<script setup lang="ts">
/**
 * PlaylistDiscoveryPanel.vue - Discovers and displays public playlists
 *
 * Features:
 * - Scrapes Google search results for indexed asmr.one/playlist URLs
 * - Fetches all pages of search results dynamically
 * - Stores discovered playlists in GM storage for cross-domain persistence
 * - Allows manual addition of playlist URLs
 * - Infinite scroll loading with lazy image loading
 * - Filter modes: All, I liked, I created, Online only
 * - Text search filter with debounce
 */

import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { useBridge } from '../../composables/useBridge';
import { useI18n } from '../../composables/useI18n';
import { useConfig } from '../../composables/useConfig';
import { useRoute } from '../../composables/useRoute';
import { useEventBus } from '../../composables/useEventBus';
import { Logger } from '../../core/Utils';
import { GooglePlaylistScraper } from '../../scrapers/GooglePlaylistScraper';
import { AuthApi } from '../../api/Auth';
import { AppStore } from '../../store/AppStore';
import { apiRequest } from '../playlist/PlaylistService';
import KNOWN_PLAYLISTS from '../../data/known-playlists.json';
import type { PlaylistEntry, PlaylistMetadata, PlaylistWorksResponse } from '../../api/Playlist';
import type {
    CachedPlaylistMetadata,
    CachedUserPlaylists,
    DiscoveredPlaylist,
    FetchedPlaylist,
    GoogleSearchCache,
    PlaylistFetchResult,
    PlaylistListResponse,
} from '../playlist/types';

// ---------------------------------------------------------------------------
// Composables
// ---------------------------------------------------------------------------

const bridge = useBridge();
const { t, format } = useI18n();
const route = useRoute();
const enableInfiniteScroll = useConfig('enableInfiniteScroll');
const { on, emit } = useEventBus();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type PlaylistFilterMode = 'all' | 'mine' | 'public' | 'online';

const BATCH_SIZE = 12;
const METADATA_BATCH_SIZE = 4;
const BATCH_COOLDOWN_MS = 300;
const COVER_UPDATE_CONCURRENCY = 1;
const COVER_UPDATE_DELAY_MS = 500;
const WORKS_PAGE_SIZE = 1;

const STORAGE_KEY = 'asmr_ultimate_discovered_playlists';
const METADATA_CACHE_KEY = 'asmr_ultimate_playlist_metadata_cache';
const METADATA_SOFT_TTL_MS = 4 * 60 * 60 * 1000;
const METADATA_HARD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FAILED_PLAYLIST_CACHE_KEY = 'asmr_ultimate_failed_playlist_cache';
const FAILED_PLAYLIST_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const UNKNOWN_PLAYLIST_NAME = 'Unknown Playlist';
const FILTER_MODE_STORAGE_KEY = 'asmr_ultimate_playlist_filter_mode';
const USER_PLAYLISTS_CACHE_KEY = 'asmr_ultimate_user_playlists_cache';
const USER_PLAYLISTS_SOFT_TTL_MS = 5 * 60 * 1000;
const USER_PLAYLISTS_HARD_TTL_MS = 60 * 60 * 1000;
const CACHE_KEY = 'asmr_ultimate_google_search_cache';

const KNOWN_PLAYLIST_IDS = KNOWN_PLAYLISTS.map(p => p.id.toLowerCase());

// ---------------------------------------------------------------------------
// Reactive State
// ---------------------------------------------------------------------------

const filterMode = ref<PlaylistFilterMode>('all');
const textFilter = ref('');
const isLoading = ref(false);
const isSearching = ref(false);
const searchFeedback = ref<{ type: 'info' | 'success' | 'warning' | 'error'; text: string } | null>(null);
const displayedCount = ref(0);
const sentinelVisible = ref(false);

/** All discovered playlist IDs (from known list, Google, manual, user) */
const discoveredPlaylists = ref<DiscoveredPlaylist[]>([]);

/** Filtered subset of discoveredPlaylists for the current mode */
const publicPlaylists = ref<DiscoveredPlaylist[]>([]);

/** Playlists that have been fetched and loaded for display */
const loadedPlaylists = ref<FetchedPlaylist[]>([]);

// Internal non-reactive state
let metadataCache = new Map<string, CachedPlaylistMetadata>();
let failedPlaylistCache = new Map<string, number>();
let currentUserName: string | null = null;
let currentUserPlaylistIds: Set<string> | null = null;
let userPlaylistsFromApi: PlaylistEntry[] = [];
let likedPlaylistsCache: PlaylistEntry[] | null = null;
let ownedPlaylistsCache: PlaylistEntry[] | null = null;
let preloadedImageUrls = new Set<string>();
let loadNextBatchPromise: Promise<void> | null = null;
let coverUpdateQueue: Array<{ id: string; playlist: FetchedPlaylist; pageSize: number; resolve: () => void }> = [];
let coverUpdatePromises = new Map<string, Promise<void>>();
let coverUpdateInFlight = 0;
let coverUpdateRunning = false;
let rateLimitUntil = 0;
let rateLimitBackoff = 1;
let pendingImageLoads = 0;
let textFilterDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let imageObserver: IntersectionObserver | null = null;
let scrollObserver: IntersectionObserver | null = null;
let sentinelElement: HTMLElement | null = null;


// ---------------------------------------------------------------------------
// Computed
// ---------------------------------------------------------------------------

const statusText = computed(() => {
    if (displayedCount.value >= publicPlaylists.value.length && publicPlaylists.value.length > 0) {
        return format('playlistLoadStatusDone', {
            loaded: displayedCount.value,
            total: publicPlaylists.value.length,
        });
    }
    return format('playlistLoadStatus', {
        loaded: displayedCount.value,
        total: publicPlaylists.value.length,
    });
});

const countBadgeText = computed(() => {
    return `${t('playlistPublicTitle')}: ${publicPlaylists.value.length}`;
});

const isDarkMode = computed(() => {
    return document.body.classList.contains('body--dark') || document.body.classList.contains('q-dark');
});

const cardClass = computed(() => {
    return isDarkMode.value ? 'q-card q-card--dark q-dark' : 'q-card';
});

const fallbackGradient = computed(() => {
    return isDarkMode.value
        ? 'linear-gradient(135deg, #3a3a52 0%, #2a2a3e 50%, #1a1a2e 100%)'
        : 'linear-gradient(135deg, #667eea 0%, #764ba2 50%, #f093fb 100%)';
});

const allLoaded = computed(() => {
    return displayedCount.value >= publicPlaylists.value.length && publicPlaylists.value.length > 0;
});

const showSentinel = computed(() => {
    return isLoading.value || !allLoaded.value;
});

const sentinelText = computed(() => {
    return allLoaded.value ? t('playlistLoadingDone') : t('playlistLoadingMore');
});

// ---------------------------------------------------------------------------
// Cache & Storage helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function loadDiscoveredPlaylists(): void {
    try {
        const stored = GooglePlaylistScraper.safeGetValue(STORAGE_KEY, null);
        if (stored) {
            const parsed = (typeof stored === 'string' ? JSON.parse(stored) : stored) as DiscoveredPlaylist[];
            discoveredPlaylists.value = (parsed || []).filter(p => p.source === 'manual');
            Logger.debug('[PlaylistDiscovery] Loaded', discoveredPlaylists.value.length, 'manual playlists');
        }
    } catch (e) {
        Logger.warn('[PlaylistDiscovery] Failed to load discovered playlists:', e);
        discoveredPlaylists.value = [];
    }
}

function saveDiscoveredPlaylists(): void {
    try {
        const manualOnly = discoveredPlaylists.value.filter(p => p.source === 'manual');
        GooglePlaylistScraper.safeSetValue(STORAGE_KEY, JSON.stringify(manualOnly));
    } catch (e) {
        Logger.warn('[PlaylistDiscovery] Failed to save discovered playlists:', e);
    }
}

function loadMetadataCache(): void {
    try {
        const stored = GooglePlaylistScraper.safeGetValue(METADATA_CACHE_KEY, null);
        if (stored) {
            const entries = (typeof stored === 'string' ? JSON.parse(stored) : stored) as CachedPlaylistMetadata[];
            const now = Date.now();
            metadataCache.clear();
            for (const entry of entries) {
                if (!entry.name || entry.name === UNKNOWN_PLAYLIST_NAME) continue;
                if (now - entry.cachedAt < METADATA_HARD_TTL_MS) {
                    metadataCache.set(entry.id, entry);
                }
            }
            Logger.debug('[PlaylistDiscovery] Loaded', metadataCache.size, 'cached playlist metadata entries');
        }
    } catch (e) {
        Logger.warn('[PlaylistDiscovery] Failed to load metadata cache:', e);
    }
}

function saveMetadataCache(): void {
    try {
        const entries = Array.from(metadataCache.values());
        GooglePlaylistScraper.safeSetValue(METADATA_CACHE_KEY, JSON.stringify(entries));
    } catch (e) {
        Logger.warn('[PlaylistDiscovery] Failed to save metadata cache:', e);
    }
}

function loadFailedPlaylistCache(): void {
    try {
        const stored = GooglePlaylistScraper.safeGetValue(FAILED_PLAYLIST_CACHE_KEY, null);
        if (stored) {
            const entries = (typeof stored === 'string' ? JSON.parse(stored) : stored) as Array<{ id: string; failedAt: number }>;
            const now = Date.now();
            failedPlaylistCache.clear();
            for (const entry of entries) {
                if (now - entry.failedAt < FAILED_PLAYLIST_CACHE_TTL_MS) {
                    failedPlaylistCache.set(entry.id, entry.failedAt);
                }
            }
            if (failedPlaylistCache.size > 0) {
                Logger.debug('[PlaylistDiscovery] Loaded', failedPlaylistCache.size, 'failed playlist IDs');
            }
        }
    } catch (e) {
        Logger.warn('[PlaylistDiscovery] Failed to load failed playlist cache:', e);
    }
}

function saveFailedPlaylistCache(): void {
    try {
        const entries = Array.from(failedPlaylistCache.entries()).map(([id, failedAt]) => ({ id, failedAt }));
        GooglePlaylistScraper.safeSetValue(FAILED_PLAYLIST_CACHE_KEY, JSON.stringify(entries));
    } catch (e) {
        Logger.warn('[PlaylistDiscovery] Failed to save failed playlist cache:', e);
    }
}

function markPlaylistFailed(playlistId: string): void {
    const id = playlistId.toLowerCase();
    failedPlaylistCache.set(id, Date.now());
    saveFailedPlaylistCache();
    Logger.debug('[PlaylistDiscovery] Marked playlist as failed:', id);
}

function isPlaylistFailed(playlistId: string): boolean {
    const id = playlistId.toLowerCase();
    const failedAt = failedPlaylistCache.get(id);
    if (!failedAt) return false;
    if (Date.now() - failedAt < FAILED_PLAYLIST_CACHE_TTL_MS) return true;
    failedPlaylistCache.delete(id);
    return false;
}

function loadSearchCache(): GoogleSearchCache | null {
    try {
        const stored = GooglePlaylistScraper.safeGetValue(CACHE_KEY, null);
        if (stored) return typeof stored === 'string' ? JSON.parse(stored) : stored;
    } catch (e) {
        Logger.warn('[PlaylistDiscovery] Failed to load search cache:', e);
    }
    return null;
}

function saveSearchCache(playlistIds: string[]): void {
    try {
        const cache: GoogleSearchCache = { timestamp: Date.now(), playlistIds };
        GooglePlaylistScraper.safeSetValue(CACHE_KEY, JSON.stringify(cache));
    } catch (e) {
        Logger.warn('[PlaylistDiscovery] Failed to save search cache:', e);
    }
}

function loadPersistedFilterMode(): void {
    try {
        const stored = GooglePlaylistScraper.safeGetValue(FILTER_MODE_STORAGE_KEY, null);
        if (stored && typeof stored === 'string' && ['all', 'mine', 'public', 'online'].includes(stored)) {
            filterMode.value = stored as PlaylistFilterMode;
            Logger.debug('[PlaylistDiscovery] Restored filter mode:', filterMode.value);
        }
    } catch { /* ignore */ }
}

function loadCachedUserPlaylists(): CachedUserPlaylists | null {
    try {
        const stored = GooglePlaylistScraper.safeGetValue(USER_PLAYLISTS_CACHE_KEY, null);
        if (!stored) return null;
        const parsed = (typeof stored === 'string' ? JSON.parse(stored) : stored) as CachedUserPlaylists;
        if (!parsed?.playlists || !parsed.cachedAt) return null;
        if (Date.now() - parsed.cachedAt > USER_PLAYLISTS_HARD_TTL_MS) return null;
        return parsed;
    } catch { return null; }
}

function saveUserPlaylistsCache(): void {
    try {
        const cache: CachedUserPlaylists = {
            playlists: userPlaylistsFromApi,
            userName: currentUserName,
            cachedAt: Date.now(),
        };
        GooglePlaylistScraper.safeSetValue(USER_PLAYLISTS_CACHE_KEY, JSON.stringify(cache));
    } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function fetchAllPlaylistPages(filterBy: 'all' | 'liked' | 'owned', pageSize = 200): Promise<PlaylistEntry[]> {
    const first = await apiRequest<PlaylistListResponse | PlaylistEntry[]>('/api/playlist/get-playlists', {
        page: 1, pageSize, filterBy,
    });
    const firstData = Array.isArray(first) ? first : (first?.playlists || []);
    const pagination = (first as any)?.pagination;
    const totalCount: number = pagination?.totalCount ?? firstData.length;
    const totalPages = Math.ceil(totalCount / pageSize);

    if (totalPages <= 1) return firstData;

    Logger.debug(`[PlaylistDiscovery] Fetching ${totalPages} pages for filterBy=${filterBy} (${totalCount} total)`);

    const remaining = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
    const results = await Promise.allSettled(
        remaining.map(page =>
            apiRequest<PlaylistListResponse | PlaylistEntry[]>('/api/playlist/get-playlists', {
                page, pageSize, filterBy,
            })
        )
    );

    const allPlaylists = [...firstData];
    for (const result of results) {
        if (result.status === 'fulfilled') {
            const data = result.value;
            const more = Array.isArray(data) ? data : (data?.playlists || []);
            allPlaylists.push(...more);
        }
    }

    Logger.debug(`[PlaylistDiscovery] Fetched ${allPlaylists.length}/${totalCount} playlists for filterBy=${filterBy}`);
    return allPlaylists;
}

async function getCurrentUserName(): Promise<string | null> {
    if (currentUserName !== null) return currentUserName;
    try {
        const me = await AuthApi.getCurrentUser();
        const name = me?.user?.name || null;
        currentUserName = name;
        return name;
    } catch (e) {
        Logger.warn('[PlaylistDiscovery] Failed to get current user name:', e);
        currentUserName = null;
        return null;
    }
}

async function fetchUserPlaylists(): Promise<void> {
    try {
        const cached = loadCachedUserPlaylists();
        if (cached) {
            userPlaylistsFromApi = cached.playlists;
            currentUserPlaylistIds = new Set(cached.playlists.map(p => p.id));
            currentUserName = cached.userName;
            Logger.debug(`[PlaylistDiscovery] Loaded ${currentUserPlaylistIds.size} user playlists from cache`);

            if (!likedPlaylistsCache || !ownedPlaylistsCache) {
                if (cached.userName) {
                    ownedPlaylistsCache = cached.playlists.filter(p => p.user_name === cached.userName);
                    likedPlaylistsCache = cached.playlists.filter(p => p.user_name !== cached.userName);
                }
            }

            if (Date.now() - cached.cachedAt > USER_PLAYLISTS_SOFT_TTL_MS) {
                revalidateUserPlaylistsInBackground();
            }
            return;
        }

        await getCurrentUserName();

        const [ownedPlaylists, likedPlaylists_] = await Promise.all([
            fetchAllPlaylistPages('owned'),
            fetchAllPlaylistPages('liked'),
        ]);

        ownedPlaylistsCache = ownedPlaylists;
        likedPlaylistsCache = likedPlaylists_;

        const seenIds = new Set<string>();
        const all: PlaylistEntry[] = [];
        for (const p of [...ownedPlaylists, ...likedPlaylists_]) {
            if (!seenIds.has(p.id)) {
                seenIds.add(p.id);
                all.push(p);
            }
        }

        userPlaylistsFromApi = all;
        currentUserPlaylistIds = seenIds;
        saveUserPlaylistsCache();
        Logger.debug(`[PlaylistDiscovery] Fetched ${ownedPlaylists.length} owned + ${likedPlaylists_.length} liked = ${all.length} user playlists`);
    } catch (e) {
        Logger.warn('[PlaylistDiscovery] Failed to fetch user playlists:', e);
        userPlaylistsFromApi = [];
        currentUserPlaylistIds = new Set();
    }
}

function revalidateUserPlaylistsInBackground(): void {
    setTimeout(async () => {
        try {
            const [owned, liked] = await Promise.all([
                fetchAllPlaylistPages('owned'),
                fetchAllPlaylistPages('liked'),
            ]);

            ownedPlaylistsCache = owned;
            likedPlaylistsCache = liked;

            const seenIds = new Set<string>();
            const playlists: PlaylistEntry[] = [];
            for (const p of [...owned, ...liked]) {
                if (!seenIds.has(p.id)) {
                    seenIds.add(p.id);
                    playlists.push(p);
                }
            }

            const oldIds = currentUserPlaylistIds || new Set<string>();
            const changed = oldIds.size !== seenIds.size || [...oldIds].some(id => !seenIds.has(id));

            userPlaylistsFromApi = playlists;
            currentUserPlaylistIds = seenIds;
            saveUserPlaylistsCache();

            if (changed) {
                Logger.debug('[PlaylistDiscovery] User playlists changed in background');
                applyFilterMode();
            }
        } catch {
            // Silent failure for background revalidation
        }
    }, 3000);
}

// ---------------------------------------------------------------------------
// Playlist data management
// ---------------------------------------------------------------------------

function mergeSearchResults(playlistIds: string[]): void {
    const normalizedIds = playlistIds.map(id => id.toLowerCase());
    const existingIds = new Set(discoveredPlaylists.value.map(p => p.id.toLowerCase()));
    let addedCount = 0;

    for (const id of normalizedIds) {
        if (!existingIds.has(id)) {
            discoveredPlaylists.value.push({
                id,
                discovered_at: Date.now(),
                source: 'google' as const,
            });
            existingIds.add(id);
            addedCount++;
        }
    }

    Logger.debug(`[PlaylistDiscovery] Merged ${addedCount} new playlists (${normalizedIds.length} provided, ${existingIds.size} total unique)`);
    if (addedCount > 0) {
        saveDiscoveredPlaylists();
    }
}

function entriesToDiscovered(entries: PlaylistEntry[]): DiscoveredPlaylist[] {
    const sorted = [...entries].sort((a, b) => {
        const dateA = a.created_at ? new Date(a.created_at).getTime() : 0;
        const dateB = b.created_at ? new Date(b.created_at).getTime() : 0;
        return dateB - dateA;
    });
    return sorted.map(p => ({
        id: p.id,
        name: p.name,
        user_name: p.user_name,
        works_count: p.works_count ?? p.worksCount,
        discovered_at: p.created_at ? new Date(p.created_at).getTime() : Date.now(),
        source: 'user' as const,
    }));
}

function matchesTextFilter(d: DiscoveredPlaylist): boolean {
    if (!textFilter.value) return true;
    const filter = textFilter.value.toLowerCase();
    const cached = metadataCache.get(d.id);
    const name = (cached?.name || d.name || '').toLowerCase();
    const userName = (cached?.user_name || d.user_name || '').toLowerCase();
    return name.includes(filter) || userName.includes(filter);
}

function applyFilterMode(): void {
    const myIds = currentUserPlaylistIds || new Set<string>();

    const hasWorks = (d: DiscoveredPlaylist): boolean => {
        const cached = metadataCache.get(d.id);
        const worksCount = cached?.worksCount ?? d.works_count;
        return worksCount === undefined || worksCount > 0;
    };

    const ownedAsDiscovered = ownedPlaylistsCache
        ? entriesToDiscovered(ownedPlaylistsCache)
        : [];
    const likedAsDiscovered = likedPlaylistsCache
        ? entriesToDiscovered(likedPlaylistsCache)
        : [];

    const allUserPlaylistsAsDiscovered = (ownedAsDiscovered.length > 0 || likedAsDiscovered.length > 0)
        ? [...ownedAsDiscovered, ...likedAsDiscovered]
        : entriesToDiscovered(userPlaylistsFromApi);

    const publicOnly = discoveredPlaylists.value.filter(d => !myIds.has(d.id) && hasWorks(d));

    let result: DiscoveredPlaylist[];

    if (filterMode.value === 'all') {
        const seenIds = new Set<string>();
        const merged: DiscoveredPlaylist[] = [];

        for (const p of ownedAsDiscovered) {
            if (!seenIds.has(p.id.toLowerCase())) {
                seenIds.add(p.id.toLowerCase());
                merged.push(p);
            }
        }
        for (const p of likedAsDiscovered) {
            if (!seenIds.has(p.id.toLowerCase())) {
                seenIds.add(p.id.toLowerCase());
                merged.push(p);
            }
        }
        if (ownedAsDiscovered.length === 0 && likedAsDiscovered.length === 0) {
            for (const p of allUserPlaylistsAsDiscovered) {
                if (!seenIds.has(p.id.toLowerCase())) {
                    seenIds.add(p.id.toLowerCase());
                    merged.push(p);
                }
            }
        }
        for (const p of publicOnly) {
            if (!seenIds.has(p.id.toLowerCase()) && hasWorks(p)) {
                seenIds.add(p.id.toLowerCase());
                merged.push(p);
            }
        }
        result = merged;
    } else if (filterMode.value === 'mine') {
        result = likedAsDiscovered.length > 0 ? likedAsDiscovered : [];
    } else if (filterMode.value === 'public') {
        result = ownedAsDiscovered.length > 0 ? ownedAsDiscovered : allUserPlaylistsAsDiscovered;
    } else if (filterMode.value === 'online') {
        result = publicOnly;
    } else {
        result = publicOnly;
    }

    if (textFilter.value) {
        result = result.filter(d => matchesTextFilter(d));
    }

    publicPlaylists.value = result;
}

// ---------------------------------------------------------------------------
// Card data helper -- resolve display info for a playlist
// ---------------------------------------------------------------------------

interface PlaylistCardData {
    id: string;
    name: string;
    userName: string;
    worksCount: number;
    coverUrl: string;
    sourceBadge: string | null;
    isPreloaded: boolean;
}

function getCardData(playlist: FetchedPlaylist): PlaylistCardData {
    const discovered = playlist.discovered;
    const rawId = playlist.id || discovered?.id || '';
    const playlistId = rawId.toLowerCase();

    let coverUrl = playlist.coverUrl || '';
    if (!coverUrl && playlist.works && playlist.works.length > 0) {
        const firstWork = playlist.works[0];
        if (firstWork && typeof firstWork === 'object' && 'mainCoverUrl' in firstWork) {
            coverUrl = (firstWork as { mainCoverUrl?: string }).mainCoverUrl || '';
        }
    }

    const worksCount = playlist.worksCount || playlist.works?.length || discovered?.works_count || 0;
    const userName = playlist.user_name || discovered?.user_name || 'Unknown';
    const playlistName = playlist.name || discovered?.name || 'Unnamed Playlist';
    const sourceBadge = discovered?.source === 'manual' ? t('playlistAddedBadge') : null;
    const isPreloaded = !!(coverUrl && preloadedImageUrls.has(coverUrl));

    return {
        id: playlistId,
        name: playlistName,
        userName,
        worksCount,
        coverUrl,
        sourceBadge,
        isPreloaded,
    };
}

// ---------------------------------------------------------------------------
// Image preloading
// ---------------------------------------------------------------------------

function preloadImage(url: string): Promise<void> {
    if (!url || preloadedImageUrls.has(url)) return Promise.resolve();
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => { preloadedImageUrls.add(url); resolve(); };
        img.onerror = () => resolve();
        img.src = url;
        setTimeout(resolve, 3000);
    });
}

// ---------------------------------------------------------------------------
// Cover update queue
// ---------------------------------------------------------------------------

function enqueueCoverUpdate(playlist: FetchedPlaylist, pageSize: number): Promise<void> {
    const rawId = playlist.id || playlist.discovered?.id || '';
    const playlistId = rawId.toLowerCase();
    if (!playlistId) return Promise.resolve();

    const existing = coverUpdatePromises.get(playlistId);
    if (existing) return existing;

    let resolveFn: () => void = () => {};
    const promise = new Promise<void>((resolve) => { resolveFn = resolve; });
    coverUpdatePromises.set(playlistId, promise);
    coverUpdateQueue.push({ id: playlistId, playlist, pageSize, resolve: resolveFn });
    processCoverUpdateQueue();
    return promise;
}

function processCoverUpdateQueue(): void {
    if (coverUpdateRunning) return;
    coverUpdateRunning = true;

    const pump = async () => {
        while (coverUpdateQueue.length > 0) {
            const now = Date.now();
            if (now < rateLimitUntil) {
                const wait = rateLimitUntil - now;
                Logger.debug(`[PlaylistDiscovery] Rate limit active, pausing queue for ${Math.ceil(wait / 1000)}s`);
                await delay(wait);
                continue;
            }

            while (coverUpdateInFlight < COVER_UPDATE_CONCURRENCY && coverUpdateQueue.length > 0) {
                const next = coverUpdateQueue.shift();
                if (!next) break;

                coverUpdateInFlight += 1;
                updatePlaylistCoverAndCount(next.playlist, next.pageSize)
                    .then((success) => {
                        if (success) {
                            rateLimitBackoff = Math.max(1, rateLimitBackoff * 0.9);
                        }
                    })
                    .catch((err: any) => {
                        if (err?.status === 429) {
                            rateLimitBackoff = Math.min(rateLimitBackoff * 2, 30);
                            rateLimitUntil = Date.now() + (5000 * rateLimitBackoff);
                            Logger.warn(`[PlaylistDiscovery] Rate limit hit! Backing off for ${5 * rateLimitBackoff}s`);
                        }
                    })
                    .finally(() => {
                        coverUpdateInFlight = Math.max(0, coverUpdateInFlight - 1);
                        coverUpdatePromises.delete(next.id);
                        next.resolve();
                    });

                if (COVER_UPDATE_DELAY_MS > 0) {
                    await delay(COVER_UPDATE_DELAY_MS);
                }
            }
            await delay(200);
        }
        coverUpdateRunning = false;
    };

    void pump();
}

async function updatePlaylistCoverAndCount(playlist: FetchedPlaylist, pageSize: number): Promise<boolean> {
    const rawId = playlist.id || playlist.discovered?.id || '';
    const playlistId = rawId.toLowerCase();
    if (!playlistId) return false;

    const cached = metadataCache.get(playlistId);
    if (cached?.coverUrlResolved && cached.coverUrl && playlist.worksCount > 0) {
        if (cached.coverUrl !== playlist.coverUrl) {
            playlist.coverUrl = cached.coverUrl;
            updateLoadedPlaylist(playlistId, playlist);
        }
        if (cached.cachedAt && Date.now() - cached.cachedAt > METADATA_SOFT_TTL_MS) {
            scheduleBackgroundCoverRevalidation(playlistId, playlist, pageSize);
        }
        return true;
    }

    if (playlist.coverUrl && playlist.worksCount > 0) return true;

    try {
        const worksData = await apiRequest<PlaylistWorksResponse>('/api/playlist/get-playlist-works', {
            id: playlistId, page: 1, pageSize,
        });
        const works = Array.isArray(worksData.works) ? worksData.works : [];
        const firstWork = works[0] as { mainCoverUrl?: string; thumbnailCoverUrl?: string; samCoverUrl?: string } | undefined;
        const coverUrl = firstWork?.mainCoverUrl || firstWork?.thumbnailCoverUrl || firstWork?.samCoverUrl || '';
        const totalCount = worksData.pagination?.totalCount;

        let changed = false;
        if (coverUrl && coverUrl !== playlist.coverUrl) {
            playlist.coverUrl = coverUrl;
            changed = true;
        }
        if (typeof totalCount === 'number' && totalCount >= 0 && totalCount !== playlist.worksCount) {
            playlist.worksCount = totalCount;
            changed = true;
        }

        if (!changed) return true;

        if (playlist.discovered) {
            playlist.discovered.works_count = playlist.worksCount;
        }

        metadataCache.set(playlistId, {
            id: playlistId,
            name: playlist.name || 'Unnamed',
            user_name: playlist.user_name || '',
            worksCount: playlist.worksCount || 0,
            latestWorkId: 0,
            coverUrl: playlist.coverUrl || '',
            coverUrlResolved: true,
            cachedAt: Date.now(),
        });
        saveMetadataCache();

        updateLoadedPlaylist(playlistId, playlist);
        return true;
    } catch (error: any) {
        Logger.warn(`[PlaylistDiscovery] Failed to update cover/count for ${playlistId}:`, error);
        if (error?.status === 429) throw error;
        return false;
    }
}

function scheduleBackgroundCoverRevalidation(playlistId: string, playlist: FetchedPlaylist, pageSize: number): void {
    setTimeout(async () => {
        try {
            const worksData = await apiRequest<PlaylistWorksResponse>('/api/playlist/get-playlist-works', {
                id: playlistId, page: 1, pageSize,
            });
            const works = Array.isArray(worksData.works) ? worksData.works : [];
            const firstWork = works[0] as { mainCoverUrl?: string; thumbnailCoverUrl?: string; samCoverUrl?: string } | undefined;
            const newCoverUrl = firstWork?.mainCoverUrl || firstWork?.thumbnailCoverUrl || firstWork?.samCoverUrl || '';
            const newCount = worksData.pagination?.totalCount;

            let changed = false;
            if (newCoverUrl && newCoverUrl !== playlist.coverUrl) {
                playlist.coverUrl = newCoverUrl;
                changed = true;
            }
            if (typeof newCount === 'number' && newCount !== playlist.worksCount) {
                playlist.worksCount = newCount;
                changed = true;
            }

            metadataCache.set(playlistId, {
                id: playlistId,
                name: playlist.name || 'Unnamed',
                user_name: playlist.user_name || '',
                worksCount: playlist.worksCount || 0,
                latestWorkId: 0,
                coverUrl: playlist.coverUrl || '',
                coverUrlResolved: true,
                cachedAt: Date.now(),
            });
            saveMetadataCache();

            if (changed) {
                updateLoadedPlaylist(playlistId, playlist);
            }
        } catch {
            // Silent failure for background revalidation
        }
    }, 2000 + Math.random() * 3000);
}

/** Update a playlist in the loadedPlaylists array to trigger Vue reactivity */
function updateLoadedPlaylist(playlistId: string, playlist: FetchedPlaylist): void {
    const idx = loadedPlaylists.value.findIndex(p => (p.id || p.discovered?.id || '').toLowerCase() === playlistId);
    if (idx >= 0) {
        loadedPlaylists.value[idx] = { ...playlist, id: playlistId };
    }
}

// ---------------------------------------------------------------------------
// Batch loading
// ---------------------------------------------------------------------------

async function queueLoadNextBatch(): Promise<void> {
    if (loadNextBatchPromise) return loadNextBatchPromise;
    loadNextBatchPromise = loadNextBatch().finally(() => {
        loadNextBatchPromise = null;
    });
    return loadNextBatchPromise;
}

async function loadNextBatch(): Promise<void> {
    if (isLoading.value) return;
    isLoading.value = true;

    const startIdx = displayedCount.value;
    const endIdx = Math.min(startIdx + BATCH_SIZE, publicPlaylists.value.length);

    if (startIdx >= publicPlaylists.value.length) {
        Logger.debug('[PlaylistDiscovery] All playlists loaded');
        isLoading.value = false;
        return;
    }

    try {
        Logger.debug(`[PlaylistDiscovery] Loading batch ${startIdx} to ${endIdx}`);
        const batchItems = publicPlaylists.value.slice(startIdx, endIdx);
        const coverUpdatePromisesList: Promise<void>[] = [];

        const uncachedItems: DiscoveredPlaylist[] = [];
        const cachedItems: FetchedPlaylist[] = [];

        for (const discovered of batchItems) {
            if (isPlaylistFailed(discovered.id)) continue;

            const cached = metadataCache.get(discovered.id);
            if (cached) {
                cachedItems.push({
                    id: cached.id,
                    name: cached.name,
                    user_name: cached.user_name,
                    worksCount: cached.worksCount,
                    coverUrl: cached.coverUrl,
                    works: [],
                    privacy: 2,
                    discovered,
                } as FetchedPlaylist);
            } else {
                uncachedItems.push(discovered);
            }
        }

        // Preload images for cached items with known cover URLs
        const preloadPromises: Promise<void>[] = [];
        for (const item of cachedItems) {
            if (item.coverUrl && item.worksCount > 0) {
                preloadPromises.push(preloadImage(item.coverUrl));
            }
        }
        if (preloadPromises.length > 0) {
            await Promise.race([
                Promise.all(preloadPromises),
                delay(500),
            ]);
        }

        // Render cached items
        for (const item of cachedItems) {
            const isUserPlaylist = currentUserPlaylistIds?.has(item.id) ||
                                  item.discovered?.source === 'user';
            if (!isUserPlaylist && item.worksCount === 0) continue;

            loadedPlaylists.value.push(item);
            const cachedMeta = metadataCache.get(item.id.toLowerCase());
            if (!cachedMeta?.coverUrlResolved || !item.coverUrl) {
                coverUpdatePromisesList.push(enqueueCoverUpdate(item, WORKS_PAGE_SIZE));
            }
        }

        // Fetch uncached items
        if (uncachedItems.length > 0) {
            for (let i = 0; i < uncachedItems.length; i += METADATA_BATCH_SIZE) {
                const fetchBatch = uncachedItems.slice(i, i + METADATA_BATCH_SIZE);
                const results = await Promise.allSettled(
                    fetchBatch.map(async (discovered): Promise<PlaylistFetchResult> => {
                        try {
                            const metadata = await apiRequest<PlaylistMetadata>('/api/playlist/get-playlist-metadata', { id: discovered.id });
                            if (!metadata?.id || !metadata?.name || metadata.name === UNKNOWN_PLAYLIST_NAME) {
                                throw new Error('Invalid playlist metadata');
                            }
                            const worksCount = metadata.works_count || 0;
                            const coverUrl = '';

                            if (metadata.name) discovered.name = metadata.name;
                            if (metadata.user_name) discovered.user_name = metadata.user_name;
                            if (typeof worksCount === 'number' && worksCount >= 0) {
                                discovered.works_count = worksCount;
                            }

                            return { ok: true, playlist: { ...metadata, worksCount, coverUrl, discovered } };
                        } catch (e) {
                            Logger.error('[PlaylistDiscovery] Failed to fetch:', discovered.id);
                            markPlaylistFailed(discovered.id);
                            return { ok: false, id: discovered.id };
                        }
                    })
                );

                for (const result of results) {
                    if (result.status !== 'fulfilled' || !result.value) continue;
                    if (!result.value.ok) continue;

                    const playlist = result.value.playlist;
                    const playlistId = playlist.id || playlist.discovered?.id;

                    const isUserPlaylist = currentUserPlaylistIds?.has(playlistId) ||
                                          playlist.discovered?.source === 'user';
                    if (!isUserPlaylist && playlist.worksCount === 0) continue;

                    if (playlistId) {
                        const finalId = playlistId.toLowerCase();
                        const finalPlaylist = { ...playlist, id: finalId };
                        loadedPlaylists.value.push(finalPlaylist);

                        metadataCache.set(finalId, {
                            id: finalId,
                            name: playlist.name || 'Unnamed',
                            user_name: playlist.user_name || '',
                            worksCount: playlist.worksCount || 0,
                            coverUrl: playlist.coverUrl || '',
                            cachedAt: Date.now(),
                        });

                        coverUpdatePromisesList.push(enqueueCoverUpdate(finalPlaylist, WORKS_PAGE_SIZE));
                    }
                }

                if (i + METADATA_BATCH_SIZE < uncachedItems.length) {
                    await delay(BATCH_COOLDOWN_MS);
                }
            }
            saveDiscoveredPlaylists();
            saveMetadataCache();
        }

        displayedCount.value = endIdx;

        // Wait for all cover updates to finish before allowing the next batch,
        // so we don't flood the API with concurrent metadata + cover requests (429).
        if (coverUpdatePromisesList.length > 0) {
            await Promise.allSettled(coverUpdatePromisesList);
        }
    } catch (error) {
        Logger.error('[PlaylistDiscovery] Failed to load batch:', error);
    } finally {
        isLoading.value = false;

        // Auto-load next batch if sentinel is in view and infinite scroll enabled
        if (enableInfiniteScroll.value && sentinelVisible.value && displayedCount.value < publicPlaylists.value.length) {
            setTimeout(() => {
                if (!isLoading.value && sentinelVisible.value) {
                    queueLoadNextBatch();
                }
            }, BATCH_COOLDOWN_MS);
        }
    }
}

// ---------------------------------------------------------------------------
// Observers (infinite scroll + lazy images)
// ---------------------------------------------------------------------------

function setupObservers(): void {
    if (typeof IntersectionObserver === 'undefined') {
        Logger.warn('[PlaylistDiscovery] IntersectionObserver unavailable');
        return;
    }

    // Image observer for lazy loading
    imageObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const el = entry.target as HTMLImageElement;
                const src = el.dataset.src;
                if (src) {
                    el.src = src;
                    el.removeAttribute('data-src');
                    el.classList.add('loaded');
                }
                observer.unobserve(el);
            }
        });
    }, {
        rootMargin: '200px 0px',
        threshold: 0.01,
    });

    // Scroll observer for infinite scrolling
    if (enableInfiniteScroll.value) {
        scrollObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                sentinelVisible.value = entry.isIntersecting;
                if (entry.isIntersecting && !isLoading.value) {
                    Logger.debug('[PlaylistDiscovery] Sentinel intersected, loading next batch');
                    queueLoadNextBatch();
                }
            });
        }, {
            rootMargin: '400px',
            threshold: 0.1,
        });
    }
}

function cleanupObservers(): void {
    if (imageObserver) {
        imageObserver.disconnect();
        imageObserver = null;
    }
    if (scrollObserver) {
        scrollObserver.disconnect();
        scrollObserver = null;
    }
}

// Sentinel element ref callback
function onSentinelRef(el: HTMLElement | null) {
    sentinelElement = el;
    if (el && scrollObserver) {
        scrollObserver.observe(el);
    }
}

// Lazy image ref callback -- called for each card image via :ref
function onLazyImageMounted(el: HTMLElement | null) {
    if (el && el.dataset.src && imageObserver) {
        imageObserver.observe(el);
    }
}

// ---------------------------------------------------------------------------
// User actions
// ---------------------------------------------------------------------------

async function handleSearch(): Promise<void> {
    if (isSearching.value) return;

    if (GooglePlaylistScraper.isRateLimited()) {
        searchFeedback.value = { type: 'warning', text: 'Rate limited by Google. Try again in 30 minutes.' };
        return;
    }

    isSearching.value = true;
    searchFeedback.value = { type: 'info', text: t('playlistSearching') };

    try {
        const playlistIds = await GooglePlaylistScraper.discoverPlaylists(
            (page, found) => {
                searchFeedback.value = { type: 'info', text: format('playlistSearchingPage', { page, found }) };
            }
        );

        if (playlistIds.length > 0) {
            saveSearchCache(playlistIds);
            mergeSearchResults(playlistIds);
            applyFilterMode();

            if (!isLoading.value) {
                void queueLoadNextBatch();
            }

            searchFeedback.value = { type: 'success', text: `Found ${playlistIds.length} playlists from Google` };
            setTimeout(() => { searchFeedback.value = null; }, 3000);
        } else {
            searchFeedback.value = { type: 'info', text: 'No new playlists found' };
            setTimeout(() => { searchFeedback.value = null; }, 3000);
        }
    } catch (e) {
        Logger.error('[PlaylistDiscovery] Manual search failed:', e);
        searchFeedback.value = { type: 'error', text: t('playlistSearchFailed') };
    } finally {
        isSearching.value = false;
    }
}

function handleRandomize(): void {
    // Fisher-Yates shuffle
    const arr = [...publicPlaylists.value];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    publicPlaylists.value = arr;

    // Reset display
    loadedPlaylists.value = [];
    displayedCount.value = 0;
    void queueLoadNextBatch();
}

function handleFilterChange(event: Event): void {
    const mode = (event.target as HTMLSelectElement).value as PlaylistFilterMode;
    setFilterMode(mode);
}

function handleAddPlaylist(): void {
    // Click the native "+" button (hidden in the native header row)
    const nativeBtn = document.querySelector(
        '.q-layout-padding > .row.q-px-sm .q-btn:has(.material-icons)',
    ) as HTMLElement | null;
    if (nativeBtn) {
        nativeBtn.click();
    }
}

function handleTextFilterInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    if (textFilterDebounceTimer) clearTimeout(textFilterDebounceTimer);
    textFilterDebounceTimer = setTimeout(() => {
        textFilter.value = value.trim().toLowerCase();
        applyFilterMode();
        loadedPlaylists.value = [];
        displayedCount.value = 0;
        void queueLoadNextBatch();
    }, 300);
}

function setFilterMode(mode: PlaylistFilterMode): void {
    if (filterMode.value === mode) return;
    filterMode.value = mode;

    try { GooglePlaylistScraper.safeSetValue(FILTER_MODE_STORAGE_KEY, mode); } catch { /* ignore */ }

    const needsApiFetch =
        (mode === 'mine' && !likedPlaylistsCache) ||
        (mode === 'public' && !ownedPlaylistsCache);

    if (needsApiFetch) {
        const filterBy = mode === 'mine' ? 'liked' : 'owned';

        fetchAllPlaylistPages(filterBy).then(playlists => {
            if (mode === 'mine') likedPlaylistsCache = playlists;
            else ownedPlaylistsCache = playlists;

            if (filterMode.value === mode) {
                applyFilterMode();
                loadedPlaylists.value = [];
                displayedCount.value = 0;
                void queueLoadNextBatch();
            }
        });
        return;
    }

    applyFilterMode();
    loadedPlaylists.value = [];
    displayedCount.value = 0;
    void queueLoadNextBatch();
}

function handleLoadMore(): void {
    void queueLoadNextBatch();
}

// ---------------------------------------------------------------------------
// Vue Router patching
// ---------------------------------------------------------------------------

function patchVueRouter(): void {
    try {
        const router = bridge.router;
        if (!router || (router as any).__asmrPatched) return;

        const originalPush = router.push.bind(router);
        const originalReplace = router.replace?.bind(router);

        router.push = function (location: any, onComplete?: any, onAbort?: any) {
            return (originalPush as any)(location, onComplete, onAbort).catch((err: any) => {
                if (err?.name === 'NavigationDuplicated' ||
                    err?.message?.includes('Avoided redundant navigation')) {
                    return Promise.resolve();
                }
                throw err;
            });
        };

        if (originalReplace) {
            router.replace = function (location: any, onComplete?: any, onAbort?: any) {
                return (originalReplace as any)(location, onComplete, onAbort).catch((err: any) => {
                    if (err?.name === 'NavigationDuplicated' ||
                        err?.message?.includes('Avoided redundant navigation')) {
                        return Promise.resolve();
                    }
                    throw err;
                });
            };
        }

        (router as any).__asmrPatched = true;
        Logger.debug('[PlaylistDiscovery] Patched Vue Router to handle NavigationDuplicated');
    } catch (e) {
        Logger.warn('[PlaylistDiscovery] Failed to patch Vue Router:', e);
    }
}

// ---------------------------------------------------------------------------
// Native grid hiding
// ---------------------------------------------------------------------------

let nativeGridHidden = false;

function hideNativeGridAndPagination(): void {
    if (nativeGridHidden) return;

    const styleId = 'asmr-ultimate-playlist-takeover-style';
    if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            /* Hide native playlist grid (but not ours) */
            .q-page .row.q-col-gutter-x-md.q-col-gutter-y-md:not(#public-playlists-grid):not(#asmr-playlist-discovery-root *) {
                display: none !important;
            }
            /* Hide native ant-pagination */
            .q-page .ant-pagination,
            .q-page .q-pt-lg.q-pb-md.flex.flex-center,
            .q-page .q-py-lg.flex.flex-center:has(.ant-pagination),
            .q-page > div:has(.ant-pagination) {
                display: none !important;
            }
            /* Hide native header row (QSelect + "+" button) — we render our own */
            .q-page > .q-layout-padding > .row.q-px-sm.q-py-sm:has(.q-select),
            .q-page > .row.q-px-sm.q-py-sm:has(.q-select),
            .q-layout-padding > .row.q-px-sm.q-py-sm:has(.q-select) {
                display: none !important;
            }
        `;
        document.head.appendChild(style);
        Logger.debug('[PlaylistDiscovery] Injected takeover styles');
    }

    nativeGridHidden = true;
}

function restoreNativeGridAndPagination(): void {
    if (!nativeGridHidden) return;

    const styles = ['asmr-ultimate-playlist-takeover-style', 'asmr-ultimate-playlist-pagination-hide'];
    styles.forEach(id => {
        document.getElementById(id)?.remove();
    });

    document.getElementById('asmr-playlist-inline-status')?.remove();
    document.getElementById('asmr-playlist-scroll-sentinel')?.remove();

    nativeGridHidden = false;
    Logger.debug('[PlaylistDiscovery] Restored native UI');
}

// ---------------------------------------------------------------------------
// Inject "Online only" option into native dropdown
// ---------------------------------------------------------------------------

function setupNativeFilterWatcher(): void {
    const select = document.querySelector('.q-page .q-select');
    const selectVue = (select as any)?.__vue__;

    if (!selectVue) {
        Logger.warn('[PlaylistDiscovery] Could not find native filter dropdown');
        return;
    }

    const options = selectVue.options;
    if (Array.isArray(options)) {
        const onlineLabel = t('playlistOnlineOnly');
        const hasOnlineOption = options.some((opt: any) =>
            opt?.label === onlineLabel || opt?.value === 'online'
        );

        if (!hasOnlineOption) {
            const sampleOption = options[0];
            const onlineOption = sampleOption && typeof sampleOption === 'object'
                ? { ...sampleOption, label: onlineLabel, value: 'online' }
                : { label: onlineLabel, value: 'online' };
            options.push(onlineOption);
            Logger.debug('[PlaylistDiscovery] Injected "Online only" option into native dropdown');
        }
    }

    if (selectVue.$watch) {
        const nativeFilterUnwatch = selectVue.$watch('value', (newVal: any) => {
            const valueLabel = newVal?.label || newVal?.value || '';
            const valueLower = String(valueLabel).toLowerCase();
            const onlineLabelLower = t('playlistOnlineOnly').toLowerCase();

            let newMode: PlaylistFilterMode = 'all';
            if (valueLower.includes('online') || valueLower === onlineLabelLower || valueLower.includes('\u30AA\u30F3\u30E9\u30A4\u30F3') || valueLower.includes('\u4EC5\u5728\u7EBF')) {
                newMode = 'online';
            } else if (valueLower.includes('liked') || valueLower.includes('\u304A\u6C17\u306B\u5165\u308A') || valueLower.includes('\u559C\u6B22')) {
                newMode = 'mine';
            } else if (valueLower.includes('created') || valueLower.includes('\u4F5C\u6210') || valueLower.includes('\u521B\u5EFA')) {
                newMode = 'public';
            }

            Logger.debug('[PlaylistDiscovery] Native filter changed:', valueLabel, '-> mode:', newMode);
            setFilterMode(newMode);
        }, { immediate: false });

        Logger.debug('[PlaylistDiscovery] Native filter watcher attached');
    }
}


// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function initializeDiscovery(): Promise<void> {
    Logger.log('[PlaylistDiscovery] Initializing');

    patchVueRouter();

    // Load persisted state
    loadDiscoveredPlaylists();
    loadFailedPlaylistCache();
    loadPersistedFilterMode();
    loadMetadataCache();

    // Merge hardcoded known playlist IDs
    mergeSearchResults(KNOWN_PLAYLIST_IDS);

    // Merge cached Google search results
    const cached = loadSearchCache();
    if (cached && cached.playlistIds.length > 0) {
        const cacheAge = Date.now() - cached.timestamp;
        Logger.debug(`[PlaylistDiscovery] Merging cached results (age: ${Math.round(cacheAge / 60000)}min):`, cached.playlistIds.length);
        mergeSearchResults(cached.playlistIds);
    }

    // Hide native grid + pagination
    hideNativeGridAndPagination();

    // Fetch user playlists in background — don't block first batch render.
    // "mine" filter will update when this resolves.
    void fetchUserPlaylists().then(() => {
        // Re-apply filter if user had "mine" persisted, now that data is available
        if (filterMode.value === 'mine') {
            applyFilterMode();
        }
    });

    // Apply filter mode (works for 'all'/'public'/'online' without user data)
    applyFilterMode();

    Logger.debug(`[PlaylistDiscovery] Found ${publicPlaylists.value.length} playlists to display (filter: ${filterMode.value}).`);

    // Setup observers
    setupObservers();

    // Sync with native filter dropdown (if present)
    await nextTick();
    setupNativeFilterWatcher();

    // Load first batch
    await queueLoadNextBatch();
}

onMounted(() => {
    void initializeDiscovery();
});

onUnmounted(() => {
    Logger.log('[PlaylistDiscovery] Cleaning up');

    if (textFilterDebounceTimer) {
        clearTimeout(textFilterDebounceTimer);
        textFilterDebounceTimer = null;
    }

    cleanupObservers();
    restoreNativeGridAndPagination();

    // Clear display state but NOT cache state
    displayedCount.value = 0;
    loadedPlaylists.value = [];
    preloadedImageUrls.clear();
});
</script>

<template>
    <div id="asmr-ultimate-public-playlists" class="q-pa-md" style="position: relative;">
        <!-- Controls Row (native QSelect + filter + buttons + native "+" are merged here) -->
        <div
            id="asmr-playlist-discovery-controls"
            class="col-auto row items-center asmr-playlist-controls"
        >
            <!-- Filter Mode Dropdown -->
            <select
                class="asmr-playlist-filter-select"
                :aria-label="t('playlistFilterPlaceholder') || 'Filter playlists'"
                :value="filterMode"
                @change="handleFilterChange"
            >
                <option value="all">{{ t('playlistFilterAll') }}</option>
                <option value="mine">{{ t('playlistFilterMine') }}</option>
                <option value="public">{{ t('playlistFilterPublic') }}</option>
                <option value="online">{{ t('playlistOnlineOnly') }}</option>
            </select>

            <!-- Text Filter -->
            <input
                type="text"
                class="asmr-playlist-text-filter"
                :aria-label="t('playlistFilterPlaceholder') || 'Filter playlists'"
                :placeholder="t('playlistFilterPlaceholder')"
                @input="handleTextFilterInput"
            />

            <!-- Count Badge -->
            <span class="text-caption asmr-playlist-count">
                {{ countBadgeText }}
            </span>

            <!-- Search Button -->
            <button
                class="q-btn q-btn-item non-selectable no-outline q-btn--flat q-btn--rectangle q-btn--actionable q-focusable q-hoverable asmr-playlist-action"
                :aria-label="t('playlistFindMore')"
                :title="t('playlistFindMore')"
                :disabled="isSearching"
                :style="{ opacity: isSearching ? '0.6' : '1' }"
                @click="handleSearch"
            >
                <span class="q-btn__content text-center col items-center q-anchor--skip justify-center row">
                    <i class="q-icon notranslate material-icons">search</i>
                    {{ isSearching ? t('playlistSearchingButton') : t('playlistFindMore') }}
                </span>
            </button>

            <!-- Randomize Button -->
            <button
                class="q-btn q-btn-item non-selectable no-outline q-btn--flat q-btn--rectangle q-btn--actionable q-focusable q-hoverable asmr-playlist-action"
                :aria-label="t('playlistRandomize')"
                :title="t('playlistRandomize')"
                @click="handleRandomize"
            >
                <span class="q-btn__content text-center col items-center q-anchor--skip justify-center row">
                    <i class="q-icon notranslate material-icons">shuffle</i>
                    {{ t('playlistRandomize') }}
                </span>
            </button>

            <!-- Spacer to push "+" button to the right -->
            <span class="asmr-playlist-controls-spacer"></span>

            <!-- Add Playlist Button -->
            <button
                class="q-btn q-btn-item non-selectable no-outline q-btn--flat q-btn--round q-btn--actionable q-focusable q-hoverable"
                :aria-label="t('addPlaylist') || 'Add playlist'"
                :title="t('addPlaylist') || 'Add playlist'"
                @click="handleAddPlaylist"
            >
                <span class="q-btn__content text-center col items-center q-anchor--skip justify-center row">
                    <i class="q-icon notranslate material-icons">add</i>
                </span>
            </button>
        </div>

        <!-- Status Row -->
        <div>
            <div class="text-caption q-mb-sm" style="opacity: 0.7;">
                {{ statusText }}
            </div>
            <div
                v-if="searchFeedback"
                style="margin-bottom: 8px;"
            >
                <span
                    class="text-caption"
                    :style="{
                        color: searchFeedback.type === 'info' ? 'var(--q-info)' :
                               searchFeedback.type === 'success' ? 'var(--q-positive)' :
                               searchFeedback.type === 'warning' ? 'var(--q-warning)' :
                               'var(--q-negative)'
                    }"
                >
                    {{ searchFeedback.text }}
                </span>
            </div>
        </div>

        <!-- Playlist Grid -->
        <div id="public-playlists-grid" class="row q-col-gutter-x-md q-col-gutter-y-md">
            <div
                v-for="playlist in loadedPlaylists"
                :key="getCardData(playlist).id"
                class="col-xs-6 col-sm-3 col-md-2 col-lg-2 col-xl-2"
                :data-playlist-id="getCardData(playlist).id"
            >
                <div :class="cardClass">
                    <a :href="`/playlist?id=${getCardData(playlist).id}`">
                        <div role="img" class="q-img overflow-hidden q-img--menu" style="max-width: 560px;">
                            <div style="padding-bottom: 75%;"></div>
                            <!-- Cover image -->
                            <div
                                v-if="getCardData(playlist).coverUrl"
                                class="q-img__image absolute-full"
                                style="background-size: cover; background-position: 50% 50%;"
                            >
                                <div
                                    v-if="getCardData(playlist).isPreloaded"
                                    class="absolute-full fit playlist-lazy-image loaded"
                                    :style="{ backgroundSize: 'cover', backgroundPosition: '50% 50%', backgroundImage: `url('${getCardData(playlist).coverUrl}')` }"
                                ></div>
                                <img
                                    v-else
                                    class="absolute-full fit playlist-lazy-image"
                                    :data-src="getCardData(playlist).coverUrl"
                                    :ref="(el: any) => onLazyImageMounted(el as HTMLElement)"
                                    style="width: 100%; height: 100%; object-fit: cover;"
                                    alt=""
                                />
                            </div>
                            <!-- Fallback gradient -->
                            <div
                                v-else
                                class="q-img__image absolute-full"
                                :style="{ background: fallbackGradient }"
                            >
                                <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 2.5rem; opacity: 0.6;">
                                    &#127925;
                                </div>
                            </div>
                            <div class="q-img__content absolute-full"></div>
                        </div>
                    </a>
                    <hr aria-orientation="horizontal" class="q-separator q-separator q-separator--horizontal q-separator--dark" />
                    <div>
                        <div class="q-card__section q-card__section--vert">
                            <a :href="`/playlist?id=${getCardData(playlist).id}`" style="color: inherit;">
                                <div class="text-h6 ellipsis-2-lines" style="font-weight: 500;">
                                    {{ getCardData(playlist).name }}
                                    <span
                                        v-if="getCardData(playlist).sourceBadge"
                                        style="background: #4caf50; color: #fff; padding: 2px 6px; border-radius: 3px; font-size: 0.7rem; margin-left: 6px;"
                                    >
                                        {{ getCardData(playlist).sourceBadge }}
                                    </span>
                                </div>
                            </a>
                            <div class="ellipsis-2-lines q-pt-sm" style="font-weight: 400; opacity: 0.6; line-height: 1.25rem;">
                                By {{ getCardData(playlist).userName }} <br />
                                {{ getCardData(playlist).worksCount }} work{{ getCardData(playlist).worksCount !== 1 ? 's' : '' }}
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Skeleton cards while loading -->
            <template v-if="isLoading">
                <div
                    v-for="n in Math.min(BATCH_SIZE, publicPlaylists.length - displayedCount)"
                    :key="'skeleton-' + n"
                    class="col-xs-6 col-sm-3 col-md-2 col-lg-2 col-xl-2 skeleton-card"
                >
                    <div :class="cardClass" style="overflow: hidden;">
                        <div
                            class="skeleton-cover"
                            style="padding-bottom: 75%; position: relative;"
                        >
                            <div class="skeleton-shimmer"></div>
                        </div>
                        <hr class="q-separator q-separator--horizontal" style="opacity: 0.3;" />
                        <div class="q-card__section q-pa-sm">
                            <div class="skeleton-line skeleton-line--title"></div>
                            <div class="skeleton-line skeleton-line--subtitle"></div>
                        </div>
                    </div>
                </div>
            </template>
        </div>

        <!-- Infinite scroll sentinel -->
        <div
            v-show="showSentinel"
            :ref="(el: any) => onSentinelRef(el as HTMLElement)"
            style="height: 20px; margin: 20px 0;"
        >
            <div class="text-center text-caption text-grey">
                {{ sentinelText }}
            </div>
        </div>

        <!-- Load more button (when infinite scroll is disabled) -->
        <div
            v-if="!enableInfiniteScroll && !allLoaded && !isLoading"
            class="text-center q-mt-md"
        >
            <button
                class="q-btn q-btn-item non-selectable no-outline q-btn--flat q-btn--rectangle q-btn--actionable q-focusable q-hoverable asmr-playlist-action"
                @click="handleLoadMore"
            >
                <span class="q-btn__content text-center col items-center q-anchor--skip justify-center row">
                    <i class="q-icon notranslate material-icons">expand_more</i>
                    {{ t('playlistLoadMore') }}
                </span>
            </button>
        </div>
    </div>
</template>

<style scoped>
/* Lazy image fade-in */
.playlist-lazy-image {
    opacity: 0;
    transition: opacity 0.3s ease-in;
}
.playlist-lazy-image.loaded {
    opacity: 1;
}

/* Skeleton shimmer animation */
.skeleton-cover {
    background: var(--asmr-bg-secondary, rgba(255, 255, 255, 0.05));
}
.skeleton-shimmer {
    position: absolute;
    inset: 0;
    background: linear-gradient(
        90deg,
        transparent,
        var(--asmr-bg-tertiary, rgba(255, 255, 255, 0.1)),
        transparent
    );
    animation: shimmer 1.5s infinite;
}
.skeleton-line {
    border-radius: 4px;
    background: var(--asmr-bg-secondary, rgba(255, 255, 255, 0.05));
}
.skeleton-line--title {
    height: 20px;
    margin-bottom: 8px;
}
.skeleton-line--subtitle {
    height: 14px;
    width: 60%;
}

@keyframes shimmer {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(100%); }
}

/* Text filter input */
.asmr-playlist-text-filter {
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 4px;
    color: inherit;
    font-size: 13px;
    padding: 4px 10px;
    width: 160px;
    outline: none;
    transition: border-color 0.2s, background 0.2s;
}
.asmr-playlist-text-filter::placeholder {
    color: rgba(255, 255, 255, 0.4);
}
.asmr-playlist-text-filter:focus {
    border-color: var(--q-primary, #1976d2);
    background: rgba(255, 255, 255, 0.12);
}
</style>
