/**
 * EmbeddingWorkerLoader - Local embedding worker (Transformers.js)
 *
 * Runs multilingual-e5-small feature-extraction model in a Web Worker.
 * Supports WebGPU and WASM backends. Returns normalized 384-dim vectors.
 */

function getWorkerCode(): string {
    return `
let gpuDeviceLost = false;

self.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message = reason && reason.message ? reason.message : String(reason || 'Unknown error');
    if (/WebGPU Context Provider|context.*provider|device lost|GPUDevice|createComputePipeline|createShaderModule|mapAsync|Instance reference|AbortError/i.test(message)) {
        event.preventDefault();
        // Fatal GPU device loss — notify host so it can broadcast to other workers
        if (/device lost|Instance reference/i.test(message)) {
            if (!gpuDeviceLost) {
                gpuDeviceLost = true;
                skipWebgpu = true;
                console.error('[Embedding Worker] Fatal GPU device loss:', message);
                self.postMessage({ status: 'gpu-device-lost', data: { message } });
            }
        } else {
            console.warn('[Embedding Worker] Suppressed non-fatal WebGPU error:', message);
        }
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
        // Direct requestAdapter — no timeout wrapper.
        // withTimeout creates dangling promises that interfere with subsequent
        // requestAdapter calls from ONNX Runtime internally.
        let adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (!adapter) {
            adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' });
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

function getDtypeCandidates(device, vendor) {
    if (device === 'webgpu') {
        if (isFirefox) {
            console.log('[Embedding Worker] Firefox: using fp32 only (fp16 hangs)');
            return ['fp32'];
        }
        const isIntel = /intel|xe|arc/i.test(vendor);
        const isQualcomm = /qualcomm|adreno/i.test(vendor);
        // Intel Xe-2 HPG / Qualcomm Adreno: fp32 first (fp16 may produce garbage)
        // Others (Apple, NVIDIA, AMD): fp16 first (uses less memory, faster)
        const candidates = (isIntel || isQualcomm) ? ['fp32', 'fp16'] : ['fp16', 'fp32'];
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

/**
 * Release GPU memory after failed pipeline creation.
 * Yield to event loop so browser GC can reclaim orphaned GPU buffers.
 * Note: ort.env.webgpu.device manipulation is intentionally omitted —
 * ONNX Runtime ignores pre-set device references (issue #26107).
 */
async function releaseGpuResources() {
    await new Promise(r => setTimeout(r, 100));
}

// ---- Pipeline management ----

let pipelineInstance = null;
let currentModelName = null;
let pipelineReady = false;
let pipelineLoading = null; // Serializes concurrent ensurePipeline calls

async function ensurePipeline(modelName, _cascadeDepth) {
    if (!_cascadeDepth) _cascadeDepth = 0;
    if (_cascadeDepth > 3) throw new Error('Failed to load model on all backends: ' + modelName);

    await loadTransformers();

    if (pipelineReady && currentModelName === modelName && pipelineInstance) {
        return pipelineInstance;
    }

    // Serialize concurrent pipeline loads — prevents duplicate model downloads
    // when multiple embed calls fail simultaneously and all try to reload
    if (pipelineLoading) {
        await pipelineLoading;
        if (pipelineReady && currentModelName === modelName && pipelineInstance) {
            return pipelineInstance;
        }
    }

    const loadPromise = _loadPipeline(modelName, _cascadeDepth);
    pipelineLoading = loadPromise;
    try {
        return await loadPromise;
    } finally {
        if (pipelineLoading === loadPromise) {
            pipelineLoading = null;
        }
    }
}

async function _loadPipeline(modelName, _cascadeDepth) {
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

    const dtypeCandidates = getDtypeCandidates(currentBackend, currentVendor);

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

// ---- GPU error recovery ----

const GPU_ERROR_RE = /createBuffer|RangeError|out of memory|OOM|allocation|shader|device lost|GPUDevice|createComputePipeline|createShaderModule/i;

/**
 * Switch to WASM backend. Serialized: if already switching, returns the
 * in-progress promise so concurrent callers don't double-dispose.
 */
let wasmSwitchPromise = null;

async function switchToWasm(errMsg) {
    if (wasmSwitchPromise) return wasmSwitchPromise;
    wasmSwitchPromise = (async () => {
        console.warn('[Embedding Worker] GPU inference failed, falling back to WASM:', errMsg);
        skipWebgpu = true;
        if (!gpuDeviceLost) {
            gpuDeviceLost = true;
            self.postMessage({ status: 'gpu-device-lost', data: { message: errMsg } });
        }
        if (pipelineInstance) {
            try { pipelineInstance.dispose?.(); } catch {}
            pipelineInstance = null;
            pipelineReady = false;
        }
        await releaseGpuResources();
        self.postMessage({ status: 'initiate', backend: 'wasm', vendor: '' });
    })();
    try {
        await wasmSwitchPromise;
    } finally {
        wasmSwitchPromise = null;
    }
}

/**
 * Attempt embed with GPU error recovery.
 * If GPU fails, switches to WASM and retries.
 * Handles race condition where concurrent calls fail simultaneously:
 * switchToWasm() is serialized, and ensurePipeline() has a loading gate.
 */
async function embedWithRecovery(texts) {
    try {
        return await embed(texts);
    } catch (err) {
        const errMsg = String(err?.message || err || '');
        if (!GPU_ERROR_RE.test(errMsg)) throw err;

        // GPU error — switch to WASM if not already there
        if (currentBackend !== 'wasm') {
            await switchToWasm(errMsg);
        } else if (!gpuDeviceLost) {
            // Already on WASM but got a GPU error from an old session's in-flight op.
            // Report device loss but don't need to switch backends.
            gpuDeviceLost = true;
            self.postMessage({ status: 'gpu-device-lost', data: { message: errMsg } });
        }

        // Retry on WASM — ensurePipeline will create/return WASM pipeline
        return await embed(texts);
    }
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
            const results = await embedWithRecovery([msg.text]);
            self.postMessage({ status: 'complete', data: results[0], id: msg.id });
        } catch (err) {
            self.postMessage({ status: 'error', data: { message: String(err?.message || err || '') }, id: msg.id });
        }
        return;
    }

    if (msg.type === 'embed-batch') {
        try {
            const results = await embedWithRecovery(msg.texts);
            self.postMessage({ status: 'complete', data: results, id: msg.id });
        } catch (err) {
            self.postMessage({ status: 'error', data: { message: String(err?.message || err || '') }, id: msg.id });
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
