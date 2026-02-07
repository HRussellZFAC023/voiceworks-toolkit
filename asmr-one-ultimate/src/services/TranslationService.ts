import { GM_listValues, GM_deleteValue } from '$';
import { CacheKeys, SharedCache } from '../core/Cache';
import { gmRequest, retryWithBackoff, HttpError } from '../infrastructure/HttpClient';
import { I18n, Config } from '../core/Config';
import { Logger } from '../core/Utils';
import { EventBus } from '../core/EventBus';
import { createTranslationWorker } from '../features/TranslationWorkerLoader';
import { AppStore } from '../store/AppStore';
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

// Smaller chunks = more chances for single-text (current line) requests to interleave
// between batch chunks in the worker queue. GPU processes each chunk atomically.
const BATCH_CHUNK_SIZE = 16;

// Remote (Google Translate) settings
const REMOTE_CONCURRENCY = 12;
const REMOTE_MIN_INTERVAL_MS = 50;
const REMOTE_RATE_LIMIT_PAUSE_MS = 60_000;

// Single NLLB model handles all language pairs (~895MB q8, 600M params)
const NLLB_MODEL = 'Xenova/nllb-200-distilled-600M';

// FLORES-200 language codes required by NLLB
const FLORES_CODES: Record<string, string> = {
    ja: 'jpn_Jpan',
    zh: 'zho_Hans',
    en: 'eng_Latn',
};

interface ModelRoute {
    model: string;
    srcLang: string;   // FLORES-200 code
    tgtLang: string;   // FLORES-200 code
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

    const srcCode = FLORES_CODES[src];
    const tgtCode = FLORES_CODES[tgt];
    if (!srcCode || !tgtCode) return null; // unsupported language

    return { model: NLLB_MODEL, srcLang: srcCode, tgtLang: tgtCode };
}

// ============================================================================
// Quality Checks
// ============================================================================

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
// Cache
// ============================================================================

const cacheKey = (text: string, lang: string, source: TranslationSource): string =>
    CacheKeys.translation(text, normalizeTargetLang(lang), source);

function getCached(text: string, lang: string): string | null {
    return SharedCache.get<string>(cacheKey(text, lang, 'local'))
        || SharedCache.get<string>(cacheKey(text, lang, 'remote'))
        || null;
}

// ============================================================================
// Worker Pool (single NLLB worker)
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
    deviceHint?: string;  // 'webnn' for NPU worker, undefined for auto (GPU/WASM)
}

let workers: WorkerEntry[] = [];
let initPromises = new Map<string, Promise<void>>();
let nextId = 0;
let webgpuFailed = false;
// dtype that worked last time — sent to new workers to skip failed candidates (persisted across sessions)
let rememberedDtype = SharedCache.get<string>(CacheKeys.translationPreferredDtype()) || '';

// In-flight dedup: prevent duplicate translate() calls for the same text+lang
const translateInFlight = new Map<string, Promise<string>>();

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
        try { w.worker.terminate(); } catch { /* ignore */ }
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
    // Least-loaded: route to the worker with fewest pending requests.
    // When GPU + NPU workers exist, this naturally distributes work.
    return ready.reduce((best, w) => w.pending.size < best.pending.size ? w : best);
}

function handleWorkerMessage(entry: WorkerEntry, model: string, onReady: () => void, onError: (e: Error) => void) {
    let resolved = false;

    return (e: MessageEvent) => {
        const msg = e.data;

        if (msg.status === 'ready') {
            if (msg.backend === 'wasm' && entry.backend && entry.backend !== 'wasm') {
                webgpuFailed = true;
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
            const isGpuError = /createBuffer|RangeError|out of memory|OOM|device lost|GPUDevice|createComputePipeline|createShaderModule/i.test(err);

            if (msg.id && entry.pending.has(msg.id)) {
                const req = entry.pending.get(msg.id)!;
                clearTimeout(req.timer);
                req.reject(new Error(err));
                entry.pending.delete(msg.id);

                // NPU worker error: just remove it, don't disrupt GPU workers
                if (entry.deviceHint === 'webnn') {
                    Logger.warn('[TranslationService] WebNN-NPU inference failed, removing NPU worker');
                    try { entry.worker.terminate(); } catch { /* ignore */ }
                    workers = workers.filter(w => w !== entry);
                } else if (isGpuError && !webgpuFailed) {
                    webgpuFailed = true;
                    Logger.warn('[TranslationService] WebGPU inference failed, restarting on WASM');
                    const models = [...new Set(workers.map(w => w.model))];
                    terminateWorker();
                    for (const m of models) initWorker(m).catch(() => { });
                }
            } else if (!resolved) {
                // Init error — NPU failures are non-fatal (GPU worker handles everything)
                if (entry.deviceHint === 'webnn') {
                    Logger.debug('[TranslationService] WebNN-NPU init failed (non-fatal):', err);
                    resolved = true;
                    try { entry.worker.terminate(); } catch { /* ignore */ }
                    workers = workers.filter(w => w !== entry);
                    onError(new Error(err));
                } else if (isGpuError && !webgpuFailed) {
                    webgpuFailed = true;
                    Logger.warn('[TranslationService] WebGPU init failed, retrying on WASM');
                    resolved = true;
                    onError(new Error(err));
                    terminateWorker();
                    initWorker(NLLB_MODEL).catch(() => { });
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
            }
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

function initWorker(model: string, force = false, deviceHint?: string): Promise<void> {
    // Keyed by model + device so GPU and NPU workers coexist
    const key = deviceHint ? `${model}:${deviceHint}` : model;

    if (!force && workers.some(w => w.model === model && w.ready && (!deviceHint || w.deviceHint === deviceHint))) {
        return initPromises.get(key) || Promise.resolve();
    }

    const existing = initPromises.get(key);
    if (!force && existing && workers.some(w => w.model === model && !w.ready && (!deviceHint || w.deviceHint === deviceHint))) {
        return existing;
    }

    if (force) {
        // Only terminate workers matching this device hint
        if (deviceHint) {
            const toKill = workers.filter(w => w.model === model && w.deviceHint === deviceHint);
            for (const w of toKill) {
                try { w.worker.terminate(); } catch { /* ignore */ }
                for (const [, req] of w.pending) { clearTimeout(req.timer); req.reject(new Error('Worker terminated')); }
                w.pending.clear();
            }
            workers = workers.filter(w => !(w.model === model && w.deviceHint === deviceHint));
            initPromises.delete(key);
        } else {
            terminateWorker(model);
        }
    }

    const promise = new Promise<void>((resolve, reject) => {
        try {
            if (!deviceHint) {
                EventBus.emit('translation:progress', {
                    percent: 0,
                    message: I18n.t('downloadModelSub'),
                    stage: 'model',
                    model,
                });
            }

            const entry: WorkerEntry = {
                worker: createTranslationWorker(),
                ready: false,
                pending: new Map(),
                model,
                deviceHint,
            };
            workers.push(entry);

            // WebNN worker: skip WebGPU so the cascade falls through to WebNN
            // Default worker: skip WebGPU only if a previous GPU failure occurred
            if (deviceHint === 'webnn' || (webgpuFailed && !deviceHint)) {
                entry.worker.postMessage({ type: 'skip-webgpu' });
            }
            if (rememberedDtype) {
                entry.worker.postMessage({ type: 'preferred-dtype', dtype: rememberedDtype });
            }

            entry.worker.onmessage = handleWorkerMessage(entry, model, resolve, reject);
            entry.worker.postMessage({ type: 'init', model });
        } catch (err) {
            // Only terminate this specific worker on error
            workers = workers.filter(w => w.deviceHint !== deviceHint || w.model !== model);
            initPromises.delete(key);
            reject(err);
        }
    });

    initPromises.set(key, promise);
    return promise;
}

// ============================================================================
// Local Translation (through workers)
// ============================================================================

function sendToWorker(
    entry: WorkerEntry, text: string | string[], model: string, timeoutMs: number,
    langOpts?: { srcLang: string; tgtLang: string },
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
        entry.worker.postMessage({
            type: 'translate', text, id, model,
            src_lang: langOpts?.srcLang,
            tgt_lang: langOpts?.tgtLang,
        });
    });
}

async function translateLocal(text: string, targetLang: string): Promise<string | null> {
    const route = getModelForText(text, targetLang);
    if (!route) return null;

    const entry = getWorker(route.model);
    if (!entry) {
        initWorker(route.model).catch(() => { });
        return null;
    }

    const raw = await sendToWorker(entry, text, route.model, getSingleTimeout(), route);
    if (!raw) return null;

    const cleaned = TranslationService.cleanQuotes(raw);
    return isLikelyGarbage(text, cleaned) ? null : cleaned;
}

async function translateLocalBatch(texts: string[], targetLang: string): Promise<(string | null)[]> {
    const results: (string | null)[] = new Array(texts.length).fill(null);

    // Group texts by model + language pair (NLLB uses one model for multiple pairs)
    interface BatchGroup { indices: number[]; texts: string[]; route: ModelRoute }
    const groups = new Map<string, BatchGroup>();
    for (let i = 0; i < texts.length; i++) {
        const route = getModelForText(texts[i], targetLang);
        if (!route) continue;
        const key = `${route.model}|${route.srcLang}|${route.tgtLang}`;
        let g = groups.get(key);
        if (!g) { g = { indices: [], texts: [], route }; groups.set(key, g); }
        g.indices.push(i);
        g.texts.push(texts[i]);
    }

    await Promise.all(Array.from(groups.values()).map(async (group) => {
        const entry = getWorker(group.route.model);
        if (!entry) {
            initWorker(group.route.model).catch(() => { });
            return;
        }

        // Split into chunks for throughput
        for (let i = 0; i < group.texts.length; i += BATCH_CHUNK_SIZE) {
            const chunkTexts = group.texts.slice(i, i + BATCH_CHUNK_SIZE);
            const chunkIndices = group.indices.slice(i, i + BATCH_CHUNK_SIZE);
            const timeoutMs = getBatchTimeout(chunkTexts.length);

            try {
                const translated = await sendToWorker(entry, chunkTexts, group.route.model, timeoutMs, group.route);
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

async function translateRemoteSingle(text: string, targetLang: string): Promise<string> {
    // Rate limiting
    while (Date.now() < remotePausedUntil) {
        await new Promise(r => setTimeout(r, remotePausedUntil - Date.now()));
    }

    // Minimum interval between requests
    const elapsed = Date.now() - remoteLastTime;
    if (elapsed < REMOTE_MIN_INTERVAL_MS) {
        await new Promise(r => setTimeout(r, REMOTE_MIN_INTERVAL_MS - elapsed));
    }

    while (remoteActive >= REMOTE_CONCURRENCY) {
        await new Promise(r => setTimeout(r, 50));
    }

    remoteActive++;
    remoteLastTime = Date.now();

    try {
        const res = await retryWithBackoff(
            () => gmRequest({
                url: `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`,
            }),
            { attempts: 2, backoffMs: 500, shouldRetry: (e) => !(e instanceof HttpError && e.status === 429) },
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
        remoteActive--;
    }
}

// ============================================================================
// WebNN NPU Detection (host-side, for distributed mode)
// ============================================================================

async function detectWebNNNpu(): Promise<boolean> {
    try {
        if (typeof navigator === 'undefined' || !(navigator as any).ml) return false;
        const ctx = await (navigator as any).ml.createContext({ deviceType: 'npu' });
        return !!ctx;
    } catch {
        return false;
    }
}

// ============================================================================
// Public API
// ============================================================================

export const TranslationService = {
    ttlMs: CACHE_TTL_MS,

    /**
     * Pre-load the NLLB translation model.
     * When WebNN-NPU is available alongside WebGPU, starts a second worker
     * on the NPU for distributed inference (GPU + NPU process concurrently).
     */
    async ensureLocalModelReady(): Promise<void> {
        if (Config.get('preferLocalTranslation') === false) return;
        await initWorker(NLLB_MODEL, false);

        // Distributed: try adding an NPU worker alongside the GPU worker.
        // Only if the primary worker is on WebGPU (not WASM — no point running
        // two WASM-speed workers) and the user hasn't disabled distributed mode.
        if (!webgpuFailed && Config.get('distributedTranslation') !== false) {
            detectWebNNNpu().then(available => {
                if (available) {
                    Logger.log('[TranslationService] WebNN NPU detected — starting distributed worker');
                    initWorker(NLLB_MODEL, false, 'webnn').catch(err => {
                        Logger.debug('[TranslationService] WebNN NPU worker failed (non-fatal):', err);
                    });
                }
            });
        }
    },

    /**
     * Force-reload the translation model.
     */
    async warmupLocalModel(): Promise<void> {
        await initWorker(NLLB_MODEL, true);
    },

    disableLocalTranslation(reason = 'user-disabled'): void {
        Logger.warn('[TranslationService] Local translation disabled:', reason);
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
        // 1. Glossary exact match — bypasses model entirely
        const glossaryResult = applyGlossary(text, targetLang);
        if (glossaryResult) {
            SharedCache.set(cacheKey(text, targetLang, 'local'), glossaryResult, CACHE_TTL_MS);
            return glossaryResult;
        }

        // 2. Glossary pre-processing — substitute known terms so model translates around them
        const [preprocessed, wasModified] = glossaryPreProcess(text, targetLang);

        // 3. Try local translation (with preprocessed text if glossary modified it)
        if (Config.get('preferLocalTranslation') !== false) {
            try {
                const result = await translateLocal(wasModified ? preprocessed : text, targetLang);
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

        // Whisper-aware scheduling: when Whisper is actively transcribing on WASM,
        // defer batch work to avoid CPU contention (both compete for WASM threads).
        // Max wait 60s to prevent permanent blocking if Whisper gets stuck.
        if (webgpuFailed && AppStore.state.whisper?.isTranscribing) {
            const waitStart = Date.now();
            await new Promise<void>(resolve => {
                const check = () => {
                    if (!AppStore.state.whisper?.isTranscribing || Date.now() - waitStart > 60_000) {
                        resolve();
                        return;
                    }
                    setTimeout(check, 2000);
                };
                setTimeout(check, 2000);
            });
        }

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

        // Pre-process remaining texts with glossary substitution for model
        const preprocessedTexts = stillUncached.map(u => {
            const [preprocessed] = glossaryPreProcess(u.text, targetLang);
            return preprocessed;
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
                    const [preprocessed] = glossaryPreProcess(text, targetLang);
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
        return getCached(text, targetLang);
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
        let s = text;
        s = s.replace(/``/g, '"').replace(/''/g, '"');
        const replacements: [RegExp, string][] = [
            [/«|»|„|"|"|〝|〞|〟|″|〝/g, '"'],
            [/'|'|‚|‹|›|′/g, "'"],
            [/（/g, '('], [/）/g, ')'],
            [/【/g, '['], [/】/g, ']'],
            [/！/g, '!'], [/？/g, '?'],
            [/：/g, ':'], [/；/g, ';'], [/，/g, ','],
        ];
        for (const [pattern, replacement] of replacements) {
            s = s.replace(pattern, replacement);
        }
        s = s.replace(/"\s+([^"]+)\s+"/g, '"$1"');
        s = s.replace(/'\s+([^']+)\s+'/g, "'$1'");
        return s.trim();
    }
};
