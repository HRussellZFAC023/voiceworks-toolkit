import { GM_listValues, GM_deleteValue } from '$';
import { CacheKeys, SharedCache, hashString } from '../core/Cache';
import { gmRequest, retryWithBackoff, HttpError } from '../infrastructure/HttpClient';
import { I18n, Config } from '../core/Config';
import { Logger } from '../core/Utils';
import {
    glossaryMap,
    alwaysRegex,
    alwaysReplacerMap,
    preferRegex,
    preferReplacerMap,
} from '../data/nsfw-glossary';

// ============================================================================
// Types
// ============================================================================

export interface TranslationTaskOptions {
    // Kept for compatibility with existing call sites that pass scheduler priorities.
    priority?: number;
    cancellable?: boolean;
    cancellableKey?: string;
}

interface GlossaryResult {
    full: string | null;
    preprocessed: string;
    modified: boolean;
}

interface SplitSegment {
    text: string;
    wrap: [string, string];
}

interface DegenerateSampleLog {
    remoteRejected: number;
    lastLogAt: number;
}

// ============================================================================
// Constants
// ============================================================================

const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const TRANSLATION_CACHE_SCHEMA_VERSION = 'v3';
const PREFETCH_MAX_LINES = 1000;

const REMOTE_CONCURRENCY = 36;
const REMOTE_MIN_INTERVAL_MS = 10;
const REMOTE_RATE_LIMIT_PAUSE_MS = 15_000;

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

let translateHostIndex = 0;
function nextTranslateHost(): string {
    const host = GOOGLE_TRANSLATE_HOSTS[translateHostIndex % GOOGLE_TRANSLATE_HOSTS.length];
    translateHostIndex++;
    return host;
}

const quoteMap: Record<string, string> = {
    '``': '"',
    "''": '"',
    '\u00AB': '"',
    '\u00BB': '"',
    '\u201E': '"',
    '\u201C': '"',
    '\u201D': '"',
    '\u301D': '"',
    '\u301E': '"',
    '\u301F': '"',
    '\u2033': '"',
    '\u2018': "'",
    '\u2019': "'",
    '\u201A': "'",
    '\u2039': "'",
    '\u203A': "'",
    '\u2032': "'",
    '\u300C': '"',
    '\u300D': '"',
    '\u300E': '"',
    '\u300F': '"',
    '\uFF01': '!',
    '\uFF1F': '?',
    '\uFF1A': ':',
    '\uFF1B': ';',
    '\uFF0C': ',',
};

const quoteRegex = new RegExp(
    Object.keys(quoteMap).map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
    'g',
);

// Keep this preprocessing behavior to preserve translation quality for noisy metadata.
const modelNormQuoteOpen = /[「『]/g;
const modelNormQuoteClose = /[」』]/g;
const modelNormWaveDash = /[〜～]/g;
const modelNormEllipsis = /…/g;
const modelNormMultiply = /[×✕✖・]/g;
const modelNormDecorative = /[♡♥♪♫★☆✨💕🌙❤️✿❀⭐🎵🎶💖💗💓💘🔥💞💙💛🤍🖤🩷🩵]/g;
const modelNormSpaces = /\s{2,}/g;

function normalizeForModel(text: string): string {
    return text
        .replace(modelNormQuoteOpen, '"')
        .replace(modelNormQuoteClose, '"')
        .replace(modelNormWaveDash, '')
        .replace(modelNormEllipsis, '...')
        .replace(modelNormMultiply, ', ')
        .replace(modelNormDecorative, '')
        .replace(modelNormSpaces, ' ')
        .trim();
}

// ============================================================================
// Language + quality helpers
// ============================================================================

function normalizeTargetLang(lang: string): string {
    const base = lang.toLowerCase().split('-')[0];
    if (base === 'jp') return 'ja';
    if (base === 'cn') return 'zh';
    return base;
}

function detectSourceLanguage(text: string): 'ja' | 'zh' | 'en' {
    const hasKana = /[\u3040-\u309f\u30a0-\u30ff]/.test(text);
    const hasCJK = /[\u4e00-\u9fff]/.test(text);
    if (hasKana) return 'ja';
    if (hasCJK) return 'zh';
    if (/[a-zA-Z]/.test(text)) return 'en';
    return 'ja';
}

const hallucinationFirstPerson = /^I['\u2019]?m\s|^I\s(don|can|won|didn|couldn|wouldn|shouldn)['\u2019]t\s|^I\s(have|want|need|think|know|like)\s/i;
const firstPersonJa = /私|僕|俺|わたし|ぼく|おれ|あたし/;

const degenerateStats: DegenerateSampleLog = {
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

    if (!firstPersonJa.test(input) && hallucinationFirstPerson.test(trimmed)) {
        return 'first-person-hallucination';
    }

    return null;
}

function trackDegenerate(input: string, output: string, reason: string): void {
    degenerateStats.remoteRejected++;

    if (!Config.get('debug')) return;
    const now = Date.now();
    if (now - degenerateStats.lastLogAt > 1500) {
        degenerateStats.lastLogAt = now;
        Logger.debug('[TranslationService] Rejected degenerate output', {
            source: 'remote',
            reason,
            input: input.slice(0, 120),
            output: output.slice(0, 120),
            stats: { remoteRejected: degenerateStats.remoteRejected },
        });
    }
}

function isLikelyGarbage(input: string, output: string): boolean {
    return getGarbageReason(input, output) !== null;
}

// ============================================================================
// Glossary + segmentation helpers
// ============================================================================

const GLOSSARY_SHORT_THRESHOLD = 30;
const CJK_RE = /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]/;

function processGlossary(text: string, targetLang: string): GlossaryResult {
    const tgt = normalizeTargetLang(targetLang);
    const none: GlossaryResult = { full: null, preprocessed: text, modified: false };
    if (tgt !== 'en' && tgt !== 'zh') return none;
    const field = tgt === 'en' ? 'en' : 'zh';

    const trimmed = text.trim();
    if (!trimmed) return none;

    const exact = glossaryMap.get(trimmed);
    if (exact) {
        const val = exact[field];
        return { full: val, preprocessed: val, modified: true };
    }

    const isShort = trimmed.length <= GLOSSARY_SHORT_THRESHOLD;
    const regex = isShort ? preferRegex : alwaysRegex;
    const lookup = (isShort ? preferReplacerMap : alwaysReplacerMap)[field];

    regex.lastIndex = 0;
    let anyReplaced = false;
    const padEn = tgt === 'en';
    const replaced = trimmed.replace(regex, (match) => {
        anyReplaced = true;
        const repl = lookup.get(match) || match;
        return padEn ? ` ${repl} ` : repl;
    });

    if (!anyReplaced) return none;

    const cleaned = padEn ? replaced.replace(/\s{2,}/g, ' ').trim() : replaced;
    const full = CJK_RE.test(cleaned) ? null : cleaned;
    return { full, preprocessed: cleaned, modified: true };
}

function glossaryPreProcess(text: string, targetLang: string): [string, boolean] {
    const r = processGlossary(text, targetLang);
    return [r.preprocessed, r.modified];
}

function splitForModel(text: string): SplitSegment[] | null {
    const bracketRe = /([【（])((?:(?![【（】）]).)+)([】）])/g;
    let segments: SplitSegment[] = [];
    let lastEnd = 0;
    let match: RegExpExecArray | null;

    while ((match = bracketRe.exec(text)) !== null) {
        const before = text.slice(lastEnd, match.index).trim();
        if (before) segments.push({ text: before, wrap: ['', ''] });

        const open = match[1];
        const content = match[2].trim();
        const close = match[3];
        if (content) segments.push({ text: content, wrap: [open, close] });

        lastEnd = match.index + match[0].length;
    }

    const trailing = text.slice(lastEnd).trim();
    if (trailing) segments.push({ text: trailing, wrap: ['', ''] });

    if (segments.length === 0) {
        segments = [{ text: text.trim(), wrap: ['', ''] }];
    }

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
// Cache helpers
// ============================================================================

const cacheInput = (text: string): string => `${TRANSLATION_CACHE_SCHEMA_VERSION}:${text}`;
const cacheKey = (text: string, lang: string): string =>
    CacheKeys.translation(cacheInput(text), lang, 'remote');

function getCached(text: string, lang: string): string | null {
    const key = cacheKey(text, lang);
    const remote = SharedCache.get<string>(key);
    if (remote) return remote;

    // Legacy key fallback for older auto-source caches.
    return SharedCache.get<string>(CacheKeys.translation(cacheInput(text), lang, 'auto')) || null;
}

// ============================================================================
// Cancellable queue-key bookkeeping
// ============================================================================

const queueVersions = new Map<string, number>();
const queueInFlightCounts = new Map<string, number>();

function getQueueVersion(key: string): number {
    return queueVersions.get(key) || 0;
}

function bumpQueueVersion(key: string): void {
    queueVersions.set(key, getQueueVersion(key) + 1);
}

function registerQueueInFlight(key: string): () => void {
    const next = (queueInFlightCounts.get(key) || 0) + 1;
    queueInFlightCounts.set(key, next);
    return () => {
        const current = queueInFlightCounts.get(key) || 0;
        if (current <= 1) {
            queueInFlightCounts.delete(key);
        } else {
            queueInFlightCounts.set(key, current - 1);
        }
    };
}

function shouldRespectCancellation(options?: TranslationTaskOptions): boolean {
    return !!(options?.cancellable && options?.cancellableKey);
}

function isQueueCancelled(options: TranslationTaskOptions | undefined, startedVersion: number): boolean {
    if (!shouldRespectCancellation(options)) return false;
    return getQueueVersion(options!.cancellableKey!) !== startedVersion;
}

function throwIfQueueCancelled(options: TranslationTaskOptions | undefined, startedVersion: number): void {
    if (isQueueCancelled(options, startedVersion)) {
        throw new Error('Translation task cancelled');
    }
}

// ============================================================================
// Remote translator state
// ============================================================================

let remoteActive = 0;
const remoteLastTimeByHost = new Map<string, number>();
const remotePausedUntilByHost = new Map<string, number>();
const remoteWaiters: Array<() => void> = [];

const translateInFlight = new Map<string, Promise<string>>();

function acquireRemoteSlot(): Promise<void> {
    if (remoteActive < REMOTE_CONCURRENCY) {
        remoteActive++;
        return Promise.resolve();
    }

    return new Promise<void>(resolve => {
        remoteWaiters.push(() => {
            remoteActive++;
            resolve();
        });
    });
}

function releaseRemoteSlot(): void {
    remoteActive--;
    const next = remoteWaiters.shift();
    if (next) next();
}

async function translateRemoteSingle(text: string, targetLang: string): Promise<string> {
    await acquireRemoteSlot();

    let host = nextTranslateHost();
    const now = Date.now();
    for (let i = 0; i < GOOGLE_TRANSLATE_HOSTS.length; i++) {
        const pausedUntil = remotePausedUntilByHost.get(host) || 0;
        if (now >= pausedUntil) break;
        host = nextTranslateHost();
    }

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
            {
                attempts: 2,
                backoffMs: 250,
                shouldRetry: (e) => !(e instanceof HttpError) || e.status >= 500,
            },
        );

        const parsed = JSON.parse(res.responseText);
        return parsed?.[0]?.map((x: unknown[]) => x?.[0] || '').join('') || text;
    } catch (e) {
        if (e instanceof HttpError && e.status === 429) {
            remotePausedUntilByHost.set(host, Date.now() + REMOTE_RATE_LIMIT_PAUSE_MS);
            const blockedCount = [...remotePausedUntilByHost.values()].filter(t => Date.now() < t).length;
            if (blockedCount >= Math.ceil(GOOGLE_TRANSLATE_HOSTS.length / 2)) {
                SharedCache.set(
                    CacheKeys.translationRateLimit(),
                    Date.now() + REMOTE_RATE_LIMIT_PAUSE_MS,
                    REMOTE_RATE_LIMIT_PAUSE_MS,
                );
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

    isUserLang(text: string): boolean {
        const lang = I18n.lang;
        if (lang === 'ja' && /[ぁ-ヿ一-龯]/.test(text)) return true;
        if (lang === 'zh' && /[一-龯]/.test(text) && !/[ぁ-ヿ]/.test(text)) return true;
        return false;
    },

    async translate(text: string, targetLang = 'en', options?: TranslationTaskOptions): Promise<string> {
        if (!text) return '';

        targetLang = normalizeTargetLang(targetLang);
        const startedVersion = shouldRespectCancellation(options)
            ? getQueueVersion(options!.cancellableKey!)
            : 0;

        const unregisterQueue = shouldRespectCancellation(options)
            ? registerQueueInFlight(options!.cancellableKey!)
            : null;

        try {
            throwIfQueueCancelled(options, startedVersion);

            const cached = getCached(text, targetLang);
            if (cached) return cached;

            const laneKey = `${options?.priority ?? 0}:${options?.cancellableKey || 'global'}`;
            const flightKey = `${laneKey}:${targetLang}:${text}`;
            const existing = translateInFlight.get(flightKey);
            if (existing) return existing;

            const promise = this._translateInner(text, targetLang, options, startedVersion);
            translateInFlight.set(flightKey, promise);
            try {
                return await promise;
            } finally {
                translateInFlight.delete(flightKey);
            }
        } finally {
            unregisterQueue?.();
        }
    },

    async _translateInner(
        text: string,
        targetLang: string,
        options: TranslationTaskOptions | undefined,
        startedVersion: number,
    ): Promise<string> {
        throwIfQueueCancelled(options, startedVersion);

        const segments = splitForModel(text);
        if (segments) {
            const results = await Promise.all(
                segments.map(s => this.translate(s.text, targetLang, options)),
            );
            const joined = joinTranslatedSegments(segments, results);
            SharedCache.set(cacheKey(text, targetLang), joined, CACHE_TTL_MS);
            return joined;
        }

        const glossary = processGlossary(text, targetLang);
        if (glossary.full) {
            SharedCache.set(cacheKey(text, targetLang), glossary.full, CACHE_TTL_MS);
            return glossary.full;
        }

        const input = normalizeForModel(glossary.preprocessed);
        const translated = await translateRemoteSingle(input, targetLang);

        throwIfQueueCancelled(options, startedVersion);

        const cleaned = this.cleanQuotes(translated);
        const reason = getGarbageReason(text, cleaned);
        if (reason) {
            trackDegenerate(text, cleaned, reason);
            return text;
        }

        if (cleaned && cleaned !== text) {
            SharedCache.set(cacheKey(text, targetLang), cleaned, CACHE_TTL_MS);
        }

        return cleaned || text;
    },

    async translateBatch(texts: string[], targetLang = 'en', options?: TranslationTaskOptions): Promise<string[]> {
        if (texts.length === 0) return [];

        targetLang = normalizeTargetLang(targetLang);
        const startedVersion = shouldRespectCancellation(options)
            ? getQueueVersion(options!.cancellableKey!)
            : 0;

        throwIfQueueCancelled(options, startedVersion);

        const results = new Array(texts.length).fill('');
        const seen = new Map<string, number[]>();
        const uniqueUncached: string[] = [];

        for (let i = 0; i < texts.length; i++) {
            const text = texts[i]?.trim();
            if (!text) continue;

            const cached = getCached(text, targetLang);
            if (cached) {
                results[i] = cached;
                continue;
            }

            const indices = seen.get(text);
            if (indices) {
                indices.push(i);
            } else {
                seen.set(text, [i]);
                uniqueUncached.push(text);
            }
        }

        if (uniqueUncached.length === 0) return results;

        const translatedByText = new Map<string, string>();
        const workerCount = Math.min(REMOTE_CONCURRENCY, uniqueUncached.length);
        let nextIndex = 0;

        const run = async () => {
            while (true) {
                const idx = nextIndex++;
                if (idx >= uniqueUncached.length) return;

                throwIfQueueCancelled(options, startedVersion);

                const text = uniqueUncached[idx];
                let translated = text;
                try {
                    translated = await this.translate(text, targetLang, options);
                } catch (err) {
                    if (String((err as Error)?.message || '').includes('cancelled')) {
                        throw err;
                    }
                    translated = text;
                }

                translatedByText.set(text, translated);
            }
        };

        await Promise.all(Array.from({ length: workerCount }, () => run()));
        throwIfQueueCancelled(options, startedVersion);

        for (const [text, indices] of seen.entries()) {
            const translated = translatedByText.get(text) || text;
            for (const idx of indices) {
                results[idx] = translated;
            }
        }

        return results;
    },

    canPrefetch(count: number): boolean {
        if (count > PREFETCH_MAX_LINES) return false;
        const rateLimitUntil = SharedCache.get<number>(CacheKeys.translationRateLimit()) || 0;
        return Date.now() >= rateLimitUntil;
    },

    isRateLimited(): boolean {
        const rateLimitUntil = SharedCache.get<number>(CacheKeys.translationRateLimit()) || 0;
        return Date.now() < rateLimitUntil;
    },

    cancelPending(options?: { cancellableKey?: string }): number {
        if (options?.cancellableKey) {
            const key = options.cancellableKey;
            const count = queueInFlightCounts.get(key) || 0;
            bumpQueueVersion(key);
            return count;
        }

        let total = 0;
        for (const [key, count] of queueInFlightCounts.entries()) {
            total += count;
            bumpQueueVersion(key);
        }
        return total;
    },

    getDebugStats(): { degenerateRemoteRejected: number } {
        return {
            degenerateRemoteRejected: degenerateStats.remoteRejected,
        };
    },

    peekCached(text: string, targetLang = 'en'): string | null {
        if (!text) return null;
        return getCached(text, normalizeTargetLang(targetLang));
    },

    async autoTranslate(text: string, targetLang = 'en'): Promise<string> {
        if (!text || !/[ぁ-ヿ一-龯]/.test(text)) return text;
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
                if (k && (
                    k.startsWith('asmr-ult:trans:')
                    || k.startsWith('asmr-ult:tag:')
                    || k.startsWith('asmr-ult:player:')
                )) {
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
        let s = text.replace(quoteRegex, m => quoteMap[m] || m);
        s = s.replace(/"\s+([^"]+)\s+"/g, '"$1"');
        s = s.replace(/'\s+([^']+)\s+'/g, "'$1'");
        return s.trim();
    },
};

export const _testExports = {
    normalizeForModel,
    splitForModel,
    joinTranslatedSegments,
    isLikelyGarbage,
    glossaryPreProcess,
};
