/**
 * PlaylistDiscovery - Discovers public playlists via Google Search
 *
 * Features:
 * - Scrapes Google search results for indexed asmr.one/playlist URLs
 * - Fetches all pages of search results dynamically
 * - Stores discovered playlists in GM storage for cross-domain persistence
 * - Allows manual addition of playlist URLs
 * - Pagination support for displaying playlists
 * - Automatically injects into the playlists page
 */

import { GM_getValue, GM_setValue } from '$';
import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { PlaylistEntry, PlaylistMetadata, PlaylistWorksResponse } from '../api/Playlist';
import { AuthApi } from '../api/Auth';
import { I18n } from '../core/Config';
import { Logger } from '../core/Utils';
import { GooglePlaylistScraper } from '../scrapers/GooglePlaylistScraper';
import { AppStore } from '../store/AppStore';
import { apiRequest } from './playlist/PlaylistService';
import KNOWN_PLAYLISTS from '../data/known-playlists.json';
import type {
    CachedPlaylistMetadata,
    CachedUserPlaylists,
    DiscoveredPlaylist,
    FetchedPlaylist,
    GoogleSearchCache,
    PlaylistFetchResult,
    PlaylistListResponse
} from './playlist/types';

type PlaylistFilterMode = 'all' | 'mine' | 'public' | 'online';
const PLAYLISTS_PER_PAGE = 24;
const STORAGE_KEY = 'asmr_ultimate_discovered_playlists';
const METADATA_CACHE_KEY = 'asmr_ultimate_playlist_metadata_cache';
const METADATA_SOFT_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours - serve stale, revalidate in background
const METADATA_HARD_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days - evict from cache
const FAILED_PLAYLIST_CACHE_KEY = 'asmr_ultimate_failed_playlist_cache';
const FAILED_PLAYLIST_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours - don't retry deleted playlists too often
const UNKNOWN_PLAYLIST_NAME = 'Unknown Playlist';
const FILTER_MODE_STORAGE_KEY = 'asmr_ultimate_playlist_filter_mode';
const USER_PLAYLISTS_CACHE_KEY = 'asmr_ultimate_user_playlists_cache';
const USER_PLAYLISTS_SOFT_TTL_MS = 5 * 60 * 1000; // 5 min - serve stale, revalidate
const USER_PLAYLISTS_HARD_TTL_MS = 60 * 60 * 1000; // 1 hour - evict

const CACHE_KEY = 'asmr_ultimate_google_search_cache';

// Extract just the IDs for quick lookups
const KNOWN_PLAYLIST_IDS = KNOWN_PLAYLISTS.map(p => p.id.toLowerCase());

export class PlaylistDiscovery {
    private static instance: PlaylistDiscovery;
    private bridge: KikoeruBridge;
    private isActive = false;
    // Infinite Scroll & Lazy Load State
    private readonly BATCH_SIZE = 12;
    private readonly METADATA_BATCH_SIZE = 4;
    private readonly BATCH_COOLDOWN_MS = 300;
    private readonly COVER_UPDATE_CONCURRENCY = 2;
    private readonly COVER_UPDATE_DELAY_MS = 1000;
    private displayedCount = 0;
    private imageObserver: IntersectionObserver | null = null;
    private scrollObserver: IntersectionObserver | null = null;
    private sentinelElement: HTMLElement | null = null;
    private sentinelInView = false;
    private statusElement: HTMLElement | null = null;
    private controlsRowEl: HTMLElement | null = null;
    private isBulkLoading = false;
    private loadNextBatchPromise: Promise<void> | null = null;
    private coverUpdateQueue: Array<{ id: string; playlist: FetchedPlaylist; pageSize: number; resolve: () => void }> = [];
    private coverUpdatePromises: Map<string, Promise<void>> = new Map();
    private coverUpdateInFlight = 0;
    private coverUpdateRunning = false;
    private rateLimitUntil = 0;
    private rateLimitBackoff = 1;

    private discoveredPlaylists: DiscoveredPlaylist[] = [];
    private loadedPlaylists: FetchedPlaylist[] = [];
    private publicPlaylists: DiscoveredPlaylist[] = [];
    private userPlaylists: DiscoveredPlaylist[] = [];
    private userPlaylistsFromApi: PlaylistEntry[] = []; // Full user playlist data from API
    private containerElement: HTMLElement | null = null;
    private routeUnwatch: (() => void) | null = null;
    private isLoading = false;
    private isSearching = false;
    private currentUserName: string | null = null;
    private currentUserPlaylistIds: Set<string> | null = null;
    private metadataCache: Map<string, CachedPlaylistMetadata> = new Map();
    private failedPlaylistCache: Map<string, number> = new Map(); // ID -> timestamp of failure
    private filterMode: PlaylistFilterMode = 'all';
    private textFilter = '';
    private textFilterDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    private nativeGridHidden = false;
    private pendingImageLoads = 0;
    private nativeFilterUnwatch: (() => void) | null = null;
    private preloadedImageUrls = new Set<string>();
    private likedPlaylistsCache: PlaylistEntry[] | null = null;
    private ownedPlaylistsCache: PlaylistEntry[] | null = null;

    private constructor() {
        this.bridge = KikoeruBridge.getInstance();
    }

    static getInstance(): PlaylistDiscovery {
        if (!PlaylistDiscovery.instance) {
            PlaylistDiscovery.instance = new PlaylistDiscovery();
        }
        return PlaylistDiscovery.instance;
    }

    initialize(): void {
        Logger.log('[PlaylistDiscovery] Initializing');
        this.loadDiscoveredPlaylists();
        this.loadFailedPlaylistCache();
        this.loadPersistedFilterMode();
        this.setupRouteWatcher();
    }

    private loadPersistedFilterMode(): void {
        try {
            const stored = GooglePlaylistScraper.safeGetValue(FILTER_MODE_STORAGE_KEY, null);
            if (stored && typeof stored === 'string' && ['all', 'mine', 'public', 'online'].includes(stored)) {
                this.filterMode = stored as PlaylistFilterMode;
                Logger.debug('[PlaylistDiscovery] Restored filter mode:', this.filterMode);
            }
        } catch { /* ignore */ }
    }

    private setupRouteWatcher(): void {
        const app = this.bridge.app;
        if (!app?.$watch) {
            Logger.warn('[PlaylistDiscovery] Vue $watch not available');
            return;
        }

        // Check if we're already on the playlists page
        this.checkAndRender();

        // Watch for route changes
        this.routeUnwatch = app.$watch(
            () => this.bridge.route.path,
            (newPath: string) => {
                if (newPath === '/playlists') {
                    this.checkAndRender();
                } else if (this.isActive) {
                    this.cleanup();
                }
            }
        );
    }

    private checkAndRender(): void {
        const currentPath = this.bridge.route.path;
        if (currentPath === '/playlists') {
            Logger.debug('[PlaylistDiscovery] On playlists page, rendering public playlists');
            this.renderPublicPlaylists();
        }
    }

    private async renderPublicPlaylists(): Promise<void> {
        if (this.isActive) {
            Logger.debug('[PlaylistDiscovery] Already active');
            return;
        }

        this.isActive = true;

        // Patch Vue Router to avoid NavigationDuplicated errors
        this.patchVueRouter();

        // Wait for the page to load
        await this.waitForPlaylistsPage();

        // Hide native grid + pagination (native grid is empty on SPA nav; we take over display)
        this.hideNativeGridAndPagination();

        // Show section with loading status
        this.showLoadingSection();

        // Always merge hardcoded known playlist IDs first
        this.mergeSearchResults(KNOWN_PLAYLIST_IDS);

        // Also merge any cached Google search results
        const cached = this.loadSearchCache();
        if (cached && cached.playlistIds.length > 0) {
            const cacheAge = Date.now() - cached.timestamp;
            Logger.debug(`[PlaylistDiscovery] Merging cached results (age: ${Math.round(cacheAge / 60000)}min):`, cached.playlistIds.length);
            this.mergeSearchResults(cached.playlistIds);
        }

        // Load metadata cache
        this.loadMetadataCache();

        // Update status: fetching user playlists
        this.updateStatusText(I18n.t('playlistLoadingUser') || 'Fetching your playlists...');

        // Fetch user's playlists for "All" mode sorting
        await this.fetchUserPlaylists();

        // Apply current filter mode (user playlists first in "all" mode)
        this.applyFilterMode();

        this.loadedPlaylists = [];
        this.displayedCount = 0;

        Logger.debug(`[PlaylistDiscovery] Found ${this.publicPlaylists.length} playlists to display (filter: ${this.filterMode}).`);

        this.updateCountBadge();
        this.updateStatusText(I18n.format('playlistLoadStatus', { loaded: 0, total: this.publicPlaylists.length }));

        // Setup Observers (respects enableInfiniteScroll setting)
        this.setupObservers();

        // Load first batch immediately
        await this.queueLoadNextBatch();
    }

    /**
     * Patch Vue Router to prevent NavigationDuplicated errors
     */
    private patchVueRouter(): void {
        try {
            const router = this.bridge.router;
            if (!router || (router as any).__asmrPatched) return;

            const originalPush = router.push.bind(router);
            const originalReplace = router.replace?.bind(router);

            router.push = function (location: any, onComplete?: any, onAbort?: any) {
                return (originalPush as any)(location, onComplete, onAbort).catch((err: any) => {
                    // Ignore NavigationDuplicated errors
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

    /**
     * Hide only the pagination, keeping native dropdown and grid visible
     */
    private hideNativePaginationOnly(): void {
        const styleId = 'asmr-ultimate-playlist-pagination-hide';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                /* Hide native ant-pagination only */
                .q-page .ant-pagination,
                .q-page .q-pt-lg.q-pb-md.flex.flex-center:has(.ant-pagination),
                .q-page > div:has(.ant-pagination) {
                    display: none !important;
                }
            `;
            document.head.appendChild(style);
            Logger.debug('[PlaylistDiscovery] Hidden native pagination');
        }
        this.nativeGridHidden = true;
    }

    /**
     * Try to inject our playlists into the native Vue component
     * Returns true if successful, false if we need to use fallback UI
     */
    private async tryInjectIntoNativeComponent(): Promise<boolean> {
        try {
            // Find the native playlists Vue component
            const qPage = document.querySelector('.q-page') as HTMLElement & { __vue__?: any };
            if (!qPage?.__vue__) {
                Logger.debug('[PlaylistDiscovery] No Vue component found on .q-page');
                return false;
            }

            // Walk up to find the component that has playlists data
            let vue = qPage.__vue__;
            let playlistsComponent: any = null;

            const findPlaylistsData = (vm: any): any => {
                if (!vm) return null;
                // Check if this component has playlists array
                if (vm.playlists && Array.isArray(vm.playlists)) return vm;
                if (vm.$data?.playlists && Array.isArray(vm.$data.playlists)) return vm;
                if (vm.list && Array.isArray(vm.list)) return vm;
                // Check parent
                return vm.$parent ? findPlaylistsData(vm.$parent) : null;
            };

            playlistsComponent = findPlaylistsData(vue);

            if (!playlistsComponent) {
                Logger.debug('[PlaylistDiscovery] Could not find playlists data in Vue component tree');
                return false;
            }

            const playlistsArray = playlistsComponent.playlists || playlistsComponent.$data?.playlists || playlistsComponent.list;
            Logger.debug(`[PlaylistDiscovery] Found native playlists array with ${playlistsArray.length} items`);

            // Hide native pagination
            this.hideNativePaginationOnly();

            // Show loading status
            this.showInlineLoadingStatus();

            // Fetch and inject our public playlists
            await this.injectPublicPlaylistsIntoNative(playlistsComponent, playlistsArray);

            // Setup infinite scroll watcher
            this.setupNativeInfiniteScroll(playlistsComponent);

            return true;
        } catch (error) {
            Logger.warn('[PlaylistDiscovery] Failed to inject into native component:', error);
            return false;
        }
    }

    /**
     * Show inline loading status near the native dropdown
     */
    private showInlineLoadingStatus(): void {
        // Find a good spot to show status (after the native dropdown row)
        const dropdownRow = document.querySelector('.q-page > .row:first-child') as HTMLElement;
        if (!dropdownRow) return;

        // Check if we already added status
        if (document.getElementById('asmr-playlist-inline-status')) return;

        const statusDiv = document.createElement('div');
        statusDiv.id = 'asmr-playlist-inline-status';
        statusDiv.className = 'text-caption q-ml-md';
        statusDiv.style.cssText = 'opacity: 0.7; display: inline-flex; align-items: center; gap: 8px;';
        statusDiv.innerHTML = `
            <span class="asmr-status-text">${I18n.t('playlistLoadingMore')}</span>
            <q-spinner-dots color="primary" size="1em"></q-spinner-dots>
        `;

        // Insert after dropdown
        const insertPoint = dropdownRow.querySelector('.col-auto:last-child') || dropdownRow;
        insertPoint.appendChild(statusDiv);

        this.statusElement = statusDiv.querySelector('.asmr-status-text') as HTMLElement;
    }

    /**
     * Inject our public playlists into the native component's array
     */
    private async injectPublicPlaylistsIntoNative(component: any, playlistsArray: any[]): Promise<void> {
        // Get existing IDs to avoid duplicates
        const existingIds = new Set(playlistsArray.map((p: any) => p.id?.toLowerCase()));

        // Fetch metadata for our public playlists in batches
        // Filter out both existing playlists and ones that have previously failed
        const BATCH_SIZE = 8;
        const toFetch = this.publicPlaylists.filter(p =>
            !existingIds.has(p.id.toLowerCase()) && !this.isPlaylistFailed(p.id)
        );

        Logger.debug(`[PlaylistDiscovery] Injecting ${toFetch.length} public playlists into native grid`);

        for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
            const batch = toFetch.slice(i, i + BATCH_SIZE);

            const results = await Promise.allSettled(
                batch.map(async (discovered) => {
                    const cached = this.metadataCache.get(discovered.id);
                    if (cached && cached.name && cached.name !== UNKNOWN_PLAYLIST_NAME) {
                        return this.cachedToPlaylistEntry(cached, discovered);
                    }
                    // Fetch fresh metadata
                    const metadata = await apiRequest<PlaylistMetadata>('/api/playlist/get-playlist-metadata', { id: discovered.id });
                    if (!metadata?.name || metadata.name === UNKNOWN_PLAYLIST_NAME) {
                        // Mark as failed so we don't retry for 24 hours
                        this.markPlaylistFailed(discovered.id);
                        throw new Error('Invalid playlist');
                    }
                    // Cache it
                    this.metadataCache.set(discovered.id, {
                        id: metadata.id,
                        name: metadata.name,
                        user_name: metadata.user_name || 'Unknown',
                        worksCount: metadata.works_count || 0,
                        latestWorkId: 0,
                        coverUrl: '',
                        cachedAt: Date.now(),
                    });
                    this.saveMetadataCache();
                    return this.metadataToPlaylistEntry(metadata, discovered);
                })
            );

            // Add successful results to the native array
            for (const result of results) {
                if (result.status === 'fulfilled' && result.value) {
                    // Check again for duplicates (in case native loaded more)
                    if (!existingIds.has(result.value.id.toLowerCase())) {
                        playlistsArray.push(result.value);
                        existingIds.add(result.value.id.toLowerCase());
                    }
                }
            }

            // Update status
            this.updateInlineStatus(`${I18n.format('playlistLoadStatus', { loaded: Math.min(i + BATCH_SIZE, toFetch.length), total: toFetch.length })}`);
        }

        // Force Vue to re-render
        if (component.$forceUpdate) component.$forceUpdate();

        this.updateInlineStatus(`${playlistsArray.length} ${I18n.t('playlistLoadingDone')}`);
    }

    private cachedToPlaylistEntry(cached: CachedPlaylistMetadata, discovered: DiscoveredPlaylist): any {
        return {
            id: cached.id,
            name: cached.name,
            user: { name: cached.user_name },
            worksCount: cached.worksCount,
            latestWorkId: cached.latestWorkId,
            latestWork: cached.latestWorkId ? { id: cached.latestWorkId } : null,
            privacy: 2, // public
            _source: 'asmr-ultimate',
            _discovered: discovered.source,
        };
    }

    private metadataToPlaylistEntry(metadata: PlaylistMetadata, discovered: DiscoveredPlaylist): any {
        return {
            id: metadata.id,
            name: metadata.name,
            user: { name: metadata.user_name },
            worksCount: metadata.works_count,
            latestWorkId: 0,
            latestWork: null,
            privacy: 2,
            _source: 'asmr-ultimate',
            _discovered: discovered.source,
        };
    }

    private updateInlineStatus(text: string): void {
        if (this.statusElement) {
            this.statusElement.textContent = text;
        }
    }

    /**
     * Setup infinite scroll by watching scroll position
     */
    private setupNativeInfiniteScroll(component: any): void {
        // Create sentinel for infinite scroll detection
        const sentinel = document.createElement('div');
        sentinel.id = 'asmr-playlist-scroll-sentinel';
        sentinel.style.cssText = 'height: 20px; margin: 20px 0;';

        const grid = document.querySelector('.q-page .row.q-col-gutter-x-md.q-col-gutter-y-md');
        if (grid?.parentElement) {
            grid.parentElement.appendChild(sentinel);
        }

        // Observe sentinel
        this.scrollObserver = new IntersectionObserver(
            (entries) => {
                if (entries[0]?.isIntersecting && !this.isLoading) {
                    // Load more - could trigger native load or our own
                    if (component.loadMore && typeof component.loadMore === 'function') {
                        component.loadMore();
                    }
                }
            },
            { threshold: 0.1 }
        );

        this.scrollObserver.observe(sentinel);
        this.sentinelElement = sentinel;
    }

    /**
     * Fetch all pages of playlists for a given filterBy parameter.
     * Paginates through all pages to get the complete list.
     */
    private async fetchAllPlaylistPages(filterBy: 'all' | 'liked' | 'owned', pageSize = 200): Promise<PlaylistEntry[]> {
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

    private async fetchUserPlaylists(): Promise<void> {
        try {
            // Try cached user playlists first
            const cached = this.loadCachedUserPlaylists();
            if (cached) {
                this.userPlaylistsFromApi = cached.playlists;
                this.currentUserPlaylistIds = new Set(cached.playlists.map(p => p.id));
                this.currentUserName = cached.userName;
                this.userPlaylists = this.discoveredPlaylists.filter(d => this.currentUserPlaylistIds!.has(d.id));
                Logger.debug(`[PlaylistDiscovery] Loaded ${this.userPlaylists.length} user playlists from cache`);

                // Pre-populate liked/owned caches if not set
                if (!this.likedPlaylistsCache || !this.ownedPlaylistsCache) {
                    // Separate by ownership if we know the user name
                    if (cached.userName) {
                        this.ownedPlaylistsCache = cached.playlists.filter(p => p.user_name === cached.userName);
                        this.likedPlaylistsCache = cached.playlists.filter(p => p.user_name !== cached.userName);
                    }
                }

                // Revalidate in background if past soft TTL
                if (Date.now() - cached.cachedAt > USER_PLAYLISTS_SOFT_TTL_MS) {
                    this.revalidateUserPlaylistsInBackground();
                }
                return;
            }

            // No cache — fetch owned + liked in parallel from the API
            await this.getCurrentUserName();

            const [ownedPlaylists, likedPlaylists] = await Promise.all([
                this.fetchAllPlaylistPages('owned'),
                this.fetchAllPlaylistPages('liked'),
            ]);

            this.ownedPlaylistsCache = ownedPlaylists;
            this.likedPlaylistsCache = likedPlaylists;

            // Merge into combined list (owned first, then liked, deduped)
            const seenIds = new Set<string>();
            const all: PlaylistEntry[] = [];
            for (const p of [...ownedPlaylists, ...likedPlaylists]) {
                if (!seenIds.has(p.id)) {
                    seenIds.add(p.id);
                    all.push(p);
                }
            }

            this.userPlaylistsFromApi = all;
            this.currentUserPlaylistIds = seenIds;
            this.userPlaylists = this.discoveredPlaylists.filter(d => seenIds.has(d.id));
            this.saveUserPlaylistsCache();
            Logger.debug(`[PlaylistDiscovery] Fetched ${ownedPlaylists.length} owned + ${likedPlaylists.length} liked = ${all.length} user playlists`);
        } catch (e) {
            Logger.warn('[PlaylistDiscovery] Failed to fetch user playlists:', e);
            this.userPlaylists = [];
            this.userPlaylistsFromApi = [];
            this.currentUserPlaylistIds = new Set();
        }
    }

    private loadCachedUserPlaylists(): CachedUserPlaylists | null {
        try {
            const stored = GooglePlaylistScraper.safeGetValue(USER_PLAYLISTS_CACHE_KEY, null);
            if (!stored) return null;
            const parsed = (typeof stored === 'string' ? JSON.parse(stored) : stored) as CachedUserPlaylists;
            if (!parsed?.playlists || !parsed.cachedAt) return null;
            if (Date.now() - parsed.cachedAt > USER_PLAYLISTS_HARD_TTL_MS) return null;
            return parsed;
        } catch { return null; }
    }

    private saveUserPlaylistsCache(): void {
        try {
            const cache: CachedUserPlaylists = {
                playlists: this.userPlaylistsFromApi,
                userName: this.currentUserName,
                cachedAt: Date.now(),
            };
            GooglePlaylistScraper.safeSetValue(USER_PLAYLISTS_CACHE_KEY, JSON.stringify(cache));
        } catch { /* ignore */ }
    }

    private revalidateUserPlaylistsInBackground(): void {
        setTimeout(async () => {
            try {
                // Fetch owned + liked in parallel
                const [owned, liked] = await Promise.all([
                    this.fetchAllPlaylistPages('owned'),
                    this.fetchAllPlaylistPages('liked'),
                ]);

                this.ownedPlaylistsCache = owned;
                this.likedPlaylistsCache = liked;

                // Merge (deduped)
                const seenIds = new Set<string>();
                const playlists: PlaylistEntry[] = [];
                for (const p of [...owned, ...liked]) {
                    if (!seenIds.has(p.id)) {
                        seenIds.add(p.id);
                        playlists.push(p);
                    }
                }

                const oldIds = this.currentUserPlaylistIds || new Set<string>();
                const changed = oldIds.size !== seenIds.size || [...oldIds].some(id => !seenIds.has(id));

                this.userPlaylistsFromApi = playlists;
                this.currentUserPlaylistIds = seenIds;
                this.saveUserPlaylistsCache();

                if (changed) {
                    Logger.debug('[PlaylistDiscovery] User playlists changed in background, updating badge');
                    this.userPlaylists = this.discoveredPlaylists.filter(d => seenIds.has(d.id));
                    this.updateCountBadge();
                }
            } catch {
                // Silent failure for background revalidation
            }
        }, 3000);
    }

    /** Convert PlaylistEntry[] to DiscoveredPlaylist[], sorted by created_at desc */
    private entriesToDiscovered(entries: PlaylistEntry[]): DiscoveredPlaylist[] {
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

    private applyFilterMode(): void {
        const myIds = this.currentUserPlaylistIds || new Set<string>();

        // Helper to check if playlist has works (from cache or discovered data)
        const hasWorks = (d: DiscoveredPlaylist): boolean => {
            const cached = this.metadataCache.get(d.id);
            const worksCount = cached?.worksCount ?? d.works_count;
            // Only filter out if we know for certain it has 0 works
            return worksCount === undefined || worksCount > 0;
        };

        // Build owned + liked lists from their separate caches when available
        const ownedAsDiscovered = this.ownedPlaylistsCache
            ? this.entriesToDiscovered(this.ownedPlaylistsCache)
            : [];
        const likedAsDiscovered = this.likedPlaylistsCache
            ? this.entriesToDiscovered(this.likedPlaylistsCache)
            : [];

        // Fallback: all user playlists as single list (from combined API or cache)
        const allUserPlaylistsAsDiscovered = (ownedAsDiscovered.length > 0 || likedAsDiscovered.length > 0)
            ? [...ownedAsDiscovered, ...likedAsDiscovered]
            : this.entriesToDiscovered(this.userPlaylistsFromApi);

        // Get public playlists (from known list and Google search), excluding user's own
        const publicPlaylists = this.discoveredPlaylists.filter(d => !myIds.has(d.id) && hasWorks(d));

        if (this.filterMode === 'all') {
            // Show owned first, then liked, then public (all deduped)
            // User playlists are NOT filtered by works count (even 0-work ones shown)
            const seenIds = new Set<string>();
            const merged: DiscoveredPlaylist[] = [];

            // Add owned playlists first (most recent first)
            for (const p of ownedAsDiscovered) {
                if (!seenIds.has(p.id.toLowerCase())) {
                    seenIds.add(p.id.toLowerCase());
                    merged.push(p);
                }
            }

            // Add liked playlists second
            for (const p of likedAsDiscovered) {
                if (!seenIds.has(p.id.toLowerCase())) {
                    seenIds.add(p.id.toLowerCase());
                    merged.push(p);
                }
            }

            // Fallback: if we don't have separate owned/liked yet, use combined list
            if (ownedAsDiscovered.length === 0 && likedAsDiscovered.length === 0) {
                for (const p of allUserPlaylistsAsDiscovered) {
                    if (!seenIds.has(p.id.toLowerCase())) {
                        seenIds.add(p.id.toLowerCase());
                        merged.push(p);
                    }
                }
            }

            // Add public/discovered playlists after (skip if already added, filter 0-work ones)
            for (const p of publicPlaylists) {
                if (!seenIds.has(p.id.toLowerCase()) && hasWorks(p)) {
                    seenIds.add(p.id.toLowerCase());
                    merged.push(p);
                }
            }

            this.publicPlaylists = merged;
        } else if (this.filterMode === 'mine') {
            // "I liked" - uses API's filterBy: 'liked'
            this.publicPlaylists = likedAsDiscovered.length > 0
                ? likedAsDiscovered
                : [];
        } else if (this.filterMode === 'public') {
            // "I created" - uses API's filterBy: 'owned'
            this.publicPlaylists = ownedAsDiscovered.length > 0
                ? ownedAsDiscovered
                : allUserPlaylistsAsDiscovered; // Fallback to all if not fetched yet
        } else if (this.filterMode === 'online') {
            // Online only - discovered playlists from KNOWN_PLAYLISTS and Google search
            // Excludes user's own playlists, filters 0-work ones
            this.publicPlaylists = publicPlaylists;
        } else {
            // Fallback
            this.publicPlaylists = publicPlaylists;
        }

        // Apply text filter on top of mode filter
        if (this.textFilter) {
            this.publicPlaylists = this.publicPlaylists.filter(d => this.matchesTextFilter(d));
        }
    }

    private setFilterMode(mode: PlaylistFilterMode): void {
        if (this.filterMode === mode) return;
        this.filterMode = mode;

        // Persist filter mode
        try { GooglePlaylistScraper.safeSetValue(FILTER_MODE_STORAGE_KEY, mode); } catch { /* ignore */ }

        // For liked/created modes, fetch from API with the correct filterBy parameter
        const needsApiFetch =
            (mode === 'mine' && !this.likedPlaylistsCache) ||
            (mode === 'public' && !this.ownedPlaylistsCache);

        if (needsApiFetch) {
            const filterBy = mode === 'mine' ? 'liked' : 'owned';
            this.updateStatusText(I18n.t('playlistLoadingUser') || 'Loading...');

            this.fetchAllPlaylistPages(filterBy).then(playlists => {
                if (mode === 'mine') this.likedPlaylistsCache = playlists;
                else this.ownedPlaylistsCache = playlists;

                // Re-apply only if still in the same mode
                if (this.filterMode === mode) {
                    this.applyFilterMode();
                    const grid = document.getElementById('public-playlists-grid');
                    if (grid) grid.innerHTML = '';
                    this.displayedCount = 0;
                    this.loadedPlaylists = [];
                    this.updateCountBadge();
                    void this.queueLoadNextBatch();
                }
            });
            return;
        }

        // For modes with cached data, apply immediately
        this.applyFilterMode();

        const grid = document.getElementById('public-playlists-grid');
        if (grid) grid.innerHTML = '';
        this.displayedCount = 0;
        this.loadedPlaylists = [];
        this.updateCountBadge();

        void this.queueLoadNextBatch();
    }

    /**
     * Manual search - called when user clicks the search button
     */
    public async runManualSearch(): Promise<{ found: number; isRateLimited: boolean }> {
        if (this.isSearching) {
            Logger.debug('[PlaylistDiscovery] Already searching');
            return { found: 0, isRateLimited: false };
        }

        if (GooglePlaylistScraper.isRateLimited()) {
            Logger.warn('[PlaylistDiscovery] Rate limited by Google');
            return { found: 0, isRateLimited: true };
        }

        this.isSearching = true;

        try {
            Logger.debug('[PlaylistDiscovery] Starting manual Google search...');
            const playlistIds = await GooglePlaylistScraper.discoverPlaylists(
                (page, found) => this.updateSearchProgress(page, found)
            );

            if (playlistIds.length > 0) {
                this.saveSearchCache(playlistIds);
                this.mergeSearchResults(playlistIds);

                // Re-apply filter after new results found
                this.applyFilterMode();

                // Update badge
                this.updateCountBadge();

                // If we are at the end of the list, load the new ones
                if (!this.isLoading) {
                    void this.queueLoadNextBatch();
                }
            }

            return { found: playlistIds.length, isRateLimited: false };
        } catch (error) {
            Logger.error('[PlaylistDiscovery] Manual search failed:', error);
            return { found: 0, isRateLimited: GooglePlaylistScraper.isRateLimited() };
        } finally {
            this.isSearching = false;
        }
    }

    private async waitForPlaylistsPage(maxAttempts = 20): Promise<void> {
        for (let i = 0; i < maxAttempts; i++) {
            if (this.findPlaylistsGrid() || this.findPlaylistsPageRoot()) {
                Logger.debug('[PlaylistDiscovery] Playlists page root found');
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        Logger.warn('[PlaylistDiscovery] Playlists page root not found after waiting');
    }

    private findPlaylistsGrid(): Element | null {
        return document.querySelector('.row.q-col-gutter-x-md.q-col-gutter-y-md')
            || document.querySelector('.row.q-col-gutter-x-sm.q-col-gutter-y-sm')
            || document.querySelector('.row.q-col-gutter-x-md.q-col-gutter-y-lg')
            || document.querySelector('.row.q-col-gutter-md');
    }

    private findPlaylistsPageRoot(): HTMLElement | null {
        return document.querySelector('main.q-page') as HTMLElement
            || document.querySelector('main') as HTMLElement
            || document.querySelector('.q-page') as HTMLElement
            || document.querySelector('.q-page-container') as HTMLElement;
    }

    private resolvePlaylistsMountParent(): HTMLElement | null {
        const grid = this.findPlaylistsGrid();
        if (grid && grid.parentElement) return grid.parentElement as HTMLElement;
        return this.findPlaylistsPageRoot();
    }

    private mergeSearchResults(playlistIds: string[]): void {
        // Normalize all IDs to lowercase for consistent deduplication
        const normalizedIds = playlistIds.map(id => id.toLowerCase());

        // Get existing IDs for deduplication
        const existingIds = new Set(this.discoveredPlaylists.map(p => p.id.toLowerCase()));

        // Add new playlist IDs that don't already exist
        let addedCount = 0;
        for (const id of normalizedIds) {
            if (!existingIds.has(id)) {
                this.discoveredPlaylists.push({
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
            this.saveDiscoveredPlaylists();
        }
    }

    private loadSearchCache(): GoogleSearchCache | null {
        try {
            const stored = GooglePlaylistScraper.safeGetValue(CACHE_KEY, null);
            if (stored) {
                return typeof stored === 'string' ? JSON.parse(stored) : stored;
            }
        } catch (e) {
            Logger.warn('[PlaylistDiscovery] Failed to load search cache:', e);
        }
        return null;
    }

    private saveSearchCache(playlistIds: string[]): void {
        try {
            const cache: GoogleSearchCache = {
                timestamp: Date.now(),
                playlistIds,
            };
            const data = JSON.stringify(cache);
            GooglePlaylistScraper.safeSetValue(CACHE_KEY, data);
        } catch (e) {
            Logger.warn('[PlaylistDiscovery] Failed to save search cache:', e);
        }
    }

    private loadMetadataCache(): void {
        try {
            const stored = GooglePlaylistScraper.safeGetValue(METADATA_CACHE_KEY, null);
            if (stored) {
                const entries = (typeof stored === 'string' ? JSON.parse(stored) : stored) as CachedPlaylistMetadata[];
                const now = Date.now();
                this.metadataCache.clear();
                for (const entry of entries) {
                    if (!entry.name || entry.name === UNKNOWN_PLAYLIST_NAME) {
                        continue;
                    }
                    // Evict entries past hard TTL (7 days); keep stale entries for SWR
                    if (now - entry.cachedAt < METADATA_HARD_TTL_MS) {
                        this.metadataCache.set(entry.id, entry);
                    }
                }
                Logger.debug('[PlaylistDiscovery] Loaded', this.metadataCache.size, 'cached playlist metadata entries');
            }
        } catch (e) {
            Logger.warn('[PlaylistDiscovery] Failed to load metadata cache:', e);
        }
    }

    private saveMetadataCache(): void {
        try {
            const entries = Array.from(this.metadataCache.values());
            const data = JSON.stringify(entries);
            GooglePlaylistScraper.safeSetValue(METADATA_CACHE_KEY, data);
        } catch (e) {
            Logger.warn('[PlaylistDiscovery] Failed to save metadata cache:', e);
        }
    }

    private loadFailedPlaylistCache(): void {
        try {
            const stored = GooglePlaylistScraper.safeGetValue(FAILED_PLAYLIST_CACHE_KEY, null);
            if (stored) {
                const entries = (typeof stored === 'string' ? JSON.parse(stored) : stored) as Array<{ id: string; failedAt: number }>;
                const now = Date.now();
                this.failedPlaylistCache.clear();
                for (const entry of entries) {
                    // Only keep entries that haven't expired
                    if (now - entry.failedAt < FAILED_PLAYLIST_CACHE_TTL_MS) {
                        this.failedPlaylistCache.set(entry.id, entry.failedAt);
                    }
                }
                if (this.failedPlaylistCache.size > 0) {
                    Logger.debug('[PlaylistDiscovery] Loaded', this.failedPlaylistCache.size, 'failed playlist IDs (will skip these)');
                }
            }
        } catch (e) {
            Logger.warn('[PlaylistDiscovery] Failed to load failed playlist cache:', e);
        }
    }

    private saveFailedPlaylistCache(): void {
        try {
            const entries = Array.from(this.failedPlaylistCache.entries()).map(([id, failedAt]) => ({ id, failedAt }));
            const data = JSON.stringify(entries);
            GooglePlaylistScraper.safeSetValue(FAILED_PLAYLIST_CACHE_KEY, data);
        } catch (e) {
            Logger.warn('[PlaylistDiscovery] Failed to save failed playlist cache:', e);
        }
    }

    private markPlaylistFailed(playlistId: string): void {
        const id = playlistId.toLowerCase();
        this.failedPlaylistCache.set(id, Date.now());
        this.saveFailedPlaylistCache();
        Logger.debug('[PlaylistDiscovery] Marked playlist as failed:', id);
    }

    private isPlaylistFailed(playlistId: string): boolean {
        const id = playlistId.toLowerCase();
        const failedAt = this.failedPlaylistCache.get(id);
        if (!failedAt) return false;
        // Check if still within TTL
        if (Date.now() - failedAt < FAILED_PLAYLIST_CACHE_TTL_MS) {
            return true;
        }
        // Expired, remove from cache
        this.failedPlaylistCache.delete(id);
        return false;
    }

    private showLoadingSection(): void {
        // Find the q-page container
        const qPage = document.querySelector('.q-page') as HTMLElement;
        if (!qPage) {
            Logger.warn('[PlaylistDiscovery] Could not find .q-page container');
            return;
        }

        // Note: Native pagination is already hidden by hideNativePaginationOnly() in renderPublicPlaylists
        // We keep the native grid visible - our section will be added AFTER it

        // Remove existing section
        if (this.containerElement) {
            this.containerElement.remove();
        }

        this.containerElement = document.createElement('div');
        this.containerElement.id = 'asmr-ultimate-public-playlists';
        this.containerElement.className = 'q-pa-md';
        this.containerElement.style.position = 'relative';

        // Add styles for lazy images and consistent bar styling
        const _playlistStyle = document.createElement('style');
        _playlistStyle.id = 'asmr-playlist-styles';
        _playlistStyle.textContent = `
            .playlist-lazy-image { opacity: 0; transition: opacity 0.3s ease-in; }
            .playlist-lazy-image.loaded { opacity: 1; }

            /* Consistent bar styling for playlist controls */
            .q-page > .row.q-px-sm.q-py-sm {
                display: flex;
                align-items: center;
                gap: 8px;
                flex-wrap: wrap;
                padding: 8px 12px !important;
                background: var(--q-dark, rgba(0,0,0,0.2));
                border-radius: 8px;
                margin-bottom: 12px;
            }

            /* Hide the q-space to allow better flow */
            .q-page > .row.q-px-sm.q-py-sm > .q-space {
                display: none;
            }

            /* Style our controls to match */
            #asmr-playlist-discovery-controls {
                display: flex;
                align-items: center;
                gap: 8px;
                margin-left: auto;
            }

            #asmr-playlist-discovery-controls .asmr-playlist-count {
                opacity: 0.7;
                white-space: nowrap;
                padding: 0 8px;
            }

            .asmr-playlist-text-filter {
                background: rgba(255,255,255,0.08);
                border: 1px solid rgba(255,255,255,0.15);
                border-radius: 4px;
                color: inherit;
                font-size: 13px;
                padding: 4px 10px;
                width: 160px;
                outline: none;
                transition: border-color 0.2s, background 0.2s;
            }

            .asmr-playlist-text-filter::placeholder {
                color: rgba(255,255,255,0.4);
            }

            .asmr-playlist-text-filter:focus {
                border-color: var(--q-primary, #1976d2);
                background: rgba(255,255,255,0.12);
            }

            #asmr-playlist-discovery-controls .asmr-playlist-action {
                padding: 4px 12px !important;
                font-size: 13px;
                border-radius: 4px;
            }

            #asmr-playlist-discovery-controls .asmr-playlist-action:hover {
                background: rgba(255,255,255,0.1);
            }

            #asmr-playlist-discovery-controls .asmr-playlist-action .q-icon {
                font-size: 18px;
                margin-right: 4px;
            }
        `;
        // Remove existing style if present
        document.getElementById('asmr-playlist-styles')?.remove();
        document.head.appendChild(_playlistStyle);

        const totalDiscovered = this.publicPlaylists.length;

        // Controls for public playlists (merged into native dropdown row when possible)
        if (this.controlsRowEl) {
            this.controlsRowEl.remove();
            this.controlsRowEl = null;
        }

        const controlsRow = document.createElement('div');
        controlsRow.id = 'asmr-playlist-discovery-controls';
        controlsRow.className = 'col-auto row items-center asmr-playlist-controls';
        controlsRow.innerHTML = `
            <span id="public-playlist-count" class="text-caption asmr-playlist-count">
                ${this.escapeHtml(I18n.t('playlistPublicTitle'))}: ${totalDiscovered}
            </span>
            <button id="search-google-btn"
                    class="q-btn q-btn-item non-selectable no-outline q-btn--flat q-btn--rectangle q-btn--actionable q-focusable q-hoverable asmr-playlist-action"
                    title="${this.escapeHtml(I18n.t('playlistFindMore'))}">
                <span class="q-btn__content text-center col items-center q-anchor--skip justify-center row">
                    <i class="q-icon notranslate material-icons">search</i>
                    ${this.escapeHtml(I18n.t('playlistFindMore'))}
                </span>
            </button>
            <button id="playlists-randomize-btn"
                    class="q-btn q-btn-item non-selectable no-outline q-btn--flat q-btn--rectangle q-btn--actionable q-focusable q-hoverable asmr-playlist-action"
                    title="${this.escapeHtml(I18n.t('playlistRandomize'))}">
                <span class="q-btn__content text-center col items-center q-anchor--skip justify-center row">
                    <i class="q-icon notranslate material-icons">shuffle</i>
                    ${this.escapeHtml(I18n.t('playlistRandomize'))}
                </span>
            </button>
        `;
        this.controlsRowEl = controlsRow;

        // Status and feedback row
        const statusRow = document.createElement('div');
        statusRow.innerHTML = `
            <div id="public-playlist-status" class="text-caption q-mb-sm" style="opacity: 0.7;"></div>
            <div id="search-feedback" style="margin-bottom: 8px; display: none;"></div>
        `;
        this.containerElement.appendChild(statusRow);

        // Grid for playlists (unified - user's playlists first, then public)
        const publicGrid = document.createElement('div');
        publicGrid.className = 'row q-col-gutter-x-md q-col-gutter-y-md';
        publicGrid.id = 'public-playlists-grid';
        this.containerElement.appendChild(publicGrid);

        // Sentinel for infinite scroll
        this.sentinelElement = document.createElement('div');
        this.sentinelElement.id = 'playlist-sentinel';
        this.sentinelElement.style.height = '20px';
        this.sentinelElement.style.margin = '20px 0';
        this.sentinelElement.innerHTML = `<div class="text-center text-caption text-grey">${this.escapeHtml(I18n.t('playlistLoadingMore'))}</div>`;
        this.sentinelElement.style.display = 'none';
        this.containerElement.appendChild(this.sentinelElement);

        // Find the layout padding container and native dropdown row
        const layoutPadding = qPage.querySelector('.q-layout-padding') as HTMLElement || qPage;
        const nativeDropdownRow = layoutPadding.querySelector('.row:has(.q-select)') || layoutPadding.querySelector('.col-auto:has(.q-select)')?.parentElement;

        if (nativeDropdownRow) {
            // Inject text filter into the native row (before q-space so it's always visible)
            if (!document.getElementById('playlist-text-filter')) {
                const filterInput = document.createElement('input');
                filterInput.id = 'playlist-text-filter';
                filterInput.type = 'text';
                filterInput.className = 'asmr-playlist-text-filter';
                filterInput.placeholder = I18n.t('playlistFilterPlaceholder');
                filterInput.value = this.textFilter;
                const qSpace = nativeDropdownRow.querySelector('.q-space');
                if (qSpace) {
                    nativeDropdownRow.insertBefore(filterInput, qSpace);
                } else {
                    nativeDropdownRow.appendChild(filterInput);
                }
            }
            // Place controls and container inside q-layout-padding, after the native dropdown row
            nativeDropdownRow.after(controlsRow);
            controlsRow.after(this.containerElement);
        } else {
            // Fallback: insert controls before our container content, append to layoutPadding
            this.containerElement.insertBefore(controlsRow, statusRow);
            layoutPadding.appendChild(this.containerElement);
        }

        // Attach event handlers
        this.attachSearchButtonHandler();
        this.attachRandomizeButtonHandler();
        this.attachTextFilterHandler();
        this.setupNativeFilterWatcher();
        this.statusElement = document.getElementById('public-playlist-status');
        this.updateStatusText();
    }

    /**
     * Hide native grid and pagination for fallback mode
     * (Used when we can't inject into native Vue component)
     */
    private hideNativeGridAndPagination(): void {
        if (this.nativeGridHidden) return;

        const styleId = 'asmr-ultimate-playlist-takeover-style';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                /* Hide native playlist grid (but not ours) */
                .q-page .row.q-col-gutter-x-md.q-col-gutter-y-md:not(#public-playlists-grid):not(#asmr-ultimate-public-playlists *) {
                    display: none !important;
                }
                /* Hide native ant-pagination */
                .q-page .ant-pagination,
                .q-page .q-pt-lg.q-pb-md.flex.flex-center,
                .q-page .q-py-lg.flex.flex-center:has(.ant-pagination),
                .q-page > div:has(.ant-pagination) {
                    display: none !important;
                }
            `;
            document.head.appendChild(style);
            Logger.debug('[PlaylistDiscovery] Injected fallback takeover styles');
        }

        this.nativeGridHidden = true;
    }

    /**
     * Restore native grid and pagination visibility
     */
    private restoreNativeGridAndPagination(): void {
        if (!this.nativeGridHidden) return;

        // Remove style elements
        const styles = ['asmr-ultimate-playlist-takeover-style', 'asmr-ultimate-playlist-pagination-hide'];
        styles.forEach(id => {
            const style = document.getElementById(id);
            if (style) style.remove();
        });

        // Remove inline status
        const inlineStatus = document.getElementById('asmr-playlist-inline-status');
        if (inlineStatus) inlineStatus.remove();

        // Remove scroll sentinel
        const sentinel = document.getElementById('asmr-playlist-scroll-sentinel');
        if (sentinel) sentinel.remove();

        this.nativeGridHidden = false;
        Logger.debug('[PlaylistDiscovery] Restored native UI');
    }

    private updateCountBadge(): void {
        const badge = document.getElementById('public-playlist-count');
        if (badge) {
            badge.textContent = `${I18n.t('playlistPublicTitle')}: ${this.publicPlaylists.length}`;
        }
    }

    private updateStatusText(customText?: string): void {
        if (!this.statusElement) return;

        // If custom text provided, use it directly
        if (customText) {
            this.statusElement.textContent = customText;
            return;
        }

        // Default status based on loading progress
        if (this.displayedCount >= this.publicPlaylists.length && this.publicPlaylists.length > 0) {
            this.statusElement.textContent = I18n.format('playlistLoadStatusDone', {
                loaded: this.displayedCount,
                total: this.publicPlaylists.length,
            });
            return;
        }
        this.statusElement.textContent = I18n.format('playlistLoadStatus', {
            loaded: this.displayedCount,
            total: this.publicPlaylists.length,
        });
    }


    private applyLazySrc(el: HTMLElement): void {
        const src = el.dataset.src;
        if (!src) return;
        el.removeAttribute('data-src');

        // Track image load for batch gating
        this.pendingImageLoads++;

        if (el.tagName === 'IMG') {
            const img = el as HTMLImageElement;
            img.onload = img.onerror = () => {
                this.pendingImageLoads--;
                el.classList.add('loaded');
                this.checkAndTriggerNextBatch();
            };
            img.src = src;
        } else {
            // For background images, use Image() to preload
            const img = new Image();
            img.onload = img.onerror = () => {
                this.pendingImageLoads--;
                el.style.backgroundImage = `url('${src}')`;
                el.classList.add('loaded');
                this.checkAndTriggerNextBatch();
            };
            img.src = src;
        }
    }

    private observeLazyImages(scope: Element): void {
        const lazyImages = scope.querySelectorAll('[data-src]');
        if (this.imageObserver) {
            lazyImages.forEach(img => this.imageObserver?.observe(img));
            return;
        }
        lazyImages.forEach(img => this.applyLazySrc(img as HTMLElement));
    }

    private async queueLoadNextBatch(): Promise<void> {
        if (this.loadNextBatchPromise) return this.loadNextBatchPromise;
        this.loadNextBatchPromise = this.loadNextBatch().finally(() => {
            this.loadNextBatchPromise = null;
        });
        return this.loadNextBatchPromise;
    }

    private setupObservers(): void {
        // Check if infinite scroll is enabled
        const infiniteScrollEnabled = AppStore.getConfig('enableInfiniteScroll');

        if (typeof IntersectionObserver === 'undefined') {
            Logger.warn('[PlaylistDiscovery] IntersectionObserver unavailable');
            return;
        }

        // Image Observer for lazy loading
        this.imageObserver = new IntersectionObserver((entries, observer) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const el = entry.target as HTMLElement;
                    this.applyLazySrc(el);
                    observer.unobserve(el);
                }
            });
        }, {
            rootMargin: '200px 0px', // Preload images 200px before they appear
            threshold: 0.01
        });

        // Scroll Observer for infinite scrolling (only if enabled)
        if (infiniteScrollEnabled) {
            this.scrollObserver = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    this.sentinelInView = entry.isIntersecting;
                    if (entry.isIntersecting && !this.isLoading && this.areAllImagesLoaded()) {
                        Logger.debug('[PlaylistDiscovery] Sentinel intersected, loading next batch');
                        this.queueLoadNextBatch();
                    }
                });
            }, {
                rootMargin: '400px', // Load next batch well before reaching bottom
                threshold: 0.1
            });

            if (this.sentinelElement && this.scrollObserver) {
                this.scrollObserver.observe(this.sentinelElement);
            }
        }
    }

    private createSkeletonCard(): HTMLElement {
        const col = document.createElement('div');
        col.className = 'col-xs-6 col-sm-3 col-md-2 col-lg-2 col-xl-2 skeleton-card';

        const isDark = document.body.classList.contains('body--dark') || document.body.classList.contains('q-dark');
        const shimmerBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
        const shimmerHighlight = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)';

        col.innerHTML = `
            <div class="${this.getCardClass()}" style="overflow: hidden;">
                <div style="padding-bottom: 75%; background: ${shimmerBg}; position: relative;">
                    <div style="position: absolute; inset: 0; background: linear-gradient(90deg, transparent, ${shimmerHighlight}, transparent); animation: shimmer 1.5s infinite;"></div>
                </div>
                <hr class="q-separator q-separator--horizontal" style="opacity: 0.3;">
                <div class="q-card__section q-pa-sm">
                    <div style="height: 20px; background: ${shimmerBg}; border-radius: 4px; margin-bottom: 8px;"></div>
                    <div style="height: 14px; width: 60%; background: ${shimmerBg}; border-radius: 4px;"></div>
                </div>
            </div>
            <style>
                @keyframes shimmer {
                    0% { transform: translateX(-100%); }
                    100% { transform: translateX(100%); }
                }
            </style>
        `;

        return col;
    }

    private updateLoadingProgress(): void {
        const statusEl = this.sentinelElement?.querySelector('div');
        if (!statusEl) return;

        if (this.displayedCount >= this.publicPlaylists.length && this.publicPlaylists.length > 0) {
            statusEl.textContent = I18n.t('playlistLoadingDone');
            return;
        }

        statusEl.textContent = I18n.t('playlistLoadingMore');
    }

    private replaceSkeletonWithCard(playlistId: string, card: HTMLElement): void {
        const grid = document.getElementById('public-playlists-grid');
        if (!grid) return;

        const skeleton = grid.querySelector(`[data-playlist-id="${playlistId.toLowerCase()}"]`);
        if (skeleton) {
            skeleton.replaceWith(card);

            // Observe the new card's images
            this.observeLazyImages(card);
        } else {
            // No skeleton found (shouldn't happen in normal flow, but safety check)
            grid.appendChild(card);
            this.observeLazyImages(card);
        }
    }

    private enqueueCoverUpdate(playlist: FetchedPlaylist, pageSize: number): Promise<void> {
        const rawId = playlist.id || playlist.discovered?.id || '';
        const playlistId = rawId.toLowerCase();
        if (!playlistId) return Promise.resolve();

        const existing = this.coverUpdatePromises.get(playlistId);
        if (existing) return existing;

        let resolveFn: () => void = () => { };
        const promise = new Promise<void>((resolve) => {
            resolveFn = resolve;
        });
        this.coverUpdatePromises.set(playlistId, promise);
        this.coverUpdateQueue.push({ id: playlistId, playlist, pageSize, resolve: resolveFn });
        this.processCoverUpdateQueue();
        return promise;
    }

    private processCoverUpdateQueue(): void {
        if (this.coverUpdateRunning) return;
        this.coverUpdateRunning = true;

        const pump = async () => {
            while (this.coverUpdateQueue.length > 0) {
                // Check for rate limit
                const now = Date.now();
                if (now < this.rateLimitUntil) {
                    const wait = this.rateLimitUntil - now;
                    Logger.debug(`[PlaylistDiscovery] Rate limit active, pausing queue for ${Math.ceil(wait / 1000)}s`);
                    await this.delay(wait);
                    continue;
                }

                while (this.coverUpdateInFlight < this.COVER_UPDATE_CONCURRENCY && this.coverUpdateQueue.length > 0) {
                    const next = this.coverUpdateQueue.shift();
                    if (!next) break;

                    this.coverUpdateInFlight += 1;
                    this.updatePlaylistCoverAndCount(next.playlist, next.pageSize)
                        .then((success) => {
                            if (success) {
                                // Successful request, slowly decay backoff
                                this.rateLimitBackoff = Math.max(1, this.rateLimitBackoff * 0.9);
                            }
                        })
                        .catch((err: any) => {
                            if (err?.status === 429) {
                                // Hit rate limit!
                                this.rateLimitBackoff = Math.min(this.rateLimitBackoff * 2, 30); // Max 30x backoff
                                this.rateLimitUntil = Date.now() + (5000 * this.rateLimitBackoff);
                                Logger.warn(`[PlaylistDiscovery] Rate limit hit! Backing off for ${5 * this.rateLimitBackoff}s`);
                            }
                        })
                        .finally(() => {
                            this.coverUpdateInFlight = Math.max(0, this.coverUpdateInFlight - 1);
                            this.coverUpdatePromises.delete(next.id);
                            next.resolve();
                        });

                    if (this.COVER_UPDATE_DELAY_MS > 0) {
                        await this.delay(this.COVER_UPDATE_DELAY_MS);
                    }
                }
                await this.delay(200);
            }
            this.coverUpdateRunning = false;
        };

        void pump();
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private async updatePlaylistCoverAndCount(playlist: FetchedPlaylist, pageSize: number): Promise<boolean> {
        const rawId = playlist.id || playlist.discovered?.id || '';
        const playlistId = rawId.toLowerCase();
        if (!playlistId) return false;

        // Check if cover URL is already resolved from cache — skip API call entirely
        const cached = this.metadataCache.get(playlistId);
        if (cached?.coverUrlResolved && cached.coverUrl && playlist.worksCount > 0) {
            if (cached.coverUrl !== playlist.coverUrl) {
                playlist.coverUrl = cached.coverUrl;
                const card = this.createPlaylistCard({ ...playlist, id: playlistId });
                this.replaceSkeletonWithCard(playlistId, card);
            }
            // Schedule background revalidation if past soft TTL
            if (cached.cachedAt && Date.now() - cached.cachedAt > METADATA_SOFT_TTL_MS) {
                this.scheduleBackgroundCoverRevalidation(playlistId, playlist, pageSize);
            }
            return true;
        }

        if (playlist.coverUrl && playlist.worksCount > 0) {
            return true;
        }

        try {
            const worksData = await apiRequest<PlaylistWorksResponse>('/api/playlist/get-playlist-works', {
                id: playlistId,
                page: 1,
                pageSize,
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

            this.metadataCache.set(playlistId, {
                id: playlistId,
                name: playlist.name || 'Unnamed',
                user_name: playlist.user_name || '',
                worksCount: playlist.worksCount || 0,
                latestWorkId: 0,
                coverUrl: playlist.coverUrl || '',
                coverUrlResolved: true,
                cachedAt: Date.now(),
            });
            this.saveMetadataCache();

            const card = this.createPlaylistCard({ ...playlist, id: playlistId });
            this.replaceSkeletonWithCard(playlistId, card);
            return true;
        } catch (error: any) {
            Logger.warn(`[PlaylistDiscovery] Failed to update cover/count for ${playlistId}:`, error);
            if (error?.status === 429) {
                throw error; // Re-throw to trigger backoff
            }
            return false;
        }
    }

    private scheduleBackgroundCoverRevalidation(playlistId: string, playlist: FetchedPlaylist, pageSize: number): void {
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

                this.metadataCache.set(playlistId, {
                    id: playlistId,
                    name: playlist.name || 'Unnamed',
                    user_name: playlist.user_name || '',
                    worksCount: playlist.worksCount || 0,
                    latestWorkId: 0,
                    coverUrl: playlist.coverUrl || '',
                    coverUrlResolved: true,
                    cachedAt: Date.now(),
                });
                this.saveMetadataCache();

                if (changed) {
                    const card = this.createPlaylistCard({ ...playlist, id: playlistId });
                    this.replaceSkeletonWithCard(playlistId, card);
                }
            } catch {
                // Silent failure for background revalidation
            }
        }, 2000 + Math.random() * 3000);
    }

    private showSearchingStatus(): void {
        const feedback = document.getElementById('search-feedback');
        if (feedback) {
            feedback.style.display = 'block';
            feedback.innerHTML = `<span class="text-caption" style="color: var(--q-info);">${I18n.t('playlistSearching')}</span>`;
        }
    }

    private updateSearchProgress(page: number, found: number): void {
        const feedback = document.getElementById('search-feedback');
        if (feedback) {
            feedback.innerHTML = `<span class="text-caption">${I18n.format('playlistSearchingPage', { page, found })}</span>`;
        }
    }

    private hideSearchingStatus(): void {
        // handled by button logic mostly
    }

    /**
     * Load discovered playlists from GM storage (cross-domain)
     */
    private loadDiscoveredPlaylists(): void {
        try {
            const stored = GooglePlaylistScraper.safeGetValue(STORAGE_KEY, null);
            if (stored) {
                const parsed = (typeof stored === 'string' ? JSON.parse(stored) : stored) as DiscoveredPlaylist[];
                this.discoveredPlaylists = (parsed || []).filter(p => p.source === 'manual');
                Logger.debug('[PlaylistDiscovery] Loaded', this.discoveredPlaylists.length, 'manual playlists');
            }
        } catch (e) {
            Logger.warn('[PlaylistDiscovery] Failed to load discovered playlists:', e);
            this.discoveredPlaylists = [];
        }
    }

    /**
     * Save discovered playlists to GM storage (cross-domain)
     */
    private saveDiscoveredPlaylists(): void {
        try {
            const manualOnly = this.discoveredPlaylists.filter(p => p.source === 'manual');
            const data = JSON.stringify(manualOnly);
            GooglePlaylistScraper.safeSetValue(STORAGE_KEY, data);
        } catch (e) {
            Logger.warn('[PlaylistDiscovery] Failed to save discovered playlists:', e);
        }
    }

    /**
     * Add a playlist by URL or ID manually
     */
    addPlaylistManually(urlOrId: string): boolean {
        // Extract ID from URL or use directly
        let playlistId: string | null = null;
        const queryMatch = urlOrId.match(/[?&]id=([a-f0-9-]{36})/i);
        const pathMatch = urlOrId.match(/\/playlist\/([a-f0-9-]{36})/i);
        const directMatch = urlOrId.match(/^([a-f0-9-]{36})$/i);

        playlistId = queryMatch?.[1] || pathMatch?.[1] || directMatch?.[1] || null;

        if (!playlistId) {
            Logger.warn('[PlaylistDiscovery] Invalid playlist URL or ID:', urlOrId);
            return false;
        }

        if (this.discoveredPlaylists.find(p => p.id === playlistId)) {
            Logger.debug('[PlaylistDiscovery] Playlist already discovered:', playlistId);
            return false;
        }

        this.discoveredPlaylists.push({
            id: playlistId,
            discovered_at: Date.now(),
            source: 'manual',
        });
        this.saveDiscoveredPlaylists();
        Logger.debug('[PlaylistDiscovery] Manually added playlist:', playlistId);
        return true;
    }

    /**
     * Force refresh search results (clears cache)
     */
    async refreshSearch(): Promise<void> {
        GM_setValue(CACHE_KEY, null);
        await this.runManualSearch();
    }

    private async loadNextBatch(): Promise<void> {
        if (this.isLoading) return;
        this.isLoading = true;
        this.updateStatusText();

        if (this.sentinelElement) this.sentinelElement.style.display = 'block';

        const startTime = performance.now();
        const startIdx = this.displayedCount;
        const endIdx = Math.min(startIdx + this.BATCH_SIZE, this.publicPlaylists.length);
        const WORKS_PAGE_SIZE = 1;

        if (startIdx >= this.publicPlaylists.length) {
            Logger.debug('[PlaylistDiscovery] All playlists loaded');
            this.isLoading = false;
            if (this.sentinelElement) this.sentinelElement.style.display = 'none';
            this.updateStatusText();
            return;
        }

        try {
            Logger.debug(`[PlaylistDiscovery] Loading batch ${startIdx} to ${endIdx}`);
            const batchItems = this.publicPlaylists.slice(startIdx, endIdx);
            const coverUpdatePromises: Promise<void>[] = [];

            // 1. Render Skeletons for the new batch immediately
            const grid = document.getElementById('public-playlists-grid');
            if (grid) {
                batchItems.forEach(item => {
                    // Check if we already have it cached to show better placeholder?
                    // For now, just show skeleton, will be replaced instantly if cached
                    const skeleton = this.createSkeletonCard();
                    skeleton.dataset.playlistId = item.id.toLowerCase();
                    grid.appendChild(skeleton);
                });
            }

            // 2. Identify cached vs uncached (skip previously failed playlists)
            const uncachedItems: DiscoveredPlaylist[] = [];
            const cachedItems: FetchedPlaylist[] = [];

            for (const discovered of batchItems) {
                // Skip playlists that have previously failed to load
                if (this.isPlaylistFailed(discovered.id)) {
                    const skeleton = grid?.querySelector(`[data-playlist-id="${discovered.id.toLowerCase()}"]`);
                    skeleton?.remove();
                    continue;
                }

                const cached = this.metadataCache.get(discovered.id);
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

            // 3. Preload images for cached items with known cover URLs
            const preloadPromises: Promise<void>[] = [];
            for (const item of cachedItems) {
                if (item.coverUrl && item.worksCount > 0) {
                    preloadPromises.push(this.preloadImage(item.coverUrl));
                }
            }
            if (preloadPromises.length > 0) {
                await Promise.race([
                    Promise.all(preloadPromises),
                    this.delay(500),
                ]);
            }

            // 4. Render Cached Items Immediately (skip 0-work playlists unless they're user's own)
            cachedItems.forEach(item => {
                const isUserPlaylist = this.currentUserPlaylistIds?.has(item.id) ||
                                      item.discovered?.source === 'user';
                // Only skip 0-work playlists for non-user playlists
                if (!isUserPlaylist && item.worksCount === 0) {
                    const skeleton = grid?.querySelector(`[data-playlist-id="${item.id.toLowerCase()}"]`);
                    skeleton?.remove();
                    return;
                }
                const card = this.createPlaylistCard(item);
                this.replaceSkeletonWithCard(item.id, card);
                this.loadedPlaylists.push(item);
                // Only enqueue cover update if cover URL isn't already resolved
                const cached = this.metadataCache.get(item.id.toLowerCase());
                if (!cached?.coverUrlResolved || !item.coverUrl) {
                    coverUpdatePromises.push(this.enqueueCoverUpdate(item, WORKS_PAGE_SIZE));
                }
            });

            // 4. Fetch Uncached Items
            if (uncachedItems.length > 0) {
                // Fetch multiple playlists in parallel for faster streaming
                const FETCH_BATCH_SIZE = this.METADATA_BATCH_SIZE;

                for (let i = 0; i < uncachedItems.length; i += FETCH_BATCH_SIZE) {
                    const fetchBatch = uncachedItems.slice(i, i + FETCH_BATCH_SIZE);
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
                                // Mark as failed so we don't retry for 24 hours
                                this.markPlaylistFailed(discovered.id);
                                return { ok: false, id: discovered.id };
                            }
                        })
                    );

                    // Stream results as they come in (no batching delay)
                    results.forEach(result => {
                        if (result.status === 'fulfilled' && result.value) {
                            if (!result.value.ok) {
                                const failedId = result.value.id.toLowerCase();
                                const skeleton = grid?.querySelector(`[data-playlist-id="${failedId}"]`);
                                skeleton?.remove();
                                return;
                            }
                            const playlist = result.value.playlist;
                            const playlistId = playlist.id || playlist.discovered?.id;

                            // Skip non-user playlists with 0 works (user's own always shown)
                            const isUserPlaylist = this.currentUserPlaylistIds?.has(playlistId) ||
                                                  playlist.discovered?.source === 'user';
                            if (!isUserPlaylist && playlist.worksCount === 0) {
                                const emptyId = playlistId?.toLowerCase();
                                if (emptyId) {
                                    const skeleton = grid?.querySelector(`[data-playlist-id="${emptyId}"]`);
                                    skeleton?.remove();
                                }
                                return;
                            }

                            if (playlistId) {
                                const finalId = playlistId.toLowerCase();
                                const finalPlaylist = { ...playlist, id: finalId };
                                this.loadedPlaylists.push(finalPlaylist);

                                this.metadataCache.set(finalId, {
                                    id: finalId,
                                    name: playlist.name || 'Unnamed',
                                    user_name: playlist.user_name || '',
                                    worksCount: playlist.worksCount || 0,
                                    coverUrl: playlist.coverUrl || '',
                                    cachedAt: Date.now(),
                                });

                                const card = this.createPlaylistCard(finalPlaylist);
                                this.replaceSkeletonWithCard(finalId, card);
                                coverUpdatePromises.push(this.enqueueCoverUpdate(finalPlaylist, WORKS_PAGE_SIZE));
                            }
                        }
                    });

                    if (i + FETCH_BATCH_SIZE < uncachedItems.length) {
                        await this.delay(this.BATCH_COOLDOWN_MS);
                    }
                }
                this.saveDiscoveredPlaylists();
                this.saveMetadataCache();
            }

            this.displayedCount = endIdx;
            this.updateStatusText();
            if (coverUpdatePromises.length > 0) {
                await Promise.allSettled(coverUpdatePromises);
            }

        } catch (error) {
            Logger.error('[PlaylistDiscovery] Failed to load batch:', error);
        } finally {
            this.isLoading = false;
            // Hide sentinel if we reached the end
            if (this.displayedCount >= this.publicPlaylists.length && this.sentinelElement) {
                this.sentinelElement.style.display = 'none';
            }
            this.updateLoadingProgress();
            this.updateStatusText();

            // Check if infinite scroll is enabled before auto-loading next batch
            const infiniteScrollEnabled = AppStore.getConfig('enableInfiniteScroll');
            if (infiniteScrollEnabled && this.sentinelInView && this.displayedCount < this.publicPlaylists.length) {
                setTimeout(() => {
                    if (!this.isLoading && this.sentinelInView) {
                        this.queueLoadNextBatch();
                    }
                }, this.BATCH_COOLDOWN_MS);
            }
        }
    }

    private async getCurrentUserName(): Promise<string | null> {
        if (this.currentUserName !== null) return this.currentUserName;
        try {
            const me = await AuthApi.getCurrentUser();
            const name = me?.user?.name || null;
            this.currentUserName = name;
            return name;
        } catch (e) {
            Logger.warn('[PlaylistDiscovery] Failed to get current user name:', e);
            this.currentUserName = null;
            return null;
        }
    }

    private async getCurrentUserPlaylistIds(): Promise<Set<string>> {
        if (this.currentUserPlaylistIds) return this.currentUserPlaylistIds;

        if (!this.currentUserName) {
            await this.getCurrentUserName();
        }

        // Fetch owned + liked from API (don't rely on native Vue component)
        try {
            const [owned, liked] = await Promise.all([
                this.fetchAllPlaylistPages('owned'),
                this.fetchAllPlaylistPages('liked'),
            ]);

            this.ownedPlaylistsCache = owned;
            this.likedPlaylistsCache = liked;

            const seenIds = new Set<string>();
            const all: PlaylistEntry[] = [];
            for (const p of [...owned, ...liked]) {
                if (!seenIds.has(p.id)) {
                    seenIds.add(p.id);
                    all.push(p);
                }
            }

            this.userPlaylistsFromApi = all;
            this.currentUserPlaylistIds = seenIds;
            this.saveUserPlaylistsCache();
            Logger.debug(`[PlaylistDiscovery] Fetched ${owned.length} owned + ${liked.length} liked = ${all.length} user playlists from API`);
            return this.currentUserPlaylistIds;
        } catch (e) {
            Logger.warn('[PlaylistDiscovery] Failed to fetch user playlists, treating as guest:', e);
            this.userPlaylistsFromApi = [];
            this.currentUserPlaylistIds = new Set();
            return this.currentUserPlaylistIds;
        }
    }

    private showNoPlaylistsMessage(): void {
        const mountParent = this.resolvePlaylistsMountParent();
        if (!mountParent) return;

        if (this.containerElement) {
            this.containerElement.remove();
        }

        this.containerElement = document.createElement('div');
        this.containerElement.id = 'asmr-ultimate-public-playlists';
        this.containerElement.className = this.getCardClass() + ' q-mt-lg q-pa-md';

        this.containerElement.innerHTML = `
            <div class="text-center">
                <div class="text-subtitle1 q-mb-sm">${this.escapeHtml(I18n.t('playlistDiscoverTitle'))}</div>
                <div class="text-body2 ${this.getMutedTextClass()} q-mb-md">
                    ${this.escapeHtml(I18n.format('playlistDiscoverHint', { action: I18n.t('playlistFindMore') }))}
                </div>
                <div class="row justify-center q-gutter-sm q-mb-md">
                    <button id="search-google-btn" class="q-btn q-btn-item non-selectable no-outline q-btn--flat q-btn--rectangle bg-primary text-white">
                        ${this.escapeHtml(I18n.t('playlistFindMore'))}
                    </button>
                </div>
            </div>
        `;

        // Attach event listeners
        this.attachSearchButtonHandler();
        this.attachRandomizeButtonHandler();

        mountParent.appendChild(this.containerElement);
    }

    private showErrorMessage(): void {
        const mountParent = this.resolvePlaylistsMountParent();
        if (!mountParent) return;

        if (this.containerElement) {
            this.containerElement.remove();
        }

        this.containerElement = document.createElement('div');
        this.containerElement.id = 'asmr-ultimate-public-playlists';
        this.containerElement.className = this.getCardClass() + ' q-mt-lg q-pa-md';

        this.containerElement.innerHTML = `
            <div class="text-center">
                <div class="text-body2 text-negative">
                    ${this.escapeHtml(I18n.t('playlistLoadFailed'))}
                </div>
            </div>
        `;

        mountParent.appendChild(this.containerElement);
    }

    private attachSearchButtonHandler(): void {
        const btn = document.getElementById('search-google-btn');
        if (!btn) return;

        btn.onclick = async () => {
            const feedback = document.getElementById('search-feedback');
            const originalHtml = btn.innerHTML;
            btn.innerHTML = `<span style="display: flex; align-items: center; gap: 4px;">${this.escapeHtml(I18n.t('playlistSearchingButton'))}</span>`;
            (btn as HTMLButtonElement).disabled = true;
            btn.style.opacity = '0.6';

            if (feedback) {
                feedback.style.display = 'block';
                feedback.innerHTML = `<span class="text-caption" style="color: var(--q-info);">${this.escapeHtml(I18n.t('playlistSearching'))}</span>`;
            }

            try {
                const result = await this.runManualSearch();

                if (feedback) {
                    if (result.isRateLimited) {
                        feedback.innerHTML = '<span class="text-caption" style="color: var(--q-warning);">⚠️ Rate limited by Google. Try again in 30 minutes.</span>';
                    } else if (result.found > 0) {
                        feedback.innerHTML = `<span class="text-caption" style="color: var(--q-positive);">✓ Found ${result.found} playlists from Google</span>`;
                        setTimeout(() => { if (feedback) feedback.style.display = 'none'; }, 3000);
                    } else {
                        feedback.innerHTML = '<span class="text-caption" style="color: var(--q-grey);">No new playlists found</span>';
                        setTimeout(() => { if (feedback) feedback.style.display = 'none'; }, 3000);
                    }
                }
            } catch (e) {
                if (feedback) {
                    feedback.innerHTML = `<span class="text-caption" style="color: var(--q-negative);">${this.escapeHtml(I18n.t('playlistSearchFailed'))}</span>`;
                }
            } finally {
                btn.innerHTML = originalHtml;
                (btn as HTMLButtonElement).disabled = false;
                btn.style.opacity = '1';
            }
        };
    }

    private attachRandomizeButtonHandler(): void {
        const btn = document.getElementById('playlists-randomize-btn');
        if (!btn) return;

        btn.onclick = () => {
            const originalHtml = btn.innerHTML;
            btn.innerHTML = `<span style="display: flex; align-items: center; gap: 4px;">${this.escapeHtml(I18n.t('playlistRandomizing'))}</span>`;
            (btn as HTMLButtonElement).disabled = true;

            requestAnimationFrame(async () => {
                try {
                    // Fisher-Yates shuffle
                    for (let i = this.publicPlaylists.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [this.publicPlaylists[i], this.publicPlaylists[j]] = [this.publicPlaylists[j], this.publicPlaylists[i]];
                    }

                    // Reset and Reload
                    const grid = document.getElementById('public-playlists-grid');
                    if (grid) grid.innerHTML = '';
                    this.displayedCount = 0;
                    this.loadedPlaylists = [];

                    await this.queueLoadNextBatch();

                } catch (e) {
                    Logger.warn('[PlaylistDiscovery] Randomize failed', e);
                } finally {
                    btn.innerHTML = originalHtml;
                    (btn as HTMLButtonElement).disabled = false;
                }
            });
        };
    }

    private attachTextFilterHandler(): void {
        const input = document.getElementById('playlist-text-filter') as HTMLInputElement | null;
        if (!input) return;

        input.oninput = () => {
            if (this.textFilterDebounceTimer) clearTimeout(this.textFilterDebounceTimer);
            this.textFilterDebounceTimer = setTimeout(() => {
                const newFilter = input.value.trim().toLowerCase();
                if (newFilter === this.textFilter) return;
                this.textFilter = newFilter;
                this.applyTextFilter();
            }, 300);
        };
    }

    private applyTextFilter(): void {
        // Re-apply filter mode (which now also considers text filter)
        this.applyFilterMode();

        // Reset and reload grid
        const grid = document.getElementById('public-playlists-grid');
        if (grid) grid.innerHTML = '';
        this.displayedCount = 0;
        this.loadedPlaylists = [];
        this.updateCountBadge();

        void this.queueLoadNextBatch();
    }

    /**
     * Check if a playlist matches the current text filter.
     * Matches against cached name and user_name.
     */
    private matchesTextFilter(d: DiscoveredPlaylist): boolean {
        if (!this.textFilter) return true;
        const cached = this.metadataCache.get(d.id);
        const name = (cached?.name || d.name || '').toLowerCase();
        const userName = (cached?.user_name || d.user_name || '').toLowerCase();
        return name.includes(this.textFilter) || userName.includes(this.textFilter);
    }

    private setupNativeFilterWatcher(): void {
        // Find the native filter dropdown Vue component
        const select = document.querySelector('.q-page .q-select');
        const selectVue = (select as any)?.__vue__;

        if (!selectVue) {
            Logger.warn('[PlaylistDiscovery] Could not find native filter dropdown');
            return;
        }

        // Get the options array and inject our "Online only" option
        const options = selectVue.options;
        if (Array.isArray(options)) {
            // Check if we already added it
            const onlineLabel = I18n.t('playlistOnlineOnly');
            const hasOnlineOption = options.some((opt: any) =>
                opt?.label === onlineLabel || opt?.value === 'online'
            );

            if (!hasOnlineOption) {
                // Create option matching the native format
                // Native options appear to be { label: string, value: string }
                const sampleOption = options[0];
                const onlineOption = sampleOption && typeof sampleOption === 'object'
                    ? { ...sampleOption, label: onlineLabel, value: 'online' }
                    : { label: onlineLabel, value: 'online' };

                options.push(onlineOption);
                Logger.debug('[PlaylistDiscovery] Injected "Online only" option into native dropdown');
            }
        }

        Logger.debug('[PlaylistDiscovery] Native filter options:', options);

        // Watch for changes using Vue's $watch
        if (selectVue.$watch) {
            this.nativeFilterUnwatch = selectVue.$watch('value', (newVal: any) => {
                // Determine filter mode from value
                // Options: All, I created, I liked, Online only (injected)
                const valueLabel = newVal?.label || newVal?.value || '';
                const valueLower = String(valueLabel).toLowerCase();
                const onlineLabel = I18n.t('playlistOnlineOnly').toLowerCase();

                let newMode: PlaylistFilterMode = 'all';
                if (valueLower.includes('online') || valueLower === onlineLabel || valueLower.includes('オンライン') || valueLower.includes('仅在线')) {
                    newMode = 'online';
                } else if (valueLower.includes('liked') || valueLower.includes('お気に入り') || valueLower.includes('喜欢')) {
                    newMode = 'mine';
                } else if (valueLower.includes('created') || valueLower.includes('作成') || valueLower.includes('创建')) {
                    newMode = 'public'; // "I created" maps to showing user's created playlists
                }

                Logger.debug('[PlaylistDiscovery] Native filter changed:', valueLabel, '-> mode:', newMode);
                this.setFilterMode(newMode);
            }, { immediate: false });

            Logger.debug('[PlaylistDiscovery] Native filter watcher attached');
        }
    }

    private trackImageLoad(img: HTMLImageElement): void {
        this.pendingImageLoads++;
        const onLoad = () => {
            this.pendingImageLoads--;
            img.removeEventListener('load', onLoad);
            img.removeEventListener('error', onLoad);
            this.checkAndTriggerNextBatch();
        };
        img.addEventListener('load', onLoad);
        img.addEventListener('error', onLoad);
    }

    private checkAndTriggerNextBatch(): void {
        // Only trigger next batch if no pending images and sentinel is in view
        if (this.pendingImageLoads === 0 && this.sentinelInView && this.displayedCount < this.publicPlaylists.length) {
            this.queueLoadNextBatch();
        }
    }

    private areAllImagesLoaded(): boolean {
        return this.pendingImageLoads === 0;
    }

    private createPlaylistCard(playlist: FetchedPlaylist): HTMLElement {
        const col = document.createElement('div');
        col.className = 'col-xs-6 col-sm-3 col-md-2 col-lg-2 col-xl-2';

        // Get cover image - prefer pre-fetched coverUrl from API
        let coverUrl = playlist.coverUrl || '';
        const discovered = playlist.discovered;
        const rawPlaylistId = playlist.id || discovered?.id || '';
        const playlistId = rawPlaylistId.toLowerCase();
        col.dataset.playlistId = playlistId;

        // Fallback: try to extract from works array if coverUrl not set
        if (!coverUrl && playlist.works && playlist.works.length > 0) {
            const firstWork = playlist.works[0];
            if (firstWork && typeof firstWork === 'object' && 'mainCoverUrl' in firstWork) {
                coverUrl = (firstWork as { mainCoverUrl?: string }).mainCoverUrl || '';
            }
        }

        const worksCount = playlist.worksCount || playlist.works?.length || discovered?.works_count || 0;
        const userName = playlist.user_name || discovered?.user_name || 'Unknown';
        const playlistName = playlist.name || discovered?.name || 'Unnamed Playlist';

        // Add source badge - only for manually added playlists
        let sourceBadge = '';
        if (discovered?.source === 'manual') {
            sourceBadge = `<span style="background: #4caf50; color: #fff; padding: 2px 6px; border-radius: 3px; font-size: 0.7rem; margin-left: 6px;">${this.escapeHtml(I18n.t('playlistAddedBadge'))}</span>`;
        }

        // Fallback gradient when no cover image available
        const isDark = document.body.classList.contains('body--dark') || document.body.classList.contains('q-dark');
        const fallbackGradient = isDark
            ? 'linear-gradient(135deg, #3a3a52 0%, #2a2a3e 50%, #1a1a2e 100%)'
            : 'linear-gradient(135deg, #667eea 0%, #764ba2 50%, #f093fb 100%)';

        // If image is preloaded, render directly; otherwise use data-src for lazy loading
        const isPreloaded = coverUrl && this.preloadedImageUrls.has(coverUrl);
        const imageHtml = coverUrl
            ? isPreloaded
                ? `<div class="q-img__image absolute-full" style="background-size: cover; background-position: 50% 50%;">
                        <div class="absolute-full fit playlist-lazy-image loaded" style="background-size: cover; background-position: 50% 50%; background-image: url('${coverUrl}');"></div>
                   </div>`
                : `<div class="q-img__image absolute-full" style="background-size: cover; background-position: 50% 50%;">
                        <div class="absolute-full fit playlist-lazy-image" data-src="${coverUrl}" style="background-size: cover; background-position: 50% 50%;"></div>
                   </div>`
            : `<div class="q-img__image absolute-full" style="background: ${fallbackGradient};">
                    <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 2.5rem; opacity: 0.6;">🎵</div>
               </div>`;

        col.innerHTML = `
            <div class="${this.getCardClass()}">
                <a href="/playlist?id=${playlistId}" class="">
                    <div role="img" class="q-img overflow-hidden q-img--menu" style="max-width: 560px;">
                        <div style="padding-bottom: 75%;"></div>
                        ${imageHtml}
                        <div class="q-img__content absolute-full"></div>
                    </div>
                </a>
                <hr aria-orientation="horizontal" class="q-separator q-separator q-separator--horizontal q-separator--dark">
                <div>
                    <div class="q-card__section q-card__section--vert">
                        <a href="/playlist?id=${playlistId}" class="" style="color: inherit;">
                            <div class="text-h6 ellipsis-2-lines" style="font-weight: 500;">
                                ${this.escapeHtml(playlistName)}${sourceBadge}
                            </div>
                        </a>
                        <div class="ellipsis-2-lines q-pt-sm" style="font-weight: 400; opacity: 0.6; line-height: 1.25rem;">
                            By ${this.escapeHtml(userName)} <br>
                            ${worksCount} work${worksCount !== 1 ? 's' : ''}
                        </div>
                    </div>
                </div>
            </div>
        `;

        return col;
    }

    public getCardClass(): string {
        const isDark = document.body.classList.contains('body--dark') || document.body.classList.contains('q-dark');
        return isDark ? 'q-card q-card--dark q-dark' : 'q-card';
    }

    public getMutedTextClass(): string {
        const isDark = document.body.classList.contains('body--dark') || document.body.classList.contains('q-dark');
        return isDark ? 'text-grey-5' : 'text-grey-7';
    }

    private preloadImage(url: string): Promise<void> {
        if (!url || this.preloadedImageUrls.has(url)) return Promise.resolve();
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => { this.preloadedImageUrls.add(url); resolve(); };
            img.onerror = () => resolve();
            img.src = url;
            setTimeout(resolve, 3000);
        });
    }

    private escapeHtml(text: string): string {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    private cleanup(): void {
        Logger.log('[PlaylistDiscovery] Cleaning up');
        this.isActive = false;
        this.sentinelInView = false;
        this.isBulkLoading = false;
        this.loadNextBatchPromise = null;
        this.textFilter = '';
        if (this.textFilterDebounceTimer) {
            clearTimeout(this.textFilterDebounceTimer);
            this.textFilterDebounceTimer = null;
        }
        document.getElementById('playlist-text-filter')?.remove();

        if (this.imageObserver) {
            this.imageObserver.disconnect();
            this.imageObserver = null;
        }

        if (this.scrollObserver) {
            this.scrollObserver.disconnect();
            this.scrollObserver = null;
        }

        if (this.containerElement) {
            this.containerElement.remove();
            this.containerElement = null;
        }
        if (this.controlsRowEl) {
            this.controlsRowEl.remove();
            this.controlsRowEl = null;
        }

        // Restore native grid and pagination visibility
        this.restoreNativeGridAndPagination();

        // Clear display state but NOT cache state (metadataCache, currentUserPlaylistIds,
        // userPlaylistsFromApi, filterMode survive for instant re-render on revisit)
        this.displayedCount = 0;
        this.loadedPlaylists = [];
        this.preloadedImageUrls.clear();
        this.statusElement = null;
    }

    /**
     * Invalidate cache for a specific playlist (e.g., after user edits it)
     */
    public invalidatePlaylistCache(playlistId: string): void {
        const id = playlistId.toLowerCase();
        this.metadataCache.delete(id);
        this.saveMetadataCache();
        Logger.debug('[PlaylistDiscovery] Invalidated cache for playlist:', id);
    }

    /**
     * Invalidate user playlists cache (e.g., after creating/deleting a playlist)
     */
    public invalidateUserPlaylistsCache(): void {
        try { GooglePlaylistScraper.safeSetValue(USER_PLAYLISTS_CACHE_KEY, ''); } catch { /* ignore */ }
        this.currentUserPlaylistIds = null;
        this.userPlaylistsFromApi = [];
        this.likedPlaylistsCache = null;
        this.ownedPlaylistsCache = null;
        Logger.debug('[PlaylistDiscovery] Invalidated user playlists cache');
    }

    destroy(): void {
        this.cleanup();

        if (this.routeUnwatch) {
            this.routeUnwatch();
            this.routeUnwatch = null;
        }
    }
}
