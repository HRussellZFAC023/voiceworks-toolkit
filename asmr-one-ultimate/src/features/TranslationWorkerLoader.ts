/**
 * TranslationWorkerLoader - Local translation worker (Transformers.js)
 *
 * Runs opus-mt translation models in a Web Worker. WebGPU only — no WASM fallback.
 * If GPU fails, host falls through to Google Translate (faster than WASM).
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

// ---- Backend detection (WebGPU only) ----

let currentBackend = 'webgpu';
let currentVendor = '';
let currentDtype = '';
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

function getDtypeCandidates(vendor) {
    // Firefox: fp16 shader compilation hangs on Firefox WebGPU
    if (isFirefox) {
        console.log('[Translation Worker] Firefox: using fp32 only (fp16 hangs)');
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

// ---- GPU memory cleanup ----

/**
 * Release GPU memory after failed pipeline creation.
 * Multiple yields to event loop so browser GC can reclaim orphaned GPU buffers.
 * Note: ort.env.webgpu.device manipulation is intentionally omitted —
 * ONNX Runtime ignores pre-set device references (issue #26107).
 */
async function releaseGpuResources() {
    await new Promise(r => setTimeout(r, 250));
    await new Promise(r => setTimeout(r, 250));
}

// ---- Pipeline management ----

let pipelineInstance = null;
let currentModelName = null;
let pipelineReady = false;

async function ensurePipeline(modelName) {
    await loadTransformers();

    if (pipelineReady && currentModelName === modelName && pipelineInstance) {
        return pipelineInstance;
    }

    // Dispose old pipeline if switching models
    if (pipelineInstance) {
        try { pipelineInstance.dispose?.(); } catch {}
        pipelineInstance = null;
        pipelineReady = false;
        await releaseGpuResources();
    }

    const webgpu = await detectWebGPU();
    if (!webgpu) {
        throw new Error('WebGPU not available for translation');
    }
    currentBackend = 'webgpu';
    currentVendor = webgpu.vendor;

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

    const dtypeCandidates = getDtypeCandidates(currentVendor);

    if (dtypeCandidates.length === 0) {
        throw new Error('No viable WebGPU dtypes for translation');
    }

    let lastError = '';
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
                        device: 'webgpu',
                        dtype,
                    }),
                    PIPELINE_TIMEOUT_MS,
                    'Pipeline creation (' + dtype + ')'
                );
                console.log('[Translation Worker] Model loaded on WebGPU',
                    '(' + currentVendor + ') [' + dtype + ']:', modelName);

                // Validate output quality (fp16 can produce gibberish on some backends)
                const valid = await validatePipeline(candidate, modelName);
                if (!valid) {
                    console.warn('[Translation Worker] Dtype', dtype, 'failed validation, trying next...');
                    try { candidate.dispose?.(); } catch {}
                    break; // try next dtype
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
                const isOrtNumericErr = /^\\d+$/.test(msg.trim());
                const isGpuErr = isMemErr || isContextErr || isTimeout || isOrtNumericErr;

                console.warn('[Translation Worker] Load error:', dtype, hubUrl, msg, err);
                lastError = msg;

                // Release leaked GPU resources from partially-created ONNX sessions
                if (isGpuErr) {
                    await releaseGpuResources();
                }

                // Buffer allocation failed — larger dtypes will also fail.
                // Context/device errors are unrecoverable. Throw immediately.
                if (isMemErr || isContextErr) {
                    await clearModelCache(modelName);
                    throw new Error('WebGPU failed: ' + msg);
                }

                // Timeout or ORT numeric error — skip remaining hubs, try next dtype
                if (isGpuErr) break;
                // Other errors (network) — try next hub URL
            }
        }
    }

    // All WebGPU dtypes exhausted
    await releaseGpuResources();
    await clearModelCache(modelName);
    throw new Error('All WebGPU dtypes failed for ' + modelName + ': ' + lastError);
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
        // Greedy decoding: 3-4x faster than beam search, minimal quality loss on short CJK text.
        // num_beams > 1 doubles GPU time per call, causing contention with Whisper worker.
        num_beams: 1,
        do_sample: false,
        max_new_tokens: Math.min(384, Math.max(64, maxInputLen * 3)),
        repetition_penalty: 1.2,
        no_repeat_ngram_size: 3,
    };

    const output = await pipelineInstance(text, options);
    return extractResult(text, output);
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
