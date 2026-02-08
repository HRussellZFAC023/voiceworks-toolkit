/**
 * WhisperWorkerLoader - WebGPU Whisper worker (Transformers.js)
 *
 * Runs whisper models in a Web Worker. Prefers WebGPU with fp32+q4 dtype,
 * falls back to WASM. Dynamic import with CDN fallback for resilience.
 * Supports word-level timestamps and real-time streaming.
 */

function getWorkerCode(): string {
    return `
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

let pipeline;
let env;

const TRANSFORMER_URLS = [
    'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1',
    'https://esm.sh/@huggingface/transformers@3.8.1',
    'https://unpkg.com/@huggingface/transformers@3.8.1?module',
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

function isUnauthorizedError(err) {
    const msg = String(err && err.message ? err.message : err || '');
    return /Unauthorized access to file|401|403|AccessDenied/i.test(msg);
}

// ------------------------------------------------------------
// Backend / dtype selection
// ------------------------------------------------------------

let currentBackend = 'wasm';
let currentVendor = '';
let currentDtype = '';
let skipWebgpu = false;
let preferredDtype = '';

async function detectWebGPU() {
    if (typeof navigator === 'undefined' || !('gpu' in navigator)) return null;
    try {
        // Direct requestAdapter — no withTimeout wrapper.
        // ae78075 pattern: let the browser take as long as it needs.
        let adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (!adapter) {
            adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' });
        }
        if (!adapter) return null;
        const info = adapter.info || {};
        const vendor = [info.vendor, info.description, info.architecture].filter(Boolean).join(' ').toLowerCase();
        const maxBuf = adapter.limits?.maxBufferSize || 0;
        console.log('[Whisper Worker] WebGPU adapter:', vendor, '| maxBufferSize:', maxBuf, '(' + Math.round(maxBuf / 1048576) + ' MB)');
        if (maxBuf > 0 && maxBuf < 268435456) {
            console.warn('[Whisper Worker] maxBufferSize too small for Whisper models');
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
    if (device !== 'webgpu') return null;
    // Per HuggingFace docs: encoder-decoder models like Whisper need per-module dtype.
    // fp16 decoder FAILS (Transformers.js #894), q8 decoder gibberish on WebGPU (#1317).
    // Official config: encoder fp32, decoder q4.
    return [{ encoder_model: 'fp32', decoder_model_merged: 'q4' }];
}

function resolveModelName(model, multilingual) {
    if (model.startsWith('distil-whisper/')) return model;
    return multilingual ? model : model + '.en';
}

async function releaseGpuResources() {
    // Yield to event loop so browser GC can reclaim orphaned GPU buffers
    await new Promise(r => setTimeout(r, 100));
}

// ------------------------------------------------------------
// Pipeline management
// ------------------------------------------------------------

let pipelinePromise = null;
let currentModel = null;
let currentQuantized = null;
let currentMultilingual = null;

async function ensurePipeline(settings, progressCb) {
    await loadTransformers();

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
    currentBackend = backend.device;
    currentVendor = backend.vendor || '';

    self.postMessage({ status: 'initiate', backend: currentBackend, vendor: currentVendor });

    const revision = modelName.includes('/whisper-medium') ? 'no_attentions' : 'main';

    // --- WebGPU path: try dtype candidates ---
    if (currentBackend === 'webgpu') {
        const dtypeCandidates = getDtypeCandidates(currentBackend);
        if (dtypeCandidates) {
            for (const dtype of dtypeCandidates) {
                for (let hubIdx = 0; hubIdx < HUB_BASE_URLS.length; hubIdx++) {
                    env.hub = env.hub || {};
                    env.hub.baseUrl = HUB_BASE_URLS[hubIdx];
                    env.hub.allowRemoteModels = true;

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
                        currentQuantized = settings.quantized;
                        currentMultilingual = settings.multilingual;
                        currentDtype = JSON.stringify(dtype);
                        console.log('[Whisper Worker] Model loaded on webgpu [' + currentDtype + ']:', modelName);
                        return pipelinePromise;
                    } catch (err) {
                        pipelinePromise = null;
                        const msg = String(err?.message || err || '');
                        const isMemErr = /allocation|out of memory|OOM|RangeError|createbuffer/i.test(msg);
                        const isContextErr = /WebGPU Context Provider|context.*provider|device lost|GPUDevice|createComputePipeline|createShaderModule/i.test(msg);
                        const isTimeout = /timed out/i.test(msg);
                        const isGpuErr = isMemErr || isContextErr || isTimeout;

                        console.warn('[Whisper Worker] WebGPU load error:', JSON.stringify(dtype), msg);

                        if (isGpuErr) {
                            await releaseGpuResources();
                            break; // try next dtype
                        }
                        if (isContextErr) {
                            skipWebgpu = true;
                            break;
                        }
                        if (!isUnauthorizedError(err)) break;
                        // Unauthorized → try next hub
                    }
                }
            }
            // All WebGPU dtypes failed
            console.warn('[Whisper Worker] All WebGPU candidates failed, falling through to WASM');
            skipWebgpu = true;
            currentBackend = 'wasm';
            currentVendor = '';
            self.postMessage({ status: 'initiate', backend: 'wasm', vendor: '' });
        }
    }

    // --- WASM path ---
    if (!settings.allowWasm) {
        throw new Error('WebGPU is required for Whisper on this device.');
    }

    const wasmOpts = {
        progress_callback: progressCb,
        revision,
        device: 'wasm',
        quantized: settings.quantized,
    };

    let lastErr = null;
    for (let hubIdx = 0; hubIdx < HUB_BASE_URLS.length; hubIdx++) {
        env.hub = env.hub || {};
        env.hub.baseUrl = HUB_BASE_URLS[hubIdx];
        env.hub.allowRemoteModels = true;

        pipelinePromise = pipeline('automatic-speech-recognition', modelName, wasmOpts);
        try {
            await pipelinePromise;
            currentModel = modelName;
            currentQuantized = settings.quantized;
            currentMultilingual = settings.multilingual;
            currentDtype = 'wasm';
            console.log('[Whisper Worker] Model loaded on wasm:', modelName);
            return pipelinePromise;
        } catch (err) {
            lastErr = err;
            pipelinePromise = null;
            if (!isUnauthorizedError(err)) {
                throw err;
            }
            console.warn('[Whisper Worker] Unauthorized model fetch, retrying with next hub base...');
        }
    }

    throw lastErr || new Error('Failed to load model');
}

// ------------------------------------------------------------
// Transcription (word-level timestamps with segment grouping)
// ------------------------------------------------------------

let wordTimestampsSupported = true;

const SEGMENT_GAP_S = 0.5;

function isCJKText(text) {
    return /[\u3040-\u30ff\u4e00-\u9fff]/.test(text);
}

function isWordLevelChunks(chunks) {
    if (!chunks || chunks.length < 3) return false;
    let totalDur = 0;
    for (const c of chunks) {
        const s = c.timestamp?.[0] ?? 0;
        const e = c.timestamp?.[1] ?? s;
        totalDur += Math.max(0, e - s);
    }
    return (totalDur / chunks.length) < 1.5;
}

function groupWordsToSegments(words, offset) {
    if (!words || words.length === 0) return [];
    const segments = [];
    let seg = [words[0]];
    for (let i = 1; i < words.length; i++) {
        const prev = words[i - 1];
        const curr = words[i];
        const prevEnd = prev.timestamp?.[1] ?? prev.timestamp?.[0] ?? 0;
        const currStart = curr.timestamp?.[0] ?? prevEnd;
        if (currStart - prevEnd > SEGMENT_GAP_S) {
            segments.push(buildSegmentFromWords(seg, offset));
            seg = [curr];
        } else {
            seg.push(curr);
        }
    }
    if (seg.length > 0) segments.push(buildSegmentFromWords(seg, offset));
    return segments;
}

function buildSegmentFromWords(words, offset) {
    const texts = words.map(w => (w.text || '').trim()).filter(Boolean);
    const joinChar = texts.some(t => isCJKText(t)) ? '' : ' ';
    const text = texts.join(joinChar).trim();
    const first = words[0];
    const last = words[words.length - 1];
    const startRaw = first.timestamp?.[0];
    const endRaw = last.timestamp?.[1] ?? last.timestamp?.[0];
    return {
        text,
        timestamp: [
            startRaw != null ? startRaw + offset : null,
            endRaw != null ? endRaw + offset : null,
        ],
        words: words.map(w => ({
            text: (w.text || '').trim(),
            start: w.timestamp?.[0] != null ? w.timestamp[0] + offset : null,
            end: (w.timestamp?.[1] ?? w.timestamp?.[0]) != null
                ? (w.timestamp[1] ?? w.timestamp[0]) + offset : null,
        })),
    };
}

function formatSegmentChunks(chunks, offset) {
    return chunks.map(c => ({
        text: (c.text || '').trim(),
        timestamp: [
            c.timestamp?.[0] != null ? c.timestamp[0] + offset : null,
            c.timestamp?.[1] != null ? c.timestamp[1] + offset : null,
        ],
    }));
}

async function transcribe(msg) {
    const pipe = await ensurePipeline(msg, (data) => self.postMessage(data));
    self.postMessage({ status: 'ready', backend: currentBackend, vendor: currentVendor });

    // Only preemptively disable word timestamps for no_attentions revision on WASM
    // (no cross-attention outputs). Other revisions on WASM can attempt word timestamps;
    // the retry logic below catches failures gracefully.
    if (currentBackend === 'wasm' && wordTimestampsSupported) {
        const modelName = resolveModelName(msg.model, msg.multilingual);
        const revision = modelName.includes('/whisper-medium') ? 'no_attentions' : 'main';
        if (revision === 'no_attentions') {
            console.log('[Whisper Worker] WASM + no_attentions revision — disabling word-level timestamps');
            wordTimestampsSupported = false;
        }
    }

    const timeOffset = msg.timeOffset || 0;
    const chunkId = msg.chunkId;

    let wordBuffer = [];
    let lastUpdateAt = 0;
    let detectedWordLevel = null;

    function chunk_callback(chunk) {
        wordBuffer.push(chunk);
        if (detectedWordLevel === null && wordBuffer.length >= 3) {
            detectedWordLevel = isWordLevelChunks(wordBuffer);
        }
        const now = Date.now();
        if (now - lastUpdateAt < 200) return;
        lastUpdateAt = now;
        sendBufferUpdate();
    }

    function sendBufferUpdate() {
        if (wordBuffer.length === 0) return;
        if (detectedWordLevel) {
            const segments = groupWordsToSegments(wordBuffer, timeOffset);
            const text = segments.map(s => s.text).join(' ');
            self.postMessage({ status: 'update', data: [text, { chunks: segments }], chunkId });
        } else {
            const text = wordBuffer.map(c => (c.text || '').trim()).join(' ');
            const chunks = formatSegmentChunks(wordBuffer, timeOffset);
            self.postMessage({ status: 'update', data: [text, { chunks }], chunkId });
        }
    }

    const pipeOpts = {
        top_k: 0,
        do_sample: false,
        temperature: 0,
        compression_ratio_threshold: 2.0,
        no_repeat_ngram_size: 3,
        chunk_length_s: msg.chunkLengthS,
        stride_length_s: msg.strideLengthS,
        language: msg.language,
        task: msg.subtask,
        return_timestamps: wordTimestampsSupported ? 'word' : true,
        force_full_sequences: false,
        chunk_callback,
    };

    let result = null;
    try {
        result = await pipe(msg.audio, pipeOpts);
    } catch (error) {
        const errMsg = error.message || String(error);
        const isGpuError = /createBuffer|RangeError|out of memory|OOM|allocation|device lost|GPUDevice|createComputePipeline|createShaderModule|mapAsync|Instance reference|AbortError/i.test(errMsg);

        if (isGpuError && currentBackend !== 'wasm' && msg.allowWasm) {
            console.warn('[Whisper Worker] GPU inference failed, falling back to WASM:', errMsg);
            skipWebgpu = true;
            if (pipelinePromise) {
                try { (await pipelinePromise).dispose?.(); } catch {}
            }
            pipelinePromise = null;
            currentModel = null;
            self.postMessage({ status: 'initiate', backend: 'wasm', vendor: '' });
            self.postMessage({ status: 'error', data: { message: errMsg, gpuFallback: true }, chunkId });
            return null;
        }

        // If word-level timestamps failed, retry with segment-level
        if (wordTimestampsSupported) {
            console.warn('[Whisper Worker] Word-level timestamps failed (' + errMsg + '), retrying with segment timestamps');
            wordTimestampsSupported = false;
            wordBuffer = [];
            lastUpdateAt = 0;
            detectedWordLevel = null;
            pipeOpts.return_timestamps = true;
            try {
                result = await pipe(msg.audio, pipeOpts);
            } catch (retryError) {
                const retryMsg = retryError.message || String(retryError);
                self.postMessage({ status: 'error', data: { message: retryMsg }, chunkId });
                return null;
            }
        } else {
            self.postMessage({ status: 'error', data: { message: errMsg }, chunkId });
            return null;
        }
    }

    if (!result) return null;

    // Final flush of any throttled updates
    sendBufferUpdate();

    // Detect word-level output and group into segments with word timestamps
    if (result.chunks && isWordLevelChunks(result.chunks)) {
        return {
            text: result.text,
            chunks: groupWordsToSegments(result.chunks, timeOffset),
        };
    }

    // Segment-level fallback: just add time offset
    if (result.chunks && timeOffset > 0) {
        for (const c of result.chunks) {
            if (c.timestamp) {
                if (c.timestamp[0] != null) c.timestamp[0] += timeOffset;
                if (c.timestamp[1] != null) c.timestamp[1] += timeOffset;
            }
        }
    }

    return result;
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

    if (msg.type === 'preferred-dtype') {
        preferredDtype = msg.dtype || '';
        console.log('[Whisper Worker] Preferred dtype:', preferredDtype);
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
