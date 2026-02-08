import { GM_listValues, GM_deleteValue } from '$';
import { CacheKeys, SharedCache, hashString } from '../core/Cache';
import { GpuScheduler, Priority } from '../core/GpuScheduler';
import { gmRequest, retryWithBackoff, HttpError } from '../infrastructure/HttpClient';
import { I18n, Config } from '../core/Config';
import { Logger } from '../core/Utils';
import { EventBus } from '../core/EventBus';
import { createTranslationWorker } from '../features/TranslationWorkerLoader';
import { DeviceCapabilities } from '../core/DeviceCapabilities';
import {
    glossaryMap,
    alwaysRegex, alwaysReplacerMap,
    preferRegex, preferReplacerMap,
} from '../data/nsfw-glossary';

type TranslationSource = 'local' | 'remote';

// ============================================================================
// Constants
// ============================================================================

const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const PREFETCH_MAX_LINES = 1000;

// Timeouts: greedy decoding is 3-4x faster than beam search
// WASM gets longer timeouts (model compile + no GPU acceleration)
const SINGLE_TIMEOUT_MS = 15_000;
const SINGLE_TIMEOUT_WASM_MS = 20_000;
const BATCH_TIMEOUT_BASE_MS = 15_000;
const BATCH_TIMEOUT_BASE_WASM_MS = 30_000;
const BATCH_TIMEOUT_PER_ITEM_MS = 50;
const BATCH_TIMEOUT_PER_ITEM_WASM_MS = 150;

// Larger chunks = fewer round-trips, better GPU utilization.
// WASM stays small to keep per-chunk inference short so live singles can interleave.
const BATCH_CHUNK_SIZE_GPU = 64;
const BATCH_CHUNK_SIZE_WASM = 16;
// When Whisper is actively transcribing, reduce GPU batch size to avoid GPU contention
const BATCH_CHUNK_SIZE_GPU_THROTTLED = 8;

// Remote (Google Translate) settings
const REMOTE_CONCURRENCY = 12;
const REMOTE_MIN_INTERVAL_MS = 50;
const REMOTE_RATE_LIMIT_PAUSE_MS = 60_000;

// Single-pass quote/fullwidth normalization — compiled once at module scope
const _quoteMap: Record<string, string> = {
    '``': '"', "''": '"',
    '\u00AB': '"', '\u00BB': '"', '\u201E': '"', '\u201C': '"', '\u201D': '"',
    '\u301D': '"', '\u301E': '"', '\u301F': '"', '\u2033': '"',
    '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u2039': "'", '\u203A': "'", '\u2032': "'",
    '\uFF08': '(', '\uFF09': ')',
    '\u3010': '[', '\u3011': ']',
    '\u300C': '"', '\u300D': '"',  // 「」 Japanese single quotes
    '\u300E': '"', '\u300F': '"',  // 『』 Japanese double quotes
    '\uFF01': '!', '\uFF1F': '?',
    '\uFF1A': ':', '\uFF1B': ';', '\uFF0C': ',',
};
const _quoteRegex = new RegExp(
    Object.keys(_quoteMap).map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
    'g',
);

/**
 * Normalize input text before sending to the local opus-mt model.
 * Only strips characters PROVEN to cause hallucinations or truncation.
 * Preserves decorative characters (♡♪★ etc.) — they pass through the model harmlessly.
 * Does NOT apply to remote (Google Translate) which handles these natively.
 */
const _modelNormQuoteOpen = /[「『]/g;
const _modelNormQuoteClose = /[」』]/g;
const _modelNormBrackets = /【[^】]*】/g;
const _modelNormWaveDash = /[〜～]/g;
const _modelNormEllipsis = /…/g;
const _modelNormMultiply = /[×✕✖・]/g;
const _modelNormDecorative = /[♡♥♪♫★☆✨💕🌙❤️✿❀⭐🎵🎶💖💗💓💘🔥💜💙💛🤍🖤🩷🩵]/g;
const _modelNormSpaces = /\s{2,}/g;
function normalizeForModel(text: string): string {
    return text
        .replace(_modelNormQuoteOpen, '"')      // 「『 → " (prevents model stopping at quote boundary)
        .replace(_modelNormQuoteClose, '"')     // 」』 → "
        .replace(_modelNormBrackets, ' ')       // 【...】 → strip (metadata confuses model, causes hallucinations)
        .replace(_modelNormWaveDash, '')        // 〜～ → strip (causes hallucinations like "hospital")
        .replace(_modelNormEllipsis, '...')     // … → ... (better tokenization)
        .replace(_modelNormMultiply, ', ')      // × → ", " (DLsite tag separator: 純愛×催眠 → 純愛, 催眠)
        .replace(_modelNormDecorative, '')      // ♡♪★✨💕 → strip for model input (display still shows originals)
        .replace(_modelNormSpaces, ' ')
        .trim();
}

// Opus-MT models: ja→en (~105MB fp16) and zh→en (~110MB fp16).
// Both fit comfortably within the 2048 MB WebGPU buffer limit.
const OPUS_JA_EN = 'Xenova/opus-mt-ja-en';
const OPUS_ZH_EN = 'Xenova/opus-mt-zh-en';

interface ModelRoute {
    model: string;
    // MarianMT models have a fixed source→target direction; no language codes needed
}

// ============================================================================
// Language Detection
// ============================================================================

function detectSourceLanguage(text: string): 'ja' | 'zh' | 'en' {
    const hasKana = /[\u3040-\u309f\u30a0-\u30ff]/.test(text);
    const hasCJK = /[\u4e00-\u9fff]/.test(text);
    if (hasKana) return 'ja';
    if (hasCJK) return 'zh';
    if (/[a-zA-Z]/.test(text)) return 'en';
    return 'ja'; // default
}

function normalizeTargetLang(lang: string): string {
    const base = lang.toLowerCase().split('-')[0];
    if (base === 'jp') return 'ja';
    if (base === 'cn') return 'zh';
    return base;
}

function getModelForText(text: string, targetLang: string): ModelRoute | null {
    const src = detectSourceLanguage(text);
    const tgt = normalizeTargetLang(targetLang);
    if (src === tgt) return null; // same language, skip
    if (tgt !== 'en') return null; // opus-mt only does →EN; remote handles other directions

    if (src === 'ja') return { model: OPUS_JA_EN };
    if (src === 'zh') return { model: OPUS_ZH_EN };
    return null; // EN text or unsupported direction — remote handles it
}

// ============================================================================
// Quality Checks
// ============================================================================

/**
 * Hallucination pattern: opus-mt produces stock first-person conversational phrases
 * ("I'm sorry...", "I don't know...") when it can't decode the input.
 * DLsite titles/tags are noun phrases — first-person output without first-person input is a red flag.
 */
const _hallucinationFirstPerson = /^I['\u2019]?m\s|^I\s(don|can|won|didn|couldn|wouldn|shouldn)['\u2019]t\s|^I\s(have|want|need|think|know|like)\s/i;
const _firstPersonJa = /私|僕|俺|わたし|ぼく|おれ|あたし/;

function isLikelyGarbage(input: string, output: string): boolean {
    if (!output?.trim()) return true;
    if (output.length > input.length * 5 && output.length > 100) return true;
    if (/([!?.]{4,})/.test(output)) return true;
    const words = output.toLowerCase().split(/\s+/);
    let repeat = 1;
    for (let i = 1; i < words.length; i++) {
        if (words[i] === words[i - 1] && words[i].length > 1) {
            if (++repeat >= 4) return true;
        } else {
            repeat = 1;
        }
    }
    // Hallucination: first-person English from non-first-person Japanese input
    if (!_firstPersonJa.test(input) && _hallucinationFirstPerson.test(output.trim())) {
        return true;
    }
    return false;
}

// ============================================================================
// Glossary
// ============================================================================

/** Short-text threshold: below this, apply 'prefer' entries too */
const GLOSSARY_SHORT_THRESHOLD = 30;

/**
 * Apply glossary to a single text. Returns the glossary translation if the
 * entire text is an exact match, or performs substring substitution for
 * onomatopoeia / NSFW terms the model would otherwise get wrong.
 *
 * Returns null if glossary doesn't apply (let the model handle it).
 */
function applyGlossary(text: string, targetLang: string): string | null {
    const tgt = normalizeTargetLang(targetLang);
    if (tgt !== 'en' && tgt !== 'zh') return null;
    const field = tgt === 'en' ? 'en' : 'zh';

    const trimmed = text.trim();
    if (!trimmed) return null;

    // 1. Exact full-text match (all modes)
    const exact = glossaryMap.get(trimmed);
    if (exact) return exact[field];

    // 2. Single-pass regex replacement (compiled at import time)
    //    - Short text: use prefer + always entries (more aggressive)
    //    - Long text: only always entries (onomatopoeia — MT never gets these right)
    const regex = trimmed.length <= GLOSSARY_SHORT_THRESHOLD ? preferRegex : alwaysRegex;
    const map = trimmed.length <= GLOSSARY_SHORT_THRESHOLD ? preferReplacerMap : alwaysReplacerMap;
    const lookup = map[field];

    // Reset regex lastIndex (global regexes are stateful)
    regex.lastIndex = 0;
    let anyReplaced = false;
    const modified = trimmed.replace(regex, (match) => {
        anyReplaced = true;
        return lookup.get(match) || match;
    });

    if (!anyReplaced) return null;

    // If ALL content was replaced (no remaining CJK), return as-is
    const hasRemainingCJK = /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]/.test(modified);
    if (!hasRemainingCJK) return modified;

    // Mixed content: return the partially-substituted text for the model to finish.
    // We return null here and let the model translate the original —
    // but we DO want to guide the model, so we substitute and send to the model.
    return null;
}

/**
 * Pre-process text for model translation: replace glossary terms with
 * target-language equivalents so the model translates around them.
 * Returns [modifiedText, wasModified].
 */
function glossaryPreProcess(text: string, targetLang: string): [string, boolean] {
    const tgt = normalizeTargetLang(targetLang);
    if (tgt !== 'en' && tgt !== 'zh') return [text, false];
    const field = tgt === 'en' ? 'en' : 'zh';

    const regex = text.length <= GLOSSARY_SHORT_THRESHOLD ? preferRegex : alwaysRegex;
    const map = text.length <= GLOSSARY_SHORT_THRESHOLD ? preferReplacerMap : alwaysReplacerMap;
    const lookup = map[field];

    regex.lastIndex = 0;
    let anyReplaced = false;
    const modified = text.replace(regex, (match) => {
        anyReplaced = true;
        return lookup.get(match) || match;
    });

    return [modified, anyReplaced];
}

// ============================================================================
// Bracket Preprocessing
// ============================================================================

/**
 * Split multi-sentence text on 。 boundaries for opus-mt translation.
 * MarianMT treats 。 as end-of-sequence and drops subsequent sentences.
 * 【】 brackets are stripped by normalizeForModel() before reaching the model.
 * Returns null if text has only one sentence (no split needed).
 */
function splitForModel(text: string): string[] | null {
    const sentences = text.split(/。/).filter(s => s.trim());
    return sentences.length > 1 ? sentences : null;
}

// ============================================================================
// Cache
// ============================================================================

// lang parameter must already be normalized via normalizeTargetLang()
const cacheKey = (text: string, lang: string, source: TranslationSource): string =>
    CacheKeys.translation(text, lang, source);

function getCached(text: string, lang: string): string | null {
    const h = hashString(text);
    return SharedCache.get<string>(`asmr-ult:trans:local:${lang}:${h}`)
        || SharedCache.get<string>(`asmr-ult:trans:remote:${lang}:${h}`)
        || null;
}

// ============================================================================
// Worker Pool (opus-mt models)
// ============================================================================

interface PendingRequest {
    resolve: (val: any) => void;
    reject: (err: any) => void;
    timer: ReturnType<typeof setTimeout>;
}

interface WorkerEntry {
    worker: Worker;
    ready: boolean;
    pending: Map<number, PendingRequest>;
    model: string;
    backend?: string;
}

let workers: WorkerEntry[] = [];
let initPromises = new Map<string, Promise<void>>();
let nextId = 0;
let webgpuFailed = false;
// dtype that worked last time — sent to new workers to skip failed candidates (persisted across sessions)
let rememberedDtype = SharedCache.get<string>(CacheKeys.translationPreferredDtype()) || '';

// No cross-service webgpu:failed propagation — each service independently tries WebGPU
// with its own dtype cascade (fp32 on Intel, etc.). Serialized warmup in main.ts prevents
// device contention. Cross-service propagation was too aggressive: one service's fp16
// failure would permanently lock all services into WASM for the entire session.

// GPU contention: throttle translation batches while Whisper is actively transcribing
let whisperActive = false;
EventBus.on('whisper:transcribing', ({ active }) => {
    whisperActive = active;
});

// Cross-service device loss: when any worker reports GPU device lost, tell all
// translation workers to skip WebGPU. A GPU process crash affects ALL workers.
EventBus.on('gpu:device-lost-broadcast', ({ source }) => {
    if (source === 'translation') return; // Already handled by our own error path
    if (webgpuFailed) return; // Already on WASM
    Logger.warn(`[TranslationService] GPU device lost in ${source} worker — switching to WASM`);
    webgpuFailed = true;
    for (const w of workers) {
        w.worker.postMessage({ type: 'skip-webgpu' });
    }
});

// In-flight dedup: prevent duplicate translate() calls for the same text+lang
const translateInFlight = new Map<string, Promise<string>>();

// Adaptive batch chunk size: converges based on observed throughput (0 = use static defaults)
let adaptiveChunkSize = 0;

// Graduated idle unload: soft = unload less-used model early, hard = unload all
// Tier-aware: constrained devices unload sooner to free memory
const tierIdleMs = DeviceCapabilities.budget.translationIdleMs;
const IDLE_SOFT_UNLOAD_MS = Math.min(5 * 60 * 1000, tierIdleMs);
const IDLE_HARD_UNLOAD_MS = tierIdleMs;
let idleUnloadTimer: ReturnType<typeof setTimeout> | null = null;
let idleSoftTimer: ReturnType<typeof setTimeout> | null = null;

function resetIdleUnloadTimer(): void {
    if (idleUnloadTimer) clearTimeout(idleUnloadTimer);
    if (idleSoftTimer) clearTimeout(idleSoftTimer);

    // Soft unload: free the less-used zh-en model after 5 min idle
    idleSoftTimer = setTimeout(() => {
        const zhWorker = workers.find(w => w.model === OPUS_ZH_EN && w.pending.size === 0);
        if (zhWorker) {
            Logger.log('[TranslationService] Soft idle: unloading zh-en to free VRAM');
            terminateWorker(OPUS_ZH_EN);
        }
    }, IDLE_SOFT_UNLOAD_MS);

    // Hard unload: free all after 15 min idle
    idleUnloadTimer = setTimeout(() => {
        if (workers.length > 0 && workers.every(w => w.pending.size === 0)) {
            Logger.log('[TranslationService] Hard idle timeout, unloading all workers');
            terminateWorker();
        }
    }, IDLE_HARD_UNLOAD_MS);
}

function clearIdleUnloadTimer(): void {
    if (idleUnloadTimer) { clearTimeout(idleUnloadTimer); idleUnloadTimer = null; }
    if (idleSoftTimer) { clearTimeout(idleSoftTimer); idleSoftTimer = null; }
}

function getSingleTimeout(): number {
    return webgpuFailed ? SINGLE_TIMEOUT_WASM_MS : SINGLE_TIMEOUT_MS;
}

function getBatchTimeout(itemCount: number): number {
    const base = webgpuFailed ? BATCH_TIMEOUT_BASE_WASM_MS : BATCH_TIMEOUT_BASE_MS;
    const perItem = webgpuFailed ? BATCH_TIMEOUT_PER_ITEM_WASM_MS : BATCH_TIMEOUT_PER_ITEM_MS;
    return base + itemCount * perItem;
}

function terminateWorker(model?: string): void {
    const toKill = model ? workers.filter(w => w.model === model) : workers;
    for (const w of toKill) {
        w.worker.postMessage({ type: 'cleanup' });
        setTimeout(() => w.worker.terminate(), 300);
        for (const [, req] of w.pending) {
            clearTimeout(req.timer);
            req.reject(new Error('Worker terminated'));
        }
        w.pending.clear();
    }
    if (model) {
        workers = workers.filter(w => w.model !== model);
        initPromises.delete(model);
    } else {
        workers = [];
        initPromises.clear();
    }
}

function getWorker(model: string): WorkerEntry | null {
    const ready = workers.filter(w => w.model === model && w.ready);
    if (ready.length === 0) return null;
    return ready[0];
}

function handleWorkerMessage(entry: WorkerEntry, model: string, onReady: () => void, onError: (e: Error) => void) {
    let resolved = false;

    return (e: MessageEvent) => {
        const msg = e.data;

        if (msg.status === 'initiate') {
            // Worker reports its initial backend — track it so we can detect cascade later
            entry.backend = msg.backend || 'wasm';
            return;
        }

        if (msg.status === 'ready') {
            if (msg.backend === 'wasm' && entry.backend && entry.backend !== 'wasm') {
                webgpuFailed = true;
                EventBus.emit('webgpu:failed', { source: 'translation' });
                for (const w of workers) {
                    if (w !== entry) w.worker.postMessage({ type: 'skip-webgpu' });
                }
            }
            entry.backend = msg.backend || 'wasm';
            // Remember successful dtype so future workers skip failed candidates
            if (msg.dtype) {
                rememberedDtype = msg.dtype;
                SharedCache.set(CacheKeys.translationPreferredDtype(), msg.dtype, CACHE_TTL_MS);
            }
            entry.ready = true;
            SharedCache.set(CacheKeys.translationModelReady(model), true, CACHE_TTL_MS);
            if (!resolved) {
                resolved = true;
                EventBus.emit('translation:progress', {
                    percent: 100,
                    message: I18n.t('downloadModelReady'),
                    stage: 'ready',
                    model,
                });
                onReady();
            }
        } else if (msg.status === 'error') {
            const err = msg.data?.message || 'Unknown worker error';
            const isGpuError = /createBuffer|RangeError|out of memory|OOM|device lost|GPUDevice|createComputePipeline|createShaderModule|mapAsync|Instance reference|AbortError/i.test(err);

            if (msg.id && entry.pending.has(msg.id)) {
                const req = entry.pending.get(msg.id)!;
                clearTimeout(req.timer);
                req.reject(new Error(err));
                entry.pending.delete(msg.id);

                if (isGpuError && !webgpuFailed) {
                    webgpuFailed = true;
                    EventBus.emit('webgpu:failed', { source: 'translation' });
                    Logger.warn('[TranslationService] WebGPU inference failed, restarting on WASM');
                    const models = [...new Set(workers.map(w => w.model))];
                    terminateWorker();
                    for (const m of models) initWorker(m).catch(() => { });
                }
            } else if (!resolved) {
                if (isGpuError && !webgpuFailed) {
                    webgpuFailed = true;
                    EventBus.emit('webgpu:failed', { source: 'translation' });
                    Logger.warn('[TranslationService] WebGPU init failed, retrying on WASM');
                    resolved = true;
                    onError(new Error(err));
                    terminateWorker();
                    initWorker(model).catch(() => { });
                } else {
                    resolved = true;
                    EventBus.emit('translation:progress', {
                        percent: 0,
                        message: I18n.format('downloadModelFailed', { message: err }),
                        stage: 'error',
                        model,
                    });
                    onError(new Error(err));
                }
            }
        } else if (msg.status === 'complete') {
            if (msg.id && entry.pending.has(msg.id)) {
                const req = entry.pending.get(msg.id)!;
                clearTimeout(req.timer);
                req.resolve(msg.data);
                entry.pending.delete(msg.id);
                GpuScheduler.onGpuSuccess();
            }
        } else if (msg.status === 'cdn-success') {
            // Persist successful CDN indices so future workers try the known-good CDN first
            if (typeof msg.transformerIdx === 'number') {
                SharedCache.set('asmr-ult:cdn:transformer-idx', msg.transformerIdx, CACHE_TTL_MS);
            }
            if (typeof msg.hubIdx === 'number') {
                SharedCache.set('asmr-ult:cdn:hub-idx', msg.hubIdx, CACHE_TTL_MS);
            }
        } else if (msg.status === 'gpu-device-lost') {
            // Transient GPU device loss — worker will recover with fresh device on next call.
            // Don't set webgpuFailed or restart workers, but notify scheduler.
            Logger.warn('[TranslationService] GPU device lost (transient):', msg.data?.message);
            EventBus.emit('gpu:device-lost', { worker: 'translation' as const });
        } else if (msg.status === 'progress') {
            if (!entry.ready) {
                EventBus.emit('translation:progress', {
                    percent: Math.round(msg.progress || 0),
                    message: msg.file ? I18n.format('translationLoadingModelFile', { file: msg.file }) : I18n.t('downloadModelSub'),
                    stage: 'model',
                    model,
                });
            }
        }
    };
}

function initWorker(model: string, force = false): Promise<void> {
    if (!force && workers.some(w => w.model === model && w.ready)) {
        return initPromises.get(model) || Promise.resolve();
    }

    const existing = initPromises.get(model);
    if (!force && existing && workers.some(w => w.model === model && !w.ready)) {
        return existing;
    }

    if (force) {
        terminateWorker(model);
    }

    // Acquire a load lease from GpuScheduler to prevent concurrent model loading.
    // Only one worker loads a model at a time (requestAdapter + requestDevice + ONNX compile).
    const promise = GpuScheduler.acquireLoadLease('translation').then(releaseLease => {
        return new Promise<void>((resolve, reject) => {
            try {
                EventBus.emit('translation:progress', {
                    percent: 0,
                    message: I18n.t('downloadModelSub'),
                    stage: 'model',
                    model,
                });

                const entry: WorkerEntry = {
                    worker: createTranslationWorker(),
                    ready: false,
                    pending: new Map(),
                    model,
                };
                workers.push(entry);

                if (webgpuFailed) {
                    entry.worker.postMessage({ type: 'skip-webgpu' });
                }
                // Only send cached dtype hint if it's relevant. WASM-only dtypes (q8/q4)
                // are useless when GPU is available — worker uses fp32 on WebGPU anyway,
                // and q8 is the default WASM fallback order.
                const isWasmOnlyDtype = ['q8', 'q4'].includes(rememberedDtype);
                if (rememberedDtype && !(isWasmOnlyDtype && DeviceCapabilities.profile.hasGpu && !webgpuFailed)) {
                    entry.worker.postMessage({ type: 'preferred-dtype', dtype: rememberedDtype });
                }
                // Send persisted CDN preference so worker tries known-good CDN first
                const cdnTransformerIdx = SharedCache.get<number>('asmr-ult:cdn:transformer-idx');
                const cdnHubIdx = SharedCache.get<number>('asmr-ult:cdn:hub-idx');
                if (cdnTransformerIdx !== null || cdnHubIdx !== null) {
                    entry.worker.postMessage({
                        type: 'cdn-preference',
                        transformerIdx: cdnTransformerIdx ?? 0,
                        hubIdx: cdnHubIdx ?? 0,
                    });
                }

                entry.worker.onmessage = handleWorkerMessage(entry, model,
                    () => { releaseLease(); resolve(); },
                    (err) => { releaseLease(); reject(err); },
                );
                entry.worker.postMessage({ type: 'init', model });
            } catch (err) {
                releaseLease();
                workers = workers.filter(w => w.model !== model);
                initPromises.delete(model);
                reject(err);
            }
        });
    });

    initPromises.set(model, promise);
    return promise;
}

// ============================================================================
// Local Translation (through workers)
// ============================================================================

function sendToWorker(
    entry: WorkerEntry, text: string | string[], model: string, timeoutMs: number,
): Promise<any> {
    return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
            if (entry.pending.has(id)) {
                entry.pending.delete(id);
                reject(new Error('Translation timeout'));
            }
        }, timeoutMs);

        entry.pending.set(id, { resolve, reject, timer });
        entry.worker.postMessage({ type: 'translate', text, id, model });
    });
}

async function translateLocal(text: string, targetLang: string): Promise<string | null> {
    const route = getModelForText(text, targetLang);
    if (!route) return null;

    let entry = getWorker(route.model);
    if (!entry) {
        // Worker initializing — wait briefly for it to become ready instead of falling through to remote
        const pending = initPromises.get(route.model);
        if (pending) {
            try {
                await Promise.race([pending, new Promise((_, rej) => setTimeout(() => rej(new Error('init-wait')), 2000))]);
                entry = getWorker(route.model);
            } catch { /* timed out or failed, fall through */ }
        } else {
            initWorker(route.model).catch(() => { });
        }
        if (!entry) return null;
    }

    // Single translations get REALTIME priority — they're the current subtitle/title
    const raw = await GpuScheduler.enqueue({
        priority: Priority.REALTIME,
        worker: 'translation',
        execute: () => sendToWorker(entry, text, route.model, getSingleTimeout()),
    });
    if (!raw) return null;

    const cleaned = TranslationService.cleanQuotes(raw);
    return isLikelyGarbage(text, cleaned) ? null : cleaned;
}

async function translateLocalBatch(texts: string[], targetLang: string): Promise<(string | null)[]> {
    const results: (string | null)[] = new Array(texts.length).fill(null);

    // Group texts by model (each opus-mt model handles one language pair)
    interface BatchGroup { indices: number[]; texts: string[]; route: ModelRoute }
    const groups = new Map<string, BatchGroup>();
    for (let i = 0; i < texts.length; i++) {
        const route = getModelForText(texts[i], targetLang);
        if (!route) continue;
        const key = route.model;
        let g = groups.get(key);
        if (!g) { g = { indices: [], texts: [], route }; groups.set(key, g); }
        g.indices.push(i);
        g.texts.push(texts[i]);
    }

    await Promise.all(Array.from(groups.values()).map(async (group) => {
        let entry = getWorker(group.route.model);
        if (!entry) {
            const pending = initPromises.get(group.route.model);
            if (pending) {
                try {
                    await Promise.race([pending, new Promise((_, rej) => setTimeout(() => rej(new Error('init-wait')), 2000))]);
                    entry = getWorker(group.route.model);
                } catch { /* timed out */ }
            } else {
                initWorker(group.route.model).catch(() => { });
            }
            if (!entry) return;
        }

        // Sequential chunks: each chunk awaits completion before the next is sent.
        // This naturally staggers timeouts and creates interleave points where
        // single-text requests (live whisper) can jump the worker queue.
        // Adaptive: converge chunk size based on observed ms-per-item throughput.
        let chunkSize = webgpuFailed
            ? BATCH_CHUNK_SIZE_WASM
            : whisperActive ? BATCH_CHUNK_SIZE_GPU_THROTTLED : BATCH_CHUNK_SIZE_GPU;
        if (adaptiveChunkSize > 0) chunkSize = whisperActive ? Math.max(4, adaptiveChunkSize >> 1) : adaptiveChunkSize;

        for (let i = 0; i < group.texts.length; i += chunkSize) {
            const chunkTexts = group.texts.slice(i, i + chunkSize);
            const chunkIndices = group.indices.slice(i, i + chunkSize);
            const timeoutMs = getBatchTimeout(chunkTexts.length);

            try {
                const t0 = performance.now();
                // Batch chunks get NORMAL priority — background pre-translation
                const translated = await GpuScheduler.enqueue({
                    priority: Priority.NORMAL,
                    worker: 'translation',
                    execute: () => sendToWorker(entry, chunkTexts, group.route.model, timeoutMs),
                    cancellable: true,
                });
                const elapsedMs = performance.now() - t0;

                // Adapt chunk size: target 2-5s per chunk (GPU=3s, WASM=5s)
                if (chunkTexts.length >= 4 && elapsedMs > 100) {
                    const targetMs = webgpuFailed ? 5000 : 3000;
                    const msPerItem = elapsedMs / chunkTexts.length;
                    const ideal = Math.round(targetMs / msPerItem);
                    adaptiveChunkSize = Math.max(4, Math.min(128, ideal));
                    // Update chunkSize for remaining chunks in this batch
                    chunkSize = whisperActive ? Math.max(4, adaptiveChunkSize >> 1) : adaptiveChunkSize;
                }

                if (Array.isArray(translated)) {
                    for (let j = 0; j < chunkIndices.length; j++) {
                        const raw = translated[j];
                        if (raw) {
                            const cleaned = TranslationService.cleanQuotes(raw);
                            results[chunkIndices[j]] = isLikelyGarbage(chunkTexts[j], cleaned) ? null : cleaned;
                        }
                    }
                }
            } catch (e) {
                Logger.debug('[TranslationService] Local batch chunk failed:', e);
            }
        }
    }));

    return results;
}

// ============================================================================
// Remote Translation (Google Translate fallback)
// ============================================================================

let remoteActive = 0;
let remoteLastTime = 0;
let remotePausedUntil = 0;
// Promise-based semaphore: waiters are resolved FIFO when a slot frees up (replaces polling loop)
const remoteWaiters: Array<() => void> = [];

function acquireRemoteSlot(): Promise<void> {
    if (remoteActive < REMOTE_CONCURRENCY) {
        remoteActive++;
        return Promise.resolve();
    }
    return new Promise<void>(resolve => {
        remoteWaiters.push(() => { remoteActive++; resolve(); });
    });
}

function releaseRemoteSlot(): void {
    remoteActive--;
    const next = remoteWaiters.shift();
    if (next) next();
}

async function translateRemoteSingle(text: string, targetLang: string): Promise<string> {
    // Rate limiting
    if (Date.now() < remotePausedUntil) {
        await new Promise(r => setTimeout(r, Math.max(0, remotePausedUntil - Date.now())));
    }

    // Minimum interval between requests
    const elapsed = Date.now() - remoteLastTime;
    if (elapsed < REMOTE_MIN_INTERVAL_MS) {
        await new Promise(r => setTimeout(r, REMOTE_MIN_INTERVAL_MS - elapsed));
    }

    await acquireRemoteSlot();
    remoteLastTime = Date.now();

    try {
        const res = await retryWithBackoff(
            () => gmRequest({
                url: `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`,
            }),
            { attempts: 2, backoffMs: 500, shouldRetry: (e) => !(e instanceof HttpError) || e.status >= 500 },
        );
        const parsed = JSON.parse(res.responseText);
        return parsed?.[0]?.map((x: any) => x?.[0] || '').join('') || text;
    } catch (e) {
        if (e instanceof HttpError && e.status === 429) {
            remotePausedUntil = Date.now() + REMOTE_RATE_LIMIT_PAUSE_MS;
            SharedCache.set(CacheKeys.translationRateLimit(), remotePausedUntil, REMOTE_RATE_LIMIT_PAUSE_MS);
            Logger.warn('[TranslationService] Google Translate 429, pausing', REMOTE_RATE_LIMIT_PAUSE_MS / 1000, 's');
        }
        throw e;
    } finally {
        releaseRemoteSlot();
    }
}

// ============================================================================
// Public API
// ============================================================================

export const TranslationService = {
    ttlMs: CACHE_TTL_MS,

    /**
     * Pre-load both opus-mt translation models.
     */
    async ensureLocalModelReady(): Promise<void> {
        if (Config.get('preferLocalTranslation') === false) return;
        // Sequential loading: avoid creating 2 GPU devices simultaneously
        await initWorker(OPUS_JA_EN, false);
        await initWorker(OPUS_ZH_EN, false);
    },

    /**
     * Force-reload translation models.
     */
    async warmupLocalModel(): Promise<void> {
        // Sequential loading: avoid creating 2 GPU devices simultaneously
        await initWorker(OPUS_JA_EN, true);
        await initWorker(OPUS_ZH_EN, true);
        resetIdleUnloadTimer();
    },

    disableLocalTranslation(reason = 'user-disabled'): void {
        Logger.warn('[TranslationService] Local translation disabled:', reason);
        clearIdleUnloadTimer();
        terminateWorker();
    },

    isUserLang(text: string): boolean {
        const lang = I18n.lang;
        if (lang === 'ja' && /[぀-ヿ一-龯]/.test(text)) return true;
        if (lang === 'zh' && /[一-龯]/.test(text) && !/[぀-ヿ]/.test(text)) return true;
        return false;
    },

    /**
     * Translate a single text. Tries local first, falls back to remote.
     */
    async translate(text: string, targetLang = 'en'): Promise<string> {
        if (!text) return '';
        targetLang = normalizeTargetLang(targetLang);
        resetIdleUnloadTimer();

        const cached = getCached(text, targetLang);
        if (cached) return cached;

        // In-flight dedup: reuse pending translation for same text+lang
        const flightKey = `${targetLang}:${text}`;
        const existing = translateInFlight.get(flightKey);
        if (existing) return existing;

        const promise = this._translateInner(text, targetLang);
        translateInFlight.set(flightKey, promise);
        try {
            return await promise;
        } finally {
            translateInFlight.delete(flightKey);
        }
    },

    /** @internal */
    async _translateInner(text: string, targetLang: string): Promise<string> {
        // 0. Multi-sentence split — opus-mt treats 。as EOS and drops subsequent sentences.
        //    Split on 。, translate each sentence independently, then join.
        const sentences = splitForModel(text);
        if (sentences) {
            const results = await Promise.all(
                sentences.map(s => this.translate(s, targetLang)),
            );
            const joined = results.join('. ');
            SharedCache.set(cacheKey(text, targetLang, 'local'), joined, CACHE_TTL_MS);
            return joined;
        }

        // 1. Glossary exact match — bypasses model entirely
        const glossaryResult = applyGlossary(text, targetLang);
        if (glossaryResult) {
            SharedCache.set(cacheKey(text, targetLang, 'local'), glossaryResult, CACHE_TTL_MS);
            return glossaryResult;
        }

        // 2. Glossary pre-processing — substitute known terms so model translates around them
        const [preprocessed, wasModified] = glossaryPreProcess(text, targetLang);

        // 3. Try local translation (with preprocessed text if glossary modified it)
        //    Normalize input: strip decorative chars (♡♪〜) and convert 「」→"" that confuse opus-mt
        if (Config.get('preferLocalTranslation') !== false) {
            try {
                const localInput = normalizeForModel(wasModified ? preprocessed : text);
                const result = await translateLocal(localInput, targetLang);
                if (result) {
                    // Cache under the ORIGINAL text key
                    SharedCache.set(cacheKey(text, targetLang, 'local'), result, CACHE_TTL_MS);
                    return result;
                }
            } catch (e) {
                Logger.debug('[TranslationService] Local failed, using remote:', e);
            }
        }

        // 4. Remote fallback (also with preprocessed text)
        try {
            const result = await translateRemoteSingle(wasModified ? preprocessed : text, targetLang);
            const cleaned = this.cleanQuotes(result);
            if (cleaned && cleaned !== text) {
                SharedCache.set(cacheKey(text, targetLang, 'remote'), cleaned, CACHE_TTL_MS);
            }
            return cleaned || text;
        } catch (e) {
            Logger.debug('[TranslationService] Remote failed:', e);
            return text;
        }
    },

    /**
     * Translate a batch of texts. Uses local for supported pairs, remote for the rest.
     */
    async translateBatch(texts: string[], targetLang = 'en'): Promise<string[]> {
        if (texts.length === 0) return [];
        targetLang = normalizeTargetLang(targetLang);

        const results = new Array(texts.length).fill('');
        const uncached: { idx: number; text: string }[] = [];
        const seen = new Map<string, number[]>();

        // 1. Fill from cache, dedup uncached
        for (let i = 0; i < texts.length; i++) {
            const text = texts[i]?.trim();
            if (!text) continue;

            const cached = getCached(text, targetLang);
            if (cached) {
                results[i] = cached;
            } else if (seen.has(text)) {
                seen.get(text)!.push(i);
            } else {
                seen.set(text, [i]);
                uncached.push({ idx: i, text });
            }
        }

        if (uncached.length === 0) return results;

        // 1b. Fill from glossary exact matches
        const stillUncached: typeof uncached = [];
        for (const entry of uncached) {
            const glossaryResult = applyGlossary(entry.text, targetLang);
            if (glossaryResult) {
                const indices = seen.get(entry.text) || [];
                for (const idx of indices) results[idx] = glossaryResult;
                SharedCache.set(cacheKey(entry.text, targetLang, 'local'), glossaryResult, CACHE_TTL_MS);
            } else {
                stillUncached.push(entry);
            }
        }

        if (stillUncached.length === 0) return results;

        // Pre-process remaining texts with glossary substitution + model normalization
        const preprocessedMap = new Map<string, string>();
        const preprocessedTexts = stillUncached.map(u => {
            const [preprocessed] = glossaryPreProcess(u.text, targetLang);
            const normalized = normalizeForModel(preprocessed);
            preprocessedMap.set(u.text, normalized);
            return normalized;
        });
        let remaining: { idx: number; text: string }[] = [];

        // 2. Try local batch translation (with glossary-preprocessed texts)
        if (Config.get('preferLocalTranslation') !== false) {
            try {
                const localResults = await translateLocalBatch(preprocessedTexts, targetLang);

                for (let i = 0; i < stillUncached.length; i++) {
                    const translated = localResults[i];
                    if (translated) {
                        const indices = seen.get(stillUncached[i].text) || [];
                        for (const idx of indices) results[idx] = translated;
                        SharedCache.set(cacheKey(stillUncached[i].text, targetLang, 'local'), translated, CACHE_TTL_MS);
                    } else {
                        remaining.push(stillUncached[i]);
                    }
                }
            } catch (e) {
                Logger.debug('[TranslationService] Local batch failed:', e);
                remaining = [...stillUncached];
            }
        } else {
            remaining = [...stillUncached];
        }

        // 3. Remote fallback for anything local didn't handle
        if (remaining.length > 0) {
            Logger.debug('[TranslationService] Remote batch:', remaining.length, 'texts');

            const remoteResults = await Promise.allSettled(
                remaining.map(({ text }) => {
                    const preprocessed = preprocessedMap.get(text) || text;
                    return translateRemoteSingle(preprocessed, targetLang).catch(() => text);
                })
            );

            for (let i = 0; i < remaining.length; i++) {
                const res = remoteResults[i];
                const original = remaining[i].text;
                let translated = res.status === 'fulfilled' ? res.value : original;
                translated = this.cleanQuotes(translated);

                const indices = seen.get(original) || [];
                for (const idx of indices) results[idx] = translated;

                if (translated && translated !== original) {
                    SharedCache.set(cacheKey(original, targetLang, 'remote'), translated, CACHE_TTL_MS);
                }
            }
        }

        return results;
    },

    canPrefetch(count: number): boolean {
        if (count > PREFETCH_MAX_LINES) return false;
        const rateLimitUntil = SharedCache.get<number>(CacheKeys.translationRateLimit()) || 0;
        if (Date.now() < rateLimitUntil && !this.hasLocalTranslator()) return false;
        return true;
    },

    isRateLimited(): boolean {
        if (this.hasLocalTranslator()) return false; // local model is never rate-limited
        const rateLimitUntil = SharedCache.get<number>(CacheKeys.translationRateLimit()) || 0;
        return Date.now() < rateLimitUntil;
    },

    hasLocalTranslator(): boolean {
        return Config.get('preferLocalTranslation') !== false && workers.some(w => w.ready);
    },

    getLoadedModels(): Array<{ model: string; ready: boolean }> {
        const models = new Map<string, boolean>();
        for (const w of workers) {
            if (!models.has(w.model) || w.ready) {
                models.set(w.model, w.ready);
            }
        }
        return Array.from(models.entries()).map(([model, ready]) => ({ model, ready }));
    },

    peekCached(text: string, targetLang = 'en'): string | null {
        if (!text) return null;
        return getCached(text, normalizeTargetLang(targetLang));
    },

    async autoTranslate(text: string, targetLang = 'en'): Promise<string> {
        if (!text || !/[぀-ヿ一-龯]/.test(text)) return text;
        if (this.isUserLang(text) && targetLang === 'en') return text;
        const translated = await this.translate(text, targetLang);
        return this.formatPair(text, translated);
    },

    clearCache(): number {
        SharedCache.clear();
        let cleared = 0;
        try {
            const keys = GM_listValues();
            for (const key of keys) {
                if (key.startsWith('asmr-ult:trans:') ||
                    key.startsWith('asmr-ult:tag:') ||
                    key.startsWith('asmr-ult:player:')) {
                    GM_deleteValue(key);
                    cleared++;
                }
            }
        } catch {
            const toRemove: string[] = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && (k.startsWith('asmr-ult:trans:') ||
                    k.startsWith('asmr-ult:tag:') ||
                    k.startsWith('asmr-ult:player:'))) {
                    toRemove.push(k);
                }
            }
            toRemove.forEach(k => localStorage.removeItem(k));
            cleared = toRemove.length;
        }
        Logger.log(`[TranslationService] Cleared ${cleared} cached translations`);
        return cleared;
    },

    formatPair(original: string, translated: string): string {
        if (!translated || translated === original) return original;
        return `${original} (${this.cleanQuotes(translated)})`;
    },

    cleanQuotes(text: string): string {
        if (!text) return '';
        let s = text.replace(_quoteRegex, m => _quoteMap[m] || m);
        s = s.replace(/"\s+([^"]+)\s+"/g, '"$1"');
        s = s.replace(/'\s+([^']+)\s+'/g, "'$1'");
        return s.trim();
    }
};

// Exported for unit testing — not part of the public API
export const _testExports = { normalizeForModel, splitForModel, isLikelyGarbage };
