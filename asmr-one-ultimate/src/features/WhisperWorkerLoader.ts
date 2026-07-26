/**
 * WhisperWorkerLoader - WebGPU Whisper worker (Transformers.js)
 *
 * Runs Whisper models in a Web Worker on the backend selected by the host.
 * Model/backend choices are exact: runtime failures are reported instead of
 * silently substituting Tiny or WASM. Dynamic import retains CDN redundancy.
 * Supports word-level timestamps and real-time streaming.
 *
 * Post-processing (hallucination filtering, segment grouping, bracket
 * restoration) is handled host-side by whisperProcessing.ts.  The worker
 * sends raw chunks with time-offset already applied.
 */

import { createInlineWorker } from './workerLoaderShared';
import { createWhisperInferencePolicyWorkerSource } from './whisperInferencePolicy';

function getWorkerCode(enableTestHooks = false): string {
    const inferencePolicySource = createWhisperInferencePolicyWorkerSource();
    return `
let gpuDeviceLost = false;
const GPU_ERROR_RE = /WebGPU Context Provider|context.*provider|device lost|GPUDevice|createComputePipeline|createShaderModule|createBuffer|mapAsync|MapAsyncStatus|mapping webgpu buffer|failed to download data from buffer|buffer unmapped|invalid buffer|OrtRun|Instance reference|AbortError|release session|invalid session|reading 'destroy'|reading 'dispose'/i;
const EXPLICIT_DEVICE_LOSS_RE = /device lost|Instance reference|release session|invalid session|reading 'destroy'|reading 'dispose'/i;

self.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message = reason && reason.message ? reason.message : String(reason || 'Unknown error');
    if (currentBackend === 'webgpu' && GPU_ERROR_RE.test(message)) {
        event.preventDefault();
        if (EXPLICIT_DEVICE_LOSS_RE.test(message)) {
            if (!gpuDeviceLost) {
                gpuDeviceLost = true;
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
let WhisperTextStreamer;

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
            WhisperTextStreamer = mod.WhisperTextStreamer;
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

const POISONED_RUNTIME_LOAD_RE = /WebGPU Context Provider|context.*provider|device lost|GPUDevice|createComputePipeline|createShaderModule|createBuffer|mapAsync|MapAsyncStatus|mapping webgpu buffer|failed to download data from buffer|buffer unmapped|invalid buffer|OrtRun|allocation|out of memory|OOM|RangeError|onnxruntime|ORT session|session (?:creation|initialization)|invalid graph|protobuf|operator|kernel|memory access out of bounds|index out of bounds|reading 'destroy'|reading 'dispose'/i;
const RETRYABLE_HUB_TRANSPORT_RE = /Unauthorized access to file|AccessDenied|Failed to fetch|fetch failed|NetworkError|network request failed|ERR_(?:NETWORK|CONNECTION|INTERNET)|ECONN(?:RESET|REFUSED|ABORTED)|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|TLS handshake|certificate|fetch.*(?:aborted|timed out)|network.*timed out|request to https?:\\/\\/.*timed out/i;
const RETRYABLE_HUB_STATUS_RE = /(?:HTTP(?:\\/[\\d.]+)?|status(?: code)?|response status)\\s*[:=]?\\s*(?:401|403|408|429|500|502|503|504)\\b|(?:401 Unauthorized|403 Forbidden|408 Request Timeout|429 Too Many Requests|500 Internal Server Error|502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout)/i;

function hubStatusCode(err) {
    const candidates = [
        err?.status,
        err?.statusCode,
        err?.response?.status,
        err?.cause?.status,
        err?.cause?.statusCode,
    ];
    for (const candidate of candidates) {
        const status = Number(candidate);
        if (Number.isInteger(status)) return status;
    }
    return null;
}

function isRetryableHubLoadError(err) {
    const msg = String(err && err.message ? err.message : err || '');
    // Session/GPU failures can leave ORT's module-level initialization chain
    // poisoned. A mirror retry in the same worker would hide the real fault and
    // can compound leaked GPU resources.
    if (POISONED_RUNTIME_LOAD_RE.test(msg)) return false;
    const status = hubStatusCode(err);
    if (status !== null) {
        return [401, 403, 408, 429, 500, 502, 503, 504].includes(status);
    }
    if (err?.name === 'TypeError' && /^Load failed$/i.test(msg.trim())) return true;
    return RETRYABLE_HUB_STATUS_RE.test(msg) || RETRYABLE_HUB_TRANSPORT_RE.test(msg);
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
// null = not probed for the current model, true = supported, false = the
// current export does not expose cross-attention tensors.
let wordTimestampsSupported = null;
let wordTimestampsEnabled = false;
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
    const result = await detectWebGPU(requiredBufferBytes);
    if (result.backend) return result.backend;
    return {
        device: null,
        vendor: '',
        maxBuf: 0,
        reason: result.reason,
    };
}

function getDtypeCandidates(device) {
    if (device !== 'webgpu') return null;
    // Keep the acoustically sensitive encoder at full precision. Firefox/M1
    // profiling showed that fp16 could complete quickly while collapsing a
    // 29-second Japanese sample to one junk token; fp32 produced the full
    // transcript and also retains compatibility with Intel Arc-class devices.
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

// Worker inference hard ceiling. The controller shares the policy, refreshes
// its inactivity watchdog on heartbeats, and retains a margin for delivery.
${inferencePolicySource}
const GPU_INFERENCE_ERROR_RE = /createBuffer|RangeError|out of memory|OOM|allocation|device lost|GPUDevice|createComputePipeline|createShaderModule|mapAsync|MapAsyncStatus|mapping webgpu buffer|failed to download data from buffer|buffer unmapped|invalid buffer|OrtRun|Instance reference|AbortError|release session|invalid session|index out of bounds|reading 'destroy'|reading 'dispose'/i;

function toErrorMessage(error) {
    return error && error.message ? error.message : String(error || 'Unknown error');
}

function postChunkError(chunkId, message, gpuFailure = false) {
    const data = gpuFailure ? { message, gpuFailure: true } : { message };
    self.postMessage({ status: 'error', data, chunkId });
}

function getInferenceTimeoutDetails(error) {
    return error && error.whisperInferenceTimeout
        ? error.whisperInferenceTimeout
        : null;
}

function withInferenceTimeout(promise, options) {
    let timer;
    const {
        budgetMs,
        backend,
        model,
        chunkId,
        chunkLengthS,
        kind,
        observedInferenceMs,
        startedAt,
    } = options;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const details = {
                chunkId,
                chunkLengthS,
                elapsedMs: Math.max(0, Date.now() - startedAt),
                budgetMs,
                kind,
                backend,
                model,
                observedInferenceMs,
            };
            // Emit diagnostics before rejecting. The rejection poisons the
            // worker and the controller immediately detaches its listener.
            console.error('[Whisper Worker] Inference hard ceiling exceeded', details);
            const error = new Error(
                backend + ' inference timed out after ' + (budgetMs / 1000) + 's',
            );
            error.whisperInferenceTimeout = details;
            reject(error);
        }, budgetMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ------------------------------------------------------------
// Pipeline management
// ------------------------------------------------------------

let pipelinePromise = null;
let currentModel = null;
let currentMultilingual = null;
let successfulInferenceCount = 0;
let recentInferenceDurationMs = null;

function initializeTimestampCapability(modelName) {
    // "_timestamped" exports advertise alignment heads and are eligible for a
    // real word-alignment probe. Capability begins unknown for each loaded
    // model and becomes false only after the pipeline reports that its actual
    // graph lacks cross-attention outputs.
    wordTimestampsEnabled = /_timestamped$/i.test(String(modelName || ''));
    wordTimestampsSupported = null;
}

async function loadPipelineForModel(settings, progressCb) {
    const modelName = resolveModelName(settings.model, settings.multilingual);
    const requestedBackend = settings.backend;
    if (requestedBackend !== 'webgpu' && requestedBackend !== 'wasm') {
        throw toLoadFailure(
            new Error('Whisper backend must be explicitly selected as webgpu or wasm'),
            modelName,
            String(requestedBackend || 'invalid'),
            '',
        );
    }
    await loadTransformers();

    if (
        pipelinePromise
        && currentModel === modelName
        && currentMultilingual === settings.multilingual
        && currentBackend === requestedBackend
    ) {
        return pipelinePromise;
    }

    if (pipelinePromise) {
        try { await (await pipelinePromise).dispose?.(); } catch {}
        pipelinePromise = null;
        currentModel = null;
        currentDtype = '';
        wordTimestampsSupported = null;
        wordTimestampsEnabled = false;
        successfulInferenceCount = 0;
        recentInferenceDurationMs = null;
    }

    const requestedMinBuffer = Number(settings.minWebgpuBufferBytes);
    const requiredBufferBytes = Number.isFinite(requestedMinBuffer) && requestedMinBuffer > 0
        ? requestedMinBuffer
        : minWebgpuBufferBytes;
    const backend = requestedBackend === 'wasm'
        ? { device: 'wasm', vendor: '', maxBuf: 0, reason: 'CPU/WASM selected by user or device profile' }
        : await detectBackend(requiredBufferBytes);
    if (backend.device !== requestedBackend) {
        throw toLoadFailure(
            new Error('Requested WebGPU backend is unavailable: ' + (backend.reason || 'no usable hardware adapter')),
            modelName,
            requestedBackend,
            '',
        );
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
                        initializeTimestampCapability(modelName);
                        console.log('[Whisper Worker] Model loaded on webgpu [' + currentDtype + ']:', modelName);
                        return pipelinePromise;
                    } catch (err) {
                        pipelinePromise = null;
                        const msg = String(err?.message || err || '');
                        console.warn('[Whisper Worker] WebGPU load error:', JSON.stringify(dtype), msg);

                        if (isRetryableHubLoadError(err) && hubIdx + 1 < HUB_BASE_URLS.length) {
                            console.warn('[Whisper Worker] Hub transport/auth failure, retrying the exact model on the next mirror...');
                            continue;
                        }
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
            initializeTimestampCapability(modelName);
            console.log('[Whisper Worker] Model loaded on wasm [' + currentDtype + ']:', modelName);
            return pipelinePromise;
        } catch (err) {
            lastErr = err;
            pipelinePromise = null;
            if (!isRetryableHubLoadError(err)) {
                throw toLoadFailure(err, modelName, 'wasm', WASM_DTYPE);
            }
            if (hubIdx + 1 >= HUB_BASE_URLS.length) break;
            console.warn('[Whisper Worker] Hub transport/auth failure, retrying the exact model on the next mirror...');
        }
    }

    throw toLoadFailure(lastErr || new Error('Failed to load model'), modelName, 'wasm', WASM_DTYPE);
}

let pipelineLoadPromise = null;
let pipelineLoadKey = '';

async function ensurePipeline(settings, progressCb) {
    const loadingKey = settings.model + '|' + String(settings.multilingual) + '|' + String(settings.backend);
    if (pipelineLoadPromise && pipelineLoadKey === loadingKey) {
        return pipelineLoadPromise;
    }

    const loadTask = (async () => {
        return await loadPipelineForModel(settings, progressCb);
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
        const force = phase === 'started' || phase === 'retrying';
        if (!force && now - lastHeartbeatAt < 500) return;
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
    const useWordTimestamps = wordTimestampsEnabled && wordTimestampsSupported !== false;
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
        const Streamer = WhisperTextStreamer || TextStreamer;
        if (Streamer && targetPipe?.tokenizer) {
            // Whisper timestamp tokens are not classified as generic "special"
            // tokens. WhisperTextStreamer understands tokenizer.timestamp_begin
            // and prevents tokens such as <|0.00|> from reaching callbacks.
            opts.streamer = new Streamer(targetPipe.tokenizer, {
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
    let completedInferenceDurationMs = null;

    let inferenceStarted = false;
    const runInference = async (targetPipe, opts, backendName) => {
        if (!inferenceStarted) {
            inferenceStarted = true;
            self.postMessage({
                status: 'started',
                chunkId,
                data: { queueDepth: jobQueue.length },
            });
            emitHeartbeat('started');
        }
        const coldStart = backendName === 'webgpu' && successfulInferenceCount === 0;
        const selectedModel = String(currentModel || msg.model || '');
        const chunkLengthS = Number(msg.chunkLengthS) || 0;
        const observedInferenceMs = recentInferenceDurationMs;
        const timeoutMs = getInferenceTimeoutMs(
            backendName,
            chunkLengthS,
            coldStart,
            selectedModel,
            observedInferenceMs,
        );
        const timeoutKind = coldStart ? 'cold-start' : 'warm';
        const startedAt = Date.now();
        console.log(
            '[Whisper Worker] Starting '
            + (coldStart ? 'cold-start ' : '')
            + 'inference on ' + backendName
            + ' (timeout=' + timeoutMs / 1000 + 's)',
        );
        const result = await withInferenceTimeout(targetPipe(msg.audio, opts), {
            budgetMs: timeoutMs,
            backend: backendName,
            model: selectedModel,
            chunkId,
            chunkLengthS,
            kind: timeoutKind,
            observedInferenceMs,
            startedAt,
        });
        completedInferenceDurationMs = Math.max(0, Date.now() - startedAt);
        recentInferenceDurationMs = updateInferenceDurationEwma(
            recentInferenceDurationMs,
            completedInferenceDurationMs,
        );
        return result;
    };

    let result = null;
    try {
        result = await runInference(pipe, pipeOpts, currentBackend);
    } catch (initialError) {
        const initialMsg = toErrorMessage(initialError);
        const initialTimeout = getInferenceTimeoutDetails(initialError);
        // Promise.race cannot cancel the underlying Transformers pipeline call.
        // Starting a word->segment retry after a timeout would run a second
        // inference concurrently on the same wedged pipeline. Let the host
        // terminate/recreate this worker instead.
        if (initialTimeout) {
            haltTimedOutWorker(chunkId, initialMsg, initialTimeout);
            return null;
        }
        const isWordTimestampCapabilityError = pipeOpts.return_timestamps === 'word'
            && /cross[- ]attentions?|output_attentions/i.test(initialMsg);

        if (isWordTimestampCapabilityError) {
            console.warn('[Whisper Worker] Word-level timestamps failed (' + initialMsg + '), retrying with segment timestamps');
            // Remember this export's observed capability. Retrying the same
            // unsupported word-timestamp decode on every audio window
            // otherwise doubles inference work and makes live ASMR lag.
            wordTimestampsSupported = false;
            pipeOpts = createAttemptOptions(true);
            try {
                emitHeartbeat('retrying');
                result = await runInference(pipe, pipeOpts, currentBackend);
            } catch (retryError) {
                const retryMsg = toErrorMessage(retryError);
                const retryTimeout = getInferenceTimeoutDetails(retryError);
                if (retryTimeout) {
                    haltTimedOutWorker(chunkId, retryMsg, retryTimeout);
                    return null;
                }
                if (currentBackend !== 'wasm' && GPU_INFERENCE_ERROR_RE.test(retryMsg)) {
                    // The selected WebGPU plan failed. Report it without
                    // changing execution providers.
                    poisonInferenceWorker(chunkId, retryMsg, true);
                    return null;
                } else {
                    postChunkError(chunkId, retryMsg);
                    return null;
                }
            }
        } else if (currentBackend !== 'wasm' && GPU_INFERENCE_ERROR_RE.test(initialMsg)) {
            poisonInferenceWorker(chunkId, initialMsg, true);
            return null;
        } else {
            postChunkError(chunkId, initialMsg);
            return null;
        }
    }

    if (!result) return null;
    successfulInferenceCount += 1;
    if (pipeOpts.return_timestamps === 'word') {
        wordTimestampsSupported = true;
    }

    // Apply time offset to raw chunks and send to host for processing
    const rawChunks = applyOffset(result.chunks || [], timeOffset);
    console.log('[Whisper Worker] Chunk result: ' + rawChunks.length + ' chunks, return_timestamps=' + pipeOpts.return_timestamps);

    return {
        text: (result.text || '').trim(),
        rawChunks,
        inputRms: msg.inputRms,
        wordTimestamps: pipeOpts.return_timestamps === 'word',
        inferenceElapsedMs: completedInferenceDurationMs,
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

function normalizedWindowEnd(msg) {
    const timeOffset = Number(msg?.timeOffset);
    const chunkLength = Number(msg?.chunkLengthS);
    if (!Number.isFinite(timeOffset)) return Number.NEGATIVE_INFINITY;
    return timeOffset + (Number.isFinite(chunkLength) ? Math.max(0, chunkLength) : 0);
}

function shouldReplaceQueued(existing, incoming) {
    const existingPriority = normalizedPriority(existing);
    const incomingPriority = normalizedPriority(incoming);
    if (incomingPriority !== existingPriority) return incomingPriority < existingPriority;
    const existingDistance = normalizedDistance(existing);
    const incomingDistance = normalizedDistance(incoming);
    if (incomingDistance !== existingDistance) return incomingDistance < existingDistance;
    // Live windows are commonly submitted with the same priority and distance
    // (for example offset 6 at t=14, then offset 12 at t=20). Prefer the newer
    // window so slow inference converges toward playback instead of rejecting
    // and repeatedly resubmitting it.
    return normalizedWindowEnd(incoming) > normalizedWindowEnd(existing);
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

function haltTimedOutWorker(chunkId, message, timeoutDetails = {}) {
    // Promise.race cannot cancel model.generate(). Once it times out, this
    // worker may still be executing the old inference. Poison it so no queued
    // job can overlap. Report poison before the chunk error: replacing the
    // worker detaches its listener, so error-first could prevent the controller
    // from ever receiving the lifecycle event that preserves the live run.
    workerPoisoned = true;
    self.postMessage({
        status: 'worker-poisoned',
        chunkId,
        data: {
            reason: 'inference-timeout',
            message,
            ...timeoutDetails,
            gpuFailure: false,
            chunkId,
        },
    });
    postChunkError(chunkId, message);
    const queuedJobs = jobQueue;
    jobQueue = [];
    for (const queued of queuedJobs) postDropped(queued, 'worker-poisoned');
}

function poisonInferenceWorker(chunkId, message, gpuFailure) {
    // ORT WebGPU mapping/runtime failures (notably Firefox "Buffer unmapped")
    // can leave the session unusable even when the adapter itself survives.
    // Poison before reporting the chunk error so the controller replaces this
    // worker and resumes on the same pinned plan instead of reusing the session.
    workerPoisoned = true;
    self.postMessage({
        status: 'worker-poisoned',
        data: { reason: 'inference-runtime-error', message, gpuFailure: gpuFailure === true },
    });
    postChunkError(chunkId, message, gpuFailure);
    const queuedJobs = jobQueue;
    jobQueue = [];
    for (const queued of queuedJobs) postDropped(queued, 'worker-poisoned');
}
${enableTestHooks ? `
self.__whisperTestHalt = haltTimedOutWorker;
self.__whisperTestConfigureBackend = (options = {}) => {
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
self.__whisperTestIsRetryableHubLoadError = isRetryableHubLoadError;
self.__whisperTestSetTransformers = (testPipeline, testEnv = {}) => {
    pipeline = testPipeline;
    env = testEnv;
    transformersLoaded = true;
};
self.__whisperTestLoadPipelineForModel = loadPipelineForModel;
self.__whisperTestGetTimestampCapability = () => ({
    enabled: wordTimestampsEnabled,
    supported: wordTimestampsSupported,
});
self.__whisperTestSetPipeline = (testPipe, options = {}) => {
    pipelinePromise = Promise.resolve(testPipe);
    currentModel = String(options.model || 'onnx-community/whisper-small_timestamped');
    currentMultilingual = options.multilingual !== false;
    currentBackend = String(options.backend || 'webgpu');
    TextStreamer = options.TextStreamer || class { constructor() {} };
    WhisperTextStreamer = options.WhisperTextStreamer || TextStreamer;
    transformersLoaded = true;
    pipelineLoadPromise = null;
    initializeTimestampCapability(currentModel);
    successfulInferenceCount = 0;
    recentInferenceDurationMs = Number(options.recentInferenceDurationMs) > 0
        ? Number(options.recentInferenceDurationMs)
        : null;
};
self.__whisperTestTranscribeDirect = transcribe;
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
        wordTimestampsSupported = null;
        wordTimestampsEnabled = false;
        successfulInferenceCount = 0;
        recentInferenceDurationMs = null;
        pipelineLoadPromise = null;
        pipelineLoadKey = '';
        return;
    }

    if (msg.type === 'init') {
        const inheritedInferenceDuration = Number(msg.recentInferenceDurationMs);
        if (Number.isFinite(inheritedInferenceDuration) && inheritedInferenceDuration > 0) {
            recentInferenceDurationMs = inheritedInferenceDuration;
        }
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
