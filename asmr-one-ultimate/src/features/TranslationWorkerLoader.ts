/**
 * TranslationWorkerLoader - Local translation worker (Transformers.js)
 *
 * Runs opus-mt translation models in a Web Worker. Supports WebGPU and WASM.
 * Greedy decoding for speed. MarianMT architecture (fixed source→target direction).
 */

function getWorkerCode(): string {
    return `
self.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message = reason && reason.message ? reason.message : String(reason || 'Unknown error');
    // ONNX Runtime may reject internally during WebGPU EP creation but retry/fallback
    // on its own. Suppress these so we don't kill the worker before ONNX can recover.
    if (/WebGPU Context Provider|context.*provider|device lost|GPUDevice|createComputePipeline|createShaderModule|mapAsync|Instance reference|AbortError/i.test(message)) {
        console.warn('[Translation Worker] Suppressed non-fatal WebGPU error:', message);
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
            console.log('[Translation Worker] Transformers loaded from:', url);
            return;
        } catch (err) {
            console.warn('[Translation Worker] CDN failed:', url, err);
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
            console.log('[Translation Worker] Cleared', cleared, 'cached entries for', modelName);
        }
    } catch (err) {
        console.warn('[Translation Worker] Cache clear failed:', err);
    }
}

// ---- WebGPU adapter/device patches (dual-GPU + shader-f16 fixes) ----
// Fixes: (1) Chrome using wrong GPU on dual-GPU laptops (AMD iGPU + Intel Arc dGPU)
//        (2) ONNX Runtime requesting shader-f16 which fails on some D3D12 backends
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
                    console.warn('[Translation Worker] requestDevice failed with shader-f16, retrying without:', err?.message);
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
if (isFirefox) console.log('[Translation Worker] Firefox detected');

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
        // Prefer discrete GPU; fall back to integrated if unavailable
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
        console.log('[Translation Worker] WebGPU adapter:', vendor, '| maxBufferSize:', maxBuf, '(' + Math.round(maxBuf / 1048576) + ' MB)');
        if (maxBuf > 0 && maxBuf < 134217728) {
            console.warn('[Translation Worker] maxBufferSize too small for translation models');
            return null;
        }
        // Verify device creation actually works (adapter detection alone fails on dual-GPU systems)
        try {
            const testDevice = await withTimeout(adapter.requestDevice(), 10000, 'requestDevice');
            testDevice.destroy();
        } catch (deviceErr) {
            console.warn('[Translation Worker] WebGPU device creation failed:', deviceErr?.message);
            return null;
        }
        return { device: 'webgpu', vendor, maxBuf };
    } catch {
        return null;
    }
}

async function detectBackend() {
    // Cascade: WebGPU > WASM
    if (!skipWebgpu) {
        const webgpu = await detectWebGPU();
        if (webgpu) return webgpu;
    }
    return { device: 'wasm', vendor: '', maxBuf: 0 };
}

function getDtypeCandidates(device, vendor, maxBuf) {
    if (device === 'webgpu') {
        // Firefox: fp16 shader compilation hangs on Firefox WebGPU
        if (isFirefox) {
            console.log('[Translation Worker] Firefox: using fp32 only (fp16 hangs)');
            return ['fp32'];
        }
        // opus-mt models are small (~52MB fp16) — fp16 works on virtually any GPU
        const candidates = ['fp16', 'fp32'];
        if (preferredDtype && candidates.includes(preferredDtype)) {
            return [preferredDtype, ...candidates.filter(d => d !== preferredDtype)];
        }
        return candidates;
    }
    const wasmCandidates = ['q8', 'q4'];
    if (preferredDtype && wasmCandidates.includes(preferredDtype)) {
        return [preferredDtype, ...wasmCandidates.filter(d => d !== preferredDtype)];
    }
    return wasmCandidates;
}

// ---- GPU memory cleanup ----

/**
 * Release GPU memory after failed pipeline creation.
 * When pipeline() throws partway through, ONNX sessions (encoder/decoder) may
 * have allocated GPU buffers we can't reach. Yield to GC + release ONNX EP.
 */
async function releaseGpuResources() {
    // 1. Try to release ONNX Runtime's execution provider resources
    try {
        if (typeof globalThis.ort !== 'undefined' && globalThis.ort.env?.webgpu?.device) {
            // Force ONNX RT to drop its device reference
            globalThis.ort.env.webgpu.device = undefined;
        }
    } catch {}
    // 2. Yield to event loop so browser GC can reclaim orphaned GPU buffers
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

    // Dispose old pipeline if switching models
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
            console.log('[Translation Worker] Downloading:', data.file || data.name);
        } else if (data.status === 'done') {
            console.log('[Translation Worker] Downloaded:', data.file || data.name);
        }
    };

    const dtypeCandidates = getDtypeCandidates(currentBackend, currentVendor, backend.maxBuf);

    // No viable dtypes for this backend (e.g. Intel/Qualcomm iGPU) — skip directly
    // without clearing cache (nothing was downloaded for this backend)
    if (dtypeCandidates.length === 0) {
        console.log('[Translation Worker] No viable dtypes for', currentBackend, '— cascading');
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
                    pipeline('translation', modelName, {
                        progress_callback: progressCb,
                        device: currentBackend,
                        dtype,
                    }),
                    PIPELINE_TIMEOUT_MS,
                    'Pipeline creation (' + dtype + ')'
                );
                console.log('[Translation Worker] Model loaded on', currentBackend,
                    '(' + currentVendor + ') [' + dtype + ']:', modelName);

                // Validate output quality (fp16/q8 can produce gibberish on some backends)
                if (currentBackend === 'webgpu') {
                    const valid = await validatePipeline(candidate, modelName);
                    if (!valid) {
                        console.warn('[Translation Worker] Dtype', dtype, 'failed validation, trying next...');
                        try { candidate.dispose?.(); } catch {}
                        break; // try next dtype
                    }
                }

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
                // ONNX Runtime sometimes throws bare numeric errors (buffer size) on session creation failure
                const isOrtNumericErr = /^\\d+$/.test(msg.trim());
                const isGpuErr = isMemErr || isContextErr || isTimeout || isOrtNumericErr;

                console.warn('[Translation Worker] Load error:', dtype, hubUrl, msg, err);

                // Release leaked GPU resources from partially-created ONNX sessions
                if (currentBackend === 'webgpu' && isGpuErr) {
                    await releaseGpuResources();
                }

                // WebGPU context failed — cascade to next backend
                if (isContextErr && currentBackend === 'webgpu') {
                    console.warn('[Translation Worker] WebGPU context failed');
                    skipWebgpu = true;
                    return ensurePipeline(modelName, _cascadeDepth + 1);
                }

                // Memory/session error or pipeline timeout — skip remaining hubs, try next dtype
                if (isGpuErr) break;
                // Other errors (network, WASM abort) — try next hub URL
            }
        }
    }

    // All candidates for current backend exhausted — release GPU memory and clear
    // potentially corrupt cache entries before cascading to the next backend
    if (currentBackend === 'webgpu') {
        console.warn('[Translation Worker] All WebGPU candidates failed, releasing GPU and clearing cache');
        await releaseGpuResources();
        await clearModelCache(modelName);
        skipWebgpu = true;
        return ensurePipeline(modelName, _cascadeDepth + 1);
    }

    throw new Error('Failed to load model: ' + modelName);
}

// ---- Validation ----

const VALIDATION_TESTS = {
    'Xenova/opus-mt-ja-en': { input: 'テスト', expect: /test/i },
    'Xenova/opus-mt-zh-en': { input: '测试', expect: /test/i },
};

async function validatePipeline(pipe, modelName) {
    const test = VALIDATION_TESTS[modelName];
    if (!test) return true; // no test available, assume OK
    try {
        const opts = { num_beams: 1, max_new_tokens: 32 };

        // Timeout: inference can hang forever on some GPU/driver combos (Intel Xe-2, etc.)
        const VALIDATION_TIMEOUT_MS = 30000;
        const out = await Promise.race([
            pipe(test.input, opts),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Validation timed out after ' + VALIDATION_TIMEOUT_MS + 'ms')), VALIDATION_TIMEOUT_MS)
            ),
        ]);

        const text = out?.[0]?.translation_text || out?.translation_text || '';
        if (!text || !test.expect.test(text)) {
            console.warn('[Translation Worker] Validation FAILED for', modelName,
                '| got:', JSON.stringify(text), '| expected:', test.expect);
            return false;
        }
        console.log('[Translation Worker] Validation OK:', modelName, '->', JSON.stringify(text));
        return true;
    } catch (err) {
        console.warn('[Translation Worker] Validation error for', modelName, ':', err);
        return false;
    }
}

// ---- Translation ----

function extractResult(text, output) {
    if (!output) return text;
    if (Array.isArray(text)) {
        if (!Array.isArray(output)) return text;
        return output.map((item, i) => (item?.translation_text) || text[i] || '');
    }
    if (Array.isArray(output)) return output[0]?.translation_text || text;
    return output?.translation_text || text;
}

async function translate(msg) {
    const model = msg.model;
    await ensurePipeline(model);

    const text = msg.text;

    // Scale max tokens to input — CJK→EN expands ~3x. Floor 64, cap 384.
    const maxInputLen = Array.isArray(text)
        ? Math.max(...text.map(t => t.length))
        : text.length;

    const options = {
        return_tensors: false,
        // Greedy decoding: ~3-4x faster than beam search, minimal quality loss on short text
        num_beams: 1,
        do_sample: false,
        max_new_tokens: Math.min(384, Math.max(64, maxInputLen * 3)),
        repetition_penalty: 1.2,
        no_repeat_ngram_size: 3,
    };

    try {
        const output = await pipelineInstance(text, options);
        return extractResult(text, output);
    } catch (err) {
        const errMsg = String(err?.message || err || '');
        const isGpuError = /createBuffer|RangeError|out of memory|OOM|allocation|shader|device lost|GPUDevice|createComputePipeline|createShaderModule/i.test(errMsg)
            || /^\\d+$/.test(errMsg.trim());

        // GPU inference failed — dispose pipeline, release GPU memory, switch backend, retry once
        if (currentBackend !== 'wasm' && isGpuError) {
            console.warn('[Translation Worker] GPU inference failed, falling back to WASM:', errMsg);
            skipWebgpu = true;
            // Dispose the broken GPU pipeline and release GPU memory
            if (pipelineInstance) {
                try { pipelineInstance.dispose?.(); } catch {}
                pipelineInstance = null;
                pipelineReady = false;
            }
            await releaseGpuResources();
            // Notify host about backend change
            self.postMessage({ status: 'initiate', backend: 'wasm', vendor: '' });
            // Retry: ensurePipeline will now pick WASM
            await ensurePipeline(model);
            const output = await pipelineInstance(text, options);
            return extractResult(text, output);
        }
        throw err;
    }
}

// ---- Job queue with coalescing ----

const COALESCE_MS = 8;
const MAX_BATCH = 500;
let jobQueue = [];
let coalesceTimer = null;
let processing = false;

async function processBatch() {
    if (processing || jobQueue.length === 0) return;
    processing = true;
    coalesceTimer = null;

    const jobs = jobQueue.splice(0, MAX_BATCH);

    // Coalesce single-text jobs into batches, grouped by language pair
    const singles = jobs.filter(j => typeof j.text === 'string');
    const batches = jobs.filter(j => Array.isArray(j.text));

    if (singles.length > 0) {
        // All singles for this worker share the same model/direction — batch them
        const texts = singles.map(j => j.text);
        try {
            const results = await translate({ ...singles[0], text: texts });
            singles.forEach((job, i) => {
                self.postMessage({ status: 'complete', data: results[i], id: job.id });
            });
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            singles.forEach(job => {
                self.postMessage({ status: 'error', data: { message: errMsg }, id: job.id });
            });
        }
    }

    for (const job of batches) {
        try {
            const result = await translate(job);
            self.postMessage({ status: 'complete', data: result, id: job.id });
        } catch (err) {
            self.postMessage({
                status: 'error',
                data: { message: err instanceof Error ? err.message : String(err) },
                id: job.id,
            });
        }
    }

    processing = false;
    if (jobQueue.length > 0) scheduleProcess();
}

function scheduleProcess() {
    if (coalesceTimer) return;
    if (jobQueue.length >= MAX_BATCH) {
        processBatch();
    } else {
        coalesceTimer = setTimeout(processBatch, COALESCE_MS);
    }
}

// ---- Message handler ----

let readySent = false;

self.addEventListener('message', async (event) => {
    const msg = event.data;

    if (msg.type === 'skip-webgpu') {
        skipWebgpu = true;
        console.log('[Translation Worker] WebGPU disabled by host');
        return;
    }

    if (msg.type === 'preferred-dtype') {
        preferredDtype = msg.dtype || '';
        console.log('[Translation Worker] Preferred dtype:', preferredDtype);
        return;
    }

    if (msg.type === 'init') {
        try {
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

    if (msg.type === 'translate') {
        // Send ready on first translate if init was skipped
        if (!readySent && pipelineReady) {
            readySent = true;
            self.postMessage({ status: 'ready', backend: currentBackend, vendor: currentVendor, dtype: currentDtype });
        }
        jobQueue.push(msg);
        scheduleProcess();
    }
});
`
}

export function createTranslationWorker(): Worker {
    const workerCode = getWorkerCode();
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    return new Worker(blobUrl, { type: 'module' });
}
