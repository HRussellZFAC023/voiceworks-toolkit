/**
 * TranslationWorkerLoader - Local translation worker (Transformers.js)
 *
 * Runs NLLB-200 model in a Web Worker. Supports WebGPU, WebNN-NPU, and WASM.
 * When both GPU and NPU are available, the host can create two workers
 * (one per device) for distributed inference. Greedy decoding for speed.
 * Supports all JA/ZH/EN pairs via FLORES-200 language codes.
 */

function getWorkerCode(): string {
    return `
self.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message = reason && reason.message ? reason.message : String(reason || 'Unknown error');
    // ONNX Runtime may reject internally during WebGPU EP creation but retry/fallback
    // on its own. Suppress these so we don't kill the worker before ONNX can recover.
    if (/WebGPU Context Provider|context.*provider|device lost|GPUDevice|createComputePipeline|createShaderModule/i.test(message)) {
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

// ---- Backend detection ----

let currentBackend = 'wasm';
let currentVendor = '';
let currentDtype = '';
let skipWebgpu = false;
let skipWebnn = false;
let preferredDtype = '';

async function detectWebNN() {
    if (typeof navigator === 'undefined' || !navigator.ml) return null;
    try {
        const ctx = await navigator.ml.createContext();
        if (!ctx) return null;
        console.log('[Translation Worker] WebNN available');
        return { device: 'webnn', vendor: 'webnn', maxBuf: 0 };
    } catch (err) {
        console.warn('[Translation Worker] WebNN not available:', err?.message);
        return null;
    }
}

async function detectWebGPU() {
    if (typeof navigator === 'undefined' || !('gpu' in navigator)) return null;
    try {
        // Prefer discrete GPU; fall back to integrated if unavailable
        let adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (!adapter) {
            adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' });
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
        return { device: 'webgpu', vendor, maxBuf };
    } catch {
        return null;
    }
}

async function detectBackend() {
    // Standard cascade: WebGPU > WebNN > WASM
    if (!skipWebgpu) {
        const webgpu = await detectWebGPU();
        if (webgpu) return webgpu;
    }
    if (!skipWebnn) {
        const webnn = await detectWebNN();
        if (webnn) return webnn;
    }
    return { device: 'wasm', vendor: '', maxBuf: 0 };
}

function getDtypeCandidates(device, vendor, maxBuf) {
    if (device === 'webnn') {
        // WebNN: fp16 preferred (good perf/memory), fp32 fallback
        const webnnCandidates = ['fp16', 'fp32'];
        if (preferredDtype && webnnCandidates.includes(preferredDtype)) {
            return [preferredDtype, ...webnnCandidates.filter(d => d !== preferredDtype)];
        }
        return webnnCandidates;
    }
    if (device === 'webgpu') {
        // q8: produces gibberish on WebGPU decoders (transformers.js#1317).
        const isIntel = /intel|xe|arc/i.test(vendor);
        const isQualcomm = /qualcomm|adreno/i.test(vendor);
        // fp32 models (~236MB) need >= 256MB maxBufferSize
        const canFp32 = maxBuf === 0 || maxBuf >= 268435456;

        let candidates;
        if (isIntel || isQualcomm) {
            // Intel Xe-2 HPG: fp16 shaders produce garbage output.
            // Adreno: lacks shader-f16 (uniformAndStorageBuffer16BitAccess).
            // Prefer fp32; fall back to fp16 with validation if buffer too small.
            candidates = canFp32 ? ['fp32', 'fp16'] : ['fp16'];
        } else {
            // Apple Silicon, NVIDIA, AMD, Mali: fp16 works well, uses less memory.
            candidates = canFp32 ? ['fp16', 'fp32'] : ['fp16'];
        }

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

    for (const dtype of dtypeCandidates) {
        for (let hubIdx = 0; hubIdx < HUB_BASE_URLS.length; hubIdx++) {
            const hubUrl = HUB_BASE_URLS[hubIdx];
            env.hub = env.hub || {};
            env.hub.baseUrl = hubUrl;
            env.hub.allowRemoteModels = true;

            try {
                const candidate = await pipeline('translation', modelName, {
                    progress_callback: progressCb,
                    device: currentBackend,
                    dtype,
                });
                console.log('[Translation Worker] Model loaded on', currentBackend,
                    '(' + currentVendor + ') [' + dtype + ']:', modelName);

                // Validate output quality (fp16/q8 can produce gibberish on some backends)
                if (currentBackend === 'webgpu' || currentBackend === 'webnn') {
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

                console.warn('[Translation Worker] Load error:', dtype, hubUrl, msg, err);

                // WebGPU context failed — cascade to next backend
                if (isContextErr && currentBackend === 'webgpu') {
                    console.warn('[Translation Worker] WebGPU context failed');
                    skipWebgpu = true;
                    return ensurePipeline(modelName, _cascadeDepth + 1);
                }

                // Memory error — skip remaining hubs, try next dtype
                if (isMemErr) break;
                // Other errors (network, WASM abort) — try next hub URL
            }
        }
    }

    // All candidates for current backend exhausted — clear potentially corrupt
    // cache entries before cascading to the next backend
    if (currentBackend === 'webgpu') {
        console.warn('[Translation Worker] All WebGPU candidates failed, clearing cache');
        await clearModelCache(modelName);
        skipWebgpu = true;
        return ensurePipeline(modelName, _cascadeDepth + 1);
    }
    if (currentBackend === 'webnn') {
        console.warn('[Translation Worker] All WebNN candidates failed, clearing cache');
        await clearModelCache(modelName);
        skipWebnn = true;
        return ensurePipeline(modelName, _cascadeDepth + 1);
    }

    throw new Error('Failed to load model: ' + modelName);
}

// ---- Validation ----

const VALIDATION_TESTS = {
    'Xenova/opus-mt-ja-en': { input: 'テスト', expect: /test/i },
    'Xenova/opus-mt-zh-en': { input: '测试', expect: /test/i },
    'Xenova/nllb-200-distilled-600M': {
        input: 'テスト', expect: /test/i,
        src_lang: 'jpn_Jpan', tgt_lang: 'eng_Latn',
    },
};

async function validatePipeline(pipe, modelName) {
    const test = VALIDATION_TESTS[modelName];
    if (!test) return true; // no test available, assume OK
    try {
        const opts = { num_beams: 1, max_new_tokens: 32 };
        if (test.src_lang) opts.src_lang = test.src_lang;
        if (test.tgt_lang) opts.tgt_lang = test.tgt_lang;
        const out = await pipe(test.input, opts);
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

    // NLLB requires explicit language codes
    if (msg.src_lang) options.src_lang = msg.src_lang;
    if (msg.tgt_lang) options.tgt_lang = msg.tgt_lang;

    try {
        const output = await pipelineInstance(text, options);
        return extractResult(text, output);
    } catch (err) {
        const errMsg = String(err?.message || err || '');
        const isGpuError = /createBuffer|RangeError|out of memory|OOM|allocation|shader|device lost|GPUDevice|createComputePipeline|createShaderModule/i.test(errMsg);

        // GPU inference failed — dispose pipeline, switch backend, retry once
        if (currentBackend !== 'wasm' && isGpuError) {
            console.warn('[Translation Worker] GPU inference failed, falling back to WASM:', errMsg);
            if (currentBackend === 'webgpu') skipWebgpu = true;
            if (currentBackend === 'webnn') skipWebnn = true;
            // Dispose the broken GPU pipeline
            if (pipelineInstance) {
                try { pipelineInstance.dispose?.(); } catch {}
                pipelineInstance = null;
                pipelineReady = false;
            }
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
        // Sub-group by src_lang|tgt_lang so NLLB batches have consistent language codes
        const langGroups = new Map();
        for (const job of singles) {
            const key = (job.src_lang || '') + '|' + (job.tgt_lang || '');
            if (!langGroups.has(key)) langGroups.set(key, []);
            langGroups.get(key).push(job);
        }
        for (const [, group] of langGroups) {
            const texts = group.map(j => j.text);
            try {
                const results = await translate({ ...group[0], text: texts });
                group.forEach((job, i) => {
                    self.postMessage({ status: 'complete', data: results[i], id: job.id });
                });
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                group.forEach(job => {
                    self.postMessage({ status: 'error', data: { message: errMsg }, id: job.id });
                });
            }
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

    if (msg.type === 'skip-webnn') {
        skipWebnn = true;
        console.log('[Translation Worker] WebNN disabled by host');
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
