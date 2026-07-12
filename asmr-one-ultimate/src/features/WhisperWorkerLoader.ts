/**
 * WhisperWorkerLoader - WebGPU Whisper worker (Transformers.js)
 *
 * Runs whisper models in a Web Worker. Prefers WebGPU with fp32+q4 dtype,
 * falls back to WASM. Dynamic import with CDN fallback for resilience.
 * Supports word-level timestamps and real-time streaming.
 *
 * Post-processing (hallucination filtering, segment grouping, bracket
 * restoration) is handled host-side by whisperProcessing.ts.  The worker
 * sends raw chunks with time-offset already applied.
 */

import { createInlineWorker } from './workerLoaderShared';

function getWorkerCode(): string {
    return `
let gpuDeviceLost = false;
const GPU_ERROR_RE = /WebGPU Context Provider|context.*provider|device lost|GPUDevice|createComputePipeline|createShaderModule|createBuffer|mapAsync|mapping webgpu buffer|invalid buffer|Instance reference|AbortError|release session|invalid session|reading 'destroy'|reading 'dispose'/i;
const EXPLICIT_DEVICE_LOSS_RE = /device lost|Instance reference|release session|invalid session|reading 'destroy'|reading 'dispose'/i;

self.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message = reason && reason.message ? reason.message : String(reason || 'Unknown error');
    if (GPU_ERROR_RE.test(message)) {
        event.preventDefault();
        if (EXPLICIT_DEVICE_LOSS_RE.test(message)) {
            if (!gpuDeviceLost) {
                gpuDeviceLost = true;
                skipWebgpu = true;
                console.error('[Whisper Worker] Fatal GPU device loss:', message);
                self.postMessage({ status: 'gpu-device-lost', data: { message } });
            }
        } else {
            console.warn('[Whisper Worker] Suppressed WebGPU error:', message);
        }
        return;
    }
    self.postMessage({ status: 'error', data: { message } });
});

let pipeline;
let env;

const TRANSFORMER_URLS = [
    'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.0.0-next.4',
    'https://esm.sh/@huggingface/transformers@4.0.0-next.4',
];

const HUB_BASE_URLS = [
    'https://huggingface.co',
    'https://hf-mirror.com',
];

let transformersLoaded = false;
async function loadTransformers() {
    if (transformersLoaded) return;
    for (const url of TRANSFORMER_URLS) {
        try {
            const mod = await Promise.race([
                import(url),
                new Promise((_, reject) => setTimeout(() => reject(new Error('CDN import timeout')), 30000))
            ]);
            pipeline = mod.pipeline;
            env = mod.env;
            if (!pipeline || !env) throw new Error('Missing pipeline/env');
            env.allowLocalModels = false;
            env.allowRemoteModels = true;
            env.useBrowserCache = true;
            transformersLoaded = true;
            console.log('[Whisper Worker] Transformers loaded from:', url);
            return;
        } catch (err) {
            console.warn('[Whisper Worker] CDN failed:', url, err);
        }
    }
    throw new Error('Failed to load transformers.js from all CDNs');
}

function isUnauthorizedError(err) {
    const msg = String(err && err.message ? err.message : err || '');
    return /Unauthorized access to file|401|403|AccessDenied/i.test(msg);
}

// ------------------------------------------------------------
// Backend / dtype selection
// ------------------------------------------------------------

let gpuVendorHint = '';
let currentBackend = 'wasm';
let currentVendor = '';
let currentDtype = '';
let skipWebgpu = false;
let preferLowPowerAdapter = false;
let minWebgpuBufferBytes = 268435456;

async function detectWebGPU() {
    if (typeof navigator === 'undefined' || !('gpu' in navigator)) return null;
    try {
        const powerPreference = preferLowPowerAdapter ? 'low-power' : 'high-performance';
        let adapter = null;
        try {
            adapter = await navigator.gpu.requestAdapter({ powerPreference });
        } catch (err) {
            console.warn('[Whisper Worker] requestAdapter failed for', powerPreference, err);
        }
        // Fall back to opposite power class if preferred adapter unavailable
        if (!adapter) {
            const fallback = preferLowPowerAdapter ? 'high-performance' : 'low-power';
            try {
                adapter = await navigator.gpu.requestAdapter({ powerPreference: fallback });
            } catch (err) {
                console.warn('[Whisper Worker] requestAdapter failed for', fallback, err);
            }
        }
        if (!adapter) {
            console.warn('[Whisper Worker] No usable WebGPU adapter found');
            return null;
        }
        const info = adapter.info || {};
        let vendor = [info.vendor, info.description, info.architecture].filter(Boolean).join(' ').toLowerCase();
        if (!vendor && gpuVendorHint) {
            vendor = gpuVendorHint;
            console.log('[Whisper Worker] Using host GPU vendor hint:', vendor);
        }
        if (/swiftshader|llvmpipe|software|softpipe/i.test(vendor)) {
            console.warn('[Whisper Worker] Rejected software WebGPU adapter:', vendor);
            return null;
        }
        const maxBuf = adapter.limits?.maxBufferSize || 0;
        if (maxBuf > 0 && maxBuf < minWebgpuBufferBytes) {
            console.warn('[Whisper Worker] Rejected adapter — maxBufferSize too small:', maxBuf);
            return null;
        }
        console.log('[Whisper Worker] WebGPU adapter:', (vendor || 'unknown'), Math.round(maxBuf / 1048576) + 'MB');
        return { device: 'webgpu', vendor, maxBuf };
    } catch {
        return null;
    }
}

async function detectBackend() {
    if (!skipWebgpu) {
        const webgpu = await detectWebGPU();
        if (webgpu) return webgpu;
    }
    return { device: 'wasm', vendor: '', maxBuf: 0 };
}

function getDtypeCandidates(device) {
    if (device !== 'webgpu') return null;
    return [{ encoder_model: 'fp32', decoder_model_merged: 'q4' }];
}

function resolveModelName(model, multilingual) {
    if (model.startsWith('distil-whisper/')) return model;
    if (multilingual) return model;
    if (model.endsWith('_timestamped')) {
        return model.slice(0, -'_timestamped'.length) + '.en_timestamped';
    }
    return model + '.en';
}

async function releaseGpuResources() {
    await new Promise(r => setTimeout(r, 250));
    await new Promise(r => setTimeout(r, 250));
}

// Inference timeout
const INFERENCE_TIMEOUT_MS = 45_000;
const FAST_BOOTSTRAP_TIMEOUT_MS = 30_000;
const GPU_INFERENCE_ERROR_RE = /createBuffer|RangeError|out of memory|OOM|allocation|device lost|GPUDevice|createComputePipeline|createShaderModule|mapAsync|mapping webgpu buffer|invalid buffer|Instance reference|AbortError|release session|invalid session|index out of bounds|timed out|reading 'destroy'|reading 'dispose'/i;

function toErrorMessage(error) {
    return error && error.message ? error.message : String(error || 'Unknown error');
}

function postChunkError(chunkId, message, gpuFallback = false) {
    const data = gpuFallback ? { message, gpuFallback: true } : { message };
    self.postMessage({ status: 'error', data, chunkId });
}

function withInferenceTimeout(promise, ms, backendName) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(backendName + ' inference timed out after ' + (ms / 1000) + 's')), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function getInferenceTimeoutMs(currentBackend, chunkLengthS) {
    const chunkS = Number(chunkLengthS) || 30;
    if (currentBackend === 'webgpu') return Math.max(INFERENCE_TIMEOUT_MS, chunkS * 5 * 1000);
    return Math.min(180_000, Math.max(90_000, chunkS * 4 * 1000));
}

// ------------------------------------------------------------
// Pipeline management
// ------------------------------------------------------------

let pipelinePromise = null;
let currentModel = null;
let currentMultilingual = null;

async function loadPipelineForModel(settings, progressCb) {
    await loadTransformers();

    const modelName = resolveModelName(settings.model, settings.multilingual);

    if (pipelinePromise && currentModel === modelName && currentMultilingual === settings.multilingual) {
        return pipelinePromise;
    }

    if (pipelinePromise) {
        try { await (await pipelinePromise).dispose?.(); } catch {}
        pipelinePromise = null;
    }

    const backend = await detectBackend();
    currentBackend = backend.device;
    currentVendor = backend.vendor || '';

    self.postMessage({ status: 'initiate', backend: currentBackend, vendor: currentVendor });

    // A host-level GPU probe can succeed while the worker ultimately lands on
    // WASM. Keep that backend bounded instead of loading a large model first.
    if (currentBackend === 'wasm' && settings.model !== FALLBACK_MODEL) {
        fallbackModelOverride = FALLBACK_MODEL;
        self.postMessage({
            status: 'fallback',
            originalModel: settings.model,
            fallbackModel: FALLBACK_MODEL,
            reason: 'WASM backend requires the bounded tiny model',
        });
        return loadPipelineForModel({ ...settings, model: FALLBACK_MODEL }, progressCb);
    }

    const revision = 'main';

    // --- WebGPU path ---
    if (currentBackend === 'webgpu') {
        const dtypeCandidates = getDtypeCandidates(currentBackend);
        if (dtypeCandidates) {
            for (const dtype of dtypeCandidates) {
                for (let hubIdx = 0; hubIdx < HUB_BASE_URLS.length; hubIdx++) {
                    env.remoteHost = HUB_BASE_URLS[hubIdx];
                    const opts = {
                        progress_callback: progressCb,
                        revision,
                        device: 'webgpu',
                        dtype,
                    };
                    pipelinePromise = pipeline('automatic-speech-recognition', modelName, opts);
                    try {
                        await pipelinePromise;
                        currentModel = modelName;
                        currentMultilingual = settings.multilingual;
                        currentDtype = JSON.stringify(dtype);
                        console.log('[Whisper Worker] Model loaded on webgpu [' + currentDtype + ']:', modelName);
                        return pipelinePromise;
                    } catch (err) {
                        pipelinePromise = null;
                        const msg = String(err?.message || err || '');
                        const isContextErr = /WebGPU Context Provider|context.*provider|device lost|GPUDevice|createComputePipeline|createShaderModule|mapping webgpu buffer|invalid buffer/i.test(msg);
                        const isGpuErr = isContextErr || /allocation|out of memory|OOM|RangeError|createbuffer|timed out/i.test(msg);

                        console.warn('[Whisper Worker] WebGPU load error:', JSON.stringify(dtype), msg);

                        if (isContextErr) {
                            await releaseGpuResources();
                            skipWebgpu = true;
                            break;
                        }
                        if (isGpuErr) {
                            await releaseGpuResources();
                            break;
                        }
                        if (!isUnauthorizedError(err)) break;
                    }
                }
            }
            console.warn('[Whisper Worker] All WebGPU candidates failed, falling through to WASM');
            skipWebgpu = true;
            currentBackend = 'wasm';
            currentVendor = '';
            self.postMessage({ status: 'initiate', backend: 'wasm', vendor: '' });
            if (settings.model !== FALLBACK_MODEL) {
                fallbackModelOverride = FALLBACK_MODEL;
                self.postMessage({
                    status: 'fallback',
                    originalModel: settings.model,
                    fallbackModel: FALLBACK_MODEL,
                    reason: 'WebGPU model load failed; WASM requires the bounded tiny model',
                });
                return loadPipelineForModel({ ...settings, model: FALLBACK_MODEL }, progressCb);
            }
        }
    }

    // --- WASM path ---
    const wasmOpts = {
        progress_callback: progressCb,
        revision,
        device: 'wasm',
        dtype: 'q8',
    };

    let lastErr = null;
    for (let hubIdx = 0; hubIdx < HUB_BASE_URLS.length; hubIdx++) {
        env.remoteHost = HUB_BASE_URLS[hubIdx];
        pipelinePromise = pipeline('automatic-speech-recognition', modelName, wasmOpts);
        try {
            await pipelinePromise;
            currentModel = modelName;
            currentMultilingual = settings.multilingual;
            currentDtype = 'q8';
            console.log('[Whisper Worker] Model loaded on wasm:', modelName);
            return pipelinePromise;
        } catch (err) {
            lastErr = err;
            pipelinePromise = null;
            if (!isUnauthorizedError(err)) throw err;
            console.warn('[Whisper Worker] Unauthorized model fetch, retrying with next hub base...');
        }
    }

    throw lastErr || new Error('Failed to load model');
}

const FALLBACK_MODEL = 'onnx-community/whisper-tiny';
let fallbackModelOverride = null;

async function ensurePipeline(settings, progressCb) {
    const effective = fallbackModelOverride
        ? { ...settings, model: fallbackModelOverride }
        : settings;
    try {
        return await loadPipelineForModel(effective, progressCb);
    } catch (error) {
        if (effective.model === FALLBACK_MODEL) throw error;
        fallbackModelOverride = FALLBACK_MODEL;
        self.postMessage({
            status: 'fallback',
            originalModel: effective.model,
            fallbackModel: FALLBACK_MODEL,
            reason: toErrorMessage(error),
        });
        return loadPipelineForModel({ ...settings, model: FALLBACK_MODEL }, progressCb);
    }
}

// ------------------------------------------------------------
// Transcription — raw chunk output
// ------------------------------------------------------------

// Apply time offset to raw chunks in-place and return them.
function applyOffset(chunks, offset) {
    if (!chunks || offset === 0) return chunks;
    for (const c of chunks) {
        if (c.timestamp) {
            if (c.timestamp[0] != null) c.timestamp[0] += offset;
            if (c.timestamp[1] != null) c.timestamp[1] += offset;
        }
    }
    return chunks;
}

async function transcribe(msg) {
    const pipe = await ensurePipeline(msg, (data) => self.postMessage(data));
    self.postMessage({ status: 'ready', backend: currentBackend, vendor: currentVendor });

    const timeOffset = msg.timeOffset || 0;
    const chunkId = msg.chunkId;
    const requestedUpdateInterval = Number(msg.updateIntervalMs);
    const updateIntervalMs = Number.isFinite(requestedUpdateInterval)
        ? Math.max(100, Math.min(1000, Math.floor(requestedUpdateInterval)))
        : 200;
    const useWordTimestamps = true;

    let wordBuffer = [];
    let lastUpdateAt = 0;

    function chunk_callback(chunk) {
        wordBuffer.push(chunk);
        const now = Date.now();
        if (now - lastUpdateAt < updateIntervalMs) return;
        lastUpdateAt = now;
        sendBufferUpdate();
    }

    function sendBufferUpdate() {
        if (wordBuffer.length === 0) return;
        // Send raw chunks with offset — host does all processing
        const raw = wordBuffer.map(c => ({
            text: (c.text || '').trim(),
            timestamp: [
                c.timestamp?.[0] != null ? c.timestamp[0] + timeOffset : null,
                c.timestamp?.[1] != null ? c.timestamp[1] + timeOffset : null,
            ],
        }));
        self.postMessage({ status: 'update', data: { rawChunks: raw, inputRms: msg.inputRms }, chunkId });
    }

    const pipeOpts = {
        do_sample: false,
        chunk_length_s: msg.chunkLengthS,
        stride_length_s: msg.strideLengthS,
        task: msg.subtask,
        return_timestamps: useWordTimestamps ? 'word' : true,
        chunk_callback,
    };
    if (msg.language) pipeOpts.language = msg.language;

    const resetStreamState = (wordLevel) => {
        wordBuffer = [];
        lastUpdateAt = 0;
    };

    const runInference = async (targetPipe, opts, backendName, timeoutOverrideMs) => {
        const timeoutMs = timeoutOverrideMs ?? getInferenceTimeoutMs(backendName, msg.chunkLengthS);
        console.log('[Whisper Worker] Starting inference on ' + backendName + ' (timeout=' + timeoutMs / 1000 + 's)');
        return withInferenceTimeout(targetPipe(msg.audio, opts), timeoutMs, backendName);
    };

    const fallbackToWasmAndRetry = async (reasonMsg) => {
        if (currentBackend === 'wasm') throw new Error(reasonMsg);

        console.warn('[Whisper Worker] GPU inference failed, falling back to WASM:', reasonMsg);
        skipWebgpu = true;
        if (pipelinePromise) {
            try { await (await pipelinePromise).dispose?.(); } catch {}
        }
        pipelinePromise = null;
        currentModel = null;
        currentMultilingual = null;

        await releaseGpuResources();

        self.postMessage({ status: 'initiate', backend: 'wasm', vendor: '' });
        const wasmPipe = await ensurePipeline(msg, (data) => self.postMessage(data));
        self.postMessage({ status: 'ready', backend: currentBackend, vendor: currentVendor });

        resetStreamState(false);
        const fallbackOpts = { ...pipeOpts, return_timestamps: true };
        const fallbackResult = await runInference(wasmPipe, fallbackOpts, 'wasm');
        self.postMessage({ status: 'gpu-degraded', data: { message: reasonMsg } });
        return fallbackResult;
    };

    let result = null;
    try {
        result = await runInference(pipe, pipeOpts, currentBackend);
    } catch (initialError) {
        const initialMsg = toErrorMessage(initialError);
        // Promise.race cannot cancel the underlying Transformers pipeline call.
        // Starting a word->segment retry after a timeout would run a second
        // inference concurrently on the same wedged pipeline. Let the host
        // terminate/recreate this worker instead.
        if (/inference timed out/i.test(initialMsg)) {
            postChunkError(chunkId, initialMsg, currentBackend !== 'wasm');
            return null;
        }
        const canRetryWithoutWords = pipeOpts.return_timestamps === 'word';

        if (canRetryWithoutWords) {
            console.warn('[Whisper Worker] Word-level timestamps failed (' + initialMsg + '), retrying with segment timestamps');
            resetStreamState(false);
            pipeOpts.return_timestamps = true;
            try {
                const retryTimeoutMs = Math.max(getInferenceTimeoutMs(currentBackend, msg.chunkLengthS), FAST_BOOTSTRAP_TIMEOUT_MS);
                result = await runInference(pipe, pipeOpts, currentBackend, retryTimeoutMs);
            } catch (retryError) {
                const retryMsg = toErrorMessage(retryError);
                if (currentBackend !== 'wasm' && GPU_INFERENCE_ERROR_RE.test(retryMsg)) {
                    try {
                        result = await fallbackToWasmAndRetry(retryMsg);
                    } catch (fallbackError) {
                        postChunkError(chunkId, toErrorMessage(fallbackError), true);
                        return null;
                    }
                } else {
                    postChunkError(chunkId, retryMsg);
                    return null;
                }
            }
        } else if (currentBackend !== 'wasm' && GPU_INFERENCE_ERROR_RE.test(initialMsg)) {
            try {
                result = await fallbackToWasmAndRetry(initialMsg);
            } catch (fallbackError) {
                postChunkError(chunkId, toErrorMessage(fallbackError), true);
                return null;
            }
        } else {
            postChunkError(chunkId, initialMsg);
            return null;
        }
    }

    if (!result) return null;

    // Final flush of any throttled streaming updates
    sendBufferUpdate();

    // Apply time offset to raw chunks and send to host for processing
    const rawChunks = applyOffset(result.chunks || [], timeOffset);
    console.log('[Whisper Worker] Chunk result: ' + rawChunks.length + ' chunks, return_timestamps=' + pipeOpts.return_timestamps);

    return {
        text: (result.text || '').trim(),
        rawChunks,
        inputRms: msg.inputRms,
    };
}

// ------------------------------------------------------------
// Job queue (sequential execution)
// ------------------------------------------------------------

let jobQueue = [];
let jobProcessing = false;

async function processNextJob() {
    if (jobProcessing || jobQueue.length === 0) return;
    jobProcessing = true;
    const msg = jobQueue.shift();

    try {
        const result = await transcribe(msg);
        if (result !== null) {
            self.postMessage({
                status: 'complete',
                task: 'automatic-speech-recognition',
                data: result,
                chunkId: msg.chunkId,
            });
        }
    } catch (err) {
        self.postMessage({
            status: 'error',
            data: { message: err instanceof Error ? err.message : String(err) },
            chunkId: msg.chunkId,
        });
    }

    jobProcessing = false;
    processNextJob();
}

// ------------------------------------------------------------
// Message handler
// ------------------------------------------------------------

self.addEventListener('message', async (event) => {
    const msg = event.data;

    if (msg.type === 'skip-webgpu') {
        skipWebgpu = true;
        console.log('[Whisper Worker] WebGPU disabled by host');
        return;
    }

    if (msg.type === 'flush-queue') {
        const flushed = jobQueue.length;
        jobQueue = [];
        if (flushed > 0) console.log('[Whisper Worker] Flushed ' + flushed + ' queued jobs');
        return;
    }

    if (msg.type === 'reset') {
        if (pipelinePromise) {
            try { await (await pipelinePromise).dispose?.(); } catch {}
            pipelinePromise = null;
        }
        currentModel = null;
        currentMultilingual = null;
        fallbackModelOverride = null;
        return;
    }

    if (msg.type === 'init') {
        if (msg.gpuVendorHint) gpuVendorHint = String(msg.gpuVendorHint).toLowerCase();
        const requestedMinBuffer = Number(msg.minWebgpuBufferBytes);
        minWebgpuBufferBytes = Number.isFinite(requestedMinBuffer) && requestedMinBuffer > 0
            ? Math.floor(requestedMinBuffer)
            : 268435456;
        preferLowPowerAdapter = msg.preferLowPowerAdapter === true;
        try {
            await ensurePipeline(msg, (data) => self.postMessage(data));
            self.postMessage({ status: 'ready', backend: currentBackend, vendor: currentVendor });
        } catch (err) {
            self.postMessage({ status: 'error', data: { message: err instanceof Error ? err.message : String(err) } });
        }
        return;
    }

    // Queue transcription job
    jobQueue.push(msg);
    processNextJob();
});
`;
}

export function createWhisperWorker(): Worker {
    return createInlineWorker(getWorkerCode());
}

// Test-only helper: exposes generated worker code for unit assertions.
export function __getWhisperWorkerCodeForTests(): string {
    return getWorkerCode();
}
