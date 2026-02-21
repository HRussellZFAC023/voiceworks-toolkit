/**
 * WhisperWorkerLoader - WebGPU Whisper worker (Transformers.js)
 *
 * Runs whisper models in a Web Worker. Prefers WebGPU with fp32+q4 dtype,
 * falls back to WASM. Dynamic import with CDN fallback for resilience.
 * Supports word-level timestamps and real-time streaming.
 */

function getWorkerCode(): string {
    return `
let gpuDeviceLost = false;
const GPU_ERROR_RE = /WebGPU Context Provider|context.*provider|device lost|GPUDevice|createComputePipeline|createShaderModule|createBuffer|mapAsync|mapping webgpu buffer|invalid buffer|Instance reference|AbortError|release session|invalid session/i;
const EXPLICIT_DEVICE_LOSS_RE = /device lost|Instance reference|release session|invalid session/i;

self.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message = reason && reason.message ? reason.message : String(reason || 'Unknown error');
    if (GPU_ERROR_RE.test(message)) {
        event.preventDefault();
        // Fatal GPU device loss — notify host so it can show crash UI
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
let preferLowPowerAdapter = false;
let minWebgpuBufferBytes = 268435456;

function scoreAdapter(vendor, maxBuf, powerPreference, preferredPower) {
    const v = (vendor || '').toLowerCase();
    let vendorScore = 0;
    if (/(amd|radeon|rdna|nvidia|geforce|rtx|gtx)/i.test(v)) vendorScore = 3;
    else if (/(intel|iris|uhd|xe|gen-9|gen9)/i.test(v)) vendorScore = -2;
    else if (/(qualcomm|adreno|mali|powervr)/i.test(v)) vendorScore = -1;
    else if (/(apple|m[1-9]|metal)/i.test(v)) vendorScore = 1;

    const powerScore = powerPreference === preferredPower ? 2 : 0;
    const bufferScore = maxBuf >= 1073741824 ? 2 : (maxBuf >= 536870912 ? 1 : 0);
    return vendorScore * 3 + powerScore + bufferScore;
}

function sortAdaptersByScore(a, b) {
    if (b.score !== a.score) return b.score - a.score;
    if (b.maxBuf !== a.maxBuf) return b.maxBuf - a.maxBuf;
    if (a.powerPreference === b.powerPreference) return 0;
    if (a.powerPreference === 'high-performance') return -1;
    if (b.powerPreference === 'high-performance') return 1;
    return 0;
}

async function detectWebGPU() {
    if (typeof navigator === 'undefined' || !('gpu' in navigator)) return null;
    try {
        // Direct requestAdapter — no withTimeout wrapper.
        // ae78075 pattern: let the browser take as long as it needs.
        const preferredPower = preferLowPowerAdapter ? 'low-power' : 'high-performance';
        const preferences = preferLowPowerAdapter
            ? ['low-power', 'high-performance']
            : ['high-performance', 'low-power'];
        const candidates = [];
        for (const powerPreference of preferences) {
            let adapter = null;
            try {
                adapter = await navigator.gpu.requestAdapter({ powerPreference });
            } catch (err) {
                console.warn('[Whisper Worker] requestAdapter failed for', powerPreference, err);
                continue;
            }
            if (!adapter) continue;
            const info = adapter.info || {};
            const vendor = [info.vendor, info.description, info.architecture].filter(Boolean).join(' ').toLowerCase();
            const maxBuf = adapter.limits?.maxBufferSize || 0;
            if (maxBuf > 0 && maxBuf < minWebgpuBufferBytes) {
                console.warn('[Whisper Worker] Rejected adapter (' + powerPreference + ') — maxBufferSize too small:', maxBuf);
                continue;
            }
            const score = scoreAdapter(vendor, maxBuf, powerPreference, preferredPower);
            candidates.push({ adapter, vendor, maxBuf, powerPreference, score });
        }
        if (!candidates.length) {
            console.warn('[Whisper Worker] No usable WebGPU adapter found');
            return null;
        }
        candidates.sort(sortAdaptersByScore);
        const chosen = candidates[0];
        const describe = (c) => (c.vendor || 'unknown') + ' [' + c.powerPreference + '] ' + Math.round(c.maxBuf / 1048576) + 'MB score=' + c.score;
        console.log('[Whisper Worker] WebGPU adapter candidates:', candidates.map(describe).join(' | '));
        console.log('[Whisper Worker] WebGPU adapter selected:', describe(chosen));
        return { device: 'webgpu', vendor: chosen.vendor, maxBuf: chosen.maxBuf };
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
    if (multilingual) return model;
    // Insert .en before _timestamped suffix if present
    if (model.endsWith('_timestamped')) {
        return model.slice(0, -'_timestamped'.length) + '.en_timestamped';
    }
    return model + '.en';
}

async function releaseGpuResources() {
    // Multiple yields to event loop so browser GC can reclaim orphaned GPU buffers
    await new Promise(r => setTimeout(r, 250));
    await new Promise(r => setTimeout(r, 250));
}

// ------------------------------------------------------------
// Pipeline management
// ------------------------------------------------------------

let pipelinePromise = null;
let currentModel = null;
let currentMultilingual = null;

async function ensurePipeline(settings, progressCb) {
    await loadTransformers();

    const modelName = resolveModelName(settings.model, settings.multilingual);

    if (pipelinePromise && currentModel === modelName && currentMultilingual === settings.multilingual) {
        return pipelinePromise;
    }

    // Dispose previous pipeline if needed
    if (pipelinePromise) {
        try { await (await pipelinePromise).dispose?.(); } catch {}
        pipelinePromise = null;
    }

    const backend = await detectBackend();
    currentBackend = backend.device;
    currentVendor = backend.vendor || '';

    self.postMessage({ status: 'initiate', backend: currentBackend, vendor: currentVendor });

    const revision = 'main';

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
                        currentMultilingual = settings.multilingual;
                        currentDtype = JSON.stringify(dtype);
                        console.log('[Whisper Worker] Model loaded on webgpu [' + currentDtype + ']:', modelName);
                        return pipelinePromise;
                    } catch (err) {
                        pipelinePromise = null;
                        const msg = String(err?.message || err || '');
                        const isMemErr = /allocation|out of memory|OOM|RangeError|createbuffer/i.test(msg);
                        const isContextErr = /WebGPU Context Provider|context.*provider|device lost|GPUDevice|createComputePipeline|createShaderModule|mapping webgpu buffer|invalid buffer/i.test(msg);
                        const isTimeout = /timed out/i.test(msg);
                        const isGpuErr = isMemErr || isContextErr || isTimeout;

                        console.warn('[Whisper Worker] WebGPU load error:', JSON.stringify(dtype), msg);

                        if (isContextErr) {
                            // Context provider / device lost: skip WebGPU entirely
                            await releaseGpuResources();
                            skipWebgpu = true;
                            break;
                        }
                        if (isGpuErr) {
                            await releaseGpuResources();
                            break; // try next dtype
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
    const wasmOpts = {
        progress_callback: progressCb,
        revision,
        device: 'wasm',
        dtype: 'q8',
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
            currentMultilingual = settings.multilingual;
            currentDtype = 'q8';
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

// Hallucination detection for Whisper on ASMR/ambient audio.
// Transformers.js doesn't expose per-segment no_speech_prob or avg_logprob,
// and no_speech_threshold may not apply to chunked input (huggingface/transformers#29595).
// So we use pattern matching as a practical fallback.

// 1. Bracketed non-speech annotations (e.g. [laughter], (music))
const HALLUCINATION_RE = /^\\s*[\\[\\(](laughter|laughing|crying|music|applause|cheering|singing|sighing|coughing|clapping|crowd noise|background noise|inaudible|silence|blank audio|no speech|\u305F\u3081\u606F|\u7B11\u3044|\u6CE3\u304D|\u62CD\u624B|\u97F3\u697D)[\\]\\)]\\s*$/i;

// 2. Common YouTube/subtitle hallucinations from Whisper's training data
const SUBTITLE_HALLUCINATION_RE = /^\\s*(thank you(\\s+for\\s+watching)?|thanks for watching|please subscribe|like and subscribe|see you next time|\\u3054\\u8996\\u8074\\u3042\\u308A\\u304C\\u3068\\u3046\\u3054\\u3056\\u3044\\u307E\\u3059|\\u30C1\\u30E3\\u30F3\\u30CD\\u30EB\\u767B\\u9332)\\s*[\\.!]*\\s*$/i;

function cleanHallucinatedChunks(chunks) {
    if (!chunks) return chunks;
    return chunks.filter(c => {
        const text = (c.text || '').trim();
        if (!text) return false;
        if (HALLUCINATION_RE.test(text)) {
            console.log('[Whisper Worker] Filtered hallucinated chunk (non-speech):', text);
            return false;
        }
        if (SUBTITLE_HALLUCINATION_RE.test(text)) {
            console.log('[Whisper Worker] Filtered hallucinated chunk (subtitle):', text);
            return false;
        }
        return true;
    });
}

// Silence threshold for splitting words into separate subtitle segments.
// 0.5s was too aggressive (splits mid-sentence on breath pauses).
// 1.5s was too lenient (merges separate sentences into mega-segments).
// 1.0s balances ASMR breath pauses vs genuine inter-sentence gaps.
const SEGMENT_GAP_S = 1.0;

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

    const timeOffset = msg.timeOffset || 0;
    const chunkId = msg.chunkId;
    const requestedUpdateInterval = Number(msg.updateIntervalMs);
    const updateIntervalMs = Number.isFinite(requestedUpdateInterval)
        ? Math.max(100, Math.min(1000, Math.floor(requestedUpdateInterval)))
        : 200;

    let wordBuffer = [];
    let lastUpdateAt = 0;
    let detectedWordLevel = null;

    function chunk_callback(chunk) {
        wordBuffer.push(chunk);
        if (detectedWordLevel === null && wordBuffer.length >= 3) {
            detectedWordLevel = isWordLevelChunks(wordBuffer);
        }
        const now = Date.now();
        if (now - lastUpdateAt < updateIntervalMs) return;
        lastUpdateAt = now;
        sendBufferUpdate();
    }

    function sendBufferUpdate() {
        if (wordBuffer.length === 0) return;
        const cleaned = cleanHallucinatedChunks(wordBuffer);
        if (cleaned.length === 0) return;
        if (detectedWordLevel) {
            const segments = groupWordsToSegments(cleaned, timeOffset);
            const text = segments.map(s => s.text).join(' ');
            self.postMessage({ status: 'update', data: [text, { chunks: segments }], chunkId });
        } else {
            const text = cleaned.map(c => (c.text || '').trim()).join(' ');
            const chunks = formatSegmentChunks(cleaned, timeOffset);
            self.postMessage({ status: 'update', data: [text, { chunks }], chunkId });
        }
    }

    // Transformers.js only supports a subset of Whisper generation params.
    // Unsupported (silently dropped): no_speech_threshold, logprob_threshold,
    // condition_on_prev_tokens, compression_ratio_threshold, top_k, force_full_sequences.
    // Hallucination suppression relies on cleanHallucinatedChunks() post-processing.
    const pipeOpts = {
        do_sample: false,
        chunk_length_s: msg.chunkLengthS,
        stride_length_s: msg.strideLengthS,
        language: msg.language,
        task: msg.subtask,
        // Always try word-level timestamps first. If the run fails, we retry
        // that run with segment timestamps only.
        return_timestamps: 'word',
        chunk_callback,
    };

    let result = null;
    try {
        result = await pipe(msg.audio, pipeOpts);
    } catch (error) {
        const errMsg = error.message || String(error);
        const isGpuError = /createBuffer|RangeError|out of memory|OOM|allocation|device lost|GPUDevice|createComputePipeline|createShaderModule|mapAsync|mapping webgpu buffer|invalid buffer|Instance reference|AbortError|release session|invalid session/i.test(errMsg);

        if (isGpuError && currentBackend !== 'wasm') {
            console.warn('[Whisper Worker] GPU inference failed, falling back to WASM:', errMsg);
            skipWebgpu = true;
            if (pipelinePromise) {
                try { await (await pipelinePromise).dispose?.(); } catch {}
            }
            pipelinePromise = null;
            currentModel = null;
            self.postMessage({ status: 'initiate', backend: 'wasm', vendor: '' });
            self.postMessage({ status: 'error', data: { message: errMsg, gpuFallback: true }, chunkId });
            return null;
        }

        // If word-level timestamps failed, retry with segment-level for this run.
        if (pipeOpts.return_timestamps === 'word') {
            console.warn('[Whisper Worker] Word-level timestamps failed (' + errMsg + '), retrying with segment timestamps');
            wordBuffer = [];
            lastUpdateAt = 0;
            detectedWordLevel = null;
            pipeOpts.return_timestamps = true;
            try {
                result = await pipe(msg.audio, pipeOpts);
                // Retry succeeded, but if original failure was GPU-related (e.g. createBuffer),
                // report degradation so host can warn other workers (Embedding, Translation)
                // to switch to WASM before they hit the same dead device.
                if (isGpuError && !gpuDeviceLost) {
                    console.warn('[Whisper Worker] GPU degraded — createBuffer failed during word timestamps');
                    self.postMessage({ status: 'gpu-degraded', data: { message: errMsg } });
                }
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

    // Filter hallucinated non-speech chunks before processing
    if (result.chunks) {
        result.chunks = cleanHallucinatedChunks(result.chunks);
    }

    // Detect word-level output and group into segments with word timestamps
    if (result.chunks && isWordLevelChunks(result.chunks)) {
        const segments = groupWordsToSegments(result.chunks, timeOffset);
        return {
            text: segments.map(s => s.text).join(' '),
            chunks: segments,
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

    // Update text to match filtered chunks
    if (result.chunks) {
        result.text = result.chunks.map(c => (c.text || '').trim()).join(' ');
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

    if (msg.type === 'flush-queue') {
        const flushed = jobQueue.length;
        jobQueue = [];
        if (flushed > 0) console.log('[Whisper Worker] Flushed ' + flushed + ' queued jobs');
        return;
    }

    if (msg.type === 'reset') {
        if (pipelinePromise) {
            try { await (await pipelinePromise).dispose?.(); } catch {}
            pipelinePromise = null;
        }
        currentModel = null;
        currentMultilingual = null;
        return;
    }

    if (msg.type === 'init') {
        const requestedMinBuffer = Number(msg.minWebgpuBufferBytes);
        minWebgpuBufferBytes = Number.isFinite(requestedMinBuffer) && requestedMinBuffer > 0
            ? Math.floor(requestedMinBuffer)
            : 268435456;
        preferLowPowerAdapter = msg.preferLowPowerAdapter === true;
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
