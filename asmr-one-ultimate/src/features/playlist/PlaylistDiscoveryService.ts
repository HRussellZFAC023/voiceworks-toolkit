/**
 * PlaylistDiscoveryService — Slim, data-only service for discovering public playlists.
 *
 * Responsibilities (and nothing else):
 *  • Merge a server-hosted community catalog + Google cache + manual additions
 *  • Fetch & cache playlist metadata (soft 4 h / hard 7 d TTL)
 *  • Track failed playlist IDs (24 h cooldown)
 *  • Optionally trigger a Google search scrape
 *
 * No UI, no DOM, no Vue — pure data.
 */

import { Logger } from '../../core/Utils';
import { GooglePlaylistScraper } from '../../scrapers/GooglePlaylistScraper';
import { buildCoverUrl } from '../../types/api';
import { apiRequest, getApiBaseUrl } from './PlaylistService';
import { DEFAULT_API_PROXY } from '../../core/Constants';
import type { PlaylistMetadata, PlaylistMetadataWorkItem } from '../../api/Playlist';
import type {
    CachedPlaylistMetadata,
    CommunityPlaylistCatalog,
    CommunityPlaylistSummary,
    GoogleSearchCache,
} from './types';

// ---------------------------------------------------------------------------
// Storage keys & TTLs
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'asmr_ultimate_discovered_playlists';
const METADATA_CACHE_KEY = 'asmr_ultimate_playlist_metadata_cache';
const METADATA_SOFT_TTL_MS = 4 * 60 * 60 * 1000;   // 4 hours — serve stale, revalidate
const METADATA_HARD_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — evict
const FAILED_CACHE_KEY = 'asmr_ultimate_failed_playlist_cache';
const FAILED_CACHE_VERSION_KEY = 'asmr_ultimate_failed_playlist_cache_version';
const FAILED_CACHE_VERSION = 2;
const FAILED_TTL_MS = 24 * 60 * 60 * 1000;          // 24 hours
const GOOGLE_CACHE_KEY = 'asmr_ultimate_google_search_cache';
const COMMUNITY_CATALOG_CACHE_KEY = 'asmr_ultimate_community_playlist_catalog_v1';
const COMMUNITY_CATALOG_ETAG_KEY = 'asmr_ultimate_community_playlist_catalog_etag_v1';
const COMMUNITY_CATALOG_URL = `${DEFAULT_API_PROXY}/community-playlists/catalog.json`;
const COMMUNITY_SUBMISSION_URL = `${DEFAULT_API_PROXY}/community-playlists/submissions`;
const COMMUNITY_CATALOG_MAX_BYTES = 2 * 1024 * 1024;
const COMMUNITY_CATALOG_MAX_PLAYLISTS = 5_000;
const COMMUNITY_CATALOG_HARD_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

const UNKNOWN_NAME = 'Unknown Playlist';
const TRANSIENT_FAIL_TTL_MS = 5 * 60 * 1000; // 5 min
const RATE_LIMIT_BACKOFF_MS = 90 * 1000; // 90 sec

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function gmGet<T>(key: string, def: T): T {
    return GooglePlaylistScraper.safeGetValue(key, def);
}
function gmSet(key: string, value: unknown): void {
    GooglePlaylistScraper.safeSetValue(key, value);
}
function parseJson<T>(raw: unknown): T | null {
    try {
        return typeof raw === 'string' ? JSON.parse(raw) as T : (raw as T);
    } catch { return null; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maximum: number): string {
    return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

function normalizedHttpsUrl(value: unknown): string {
    const text = boundedText(value, 8_192);
    if (!text) return '';
    try {
        const url = new URL(text);
        return url.protocol === 'https:' ? url.href : '';
    } catch {
        return '';
    }
}

function normalizeCatalogWorkId(value: unknown): string | number | undefined {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
    if (typeof value !== 'string') return undefined;
    const text = value.trim();
    if (/^[A-Za-z]{2}\d+$/.test(text)) return text.toUpperCase();
    if (/^\d+$/.test(text)) {
        const numeric = Number(text);
        return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : undefined;
    }
    return undefined;
}

async function readBoundedResponseBytes(response: Response, maximumBytes: number): Promise<Uint8Array> {
    const declared = response.headers.get('content-length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
        throw new Error('Response is too large');
    }
    if (!response.body) throw new Error('Response body is missing');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!value?.byteLength) continue;
            total += value.byteLength;
            if (total > maximumBytes) {
                await reader.cancel();
                throw new Error('Response is too large');
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

function normalizeCatalogSummary(value: unknown): CommunityPlaylistSummary | null {
    if (!isRecord(value)) return null;
    const id = boundedText(value.id, 64).toLowerCase();
    const name = boundedText(value.name, 512);
    if (!UUID_PATTERN.test(id) || !name) return null;
    const worksCount = typeof value.worksCount === 'number' && Number.isSafeInteger(value.worksCount)
        ? Math.max(0, value.worksCount)
        : 0;
    return {
        id,
        name,
        userName: boundedText(value.userName ?? value.user_name, 256),
        worksCount: Math.min(1_000_000, worksCount),
        coverUrl: normalizedHttpsUrl(value.coverUrl),
        tags: normalizeTagArray(value.tags).slice(0, 128),
        latestWorkId: normalizeCatalogWorkId(value.latestWorkId),
    };
}

/** Validate the untrusted Worker response before it reaches UI or storage. */
export function parseCommunityPlaylistCatalog(value: unknown): CommunityPlaylistCatalog {
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.playlists)
        || value.playlists.length > COMMUNITY_CATALOG_MAX_PLAYLISTS
        || typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt))) {
        throw new Error('Invalid community playlist catalog');
    }
    const playlists: CommunityPlaylistSummary[] = [];
    const seen = new Set<string>();
    for (const candidate of value.playlists) {
        const playlist = normalizeCatalogSummary(candidate);
        if (!playlist) throw new Error('Invalid community playlist catalog entry');
        if (seen.has(playlist.id)) continue;
        seen.add(playlist.id);
        playlists.push(playlist);
    }
    return { version: 1, generatedAt: value.generatedAt, playlists };
}

function readFirstCoverUrl(candidate: unknown): string {
    if (!candidate || typeof candidate !== 'object') return '';
    const record = candidate as Record<string, unknown>;
    const keys = [
        'coverUrl',
        'cover',
        'main_cover_url',
        'mainCoverUrl',
        'thumbnailCoverUrl',
        'samCoverUrl',
    ] as const;
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

function normalizeWorkId(raw: unknown): number | null {
    if (typeof raw === 'number' && Number.isFinite(raw)) {
        return raw;
    }
    if (typeof raw !== 'string') return null;
    const value = raw.trim();
    if (!value) return null;
    if (/^\d+$/.test(value)) return Number(value);
    const prefixed = value.match(/^[A-Za-z]+(\d+)$/);
    if (prefixed) return Number(prefixed[1]);
    return null;
}

function normalizeTagName(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const compact = raw.replace(/\s+/g, ' ').trim();
    return compact || null;
}

function collectTagNames(candidate: unknown, sink: Map<string, string>): void {
    if (!candidate) return;

    if (typeof candidate === 'string') {
        const normalized = normalizeTagName(candidate);
        if (!normalized) return;
        const key = normalized.toLowerCase();
        if (!sink.has(key)) sink.set(key, normalized);
        return;
    }

    if (Array.isArray(candidate)) {
        for (const item of candidate) collectTagNames(item, sink);
        return;
    }

    if (typeof candidate !== 'object') return;

    const record = candidate as Record<string, unknown>;
    for (const key of ['name', 'title', 'ja', 'en', 'name_ja', 'name_en'] as const) {
        const value = record[key];
        const normalized = normalizeTagName(value);
        if (!normalized) continue;
        const lowered = normalized.toLowerCase();
        if (!sink.has(lowered)) sink.set(lowered, normalized);
    }

    for (const key of ['tags', 'genres', 'tags_replaced', 'genres_replaced'] as const) {
        collectTagNames(record[key], sink);
    }
}

function normalizeTagArray(raw: unknown): string[] {
    const tags = new Map<string, string>();
    collectTagNames(raw, tags);
    return Array.from(tags.values());
}

function extractErrorStatus(error: unknown): number | null {
    if (!error || typeof error !== 'object') return null;
    const record = error as Record<string, unknown>;
    if (typeof record.status === 'number') return record.status;

    const response = record.response;
    if (response && typeof response === 'object') {
        const responseStatus = (response as Record<string, unknown>).status;
        if (typeof responseStatus === 'number') return responseStatus;
    }
    return null;
}

function isRateLimitError(error: unknown): boolean {
    const status = extractErrorStatus(error);
    if (status === 429) return true;
    const message = error instanceof Error ? error.message : String(error || '');
    return /\b429\b/.test(message);
}

function isTransientNetworkError(error: unknown): boolean {
    const status = extractErrorStatus(error);
    if (status === 0) return true;
    const message = error instanceof Error ? error.message : String(error || '');
    return /network error|failed to fetch|cors|timeout|err_failed/i.test(message);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class PlaylistDiscoveryService {
    private static instance: PlaylistDiscoveryService;

    /** manually-added playlist IDs */
    private manualIds = new Set<string>();
    /** metadata cache: id → entry */
    private metadataCache = new Map<string, CachedPlaylistMetadata>();
    /** failed playlist IDs → timestamp */
    private failedCache = new Map<string, number>();
    /** temporary cooldown for transient fetch failures (rate limit / network) */
    private transientFailureCache = new Map<string, number>();
    /** google search cache (raw IDs) */
    private googleIds: string[] = [];
    /** Last verified shared catalog; populated synchronously from GM storage. */
    private communityCatalog: CommunityPlaylistCatalog | null = null;
    private communityCatalogLoadedAt = 0;
    private communityCatalogRequest: Promise<CommunityPlaylistSummary[]> | null = null;
    /** global API backoff when playlist metadata endpoint starts returning 429 */
    private rateLimitUntil = 0;

    private constructor() {
        this.loadManualIds();
        this.loadMetadataCache();
        this.loadFailedCache();
        this.loadGoogleCache();
        this.loadCommunityCatalogCache();
    }

    static getInstance(): PlaylistDiscoveryService {
        if (!PlaylistDiscoveryService.instance) {
            PlaylistDiscoveryService.instance = new PlaylistDiscoveryService();
        }
        return PlaylistDiscoveryService.instance;
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /** Merged, deduplicated list of all discovered playlist IDs */
    getDiscoveredIds(): string[] {
        const set = new Set<string>();
        for (const playlist of this.getCachedCommunityCatalog()) set.add(playlist.id);
        for (const id of this.googleIds) set.add(id.toLowerCase());
        for (const id of this.manualIds) set.add(id.toLowerCase());
        return Array.from(set);
    }

    /** Return the on-device catalog snapshot without waiting for the network. */
    getCachedCommunityCatalog(): CommunityPlaylistSummary[] {
        return this.communityCatalog?.playlists.map(playlist => ({
            ...playlist,
            tags: [...playlist.tags],
        })) ?? [];
    }

    /**
     * Fetch one bounded server manifest. A cached snapshot remains usable when
     * the network is unavailable, and concurrent callers share one request.
     */
    loadCommunityCatalog(force = false): Promise<CommunityPlaylistSummary[]> {
        if (this.communityCatalogRequest) return this.communityCatalogRequest;
        if (!force && this.communityCatalog
            && Date.now() - this.communityCatalogLoadedAt < METADATA_SOFT_TTL_MS) {
            return Promise.resolve(this.getCachedCommunityCatalog());
        }

        this.communityCatalogRequest = this.fetchCommunityCatalog()
            .catch((error) => {
                Logger.warn('[PlaylistDiscoveryService] Community catalog unavailable; using cache', error);
                const cached = this.getCachedCommunityCatalog();
                if (cached.length) return cached;
                throw error;
            })
            .finally(() => { this.communityCatalogRequest = null; });
        return this.communityCatalogRequest;
    }

    /** Merged IDs after the maintained catalog has had one chance to load. */
    async getDiscoveredIdsAsync(): Promise<string[]> {
        try { await this.loadCommunityCatalog(); }
        catch { /* emergency export still includes manual and search-discovered IDs */ }
        return this.getDiscoveredIds();
    }

    /**
     * Submit only a playlist UUID. The Worker performs the authoritative live
     * existence/publicity check and stores a deduplicated verified summary.
     */
    async submitCommunityPlaylist(input: string): Promise<CommunityPlaylistSummary> {
        const id = this.extractId(input);
        if (!id || !UUID_PATTERN.test(id)) throw new Error('Invalid playlist ID');
        const response = await fetch(COMMUNITY_SUBMISSION_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ id }),
        });
        if (!response.ok) throw new Error(`Playlist submission failed (HTTP ${response.status})`);
        if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
            throw new Error('Invalid playlist submission response');
        }
        const bytes = await readBoundedResponseBytes(response, 64 * 1024);
        const parsed = parseJson<unknown>(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        const envelope = isRecord(parsed) ? parsed : null;
        let summary = normalizeCatalogSummary(envelope?.playlist);
        if (!summary && envelope?.status === 'already-listed' && envelope.id === id) {
            const refreshed = await this.loadCommunityCatalog(true);
            summary = refreshed.find(playlist => playlist.id === id) ?? null;
            if (!summary) {
                const cached = this.getCachedMetadata(id);
                if (cached) {
                    summary = {
                        id,
                        name: cached.name,
                        userName: cached.user_name,
                        worksCount: cached.worksCount,
                        coverUrl: cached.coverUrl,
                        tags: [...cached.tags],
                        latestWorkId: cached.latestWorkId,
                    };
                }
            }
        }
        if (!summary) throw new Error('Invalid playlist submission response');
        this.mergeCommunitySummary(summary);
        this.persistCommunityCatalog();
        return { ...summary, tags: [...summary.tags] };
    }

    /** Number of discovered playlists */
    get discoveredCount(): number {
        return this.getDiscoveredIds().length;
    }

    /** Peek at cached metadata (no fetch). Returns null if not cached or expired. */
    getCachedMetadata(id: string): CachedPlaylistMetadata | null {
        const entry = this.metadataCache.get(id.toLowerCase());
        if (!entry) return null;
        if (Date.now() - entry.cachedAt > METADATA_HARD_TTL_MS) {
            this.metadataCache.delete(id.toLowerCase());
            return null;
        }
        return {
            ...entry,
            tags: normalizeTagArray(entry.tags),
        };
    }

    /** Is this playlist's metadata stale (past soft TTL)? */
    isStale(id: string): boolean {
        const entry = this.metadataCache.get(id.toLowerCase());
        if (!entry) return true;
        return Date.now() - entry.cachedAt > METADATA_SOFT_TTL_MS;
    }

    /** Was this playlist previously marked as failed? */
    isFailed(id: string): boolean {
        const ts = this.failedCache.get(id.toLowerCase());
        if (!ts) return false;
        if (Date.now() - ts < FAILED_TTL_MS) return true;
        this.failedCache.delete(id.toLowerCase());
        return false;
    }

    /** Is this playlist temporarily paused due to recent transient failure? */
    isTransientFailed(id: string): boolean {
        const until = this.transientFailureCache.get(id.toLowerCase());
        if (!until) return false;
        if (Date.now() < until) return true;
        this.transientFailureCache.delete(id.toLowerCase());
        return false;
    }

    /** Is playlist metadata API currently in global rate-limit cooldown? */
    isRateLimitedNow(): boolean {
        return Date.now() < this.rateLimitUntil;
    }

    /** Fetch metadata for a single playlist. Returns null on failure. */
    async fetchMetadata(id: string): Promise<CachedPlaylistMetadata | null> {
        const key = id.toLowerCase();

        // Return from cache if fresh
        const cached = this.getCachedMetadata(key);
        if (cached && !this.isStale(key)) return cached;

        // Skip known-failed
        if (this.isFailed(key)) return cached ?? null;
        if (this.isTransientFailed(key)) return cached ?? null;
        if (this.isRateLimitedNow()) return cached ?? null;

        try {
            const meta = await apiRequest<PlaylistMetadata>(
                '/api/playlist/get-playlist-metadata', { id: key },
            );
            if (!meta?.name || meta.name === UNKNOWN_NAME) {
                this.markFailed(key);
                return null;
            }
            const cachedLatestWorkId = cached?.latestWorkId;
            const resolved = this.resolveCoverFromMetadata(meta);
            const shouldResolveFromWorks = !resolved.coverUrl && !cached?.coverUrl;
            const fallback = shouldResolveFromWorks
                ? await this.resolveCoverFromPlaylistWorks(key)
                : { coverUrl: '', latestWorkId: undefined as string | number | undefined };
            const coverUrl = resolved.coverUrl || fallback.coverUrl || cached?.coverUrl || '';
            const latestWorkId = resolved.latestWorkId ?? fallback.latestWorkId ?? cachedLatestWorkId;
            const tags = normalizeTagArray([
                cached?.tags || [],
                this.resolveTagsFromMetadata(meta),
            ]);
            const entry: CachedPlaylistMetadata = {
                id: meta.id ?? key,
                name: meta.name,
                user_name: meta.user_name ?? 'Unknown',
                worksCount: meta.works_count ?? 0,
                tags,
                latestWorkId,
                coverUrl,
                coverUrlResolved: Boolean(coverUrl),
                cachedAt: Date.now(),
            };
            this.metadataCache.set(key, entry);
            this.saveMetadataCache();
            this.transientFailureCache.delete(key);
            return entry;
        } catch (e) {
            Logger.warn('[PlaylistDiscoveryService] fetchMetadata failed:', id, e);
            if (isRateLimitError(e)) {
                const jitter = Math.floor(Math.random() * 5000);
                this.rateLimitUntil = Date.now() + RATE_LIMIT_BACKOFF_MS + jitter;
                this.transientFailureCache.set(key, this.rateLimitUntil);
                return cached ?? null;
            }
            if (isTransientNetworkError(e)) {
                this.transientFailureCache.set(key, Date.now() + TRANSIENT_FAIL_TTL_MS);
                return cached ?? null;
            }
            this.markFailed(key);
            return cached ?? null;   // serve stale if available
        }
    }

    /**
     * Fetch metadata for a batch of IDs, yielding results as they arrive.
     * Skips failed IDs automatically. Pauses `delayMs` between API calls to
     * avoid hammering the server.
     */
    async *fetchMetadataBatch(
        ids: string[],
        batchSize = 2,
        delayMs = 500,
    ): AsyncGenerator<CachedPlaylistMetadata> {
        const safeBatchSize = Math.max(1, Math.floor(batchSize));
        const safeDelayMs = Math.max(0, delayMs);
        for (let i = 0; i < ids.length; i += safeBatchSize) {
            const results = await Promise.allSettled(
                ids.slice(i, i + safeBatchSize).map(id => this.fetchMetadata(id)),
            );
            for (const result of results) {
                if (result.status === 'fulfilled' && result.value) {
                    yield result.value;
                }
            }
            if (safeDelayMs > 0 && i + safeBatchSize < ids.length) {
                await new Promise(resolve => setTimeout(resolve, safeDelayMs));
            }
        }
    }

    /** Add a playlist URL/ID manually */
    addManualPlaylist(input: string): string | null {
        const id = this.extractId(input);
        if (!id) return null;
        const key = id.toLowerCase();
        this.manualIds.add(key);
        this.saveManualIds();
        Logger.debug('[PlaylistDiscoveryService] Added manual playlist:', key);
        return key;
    }

    /** Remove a manually-added playlist */
    removeManualPlaylist(id: string): void {
        this.manualIds.delete(id.toLowerCase());
        this.saveManualIds();
    }

    /** Trigger Google search discovery in the background. Returns new IDs found. */
    async triggerGoogleSearch(
        onProgress?: (page: number, found: number) => void,
    ): Promise<string[]> {
        if (GooglePlaylistScraper.isRateLimited()) {
            Logger.warn('[PlaylistDiscoveryService] Google rate-limited, skipping');
            return [];
        }
        const ids = await GooglePlaylistScraper.discoverPlaylists(onProgress);
        if (ids.length > 0) {
            const newIds = ids.map(id => id.toLowerCase());
            this.googleIds = [...new Set([...this.googleIds, ...newIds])];
            this.saveGoogleCache();
            Logger.debug('[PlaylistDiscoveryService] Google search found', newIds.length, 'IDs');
        }
        return ids;
    }

    /** Check if Google search is currently rate-limited */
    get isGoogleRateLimited(): boolean {
        return GooglePlaylistScraper.isRateLimited();
    }

    // -----------------------------------------------------------------------
    // Persistence helpers
    // -----------------------------------------------------------------------

    private async fetchCommunityCatalog(retryUnexpectedNotModified = true): Promise<CommunityPlaylistSummary[]> {
        // An ETag is useful only alongside the validated representation it
        // identifies. GM storage can be partially cleared or quota-limited.
        const etag = this.communityCatalog
            ? String(gmGet(COMMUNITY_CATALOG_ETAG_KEY, '') || '').trim()
            : '';
        const response = await fetch(COMMUNITY_CATALOG_URL, {
            headers: {
                Accept: 'application/json',
                ...(etag ? { 'If-None-Match': etag } : {}),
            },
            cache: 'no-cache',
        });
        if (response.status === 304 && this.communityCatalog) {
            this.communityCatalogLoadedAt = Date.now();
            this.persistCommunityCatalog();
            return this.getCachedCommunityCatalog();
        }
        if (response.status === 304) {
            gmSet(COMMUNITY_CATALOG_ETAG_KEY, '');
            if (retryUnexpectedNotModified) return this.fetchCommunityCatalog(false);
            throw new Error('Community catalog returned 304 without a cached representation');
        }
        if (!response.ok) throw new Error(`Community catalog HTTP ${response.status}`);
        if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
            throw new Error('Community catalog response is not JSON');
        }
        const bytes = await readBoundedResponseBytes(response, COMMUNITY_CATALOG_MAX_BYTES);
        const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const catalog = parseCommunityPlaylistCatalog(JSON.parse(raw) as unknown);
        this.communityCatalog = catalog;
        this.communityCatalogLoadedAt = Date.now();
        this.seedMetadataFromCommunityCatalog(catalog.playlists, this.communityCatalogLoadedAt);
        const nextEtag = response.headers.get('etag');
        if (nextEtag) gmSet(COMMUNITY_CATALOG_ETAG_KEY, nextEtag);
        this.persistCommunityCatalog();
        return this.getCachedCommunityCatalog();
    }

    private loadCommunityCatalogCache(): void {
        try {
            const raw = gmGet(COMMUNITY_CATALOG_CACHE_KEY, null);
            const envelope = parseJson<{ catalog?: unknown; loadedAt?: unknown }>(raw);
            if (!envelope || typeof envelope.loadedAt !== 'number'
                || Date.now() - envelope.loadedAt > COMMUNITY_CATALOG_HARD_TTL_MS) return;
            const catalog = parseCommunityPlaylistCatalog(envelope.catalog);
            this.communityCatalog = catalog;
            this.communityCatalogLoadedAt = envelope.loadedAt;
            this.seedMetadataFromCommunityCatalog(catalog.playlists, envelope.loadedAt);
        } catch (error) {
            Logger.debug('[PlaylistDiscoveryService] Ignoring invalid community catalog cache', error);
        }
    }

    private persistCommunityCatalog(): void {
        if (!this.communityCatalog) return;
        gmSet(COMMUNITY_CATALOG_CACHE_KEY, JSON.stringify({
            catalog: this.communityCatalog,
            loadedAt: this.communityCatalogLoadedAt || Date.now(),
        }));
    }

    private mergeCommunitySummary(summary: CommunityPlaylistSummary): void {
        const current = this.communityCatalog?.playlists ?? [];
        const byId = new Map(current.map(playlist => [playlist.id, playlist]));
        byId.set(summary.id, summary);
        this.communityCatalog = {
            version: 1,
            generatedAt: this.communityCatalog?.generatedAt ?? new Date().toISOString(),
            playlists: Array.from(byId.values()),
        };
        this.communityCatalogLoadedAt = Date.now();
        this.seedMetadataFromCommunityCatalog([summary], this.communityCatalogLoadedAt);
    }

    private seedMetadataFromCommunityCatalog(playlists: CommunityPlaylistSummary[], cachedAt: number): void {
        let changed = false;
        for (const playlist of playlists) {
            const current = this.metadataCache.get(playlist.id);
            const next: CachedPlaylistMetadata = {
                id: playlist.id,
                name: playlist.name,
                user_name: playlist.userName || current?.user_name || 'Unknown',
                worksCount: playlist.worksCount,
                tags: [...playlist.tags],
                latestWorkId: playlist.latestWorkId ?? current?.latestWorkId,
                coverUrl: playlist.coverUrl || current?.coverUrl || '',
                coverUrlResolved: Boolean(playlist.coverUrl || current?.coverUrl),
                cachedAt: Math.max(current?.cachedAt ?? 0, cachedAt),
            };
            this.metadataCache.set(playlist.id, next);
            changed = true;
        }
        if (changed) this.saveMetadataCache();
    }

    private loadManualIds(): void {
        try {
            const raw = gmGet(STORAGE_KEY, null);
            const parsed = parseJson<Array<{ id: string; source?: string }>>(raw);
            if (Array.isArray(parsed)) {
                for (const p of parsed) {
                    if (p.source === 'manual') this.manualIds.add(p.id.toLowerCase());
                }
            }
        } catch { /* ignore */ }
    }

    private saveManualIds(): void {
        const arr = Array.from(this.manualIds).map(id => ({
            id,
            discovered_at: Date.now(),
            source: 'manual' as const,
        }));
        gmSet(STORAGE_KEY, JSON.stringify(arr));
    }

    private loadMetadataCache(): void {
        try {
            const raw = gmGet(METADATA_CACHE_KEY, null);
            const entries = parseJson<CachedPlaylistMetadata[]>(raw);
            if (!Array.isArray(entries)) return;
            const now = Date.now();
            for (const e of entries) {
                if (!e.name || e.name === UNKNOWN_NAME) continue;
                if (now - e.cachedAt < METADATA_HARD_TTL_MS) {
                    const normalized: CachedPlaylistMetadata = {
                        ...e,
                        tags: normalizeTagArray((e as { tags?: unknown }).tags),
                    };
                    this.metadataCache.set(e.id.toLowerCase(), normalized);
                }
            }
            Logger.debug('[PlaylistDiscoveryService] Loaded', this.metadataCache.size, 'cached metadata');
        } catch { /* ignore */ }
    }

    private saveMetadataCache(): void {
        gmSet(METADATA_CACHE_KEY, JSON.stringify(Array.from(this.metadataCache.values())));
    }

    private loadFailedCache(): void {
        try {
            const version = Number(gmGet<number | string>(FAILED_CACHE_VERSION_KEY, 1));
            if (version !== FAILED_CACHE_VERSION) {
                this.failedCache.clear();
                gmSet(FAILED_CACHE_KEY, JSON.stringify([]));
                gmSet(FAILED_CACHE_VERSION_KEY, FAILED_CACHE_VERSION);
                return;
            }
            const raw = gmGet(FAILED_CACHE_KEY, null);
            const entries = parseJson<Array<{ id: string; failedAt: number }>>(raw);
            if (!Array.isArray(entries)) return;
            const now = Date.now();
            for (const e of entries) {
                if (now - e.failedAt < FAILED_TTL_MS) {
                    this.failedCache.set(e.id.toLowerCase(), e.failedAt);
                }
            }
        } catch { /* ignore */ }
    }

    private saveFailedCache(): void {
        const arr = Array.from(this.failedCache.entries())
            .map(([id, failedAt]) => ({ id, failedAt }));
        gmSet(FAILED_CACHE_KEY, JSON.stringify(arr));
        gmSet(FAILED_CACHE_VERSION_KEY, FAILED_CACHE_VERSION);
    }

    private markFailed(id: string): void {
        this.failedCache.set(id.toLowerCase(), Date.now());
        this.saveFailedCache();
    }

    private loadGoogleCache(): void {
        try {
            const raw = gmGet(GOOGLE_CACHE_KEY, null);
            const cache = parseJson<GoogleSearchCache>(raw);
            if (cache?.playlistIds?.length) {
                this.googleIds = cache.playlistIds.map(id => id.toLowerCase());
                Logger.debug('[PlaylistDiscoveryService] Loaded', this.googleIds.length, 'Google-cached IDs');
            }
        } catch { /* ignore */ }
    }

    private saveGoogleCache(): void {
        const cache: GoogleSearchCache = { timestamp: Date.now(), playlistIds: this.googleIds };
        gmSet(GOOGLE_CACHE_KEY, JSON.stringify(cache));
    }

    /** Extract UUID from a playlist URL or raw UUID string */
    private extractId(input: string): string | null {
        const trimmed = input.trim();
        const uuidPattern = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i;
        const match = trimmed.match(uuidPattern);
        return match ? match[0].toLowerCase() : null;
    }

    private resolveCoverFromMetadata(meta: PlaylistMetadata): { coverUrl: string; latestWorkId?: string | number } {
        const topLevelCover = readFirstCoverUrl(meta);
        if (topLevelCover) {
            return { coverUrl: topLevelCover };
        }

        if (!Array.isArray(meta.works) || meta.works.length === 0) {
            return { coverUrl: '' };
        }

        return this.resolveCoverFromWork(meta.works[0]);
    }

    private resolveTagsFromMetadata(meta: PlaylistMetadata): string[] {
        const tags = new Map<string, string>();
        const record = meta as unknown as Record<string, unknown>;
        collectTagNames(record.tags, tags);
        collectTagNames(record.genres, tags);
        collectTagNames(record.tags_replaced, tags);
        collectTagNames(record.genres_replaced, tags);

        if (Array.isArray(meta.works)) {
            for (const work of meta.works) {
                if (!work || typeof work !== 'object') continue;
                const workRecord = work as Record<string, unknown>;
                collectTagNames(workRecord.tags, tags);
                collectTagNames(workRecord.genres, tags);
                collectTagNames(workRecord.tags_replaced, tags);
                collectTagNames(workRecord.genres_replaced, tags);
            }
        }

        return Array.from(tags.values());
    }

    private resolveCoverFromWork(work: PlaylistMetadataWorkItem | string | undefined): {
        coverUrl: string;
        latestWorkId?: string | number;
    } {
        if (!work) return { coverUrl: '' };

        const workCover = readFirstCoverUrl(work);
        const workObject = typeof work === 'object' && work !== null
            ? work as Record<string, unknown>
            : null;
        const rawWorkId = workObject?.id ?? workObject?.source_id ?? work;
        const latestWorkId = normalizeWorkId(rawWorkId) ?? undefined;

        if (workCover) {
            return { coverUrl: workCover, latestWorkId };
        }
        if (latestWorkId !== undefined) {
            return {
                coverUrl: buildCoverUrl(latestWorkId, 'main', getApiBaseUrl()),
                latestWorkId,
            };
        }

        return { coverUrl: '' };
    }

    private async resolveCoverFromPlaylistWorks(id: string): Promise<{ coverUrl: string; latestWorkId?: string | number }> {
        try {
            const worksResponse = await apiRequest<{ works?: PlaylistMetadataWorkItem[] }>(
                '/api/playlist/get-playlist-works',
                { id, page: 1, pageSize: 1 },
            );
            const firstWork = Array.isArray(worksResponse?.works) ? worksResponse.works[0] : undefined;
            return this.resolveCoverFromWork(firstWork);
        } catch (e) {
            Logger.debug('[PlaylistDiscoveryService] cover lookup failed:', id, e);
            return { coverUrl: '' };
        }
    }
}
