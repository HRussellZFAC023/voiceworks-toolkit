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

function getWorkerCode(enableTestHooks = false): string {
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
let TextStreamer;

const TRANSFORMER_URLS = [
    'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0',
    'https://esm.sh/@huggingface/transformers@4.2.0',
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
            TextStreamer = mod.TextStreamer;
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

function toLoadFailure(error, model, backend, dtype) {
    const message = error && error.message ? error.message : String(error || 'Failed to load model');
    const failure = new Error(message);
    failure.whisperLoadFailure = {
        model,
        backend,
        dtype: typeof dtype === 'string' ? dtype : JSON.stringify(dtype),
    };
    return failure;
}

function postModelProgress(data, chunkId) {
    const payload = data && typeof data === 'object'
        ? data
        : { message: String(data || '') };
    self.postMessage({
        status: 'progress',
        file: payload.file,
        progress: payload.progress,
        loaded: payload.loaded,
        total: payload.total,
        message: payload.message,
        sourceStatus: payload.status,
        chunkId: typeof chunkId === 'number' ? chunkId : undefined,
    });
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
let adapterProbeTimeoutMs = 8000;
const WASM_DTYPE = 'q8';

function postReady(context) {
    self.postMessage({
        status: 'ready',
        backend: currentBackend,
        vendor: currentVendor,
        model: currentModel,
        dtype: currentDtype,
        chunkId: typeof context?.chunkId === 'number' ? context.chunkId : undefined,
    });
}

function inspectWebGpuAdapter(adapter, requiredBufferBytes) {
    let info = {};
    try {
        info = adapter.info || {};
    } catch (err) {
        // Firefox may withhold adapter info for fingerprinting protection.
        console.debug('[Whisper Worker] GPU adapter info unavailable:', err);
    }
    let vendor = [info.vendor, info.description, info.architecture].filter(Boolean).join(' ').toLowerCase();
    if (!vendor && gpuVendorHint) {
        vendor = gpuVendorHint;
        console.log('[Whisper Worker] Using host GPU vendor hint:', vendor);
    }
    let isFallbackAdapter = false;
    try {
        isFallbackAdapter = adapter.isFallbackAdapter === true;
    } catch (err) {
        console.debug('[Whisper Worker] GPU fallback flag unavailable:', err);
    }
    if (isFallbackAdapter || /swiftshader|llvmpipe|software|softpipe/i.test(vendor)) {
        console.warn('[Whisper Worker] Rejected software/fallback WebGPU adapter:', vendor || 'hidden');
        return { backend: null, reason: 'software/fallback WebGPU adapter rejected' };
    }
    const maxBuf = adapter.limits?.maxBufferSize || 0;
    if (maxBuf > 0 && maxBuf < requiredBufferBytes) {
        console.warn('[Whisper Worker] Adapter too small for selected model:', maxBuf);
        return {
            backend: null,
            reason: 'adapter maxBufferSize ' + maxBuf + ' is below model requirement ' + requiredBufferBytes,
            capacityFallback: maxBuf >= 268435456,
        };
    }
    console.log('[Whisper Worker] WebGPU adapter:', (vendor || 'unknown'), Math.round(maxBuf / 1048576) + 'MB');
    return { backend: { device: 'webgpu', vendor, maxBuf, adapter }, reason: '' };
}

async function detectWebGPU(requiredBufferBytes = minWebgpuBufferBytes) {
    if (typeof navigator === 'undefined' || !navigator.gpu) {
        return { backend: null, reason: 'navigator.gpu is unavailable' };
    }
    const powerPreference = preferLowPowerAdapter ? 'low-power' : 'high-performance';
    const probeDeadline = Date.now() + adapterProbeTimeoutMs;
    const requestAdapter = async (options, label) => {
        const remainingMs = probeDeadline - Date.now();
        if (remainingMs <= 0) {
            throw new Error('requestAdapter time budget exhausted before ' + label);
        }
        let timer;
        try {
            return await Promise.race([
                navigator.gpu.requestAdapter(options),
                new Promise((_, reject) => {
                    timer = setTimeout(
                        () => reject(new Error('requestAdapter timed out for ' + label)),
                        remainingMs,
                    );
                }),
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    };

    // Firefox/driver combinations can return null or a fallback adapter for an
    // explicit power preference. Inspect both candidates under one total time
    // budget and let the browser-default candidate recover either case.
    const attempts = [
        { options: { powerPreference }, label: powerPreference },
        { options: {}, label: 'browser-default' },
    ];
    let rejectedResult = null;
    let lastFailureReason = 'requestAdapter returned no usable adapter';
    for (const attempt of attempts) {
        if (Date.now() >= probeDeadline) break;
        let adapter = null;
        try {
            adapter = await requestAdapter(attempt.options, attempt.label);
        } catch (err) {
            lastFailureReason = err instanceof Error ? err.message : String(err || 'requestAdapter failed');
            console.warn('[Whisper Worker] requestAdapter failed for', attempt.label, err);
            continue;
        }
        if (!adapter) continue;
        const inspected = inspectWebGpuAdapter(adapter, requiredBufferBytes);
        if (inspected.backend) return inspected;
        rejectedResult = inspected;
    }

    console.warn('[Whisper Worker] No usable WebGPU adapter found');
    return rejectedResult || { backend: null, reason: lastFailureReason };
}

async function detectBackend(requiredBufferBytes = minWebgpuBufferBytes) {
    if (!skipWebgpu) {
        const result = await detectWebGPU(requiredBufferBytes);
        if (result.backend) return result.backend;
        return {
            device: 'wasm',
            vendor: '',
            maxBuf: 0,
            reason: result.reason,
            capacityFallback: result.capacityFallback === true,
        };
    }
    return { device: 'wasm', vendor: '', maxBuf: 0, reason: 'WebGPU disabled by host policy' };
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

function configureWebGpuRuntime(adapter) {
    const webgpu = env?.backends?.onnx?.webgpu;
    if (!webgpu || !adapter) return false;
    // Transformers.js defaults this to high-performance at module import time.
    // Apply the device policy to the actual ORT adapter selection and reuse the
    // adapter that passed our capability/limit checks.
    webgpu.powerPreference = preferLowPowerAdapter ? 'low-power' : 'high-performance';
    webgpu.forceFallbackAdapter = false;
    webgpu.adapter = adapter;
    return true;
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
        currentModel = null;
        currentDtype = '';
    }

    const requestedMinBuffer = Number(settings.minWebgpuBufferBytes);
    const requiredBufferBytes = Number.isFinite(requestedMinBuffer) && requestedMinBuffer > 0
        ? requestedMinBuffer
        : minWebgpuBufferBytes;
    const backend = await detectBackend(requiredBufferBytes);

    // Capacity rejection happens before ORT creates a session, so this worker
    // is still healthy. Retry the portable tiny model on the same GPU instead
    // of unnecessarily falling all the way back to slow CPU/WASM.
    if (backend.capacityFallback && settings.model !== FALLBACK_MODEL) {
        fallbackModelOverride = FALLBACK_MODEL;
        self.postMessage({
            status: 'fallback',
            originalModel: settings.model,
            fallbackModel: FALLBACK_MODEL,
            reason: backend.reason || 'Selected model exceeds this WebGPU adapter limit',
            reasonCode: 'webgpu-buffer-limit',
            backend: 'webgpu',
            chunkId: typeof settings.chunkId === 'number' ? settings.chunkId : undefined,
        });
        return loadPipelineForModel({
            ...settings,
            model: FALLBACK_MODEL,
            minWebgpuBufferBytes: 268435456,
        }, progressCb);
    }

    currentBackend = backend.device;
    currentVendor = backend.vendor || '';

    self.postMessage({
        status: 'initiate',
        backend: currentBackend,
        vendor: currentVendor,
        reason: backend.reason || '',
        chunkId: typeof settings.chunkId === 'number' ? settings.chunkId : undefined,
    });

    // A host-level GPU probe can succeed while the worker ultimately lands on
    // WASM. Keep that backend bounded instead of loading a large model first.
    if (currentBackend === 'wasm' && settings.model !== FALLBACK_MODEL) {
        fallbackModelOverride = FALLBACK_MODEL;
        self.postMessage({
            status: 'fallback',
            originalModel: settings.model,
            fallbackModel: FALLBACK_MODEL,
            reason: 'WASM backend requires the bounded tiny model',
            reasonCode: 'wasm-bounded-model',
            backend: currentBackend,
            dtype: WASM_DTYPE,
            chunkId: typeof settings.chunkId === 'number' ? settings.chunkId : undefined,
        });
        return loadPipelineForModel({ ...settings, model: FALLBACK_MODEL }, progressCb);
    }

    const revision = 'main';

    // --- WebGPU path ---
    if (currentBackend === 'webgpu') {
        configureWebGpuRuntime(backend.adapter);
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

                        if (isUnauthorizedError(err) && hubIdx + 1 < HUB_BASE_URLS.length) {
                            continue;
                        }
                        if (isContextErr || isGpuErr) await releaseGpuResources();
                        // A rejected ORT session creation poisons the module's
                        // session-init chain. Recovery must happen in a fresh
                        // worker; never try another dtype/backend in this one.
                        throw toLoadFailure(err, modelName, 'webgpu', dtype);
                    }
                }
            }
            throw toLoadFailure(
                new Error('No usable WebGPU model candidate'),
                modelName,
                'webgpu',
                dtypeCandidates[0],
            );
        }
    }

    // --- WASM path ---
    const wasmOpts = {
        progress_callback: progressCb,
        revision,
        device: 'wasm',
        dtype: WASM_DTYPE,
        session_options: {
            // ORT's extended optimizer currently breaks Whisper's tied
            // embedding QDQ graph before inference. Basic optimization keeps
            // the compact q8 model usable until the upstream fix reaches the
            // Transformers.js runtime bundled by our pinned CDN version.
            graphOptimizationLevel: 'basic',
        },
    };

    let lastErr = null;
    for (let hubIdx = 0; hubIdx < HUB_BASE_URLS.length; hubIdx++) {
        env.remoteHost = HUB_BASE_URLS[hubIdx];
        pipelinePromise = pipeline('automatic-speech-recognition', modelName, wasmOpts);
        try {
            await pipelinePromise;
            currentModel = modelName;
            currentMultilingual = settings.multilingual;
            currentDtype = WASM_DTYPE;
            console.log('[Whisper Worker] Model loaded on wasm [' + currentDtype + ']:', modelName);
            return pipelinePromise;
        } catch (err) {
            lastErr = err;
            pipelinePromise = null;
            if (!isUnauthorizedError(err)) {
                throw toLoadFailure(err, modelName, 'wasm', WASM_DTYPE);
            }
            if (hubIdx + 1 >= HUB_BASE_URLS.length) break;
            console.warn('[Whisper Worker] Unauthorized model fetch, retrying with next hub base...');
        }
    }

    throw toLoadFailure(lastErr || new Error('Failed to load model'), modelName, 'wasm', WASM_DTYPE);
}

const FALLBACK_MODEL = 'onnx-community/whisper-tiny';
let fallbackModelOverride = null;
let pipelineLoadPromise = null;
let pipelineLoadKey = '';

async function ensurePipeline(settings, progressCb) {
    const effective = fallbackModelOverride
        ? { ...settings, model: fallbackModelOverride }
        : settings;
    const loadingKey = effective.model + '|' + String(effective.multilingual);
    if (pipelineLoadPromise && pipelineLoadKey === loadingKey) {
        return pipelineLoadPromise;
    }

    const loadTask = (async () => {
        return await loadPipelineForModel(effective, progressCb);
    })();
    pipelineLoadPromise = loadTask;
    pipelineLoadKey = loadingKey;
    try {
        return await loadTask;
    } finally {
        if (pipelineLoadPromise === loadTask) {
            pipelineLoadPromise = null;
            pipelineLoadKey = '';
        }
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
    let lastHeartbeatAt = 0;
    const emitHeartbeat = (phase, partialText = '') => {
        const now = Date.now();
        if (now - lastHeartbeatAt < 500 && phase !== 'started') return;
        lastHeartbeatAt = now;
        self.postMessage({
            status: 'heartbeat',
            chunkId: msg.chunkId,
            data: { phase, partialText },
        });
    };
    const pipe = await ensurePipeline(msg, (data) => {
        postModelProgress(data, msg.chunkId);
        emitHeartbeat('model');
    });
    postReady(msg);

    const timeOffset = msg.timeOffset || 0;
    const chunkId = msg.chunkId;
    // The bounded WASM export does not expose cross-attention tensors, so word
    // timestamps always fail after a full decode and force a duplicate pass.
    const useWordTimestamps = currentBackend !== 'wasm';
    let partialText = '';

    const basePipeOpts = {
        do_sample: false,
        chunk_length_s: msg.chunkLengthS,
        stride_length_s: msg.strideLengthS,
        task: msg.subtask,
    };
    if (msg.language) basePipeOpts.language = msg.language;

    let activeAttempt = 0;
    const createAttemptOptions = (returnTimestamps, targetPipe = pipe) => {
        const attempt = ++activeAttempt;
        partialText = '';
        const opts = {
            ...basePipeOpts,
            return_timestamps: returnTimestamps,
        };

        // A streamer owns token-cache and prompt state. Every retry gets a
        // fresh instance, and callbacks from a failed attempt are epoch-guarded.
        if (TextStreamer && targetPipe?.tokenizer) {
            opts.streamer = new TextStreamer(targetPipe.tokenizer, {
                skip_prompt: true,
                skip_special_tokens: true,
                callback_function: (text) => {
                    if (attempt !== activeAttempt || workerPoisoned) return;
                    if (typeof text === 'string' && text) partialText += text;
                    emitHeartbeat('decoding', partialText);
                },
                token_callback_function: () => {
                    if (attempt === activeAttempt && !workerPoisoned) {
                        emitHeartbeat('decoding', partialText);
                    }
                },
            });
        }
        return opts;
    };
    let pipeOpts = createAttemptOptions(useWordTimestamps ? 'word' : true);

    let inferenceStarted = false;
    const runInference = async (targetPipe, opts, backendName, timeoutOverrideMs) => {
        if (!inferenceStarted) {
            inferenceStarted = true;
            self.postMessage({
                status: 'started',
                chunkId,
                data: { queueDepth: jobQueue.length },
            });
            emitHeartbeat('started');
        }
        const timeoutMs = timeoutOverrideMs ?? getInferenceTimeoutMs(backendName, msg.chunkLengthS);
        console.log('[Whisper Worker] Starting inference on ' + backendName + ' (timeout=' + timeoutMs / 1000 + 's)');
        return withInferenceTimeout(targetPipe(msg.audio, opts), timeoutMs, backendName);
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
            haltTimedOutWorker(chunkId, initialMsg, currentBackend !== 'wasm');
            return null;
        }
        const canRetryWithoutWords = pipeOpts.return_timestamps === 'word';

        if (canRetryWithoutWords) {
            console.warn('[Whisper Worker] Word-level timestamps failed (' + initialMsg + '), retrying with segment timestamps');
            pipeOpts = createAttemptOptions(true);
            try {
                const retryTimeoutMs = Math.max(getInferenceTimeoutMs(currentBackend, msg.chunkLengthS), FAST_BOOTSTRAP_TIMEOUT_MS);
                result = await runInference(pipe, pipeOpts, currentBackend, retryTimeoutMs);
            } catch (retryError) {
                const retryMsg = toErrorMessage(retryError);
                if (/inference timed out/i.test(retryMsg)) {
                    haltTimedOutWorker(chunkId, retryMsg, currentBackend !== 'wasm');
                    return null;
                }
                if (currentBackend !== 'wasm' && GPU_INFERENCE_ERROR_RE.test(retryMsg)) {
                    // Switching execution providers in this worker can inherit
                    // poisoned ORT session state. The host will terminate it
                    // and retry the bounded model in a fresh WASM worker.
                    postChunkError(chunkId, retryMsg, true);
                    return null;
                } else {
                    postChunkError(chunkId, retryMsg);
                    return null;
                }
            }
        } else if (currentBackend !== 'wasm' && GPU_INFERENCE_ERROR_RE.test(initialMsg)) {
            postChunkError(chunkId, initialMsg, true);
            return null;
        } else {
            postChunkError(chunkId, initialMsg);
            return null;
        }
    }

    if (!result) return null;

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
let workerPoisoned = false;

function normalizedPriority(msg) {
    const priority = Number(msg?.priority);
    return Number.isFinite(priority) ? priority : 1;
}

function normalizedDistance(msg) {
    const distance = Number(msg?.playheadDistance);
    return Number.isFinite(distance) ? distance : Number.POSITIVE_INFINITY;
}

function shouldReplaceQueued(existing, incoming) {
    const existingPriority = normalizedPriority(existing);
    const incomingPriority = normalizedPriority(incoming);
    if (incomingPriority !== existingPriority) return incomingPriority < existingPriority;
    return normalizedDistance(incoming) < normalizedDistance(existing);
}

function postDropped(msg, reason, replacedByChunkId) {
    if (!msg || typeof msg.chunkId !== 'number') return;
    self.postMessage({
        status: 'dropped',
        chunkId: msg.chunkId,
        data: { reason, replacedByChunkId },
    });
}

function postLoadFailed(error, chunkId) {
    const details = error && error.whisperLoadFailure
        ? error.whisperLoadFailure
        : {
            model: currentModel,
            backend: currentBackend,
            dtype: currentDtype,
        };
    workerPoisoned = true;
    const queuedJobs = jobQueue;
    jobQueue = [];
    self.postMessage({
        status: 'load-failed',
        backend: details.backend || currentBackend,
        model: details.model || currentModel,
        dtype: details.dtype || currentDtype,
        data: {
            message: toErrorMessage(error),
            backend: details.backend || currentBackend,
            model: details.model || currentModel,
            dtype: details.dtype || currentDtype,
            sessionPoisoned: true,
        },
        chunkId: typeof chunkId === 'number' ? chunkId : undefined,
    });
    for (const queued of queuedJobs) postDropped(queued, 'worker-poisoned');
}

function haltTimedOutWorker(chunkId, message, gpuFallback) {
    // Promise.race cannot cancel model.generate(). Once it times out, this
    // worker may still be executing the old inference. Poison it so no queued
    // job can overlap. Report poison before the chunk error: replacing the
    // worker detaches its listener, so error-first could prevent the controller
    // from ever receiving the lifecycle event that preserves the live run.
    workerPoisoned = true;
    self.postMessage({
        status: 'worker-poisoned',
        data: { reason: 'inference-timeout', message, gpuFallback: gpuFallback === true },
    });
    postChunkError(chunkId, message, gpuFallback);
    const queuedJobs = jobQueue;
    jobQueue = [];
    for (const queued of queuedJobs) postDropped(queued, 'worker-poisoned');
}
${enableTestHooks ? `
self.__whisperTestHalt = haltTimedOutWorker;
self.__whisperTestConfigureBackend = (options = {}) => {
    skipWebgpu = options.skipWebgpu === true;
    preferLowPowerAdapter = options.preferLowPowerAdapter === true;
    minWebgpuBufferBytes = Number(options.minWebgpuBufferBytes) || 268435456;
    adapterProbeTimeoutMs = Number(options.adapterProbeTimeoutMs) || 8000;
    gpuVendorHint = String(options.gpuVendorHint || '');
};
self.__whisperTestDetectBackend = detectBackend;
self.__whisperTestConfigureWebGpuRuntime = (testEnv, adapter) => {
    env = testEnv;
    return configureWebGpuRuntime(adapter);
};
` : ''}

function enqueueJob(msg) {
    if (workerPoisoned) {
        postDropped(msg, 'worker-poisoned');
        return;
    }

    if (!jobProcessing && jobQueue.length === 0) {
        jobQueue.push(msg);
        self.postMessage({
            status: 'queued',
            chunkId: msg.chunkId,
            data: { queueDepth: jobQueue.length, active: 0 },
        });
        processNextJob();
        return;
    }

    if (jobQueue.length === 0) {
        jobQueue.push(msg);
        self.postMessage({
            status: 'queued',
            chunkId: msg.chunkId,
            data: { queueDepth: jobQueue.length, active: jobProcessing ? 1 : 0 },
        });
        return;
    }

    const queued = jobQueue[0];
    if (shouldReplaceQueued(queued, msg)) {
        jobQueue[0] = msg;
        postDropped(queued, 'queue-replaced', msg.chunkId);
        self.postMessage({
            status: 'queued',
            chunkId: msg.chunkId,
            data: { queueDepth: jobQueue.length, active: jobProcessing ? 1 : 0 },
        });
    } else {
        postDropped(msg, 'queue-full', queued.chunkId);
    }
}

async function processNextJob() {
    if (jobProcessing || jobQueue.length === 0) return;
    jobProcessing = true;
    const msg = jobQueue.shift();

    try {
        const result = ${enableTestHooks
        ? "typeof self.__whisperTestTranscribe === 'function' ? await self.__whisperTestTranscribe(msg) : await transcribe(msg)"
        : 'await transcribe(msg)'};
        if (result !== null) {
            self.postMessage({
                status: 'complete',
                task: 'automatic-speech-recognition',
                data: result,
                chunkId: msg.chunkId,
            });
        }
    } catch (err) {
        if (err && err.whisperLoadFailure) {
            postLoadFailed(err, msg.chunkId);
        } else {
            self.postMessage({
                status: 'error',
                data: { message: err instanceof Error ? err.message : String(err) },
                chunkId: msg.chunkId,
            });
        }
    }

    jobProcessing = false;
    if (!workerPoisoned) processNextJob();
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
        for (const queued of jobQueue) postDropped(queued, 'queue-flushed');
        jobQueue = [];
        if (flushed > 0) console.log('[Whisper Worker] Flushed ' + flushed + ' queued jobs');
        return;
    }

    if (msg.type === 'reset') {
        workerPoisoned = true;
        jobQueue = [];
        if (pipelinePromise) {
            try { await (await pipelinePromise).dispose?.(); } catch {}
            pipelinePromise = null;
        }
        currentModel = null;
        currentMultilingual = null;
        fallbackModelOverride = null;
        pipelineLoadPromise = null;
        pipelineLoadKey = '';
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
            await ensurePipeline(msg, (data) => postModelProgress(data, msg.chunkId));
            postReady(msg);
        } catch (err) {
            if (err && err.whisperLoadFailure) {
                postLoadFailed(err, msg.chunkId);
            } else {
                self.postMessage({ status: 'error', data: { message: err instanceof Error ? err.message : String(err) } });
            }
        }
        return;
    }

    // One active inference plus one replaceable queued window. This bounds
    // memory and prevents queued-but-not-started work from looking stalled.
    enqueueJob(msg);
});
`;
}

export function createWhisperWorker(): Worker {
    return createInlineWorker(getWorkerCode());
}

// Test-only helper: exposes generated worker code for unit assertions.
export function __getWhisperWorkerCodeForTests(enableTestHooks = false): string {
    return getWorkerCode(enableTestHooks);
}
