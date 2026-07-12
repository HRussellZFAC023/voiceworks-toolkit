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
import { PlaybackController } from '../radio/PlaybackController';
import { FolderDiver } from '../FolderDiver';
import {
    claimExclusivePlaybackMode,
    registerExclusivePlaybackMode,
} from '../playbackModeCoordinator';
import { AUDIO_EXTENSIONS, VIDEO_EXTENSIONS } from '../folderDiverTreeUtils';
import { PlaylistApi, PlaylistWorkItem } from '../../api/Playlist';
import { WorkService } from '../../services/WorkService';
import { getAudioElement } from '../../core/DomUtils';
import { runPacedBatches } from '../../core/PacedBatch';
import type { PlaylistModeState, WorkDetail, PlayerTrack, AudioTrack } from '../../types';
import type { TrackFolder, TrackItem, TracksResponse } from '../../types/api';

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
    /** Tracks whether refreshDependencies() has already run in this script context */
    private static _refreshed = false;
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
    private loadingPlaylistId: string | null = null;
    private lastLoadedPlaylistId: string | null = null;
    private loadGeneration = 0;
    private activationGeneration = 0;
    private navigationGeneration = 0;

    private constructor() {
        this.bridge = KikoeruBridge.getInstance();
        this.playbackController = new PlaybackController();
        this.folderDiver = FolderDiver.getInstance();
        registerExclusivePlaybackMode('playlist', () => this.deactivate());
    }

    static getInstance(): PlaylistMode {
        // Check window first for persisted instance
        if (globalWindow.__ASMR_PLAYLIST_MODE__) {
            PlaylistMode._instance = globalWindow.__ASMR_PLAYLIST_MODE__;
            // Only refresh once per script context to preserve runtime state
            if (!PlaylistMode._refreshed) {
                PlaylistMode._refreshed = true;
                PlaylistMode._instance.refreshBridgeRefs();
                Logger.debug('[PlaylistMode] Reusing persisted instance (refreshed bridge refs)');
            }
            return PlaylistMode._instance;
        }

        if (!PlaylistMode._instance) {
            PlaylistMode._instance = new PlaylistMode();
            globalWindow.__ASMR_PLAYLIST_MODE__ = PlaylistMode._instance;
            PlaylistMode._refreshed = true;
        }
        return PlaylistMode._instance;
    }

    /**
     * Refresh stale bridge references after script re-injection.
     * Preserves playlist state (workIds, currentWorkIndex, visitedIndices) across refreshes.
     */
    private refreshBridgeRefs(): void {
        this.bridge = KikoeruBridge.getInstance();
        this.playbackController = new PlaybackController();
        this.folderDiver = FolderDiver.getInstance();
        registerExclusivePlaybackMode('playlist', () => this.deactivate());
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

        claimExclusivePlaybackMode('playlist');
        this.activationGeneration++;
        this.navigationGeneration++;

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
        if (this.loadingPlaylistId === playlistId) {
            Logger.debug('[PlaylistMode] Already loading this URL playlist, ignoring');
            return;
        }
        if (this._isActive && this.playlistId === playlistId) {
            Logger.debug('[PlaylistMode] Already active with this playlist');
            return;
        }
        if (this.lastLoadedPlaylistId === playlistId && this._isActive) {
            return;
        }

        const loadGeneration = ++this.loadGeneration;
        this.loadingPlaylistId = playlistId;
        Logger.debug('[PlaylistMode] Loading playlist from URL, id:', playlistId);

        try {
            // Fetch metadata + first page of works in parallel (fast — single API call each)
            const [metadata, firstPage] = await Promise.all([
                PlaylistApi.getPlaylistMetadata(playlistId),
                PlaylistApi.getPlaylistWorks(playlistId, 1, 100),
            ]);

            if (loadGeneration !== this.loadGeneration || this.loadingPlaylistId !== playlistId) {
                Logger.debug('[PlaylistMode] Superseded URL playlist load ignored:', playlistId);
                return;
            }

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
            const activationGeneration = this.activationGeneration;

            // Fetch remaining pages in background and extend the playlist
            if (totalPages > 1) {
                void this.fetchRemainingPages(
                    playlistId,
                    totalPages,
                    totalCount,
                    extractIds,
                    activationGeneration,
                );
            }
        } catch (error) {
            if (loadGeneration !== this.loadGeneration) return;
            Logger.error('[PlaylistMode] Failed to load playlist from URL:', error);
        } finally {
            if (loadGeneration === this.loadGeneration) this.loadingPlaylistId = null;
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
        activationGeneration: number,
    ): Promise<void> {
        try {
            const pages: number[] = [];
            for (let p = 2; p <= totalPages; p++) pages.push(p);

            const allRemainingWorks: PlaylistWorkItem[] = [];

            // Keep background loading responsive without creating a burst of
            // dozens of requests against a service that is already unstable.
            const results = await runPacedBatches(
                pages,
                page => PlaylistApi.getPlaylistWorks(playlistId, page, 100),
                { batchSize: 3, delayMs: 350 },
            );

            for (const result of results) {
                if (result.status === 'fulfilled' && result.value.works?.length) {
                    allRemainingWorks.push(...result.value.works);
                }
            }

            if (allRemainingWorks.length > 0
                && this.isCurrentActivation(activationGeneration)
                && this.playlistId === playlistId) {
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
            this.loadGeneration++;
            this.loadingPlaylistId = null;
            Logger.debug('[PlaylistMode] Already inactive');
            return;
        }

        this._isActive = false;
        this.activationGeneration++;
        this.navigationGeneration++;
        this.loadGeneration++;
        this.loadingPlaylistId = null;
        this.workIds = [];
        this.currentWorkIndex = 0;
        this.playlistId = null;
        this.playlistName = null;
        this.isNavigating = false;
        this.hasAdvanced = false;
        this.playAllInFolder = false;
        this.visitedIndices.clear();

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

    /**
     * Navigate to a specific work index and start playback.
     *
     * Directly loads and starts playback after navigation instead of relying on
     * a 1.5s timer. This eliminates the dead time where no audio plays and the
     * host app might interfere.
     */
    private async navigateToWork(index: number): Promise<void> {
        if (!this._isActive || index < 0 || index >= this.workIds.length) return;

        const activationGeneration = this.activationGeneration;
        const navigationGeneration = ++this.navigationGeneration;
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

        // Navigate host app
        Logger.debug('[PlaylistMode] Navigating to:', workId);
        this.bridge.navigateToWork(workId);

        // Clear any stale timer from a previous navigation
        if (this.navigationTimer !== null) {
            clearTimeout(this.navigationTimer);
            this.navigationTimer = null;
        }

        try {
            // Directly load and start playback (no timer delay — our API fetch
            // is independent of the host app's page load).
            await this.loadWorkAndStartPlayback(
                workId,
                activationGeneration,
                navigationGeneration,
            );
        } catch (error) {
            Logger.error('[PlaylistMode] Error during navigateToWork playback:', error);
        } finally {
            if (!this.isCurrentNavigation(activationGeneration, navigationGeneration, workId)) return;
            this.isNavigating = false;
            this.hasAdvanced = false;
        }
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
                if ((this._isActive || this.loadingPlaylistId)
                    && !newPath.startsWith('/playlist')
                    && !newPath.startsWith('/work/')) {
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
                            this.navigationGeneration++;
                            this.isNavigating = false;
                            this.hasAdvanced = false;
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
    private async loadWorkAndStartPlayback(
        workId: string,
        activationGeneration = this.activationGeneration,
        navigationGeneration = this.navigationGeneration,
    ): Promise<void> {
        if (!this.isCurrentNavigation(activationGeneration, navigationGeneration, workId)) {
            Logger.debug('[PlaylistMode] Work ID mismatch during load, aborting');
            return;
        }

        Logger.debug('[PlaylistMode] loadWorkAndStartPlayback', { workId });

        try {
            const work = await WorkService.getWork(workId) as WorkDetail;
            if (!this.isCurrentNavigation(activationGeneration, navigationGeneration, workId)) {
                Logger.debug('[PlaylistMode] Work changed during fetch, aborting');
                return;
            }

            if (!work) {
                Logger.warn('[PlaylistMode] Failed to fetch work data for:', workId);
                return;
            }

            const useTrackPool = Boolean(Config.get('playlistUseFlatTracks') || Config.get('radioUseFlatTracks'));
            let tracks: AudioTrack[] = [];

            if (useTrackPool) {
                Logger.debug('[PlaylistMode] Using pooled track selection (all folders)');
                try {
                    const treeData = await WorkService.getTracks(workId);
                    if (!this.isCurrentNavigation(activationGeneration, navigationGeneration, workId)) return;
                    tracks = treeData ? this.collectAllAudioFromTree(treeData) : [];
                } catch (error) {
                    Logger.warn('[PlaylistMode] Flat track fetch failed, falling back:', error);
                }
                if (tracks.length === 0) {
                    tracks = this.playbackController.getPlayableTracksFromWork(work);
                }
            } else {
                let treeData: TracksResponse | null = null;
                try {
                    treeData = await WorkService.getTracks(workId);
                    if (!this.isCurrentNavigation(activationGeneration, navigationGeneration, workId)) return;
                    if (treeData) {
                        const startPath = this.folderDiver.getHostPath();
                        this.folderDiver.syncPath(startPath);
                        if (this.folderDiver.needsDiveFromPath(treeData, startPath)) {
                            Logger.debug('[PlaylistMode] Auto-diving into folder structure', {
                                startPath: startPath.join('/') || '(root)',
                            });
                            const result = await this.folderDiver.diveFromPath(treeData, startPath);
                            if (!this.isCurrentNavigation(activationGeneration, navigationGeneration, workId)) return;
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

                if (!this.isCurrentNavigation(activationGeneration, navigationGeneration, workId)) return;
                tracks = this.playbackController.getPlayableTracksFromWork(work);

                // Fallback: work metadata often has no file tree — extract from treeData
                if (tracks.length === 0 && treeData) {
                    Logger.debug('[PlaylistMode] Work metadata had no tracks, extracting from tree data');
                    tracks = this.collectAllAudioFromTree(treeData);
                }
            }

            Logger.debug('[PlaylistMode] Extracted playable tracks', {
                count: tracks.length,
                firstTrack: tracks[0]?.title || tracks[0]?.hash || '(none)',
            });

            if (!this.isCurrentNavigation(activationGeneration, navigationGeneration, workId)) return;

            if (tracks.length > 0) {
                const shuffle = Config.get('playlistShuffle');
                let queueToPlay = tracks as PlayerTrack[];
                let startIndex = 0;

                if (!this.playAllInFolder && queueToPlay.length > 1) {
                    const pickIndex = shuffle ? Math.floor(Math.random() * queueToPlay.length) : 0;
                    queueToPlay = [queueToPlay[pickIndex]];
                    Logger.debug('[PlaylistMode] Play Entire Work disabled; selected single track from pool', {
                        pickIndex,
                        title: queueToPlay[0]?.title || queueToPlay[0]?.hash || '(unknown)',
                    });
                } else if (shuffle && queueToPlay.length > 1) {
                    const shuffled = this.playbackController.shuffleAndPlay(tracks);
                    queueToPlay = shuffled.queue as PlayerTrack[];
                    startIndex = shuffled.index;
                }

                this.playbackController.setQueueAndPlay(queueToPlay, startIndex);
                Logger.debug('[PlaylistMode] Playback started for work:', workId);
            } else {
                // Fallback: try clicking the play button
                Logger.warn('[PlaylistMode] No tracks extracted, trying play button fallback');
                this.playbackController.clickPlayButton(Config.get('playlistShuffle'));
            }
        } catch (error) {
            if (!this.isCurrentNavigation(activationGeneration, navigationGeneration, workId)) return;
            Logger.error('[PlaylistMode] Error loading work for playback:', error);
            // Fallback: try clicking the play button
            this.playbackController.clickPlayButton(Config.get('playlistShuffle'));
        }
    }

    private isCurrentActivation(generation: number): boolean {
        return this._isActive && generation === this.activationGeneration;
    }

    private isCurrentNavigation(
        activationGeneration: number,
        navigationGeneration: number,
        workId: string,
    ): boolean {
        if (!this.isCurrentActivation(activationGeneration)) return false;
        if (navigationGeneration !== this.navigationGeneration) return false;
        const expected = this.workIds[this.currentWorkIndex];
        return !!expected && this.normalizeWorkId(expected) === this.normalizeWorkId(workId);
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
        const hasNextPlayable = this.hasNextPlayableTrack(queue as PlayerTrack[], queueIndex);

        // Check if at end of current work's queue
        if (!hasNextPlayable) {
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
        const hasNextPlayable = this.hasNextPlayableTrack(queue as PlayerTrack[], queueIndex);

        // Prefer HTML5 audio element for accurate time info (Vuex may lag or reset)
        const audio = getAudioElement();
        const currentTime = audio?.currentTime ?? player.currentTime ?? 0;
        const duration = (audio?.duration && isFinite(audio.duration))
            ? audio.duration
            : (player.duration || 0);
        const audioEnded = audio?.ended ?? false;

        const isLastTrack = !hasNextPlayable;
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

        if (this.playAllInFolder && hasNextPlayable && audioEnded && !player.playing) {
            this.forcePlayNextTrackInQueue(queue as PlayerTrack[], queueIndex);
            return;
        }

        if (isLastTrack && (nearEnd || audioEnded)) {
            Logger.debug('[PlaylistMode] Near end of last track, will advance playlist', {
                isLastTrack,
                remainingTime: (duration - currentTime).toFixed(1),
                audioEnded,
            });
            this.next();
        }

        this.lastQueueIndex = queueIndex;
    }

    private getNextPlayableTrackIndex(queue: PlayerTrack[], currentIndex: number): number {
        if (!Array.isArray(queue) || queue.length === 0) return -1;

        const playableIndices: number[] = [];
        for (let i = 0; i < queue.length; i++) {
            const track = queue[i] as PlayerTrack & { is_audio?: boolean };
            if (!track) continue;
            if (track.type === 'audio' && track.is_audio !== false) {
                playableIndices.push(i);
            }
        }

        if (playableIndices.length === 0) {
            return currentIndex < queue.length - 1 ? currentIndex + 1 : -1;
        }

        const directNext = playableIndices.find(index => index > currentIndex);
        return typeof directNext === 'number' ? directNext : -1;
    }

    private hasNextPlayableTrack(queue: PlayerTrack[], currentIndex: number): boolean {
        return this.getNextPlayableTrackIndex(queue, currentIndex) >= 0;
    }

    private forcePlayNextTrackInQueue(queue: PlayerTrack[], currentIndex: number): void {
        const nextIndex = this.getNextPlayableTrackIndex(queue, currentIndex);
        if (nextIndex < 0) return;

        Logger.debug('[PlaylistMode] Forcing next track playback', { from: currentIndex, to: nextIndex });
        void this.playbackController.forcePlayQueueTrack(queue, nextIndex);
    }

    /**
     * Collect ALL audio tracks recursively from a TracksResponse tree (flat mode).
     */
    private collectAllAudioFromTree(nodes: TracksResponse): AudioTrack[] {
        const audio: AudioTrack[] = [];
        for (const node of nodes) {
            if (node.type === 'folder') {
                audio.push(...this.collectAllAudioFromTree((node as TrackFolder).children));
            } else if (this.isPlayableTrackItem(node)) {
                audio.push(node as unknown as AudioTrack);
            }
        }
        return audio;
    }

    private isPlayableTrackItem(node: TrackItem): boolean {
        if (node.type === 'audio') return true;
        const title = (node.title || '').toLowerCase();
        const hasAudioExt = AUDIO_EXTENSIONS.some((ext) => title.endsWith(ext) || title.includes(ext));
        const hasVideoExt = VIDEO_EXTENSIONS.some((ext) => title.endsWith(ext));
        return hasAudioExt || hasVideoExt;
    }
}
