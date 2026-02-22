/**
 * WhisperWorkerLoader - WebGPU Whisper worker (Transformers.js)
 *
 * Runs whisper models in a Web Worker. Prefers WebGPU with fp16/fp32 encoder
 * + fp32 decoder, falls back to WASM. Dynamic import with CDN fallback for resilience.
 * Supports word-level timestamps and real-time streaming.
 */

function getWorkerCode(): string {
    return `
let gpuDeviceLost = false;
const GPU_ERROR_RE = /WebGPU Context Provider|context.*provider|device lost|GPUDevice|createComputePipeline|createShaderModule|createBuffer|mapAsync|mapping webgpu buffer|invalid buffer|Instance reference|AbortError|release session|invalid session/i;
const EXPLICIT_DEVICE_LOSS_RE = /device lost|Instance reference|release session|invalid session/i;
const RECOVERABLE_GPU_REJECTION_RE = /index out of bounds|table index is out of bounds|inference timed out|timed out/i;
const SUPPRESS_RECOVERABLE_REJECTIONS_WINDOW_MS = 120000;
let suppressRecoverableGpuRejectionsUntil = 0;

self.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message = reason && reason.message ? reason.message : String(reason || 'Unknown error');
    const looksNumericGpuCode = /^\\d+$/.test(message);
    if (Date.now() < suppressRecoverableGpuRejectionsUntil
        && (RECOVERABLE_GPU_REJECTION_RE.test(message) || looksNumericGpuCode)) {
        // After timeout/fallback, stale GPU promises can still reject in the background.
        // Suppress these so host state is not poisoned by late async failures.
        event.preventDefault();
        console.warn('[Whisper Worker] Suppressed late recoverable GPU rejection:', message);
        return;
    }
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
// GPU vendor hint from host (detected via WebGL on main thread).
// Firefox hides adapter.info for fingerprinting; this fills the gap.
let gpuVendorHint = '';

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
            let vendor = [info.vendor, info.description, info.architecture].filter(Boolean).join(' ').toLowerCase();
            // Firefox hides adapter.info — use WebGL-detected vendor from host as fallback
            if (!vendor && gpuVendorHint) {
                vendor = gpuVendorHint;
                console.log('[Whisper Worker] Using host GPU vendor hint:', vendor);
            }
            const maxBuf = adapter.limits?.maxBufferSize || 0;
            if (maxBuf > 0 && maxBuf < minWebgpuBufferBytes) {
                console.warn('[Whisper Worker] Rejected adapter (' + powerPreference + ') — maxBufferSize too small:', maxBuf);
                continue;
            }
            const score = scoreAdapter(vendor, maxBuf, powerPreference, preferredPower);
            const candidate = { adapter, vendor, maxBuf, powerPreference, score };
            candidates.push(candidate);

            // Respect requested power class deterministically.
            // If the preferred class yields a usable adapter, use it immediately.
            if (powerPreference === preferredPower) {
                const describe = (c) => (c.vendor || 'unknown') + ' [' + c.powerPreference + '] ' + Math.round(c.maxBuf / 1048576) + 'MB score=' + c.score;
                console.log('[Whisper Worker] WebGPU adapter candidates:', candidates.map(describe).join(' | '));
                console.log('[Whisper Worker] WebGPU adapter selected:', describe(candidate), '(preferred power)');
                return { device: 'webgpu', vendor: candidate.vendor, maxBuf: candidate.maxBuf };
            }
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

function getDtypeCandidates(device, vendor) {
    if (device !== 'webgpu') return null;
    // Per HuggingFace docs: encoder-decoder models like Whisper need per-module dtype.
    // Decoder constraints on WebGPU:
    //   fp16 decoder FAILS (Transformers.js #894)
    //   q8 decoder gibberish on WebGPU (Transformers.js #1317)
    //   q4 decoder produces empty output on Firefox WebGPU
    // → decoder MUST be fp32 on WebGPU. Encoder can try fp16 first for speed.

    const isIntelArc = /intel.*arc|\\barc\\b/i.test(vendor);
    const isIntel = /intel|xe|iris|uhd|gen-9|gen9/i.test(vendor);
    const isQualcomm = /qualcomm|adreno/i.test(vendor);

    // Firefox WebGPU remains fragile on Whisper decoder cache paths.
    // Keep dtype deterministic and conservative.
    if (IS_FIREFOX) {
        return [{ encoder_model: 'fp32', decoder_model_merged: 'fp32' }];
    }

    // Arc dGPU on Chromium: fp16 encoder is much faster; keep fp32 fallback for stability.
    if (isIntelArc) {
        return [
            { encoder_model: 'fp16', decoder_model_merged: 'fp32' },
            { encoder_model: 'fp32', decoder_model_merged: 'fp32' },
        ];
    }

    // Intel / Qualcomm: pin to fp32 for output stability.
    if (isIntel || isQualcomm) {
        return [{ encoder_model: 'fp32', decoder_model_merged: 'fp32' }];
    }

    // Others (Apple, NVIDIA, AMD on Chrome/Edge): fp16 encoder first
    return [
        { encoder_model: 'fp16', decoder_model_merged: 'fp32' },
        { encoder_model: 'fp32', decoder_model_merged: 'fp32' },
    ];
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

// Inference timeout — keep a small, deterministic model across browsers.
const IS_FIREFOX = typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent || '');
const INFERENCE_TIMEOUT_MS = 45_000;
const FAST_BOOTSTRAP_TIMEOUT_MS = 30_000;
const FIRST_GPU_INFERENCE_TIMEOUT_MS = IS_FIREFOX ? 45_000 : 90_000;
const ENABLE_SHADER_WARMUP = false;
const GPU_INFERENCE_ERROR_RE = /createBuffer|RangeError|out of memory|OOM|allocation|device lost|GPUDevice|createComputePipeline|createShaderModule|mapAsync|mapping webgpu buffer|invalid buffer|Instance reference|AbortError|release session|invalid session|index out of bounds|timed out/i;
function toErrorMessage(error) {
    return error && error.message ? error.message : String(error || 'Unknown error');
}

function postChunkError(chunkId, message, gpuFallback = false) {
    const data = gpuFallback ? { message, gpuFallback: true } : { message };
    self.postMessage({ status: 'error', data, chunkId });
}

function armRecoverableRejectionSuppression() {
    suppressRecoverableGpuRejectionsUntil = Date.now() + SUPPRESS_RECOVERABLE_REJECTIONS_WINDOW_MS;
}

function withInferenceTimeout(promise, ms) {
    let timer;
    let timedOut = false;
    const guarded = Promise.resolve(promise).catch((error) => {
        const message = toErrorMessage(error);
        if (timedOut && GPU_INFERENCE_ERROR_RE.test(message)) {
            // The timeout branch already recovered (usually to WASM). Ignore late
            // WebGPU rejections from the stale in-flight inference.
            console.warn('[Whisper Worker] Ignoring late WebGPU rejection after timeout:', message);
            return null;
        }
        throw error;
    });
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            timedOut = true;
            armRecoverableRejectionSuppression();
            reject(new Error('WebGPU inference timed out after ' + (ms / 1000) + 's'));
        }, ms);
    });
    return Promise.race([guarded, timeout]).finally(() => clearTimeout(timer));
}

function getInferenceTimeoutMs(currentBackend, chunkLengthS) {
    if (currentBackend !== 'webgpu') return INFERENCE_TIMEOUT_MS;
    // First GPU inference may include residual shader compilation if warmup
    // was skipped or only partially compiled shaders. Give it much more time.
    if (!gpuShadersCompiled) return FIRST_GPU_INFERENCE_TIMEOUT_MS;
    let timeoutMs = INFERENCE_TIMEOUT_MS;
    if (Number(chunkLengthS) <= 8) {
        timeoutMs = Math.min(timeoutMs, FAST_BOOTSTRAP_TIMEOUT_MS);
    }
    return timeoutMs;
}

// ------------------------------------------------------------
// Pipeline management
// ------------------------------------------------------------

let pipelinePromise = null;
let currentModel = null;
let currentMultilingual = null;
let gpuShadersCompiled = false;
let loadingModel = null;
let loadingMultilingual = null;

async function ensurePipeline(settings, progressCb) {
    await loadTransformers();

    const modelName = resolveModelName(settings.model, settings.multilingual);
    const sameLoaded = currentModel === modelName && currentMultilingual === settings.multilingual;
    const sameLoading = !currentModel
        && loadingModel === modelName
        && loadingMultilingual === settings.multilingual;

    // Reuse in-flight load for same model/settings instead of disposing/recreating.
    if (pipelinePromise && (sameLoaded || sameLoading)) {
        return pipelinePromise;
    }

    // Dispose previous pipeline only when switching to different settings.
    if (pipelinePromise) {
        try { await (await pipelinePromise).dispose?.(); } catch {}
        pipelinePromise = null;
        currentModel = null;
        currentMultilingual = null;
        loadingModel = null;
        loadingMultilingual = null;
    }

    const backend = await detectBackend();
    currentBackend = backend.device;
    currentVendor = backend.vendor || '';

    self.postMessage({ status: 'initiate', backend: currentBackend, vendor: currentVendor });

    const revision = 'main';

    // --- WebGPU path: try dtype candidates ---
    if (currentBackend === 'webgpu') {
        const dtypeCandidates = getDtypeCandidates(currentBackend, currentVendor);
        if (dtypeCandidates) {
            for (const dtype of dtypeCandidates) {
                if (skipWebgpu) break; // Context error detected — abort remaining dtypes
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
                    loadingModel = modelName;
                    loadingMultilingual = settings.multilingual;
                    pipelinePromise = pipeline('automatic-speech-recognition', modelName, opts);
                    try {
                        await pipelinePromise;
                        currentModel = modelName;
                        currentMultilingual = settings.multilingual;
                        currentDtype = JSON.stringify(dtype);
                        console.log('[Whisper Worker] Model loaded on webgpu [' + currentDtype + ']:', modelName);

                        // Keep startup simple and let first real inference compile shaders lazily.
                        if (!gpuShadersCompiled && !ENABLE_SHADER_WARMUP) {
                            console.log('[Whisper Worker] Warmup disabled; first inference may include shader compilation');
                        }

                        return pipelinePromise;
                    } catch (err) {
                        pipelinePromise = null;
                        loadingModel = null;
                        loadingMultilingual = null;
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

        loadingModel = modelName;
        loadingMultilingual = settings.multilingual;
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
            loadingModel = null;
            loadingMultilingual = null;
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
    // Root-cause fix:
    // Word timestamps on WebGPU are the unstable path causing hangs/timeouts/index errors.
    // Keep WebGPU on segment timestamps for both Chrome and Firefox.
    // WASM can still use word timestamps.
    const useWordTimestamps = currentBackend !== 'webgpu';

    let wordBuffer = [];
    let lastUpdateAt = 0;
    let detectedWordLevel = useWordTimestamps ? null : false;

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
        return_timestamps: useWordTimestamps ? 'word' : true,
        chunk_callback,
    };

    const resetStreamState = (wordLevel) => {
        wordBuffer = [];
        lastUpdateAt = 0;
        detectedWordLevel = wordLevel ? null : false;
    };

    const runInference = async (targetPipe, opts, backendName, timeoutOverrideMs) => {
        const useTimeout = backendName === 'webgpu';
        const timeoutMs = timeoutOverrideMs ?? getInferenceTimeoutMs(backendName, msg.chunkLengthS);
        console.log('[Whisper Worker] Starting inference on ' + backendName + (useTimeout ? ' (timeout=' + timeoutMs / 1000 + 's)' : ''));
        return useTimeout
            ? withInferenceTimeout(targetPipe(msg.audio, opts), timeoutMs)
            : targetPipe(msg.audio, opts);
    };

    const fallbackToWasmAndRetry = async (reasonMsg) => {
        if (currentBackend === 'wasm') throw new Error(reasonMsg);

        console.warn('[Whisper Worker] GPU inference failed, falling back to WASM:', reasonMsg);
        armRecoverableRejectionSuppression();
        // Keep this worker on WASM after a GPU inference failure. This avoids
        // webgpu<->wasm thrash loops and stale timeout rejections poisoning the queue.
        skipWebgpu = true;
        if (pipelinePromise) {
            try { await (await pipelinePromise).dispose?.(); } catch {}
        }
        pipelinePromise = null;
        currentModel = null;
        currentMultilingual = null;
        loadingModel = null;
        loadingMultilingual = null;

        self.postMessage({ status: 'initiate', backend: 'wasm', vendor: '' });
        const wasmPipe = await ensurePipeline(msg, (data) => self.postMessage(data));
        self.postMessage({ status: 'ready', backend: currentBackend, vendor: currentVendor });

        resetStreamState(false);
        const fallbackOpts = { ...pipeOpts, return_timestamps: true };
        const fallbackResult = await runInference(wasmPipe, fallbackOpts, 'wasm');
        self.postMessage({ status: 'gpu-degraded', data: { message: reasonMsg } });
        return fallbackResult;
    };

    let result = null;
    try {
        result = await runInference(pipe, pipeOpts, currentBackend);
        if (currentBackend === 'webgpu') gpuShadersCompiled = true;
    } catch (initialError) {
        const initialMsg = toErrorMessage(initialError);
        const canRetryWithoutWords = pipeOpts.return_timestamps === 'word';

        if (canRetryWithoutWords) {
            console.warn('[Whisper Worker] Word-level timestamps failed (' + initialMsg + '), retrying with segment timestamps');
            resetStreamState(false);
            pipeOpts.return_timestamps = true;
            try {
                const retryTimeoutMs = Math.max(getInferenceTimeoutMs(currentBackend, msg.chunkLengthS), FAST_BOOTSTRAP_TIMEOUT_MS);
                result = await runInference(pipe, pipeOpts, currentBackend, retryTimeoutMs);
            } catch (retryError) {
                const retryMsg = toErrorMessage(retryError);
                if (currentBackend !== 'wasm' && GPU_INFERENCE_ERROR_RE.test(retryMsg)) {
                    try {
                        result = await fallbackToWasmAndRetry(retryMsg);
                    } catch (fallbackError) {
                        postChunkError(chunkId, toErrorMessage(fallbackError), true);
                        return null;
                    }
                } else {
                    postChunkError(chunkId, retryMsg);
                    return null;
                }
            }
        } else if (currentBackend !== 'wasm' && GPU_INFERENCE_ERROR_RE.test(initialMsg)) {
            try {
                result = await fallbackToWasmAndRetry(initialMsg);
            } catch (fallbackError) {
                postChunkError(chunkId, toErrorMessage(fallbackError), true);
                return null;
            }
        } else {
            postChunkError(chunkId, initialMsg);
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
        loadingModel = null;
        loadingMultilingual = null;
        gpuShadersCompiled = false;
        return;
    }

    if (msg.type === 'init') {
        const requestedMinBuffer = Number(msg.minWebgpuBufferBytes);
        minWebgpuBufferBytes = Number.isFinite(requestedMinBuffer) && requestedMinBuffer > 0
            ? Math.floor(requestedMinBuffer)
            : 268435456;
        preferLowPowerAdapter = msg.preferLowPowerAdapter === true;
        if (msg.gpuVendorHint) gpuVendorHint = String(msg.gpuVendorHint).toLowerCase();
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

// Test-only helper: exposes generated worker code for unit assertions.
export function __getWhisperWorkerCodeForTests(): string {
    return getWorkerCode();
}
