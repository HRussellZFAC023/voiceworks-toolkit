/**
 * EmbeddingWorkerLoader - Local embedding worker (Transformers.js)
 *
 * Runs multilingual-e5-small feature-extraction model in a Web Worker.
 * Supports WebGPU and WASM backends. Returns normalized 384-dim vectors.
 */

function getWorkerCode(): string {
    return `
self.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message = reason && reason.message ? reason.message : String(reason || 'Unknown error');
    if (/WebGPU Context Provider|context.*provider|device lost|GPUDevice|createComputePipeline|createShaderModule|mapAsync|Instance reference|AbortError/i.test(message)) {
        console.warn('[Embedding Worker] Suppressed non-fatal WebGPU error:', message);
        return;
    }
    self.postMessage({ status: 'error', data: { message } });
});

let pipeline;
let env;

const TRANSFORMER_URLS = [
    'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1',
    'https://esm.sh/@huggingface/transformers@3.8.1',
    'https://unpkg.com/@huggingface/transformers@3.8.1?module',
];

const HUB_BASE_URLS = [
    'https://hf-mirror.com',
    'https://huggingface.co',
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
            console.log('[Embedding Worker] Transformers loaded from:', url);
            return;
        } catch (err) {
            console.warn('[Embedding Worker] CDN failed:', url, err);
        }
    }
    throw new Error('Failed to load transformers.js from all CDNs');
}

async function clearModelCache(modelName) {
    if (typeof caches === 'undefined') return;
    try {
        const modelSlug = modelName.split('/').pop();
        const cacheNames = await caches.keys();
        let cleared = 0;
        for (const name of cacheNames) {
            const cache = await caches.open(name);
            const keys = await cache.keys();
            for (const key of keys) {
                if (key.url && key.url.includes(modelSlug)) {
                    await cache.delete(key);
                    cleared++;
                }
            }
        }
        if (cleared > 0) {
            console.log('[Embedding Worker] Cleared', cleared, 'cached entries for', modelName);
        }
    } catch (err) {
        console.warn('[Embedding Worker] Cache clear failed:', err);
    }
}

// ---- WebGPU adapter/device patches (dual-GPU + shader-f16 fixes) ----
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
                    console.warn('[Embedding Worker] requestDevice failed with shader-f16, retrying without:', err?.message);
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

const isFirefox = typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent);

function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(label + ' timed out after ' + ms + 'ms')), ms);
        }),
    ]).finally(() => clearTimeout(timer));
}

// ---- Backend detection ----

let currentBackend = 'wasm';
let currentVendor = '';
let currentDtype = '';
let skipWebgpu = false;
let preferredDtype = '';

async function detectWebGPU() {
    if (typeof navigator === 'undefined' || !('gpu' in navigator)) return null;
    try {
        let adapter = await withTimeout(
            navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }),
            10000, 'requestAdapter'
        );
        if (!adapter) {
            adapter = await withTimeout(
                navigator.gpu.requestAdapter({ powerPreference: 'low-power' }),
                10000, 'requestAdapter(low-power)'
            );
        }
        if (!adapter) return null;
        const info = adapter.info || {};
        const vendor = [info.vendor, info.description, info.architecture].filter(Boolean).join(' ').toLowerCase();
        const maxBuf = adapter.limits?.maxBufferSize || 0;
        console.log('[Embedding Worker] WebGPU adapter:', vendor, '| maxBufferSize:', maxBuf, '(' + Math.round(maxBuf / 1048576) + ' MB)');
        if (maxBuf > 0 && maxBuf < 134217728) {
            console.warn('[Embedding Worker] maxBufferSize too small for embedding model');
            return null;
        }
        try {
            const testDevice = await withTimeout(adapter.requestDevice(), 10000, 'requestDevice');
            testDevice.destroy();
        } catch (deviceErr) {
            console.warn('[Embedding Worker] WebGPU device creation failed:', deviceErr?.message);
            return null;
        }
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
    if (device === 'webgpu') {
        if (isFirefox) {
            console.log('[Embedding Worker] Firefox: using fp32 only (fp16 hangs)');
            return ['fp32'];
        }
        // Encoder-only model — fp16 should work fine on most GPUs
        const candidates = ['fp16', 'fp32'];
        if (preferredDtype && candidates.includes(preferredDtype)) {
            return [preferredDtype, ...candidates.filter(d => d !== preferredDtype)];
        }
        return candidates;
    }
    // WASM: prefer quantized for speed
    const wasmCandidates = ['q8', 'fp32'];
    if (preferredDtype && wasmCandidates.includes(preferredDtype)) {
        return [preferredDtype, ...wasmCandidates.filter(d => d !== preferredDtype)];
    }
    return wasmCandidates;
}

async function releaseGpuResources() {
    try {
        if (typeof globalThis.ort !== 'undefined' && globalThis.ort.env?.webgpu?.device) {
            globalThis.ort.env.webgpu.device = undefined;
        }
    } catch {}
    await new Promise(r => setTimeout(r, 100));
}

// ---- Pipeline management ----

let pipelineInstance = null;
let currentModelName = null;
let pipelineReady = false;

async function ensurePipeline(modelName, _cascadeDepth) {
    if (!_cascadeDepth) _cascadeDepth = 0;
    if (_cascadeDepth > 3) throw new Error('Failed to load model on all backends: ' + modelName);

    await loadTransformers();

    if (pipelineReady && currentModelName === modelName && pipelineInstance) {
        return pipelineInstance;
    }

    if (pipelineInstance) {
        try { pipelineInstance.dispose?.(); } catch {}
        pipelineInstance = null;
        pipelineReady = false;
    }

    const backend = await detectBackend();
    currentBackend = backend.device;
    currentVendor = backend.vendor;

    self.postMessage({ status: 'initiate', backend: currentBackend, vendor: currentVendor });

    const progressCb = (data) => {
        if (!data) return;
        if (data.status === 'progress') {
            self.postMessage({
                status: 'progress',
                file: data.file || data.name || 'model',
                progress: data.progress || 0,
            });
        } else if (data.status === 'initiate') {
            console.log('[Embedding Worker] Downloading:', data.file || data.name);
        } else if (data.status === 'done') {
            console.log('[Embedding Worker] Downloaded:', data.file || data.name);
        }
    };

    const dtypeCandidates = getDtypeCandidates(currentBackend);

    if (dtypeCandidates.length === 0) {
        console.log('[Embedding Worker] No viable dtypes for', currentBackend, '— cascading');
        if (currentBackend === 'webgpu') skipWebgpu = true;
        return ensurePipeline(modelName, _cascadeDepth + 1);
    }

    for (const dtype of dtypeCandidates) {
        for (let hubIdx = 0; hubIdx < HUB_BASE_URLS.length; hubIdx++) {
            const hubUrl = HUB_BASE_URLS[hubIdx];
            env.hub = env.hub || {};
            env.hub.baseUrl = hubUrl;
            env.hub.allowRemoteModels = true;

            try {
                const PIPELINE_TIMEOUT_MS = 120000;
                const candidate = await withTimeout(
                    pipeline('feature-extraction', modelName, {
                        progress_callback: progressCb,
                        device: currentBackend,
                        dtype,
                    }),
                    PIPELINE_TIMEOUT_MS,
                    'Pipeline creation (' + dtype + ')'
                );
                console.log('[Embedding Worker] Model loaded on', currentBackend,
                    '(' + currentVendor + ') [' + dtype + ']:', modelName);

                pipelineInstance = candidate;
                currentModelName = modelName;
                currentDtype = dtype;
                pipelineReady = true;
                return pipelineInstance;
            } catch (err) {
                const msg = String(err?.message || err || '');
                const isMemErr = /allocation|out of memory|OOM|RangeError|createbuffer/i.test(msg);
                const isContextErr = /WebGPU Context Provider|context.*provider|device lost|GPUDevice|createComputePipeline|createShaderModule/i.test(msg);
                const isTimeout = /timed out/i.test(msg);
                const isOrtNumericErr = /^\\d+$/.test(msg.trim());
                const isGpuErr = isMemErr || isContextErr || isTimeout || isOrtNumericErr;

                console.warn('[Embedding Worker] Load error:', dtype, hubUrl, msg, err);

                if (currentBackend === 'webgpu' && isGpuErr) {
                    await releaseGpuResources();
                }

                if (isContextErr && currentBackend === 'webgpu') {
                    console.warn('[Embedding Worker] WebGPU context failed');
                    skipWebgpu = true;
                    return ensurePipeline(modelName, _cascadeDepth + 1);
                }

                if (isGpuErr) break;
            }
        }
    }

    if (currentBackend === 'webgpu') {
        console.warn('[Embedding Worker] All WebGPU candidates failed, releasing GPU and clearing cache');
        await releaseGpuResources();
        await clearModelCache(modelName);
        skipWebgpu = true;
        return ensurePipeline(modelName, _cascadeDepth + 1);
    }

    throw new Error('Failed to load model: ' + modelName);
}

// ---- Embedding ----

function meanPool(embeddings, attentionMask) {
    // embeddings shape: [batch, seq_len, hidden_size]
    // attentionMask shape: [batch, seq_len]
    const batchSize = embeddings.dims[0];
    const seqLen = embeddings.dims[1];
    const hiddenSize = embeddings.dims[2];
    const result = [];

    for (let b = 0; b < batchSize; b++) {
        const vec = new Float32Array(hiddenSize);
        let tokenCount = 0;
        for (let s = 0; s < seqLen; s++) {
            const mask = attentionMask ? attentionMask.data[b * seqLen + s] : 1;
            if (mask > 0) {
                tokenCount++;
                for (let h = 0; h < hiddenSize; h++) {
                    vec[h] += embeddings.data[b * seqLen * hiddenSize + s * hiddenSize + h];
                }
            }
        }
        if (tokenCount > 0) {
            for (let h = 0; h < hiddenSize; h++) {
                vec[h] /= tokenCount;
            }
        }
        // L2 normalize
        let norm = 0;
        for (let h = 0; h < hiddenSize; h++) norm += vec[h] * vec[h];
        norm = Math.sqrt(norm);
        if (norm > 0) {
            for (let h = 0; h < hiddenSize; h++) vec[h] /= norm;
        }
        result.push(Array.from(vec));
    }
    return result;
}

async function embed(texts) {
    await ensurePipeline(currentModelName);

    const output = await pipelineInstance(texts, { pooling: 'mean', normalize: true });

    // output can be a Tensor with shape [batch, hidden_size] (already pooled)
    // or [batch, seq_len, hidden_size] (needs pooling)
    if (output.dims && output.dims.length === 2) {
        // Already pooled and normalized by the pipeline
        const batchSize = output.dims[0];
        const hiddenSize = output.dims[1];
        const result = [];
        for (let b = 0; b < batchSize; b++) {
            const vec = Array.from(output.data.slice(b * hiddenSize, (b + 1) * hiddenSize));
            result.push(vec);
        }
        return result;
    }

    // Fallback: manual mean pooling (shouldn't happen with pooling: 'mean')
    return meanPool(output, null);
}

// ---- Message handler ----

let readySent = false;

self.addEventListener('message', async (event) => {
    const msg = event.data;

    if (msg.type === 'skip-webgpu') {
        skipWebgpu = true;
        console.log('[Embedding Worker] WebGPU disabled by host');
        return;
    }

    if (msg.type === 'preferred-dtype') {
        preferredDtype = msg.dtype || '';
        console.log('[Embedding Worker] Preferred dtype:', preferredDtype);
        return;
    }

    if (msg.type === 'init') {
        try {
            currentModelName = msg.model;
            await ensurePipeline(msg.model);
            if (!readySent) {
                readySent = true;
                self.postMessage({ status: 'ready', backend: currentBackend, vendor: currentVendor, dtype: currentDtype });
            }
        } catch (err) {
            self.postMessage({ status: 'error', data: { message: String(err?.message || err) } });
        }
        return;
    }

    if (msg.type === 'embed') {
        try {
            const results = await embed([msg.text]);
            self.postMessage({ status: 'complete', data: results[0], id: msg.id });
        } catch (err) {
            const errMsg = String(err?.message || err || '');
            const isGpuError = /createBuffer|RangeError|out of memory|OOM|allocation|shader|device lost|GPUDevice|createComputePipeline|createShaderModule/i.test(errMsg);

            if (currentBackend !== 'wasm' && isGpuError) {
                console.warn('[Embedding Worker] GPU inference failed, falling back to WASM:', errMsg);
                skipWebgpu = true;
                if (pipelineInstance) {
                    try { pipelineInstance.dispose?.(); } catch {}
                    pipelineInstance = null;
                    pipelineReady = false;
                }
                await releaseGpuResources();
                self.postMessage({ status: 'initiate', backend: 'wasm', vendor: '' });
                try {
                    const results = await embed([msg.text]);
                    self.postMessage({ status: 'complete', data: results[0], id: msg.id });
                    return;
                } catch (retryErr) {
                    self.postMessage({ status: 'error', data: { message: String(retryErr?.message || retryErr) }, id: msg.id });
                    return;
                }
            }
            self.postMessage({ status: 'error', data: { message: errMsg }, id: msg.id });
        }
        return;
    }

    if (msg.type === 'embed-batch') {
        try {
            const results = await embed(msg.texts);
            self.postMessage({ status: 'complete', data: results, id: msg.id });
        } catch (err) {
            const errMsg = String(err?.message || err || '');
            const isGpuError = /createBuffer|RangeError|out of memory|OOM|allocation|shader|device lost|GPUDevice|createComputePipeline|createShaderModule/i.test(errMsg);

            if (currentBackend !== 'wasm' && isGpuError) {
                console.warn('[Embedding Worker] GPU batch inference failed, falling back to WASM:', errMsg);
                skipWebgpu = true;
                if (pipelineInstance) {
                    try { pipelineInstance.dispose?.(); } catch {}
                    pipelineInstance = null;
                    pipelineReady = false;
                }
                await releaseGpuResources();
                self.postMessage({ status: 'initiate', backend: 'wasm', vendor: '' });
                try {
                    const results = await embed(msg.texts);
                    self.postMessage({ status: 'complete', data: results, id: msg.id });
                    return;
                } catch (retryErr) {
                    self.postMessage({ status: 'error', data: { message: String(retryErr?.message || retryErr) }, id: msg.id });
                    return;
                }
            }
            self.postMessage({
                status: 'error',
                data: { message: errMsg },
                id: msg.id,
            });
        }
        return;
    }
});
`
}

export function createEmbeddingWorker(): Worker {
    const workerCode = getWorkerCode();
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    return new Worker(blobUrl, { type: 'module' });
}
