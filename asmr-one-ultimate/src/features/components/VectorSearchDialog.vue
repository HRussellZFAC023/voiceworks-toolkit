<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { openDB, deleteDB, type DBSchema } from 'idb';
import { useBridge, useI18n, useConfig, useEventBus } from '../../composables';
import { SharedCache } from '../../core/Cache';
import { TranslationService } from '../../services/TranslationService';
import { WorksApi } from '../../api';
import { buildCoverUrl } from '../../types/api';
import { Config, Logger, I18n } from '../../core/Utils';
import { gmRequest, retryWithBackoff, HttpError } from '../../infrastructure/HttpClient';
import type { TagEntry } from '../../types/api';

// ============================================================================
// Types
// ============================================================================

export interface VectorEntry {
    id: string;
    title: string;
    description: string;
    tags: string[];
    searchTags?: string[];
    circle?: string;
    vas?: string[];
    series?: string;
    searchText?: string;
    cover?: string;
    vector: number[];
}

interface VectorDB extends DBSchema {
    vectors: {
        key: string;
        value: VectorEntry;
    };
}

type SearchContext = {
    payload: string;
    usedTranslation: boolean;
    tokens: string[];
    tagHints: string[];
};

interface ScoredResult {
    entry: VectorEntry;
    score: number;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_API_SERVER = 'https://api.asmr-200.com';
const EMBED_CONCURRENCY = 2;
const RESULT_LIMIT = 40;
const VECTOR_INDEX_VERSION = 2;
const EMBEDDING_MODEL = 'jina-embeddings-v3';
const EMBEDDING_TASK_QUERY = 'retrieval.query';
const EMBEDDING_TASK_DOC = 'retrieval.passage';
const EMBEDDING_NORMALIZED = true;
const JINA_FREE_RPM = 500;
const EMBEDDING_MIN_INTERVAL_MS = Math.ceil(60000 / JINA_FREE_RPM);
const MAX_DESCRIPTION_CHARS = 2000;
const MAX_PAYLOAD_CHARS = 8000;

// ============================================================================
// Composables & Reactive State
// ============================================================================

const bridge = useBridge();
const { t, format } = useI18n();
const { on } = useEventBus();
const apiKey = useConfig('vectorSearchApiKey');

// Dialog state
const visible = ref(false);
const query = ref('');
const keyInput = ref('');
const statusMessage = ref('');
const statusLoading = ref(false);
const indexCount = ref(0);

// Results & pagination
const allResults = ref<ScoredResult[]>([]);
const currentPage = ref(1);
const totalPages = computed(() => Math.max(1, Math.ceil(allResults.value.length / RESULT_LIMIT)));
const pageResults = computed(() => {
    const start = (currentPage.value - 1) * RESULT_LIMIT;
    return allResults.value.slice(start, start + RESULT_LIMIT);
});
const showPagination = computed(() => allResults.value.length > RESULT_LIMIT);
const hasResults = computed(() => allResults.value.length > 0);
const hasApiKey = computed(() => !!apiKey.value);

// Template refs
const inputRef = ref<HTMLInputElement | null>(null);

// ============================================================================
// Internal (non-reactive) state
// ============================================================================

let dbPromise = openVectorDb();
let autoIndexRequested = false;
let autoIndexRunning = false;
let autoSeedTimer: number | null = null;
let autoWatchTimer: number | null = null;
let autoBatchTimer: number | null = null;
let autoIndexExhausted = false;
let bulkIndexCursor = Math.max(1, Number(Config.get('vectorIndexCursor') || 1));
const embeddingInflight = new Map<string, Promise<number[] | null>>();
let embeddingMinIntervalMs = EMBEDDING_MIN_INTERVAL_MS;
let embeddingCooldownUntil = 0;
let embeddingRateLimited = false;
let embeddingNextAt = 0;
let embeddingQueue: Promise<void> = Promise.resolve();
let indexReady = false;
let tagIndexReady: Promise<void> | null = null;
const tagById = new Map<number, TagEntry>();
const tagByName = new Map<string, TagEntry[]>();

// Title translations cache (for rendered results)
const titleTranslations = ref<Map<string, string>>(new Map());

// ============================================================================
// IndexedDB
// ============================================================================

function openVectorDb() {
    return openDB<VectorDB>('asmr-one-vectors', 1, {
        upgrade(db) {
            db.createObjectStore('vectors', { keyPath: 'id' });
        }
    });
}

// ============================================================================
// API base URL
// ============================================================================

function getApiBaseUrl(): string {
    try {
        const axios = bridge.axios as unknown as { defaults?: { baseURL?: string } };
        const baseURL = axios?.defaults?.baseURL;
        if (baseURL && baseURL.startsWith('http')) {
            return baseURL.replace(/\/$/, '');
        }
    } catch (e) {
        Logger.warn('[VectorSearch] Failed to read API base URL from bridge:', e);
    }
    return DEFAULT_API_SERVER;
}

// ============================================================================
// Index management
// ============================================================================

function hashKey(input: string): string {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(36);
}

async function ensureIndexReady(): Promise<void> {
    if (indexReady) return;
    const storedVersion = Number(Config.get('vectorIndexVersion') || 0);
    const storedModel = String(Config.get('vectorSearchModel') || '');
    if (storedVersion !== VECTOR_INDEX_VERSION || storedModel !== EMBEDDING_MODEL) {
        await resetVectorIndex('model-change', { storedVersion, storedModel });
    }
    Config.set('vectorIndexVersion', VECTOR_INDEX_VERSION);
    Config.set('vectorSearchModel', EMBEDDING_MODEL);
    indexReady = true;
}

async function ensureApiKeySynced(): Promise<void> {
    const key = String(Config.get('vectorSearchApiKey') || '').trim();
    if (!key) {
        if (Config.get('vectorSearchApiKeyHash')) {
            Config.set('vectorSearchApiKeyHash', '');
        }
        return;
    }
    const nextHash = hashKey(key);
    const storedHash = String(Config.get('vectorSearchApiKeyHash') || '');
    if (!storedHash) {
        Config.set('vectorSearchApiKeyHash', nextHash);
        return;
    }
    if (nextHash !== storedHash) {
        Config.set('vectorSearchApiKeyHash', nextHash);
        await resetVectorIndex('api-key-change');
    }
}

function clearRateLimitState(): void {
    embeddingCooldownUntil = 0;
    embeddingRateLimited = false;
    Config.set('vectorRateLimitCooldownUntil', 0);
    resetRateLimitBackoff();
}

async function handleApiKeyChange(nextKey: string, prevKey: string): Promise<void> {
    const next = nextKey.trim();
    const prev = prevKey.trim();
    if (next === prev) return;
    if (next) {
        Config.set('vectorSearchApiKeyHash', hashKey(next));
    } else {
        Config.set('vectorSearchApiKeyHash', '');
    }
    clearRateLimitState();
    await resetVectorIndex('api-key-change');
    if (next) {
        await scheduleAutoIndex();
    }
}

async function resetVectorIndex(reason: string, details?: Record<string, unknown>): Promise<void> {
    Logger.warn('[VectorSearch] Resetting vector index.', { reason, ...details });
    autoIndexRunning = false;
    autoIndexRequested = false;
    autoIndexExhausted = false;
    if (autoBatchTimer) {
        window.clearTimeout(autoBatchTimer);
        autoBatchTimer = null;
    }
    try {
        const db = await dbPromise;
        db.close();
    } catch (e) {
        Logger.warn('[VectorSearch] Failed to close vector DB before reset:', e);
    }
    await deleteDB('asmr-one-vectors');
    dbPromise = openVectorDb();
    bulkIndexCursor = 1;
    Config.set('vectorIndexCursor', 1);
    Config.set('vectorIndexLatestWorkId', '');
    Config.set('vectorIndexVersion', VECTOR_INDEX_VERSION);
    Config.set('vectorSearchModel', EMBEDDING_MODEL);
    indexReady = true;
    void refreshIndexCount();
}

async function countIndex(): Promise<number> {
    await ensureIndexReady();
    const db = await dbPromise;
    return db.count('vectors');
}

async function refreshIndexCount(): Promise<void> {
    indexCount.value = await countIndex();
}

// ============================================================================
// Tag index
// ============================================================================

function normalizeText(text: string): string {
    return text ? text.normalize('NFKC').toLowerCase() : '';
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
    const seen = new Set<string>();
    for (const value of values) {
        if (!value) continue;
        const normalized = value.trim();
        if (!normalized) continue;
        seen.add(normalized);
    }
    return Array.from(seen);
}

function indexTagName(name: string | undefined, tag: TagEntry): void {
    if (!name) return;
    const key = normalizeText(name).trim();
    if (!key) return;
    const existing = tagByName.get(key);
    if (existing) {
        existing.push(tag);
    } else {
        tagByName.set(key, [tag]);
    }
}

async function ensureTagIndex(): Promise<void> {
    if (tagIndexReady) return tagIndexReady;
    tagIndexReady = (async () => {
        try {
            const res = await bridge.api.getTags<TagEntry>();
            const tags = res?.data || [];
            for (const tag of tags) {
                tagById.set(tag.id, tag);
                indexTagName(tag.name, tag);
                indexTagName(tag.ja, tag);
                indexTagName(tag.en, tag);
            }
            Logger.debug(`[VectorSearch] Tag index loaded (${tags.length} tags).`);
        } catch (err) {
            Logger.warn('[VectorSearch] Failed to load tags for search hints', err);
        }
    })();
    return tagIndexReady;
}

// ============================================================================
// Embedding API
// ============================================================================

function checkPersistedRateLimit(): void {
    const persistedCooldown = Number(Config.get('vectorRateLimitCooldownUntil') || 0);
    if (persistedCooldown > Date.now()) {
        embeddingCooldownUntil = persistedCooldown;
        embeddingRateLimited = true;
    } else if (persistedCooldown > 0) {
        Config.set('vectorRateLimitBackoff', 1);
        Config.set('vectorRateLimitCooldownUntil', 0);
    }
}

function resetRateLimitBackoff(): void {
    if (Config.get('vectorRateLimitBackoff') !== 1) {
        Config.set('vectorRateLimitBackoff', 1);
    }
}

function applyRateLimit(delayMs: number): void {
    const currentBackoff = Number(Config.get('vectorRateLimitBackoff') || 1);
    const backoffMultiplier = Math.min(currentBackoff * 2, 8);
    const cooldownMs = Math.max(1000, delayMs * backoffMultiplier);

    embeddingCooldownUntil = Date.now() + cooldownMs;
    embeddingRateLimited = true;

    Config.set('vectorRateLimitCooldownUntil', embeddingCooldownUntil);
    Config.set('vectorRateLimitBackoff', backoffMultiplier);

    const waitSecs = Math.round(cooldownMs / 1000);
    setStatus(format('magicSearchRateLimitedRetry', { wait: waitSecs }), false);
    Logger.warn(`[VectorSearch] Rate limited by Jina. Cooling down for ${waitSecs}s (backoff: ${backoffMultiplier}x)`);
}

async function waitForEmbeddingSlot(): Promise<void> {
    let release: ((value?: void | PromiseLike<void>) => void) | null = null;
    const previous = embeddingQueue;
    embeddingQueue = new Promise<void>((resolve) => {
        release = resolve;
    });
    await previous;

    const now = Date.now();
    const waitUntil = Math.max(embeddingCooldownUntil, embeddingNextAt);
    const delay = Math.max(0, waitUntil - now);
    const nextBase = Math.max(now, waitUntil);
    embeddingNextAt = nextBase + embeddingMinIntervalMs;
    if (delay > 0) {
        await new Promise(resolve => window.setTimeout(resolve, delay));
    }
    if (release) (release as any)();
}

async function fetchEmbedding(text: string, task: string): Promise<number[] | null> {
    Logger.debug('[VectorSearch] fetchEmbedding');
    const url = 'https://api.jina.ai/v1/embeddings';
    const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${Config.get('vectorSearchApiKey')}`,
    };
    const body = JSON.stringify({
        model: EMBEDDING_MODEL,
        task,
        input: [text],
        normalized: EMBEDDING_NORMALIZED,
        embedding_type: 'float',
    });

    try {
        const res = await retryWithBackoff(
            () => gmRequest({ method: 'POST', url, headers, data: body, responseType: 'json' }),
            {
                attempts: 3,
                backoffMs: 1000,
                multiplier: 2,
                shouldRetry: (err) => {
                    if (err instanceof HttpError && err.status === 429) {
                        applyRateLimit(60000);
                        return false;
                    }
                    return true;
                },
            },
        );

        const data = typeof res.response === 'object' && res.response
            ? (res.response as Record<string, unknown>)
            : (JSON.parse(res.responseText) as Record<string, unknown>);

        const dataArr = data?.data as Array<Record<string, unknown>> | undefined;
        const embedding: number[] | null = (dataArr?.[0]?.embedding as number[] | undefined) || null;
        Logger.debug(`[VectorSearch] Embedding received: dim=${embedding?.length || 0}`);
        if (embedding) resetRateLimitBackoff();
        return embedding;
    } catch (err) {
        if (err instanceof HttpError && err.status === 429) {
            return null;
        }
        Logger.warn('[VectorSearch] fetchEmbedding failed:', err);
        return null;
    }
}

async function getEmbedding(text: string, task: string): Promise<number[] | null> {
    if (!Config.get('vectorSearchApiKey')) {
        Logger.warn('[VectorSearch] Missing Jina API key.');
        return null;
    }
    const cacheKey = `embedding:${EMBEDDING_MODEL}:${task}:${text}`;
    const cached = SharedCache.getMemory<number[]>(cacheKey);
    if (cached) {
        Logger.debug(`[VectorSearch] Embedding cache hit (dim=${cached.length})`);
        return cached;
    }
    const inflightKey = `${task}:${text}`;
    if (embeddingInflight.has(inflightKey)) {
        Logger.debug('[VectorSearch] Embedding in-flight, waiting...');
        return embeddingInflight.get(inflightKey)!;
    }
    Logger.debug(`[VectorSearch] Fetching embedding for text (${text.length} chars)`);

    const taskPromise = waitForEmbeddingSlot().then(() => fetchEmbedding(text, task)).then((vector) => {
        if (vector) SharedCache.setMemory(cacheKey, vector, 1000 * 60 * 60);
        return vector;
    }).finally(() => {
        embeddingInflight.delete(inflightKey);
    });

    embeddingInflight.set(inflightKey, taskPromise);
    return taskPromise;
}

// ============================================================================
// Work preparation & indexing
// ============================================================================

function truncateText(text: string, maxChars: number): string {
    if (!text) return '';
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}...`;
}

function extractTagInfo(tags: any[]): { displayTags: string[]; searchTags: string[] } {
    const displayTags = uniqueStrings(tags.map((t: any) => t?.name || t?.title || '').filter(Boolean));
    const searchTags: string[] = [];

    for (const tag of tags) {
        const raw = tag?.name || tag?.title || '';
        const i18nEn = tag?.i18n?.['en-us']?.name || tag?.i18n?.en?.name;
        const i18nJa = tag?.i18n?.['ja-jp']?.name || tag?.i18n?.ja?.name;

        const tagId = Number(tag?.id || 0) || 0;
        const tagEntry = tagId ? tagById.get(tagId) : undefined;

        if (tagEntry?.name) searchTags.push(tagEntry.name);
        if (tagEntry?.ja) searchTags.push(tagEntry.ja);
        if (tagEntry?.en) searchTags.push(tagEntry.en);
        searchTags.push(raw, i18nEn || '', i18nJa || '');
    }

    return {
        displayTags,
        searchTags: uniqueStrings(searchTags),
    };
}

function resolveCoverUrl(work: any, id: string): string | null {
    if (work.coverUrl) return work.coverUrl;
    if (work.main_cover_url) return work.main_cover_url;
    return buildCoverUrl(id, 'main', getApiBaseUrl());
}

async function prepareWorkEntry(work: any): Promise<{ entry: VectorEntry; payload: string } | null> {
    if (!work?.id) return null;
    const id = String(work.id);
    const title = work.title || work.name || '';
    const descriptionRaw = work.description || work.summary || '';
    const description = truncateText(descriptionRaw, MAX_DESCRIPTION_CHARS);

    const circle = work.circle?.name || (work.name && work.name !== title ? work.name : '');
    const series = work.series?.name || work.series_name || '';
    const vas = (work.vas || []).map((v: any) => v?.name || '').filter(Boolean);

    const tagInfo = extractTagInfo(work.tags || []);
    const searchTags = tagInfo.searchTags;
    const displayTags = tagInfo.displayTags;

    const payloadParts: string[] = [];
    if (title) payloadParts.push(`Title: ${title}`);
    if (circle) payloadParts.push(`Circle: ${circle}`);
    if (series) payloadParts.push(`Series: ${series}`);
    if (vas.length) payloadParts.push(`VAs: ${vas.join(', ')}`);
    if (searchTags.length) payloadParts.push(`Tags: ${searchTags.join(', ')}`);
    if (description) payloadParts.push(`Description: ${description}`);

    const payload = truncateText(payloadParts.join('\n'), MAX_PAYLOAD_CHARS);
    if (!payload.trim()) return null;

    const searchText = normalizeText([
        title, description, circle, series,
        vas.join(' '), searchTags.join(' ')
    ].filter(Boolean).join(' '));

    const entry: VectorEntry = {
        id, title, description,
        tags: displayTags,
        searchTags,
        circle: circle || undefined,
        series: series || undefined,
        vas: vas.length ? vas : undefined,
        searchText,
        vector: [],
    };

    return { entry, payload };
}

async function indexWork(work: any): Promise<boolean> {
    if (!work?.id) return false;
    const id = String(work.id);
    await ensureIndexReady();
    await ensureApiKeySynced();
    await ensureTagIndex();
    const db = await dbPromise;
    const existing = await db.get('vectors', id);
    if (existing) return false;

    const prepared = await prepareWorkEntry(work);
    if (!prepared) return false;

    const vector = await getEmbedding(prepared.payload, EMBEDDING_TASK_DOC);
    if (vector) {
        const cover = resolveCoverUrl(work, id) || undefined;
        await db.put('vectors', { ...prepared.entry, cover, vector });
        return true;
    }
    return false;
}

async function indexWorks(works: any[]): Promise<number> {
    if (works.length === 0) return 0;
    let added = 0;
    let index = 0;
    const workerCount = Math.min(EMBED_CONCURRENCY, works.length);
    const workers = Array.from({ length: workerCount }).map(async () => {
        while (index < works.length) {
            const work = works[index++];
            try {
                if (await indexWork(work)) added += 1;
            } catch (e) {
                Logger.warn('[VectorSearch] Index work failed', e);
            }
        }
    });
    await Promise.all(workers);
    return added;
}

async function indexCurrentWork(): Promise<void> {
    const work = (bridge.store.state.AudioPlayer?.work as any);
    if (!work?.id) return;
    if (!Config.get('vectorSearchApiKey')) return;
    const id = String(work.id);

    await ensureIndexReady();
    await ensureApiKeySynced();
    await ensureTagIndex();
    const db = await dbPromise;
    const existing = await db.get('vectors', id);
    if (existing) return;

    const prepared = await prepareWorkEntry(work);
    if (!prepared) return;

    const vector = await getEmbedding(prepared.payload, EMBEDDING_TASK_DOC);
    if (!vector) return;

    const cover = resolveCoverUrl(work, id) || undefined;
    await db.put('vectors', { ...prepared.entry, cover, vector });
    Logger.debug('[VectorSearch] Indexed work:', id, prepared.entry.title);
}

// ============================================================================
// Bulk indexing
// ============================================================================

async function bulkIndex(opts?: { maxPages?: number; maxWorks?: number; order?: string; sort?: string; startPage?: number }) {
    if (autoIndexRunning) return;
    if (!Config.get('vectorSearchApiKey')) {
        setStatus(t('magicSearchKeyMissingSettings'), false);
        return;
    }
    await ensureIndexReady();
    await ensureApiKeySynced();
    await ensureTagIndex();
    autoIndexRunning = true;
    setStatus(t('magicSearchFetchingLatest'), true);
    try {
        const maxPages = opts?.maxPages ?? 5;
        const maxWorks = opts?.maxWorks ?? 200;
        const order = opts?.order ?? 'release';
        const sort = opts?.sort ?? 'desc';
        const startPage = Math.max(1, opts?.startPage ?? bulkIndexCursor);
        const endPage = startPage + maxPages - 1;
        let indexed = 0;
        let lastPage = startPage - 1;
        let exhausted = false;
        let firstWorkId: string | null = null;
        for (let page = startPage; page <= endPage; page++) {
            if (page > startPage) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
            setStatus(format('magicSearchFetchingPage', { page, end: endPage }), true);
            let res;
            try {
                res = await WorksApi.getWorks({ order: order as any, sort: sort as any, page });
            } catch (fetchErr) {
                if (fetchErr instanceof HttpError && fetchErr.status === 429) {
                    Logger.warn('[VectorSearch] Works API rate limited (429). Rescheduling.');
                    setStatus(t('magicSearchWorksRateLimited'), false);
                    scheduleNextBatch(120_000);
                    return;
                }
                throw fetchErr;
            }
            if (!res || typeof res !== 'object') {
                Logger.warn('[VectorSearch] Invalid response from Works API (null or not an object):', res);
                setStatus(t('magicSearchBulkIndexFailed'), false);
                scheduleNextBatch(60_000);
                return;
            }
            const works = res.works || [];
            if (works.length === 0) {
                Logger.warn('[VectorSearch] Bulk index found no works on page', page);
                exhausted = true;
                break;
            }
            if (page === 1 && works[0]?.id) {
                firstWorkId = String(works[0].id);
            }
            lastPage = page;
            const remaining = maxWorks - indexed;
            const pageWorks = works.slice(0, remaining);
            setStatus(format('magicSearchIndexingPage', { page, count: pageWorks.length }), true);
            indexed += await indexWorks(pageWorks);
            if (embeddingRateLimited) {
                embeddingRateLimited = false;
                autoIndexExhausted = false;
                const delay = Math.max(0, embeddingCooldownUntil - Date.now());
                setStatus(t('magicSearchRateLimitedJinaCooldown'), false);
                scheduleNextBatch(delay || 60000);
                return;
            }
            if (indexed >= maxWorks) break;
        }
        if (exhausted) {
            bulkIndexCursor = 1;
            autoIndexExhausted = true;
        } else if (lastPage >= startPage) {
            bulkIndexCursor = lastPage + 1;
            autoIndexExhausted = false;
        }
        Config.set('vectorIndexCursor', bulkIndexCursor);
        if (firstWorkId) Config.set('vectorIndexLatestWorkId', firstWorkId);
        if (!autoIndexExhausted) {
            setStatus(t('magicSearchIndexingContinue'), false);
            scheduleNextBatch();
        } else {
            setStatus(t('magicSearchIndexingPaused'), false);
        }
        refreshIndexCount();
    } catch (e) {
        Logger.error('[VectorSearch] Bulk index failed', e);
        setStatus(t('magicSearchBulkIndexFailed'), false);
    } finally {
        autoIndexRunning = false;
        autoIndexRequested = false;
    }
}

async function scheduleAutoIndex(): Promise<void> {
    if (autoIndexRequested || autoIndexRunning) return;
    autoIndexRequested = true;
    await bulkIndex({ maxPages: 6, maxWorks: 250, order: 'release', sort: 'desc' });
}

function scheduleNextBatch(delayMs = 60 * 1000): void {
    if (autoBatchTimer) return;
    autoBatchTimer = window.setTimeout(async () => {
        autoBatchTimer = null;
        if (autoIndexRunning || autoIndexExhausted) return;
        await scheduleAutoIndex();
    }, delayMs);
}

function startIndexWatcher(): void {
    if (autoWatchTimer) return;
    autoWatchTimer = window.setInterval(() => {
        void checkForNewWorks();
    }, 10 * 60 * 1000);
}

async function checkForNewWorks(): Promise<void> {
    if (autoIndexRunning) return;
    if (!Config.get('vectorSearchApiKey')) return;
    const res = await WorksApi.getWorks({ order: 'release', sort: 'desc', page: 1 });
    const works = res.works || [];
    if (!works.length || !works[0]?.id) return;
    const latest = String(works[0].id);
    const lastSeen = String(Config.get('vectorIndexLatestWorkId') || '');
    if (latest && latest !== lastSeen) {
        Logger.debug('[VectorSearch] New works detected. Re-indexing from page 1.');
        bulkIndexCursor = 1;
        await bulkIndex({ maxPages: 3, maxWorks: 150, order: 'release', sort: 'desc', startPage: 1 });
    }
}

async function ensureAutoIndexOnOpen(): Promise<void> {
    const count = await countIndex();
    if (count > 0) return;
    await scheduleAutoIndex();
}

// ============================================================================
// Search logic
// ============================================================================

function containsJapanese(text: string): boolean {
    return /[\u3040-\u30ff\u4e00-\u9fff]/.test(text);
}

function extractTokens(text: string): string[] {
    const normalized = normalizeText(text);
    return normalized
        .split(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]+/g)
        .map(token => token.trim())
        .filter(token => token.length >= 2);
}

function findTagHints(normalizedQuery: string, tokens: string[]): string[] {
    const hints = new Set<string>();
    const keys = new Set<string>();
    if (normalizedQuery) keys.add(normalizedQuery);
    for (const token of tokens) {
        const key = normalizeText(token).trim();
        if (key) keys.add(key);
    }
    for (const key of keys) {
        const matches = tagByName.get(key);
        if (!matches) continue;
        for (const tag of matches) {
            if (tag.name) hints.add(tag.name);
            if (tag.ja) hints.add(tag.ja);
            if (tag.en) hints.add(tag.en);
        }
    }
    return Array.from(hints);
}

async function buildSearchContext(queryText: string): Promise<SearchContext> {
    const trimmed = queryText.trim();
    if (!trimmed) return { payload: trimmed, usedTranslation: false, tokens: [], tagHints: [] };

    const tokens = extractTokens(trimmed);
    const normalizedQuery = normalizeText(trimmed).trim();
    const tagHints = uniqueStrings(findTagHints(normalizedQuery, tokens));

    const expansions: string[] = [];
    if (tagHints.length) expansions.push(...tagHints);

    let usedTranslation = false;
    if (!containsJapanese(trimmed)) {
        const hasJapaneseHint = tagHints.some(hint => containsJapanese(hint));
        if (!hasJapaneseHint) {
            const translated = await TranslationService.translate(trimmed, 'ja');
            const normalized = translated?.trim() || '';
            if (normalized && normalized !== trimmed) {
                expansions.push(normalized);
                usedTranslation = true;
            }
        }
    }

    const payloadParts = [trimmed];
    const uniqueExpansions = uniqueStrings(expansions);
    if (uniqueExpansions.length) {
        payloadParts.push(`Related: ${uniqueExpansions.join(', ')}`);
    }

    const tokenSet = new Set<string>(tokens);
    for (const token of extractTokens(uniqueExpansions.join(' '))) {
        tokenSet.add(token);
    }

    return {
        payload: payloadParts.join('\n'),
        usedTranslation,
        tokens: Array.from(tokenSet),
        tagHints,
    };
}

function cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (vecA.length !== vecB.length) return 0;
    let dot = 0.0;
    let normA = 0.0;
    let normB = 0.0;
    for (let i = 0; i < vecA.length; i++) {
        dot += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function calculateKeywordBoost(entry: VectorEntry, searchMeta: SearchContext): number {
    const tokens = searchMeta.tokens;
    if (!tokens.length) return 0;

    const title = normalizeText(entry.title || '');
    const description = normalizeText(entry.description || '');
    const circle = normalizeText(entry.circle || '');
    const series = normalizeText(entry.series || '');
    const vas = normalizeText((entry.vas || []).join(' '));
    const tagsText = normalizeText(entry.tags.join(' '));
    const searchTags = (entry.searchTags && entry.searchTags.length ? entry.searchTags : entry.tags)
        .map(tag => normalizeText(tag))
        .filter(Boolean);
    const searchTagSet = new Set(searchTags);

    let boost = 0;
    let matched = 0;
    const normalizedTokens = tokens.map(token => normalizeText(token)).filter(Boolean);

    for (const token of normalizedTokens) {
        if (searchTagSet.has(token)) { boost += 0.15; matched += 1; continue; }
        if (tagsText.includes(token)) { boost += 0.1; matched += 1; continue; }
        if (title.includes(token)) { boost += 0.06; matched += 1; continue; }
        if (circle.includes(token) || series.includes(token) || vas.includes(token)) { boost += 0.05; matched += 1; continue; }
        if (description.includes(token)) { boost += 0.03; }
    }

    if (matched >= Math.min(2, normalizedTokens.length)) boost += 0.05;

    if (searchMeta.tagHints.length) {
        const hintSet = new Set(searchMeta.tagHints.map(hint => normalizeText(hint)).filter(Boolean));
        let hintMatches = 0;
        for (const hint of hintSet) {
            if (searchTagSet.has(hint)) hintMatches += 1;
        }
        if (hintMatches > 0) {
            boost += 0.08 + Math.min(0.12, hintMatches * 0.04);
        }
    }

    return boost;
}

function scoreEntry(entry: VectorEntry, vector: number[], searchMeta: SearchContext): number {
    const similarity = cosineSimilarity(vector, entry.vector);
    const boost = calculateKeywordBoost(entry, searchMeta);
    return similarity + boost;
}

async function doSearch(): Promise<void> {
    const val = query.value.trim();
    if (keyInput.value.trim()) {
        Config.set('vectorSearchApiKey', keyInput.value.trim());
    }
    if (!val) return;

    Logger.debug('[VectorSearch] Search query:', val);
    if (embeddingRateLimited) {
        const wait = Math.max(0, Math.ceil((embeddingCooldownUntil - Date.now()) / 1000));
        Logger.warn(`[VectorSearch] Rate limited, ${wait}s remaining`);
        setStatus(format('magicSearchCooldown', { wait }), false);
        return;
    }
    setStatus(t('magicSearchPreparing'), true);
    allResults.value = [];
    currentPage.value = 1;

    await ensureIndexReady();
    await ensureApiKeySynced();
    await ensureTagIndex();
    const searchMeta = await buildSearchContext(val);
    Logger.debug('[VectorSearch] Search context:', searchMeta);
    const searchLabel = searchMeta.usedTranslation ? t('magicSearchSearchingJP') : t('magicSearchSearching');
    setStatus(searchLabel, true);
    const queryVector = await getEmbedding(searchMeta.payload, EMBEDDING_TASK_QUERY);
    if (!queryVector) {
        setStatus(t('magicSearchEmbedFail'), false);
        return;
    }

    const db = await dbPromise;
    let entries = await db.getAll('vectors');
    if (entries.length === 0) {
        Logger.warn('[VectorSearch] Index empty. Starting auto-index.');
        setStatus(t('magicSearchIndexEmpty'), true);
        await scheduleAutoIndex();
        entries = await db.getAll('vectors');
        if (entries.length === 0) {
            setStatus(t('magicSearchIndexEmptyCheck'), false);
            return;
        }
    }

    const scored = entries.map(entry => ({
        entry,
        score: scoreEntry(entry, queryVector, searchMeta)
    })).sort((a, b) => b.score - a.score);

    Logger.debug(`[VectorSearch] Search completed: ${scored.length} results from ${entries.length} indexed entries`, {
        topResults: scored.slice(0, 5).map(r => ({ id: r.entry.id, title: r.entry.title, score: r.score.toFixed(3) })),
    });

    allResults.value = scored;
    currentPage.value = 1;
    titleTranslations.value = new Map();

    if (scored.length === 0) {
        setStatus(t('magicSearchNoMatches'), false);
    } else {
        const start = 1;
        const end = Math.min(RESULT_LIMIT, scored.length);
        setStatus(format('magicSearchShowing', { start, end, total: scored.length }), false);
    }

    // Trigger translations for visible results
    await nextTick();
    translateVisibleTitles();
}

// ============================================================================
// Title translation
// ============================================================================

async function translateResultTitle(title: string, id: string): Promise<void> {
    if (!title || I18n.lang !== 'en') return;
    if (!containsJapanese(title)) return;
    const translated = await TranslationService.translate(title, 'en');
    if (!translated || translated.trim() === title.trim()) return;
    titleTranslations.value.set(id, translated);
    // Trigger reactivity
    titleTranslations.value = new Map(titleTranslations.value);
}

function translateVisibleTitles(): void {
    for (const { entry } of pageResults.value) {
        if (!titleTranslations.value.has(entry.id)) {
            void translateResultTitle(entry.title, entry.id);
        }
    }
}

// ============================================================================
// UI helpers
// ============================================================================

function setStatus(message: string, loading: boolean): void {
    statusMessage.value = message;
    statusLoading.value = loading;
}

function getMatchPercent(score: number): string {
    return Math.max(0, Math.min(100, Math.round(score * 100))).toString();
}

function getDisplayTags(tags: string[]): string {
    return tags.slice(0, 3).filter(Boolean).join(' \u00b7 ');
}

function getCoverSrc(entry: VectorEntry): string {
    const cacheKey = `img-fail-${entry.id}`;
    if (SharedCache.get(cacheKey)) return '';
    return buildCoverUrl(entry.id, 'main', getApiBaseUrl());
}

function onImgError(event: Event, entryId: string): void {
    const img = event.target as HTMLImageElement;
    img.style.display = 'none';
    const placeholder = img.parentElement?.querySelector('.asmr-vector-thumb-placeholder') as HTMLElement | null;
    if (placeholder) placeholder.style.display = 'flex';
    SharedCache.set(`img-fail-${entryId}`, true, 24 * 60 * 60 * 1000);
}

function onImgLoad(event: Event): void {
    const img = event.target as HTMLImageElement;
    const placeholder = img.parentElement?.querySelector('.asmr-vector-thumb-placeholder') as HTMLElement | null;
    if (placeholder) placeholder.style.display = 'none';
}

function navigateToWork(id: string): void {
    bridge.router.push(`/work/${id}`);
    close();
}

function goToPage(page: number): void {
    const clamped = Math.max(1, Math.min(page, totalPages.value));
    currentPage.value = clamped;
    const start = (clamped - 1) * RESULT_LIMIT + 1;
    const end = Math.min(clamped * RESULT_LIMIT, allResults.value.length);
    setStatus(format('magicSearchShowing', { start, end, total: allResults.value.length }), false);
    titleTranslations.value = new Map(titleTranslations.value);
    nextTick(() => translateVisibleTitles());
}

// ============================================================================
// Dialog open/close
// ============================================================================

function open(): void {
    visible.value = true;
    nextTick(() => inputRef.value?.focus());
    void ensureAutoIndexOnOpen();
}

function close(): void {
    visible.value = false;
}

function onOverlayClick(e: MouseEvent): void {
    if (e.target === e.currentTarget) close();
}

function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && visible.value) {
        e.preventDefault();
        close();
    }
}

// ============================================================================
// Lifecycle & initialization
// ============================================================================

checkPersistedRateLimit();
void ensureIndexReady();

// Watch for route changes to index current work
let routeUnwatch: (() => void) | undefined;

onMounted(() => {
    routeUnwatch = bridge.$watch?.('$route', () => indexCurrentWork());
    void indexCurrentWork();

    // Schedule background indexing
    if (!autoSeedTimer) {
        autoSeedTimer = window.setTimeout(async () => {
            if (!Config.get('vectorSearchApiKey')) {
                Logger.warn('[VectorSearch] API key missing, background index skipped.');
                return;
            }
            Logger.log('[VectorSearch] Auto-indexing in background...');
            await scheduleAutoIndex();
            startIndexWatcher();
        }, 3000);
    }

    void ensureTagIndex();
    void refreshIndexCount();
    setStatus(t('magicSearchReady'), false);

    document.addEventListener('keydown', onKeydown);
});

onUnmounted(() => {
    routeUnwatch?.();
    document.removeEventListener('keydown', onKeydown);
    if (autoSeedTimer) { window.clearTimeout(autoSeedTimer); autoSeedTimer = null; }
    if (autoWatchTimer) { window.clearInterval(autoWatchTimer); autoWatchTimer = null; }
    if (autoBatchTimer) { window.clearTimeout(autoBatchTimer); autoBatchTimer = null; }
});

// Listen for config changes (API key)
on('config:change', (payload) => {
    if (payload?.key === 'vectorSearchApiKey') {
        void handleApiKeyChange(String(payload.value || ''), String(payload.oldValue || ''));
    }
});

// Listen for language changes
on('lang:change', () => {
    void refreshIndexCount();
});

// Expose open method so the controller can trigger it
defineExpose({ open });
</script>

<template>
    <!-- Trigger button (injected by controller into header) -->
    <button
        class="q-btn q-btn-flat q-btn-dense asmr-vector-btn text-white"
        :title="t('magicSearchBtn')"
        @click="open"
    >
        <span class="q-btn__content">
            <i class="q-icon material-icons" aria-hidden="true">psychology</i>
        </span>
    </button>

    <!-- Dialog overlay -->
    <Teleport to="body">
        <div
            v-if="visible"
            class="q-dialog fullscreen flex-center asmr-dialog-overlay"
            @click="onOverlayClick"
        >
            <div class="q-card q-pa-md asmr-vector-dialog asmr-dialog-card column no-wrap">
                <!-- Header -->
                <div class="row items-center justify-between q-mb-lg">
                    <div class="text-h6 text-weight-bold asmr-dialog-title">{{ t('magicSearch') }}</div>
                    <button
                        class="q-btn q-btn-flat q-btn-round q-btn-dense asmr-vector-close asmr-close-btn text-grey-7"
                        :aria-label="t('cancel') || 'Close'"
                        @click="close"
                    >
                        <span class="q-btn__content">
                            <i class="material-icons" aria-hidden="true">close</i>
                        </span>
                    </button>
                </div>

                <!-- API key warning (when missing) -->
                <div v-if="!hasApiKey" class="text-caption text-negative q-mb-md">
                    {{ t('magicSearchKeyMissing') }}
                </div>

                <!-- API key input (when missing) -->
                <template v-if="!hasApiKey">
                    <input
                        v-model="keyInput"
                        class="q-input q-pa-sm rounded-borders full-width q-mb-xs asmr-vector-key"
                        :placeholder="t('magicSearchKeyPlaceholder')"
                        :aria-label="t('magicSearchKeyPlaceholder')"
                    />
                    <div class="text-caption text-grey-7 q-mb-md asmr-settings-hint-text">
                        {{ t('magicSearchKeyHint') }}
                        <a href="https://jina.ai/" target="_blank" rel="noopener noreferrer"
                           class="text-primary asmr-settings-link">jina.ai</a>
                    </div>
                </template>

                <!-- Search bar -->
                <div class="row no-wrap items-center q-mb-sm rounded-borders asmr-search-bar">
                    <i class="material-icons q-mx-sm text-grey">search</i>
                    <input
                        ref="inputRef"
                        v-model="query"
                        class="q-input full-width asmr-vector-input col text-body1"
                        :placeholder="t('magicSearchPlaceholder')"
                        :aria-label="t('magicSearchPlaceholder')"
                        @keydown.enter="doSearch"
                    />
                    <button
                        class="q-btn q-btn-unelevated q-px-lg text-white asmr-vector-go q-mr-xs shadow-1"
                        :title="t('magicSearchGo')"
                        @click="doSearch"
                    >
                        <span class="q-btn__content">{{ t('magicSearchGo') }}</span>
                    </button>
                </div>

                <!-- Meta line: index count + status -->
                <div class="row items-center justify-between q-mb-sm asmr-vector-meta">
                    <div class="asmr-vector-count text-caption text-grey">
                        {{ format('magicSearchWorksIndexed', { count: indexCount }) }}
                    </div>
                    <div
                        class="asmr-vector-status text-caption text-grey"
                        :class="{ 'asmr-vector-status--loading': statusLoading }"
                    >
                        {{ statusMessage }}
                    </div>
                </div>

                <!-- Results list -->
                <div
                    v-if="hasResults"
                    class="asmr-vector-result-list q-list q-list--separator"
                    role="list"
                    :aria-label="t('magicSearch')"
                >
                    <div
                        v-for="{ entry, score } in pageResults"
                        :key="entry.id"
                        class="asmr-vector-result"
                        role="listitem"
                        @click="navigateToWork(entry.id)"
                    >
                        <div class="asmr-vector-thumb">
                            <img
                                v-if="getCoverSrc(entry)"
                                :src="getCoverSrc(entry)"
                                alt=""
                                referrerpolicy="no-referrer"
                                @load="onImgLoad"
                                @error="onImgError($event, entry.id)"
                            />
                            <div
                                class="asmr-vector-thumb-placeholder"
                                :class="{ visible: !getCoverSrc(entry) }"
                            >
                                <i class="material-icons">music_note</i>
                            </div>
                        </div>
                        <div class="q-item__section q-pa-sm asmr-result-content">
                            <div class="asmr-vector-title" :title="entry.title">{{ entry.title }}</div>
                            <div
                                v-if="titleTranslations.get(entry.id)"
                                class="asmr-vector-title-translation"
                            >
                                {{ titleTranslations.get(entry.id) }}
                            </div>
                            <div v-if="entry.description" class="asmr-vector-desc">
                                {{ entry.description }}
                            </div>
                            <div class="asmr-vector-meta-line">
                                <span class="text-weight-bold asmr-accent">
                                    {{ getMatchPercent(score) }}{{ t('magicSearchMatch') }}
                                </span>
                                <template v-if="getDisplayTags(entry.tags)">
                                    <span class="text-grey-5 q-mx-xs">&bull;</span>
                                    <span class="text-grey-6 ellipsis">{{ getDisplayTags(entry.tags) }}</span>
                                </template>
                            </div>
                        </div>
                        <div class="column justify-center q-pr-sm">
                            <button class="q-btn q-btn-flat q-btn-round asmr-accent">
                                <i class="material-icons asmr-play-icon">play_circle</i>
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Pagination -->
                <div
                    v-if="showPagination"
                    class="row items-center justify-between q-mt-sm asmr-vector-pagination"
                >
                    <button
                        class="q-btn q-btn-flat q-btn-dense text-primary asmr-vector-prev"
                        :disabled="currentPage <= 1"
                        @click="goToPage(currentPage - 1)"
                    >
                        {{ t('magicSearchPrev') }}
                    </button>
                    <div class="asmr-vector-page text-caption text-grey">
                        {{ format('magicSearchPage', { current: currentPage, total: totalPages }) }}
                    </div>
                    <button
                        class="q-btn q-btn-flat q-btn-dense text-primary asmr-vector-next"
                        :disabled="currentPage >= totalPages"
                        @click="goToPage(currentPage + 1)"
                    >
                        {{ t('magicSearchNext') }}
                    </button>
                </div>
            </div>
        </div>
    </Teleport>
</template>
