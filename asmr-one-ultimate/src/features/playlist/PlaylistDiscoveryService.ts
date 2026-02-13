/**
 * PlaylistDiscoveryService — Slim, data-only service for discovering public playlists.
 *
 * Responsibilities (and nothing else):
 *  • Merge known playlist IDs (hardcoded seed) + Google search cache + manual additions
 *  • Fetch & cache playlist metadata (soft 4 h / hard 7 d TTL)
 *  • Track failed playlist IDs (24 h cooldown)
 *  • Optionally trigger a Google search scrape
 *
 * No UI, no DOM, no Vue — pure data.
 */

import { Logger } from '../../core/Utils';
import { GooglePlaylistScraper } from '../../scrapers/GooglePlaylistScraper';
import { apiRequest } from './PlaylistService';
import KNOWN_PLAYLISTS from '../../data/known-playlists.json';
import type { PlaylistMetadata } from '../../api/Playlist';
import type { CachedPlaylistMetadata, GoogleSearchCache } from './types';

// ---------------------------------------------------------------------------
// Storage keys & TTLs
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'asmr_ultimate_discovered_playlists';
const METADATA_CACHE_KEY = 'asmr_ultimate_playlist_metadata_cache';
const METADATA_SOFT_TTL_MS = 4 * 60 * 60 * 1000;   // 4 hours — serve stale, revalidate
const METADATA_HARD_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — evict
const FAILED_CACHE_KEY = 'asmr_ultimate_failed_playlist_cache';
const FAILED_TTL_MS = 24 * 60 * 60 * 1000;          // 24 hours
const GOOGLE_CACHE_KEY = 'asmr_ultimate_google_search_cache';

const UNKNOWN_NAME = 'Unknown Playlist';
const KNOWN_IDS = KNOWN_PLAYLISTS.map(p => p.id.toLowerCase());

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
    /** google search cache (raw IDs) */
    private googleIds: string[] = [];

    private constructor() {
        this.loadManualIds();
        this.loadMetadataCache();
        this.loadFailedCache();
        this.loadGoogleCache();
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
        for (const id of KNOWN_IDS) set.add(id);
        for (const id of this.googleIds) set.add(id.toLowerCase());
        for (const id of this.manualIds) set.add(id.toLowerCase());
        return Array.from(set);
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
        return entry;
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

    /** Fetch metadata for a single playlist. Returns null on failure. */
    async fetchMetadata(id: string): Promise<CachedPlaylistMetadata | null> {
        const key = id.toLowerCase();

        // Return from cache if fresh
        const cached = this.getCachedMetadata(key);
        if (cached && !this.isStale(key)) return cached;

        // Skip known-failed
        if (this.isFailed(key)) return cached ?? null;

        try {
            const meta = await apiRequest<PlaylistMetadata>(
                '/api/playlist/get-playlist-metadata', { id: key },
            );
            if (!meta?.name || meta.name === UNKNOWN_NAME) {
                this.markFailed(key);
                return null;
            }
            const entry: CachedPlaylistMetadata = {
                id: meta.id ?? key,
                name: meta.name,
                user_name: meta.user_name ?? 'Unknown',
                worksCount: meta.works_count ?? 0,
                coverUrl: '',
                cachedAt: Date.now(),
            };
            this.metadataCache.set(key, entry);
            this.saveMetadataCache();
            return entry;
        } catch (e) {
            Logger.warn('[PlaylistDiscoveryService] fetchMetadata failed:', id, e);
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
        batchSize = 4,
        delayMs = 300,
    ): AsyncGenerator<CachedPlaylistMetadata> {
        for (let i = 0; i < ids.length; i += batchSize) {
            const batch = ids.slice(i, i + batchSize);
            const results = await Promise.allSettled(
                batch.map(id => this.fetchMetadata(id)),
            );
            for (const r of results) {
                if (r.status === 'fulfilled' && r.value) {
                    yield r.value;
                }
            }
            if (i + batchSize < ids.length) {
                await new Promise(resolve => setTimeout(resolve, delayMs));
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
                    this.metadataCache.set(e.id.toLowerCase(), e);
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
}
