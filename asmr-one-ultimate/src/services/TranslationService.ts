import { GM_listValues, GM_deleteValue } from '$';
import { CacheKeys, SharedCache, hashString } from '../core/Cache';
import { gmRequest, retryWithBackoff, HttpError } from '../infrastructure/HttpClient';
import { I18n, Config } from '../core/Config';
import { Logger } from '../core/Utils';
import { CACHE_TTL } from '../core/Constants';
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

interface TranslationTaskOptions {
    // Kept for compatibility with existing call sites that pass scheduler priorities.
    priority?: number;
    // Queued remote work with the same key can be cancelled before execution.
    cancellable?: boolean;
    cancellableKey?: string;
    /** Optional source context for ambiguous Han-only text. */
    sourceLanguageHint?: 'ja' | 'zh' | 'en' | 'auto';
    /** Keep an explicitly requested UI lane target instead of applying CN→JA preference. */
    preserveRequestedTarget?: boolean;
}

interface GlossaryResult {
    full: string | null;
    preprocessed: string;
    modified: boolean;
}

interface DegenerateSampleLog {
    remoteRejected: number;
    lastLogAt: number;
}

// ============================================================================
// Constants
// ============================================================================

const CACHE_TTL_MS = CACHE_TTL.THIRTY_DAYS_MS;
const NOOP_CACHE_TTL_MS = 60_000;
const TRANSLATION_CACHE_SCHEMA_VERSION = 'v5';
const PREFETCH_MAX_LINES = 1000;

const REMOTE_CONCURRENCY = 8;
const CUSTOM_REMOTE_CONCURRENCY = 2;
const REMOTE_MIN_INTERVAL_MS = 60;
const REMOTE_RATE_LIMIT_PAUSE_MS = 15_000;

const GOOGLE_TRANSLATE_HOSTS = [
    'translate.googleapis.com',
    'translate.google.com',
    'translate.google.co.jp',
];

let translateHostIndex = 0;
function nextTranslateHost(): string {
    const host = GOOGLE_TRANSLATE_HOSTS[translateHostIndex % GOOGLE_TRANSLATE_HOSTS.length];
    translateHostIndex++;
    return host;
}

interface CustomTranslationConfig {
    endpoint: string;
    apiKey: string;
    model: string;
}

interface RemoteTranslationResult {
    text: string;
    source: 'custom' | 'google';
    customConfigured: boolean;
}

interface TranslationProviderSnapshot {
    id: string;
    custom: CustomTranslationConfig | null;
}

function readStringConfig(key: 'translationApiEndpoint' | 'translationApiKey' | 'translationApiModel'): string {
    const value = Config.get(key);
    return typeof value === 'string' ? value.trim() : '';
}

function getCustomTranslationConfig(): CustomTranslationConfig | null {
    const endpoint = readStringConfig('translationApiEndpoint');
    if (!endpoint) return null;
    try {
        const parsed = new URL(endpoint);
        const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
        const loopback = hostname === 'localhost'
            || hostname === '127.0.0.1'
            || hostname === '::1'
            || hostname.endsWith('.localhost');
        if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) return null;
    } catch {
        return null;
    }
    return {
        endpoint,
        apiKey: readStringConfig('translationApiKey'),
        model: readStringConfig('translationApiModel') || 'gpt-4o-mini',
    };
}

function getTranslationProviderSnapshot(): TranslationProviderSnapshot {
    const custom = getCustomTranslationConfig();
    return {
        id: custom ? `custom-${hashString(`${custom.endpoint}\u0000${custom.model}`)}` : 'google',
        custom,
    };
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

function isLikelyUntranslated(
    input: string,
    output: string,
    targetLang: string,
    sourceLanguageHint?: TranslationTaskOptions['sourceLanguageHint'],
): boolean {
    const sourceLang = sourceLanguageHint && sourceLanguageHint !== 'auto'
        ? sourceLanguageHint
        : detectSourceLanguage(input);
    const target = normalizeTargetLang(targetLang);
    if (sourceLang === target) return false;
    const normalize = (value: string) => value.normalize('NFKC').replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase();
    const normalizedInput = normalize(input);
    const normalizedOutput = normalize(output);
    if (normalizedInput === normalizedOutput) return true;

    // Some providers return "source + translation" or a mostly-untranslated
    // Japanese line. The UI already shows the source separately, so retaining
    // the complete source is both redundant and a strong echo signal.
    if (normalizedInput.length >= 4 && normalizedOutput.includes(normalizedInput)) return true;

    if (target === 'en' && (sourceLang === 'ja' || sourceLang === 'zh')) {
        const cjkCount = (output.match(/[\u3040-\u30ff\u4e00-\u9fff]/g) || []).length;
        const latinCount = (output.match(/[a-z]/gi) || []).length;
        if (cjkCount >= 4 && cjkCount > latinCount) return true;
    }

    if (target === 'zh' && sourceLang === 'ja') {
        const kanaCount = (output.match(/[\u3040-\u30ff]/g) || []).length;
        const hanCount = (output.match(/[\u4e00-\u9fff]/g) || []).length;
        if (kanaCount >= 4 && kanaCount * 2 >= Math.max(1, hanCount)) return true;
    }

    return false;
}

function shouldPreferJapaneseForChinese(
    text: string,
    targetLang: string,
    sourceLanguageHint?: TranslationTaskOptions['sourceLanguageHint'],
): boolean {
    if (Config.get('translateCnToJp') !== true) return false;
    const target = normalizeTargetLang(targetLang);
    if (target === 'ja') return false;
    const sourceLang = sourceLanguageHint && sourceLanguageHint !== 'auto'
        ? sourceLanguageHint
        : detectSourceLanguage(text);
    return sourceLang === 'zh';
}

function resolveEffectiveTargetLang(
    text: string,
    requestedTargetLang: string,
    sourceLanguageHint?: TranslationTaskOptions['sourceLanguageHint'],
    preserveRequestedTarget = false,
): string {
    const normalized = normalizeTargetLang(requestedTargetLang);
    if (preserveRequestedTarget) return normalized;
    return shouldPreferJapaneseForChinese(text, normalized, sourceLanguageHint) ? 'ja' : normalized;
}

const hallucinationFirstPerson = /^I['\u2019]?m\s|^I\s(don|can|won|didn|couldn|wouldn|shouldn)['\u2019]t\s|^I\s(have|want|need|think|know|like)\s/i;
const firstPersonCjk = /私|僕|俺|自分|わたし|ぼく|おれ|あたし|じぶん|我|我们|本人|咱|咱们/;

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

    // Only flag first-person hallucination for short inputs.  Japanese zero-pronoun
    // (主語省略) is extremely common — long sentences routinely omit 私/僕 yet validly
    // translate to "I …".  Short fragments are more likely to be actual hallucinations.
    if (input.length < 50 && !firstPersonCjk.test(input) && hallucinationFirstPerson.test(trimmed)) {
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


// ============================================================================
// Cache helpers
// ============================================================================

const sourceContext = (hint?: TranslationTaskOptions['sourceLanguageHint']): string =>
    hint && hint !== 'auto' ? hint : 'auto';
const cacheInput = (
    text: string,
    providerId: string,
    sourceLanguageHint?: TranslationTaskOptions['sourceLanguageHint'],
): string => `${TRANSLATION_CACHE_SCHEMA_VERSION}:${sourceContext(sourceLanguageHint)}:${providerId}:${text}`;
const cacheKey = (
    text: string,
    lang: string,
    providerId: string,
    sourceLanguageHint?: TranslationTaskOptions['sourceLanguageHint'],
): string => CacheKeys.translation(cacheInput(text, providerId, sourceLanguageHint), lang, 'remote');
const noopCacheKey = (
    text: string,
    lang: string,
    providerId: string,
    sourceLanguageHint?: TranslationTaskOptions['sourceLanguageHint'],
): string => `${cacheKey(text, lang, providerId, sourceLanguageHint)}:noop`;

function getCached(
    text: string,
    lang: string,
    providerId = getTranslationProviderSnapshot().id,
    sourceLanguageHint?: TranslationTaskOptions['sourceLanguageHint'],
): string | null {
    const key = cacheKey(text, lang, providerId, sourceLanguageHint);
    const remote = SharedCache.get<string>(key);
    if (remote) return remote;
    const noop = SharedCache.getMemory<string>(noopCacheKey(text, lang, providerId, sourceLanguageHint));
    if (noop) return noop;

    // Legacy key fallback for older auto-source caches.
    return SharedCache.get<string>(CacheKeys.translation(cacheInput(text, providerId, sourceLanguageHint), lang, 'auto')) || null;
}

// ============================================================================
// Remote translator state
// ============================================================================

interface RemotePool {
    active: number;
    limit: number;
    waiters: RemoteWaiter[];
}

interface RemoteWaiter {
    priority: number;
    sequence: number;
    cancellableKey?: string;
    resolve: () => void;
    reject: (reason: unknown) => void;
}

class TranslationCancelledError extends Error {
    constructor() {
        super('Translation task cancelled before network execution');
        this.name = 'TranslationCancelledError';
    }
}

const googleRemotePool: RemotePool = { active: 0, limit: REMOTE_CONCURRENCY, waiters: [] };
const customRemotePool: RemotePool = { active: 0, limit: CUSTOM_REMOTE_CONCURRENCY, waiters: [] };
const remoteLastTimeByHost = new Map<string, number>();
const remotePausedUntilByHost = new Map<string, number>();

const translateInFlight = new Map<string, Promise<string>>();
let remoteWaiterSequence = 0;

function resetRemoteStateForTests(): void {
    translateHostIndex = 0;
    googleRemotePool.active = 0;
    googleRemotePool.waiters = [];
    customRemotePool.active = 0;
    customRemotePool.waiters = [];
    remoteLastTimeByHost.clear();
    remotePausedUntilByHost.clear();
    translateInFlight.clear();
    remoteWaiterSequence = 0;
}

function acquireRemoteSlot(pool: RemotePool, options?: TranslationTaskOptions): Promise<void> {
    if (pool.active < pool.limit) {
        pool.active++;
        return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
        pool.waiters.push({
            priority: options?.priority ?? 0,
            sequence: remoteWaiterSequence++,
            cancellableKey: options?.cancellable ? options.cancellableKey : undefined,
            resolve: () => {
                pool.active++;
                resolve();
            },
            reject,
        });
        pool.waiters.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
    });
}

function releaseRemoteSlot(pool: RemotePool): void {
    pool.active = Math.max(0, pool.active - 1);
    const next = pool.waiters.shift();
    if (next) next.resolve();
}

function cancelRemoteWaiters(pool: RemotePool, cancellableKey?: string): number {
    if (!cancellableKey) return 0;
    const cancelled = pool.waiters.filter(waiter => waiter.cancellableKey === cancellableKey);
    if (cancelled.length === 0) return 0;
    pool.waiters = pool.waiters.filter(waiter => waiter.cancellableKey !== cancellableKey);
    for (const waiter of cancelled) waiter.reject(new TranslationCancelledError());
    return cancelled.length;
}

async function translateGoogleSingle(text: string, targetLang: string, options?: TranslationTaskOptions): Promise<string> {
    await acquireRemoteSlot(googleRemotePool, options);

    let host = nextTranslateHost();
    const now = Date.now();
    for (let i = 0; i < GOOGLE_TRANSLATE_HOSTS.length; i++) {
        const pausedUntil = remotePausedUntilByHost.get(host) || 0;
        if (now >= pausedUntil) break;
        host = nextTranslateHost();
    }

    // Reserve the host's slot synchronously before awaiting. Concurrent calls
    // then see the future reservation and cannot wake together in a burst.
    const previousSlot = remoteLastTimeByHost.get(host) || 0;
    const reservedSlot = Math.max(now, previousSlot + REMOTE_MIN_INTERVAL_MS);
    remoteLastTimeByHost.set(host, reservedSlot);
    if (reservedSlot > now) {
        await new Promise(r => setTimeout(r, reservedSlot - now));
    }

    try {
        const sourceLang = sourceContext(options?.sourceLanguageHint);
        const res = await retryWithBackoff(
            () => gmRequest({
                url: `https://${host}/translate_a/single?client=gtx&sl=${sourceLang}&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`,
            }),
            {
                attempts: 2,
                backoffMs: 150,
                shouldRetry: (e) => e instanceof Error && /timeout/i.test(e.message),
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
        releaseRemoteSlot(googleRemotePool);
    }
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function extractCustomTranslation(payload: unknown): string {
    const root = asRecord(payload);
    if (!root) return '';

    for (const key of ['translation', 'translatedText', 'translated_text', 'text', 'output_text']) {
        if (typeof root[key] === 'string') return root[key].trim();
    }

    const choices = Array.isArray(root.choices) ? root.choices : [];
    const choice = asRecord(choices[0]);
    const message = asRecord(choice?.message);
    if (typeof message?.content === 'string') return message.content.trim();
    if (typeof choice?.text === 'string') return choice.text.trim();

    const content = Array.isArray(root.content) ? root.content : [];
    const contentPart = asRecord(content[0]);
    if (typeof contentPart?.text === 'string') return contentPart.text.trim();

    const candidates = Array.isArray(root.candidates) ? root.candidates : [];
    const candidate = asRecord(candidates[0]);
    const candidateContent = asRecord(candidate?.content);
    const parts = Array.isArray(candidateContent?.parts) ? candidateContent.parts : [];
    const part = asRecord(parts[0]);
    return typeof part?.text === 'string' ? part.text.trim() : '';
}

async function translateCustomSingle(
    text: string,
    targetLang: string,
    config: CustomTranslationConfig,
    options?: TranslationTaskOptions,
): Promise<string> {
    await acquireRemoteSlot(customRemotePool, options);
    try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
        const sourceInstruction = options?.sourceLanguageHint && options.sourceLanguageHint !== 'auto'
            ? ` from ${options.sourceLanguageHint}`
            : '';
        const res = await retryWithBackoff(
            () => gmRequest({
                method: 'POST',
                url: config.endpoint,
                headers,
                data: JSON.stringify({
                    model: config.model,
                    temperature: 0,
                    messages: [
                        {
                            role: 'system',
                            content: `Translate the user text${sourceInstruction} into ${targetLang}. Preserve meaning, names, tone, and line breaks. Return only the translation, with no notes or quotation marks.`,
                        },
                        { role: 'user', content: text },
                    ],
                }),
                responseType: 'json',
                timeout: 60_000,
            }),
            {
                attempts: 2,
                backoffMs: 500,
                shouldRetry: (error) => !(error instanceof HttpError) || error.retryable,
            },
        );
        const payload = asRecord(res.response) ? res.response : JSON.parse(res.responseText || '{}');
        const translated = extractCustomTranslation(payload);
        if (!translated) throw new Error('Custom translation API returned no text');
        if (isLikelyUntranslated(text, translated, targetLang, options?.sourceLanguageHint)) {
            throw new Error('Custom translation API echoed the source text');
        }
        return translated;
    } finally {
        releaseRemoteSlot(customRemotePool);
    }
}

async function translateRemoteSingle(
    text: string,
    targetLang: string,
    custom: CustomTranslationConfig | null,
    options?: TranslationTaskOptions,
): Promise<RemoteTranslationResult> {
    if (custom) {
        try {
            return {
                text: await translateCustomSingle(text, targetLang, custom, options),
                source: 'custom',
                customConfigured: true,
            };
        } catch (error) {
            if (error instanceof TranslationCancelledError) throw error;
            Logger.warn('[TranslationService] Custom translation API failed; using Google fallback:',
                error instanceof Error ? error.message : 'Unknown request error');
        }
        return {
            text: await translateGoogleSingle(text, targetLang, options),
            source: 'google',
            customConfigured: true,
        };
    }
    return {
        text: await translateGoogleSingle(text, targetLang, options),
        source: 'google',
        customConfigured: false,
    };
}

// ============================================================================
// Public API
// ============================================================================

export const TranslationService = {
    ttlMs: CACHE_TTL_MS,

    /** Target used for user-facing translations. Search/indexing callers may still request English explicitly. */
    getUiTargetLang(): string {
        return normalizeTargetLang(I18n.lang || 'en') || 'en';
    },

    isUserLang(text: string): boolean {
        const lang = I18n.lang;
        if (lang === 'ja' && /[ぁ-ヿ一-龯]/.test(text)) return true;
        if (lang === 'zh' && /[一-龯]/.test(text) && !/[ぁ-ヿ]/.test(text)) return true;
        return false;
    },

    isTargetLanguage(text: string, targetLang: string, sourceLanguageHint?: TranslationTaskOptions['sourceLanguageHint']): boolean {
        const sourceLang = sourceLanguageHint && sourceLanguageHint !== 'auto'
            ? sourceLanguageHint
            : detectSourceLanguage(text);
        return sourceLang === resolveEffectiveTargetLang(text, targetLang, sourceLanguageHint);
    },

    async translate(text: string, targetLang = 'en', options?: TranslationTaskOptions): Promise<string> {
        if (!text) return '';

        targetLang = resolveEffectiveTargetLang(
            text,
            targetLang,
            options?.sourceLanguageHint,
            options?.preserveRequestedTarget,
        );
        const provider = getTranslationProviderSnapshot();

        if (options?.sourceLanguageHint && options.sourceLanguageHint !== 'auto'
            && options.sourceLanguageHint === targetLang) {
            SharedCache.setMemory(noopCacheKey(text, targetLang, provider.id, options.sourceLanguageHint), text, NOOP_CACHE_TTL_MS);
            return text;
        }

        const cached = getCached(text, targetLang, provider.id, options?.sourceLanguageHint);
        if (cached) return cached;

        const laneKey = `${options?.priority ?? 0}`;
        const cancellationScope = options?.cancellable
            ? `cancel:${options.cancellableKey || 'anonymous'}`
            : 'shared';
        const flightKey = `${provider.id}:${sourceContext(options?.sourceLanguageHint)}:${laneKey}:${cancellationScope}:${targetLang}:${text}`;
        const existing = translateInFlight.get(flightKey);
        if (existing) return existing;

        const promise = this._translateInner(text, targetLang, provider, options);
        translateInFlight.set(flightKey, promise);
        try {
            return await promise;
        } catch (error) {
            if (!(error instanceof TranslationCancelledError)) {
                SharedCache.setMemory(
                    noopCacheKey(text, targetLang, provider.id, options?.sourceLanguageHint),
                    text,
                    NOOP_CACHE_TTL_MS,
                );
            }
            throw error;
        } finally {
            translateInFlight.delete(flightKey);
        }
    },

    async _translateInner(
        text: string,
        targetLang: string,
        provider = getTranslationProviderSnapshot(),
        options?: TranslationTaskOptions,
    ): Promise<string> {
        const glossary = processGlossary(text, targetLang);
        if (glossary.full) {
            SharedCache.set(cacheKey(text, targetLang, provider.id, options?.sourceLanguageHint), glossary.full, CACHE_TTL_MS);
            return glossary.full;
        }

        const input = normalizeForModel(glossary.preprocessed);
        const remote = await translateRemoteSingle(input, targetLang, provider.custom, options);
        let translated = remote.text;
        let source = remote.source;

        // A successful HTTP response can still be an untranslated echo. Retry
        // once through a different Google host before surfacing source text.
        if (isLikelyUntranslated(input, translated, targetLang, options?.sourceLanguageHint)) {
            Logger.debug('[TranslationService] Translation echoed source; retrying alternate provider');
            translated = await translateGoogleSingle(input, targetLang, options);
            source = 'google';
        }

        const cleaned = this.cleanQuotes(translated);
        const reason = isLikelyUntranslated(text, cleaned, targetLang, options?.sourceLanguageHint)
            ? 'untranslated-output'
            : getGarbageReason(text, cleaned);
        if (reason) {
            trackDegenerate(text, cleaned, reason);
            SharedCache.setMemory(noopCacheKey(text, targetLang, provider.id, options?.sourceLanguageHint), text, NOOP_CACHE_TTL_MS);
            return text;
        }

        // A transient custom-endpoint failure must not pin the Google fallback
        // in the custom provider's 30-day cache. Retrying later lets a repaired
        // endpoint become effective without requiring a manual cache clear.
        const cacheUnderCurrentProvider = source === 'custom' || !remote.customConfigured;
        if (cacheUnderCurrentProvider && cleaned && cleaned !== text) {
            SharedCache.set(cacheKey(text, targetLang, provider.id, options?.sourceLanguageHint), cleaned, CACHE_TTL_MS);
        } else if (!cleaned || cleaned === text) {
            SharedCache.setMemory(noopCacheKey(text, targetLang, provider.id, options?.sourceLanguageHint), text, NOOP_CACHE_TTL_MS);
        }

        return cleaned || text;
    },

    async translateBatch(texts: string[], targetLang = 'en', options?: TranslationTaskOptions): Promise<string[]> {
        if (texts.length === 0) return [];

        const requestedTargetLang = normalizeTargetLang(targetLang);

        const results = new Array(texts.length).fill('');
        const seen = new Map<string, number[]>();
        const uniqueUncached: string[] = [];

        for (let i = 0; i < texts.length; i++) {
            const text = texts[i]?.trim();
            if (!text) continue;

            const effectiveTargetLang = resolveEffectiveTargetLang(
                text,
                requestedTargetLang,
                options?.sourceLanguageHint,
                options?.preserveRequestedTarget,
            );
            const cached = getCached(text, effectiveTargetLang, undefined, options?.sourceLanguageHint);
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
        const workerCount = Math.min(
            getCustomTranslationConfig() ? CUSTOM_REMOTE_CONCURRENCY : REMOTE_CONCURRENCY,
            uniqueUncached.length,
        );
        let nextIndex = 0;

        const run = async () => {
            while (true) {
                const idx = nextIndex++;
                if (idx >= uniqueUncached.length) return;

                const text = uniqueUncached[idx];
                let translated = text;
                try {
                    translated = await this.translate(text, requestedTargetLang, options);
                } catch (err) {
                    Logger.debug('[TranslationService] Batch item fallback to source after error:', err);
                    translated = text;
                }

                translatedByText.set(text, translated);
            }
        };

        await Promise.all(Array.from({ length: workerCount }, () => run()));

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
        const key = options?.cancellableKey;
        return cancelRemoteWaiters(googleRemotePool, key)
            + cancelRemoteWaiters(customRemotePool, key);
    },

    getDebugStats(): { degenerateRemoteRejected: number } {
        return {
            degenerateRemoteRejected: degenerateStats.remoteRejected,
        };
    },

    peekCached(
        text: string,
        targetLang = 'en',
        sourceLanguageHint?: TranslationTaskOptions['sourceLanguageHint'],
        options?: Pick<TranslationTaskOptions, 'preserveRequestedTarget'>,
    ): string | null {
        if (!text) return null;
        return getCached(
            text,
            resolveEffectiveTargetLang(text, targetLang, sourceLanguageHint, options?.preserveRequestedTarget),
            undefined,
            sourceLanguageHint,
        );
    },

    invalidate(text: string, targetLangs: string[] = ['en', 'ja', 'zh']): void {
        if (!text) return;
        const providerId = getTranslationProviderSnapshot().id;
        const sourceHints: Array<TranslationTaskOptions['sourceLanguageHint']> = ['auto', 'ja', 'zh', 'en'];
        for (const sourceLanguageHint of sourceHints) {
            for (const requestedTarget of targetLangs) {
                const targetLang = resolveEffectiveTargetLang(text, requestedTarget, sourceLanguageHint);
                const input = cacheInput(text, providerId, sourceLanguageHint);
                SharedCache.set(CacheKeys.translation(input, targetLang, 'remote'), null, 0);
                SharedCache.set(CacheKeys.translation(input, targetLang, 'auto'), null, 0);
                SharedCache.setMemory(
                    noopCacheKey(text, targetLang, providerId, sourceLanguageHint),
                    null as unknown as string,
                    0,
                );
            }
        }
    },

    async autoTranslate(text: string, targetLang = 'en'): Promise<string> {
        if (!text || !/[ぁ-ヿ一-龯]/.test(text)) return text;
        if (this.isTargetLanguage(text, targetLang)) return text;
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
    isLikelyGarbage,
    isLikelyUntranslated,
    extractCustomTranslation,
    glossaryPreProcess,
    resetRemoteStateForTests,
};
