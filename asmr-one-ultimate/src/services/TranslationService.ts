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
const TRANSLATION_CACHE_SCHEMA_VERSION = 'v2';
const PREFETCH_MAX_LINES = 1000;

// Timeouts: greedy decoding is 3-4x faster than beam search
const SINGLE_TIMEOUT_MS = 15_000;
const BATCH_TIMEOUT_BASE_MS = 15_000;
const BATCH_TIMEOUT_PER_ITEM_MS = 50;

// Larger chunks = fewer round-trips, better GPU utilization.
// Short DLsite titles translate fast (~10-20ms each) — big chunks keep GPU saturated.
// When Whisper is actively transcribing, reduce batch size to avoid GPU contention.
const BATCH_CHUNK_SIZE_GPU = 96;
const BATCH_CHUNK_SIZE_GPU_THROTTLED = 12;

// Remote (Google Translate) settings
const REMOTE_CONCURRENCY = 12;
const REMOTE_MIN_INTERVAL_MS = 50;
const REMOTE_RATE_LIMIT_PAUSE_MS = 15_000;

// TLD rotation: spread requests across Google Translate domains to reduce per-host 429s
const GOOGLE_TRANSLATE_HOSTS = [
    'translate.googleapis.com',
    'translate.google.com',
    'translate.google.co.jp',
    'translate.google.de',
    'translate.google.fr',
    'translate.google.es',
    'translate.google.co.kr',
    'translate.google.com.tw',
];
let _gtldIndex = 0;
function nextTranslateHost(): string {
    const host = GOOGLE_TRANSLATE_HOSTS[_gtldIndex % GOOGLE_TRANSLATE_HOSTS.length];
    _gtldIndex++;
    return host;
}

// Single-pass quote/fullwidth normalization — compiled once at module scope
const _quoteMap: Record<string, string> = {
    '``': '"', "''": '"',
    '\u00AB': '"', '\u00BB': '"', '\u201E': '"', '\u201C': '"', '\u201D': '"',
    '\u301D': '"', '\u301E': '"', '\u301F': '"', '\u2033': '"',
    '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u2039': "'", '\u203A': "'", '\u2032': "'",
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
const _modelNormWaveDash = /[〜～]/g;
const _modelNormEllipsis = /…/g;
const _modelNormMultiply = /[×✕✖・]/g;
const _modelNormDecorative = /[♡♥♪♫★☆✨💕🌙❤️✿❀⭐🎵🎶💖💗💓💘🔥💜💙💛🤍🖤🩷🩵]/g;
const _modelNormSpaces = /\s{2,}/g;
function normalizeForModel(text: string): string {
    return text
        .replace(_modelNormQuoteOpen, '"')      // 「『 → " (prevents model stopping at quote boundary)
        .replace(_modelNormQuoteClose, '"')     // 」』 → "
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

export interface TranslationTaskOptions {
    priority?: Priority;
    cancellable?: boolean;
    cancellableKey?: string;
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
 * ("I'm sorry...", "I don't know...") when it can't decode the input (e.g. proper nouns).
 * DLsite titles/tags are noun phrases — first-person output without first-person input is a red flag.
 */
const _hallucinationFirstPerson = /^I['\u2019]?m\s|^I\s(don|can|won|didn|couldn|wouldn|shouldn)['\u2019]t\s|^I\s(have|want|need|think|know|like)\s/i;
const _firstPersonJa = /私|僕|俺|わたし|ぼく|おれ|あたし/;

interface DegenerateSampleLog {
    localRejected: number;
    remoteRejected: number;
    lastLogAt: number;
}

const degenerateStats: DegenerateSampleLog = {
    localRejected: 0,
    remoteRejected: 0,
    lastLogAt: 0,
};

function hasRepeatedNGram(tokens: string[], n: number, minRepeats: number): boolean {
    if (tokens.length < n * minRepeats) return false;
    let repeats = 1;
    for (let i = n; i + n <= tokens.length; i += n) {
        let same = true;
        for (let j = 0; j < n; j++) {
            if (tokens[i + j] !== tokens[i - n + j]) {
                same = false;
                break;
            }
        }
        if (same) {
            repeats++;
            if (repeats >= minRepeats) return true;
        } else {
            repeats = 1;
        }
    }
    return false;
}

function getGarbageReason(input: string, output: string): string | null {
    const trimmed = output?.trim() || '';
    if (!trimmed) return 'empty-output';
    if (trimmed.length > input.length * 5 && trimmed.length > 100) return 'excessive-length';
    if (/([!?.])\1{3,}/.test(trimmed)) return 'repeated-punctuation';
    if (/([a-z0-9])\1{15,}/i.test(trimmed)) return 'repeated-char-run';
    if (/([^\s])\1{20,}/.test(trimmed)) return 'repeated-symbol-run';

    const words = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length > 0) {
        let repeat = 1;
        for (let i = 1; i < words.length; i++) {
            if (words[i] === words[i - 1] && words[i].length > 1) {
                if (++repeat >= 4) return 'repeated-word-run';
            } else {
                repeat = 1;
            }
        }
        const ngramTokens = words.filter((w) => w.length > 1);
        if (
            ngramTokens.length >= 12
            && (
                hasRepeatedNGram(ngramTokens, 2, 3)
                || hasRepeatedNGram(ngramTokens, 3, 3)
                || hasRepeatedNGram(ngramTokens, 4, 3)
            )
        ) {
            return 'repeated-ngram-run';
        }
    }

    // Hallucination: first-person English from non-first-person Japanese input
    if (!_firstPersonJa.test(input) && _hallucinationFirstPerson.test(trimmed)) {
        return 'first-person-hallucination';
    }
    return null;
}

function trackDegenerate(source: TranslationSource, input: string, output: string, reason: string): void {
    if (source === 'local') {
        degenerateStats.localRejected++;
    } else {
        degenerateStats.remoteRejected++;
    }

    if (!Config.get('debug')) return;
    const now = Date.now();
    if (now - degenerateStats.lastLogAt > 1500) {
        degenerateStats.lastLogAt = now;
        Logger.debug('[TranslationService] Rejected degenerate output', {
            source,
            reason,
            input: input.slice(0, 120),
            output: output.slice(0, 120),
            stats: {
                localRejected: degenerateStats.localRejected,
                remoteRejected: degenerateStats.remoteRejected,
            },
        });
    }
}

function isLikelyGarbage(input: string, output: string): boolean {
    return getGarbageReason(input, output) !== null;
}

// ============================================================================
// Glossary
// ============================================================================

/** Short-text threshold: below this, apply 'prefer' entries too */
const GLOSSARY_SHORT_THRESHOLD = 30;

/** CJK character ranges (hiragana, katakana, CJK unified ideographs) */
const CJK_RE = /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]/;

/**
 * Result of a single glossary pass. Callers pick what they need:
 *   - `full`:         non-null when ALL text was resolved (no remaining CJK) — use as final translation
 *   - `preprocessed`: text with glossary substitutions — feed to model so it translates around them
 *   - `modified`:     whether any substitution was made
 *
 * One regex pass serves both "full resolution" and "model pre-processing", so hot
 * paths (translate, translateBatch) only pay the regex cost once.
 */
interface GlossaryResult {
    full: string | null;
    preprocessed: string;
    modified: boolean;
}

function processGlossary(text: string, targetLang: string): GlossaryResult {
    const tgt = normalizeTargetLang(targetLang);
    const none: GlossaryResult = { full: null, preprocessed: text, modified: false };
    if (tgt !== 'en' && tgt !== 'zh') return none;
    const field = tgt === 'en' ? 'en' : 'zh';

    const trimmed = text.trim();
    if (!trimmed) return none;

    // 1. Exact full-text match (all modes) — O(1) Map lookup
    const exact = glossaryMap.get(trimmed);
    if (exact) {
        const val = exact[field];
        return { full: val, preprocessed: val, modified: true };
    }

    // 2. Single-pass regex replacement (compiled once at import time)
    //    - Short text (≤30 chars): use prefer + always entries (more aggressive)
    //    - Long text: only always entries (onomatopoeia — MT never gets these right)
    const isShort = trimmed.length <= GLOSSARY_SHORT_THRESHOLD;
    const regex = isShort ? preferRegex : alwaysRegex;
    const lookup = (isShort ? preferReplacerMap : alwaysReplacerMap)[field];

    regex.lastIndex = 0;
    let anyReplaced = false;
    // Pad English replacements with spaces — Japanese has no word separators,
    // so adjacent glossary hits like 性処理セックス → "sexual servicesex" without this.
    const padEn = tgt === 'en';
    const replaced = trimmed.replace(regex, (match) => {
        anyReplaced = true;
        const repl = lookup.get(match) || match;
        return padEn ? ` ${repl} ` : repl;
    });

    if (!anyReplaced) return none;

    // Collapse padding spaces for English
    const cleaned = padEn ? replaced.replace(/\s{2,}/g, ' ').trim() : replaced;

    // If ALL content was replaced (no remaining CJK), it's a full translation
    const full = CJK_RE.test(cleaned) ? null : cleaned;
    return { full, preprocessed: cleaned, modified: true };
}

/** Thin wrapper for test exports: returns [preprocessedText, wasModified] for model input. */
function glossaryPreProcess(text: string, targetLang: string): [string, boolean] {
    const r = processGlossary(text, targetLang);
    return [r.preprocessed, r.modified];
}

/**
 * Split text into translatable segments for opus-mt.
 *
 * Two splitting strategies (applied in order):
 * 1. **Bracket extraction** — DLsite titles use 【】（）brackets as logical
 *    delimiters (e.g. 【tag】main title【bonus】). Each bracketed section and
 *    the text between them become separate segments. The brackets are preserved
 *    for re-wrapping after translation.
 * 2. **Sentence splitting** — Within each segment, split on 。 boundaries.
 *    MarianMT treats 。 as end-of-sequence and drops subsequent sentences.
 *
 * Returns null if text is a single segment with one sentence (no split needed).
 * Each segment carries a `wrap` string pair for reassembly.
 */
interface SplitSegment {
    text: string;
    /** [open, close] bracket pair to re-wrap after translation, or ['', ''] for bare text */
    wrap: [string, string];
}

function splitForModel(text: string): SplitSegment[] | null {
    // Phase 1: bracket extraction
    // Match 【…】 or （…） sections — capture bracket content and surrounding text
    const bracketRe = /([【（])((?:(?![【（】）]).)+)([】）])/g;
    let segments: SplitSegment[] = [];
    let lastEnd = 0;
    let match: RegExpExecArray | null;

    while ((match = bracketRe.exec(text)) !== null) {
        // Bare text before this bracket
        const before = text.slice(lastEnd, match.index).trim();
        if (before) segments.push({ text: before, wrap: ['', ''] });
        // Bracketed content
        const open = match[1];
        const content = match[2].trim();
        const close = match[3];
        if (content) segments.push({ text: content, wrap: [open, close] });
        lastEnd = match.index + match[0].length;
    }
    // Trailing text after last bracket
    const trailing = text.slice(lastEnd).trim();
    if (trailing) segments.push({ text: trailing, wrap: ['', ''] });

    // If no brackets found, treat whole text as single bare segment
    if (segments.length === 0) {
        segments = [{ text: text.trim(), wrap: ['', ''] }];
    }

    // Phase 2: sentence splitting within each segment (split on 。)
    const expanded: SplitSegment[] = [];
    for (const seg of segments) {
        const sentences = seg.text.split(/。/).filter(s => s.trim());
        if (sentences.length > 1) {
            for (const s of sentences) {
                expanded.push({ text: s.trim(), wrap: seg.wrap });
            }
        } else {
            expanded.push(seg);
        }
    }

    return expanded.length > 1 ? expanded : null;
}

/** Rejoin translated segments with their original bracket wrappers. */
function joinTranslatedSegments(segments: SplitSegment[], translations: string[]): string {
    const parts: string[] = [];
    for (let i = 0; i < segments.length; i++) {
        const [open, close] = segments[i].wrap;
        const translated = translations[i] || '';
        if (open && close) {
            parts.push(`${open}${translated}${close}`);
        } else {
            parts.push(translated);
        }
    }
    return parts.join(' ').replace(/\s{2,}/g, ' ').trim();
}

// ============================================================================
// Cache
// ============================================================================

// lang parameter must already be normalized via normalizeTargetLang()
const cacheInput = (text: string): string => `${TRANSLATION_CACHE_SCHEMA_VERSION}:${text}`;
const cacheKey = (text: string, lang: string, source: TranslationSource): string =>
    CacheKeys.translation(cacheInput(text), lang, source);

function getCached(text: string, lang: string): string | null {
    const h = hashString(cacheInput(text));
    return SharedCache.get<string>(`asmr-ult:trans:local:${lang}:${h}`)
        || SharedCache.get<string>(`asmr-ult:trans:remote:${lang}:${h}`)
        || null;
}

// ============================================================================
// Worker Pool (opus-mt models)
// ============================================================================

interface PendingRequest {
    resolve: (val: string | string[]) => void;
    reject: (err: unknown) => void;
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

// Translation is WebGPU-only (no WASM fallback). If GPU fails, webgpuFailed is set
// and all subsequent translateLocal() calls return null → falls through to Google Translate.

// GPU contention: throttle translation batches while Whisper is actively transcribing
let whisperActive = false;
EventBus.on('whisper:transcribing', ({ active }) => {
    whisperActive = !!active;
    if (!active) return;
    if (workers.length === 0) return;

    const profile = DeviceCapabilities.profile;
    const pressure = GpuScheduler.getMemoryPressure();
    const canRunParallel = profile.tier === 'full' && profile.hasGpu;

    // Desktop/full-tier GPUs can keep ja-en warm for realtime subtitle translation.
    // Under pressure, unload zh-en first and keep the primary ja-en model alive.
    if (canRunParallel) {
        if (pressure === 'low') {
            Logger.debug('[TranslationService] Whisper active: keeping local translation workers warm for parallel throughput');
            return;
        }
        if (workers.some(w => w.model === OPUS_ZH_EN)) {
            Logger.log(`[TranslationService] Whisper active: unloading zh-en worker (${pressure} pressure), keeping ja-en for realtime`);
            terminateWorker(OPUS_ZH_EN);
            return;
        }
        Logger.debug('[TranslationService] Whisper active: keeping ja-en worker for realtime translation');
        return;
    }

    // Limited devices: unload all local translation workers to protect GPU stability.
    Logger.log('[TranslationService] Whisper active: unloading local translation workers');
    terminateWorker();
});

function shouldUseLocalTranslation(options?: TranslationTaskOptions): boolean {
    if (Config.get('preferLocalTranslation') === false) return false;
    if (!whisperActive) return true;
    const priority = options?.priority ?? Priority.REALTIME;
    // Keep local translation for interactive lanes while whisper is active.
    // Background lanes fall back to remote to avoid starving whisper inference.
    return priority <= Priority.HIGH;
}

// Cross-service device loss: when any worker reports GPU device lost, terminate
// translation workers. Google Translate handles the fallback (faster than WASM).
EventBus.on('gpu:device-lost-broadcast', ({ source }) => {
    if (source === 'translation') return; // Already handled by our own error path
    if (webgpuFailed) return;
    Logger.warn(`[TranslationService] GPU device lost in ${source} worker — falling back to remote`);
    webgpuFailed = true;
    terminateWorker();
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
    return SINGLE_TIMEOUT_MS;
}

function getBatchTimeout(itemCount: number): number {
    return BATCH_TIMEOUT_BASE_MS + itemCount * BATCH_TIMEOUT_PER_ITEM_MS;
}

function terminateWorker(model?: string): void {
    const toKill = model ? workers.filter(w => w.model === model) : workers;
    for (const w of toKill) {
        w.worker.postMessage({ type: 'cleanup' });
        setTimeout(() => w.worker.terminate(), 500);
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

        if (msg.status === 'debug') {
            if (Config.get('debug')) {
                Logger.debug('[Translation Worker]', msg.message || '', msg.data || '');
            }
            return;
        }

        if (msg.status === 'initiate') {
            // Worker reports its initial backend
            entry.backend = msg.backend || 'webgpu';
            return;
        }

        if (msg.status === 'ready') {
            entry.backend = msg.backend || 'webgpu';
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
                    Logger.warn('[TranslationService] WebGPU inference failed, falling back to remote');
                    terminateWorker();
                    // Don't restart on WASM — Google Translate is faster
                }
            } else if (!resolved) {
                if (isGpuError && !webgpuFailed) {
                    webgpuFailed = true;
                    EventBus.emit('webgpu:failed', { source: 'translation' });
                    Logger.warn('[TranslationService] WebGPU init failed, falling back to remote');
                    resolved = true;
                    terminateWorker();
                    onError(new Error(err));
                    // Don't restart on WASM — Google Translate is faster
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
                GpuScheduler.onGpuSuccess('translation');
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
        // Free GPU memory AFTER acquiring the lease — this guarantees the other model
        // has finished loading (it held the lease). Freeing BEFORE the lease caused a
        // deadlock: terminating a still-loading worker orphaned its load lease forever,
        // blocking all subsequent model loads (including Whisper init).
        if (!webgpuFailed) {
            const otherModelWorkers = workers.filter(w => w.model !== model && w.pending.size === 0);
            for (const w of otherModelWorkers) {
                Logger.log(`[TranslationService] Freeing GPU: terminating ${w.model} before loading ${model}`);
                terminateWorker(w.model);
            }
        }

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

                // Send cached dtype hint (WebGPU only — skip WASM-only dtypes)
                if (rememberedDtype && !['q8', 'q4'].includes(rememberedDtype)) {
                    entry.worker.postMessage({ type: 'preferred-dtype', dtype: rememberedDtype });
                }
                entry.worker.postMessage({ type: 'debug', enabled: !!Config.get('debug') });
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
): Promise<string | string[]> {
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

async function translateLocal(
    text: string,
    targetLang: string,
    options?: TranslationTaskOptions,
): Promise<string | null> {
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

    // Single translations get REALTIME priority — they're the current subtitle/title.
    // The per-worker scheduler allows this to run concurrently with embedding/whisper
    // while still serializing within the translation worker to prevent GPU flooding.
    const raw = await GpuScheduler.enqueue({
        priority: options?.priority ?? Priority.REALTIME,
        worker: 'translation',
        execute: () => sendToWorker(entry, text, route.model, getSingleTimeout()),
        cancellable: options?.cancellable,
        cancellableKey: options?.cancellableKey,
    });
    if (!raw) return null;

    const cleaned = TranslationService.cleanQuotes(raw as string);
    const reason = getGarbageReason(text, cleaned);
    if (reason) {
        trackDegenerate('local', text, cleaned, reason);
        return null;
    }
    return cleaned;
}

async function translateLocalBatch(
    texts: string[],
    targetLang: string,
    options?: TranslationTaskOptions,
): Promise<(string | null)[]> {
    const results: (string | null)[] = new Array(texts.length).fill(null);

    // Group texts by model (each opus-mt model handles one language pair)
    interface BatchGroup { indices: number[]; texts: string[]; route: ModelRoute }
    const groups = new Map<string, BatchGroup>();
    const tgtNorm = normalizeTargetLang(targetLang);
    for (let i = 0; i < texts.length; i++) {
        const route = getModelForText(texts[i], targetLang);
        if (!route) {
            // Text is already in target language (e.g., fully glossary-resolved:
            // "催眠" → "hypnosis"). Return as-is instead of leaving null — otherwise
            // it falls through to remote and makes an unnecessary Google API call.
            const src = detectSourceLanguage(texts[i]);
            if (src === tgtNorm) {
                results[i] = texts[i];
            }
            continue;
        }
        const key = route.model;
        let g = groups.get(key);
        if (!g) { g = { indices: [], texts: [], route }; groups.set(key, g); }
        g.indices.push(i);
        g.texts.push(texts[i]);
    }

    await Promise.all(Array.from(groups.values()).map(async (group) => {
        let entry = getWorker(group.route.model);
        if (!entry) {
            // Wait longer for model init in batch context (ONNX session creation + WebGPU
            // shader compilation can take 20-30s on first load). If we timeout too early,
            // the entire batch falls through to remote, leaving GPU idle.
            const BATCH_INIT_WAIT_MS = 45_000;
            const pending = initPromises.get(group.route.model);
            if (pending) {
                try {
                    await Promise.race([pending, new Promise((_, rej) => setTimeout(() => rej(new Error('init-wait')), BATCH_INIT_WAIT_MS))]);
                    entry = getWorker(group.route.model);
                } catch { /* timed out */ }
            } else {
                try {
                    await Promise.race([initWorker(group.route.model), new Promise((_, rej) => setTimeout(() => rej(new Error('init-wait')), BATCH_INIT_WAIT_MS))]);
                    entry = getWorker(group.route.model);
                } catch { /* timed out or init failed */ }
            }
            if (!entry) return;
        }

        // Sequential chunks: each chunk awaits completion before the next is sent.
        // This naturally staggers timeouts and creates interleave points where
        // single-text REALTIME requests (live subtitle) can jump the worker queue.
        //
        // Initial ramp-up: first chunks are tiny (4→8 items, ~50-100ms each) so
        // REALTIME translate() requests aren't blocked behind a 2.5s batch chunk.
        // After the ramp-up phase, adaptive sizing takes over.
        const taskPriority = options?.priority ?? Priority.NORMAL;
        const RAMP_SIZES = [4, 8]; // first two chunks use these small sizes
        let chunkIdx = 0;

        const getChunkSize = (): number => {
            // During ramp-up, use small fixed sizes for fast interleaving
            if (chunkIdx < RAMP_SIZES.length) return RAMP_SIZES[chunkIdx];

            // If a REALTIME task is waiting, shrink to minimum to yield quickly
            if (GpuScheduler.hasRealtimeQueued('translation')) return 4;

            let size = whisperActive ? BATCH_CHUNK_SIZE_GPU_THROTTLED : BATCH_CHUNK_SIZE_GPU;
            if (adaptiveChunkSize > 0) size = whisperActive ? Math.max(4, adaptiveChunkSize >> 1) : adaptiveChunkSize;
            if (whisperActive && taskPriority <= Priority.HIGH) {
                size = Math.min(size, BATCH_CHUNK_SIZE_GPU_THROTTLED);
            }
            // Under high GPU memory pressure, halve to create more interleave points
            if (GpuScheduler.getMemoryPressure() === 'high') size = Math.max(4, size >> 1);
            return size;
        };

        for (let i = 0; i < group.texts.length;) {
            const chunkSize = getChunkSize();
            const chunkTexts = group.texts.slice(i, i + chunkSize);
            const chunkIndices = group.indices.slice(i, i + chunkSize);
            const timeoutMs = getBatchTimeout(chunkTexts.length);
            i += chunkSize;
            chunkIdx++;

            try {
                const t0 = performance.now();
                // Batch chunks get NORMAL priority — background pre-translation.
                // The per-worker scheduler serializes within the translation worker
                // (preventing GPU flooding from fast scrolling) while allowing
                // embedding/whisper to run concurrently on their own workers.
                const translated = await GpuScheduler.enqueue({
                    priority: options?.priority ?? Priority.NORMAL,
                    worker: 'translation',
                    execute: () => sendToWorker(entry, chunkTexts, group.route.model, timeoutMs),
                    cancellable: options?.cancellable ?? true,
                    cancellableKey: options?.cancellableKey,
                });
                const elapsedMs = performance.now() - t0;

                // Adapt chunk size: target ~0.25s per chunk to improve queue fairness and UI latency.
                if (chunkTexts.length >= 4 && elapsedMs > 100) {
                    const targetMs = 250;
                    const msPerItem = elapsedMs / chunkTexts.length;
                    const ideal = Math.round(targetMs / msPerItem);
                    adaptiveChunkSize = Math.max(4, Math.min(128, ideal));
                }

                if (Array.isArray(translated)) {
                    for (let j = 0; j < chunkIndices.length; j++) {
                        const raw = translated[j];
                        if (raw) {
                            const cleaned = TranslationService.cleanQuotes(raw);
                            const reason = getGarbageReason(chunkTexts[j], cleaned);
                            if (reason) {
                                trackDegenerate('local', chunkTexts[j], cleaned, reason);
                                results[chunkIndices[j]] = null;
                            } else {
                                results[chunkIndices[j]] = cleaned;
                            }
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
// Per-host timing: min interval + 429 pause are tracked per host so requests to
// different TLDs don't block each other.
const remoteLastTimeByHost = new Map<string, number>();
const remotePausedUntilByHost = new Map<string, number>();
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
    await acquireRemoteSlot();

    // Pick host, skipping any that are rate-limited
    let host = nextTranslateHost();
    const now = Date.now();
    for (let i = 0; i < GOOGLE_TRANSLATE_HOSTS.length; i++) {
        const pausedUntil = remotePausedUntilByHost.get(host) || 0;
        if (now >= pausedUntil) break;
        host = nextTranslateHost();
    }

    // Per-host minimum interval — requests to different hosts fire immediately
    const lastTime = remoteLastTimeByHost.get(host) || 0;
    const elapsed = now - lastTime;
    if (elapsed < REMOTE_MIN_INTERVAL_MS) {
        await new Promise(r => setTimeout(r, REMOTE_MIN_INTERVAL_MS - elapsed));
    }
    remoteLastTimeByHost.set(host, Date.now());

    try {
        const res = await retryWithBackoff(
            () => gmRequest({
                url: `https://${host}/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`,
            }),
            { attempts: 2, backoffMs: 250, shouldRetry: (e) => !(e instanceof HttpError) || e.status >= 500 },
        );
        const parsed = JSON.parse(res.responseText);
        return parsed?.[0]?.map((x: unknown[]) => x?.[0] || '').join('') || text;
    } catch (e) {
        if (e instanceof HttpError && e.status === 429) {
            remotePausedUntilByHost.set(host, Date.now() + REMOTE_RATE_LIMIT_PAUSE_MS);
            // Signal rate-limit to rest of system (canPrefetch, isRateLimited) only when
            // the majority of hosts are blocked — a single blocked host is not a global issue
            const blockedCount = [...remotePausedUntilByHost.values()].filter(t => Date.now() < t).length;
            if (blockedCount >= Math.ceil(GOOGLE_TRANSLATE_HOSTS.length / 2)) {
                SharedCache.set(CacheKeys.translationRateLimit(), Date.now() + REMOTE_RATE_LIMIT_PAUSE_MS, REMOTE_RATE_LIMIT_PAUSE_MS);
            }
            Logger.warn('[TranslationService] Google Translate 429 on', host, `(${blockedCount}/${GOOGLE_TRANSLATE_HOSTS.length} blocked)`);
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
        if (whisperActive) return;
        // Only load ja-en eagerly (most common). zh-en loads on demand when Chinese
        // text is detected. Loading both creates 2 GPU devices (~400-600MB) which
        // causes buffer allocation failures on GPUs with limited VRAM.
        await initWorker(OPUS_JA_EN, false);
    },

    /**
     * Force-reload translation models.
     */
    async warmupLocalModel(): Promise<void> {
        if (whisperActive) return;
        await initWorker(OPUS_JA_EN, true);
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
    async translate(text: string, targetLang = 'en', options?: TranslationTaskOptions): Promise<string> {
        if (!text) return '';
        targetLang = normalizeTargetLang(targetLang);
        resetIdleUnloadTimer();

        const cached = getCached(text, targetLang);
        if (cached) return cached;

        // In-flight dedup: reuse pending translation for same text+lang
        const laneKey = `${options?.priority ?? Priority.REALTIME}:${options?.cancellableKey || 'global'}`;
        const flightKey = `${laneKey}:${targetLang}:${text}`;
        const existing = translateInFlight.get(flightKey);
        if (existing) return existing;

        const promise = this._translateInner(text, targetLang, options);
        translateInFlight.set(flightKey, promise);
        try {
            return await promise;
        } finally {
            translateInFlight.delete(flightKey);
        }
    },

    /** @internal */
    async _translateInner(text: string, targetLang: string, options?: TranslationTaskOptions): Promise<string> {
        // 0. Multi-segment split: bracket extraction + sentence splitting.
        const segments = splitForModel(text);
        if (segments) {
            const results = await Promise.all(
                segments.map(s => this.translate(s.text, targetLang, options)),
            );
            const joined = joinTranslatedSegments(segments, results);
            SharedCache.set(cacheKey(text, targetLang, 'local'), joined, CACHE_TTL_MS);
            return joined;
        }

        // 1. Glossary — single regex pass for both exact resolution and model pre-processing
        const glossary = processGlossary(text, targetLang);
        if (glossary.full) {
            SharedCache.set(cacheKey(text, targetLang, 'local'), glossary.full, CACHE_TTL_MS);
            return glossary.full;
        }
        const { preprocessed, modified: wasModified } = glossary;

        // 3. Try local translation (with preprocessed text if glossary modified it)
        //    Normalize input: strip decorative chars (♡♪〜) and convert 「」→"" that confuse opus-mt
        if (shouldUseLocalTranslation(options)) {
            try {
                const localInput = normalizeForModel(wasModified ? preprocessed : text);
                const result = await translateLocal(localInput, targetLang, options);
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
            const reason = getGarbageReason(text, cleaned);
            if (reason) {
                trackDegenerate('remote', text, cleaned, reason);
                return text;
            }
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
    async translateBatch(texts: string[], targetLang = 'en', options?: TranslationTaskOptions): Promise<string[]> {
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

        // 1b. Fill from glossary — single regex pass per text, cache for reuse in preprocess step
        const glossaryCache = new Map<string, GlossaryResult>();
        const stillUncached: typeof uncached = [];
        for (const entry of uncached) {
            const glossary = processGlossary(entry.text, targetLang);
            glossaryCache.set(entry.text, glossary);
            if (glossary.full) {
                const indices = seen.get(entry.text) || [];
                for (const idx of indices) results[idx] = glossary.full;
                SharedCache.set(cacheKey(entry.text, targetLang, 'local'), glossary.full, CACHE_TTL_MS);
            } else {
                stillUncached.push(entry);
            }
        }

        if (stillUncached.length === 0) return results;

        // 1c. Expand multi-segment texts (bracket/sentence splits) into the batch.
        //     Instead of routing to individual translate() calls (slow: per-call overhead),
        //     we split them here, add each segment to the batch, then rejoin after translation.
        interface SplitRecord { originalText: string; segments: SplitSegment[] }
        const splitRecords: SplitRecord[] = [];
        const flatBatch: { originalText: string; text: string; segIdx: number; splitIdx: number }[] = [];
        const singleSentence: typeof uncached = [];

        for (const entry of stillUncached) {
            const segments = splitForModel(entry.text);
            if (!segments) {
                singleSentence.push(entry);
                continue;
            }
            const splitIdx = splitRecords.length;
            splitRecords.push({ originalText: entry.text, segments });
            for (let s = 0; s < segments.length; s++) {
                flatBatch.push({ originalText: entry.text, text: segments[s].text, segIdx: s, splitIdx });
            }
        }

        // Merge split segments + single-sentence texts into one flat batch for the model
        const allBatchItems = [
            ...singleSentence.map(u => ({ text: u.text, isSplit: false as const, originalText: u.text })),
            ...flatBatch.map(fb => ({ text: fb.text, isSplit: true as const, originalText: fb.originalText, segIdx: fb.segIdx, splitIdx: fb.splitIdx })),
        ];

        if (allBatchItems.length === 0) return results;

        // Pre-process all batch items with glossary substitution + model normalization.
        // Reuse glossary results from step 1b to avoid a second regex pass on the same texts.
        const preprocessedMap = new Map<string, string>();
        const preprocessedTexts = allBatchItems.map(u => {
            if (preprocessedMap.has(u.text)) return preprocessedMap.get(u.text)!;
            const glossary = glossaryCache.get(u.text) ?? processGlossary(u.text, targetLang);
            const normalized = normalizeForModel(glossary.preprocessed);
            preprocessedMap.set(u.text, normalized);
            return normalized;
        });
        // Collect per-item translations (indexed by allBatchItems position)
        const batchTranslations: (string | null)[] = new Array(allBatchItems.length).fill(null);

        // Pre-route: classify items by whether a local model exists for them.
        // This lets us start remote-only items (e.g. Chinese) immediately instead of
        // waiting for local GPU inference (Japanese) to finish.
        const localRoutable: number[] = [];
        const remoteOnly: number[] = [];
        const useLocal = shouldUseLocalTranslation(options);
        for (let i = 0; i < allBatchItems.length; i++) {
            if (useLocal && getModelForText(allBatchItems[i].text, targetLang)) {
                localRoutable.push(i);
            } else {
                remoteOnly.push(i);
            }
        }

        // Fire remote-only items immediately (semaphore handles concurrency — no chunking needed)
        const remoteOnlyPromise = remoteOnly.length > 0
            ? this._translateRemoteIndices(allBatchItems, remoteOnly, preprocessedMap, targetLang, batchTranslations)
            : Promise.resolve();

        // Run local batch concurrently for items that have a model route
        let localFailures: number[] = [];
        if (localRoutable.length > 0) {
            try {
                const localResults = await translateLocalBatch(preprocessedTexts, targetLang, options);
                for (const i of localRoutable) {
                    if (localResults[i]) {
                        batchTranslations[i] = localResults[i];
                    } else {
                        localFailures.push(i);
                    }
                }
            } catch (e) {
                Logger.debug('[TranslationService] Local batch failed:', e);
                localFailures = [...localRoutable];
            }
        }

        // Send local failures to remote as fallback
        const localFallbackPromise = localFailures.length > 0
            ? this._translateRemoteIndices(allBatchItems, localFailures, preprocessedMap, targetLang, batchTranslations)
            : Promise.resolve();

        // Wait for all remote translations (initial + fallback)
        await Promise.all([remoteOnlyPromise, localFallbackPromise]);

        // 4. Collect results: single items go directly, split items are rejoined
        // 4a. Single-sentence items (no split)
        const singleCount = singleSentence.length;
        for (let i = 0; i < singleCount; i++) {
            const translated = batchTranslations[i];
            if (translated) {
                const original = singleSentence[i].text;
                const indices = seen.get(original) || [];
                for (const idx of indices) results[idx] = translated;
                SharedCache.set(cacheKey(original, targetLang, 'local'), translated, CACHE_TTL_MS);
            }
        }

        // 4b. Split items: cache individual segments AND rejoin per original text.
        //     Segment caching prevents re-translation when translate() is later called
        //     for the same title (it splits → translate(segment) → would miss cache).
        for (const record of splitRecords) {
            const segTranslations: string[] = record.segments.map(() => '');
            let allResolved = true;
            // Find this record's segment translations in the flat batch
            for (let i = singleCount; i < allBatchItems.length; i++) {
                const item = allBatchItems[i];
                if (item.isSplit && item.originalText === record.originalText) {
                    const t = batchTranslations[i];
                    if (t) {
                        segTranslations[item.segIdx] = t;
                        // Cache segment individually so translate(segmentText) hits cache
                        SharedCache.set(cacheKey(item.text, targetLang, 'local'), t, CACHE_TTL_MS);
                    } else {
                        allResolved = false;
                    }
                }
            }
            if (allResolved) {
                const joined = joinTranslatedSegments(record.segments, segTranslations);
                const indices = seen.get(record.originalText) || [];
                for (const idx of indices) results[idx] = joined;
                SharedCache.set(cacheKey(record.originalText, targetLang, 'local'), joined, CACHE_TTL_MS);
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

    /**
     * Cancel queued local translation tasks.
     * If `cancellableKey` is provided, only matching tasks are dropped.
     */
    cancelPendingLocal(options?: { cancellableKey?: string }): number {
        return GpuScheduler.clearCancellable('translation', options?.cancellableKey);
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

    getDebugStats(): { degenerateLocalRejected: number; degenerateRemoteRejected: number } {
        return {
            degenerateLocalRejected: degenerateStats.localRejected,
            degenerateRemoteRejected: degenerateStats.remoteRejected,
        };
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
    },

    /** @internal Fire remote translations for a set of batch indices concurrently (no chunking). */
    async _translateRemoteIndices(
        allBatchItems: { text: string }[],
        indices: number[],
        preprocessedMap: Map<string, string>,
        targetLang: string,
        batchTranslations: (string | null)[],
    ): Promise<void> {
        Logger.debug('[TranslationService] Remote concurrent:', indices.length, 'texts');
        await Promise.allSettled(indices.map(async (batchIdx) => {
            const item = allBatchItems[batchIdx];
            const preprocessed = preprocessedMap.get(item.text) || item.text;
            let translated: string;
            try {
                translated = await translateRemoteSingle(preprocessed, targetLang);
            } catch {
                translated = item.text;
            }
            const cleaned = this.cleanQuotes(translated);
            const reason = getGarbageReason(item.text, cleaned);
            if (reason) {
                trackDegenerate('remote', item.text, cleaned, reason);
                batchTranslations[batchIdx] = item.text;
            } else {
                batchTranslations[batchIdx] = cleaned;
            }
        }));
    },
};

// Exported for unit testing — not part of the public API
export const _testExports = { normalizeForModel, splitForModel, joinTranslatedSegments, isLikelyGarbage, glossaryPreProcess };
