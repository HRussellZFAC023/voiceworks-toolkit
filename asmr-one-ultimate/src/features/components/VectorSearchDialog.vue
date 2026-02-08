<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue';
import { openDB, deleteDB, type DBSchema } from 'idb';
import { useBridge, useI18n, useEventBus } from '../../composables';
import { SharedCache } from '../../core/Cache';
import { TranslationService } from '../../services/TranslationService';
import { WorksApi } from '../../api';
import { buildCoverUrl } from '../../types/api';
import { Config, Logger, I18n } from '../../core/Utils';
import { HttpError } from '../../infrastructure/HttpClient';
import { EmbeddingService } from '../../services/EmbeddingService';
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
    dlCount?: number;
    rating?: number;
    nsfw?: boolean;
    hasSubtitle?: boolean;
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
const EMBED_CONCURRENCY = 3;
const RESULT_LIMIT = 40;
const VECTOR_INDEX_VERSION = 4; // Force re-index: enriched metadata (dl_count, rating, age_category)
const EMBEDDING_MODEL = 'Xenova/multilingual-e5-small';
const EMBEDDING_TASK_QUERY = 'query';
const EMBEDDING_TASK_DOC = 'passage';
const MAX_DESCRIPTION_CHARS = 1500;
const MAX_PAYLOAD_CHARS = 5000;
const MIN_SCORE_THRESHOLD = 0.25;
const SEARCH_TIMEOUT_MS = 15_000;
const TRANSLATION_TIMEOUT_MS = 5_000;

// ============================================================================
// Composables & Reactive State
// ============================================================================

const bridge = useBridge();
const { t, format } = useI18n();
const { on } = useEventBus();

// Dialog state
const visible = ref(false);
const query = ref('');
const statusMessage = ref('');
const statusLoading = ref(false);
const searching = ref(false);
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
let indexReady = false;
let indexReadyPromise: Promise<void> | null = null;
let tagIndexReady: Promise<void> | null = null;
let searchPriority = false;
let searchAbort: AbortController | null = null;
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

function ensureIndexReady(): Promise<void> {
    if (indexReady) return Promise.resolve();
    if (indexReadyPromise) return indexReadyPromise;
    indexReadyPromise = (async () => {
        const storedVersion = Number(Config.get('vectorIndexVersion') || 0);
        const storedModel = String(Config.get('vectorSearchModel') || '');
        if (storedVersion !== VECTOR_INDEX_VERSION || storedModel !== EMBEDDING_MODEL) {
            await resetVectorIndex('model-change', { storedVersion, storedModel });
        }
        Config.set('vectorIndexVersion', VECTOR_INDEX_VERSION);
        Config.set('vectorSearchModel', EMBEDDING_MODEL);
        indexReady = true;
    })();
    return indexReadyPromise;
}

async function ensureModelSynced(): Promise<void> {
    // No additional sync needed — model/version checking is done in ensureIndexReady()
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
// Embedding (local model via EmbeddingService)
// ============================================================================

async function getEmbedding(text: string, task: string): Promise<number[] | null> {
    try {
        const embTask = task === EMBEDDING_TASK_QUERY ? 'query' : 'passage';
        return await EmbeddingService.embed(text, embTask);
    } catch (err) {
        Logger.warn('[VectorSearch] getEmbedding failed:', err);
        return null;
    }
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

    // Extract metadata for storage and embedding enrichment
    const dlCount = typeof work.dl_count === 'number' ? work.dl_count : undefined;
    const rating = typeof work.rate_average_2dp === 'number' ? work.rate_average_2dp : undefined;
    const nsfw = typeof work.nsfw === 'boolean' ? work.nsfw : undefined;
    const hasSubtitle = typeof work.has_subtitle === 'boolean' ? work.has_subtitle : undefined;
    const ageCategory = work.age_category_string || '';
    const langEditions: string[] = Array.isArray(work.language_editions)
        ? work.language_editions.map((e: any) => e?.lang || e?.label || '').filter(Boolean)
        : [];

    const payloadParts: string[] = [];
    if (title) payloadParts.push(`Title: ${title}`);
    if (circle) payloadParts.push(`Circle: ${circle}`);
    if (series) payloadParts.push(`Series: ${series}`);
    if (vas.length) payloadParts.push(`VAs: ${vas.join(', ')}`);
    if (searchTags.length) payloadParts.push(`Tags: ${searchTags.join(', ')}`);
    if (ageCategory) payloadParts.push(`Category: ${ageCategory}`);
    if (langEditions.length) payloadParts.push(`Languages: ${langEditions.join(', ')}`);
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
        dlCount,
        rating,
        nsfw,
        hasSubtitle,
    };

    return { entry, payload };
}

async function indexWork(work: any): Promise<boolean> {
    if (!work?.id) return false;
    // Yield to search when search is active
    if (searchPriority) {
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    const id = String(work.id);
    await ensureIndexReady();
    await ensureModelSynced();
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
    const id = String(work.id);

    await ensureIndexReady();
    await ensureModelSynced();
    await ensureTagIndex();
    const db = await dbPromise;
    const existing = await db.get('vectors', id);

    // Enrich existing entries when richer data (e.g. description) is now available
    const workHasDescription = !!(work.description || work.summary);
    if (existing) {
        if (!workHasDescription || existing.description) return;
        Logger.debug('[VectorSearch] Enriching entry with description:', id);
    }

    const prepared = await prepareWorkEntry(work);
    if (!prepared) return;

    const vector = await getEmbedding(prepared.payload, EMBEDDING_TASK_DOC);
    if (!vector) return;

    const cover = resolveCoverUrl(work, id) || undefined;
    await db.put('vectors', { ...prepared.entry, cover, vector });
    Logger.debug(`[VectorSearch] ${existing ? 'Enriched' : 'Indexed'} work:`, id, prepared.entry.title);
}

// ============================================================================
// Bulk indexing
// ============================================================================

async function bulkIndex(opts?: { maxPages?: number; maxWorks?: number; order?: string; sort?: string; startPage?: number }) {
    if (autoIndexRunning) return;
    await ensureIndexReady();
    await ensureModelSynced();
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
        try {
            const translated = await Promise.race([
                TranslationService.translate(trimmed, 'ja'),
                new Promise<null>((_, reject) => setTimeout(() => reject(new Error('Translation timeout')), TRANSLATION_TIMEOUT_MS)),
            ]);
            const normalized = translated?.trim() || '';
            if (normalized && normalized !== trimmed) {
                expansions.push(normalized);
                usedTranslation = true;
            }
        } catch {
            // Translation timed out or failed — E5-small handles English natively
            Logger.debug('[VectorSearch] Translation timed out or failed, proceeding without');
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

function dotProduct(vecA: number[], vecB: number[]): number {
    if (vecA.length !== vecB.length) return 0;
    let dot = 0.0;
    for (let i = 0; i < vecA.length; i++) {
        dot += vecA[i] * vecB[i];
    }
    return dot;
}

function isLatinToken(token: string): boolean {
    return /^[a-z0-9]+$/.test(token);
}

function textContainsToken(text: string, token: string): boolean {
    if (isLatinToken(token)) {
        return new RegExp(`\\b${token}\\b`).test(text);
    }
    return text.includes(token);
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
        if (searchTagSet.has(token)) { boost += 0.08; matched += 1; continue; }
        if (textContainsToken(tagsText, token)) { boost += 0.05; matched += 1; continue; }
        if (textContainsToken(title, token)) { boost += 0.04; matched += 1; continue; }
        if (textContainsToken(circle, token) || textContainsToken(series, token) || textContainsToken(vas, token)) { boost += 0.03; matched += 1; continue; }
        if (textContainsToken(description, token)) { boost += 0.02; }
    }

    if (matched >= Math.min(2, normalizedTokens.length)) boost += 0.03;

    if (searchMeta.tagHints.length) {
        const hintSet = new Set(searchMeta.tagHints.map(hint => normalizeText(hint)).filter(Boolean));
        let hintMatches = 0;
        for (const hint of hintSet) {
            if (searchTagSet.has(hint)) hintMatches += 1;
        }
        if (hintMatches > 0) {
            boost += 0.04 + Math.min(0.06, hintMatches * 0.02);
        }
    }

    return boost;
}

function calculatePopularityBoost(entry: VectorEntry): number {
    if (!entry.dlCount || entry.dlCount <= 0) return 0;
    // Logarithmic scale: 1000 downloads = +0.01, 10000 = +0.02, 100000 = +0.03
    return Math.min(0.04, Math.log10(Math.max(1, entry.dlCount)) * 0.01 - 0.02);
}

function scoreEntry(entry: VectorEntry, vector: number[], searchMeta: SearchContext): number {
    const similarity = dotProduct(vector, entry.vector);
    const keywordBoost = calculateKeywordBoost(entry, searchMeta);
    const popularityBoost = calculatePopularityBoost(entry);
    return similarity + keywordBoost + popularityBoost;
}

function cancelSearch(): void {
    if (searchAbort) {
        searchAbort.abort();
        searchAbort = null;
    }
}

async function doSearch(): Promise<void> {
    if (searching.value) return;
    const val = query.value.trim();
    if (!val) return;

    // Cancel any previous search
    cancelSearch();
    const abort = new AbortController();
    searchAbort = abort;

    Logger.debug('[VectorSearch] Search query:', val);
    searching.value = true;
    searchPriority = true;
    setStatus(t('magicSearchPreparing'), true);
    allResults.value = [];
    currentPage.value = 1;

    const searchBody = async () => {
        await ensureIndexReady();
        if (abort.signal.aborted) return;
        await ensureModelSynced();
        if (abort.signal.aborted) return;
        await ensureTagIndex();
        if (abort.signal.aborted) return;
        const searchMeta = await buildSearchContext(val);
        if (abort.signal.aborted) return;
        Logger.debug('[VectorSearch] Search context:', searchMeta);
        const searchLabel = searchMeta.usedTranslation ? t('magicSearchSearchingJP') : t('magicSearchSearching');
        setStatus(searchLabel, true);
        const queryVector = await getEmbedding(searchMeta.payload, EMBEDDING_TASK_QUERY);
        if (abort.signal.aborted) return;
        if (!queryVector) {
            setStatus(t('magicSearchEmbedFail'), false);
            return;
        }

        const db = await dbPromise;
        const entries = await db.getAll('vectors');
        if (entries.length === 0) {
            Logger.warn('[VectorSearch] Index empty. Starting auto-index.');
            setStatus(t('magicSearchIndexEmpty'), false);
            void scheduleAutoIndex(); // Fire-and-forget: don't block search on bulk indexing
            return;
        }

        if (abort.signal.aborted) return;

        const scored = entries.map(entry => ({
            entry,
            score: scoreEntry(entry, queryVector, searchMeta)
        }))
        .filter(r => r.score >= MIN_SCORE_THRESHOLD)
        .sort((a, b) => b.score - a.score);

        Logger.debug(`[VectorSearch] Search completed: ${scored.length} relevant results from ${entries.length} indexed entries (threshold: ${MIN_SCORE_THRESHOLD})`, {
            topResults: scored.slice(0, 5).map(r => ({ id: r.entry.id, title: r.entry.title, score: r.score.toFixed(3) })),
        });

        allResults.value = scored;
        currentPage.value = 1;
        titleTranslations.value = new Map();

        if (scored.length === 0) {
            setStatus(entries.length > 0 ? t('magicSearchNoRelevantMatches') : t('magicSearchNoMatches'), false);
        } else {
            const start = 1;
            const end = Math.min(RESULT_LIMIT, scored.length);
            setStatus(format('magicSearchShowing', { start, end, total: scored.length }), false);
        }

        // Trigger translations for visible results
        await nextTick();
        translateVisibleTitles();
    };

    try {
        await Promise.race([
            searchBody(),
            new Promise<void>((_, reject) => {
                const timer = setTimeout(() => reject(new Error('Search timeout')), SEARCH_TIMEOUT_MS);
                abort.signal.addEventListener('abort', () => {
                    clearTimeout(timer);
                    reject(new Error('Search cancelled'));
                });
            }),
        ]);
    } catch (err: any) {
        if (abort.signal.aborted) {
            setStatus(t('magicSearchCancelled'), false);
        } else {
            Logger.warn('[VectorSearch] Search failed:', err);
            setStatus(t('magicSearchTimeout'), false);
        }
    } finally {
        searching.value = false;
        searchPriority = false;
        if (searchAbort === abort) searchAbort = null;
    }
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
    cancelSearch();
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

void ensureIndexReady();

// Watch for route changes to index current work
let routeUnwatch: (() => void) | undefined;

onMounted(() => {
    routeUnwatch = bridge.$watch?.('$route', () => indexCurrentWork());
    void indexCurrentWork();

    // Schedule background indexing
    if (!autoSeedTimer) {
        autoSeedTimer = window.setTimeout(async () => {
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

                <!-- Search bar -->
                <div class="row no-wrap items-center rounded-borders asmr-search-bar" :class="{ 'asmr-search-bar--busy': searching }">
                    <i class="material-icons q-mx-sm text-grey">search</i>
                    <input
                        ref="inputRef"
                        v-model="query"
                        class="q-input full-width asmr-vector-input col text-body1"
                        :placeholder="t('magicSearchPlaceholder')"
                        :aria-label="t('magicSearchPlaceholder')"
                        :disabled="searching"
                        @keydown.enter="doSearch"
                    />
                    <button
                        v-if="!searching"
                        class="q-btn q-btn-unelevated q-px-lg text-white asmr-vector-go q-mr-xs shadow-1"
                        :title="t('magicSearchGo')"
                        @click="doSearch"
                    >
                        <span class="q-btn__content">{{ t('magicSearchGo') }}</span>
                    </button>
                    <button
                        v-else
                        class="q-btn q-btn-unelevated q-px-lg asmr-vector-cancel q-mr-xs shadow-1"
                        :title="t('magicSearchCancel')"
                        @click="cancelSearch"
                    >
                        <span class="q-btn__content">{{ t('magicSearchCancel') }}</span>
                    </button>
                </div>
                <div class="asmr-search-progress-track q-mb-sm">
                    <div v-if="searching" class="asmr-search-progress-bar"></div>
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
