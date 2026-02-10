/**
 * PlaylistMode - Manages playback within a playlist context
 *
 * Distinct from RadioMode:
 * - Stores work RJ codes (not random selection)
 * - Auto-advances to next work when last track of current work completes
 * - Shows forward/back navigation in player bar
 * - Active when on /playlist/* routes, returns to inactive on home
 * - Mutually exclusive with RadioMode
 */

import { KikoeruBridge } from '../../infrastructure/KikoeruBridge';
import { EventBus } from '../../core/EventBus';
import { Logger, Config } from '../../core/Utils';
import { RadioMode } from '../radio';
import { PlaybackController } from '../radio/PlaybackController';
import { FolderDiver } from '../FolderDiver';
import { PlaylistApi, PlaylistWorkItem } from '../../api/Playlist';
import { WorkService } from '../../services/WorkService';
import type { PlaylistModeState, WorkDetail, PlayerTrack, AudioTrack } from '../../types';
import type { TrackFolder, TracksResponse } from '../../types/api';

const QUEUE_END_CHECK_INTERVAL = 1500;
const WORK_CHANGE_DEBOUNCE_MS = 500;
const PLAYBACK_SETTLE_DELAY = 1500;

// Store singleton on window to persist across script re-injections
declare const unsafeWindow: Window & typeof globalThis;
const globalWindow = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) as Window & {
    __ASMR_PLAYLIST_MODE__?: PlaylistMode;
};

export class PlaylistMode {
    private static _instance: PlaylistMode;
    private bridge: KikoeruBridge;
    private playbackController: PlaybackController;
    private folderDiver: FolderDiver;

    // State
    private _isActive = false;
    private workIds: string[] = [];
    private currentWorkIndex = 0;
    private playlistId: string | null = null;
    private playlistName: string | null = null;
    private isNavigating = false;
    private isInitialized = false;
    private hasAdvanced = false; // Prevents double-trigger from queue monitor + track:end
    private playAllInFolder = false;

    // Shuffle visited tracking: indices already played in this cycle
    private visitedIndices: Set<number> = new Set();

    // Watchers/Timers
    private _routeWatcher: (() => void) | null = null; // stored for future cleanup
    private checkInterval: number | null = null;
    private lastQueueIndex = -1;
    private workChangeDebounceTimer: number | null = null;
    private navigationTimer: number | null = null;
    private isLoadingFromUrl = false;
    private lastLoadedPlaylistId: string | null = null;

    private constructor() {
        this.bridge = KikoeruBridge.getInstance();
        this.playbackController = new PlaybackController();
        this.folderDiver = FolderDiver.getInstance();
    }

    static getInstance(): PlaylistMode {
        // Check window first for persisted instance
        if (globalWindow.__ASMR_PLAYLIST_MODE__) {
            PlaylistMode._instance = globalWindow.__ASMR_PLAYLIST_MODE__;
            PlaylistMode._instance.refreshDependencies();
            Logger.debug('[PlaylistMode] Reusing persisted instance');
            return PlaylistMode._instance;
        }

        if (!PlaylistMode._instance) {
            PlaylistMode._instance = new PlaylistMode();
            globalWindow.__ASMR_PLAYLIST_MODE__ = PlaylistMode._instance;
        }
        return PlaylistMode._instance;
    }

    /**
     * Refresh dependencies that may be stale after script re-injection
     */
    private refreshDependencies(): void {
        this.bridge = KikoeruBridge.getInstance();
        this.playbackController = new PlaybackController();
        this.folderDiver = FolderDiver.getInstance();
    }

    /**
     * Static accessor for active state
     */
    static get isActive(): boolean {
        return PlaylistMode._instance?._isActive ?? false;
    }

    /**
     * Instance accessor for active state
     */
    get isActive(): boolean {
        return this._isActive;
    }

    /**
     * Get current state
     */
    getState(): PlaylistModeState {
        return {
            isActive: this._isActive,
            workIds: [...this.workIds],
            currentWorkIndex: this.currentWorkIndex,
            playlistId: this.playlistId,
            playlistName: this.playlistName,
        };
    }

    /**
     * Initialize playlist mode (call on plugin startup)
     */
    initialize(): void {
        if (this.isInitialized) {
            Logger.warn('[PlaylistMode] Already initialized, skipping');
            return;
        }
        this.isInitialized = true;

        // Setup route watcher
        this.setupRouteWatcher();

        // Listen for track end events
        EventBus.on('track:end', () => this.handleTrackEnd());

        // Listen for work change events
        EventBus.on('work:change', (event: { workId: string; work: WorkDetail }) => this.onWorkChange(event));
        EventBus.on('config:change', ({ key, value }: { key: string; value: unknown }) => {
            if (key === 'playlistPlayAllInFolder') {
                this.playAllInFolder = !!value;
            }
        });

        Logger.log('[PlaylistMode] Initialized');
    }

    /**
     * Activate playlist mode with given work IDs
     * @param autoNavigate - if false, don't navigate to first work (used when loading from URL)
     */
    activate(workIds: string[], playlistId?: string, playlistName?: string, autoNavigate = true): void {
        if (this._isActive && this.playlistId === playlistId) {
            Logger.debug('[PlaylistMode] Already active with same playlist');
            return;
        }

        // Disable RadioMode if active (mutually exclusive)
        const radio = RadioMode.getInstance();
        if (radio.isActive) {
            Logger.debug('[PlaylistMode] Disabling RadioMode (mutually exclusive)');
            radio.disable();
        }

        // Clear stale navigation state from previous activation
        if (this.navigationTimer !== null) {
            clearTimeout(this.navigationTimer);
            this.navigationTimer = null;
        }
        this.isNavigating = false;
        this.hasAdvanced = false;
        this.visitedIndices.clear();

        this._isActive = true;
        this.workIds = [...workIds];
        this.currentWorkIndex = 0;
        this.playlistId = playlistId || null;
        this.playlistName = playlistName || null;
        this.playAllInFolder = Config.get('playlistPlayAllInFolder');
        this.lastQueueIndex = this.bridge.player.queueIndex ?? 0;

        // Emit activation event
        EventBus.emit('playlist:active', {
            isActive: true,
            workIds: this.workIds,
            playlistId: this.playlistId || undefined,
        });

        // Emit initial progress
        EventBus.emit('playlist:progress', {
            current: 1,
            total: this.workIds.length,
            workId: this.workIds[0] || '',
        });

        // Start queue monitoring
        this.startQueueMonitor();

        Logger.log(`[PlaylistMode] Activated with ${workIds.length} works${playlistName ? ` from "${playlistName}"` : ''} (ID: ${playlistId || 'unknown'})`);

        // Navigate to first work if we have any (unless loading from URL)
        if (autoNavigate && workIds.length > 0) {
            this.navigateToWork(0);
        }
    }

    /**
     * Load playlist from the current page URL (/playlist?id=UUID)
     * Fetches playlist metadata from the API and activates with all work IDs
     */
    async loadFromUrl(playlistId: string): Promise<void> {
        if (this.isLoadingFromUrl) {
            Logger.debug('[PlaylistMode] Already loading from URL, ignoring');
            return;
        }
        if (this._isActive && this.playlistId === playlistId) {
            Logger.debug('[PlaylistMode] Already active with this playlist');
            return;
        }
        if (this.lastLoadedPlaylistId === playlistId && this._isActive) {
            return;
        }

        this.isLoadingFromUrl = true;
        Logger.debug('[PlaylistMode] Loading playlist from URL, id:', playlistId);

        try {
            // Fetch metadata + first page of works in parallel (fast — single API call each)
            const [metadata, firstPage] = await Promise.all([
                PlaylistApi.getPlaylistMetadata(playlistId),
                PlaylistApi.getPlaylistWorks(playlistId, 1, 100),
            ]);

            const firstWorks = firstPage.works || [];
            if (firstWorks.length === 0) {
                Logger.warn('[PlaylistMode] Playlist has no works');
                return;
            }

            const extractIds = (works: PlaylistWorkItem[]) => works.map((w) => {
                if (w.source_id) return w.source_id;
                if (w.id) return `RJ${String(w.id).padStart(8, '0')}`;
                return String(w);
            });

            const firstWorkIds = extractIds(firstWorks);
            const totalCount = firstPage.pagination?.totalCount ?? firstWorks.length;
            const totalPages = Math.ceil(totalCount / 100);

            Logger.debug(`[PlaylistMode] Fetched first page: ${firstWorkIds.length}/${totalCount} works from "${metadata.name}"`);

            this.lastLoadedPlaylistId = playlistId;

            // Activate immediately with the first page so user can interact
            this.activate(firstWorkIds, playlistId, metadata.name || undefined, false);

            // Fetch remaining pages in background and extend the playlist
            if (totalPages > 1) {
                this.fetchRemainingPages(playlistId, totalPages, totalCount, extractIds);
            }
        } catch (error) {
            Logger.error('[PlaylistMode] Failed to load playlist from URL:', error);
        } finally {
            this.isLoadingFromUrl = false;
        }
    }

    /**
     * Fetch remaining playlist pages in background and extend the work list.
     */
    private async fetchRemainingPages(
        playlistId: string,
        totalPages: number,
        totalCount: number,
        extractIds: (works: PlaylistWorkItem[]) => string[],
    ): Promise<void> {
        try {
            const pages: number[] = [];
            for (let p = 2; p <= totalPages; p++) pages.push(p);

            const batchSize = 20;
            const allRemainingWorks: PlaylistWorkItem[] = [];

            for (let i = 0; i < pages.length; i += batchSize) {
                const batch = pages.slice(i, i + batchSize);
                const results = await Promise.allSettled(
                    batch.map(page => PlaylistApi.getPlaylistWorks(playlistId, page, 100))
                );

                for (const result of results) {
                    if (result.status === 'fulfilled' && result.value.works?.length) {
                        allRemainingWorks.push(...result.value.works);
                    }
                }

                // Small delay between batches to avoid rate limiting
                if (i + batchSize < pages.length) {
                    await new Promise(r => setTimeout(r, 50));
                }
            }

            if (allRemainingWorks.length > 0 && this._isActive && this.playlistId === playlistId) {
                const remainingIds = extractIds(allRemainingWorks);
                this.workIds.push(...remainingIds);

                Logger.debug(`[PlaylistMode] Extended playlist with ${remainingIds.length} more works (total: ${this.workIds.length}/${totalCount})`);

                // Re-emit progress with updated total
                EventBus.emit('playlist:progress', {
                    current: this.currentWorkIndex + 1,
                    total: this.workIds.length,
                    workId: this.workIds[this.currentWorkIndex] || '',
                });
            }
        } catch (error) {
            Logger.warn('[PlaylistMode] Failed to fetch remaining playlist pages:', error);
        }
    }

    /**
     * Deactivate playlist mode
     */
    deactivate(): void {
        if (!this._isActive) {
            Logger.debug('[PlaylistMode] Already inactive');
            return;
        }

        this._isActive = false;
        this.workIds = [];
        this.currentWorkIndex = 0;
        this.playlistId = null;
        this.playlistName = null;
        this.isNavigating = false;
        this.hasAdvanced = false;
        this.playAllInFolder = false;
        this.visitedIndices.clear();

        // Clear route watcher
        this._routeWatcher?.();
        this._routeWatcher = null;

        // Clear timers
        this.stopQueueMonitor();
        if (this.navigationTimer !== null) {
            clearTimeout(this.navigationTimer);
            this.navigationTimer = null;
        }
        if (this.workChangeDebounceTimer !== null) {
            clearTimeout(this.workChangeDebounceTimer);
            this.workChangeDebounceTimer = null;
        }

        // Emit deactivation event
        EventBus.emit('playlist:active', { isActive: false });

        Logger.log('[PlaylistMode] Deactivated');
    }

    /**
     * Skip to next work in playlist.
     *
     * Shuffle mode: picks a random unvisited index. Once all have been visited,
     * resets the visited set and loops (if loopPlaylist is on) or stops.
     *
     * Sequential mode: advances index by 1. At the end, loops back to 0
     * (if loopPlaylist is on) or stops.
     */
    async next(): Promise<void> {
        if (!this._isActive) return;

        const loop = Config.get('playlistLoopPlaylist');

        if (Config.get('playlistShuffle') && this.workIds.length > 1) {
            // Mark current as visited
            this.visitedIndices.add(this.currentWorkIndex);

            // Build list of unvisited indices (excluding current)
            const unvisited = this.workIds
                .map((_, i) => i)
                .filter(i => !this.visitedIndices.has(i));

            if (unvisited.length === 0) {
                // All works visited
                if (!loop) {
                    Logger.debug('[PlaylistMode] Shuffle: all works visited, loop off — stopping');
                    EventBus.emit('playlist:progress', {
                        current: this.currentWorkIndex + 1,
                        total: this.workIds.length,
                        workId: this.workIds[this.currentWorkIndex],
                    });
                    return;
                }
                // Loop: reset visited set and pick from all except current
                Logger.debug('[PlaylistMode] Shuffle: all works visited, looping — resetting visited set');
                this.visitedIndices.clear();
                this.visitedIndices.add(this.currentWorkIndex);
                const allExceptCurrent = this.workIds
                    .map((_, i) => i)
                    .filter(i => i !== this.currentWorkIndex);
                const randomIndex = allExceptCurrent[Math.floor(Math.random() * allExceptCurrent.length)];
                Logger.debug('[PlaylistMode] Shuffle+Loop: advancing to random work', {
                    index: randomIndex + 1,
                    total: this.workIds.length,
                    workId: this.workIds[randomIndex],
                });
                this.navigateToWork(randomIndex);
                return;
            }

            const randomIndex = unvisited[Math.floor(Math.random() * unvisited.length)];
            Logger.debug('[PlaylistMode] Shuffle: advancing to random unvisited work', {
                index: randomIndex + 1,
                total: this.workIds.length,
                visited: this.visitedIndices.size,
                remaining: unvisited.length,
                workId: this.workIds[randomIndex],
            });
            this.navigateToWork(randomIndex);
            return;
        }

        // Sequential mode
        if (this.currentWorkIndex >= this.workIds.length - 1) {
            if (!loop) {
                Logger.debug('[PlaylistMode] End of playlist reached, loop off — stopping');
                EventBus.emit('playlist:progress', {
                    current: this.workIds.length,
                    total: this.workIds.length,
                    workId: this.workIds[this.currentWorkIndex],
                });
                return;
            }
            // Loop back to start
            Logger.debug('[PlaylistMode] End of playlist reached, looping to start');
            this.navigateToWork(0);
            return;
        }

        const nextIndex = this.currentWorkIndex + 1;
        Logger.debug('[PlaylistMode] Advancing to next work in playlist', {
            index: nextIndex + 1,
            total: this.workIds.length,
            workId: this.workIds[nextIndex],
        });
        this.navigateToWork(nextIndex);
    }

    /**
     * Go to previous work in playlist
     */
    async previous(): Promise<void> {
        if (!this._isActive) return;

        if (this.currentWorkIndex <= 0) {
            Logger.debug('[PlaylistMode] Already at start of playlist');
            return;
        }

        const prevIndex = this.currentWorkIndex - 1;
        Logger.debug('[PlaylistMode] Going back to previous work in playlist', {
            index: prevIndex + 1,
            total: this.workIds.length,
            workId: this.workIds[prevIndex]
        });
        this.navigateToWork(prevIndex);
    }

    /**
     * Jump to specific work in playlist
     */
    goToWork(index: number): void {
        if (!this._isActive) return;
        if (index < 0 || index >= this.workIds.length) {
            Logger.warn('[PlaylistMode] Invalid work index:', index);
            return;
        }

        Logger.debug('[PlaylistMode] Jumping to work', index + 1, '/', this.workIds.length);
        this.navigateToWork(index);
    }

    /**
     * Toggle shuffle mode on/off.
     * Resets the visited-indices tracker when toggled.
     */
    shuffle(): void {
        const newValue = !Config.get('playlistShuffle');
        Config.set('playlistShuffle', newValue);
        this.visitedIndices.clear();
        Logger.debug('[PlaylistMode] Shuffle toggled:', newValue);

        EventBus.emit('playlist:shuffleToggled', { enabled: newValue });
    }

    /**
     * Toggle loop mode on/off
     */
    toggleLoop(): void {
        const newValue = !Config.get('playlistLoopPlaylist');
        Config.set('playlistLoopPlaylist', newValue);
        Logger.debug('[PlaylistMode] Loop toggled:', newValue);

        EventBus.emit('playlist:loopToggled', { enabled: newValue });
    }

    /**
     * Get current progress info
     */
    getProgress(): { current: number; total: number; workId: string | null } {
        return {
            current: this.currentWorkIndex + 1,
            total: this.workIds.length,
            workId: this.workIds[this.currentWorkIndex] || null,
        };
    }

    // =========================================================================
    // Private Methods
    // =========================================================================

    private navigateToWork(index: number): void {
        if (this.isNavigating) {
            Logger.debug('[PlaylistMode] Already navigating, ignoring');
            return;
        }

        this.isNavigating = true;
        this.hasAdvanced = true;
        const previousIndex = this.currentWorkIndex;
        this.currentWorkIndex = index;
        const workId = this.workIds[index];

        // Stop current playback before navigating (like RadioMode)
        this.playbackController.stopPlayback();

        // Emit progress event
        EventBus.emit('playlist:progress', {
            current: index + 1,
            total: this.workIds.length,
            workId,
        });

        // Emit navigation event
        EventBus.emit('playlist:navigate', {
            direction: index > previousIndex ? 'next' : 'previous',
            workId,
            index,
        });

        // Navigate
        Logger.debug('[PlaylistMode] Navigating to:', workId);
        this.bridge.navigateToWork(workId);

        // Reset navigation flag after delay, then load and start playback
        if (this.navigationTimer !== null) clearTimeout(this.navigationTimer);
        this.navigationTimer = window.setTimeout(() => {
            this.navigationTimer = null;
            this.isNavigating = false;
            this.hasAdvanced = false;
            // Actively load and start playback for the new work
            this.loadWorkAndStartPlayback(workId);
        }, PLAYBACK_SETTLE_DELAY);
    }

    private setupRouteWatcher(): void {
        const app = this.bridge.app;
        if (!app?.$watch) {
            Logger.warn('[PlaylistMode] Vue $watch not available');
            return;
        }

        Logger.debug('[PlaylistMode] Setting up route watcher');

        // Check if we're already on a playlist page at startup
        this.checkAndLoadPlaylistFromRoute();

        this._routeWatcher = app.$watch(
            () => this.bridge.route.fullPath || this.bridge.route.path,
            (newFullPath: string) => {
                const newPath = newFullPath.split('?')[0];

                // Auto-deactivate when navigating to home or other non-work pages
                if (this._isActive && !newPath.startsWith('/playlist') && !newPath.startsWith('/work/')) {
                    // Check if this is intentional navigation away
                    if (newPath === '/' || newPath === '/works' || newPath === '/settings') {
                        Logger.debug('[PlaylistMode] Navigated away from playlist context, deactivating');
                        this.deactivate();
                        return;
                    }
                }

                // Auto-load playlist when navigating to /playlist?id=UUID
                if (newPath.startsWith('/playlist')) {
                    this.checkAndLoadPlaylistFromRoute();
                }

                // Update current work index if navigating to a work in our list
                if (this._isActive && newPath.startsWith('/work/')) {
                    const workMatch = newPath.match(/\/work\/(\w+)/);
                    const workId = workMatch?.[1];
                    if (workId) {
                        // Normalize the work ID for comparison
                        const normalizedId = this.normalizeWorkId(workId);
                        const index = this.workIds.findIndex(id => this.normalizeWorkId(id) === normalizedId);
                        if (index >= 0 && index !== this.currentWorkIndex) {
                            Logger.debug('[PlaylistMode] Work index updated to:', index + 1);
                            this.currentWorkIndex = index;
                            EventBus.emit('playlist:progress', {
                                current: index + 1,
                                total: this.workIds.length,
                                workId: this.workIds[index],
                            });
                        }
                    }
                }
            }
        );
    }

    /**
     * Check current route for playlist ID and auto-load if found
     */
    private checkAndLoadPlaylistFromRoute(): void {
        const route = this.bridge.route;
        // Try Vue route query first, then fall back to URL search params
        let playlistId = route.query?.id as string | undefined;
        if (!playlistId) {
            const fullPath = route.fullPath || route.path || '';
            const queryMatch = fullPath.match(/[?&]id=([^&]+)/);
            playlistId = queryMatch?.[1];
        }
        if (!playlistId) {
            // Also check window.location as fallback
            const params = new URLSearchParams(window.location.search);
            playlistId = params.get('id') || undefined;
        }

        if (playlistId) {
            Logger.debug('[PlaylistMode] Detected playlist page with id:', playlistId);
            this.loadFromUrl(playlistId);
        }
    }

    private normalizeWorkId(id: string): string {
        // Remove RJ prefix and leading zeros for comparison
        return id.replace(/^RJ0*/i, '').toLowerCase();
    }

    private onWorkChange(event: { workId: string; work: WorkDetail }): void {
        if (!this._isActive) return;

        const { workId } = event;
        const normalizedId = this.normalizeWorkId(workId);
        const currentPlaylistWorkId = this.workIds[this.currentWorkIndex];

        if (currentPlaylistWorkId && this.normalizeWorkId(currentPlaylistWorkId) === normalizedId) {
            Logger.debug('[PlaylistMode] Work loaded:', workId);
        }
    }

    /**
     * Load work data and explicitly start playback (modeled on RadioMode).
     * This ensures the first track plays reliably instead of relying on auto-play.
     */
    private async loadWorkAndStartPlayback(workId: string): Promise<void> {
        if (!this._isActive) return;

        // Verify we're still on the expected work
        const currentExpected = this.workIds[this.currentWorkIndex];
        if (currentExpected && this.normalizeWorkId(currentExpected) !== this.normalizeWorkId(workId)) {
            Logger.debug('[PlaylistMode] Work ID mismatch during load, aborting');
            return;
        }

        Logger.debug('[PlaylistMode] loadWorkAndStartPlayback', { workId });

        try {
            const work = await WorkService.getWork(workId) as WorkDetail;
            if (!this._isActive) return;
            if (currentExpected && this.normalizeWorkId(currentExpected) !== this.normalizeWorkId(workId)) {
                Logger.debug('[PlaylistMode] Work changed during fetch, aborting');
                return;
            }

            if (!work) {
                Logger.warn('[PlaylistMode] Failed to fetch work data for:', workId);
                return;
            }

            const useFlatTracks = Config.get('playlistUseFlatTracks');
            let tracks: AudioTrack[] = [];

            if (useFlatTracks) {
                Logger.debug('[PlaylistMode] Using flat track selection (all files)');
                try {
                    const treeData = await WorkService.getTracks(workId);
                    tracks = treeData ? this.collectAllAudioFromTree(treeData) : [];
                } catch (error) {
                    Logger.warn('[PlaylistMode] Flat track fetch failed, falling back:', error);
                }
                if (tracks.length === 0) {
                    tracks = this.playbackController.getPlayableTracksFromWork(work);
                }
            } else {
                try {
                    const treeData = await WorkService.getTracks(workId);
                    const autoFilter = Config.get('playlistAutoFilterFolders');
                    if (!autoFilter) {
                        Logger.debug('[PlaylistMode] playlistAutoFilterFolders disabled, skipping dive');
                    } else if (treeData) {
                        const startPath = this.folderDiver.getHostPath();
                        this.folderDiver.syncPath(startPath);
                        if (this.folderDiver.needsDiveFromPath(treeData, startPath)) {
                            Logger.debug('[PlaylistMode] Auto-diving into folder structure', {
                                startPath: startPath.join('/') || '(root)',
                            });
                            const result = await this.folderDiver.diveFromPath(treeData, startPath);
                            Logger.debug('[PlaylistMode] Dive result', {
                                success: result.success,
                                reason: result.reason,
                                path: result.path.join('/') || '(root)',
                                depth: result.depth,
                            });
                        }
                    }
                } catch (error) {
                    Logger.warn('[PlaylistMode] Failed to fetch tracks for dive:', error);
                }

                if (!this._isActive) return;
                tracks = this.playbackController.getPlayableTracksFromWork(work);
            }

            Logger.debug('[PlaylistMode] Extracted playable tracks', {
                count: tracks.length,
                firstTrack: tracks[0]?.title || tracks[0]?.hash || '(none)',
            });

            if (tracks.length > 0) {
                this.playbackController.setQueueAndPlay(tracks as PlayerTrack[]);
                Logger.debug('[PlaylistMode] Playback started for work:', workId);
            } else {
                // Fallback: try clicking the play button
                Logger.warn('[PlaylistMode] No tracks extracted, trying play button fallback');
                this.playbackController.clickPlayButton(Config.get('playlistShuffle'));
            }
        } catch (error) {
            Logger.error('[PlaylistMode] Error loading work for playback:', error);
            // Fallback: try clicking the play button
            this.playbackController.clickPlayButton(Config.get('playlistShuffle'));
        }
    }

    private handleTrackEnd(): void {
        if (!this._isActive) return;
        if (this.isNavigating || this.hasAdvanced) return;

        // Debounce to prevent rapid-fire
        if (this.workChangeDebounceTimer !== null) {
            return;
        }

        this.workChangeDebounceTimer = window.setTimeout(() => {
            this.workChangeDebounceTimer = null;
            this.checkAndAdvance();
        }, WORK_CHANGE_DEBOUNCE_MS);
    }

    private checkAndAdvance(): void {
        if (!this._isActive) return;
        if (this.isNavigating || this.hasAdvanced) return;

        if (!this.playAllInFolder) {
            Logger.debug('[PlaylistMode] Track ended and playlistPlayAllInFolder=false, triggering advance');
            this.next();
            return;
        }

        const player = this.bridge.player;
        const queue = player.queue || player.playlist || [];
        const queueIndex = player.queueIndex ?? 0;

        // Check if at end of current work's queue
        if (queueIndex >= queue.length - 1) {
            Logger.debug('[PlaylistMode] Current work queue ended, triggering advance');
            this.next();
        }
    }

    private startQueueMonitor(): void {
        if (this.checkInterval !== null) return;

        Logger.debug('[PlaylistMode] Starting queue monitor');
        this.checkInterval = window.setInterval(() => {
            if (!this._isActive) return;
            this.checkQueuePosition();
        }, QUEUE_END_CHECK_INTERVAL);
    }

    private stopQueueMonitor(): void {
        if (this.checkInterval !== null) {
            Logger.debug('[PlaylistMode] Stopping queue monitor');
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
    }

    private checkQueuePosition(): void {
        if (this.isNavigating || this.hasAdvanced) return;

        const player = this.bridge.player;
        const queue = player.queue || player.playlist || [];
        const queueIndex = player.queueIndex ?? 0;
        const currentTime = player.currentTime || 0;
        const duration = player.duration || 0;

        const isLastTrack = queueIndex >= queue.length - 1;
        // Only advance when within 3 seconds of the end - no premature highProgress check
        const nearEnd = duration > 0 && (duration - currentTime) < 3;

        if (!this.playAllInFolder && !isLastTrack
            && queueIndex !== this.lastQueueIndex && this.lastQueueIndex >= 0) {
            Logger.debug('[PlaylistMode] Track advanced but playlistPlayAllInFolder=false, skipping to next work', {
                prevIndex: this.lastQueueIndex, queueIndex, queueLength: queue.length,
            });
            this.lastQueueIndex = queueIndex;
            this.next();
            return;
        }

        if (isLastTrack && nearEnd) {
            Logger.debug('[PlaylistMode] Near end of last track, will advance playlist', {
                isLastTrack,
                remainingTime: (duration - currentTime).toFixed(1),
            });
            this.next();
        }

        this.lastQueueIndex = queueIndex;
    }

    /**
     * Collect ALL audio tracks recursively from a TracksResponse tree (flat mode).
     */
    private collectAllAudioFromTree(nodes: TracksResponse): AudioTrack[] {
        const audio: AudioTrack[] = [];
        for (const node of nodes) {
            if (node.type === 'audio') {
                audio.push(node as unknown as AudioTrack);
            } else if (node.type === 'folder') {
                audio.push(...this.collectAllAudioFromTree((node as TrackFolder).children));
            }
        }
        return audio;
    }
}
