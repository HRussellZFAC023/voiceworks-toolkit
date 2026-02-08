/**
 * WhisperWorkerLoader - WebGPU Whisper worker (Transformers.js)
 *
 * Rebuilt for real-time transcription with explicit WebGPU requirements,
 * JP-specialized models, and resilient caching.
 */

function getWorkerCode(): string {
    return `
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.0';

// Suppress non-fatal WebGPU errors that ONNX Runtime throws internally during
// EP creation / shader compilation but recovers from on its own.
self.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message = reason && reason.message ? reason.message : String(reason || 'Unknown error');
    if (/WebGPU Context Provider|context.*provider|device lost|GPUDevice|createComputePipeline|createShaderModule|mapAsync|Instance reference|AbortError/i.test(message)) {
        console.warn('[Whisper Worker] Suppressed non-fatal WebGPU error:', message);
        event.preventDefault();
        return;
    }
    self.postMessage({ status: 'error', data: { message } });
});

// ---- WebGPU adapter/device patches (shader-f16 fix for Intel Xe-2 HPG) ----
// ONNX Runtime requests shader-f16 which is reported as supported by the adapter
// but fails on Intel's D3D12 backend, causing mapAsync/Instance reference errors.
// Intercept requestDevice to retry without shader-f16 when it fails.
(function patchWebGPU() {
    if (typeof navigator === 'undefined' || !navigator.gpu) return;
    const origRA = navigator.gpu.requestAdapter.bind(navigator.gpu);
    navigator.gpu.requestAdapter = async function(options) {
        const adapter = await origRA({ ...options, powerPreference: 'high-performance' });
        if (!adapter) return adapter;
        const origRD = adapter.requestDevice.bind(adapter);
        adapter.requestDevice = async function(desc) {
            try {
                return await origRD(desc);
            } catch (err) {
                const feats = [...(desc?.requiredFeatures || [])];
                if (feats.includes('shader-f16')) {
                    console.warn('[Whisper Worker] requestDevice failed with shader-f16, retrying without:', err?.message);
                    const fresh = await origRA({ ...options, powerPreference: 'high-performance' });
                    if (!fresh) throw err;
                    return fresh.requestDevice({ ...desc, requiredFeatures: feats.filter(f => f !== 'shader-f16') });
                }
                throw err;
            }
        };
        return adapter;
    };
})();

env.allowLocalModels = false;
env.allowRemoteModels = true;
// Prefer browser Cache API for near-instant reloads
// (Transformers.js uses this when enabled)
env.useBrowserCache = true;

const HUB_BASE_URLS = [
    'https://huggingface.co',
    'https://hf-mirror.com',
];

let hubBaseIndex = 0;
function setHubBase(index) {
    hubBaseIndex = index;
    const baseUrl = HUB_BASE_URLS[index] || HUB_BASE_URLS[0];
    env.hub = env.hub || {};
    env.hub.baseUrl = baseUrl;
    env.hub.allowRemoteModels = true;
    console.log('[Whisper Worker] Hub base:', baseUrl);
}

function isUnauthorizedError(err) {
    const msg = String(err && err.message ? err.message : err || '');
    return /Unauthorized access to file|401|403|AccessDenied/i.test(msg);
}

// ------------------------------------------------------------
// Backend / dtype selection
// ------------------------------------------------------------

let currentBackend = 'webgpu';
let currentVendor = '';

async function detectBackend() {
    if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
        return { device: 'wasm', vendor: '' };
    }

    try {
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (!adapter) return { device: 'wasm', vendor: '' };
        const info = adapter.info || {};
        const vendor = String(info.vendor || '').toLowerCase();
        const desc = String(info.description || '').toLowerCase();
        const arch = String(info.architecture || '').toLowerCase();
        const full = [vendor, desc, arch].filter(Boolean).join(' ');
        return { device: 'webgpu', vendor: full };
    } catch {
        return { device: 'wasm', vendor: '' };
    }
}

function isIntel(vendor) {
    return vendor.includes('intel') || vendor.includes('xe') || vendor.includes('arc');
}

function chooseDtype(device, vendor, quantized) {
    if (device !== 'webgpu') return null;

    if (isIntel(vendor)) {
        // Intel WebGPU: avoid quantized ops (known to be unstable)
        return { encoder_model: 'fp32', decoder_model_merged: 'fp32' };
    }

    if (quantized) {
        // Faster path for non-Intel GPUs
        return { encoder_model: 'fp32', decoder_model_merged: 'q4' };
    }

    return { encoder_model: 'fp32', decoder_model_merged: 'fp32' };
}

function resolveModelName(model, multilingual) {
    if (model.startsWith('distil-whisper/')) return model;
    return multilingual ? model : model + '.en';
}

// ------------------------------------------------------------
// Pipeline management
// ------------------------------------------------------------

let pipelinePromise = null;
let currentModel = null;
let currentQuantized = null;
let currentMultilingual = null;

async function ensurePipeline(settings, progressCb) {
    const modelName = resolveModelName(settings.model, settings.multilingual);

    if (pipelinePromise && currentModel === modelName && currentQuantized === settings.quantized && currentMultilingual === settings.multilingual) {
        return pipelinePromise;
    }

    // Dispose previous pipeline if needed
    if (pipelinePromise) {
        try { (await pipelinePromise).dispose?.(); } catch {}
        pipelinePromise = null;
    }

    const backend = await detectBackend();
    if (backend.device !== 'webgpu' && !settings.allowWasm) {
        throw new Error('WebGPU is required for Whisper on this device.');
    }

    currentBackend = backend.device;
    currentVendor = backend.vendor || '';

    self.postMessage({ status: 'initiate', backend: currentBackend, vendor: currentVendor });

    const dtype = chooseDtype(currentBackend, currentVendor, settings.quantized);

    const opts = {
        progress_callback: progressCb,
        revision: modelName.includes('/whisper-medium') ? 'no_attentions' : 'main',
        device: currentBackend,
    };

    if (dtype) {
        opts.dtype = dtype;
    } else {
        opts.quantized = settings.quantized;
    }

    let lastErr = null;
    for (let attempt = 0; attempt < HUB_BASE_URLS.length; attempt++) {
        setHubBase(attempt);
        pipelinePromise = pipeline('automatic-speech-recognition', modelName, opts);
        try {
            await pipelinePromise;
            currentModel = modelName;
            currentQuantized = settings.quantized;
            currentMultilingual = settings.multilingual;
            return pipelinePromise;
        } catch (err) {
            lastErr = err;
            pipelinePromise = null;
            currentModel = null;
            currentQuantized = null;
            currentMultilingual = null;
            if (!isUnauthorizedError(err)) {
                throw err;
            }
            console.warn('[Whisper Worker] Unauthorized model fetch, retrying with next hub base...');
        }
    }

    throw lastErr || new Error('Failed to load model');
}

// ------------------------------------------------------------
// Transcription
// ------------------------------------------------------------

async function transcribe(msg) {
    const pipe = await ensurePipeline(msg, (data) => self.postMessage(data));
    self.postMessage({ status: 'ready', backend: currentBackend, vendor: currentVendor });

    const timeOffset = msg.timeOffset || 0;
    const chunkId = msg.chunkId;

    let finalizedChunks = [];

    function chunk_callback(chunk) {
        finalizedChunks.push(chunk);
        const text = finalizedChunks.map(c => (c.text || '').trim()).join(' ');
        const chunks = finalizedChunks.map(c => ({
            text: (c.text || '').trim(),
            timestamp: [
                c.timestamp?.[0] != null ? c.timestamp[0] + timeOffset : null,
                c.timestamp?.[1] != null ? c.timestamp[1] + timeOffset : null,
            ],
        }));
        self.postMessage({
            status: 'update',
            data: [text, { chunks }],
            chunkId,
        });
    }

    const result = await pipe(msg.audio, {
        top_k: 0,
        do_sample: false,
        temperature: 0,
        compression_ratio_threshold: 2.0,
        no_repeat_ngram_size: 3,
        chunk_length_s: msg.chunkLengthS,
        stride_length_s: msg.strideLengthS,
        language: msg.language,
        task: msg.subtask,
        return_timestamps: true,
        force_full_sequences: false,
        chunk_callback,
    }).catch((error) => {
        self.postMessage({
            status: 'error',
            data: { message: error.message || String(error) },
            chunkId,
        });
        return null;
    });

    if (result && result.chunks && timeOffset > 0) {
        for (const c of result.chunks) {
            if (c.timestamp) {
                if (c.timestamp[0] != null) c.timestamp[0] += timeOffset;
                if (c.timestamp[1] != null) c.timestamp[1] += timeOffset;
            }
        }
    }

    return result || null;
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

    if (msg.type === 'reset') {
        if (pipelinePromise) {
            try { (await pipelinePromise).dispose?.(); } catch {}
            pipelinePromise = null;
        }
        currentModel = null;
        currentQuantized = null;
        currentMultilingual = null;
        return;
    }

    if (msg.type === 'init') {
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

/**
 * Creates a Web Worker from inline code using a Blob URL.
 * This bypasses cross-origin restrictions in userscript environments.
 */
export function createWhisperWorker(): Worker {
    const workerCode = getWorkerCode();
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);

    try {
        return new Worker(blobUrl, { type: 'module' });
    } finally {
        URL.revokeObjectURL(blobUrl);
    }
}
