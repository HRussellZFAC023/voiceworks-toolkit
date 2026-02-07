/**
 * WhisperWorkerLoader - WebGPU Whisper worker (Transformers.js)
 *
 * Runs whisper models in a Web Worker. Prefers WebGPU, optional WASM fallback.
 * Auto-falls back to smaller models (small → base → tiny) on OOM.
 */

function getWorkerCode(): string {
    return `
self.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message = reason?.message || String(reason || 'Unknown error');
    // ONNX Runtime may reject internally during WebGPU EP creation but retry/fallback
    // on its own. Suppress these so we don't kill the worker before ONNX can recover.
    if (isWebGPUContextError({ message })) {
        console.warn('[Whisper Worker] Suppressed non-fatal WebGPU error:', message);
        return;
    }
    self.postMessage({ status: 'error', data: { message } });
});

let pipeline, env;

const TRANSFORMER_URLS = [
    'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1',
    'https://esm.sh/@huggingface/transformers@3.8.1',
    'https://unpkg.com/@huggingface/transformers@3.8.1?module',
];

const HUB_URLS = [
    'https://hf-mirror.com',
    'https://huggingface.co',
];

const MODEL_FALLBACK = [
    'onnx-community/whisper-small',
    'onnx-community/whisper-base',
    'onnx-community/whisper-tiny',
];

let transformersLoaded = false;
async function loadTransformers() {
    if (transformersLoaded) return;
    for (const url of TRANSFORMER_URLS) {
        try {
            const mod = await import(url);
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

// ---- Error classification ----

function isRecoverableError(err) {
    const msg = String(err?.message || err || '');
    const name = String(err?.name || '');
    return /Unauthorized|401|403|AccessDenied|failed to load|network|fetch|timeout|ENOENT|ECONNREFUSED|allocation failed|out of memory|OOM|RangeError|memory|createbuffer|buffer of size/i.test(msg) || name === 'RangeError';
}

function isMemoryError(err) {
    const msg = String(err?.message || err || '');
    return /allocation failed|out of memory|OOM|RangeError|memory|createbuffer|buffer of size/i.test(msg) || err?.name === 'RangeError';
}

function isWebGPUContextError(err) {
    const msg = String(err?.message || err || '');
    return /WebGPU Context Provider|context.*provider|device lost|GPUDevice|createComputePipeline|createShaderModule/i.test(msg);
}

function isGpuInferenceError(err) {
    return isMemoryError(err) || isWebGPUContextError(err);
}

// ---- Backend detection ----

let currentBackend = 'webgpu';
let currentVendor = '';
let webgpuBroken = false;
let webnnBroken = false;

async function detectWebNN() {
    if (typeof navigator === 'undefined' || !navigator.ml) return null;
    try {
        const ctx = await navigator.ml.createContext();
        if (!ctx) return null;
        console.log('[Whisper Worker] WebNN available');
        return { device: 'webnn', vendor: 'webnn' };
    } catch {
        return null;
    }
}

async function detectBackend() {
    // Cascade: WebGPU > WebNN > WASM
    if (!webgpuBroken) {
        if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
            try {
                // Prefer discrete GPU; fall back to integrated if unavailable
                let adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
                if (!adapter) {
                    adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' });
                }
                if (adapter) {
                    const info = adapter.info || {};
                    const vendor = [info.vendor, info.description, info.architecture].filter(Boolean).join(' ').toLowerCase();
                    const maxBuf = adapter.limits?.maxBufferSize || 0;
                    console.log('[Whisper Worker] WebGPU adapter:', vendor, '| maxBufferSize:', Math.round(maxBuf / 1048576), 'MB');
                    return { device: 'webgpu', vendor };
                }
            } catch {}
        }
    }
    if (!webnnBroken) {
        const webnn = await detectWebNN();
        if (webnn) return webnn;
    }
    return { device: 'wasm', vendor: '' };
}

function chooseDtype(device, vendor, quantized) {
    if (device === 'webnn') {
        // WebNN: fp32 is safest for both encoder and decoder
        return { encoder_model: 'fp32', decoder_model_merged: 'fp32' };
    }
    if (device !== 'webgpu') return null;
    const isIntel = /intel|xe|arc/i.test(vendor);
    const isQualcomm = /qualcomm|adreno/i.test(vendor);
    // Intel Xe-2 HPG: fp16 shaders produce garbage. Adreno: lacks shader-f16 support.
    if (isIntel || isQualcomm) return { encoder_model: 'fp32', decoder_model_merged: 'fp32' };
    if (quantized) return { encoder_model: 'fp32', decoder_model_merged: 'q4' };
    return { encoder_model: 'fp32', decoder_model_merged: 'fp32' };
}

// ---- Pipeline management ----

let pipelineInstance = null;
let currentModel = null;
let currentQuantized = null;
let currentMultilingual = null;
let pipelineReady = false;

function resolveModelName(model, multilingual) {
    if (!model) return MODEL_FALLBACK[0];
    const name = model.trim().replace(/-ONNX$/i, '') || MODEL_FALLBACK[0];
    if (name.startsWith('distil-whisper/')) return name;
    if (name.startsWith('onnx-community/whisper-') && !multilingual) return name + '.en';
    return name;
}

function buildFallbackChain(model) {
    const normalized = (model || '').trim().replace(/-ONNX$/i, '') || MODEL_FALLBACK[0];
    for (let i = 0; i < MODEL_FALLBACK.length; i++) {
        if (MODEL_FALLBACK[i] === normalized) return MODEL_FALLBACK.slice(i);
    }
    return [normalized, ...MODEL_FALLBACK];
}

async function ensurePipeline(settings) {
    await loadTransformers();

    const modelName = resolveModelName(settings.model, settings.multilingual);

    // Reuse existing pipeline if compatible
    if (pipelineReady && pipelineInstance && currentModel === modelName &&
        currentQuantized === settings.quantized && currentMultilingual === settings.multilingual) {
        return pipelineInstance;
    }

    // Dispose old
    if (pipelineInstance) {
        try { (await pipelineInstance).dispose?.(); } catch {}
        pipelineInstance = null;
        pipelineReady = false;
    }

    const backend = await detectBackend();
    if (backend.device !== 'webgpu' && backend.device !== 'webnn' && !settings.allowWasm) {
        throw new Error('WebGPU is required for Whisper on this device.');
    }
    currentBackend = backend.device;
    currentVendor = backend.vendor;

    self.postMessage({ status: 'initiate', backend: currentBackend, vendor: currentVendor });

    const dtype = chooseDtype(currentBackend, currentVendor, settings.quantized);
    const fallbackChain = buildFallbackChain(settings.model);

    const progressCb = (data) => {
        if (!data) return;
        if (data.status === 'progress') {
            let progress = typeof data.progress === 'number' ? data.progress : 0;
            if (progress <= 0 && data.total > 0) progress = (data.loaded / data.total) * 100;
            if (progress > 0 && progress <= 1) progress *= 100;
            self.postMessage({ status: 'progress', file: data.file || 'model', progress: Math.max(0, Math.min(100, progress)) });
        } else if (data.status === 'initiate') {
            self.postMessage({ status: 'progress', file: data.file || 'model', progress: 0 });
        } else if (data.status === 'done') {
            self.postMessage({ status: 'progress', file: data.file || 'model', progress: 100 });
        }
    };

    // Try each model in fallback chain
    for (let fi = 0; fi < fallbackChain.length; fi++) {
        const tryModel = resolveModelName(fallbackChain[fi], settings.multilingual);

        const opts = { progress_callback: progressCb, revision: 'main', device: currentBackend };
        if (dtype) { opts.dtype = dtype; } else { opts.quantized = settings.quantized; }

        // Try each hub URL
        let lastErr = null;
        for (let hi = 0; hi < HUB_URLS.length; hi++) {
            env.hub = env.hub || {};
            env.hub.baseUrl = HUB_URLS[hi];
            env.hub.allowRemoteModels = true;

            try {
                pipelineInstance = await pipeline('automatic-speech-recognition', tryModel, opts);
                currentModel = tryModel;
                currentQuantized = settings.quantized;
                currentMultilingual = settings.multilingual;
                pipelineReady = true;
                console.log('[Whisper Worker] Model loaded:', tryModel, 'on', currentBackend);
                return pipelineInstance;
            } catch (err) {
                lastErr = err;
                pipelineInstance = null;

                // WebGPU context creation failed — cascade to next backend (WebNN > WASM)
                if (isWebGPUContextError(err) && currentBackend === 'webgpu' && settings.allowWasm) {
                    console.warn('[Whisper Worker] WebGPU context failed:', err?.message);
                    webgpuBroken = true;
                    return ensurePipeline(settings);
                }

                if (isMemoryError(err)) break; // OOM → try smaller model
                // Network/auth → try next hub
            }
        }

        // Notify fallback
        if (fi < fallbackChain.length - 1 && isRecoverableError(lastErr)) {
            const nextModel = fallbackChain[fi + 1];
            self.postMessage({ status: 'fallback', originalModel: fallbackChain[fi], fallbackModel: nextModel, reason: lastErr?.message });
            continue;
        }

        if (lastErr) throw lastErr;
    }

    throw new Error('Failed to load any Whisper model');
}

// ---- Hallucination detection ----

function isHallucinated(text) {
    if (!text || !text.trim()) return false;
    const t = text.trim();
    // Detect repeating patterns: "word word word word" or "xy xy xy xy"
    const words = t.split(/\\s+/);
    if (words.length >= 4) {
        let repeats = 1;
        for (let i = 1; i < words.length; i++) {
            if (words[i] === words[i - 1]) { if (++repeats >= 4) return true; }
            else repeats = 1;
        }
    }
    // Detect repeated character sequences (e.g., "aaaaa" or "!!!!!")
    if (/(.{2,})\\1{3,}/.test(t)) return true;
    // Detect excessive punctuation-only output
    if (/^[\\s.!?,;:…。、！？]+$/.test(t)) return true;
    return false;
}

// ---- Transcription ----

async function transcribe(msg) {
    const pipe = await ensurePipeline(msg);
    self.postMessage({ status: 'ready', backend: currentBackend, vendor: currentVendor });

    const timeOffset = msg.timeOffset || 0;
    const chunkId = msg.chunkId;
    let finalizedChunks = [];

    function chunk_callback(chunk) {
        // Filter out hallucinated chunks
        if (isHallucinated(chunk.text)) {
            console.warn('[Whisper Worker] Filtered hallucinated chunk:', (chunk.text || '').slice(0, 80));
            return;
        }
        finalizedChunks.push(chunk);
        const text = finalizedChunks.map(c => (c.text || '').trim()).join(' ');
        const chunks = finalizedChunks.map(c => ({
            text: (c.text || '').trim(),
            timestamp: [
                c.timestamp?.[0] != null ? c.timestamp[0] + timeOffset : null,
                c.timestamp?.[1] != null ? c.timestamp[1] + timeOffset : null,
            ],
        }));
        self.postMessage({ status: 'update', data: [text, { chunks }], chunkId });
    }

    let result;
    try {
        result = await pipe(msg.audio, {
            top_k: 0,
            do_sample: false,
            // Temperature fallback: retry with higher temperatures on hallucination
            temperature: [0, 0.2, 0.4, 0.6, 0.8, 1.0],
            // Tighter compression ratio catches hallucinated repetitive segments
            compression_ratio_threshold: 1.35,
            logprob_threshold: -1.0,
            no_speech_threshold: 0.6,
            // Block repeating 3-grams (fixes repeating phrases)
            no_repeat_ngram_size: 3,
            repetition_penalty: 1.2,
            chunk_length_s: msg.chunkLengthS,
            stride_length_s: msg.strideLengthS,
            language: msg.language,
            task: msg.subtask,
            return_timestamps: true,
            force_full_sequences: false,
            condition_on_prev_tokens: true,
            chunk_callback,
        });
    } catch (inferenceError) {
        // GPU inference failed (createBuffer, OOM, device lost) — fall back to WASM and retry
        if (currentBackend !== 'wasm' && isGpuInferenceError(inferenceError) && msg.allowWasm) {
            console.warn('[Whisper Worker] GPU inference failed, falling back to WASM:', inferenceError?.message);
            if (currentBackend === 'webgpu') webgpuBroken = true;
            if (currentBackend === 'webnn') webnnBroken = true;
            // Dispose the broken GPU pipeline
            if (pipelineInstance) {
                try { pipelineInstance.dispose?.(); } catch {}
                pipelineInstance = null;
                pipelineReady = false;
            }
            // Notify host about backend change
            self.postMessage({ status: 'initiate', backend: 'wasm', vendor: '' });
            // Reset finalized chunks for retry
            finalizedChunks = [];
            return transcribe(msg);
        }
        // Non-GPU error or WASM not allowed — report to host
        self.postMessage({ status: 'error', data: { message: inferenceError?.message || String(inferenceError) }, chunkId });
        return null;
    }

    if (result?.chunks) {
        // Filter hallucinated segments from final result
        result.chunks = result.chunks.filter(c => !isHallucinated(c.text));
        if (timeOffset > 0) {
            for (const c of result.chunks) {
                if (c.timestamp) {
                    if (c.timestamp[0] != null) c.timestamp[0] += timeOffset;
                    if (c.timestamp[1] != null) c.timestamp[1] += timeOffset;
                }
            }
        }
    }

    return result || null;
}

// ---- Job queue (sequential) ----

let jobQueue = [];
let jobProcessing = false;

async function processNextJob() {
    if (jobProcessing || jobQueue.length === 0) return;
    jobProcessing = true;
    const msg = jobQueue.shift();

    try {
        const result = await transcribe(msg);
        if (result !== null) {
            self.postMessage({ status: 'complete', task: 'automatic-speech-recognition', data: result, chunkId: msg.chunkId });
        }
    } catch (err) {
        self.postMessage({ status: 'error', data: { message: err instanceof Error ? err.message : String(err) }, chunkId: msg.chunkId });
    }

    jobProcessing = false;
    processNextJob();
}

// ---- Message handler ----

self.addEventListener('message', async (event) => {
    const msg = event.data;

    if (msg.type === 'skip-webgpu') {
        console.log('[Whisper Worker] Received skip-webgpu');
        webgpuBroken = true;
        return;
    }

    if (msg.type === 'skip-webnn') {
        console.log('[Whisper Worker] Received skip-webnn');
        webnnBroken = true;
        return;
    }

    if (msg.type === 'reset') {
        if (pipelineInstance) {
            try { (await pipelineInstance).dispose?.(); } catch {}
            pipelineInstance = null;
        }
        currentModel = null;
        pipelineReady = false;
        return;
    }

    if (msg.type === 'init') {
        try {
            await ensurePipeline(msg);
            self.postMessage({ status: 'ready', backend: currentBackend, vendor: currentVendor });
        } catch (err) {
            self.postMessage({ status: 'error', data: { message: err instanceof Error ? err.message : String(err) } });
        }
        return;
    }

    jobQueue.push(msg);
    processNextJob();
});
`;
}

export function createWhisperWorker(): Worker {
    const workerCode = getWorkerCode();
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    return new Worker(blobUrl, { type: 'module' });
}
