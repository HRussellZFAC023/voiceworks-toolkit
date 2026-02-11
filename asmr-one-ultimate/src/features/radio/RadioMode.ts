/**
 * RadioMode - Continuous playback mode that auto-advances between works
 *
 * Orchestrates:
 * - WorkSelector: Chooses next work
 * - PlaybackController: Controls playback
 * - FolderDiver: Handles folder navigation
 */

import { KikoeruBridge } from '../../infrastructure/KikoeruBridge';
import { AppStore } from '../../store/AppStore';
import { EventBus } from '../../core/EventBus';
import { Logger, Config } from '../../core/Utils';
import { WorkSelector } from './WorkSelector';
import { PlaybackController } from './PlaybackController';
import { FolderDiver } from '../FolderDiver';
import { WorkService } from '../../services/WorkService';
import type { PlayerTrack, RadioState, WorkDetail, AudioTrack } from '../../types';
import type { TrackFolder, TracksResponse } from '../../types/api';

const PLAYBACK_START_TIMEOUT = 8000;
const WORK_CHANGE_DEBOUNCE_MS = 500;
const WORK_LOAD_RETRY_DELAY = 1500;
const MAX_PLAYBACK_RETRIES = 3;
const QUEUE_END_CHECK_INTERVAL = 1500; // 1.5 seconds
const HEALTH_CHECK_INTERVAL = 30000; // 30 seconds
const MAX_STUCK_TIME = 60000; // 1 minute without activity

// Store singleton on window to persist across script re-injections
declare const unsafeWindow: Window & typeof globalThis;
const globalWindow = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) as Window & {
    __ASMR_RADIO_MODE__?: RadioMode;
};

export class RadioMode {
    private static _instance: RadioMode;
    private bridge: KikoeruBridge;
    private workSelector: WorkSelector;
    private playbackController: PlaybackController;
    private folderDiver: FolderDiver;

    // State
    private _isActive = false;
    private _state: RadioState = 'idle';
    private currentWorkId: string | null = null;
    private isSkipping = false;
    private playAllInFolder = false;
    private isInitialized = false;

    // Watchers/Timers
    private _queueWatcher: (() => void) | null = null; // stored for future cleanup
    private _playingWatcher: (() => void) | null = null; // stored for future cleanup
    private _trackSrcWatcher: (() => void) | null = null; // stored for future cleanup
    private _routeWatcher: (() => void) | null = null; // stored for future cleanup
    private lastTrackSrc: string | null = null;
    private workChangeDebounceTimer: number | null = null;
    private pendingWorkChange: string | null = null;
    private playbackTimeoutId: number | null = null;
    private playbackRetryCount = 0;
    private eventCleanups: (() => void)[] = [];

    // Queue monitoring
    private checkInterval: number | null = null;
    private lastQueueIndex = 0;

    // Health check / auto-healing
    private healthCheckInterval: number | null = null;
    private lastActivityTime = Date.now();

    /** Persisted to GM storage so it survives page refresh */
    private get manuallyPaused(): boolean {
        return Config.get('radioManuallyPaused') as boolean;
    }
    private set manuallyPaused(value: boolean) {
        Config.set('radioManuallyPaused', value);
    }

    private constructor() {
        this.bridge = KikoeruBridge.getInstance();
        this.workSelector = new WorkSelector();
        this.playbackController = new PlaybackController();
        this.folderDiver = FolderDiver.getInstance();
    }

    static getInstance(): RadioMode {
        // Check window first for persisted instance
        if (globalWindow.__ASMR_RADIO_MODE__) {
            RadioMode._instance = globalWindow.__ASMR_RADIO_MODE__;
            RadioMode._instance.refreshDependencies();
            Logger.debug('[RadioMode] Reusing persisted instance');
            return RadioMode._instance;
        }

        if (!RadioMode._instance) {
            RadioMode._instance = new RadioMode();
            globalWindow.__ASMR_RADIO_MODE__ = RadioMode._instance;
        }
        return RadioMode._instance;
    }

    private refreshDependencies(): void {
        this.bridge = KikoeruBridge.getInstance();
        this.workSelector = new WorkSelector();
        this.playbackController = new PlaybackController();
        this.folderDiver = FolderDiver.getInstance();
    }

    static get isActive(): boolean {
        return RadioMode._instance?._isActive ?? false;
    }

    /**
     * Initialize radio mode (call on plugin startup)
     */
    initialize(): void {
        if (this.isInitialized) {
            Logger.warn('[RadioMode] Already initialized, skipping');
            return;
        }
        this.isInitialized = true;

        this.setupStoreWatchers();
        this.setupRouteWatcher();

        // Store cleanup functions for EventBus subscriptions
        this.eventCleanups.push(
            EventBus.on('track:end', () => this.handleTrackEnd()),
            EventBus.on('work:change', (event: { workId: string; work: WorkDetail }) => this.onWorkChange(event)),
            EventBus.on('config:change', ({ key, value }: { key: string; value: unknown }) => {
                if (key === 'playAllInFolder') this.playAllInFolder = !!value;
            }),
        );

        Logger.log('[RadioMode] Initialized');
    }

    /**
     * Enable radio mode
     */
    enable(): void {
        if (this._isActive) {
            Logger.debug('[RadioMode] Already active, ignoring enable request');
            return;
        }

        // Check if we were manually paused before (survives page refresh via GM storage)
        const wasPaused = this.manuallyPaused;

        this._isActive = true;
        this._state = 'playing';
        if (!wasPaused) {
            this.manuallyPaused = false;
        }
        this.playAllInFolder = Config.get('playAllInFolder');

        AppStore.setRadioState({ isActive: true, state: 'playing' });

        const player = this.bridge.player;
        const hasTrack = !!(player.currentTrack || player.currentPlayingFile);
        const hasQueue = (player.queue?.length || 0) > 0 || (player.playlist?.length || 0) > 0;

        Logger.log('[RadioMode] Enabling', {
            hasTrack,
            hasQueue,
            wasPaused,
            playAllInFolder: this.playAllInFolder,
            currentWorkId: this.currentWorkId,
        });

        // Start monitoring systems
        this.startQueueMonitor();
        this.startHealthCheck();
        this.recordActivity();

        // If user had manually paused before refresh, stay paused on current work
        if (wasPaused) {
            Logger.debug('[RadioMode] Restored manually-paused state, staying paused on current work');
            return;
        }

        if (!hasTrack && !hasQueue) {
            if (!this.isSkipping) {
                this.skipToNext();
            }
        } else {
            this.ensurePlaying();
        }
    }

    /**
     * Disable radio mode
     */
    disable(): void {
        if (!this._isActive) {
            Logger.debug('[RadioMode] Already disabled, ignoring disable request');
            return;
        }

        this._isActive = false;
        this._state = 'idle';
        this.manuallyPaused = false;

        AppStore.setRadioState({ isActive: false, state: 'idle' });
        this.cleanupTimers();

        Logger.log('[RadioMode] Disabling');
    }

    /**
     * Toggle radio mode
     */
    toggle(): void {
        if (this._isActive) {
            this.disable();
        } else {
            this.enable();
        }
    }

    get isActive(): boolean {
        return this._isActive;
    }

    get state(): RadioState {
        return this._state;
    }

    canSkipToPrevious(): boolean {
        return this.getPreviousWorkId() !== null;
    }

    private getPreviousWorkId(): string | null {
        const history = this.workSelector.getRecentWorkIds();
        if (!history.length) return null;

        const current = this.currentWorkId;
        if (!current) {
            return history[0] || null;
        }

        return history.find(id => id !== current) || null;
    }

    /**
     * Skip to next work
     */
    async skipToNext(): Promise<void> {
        if (this.isSkipping) {
            Logger.debug('[RadioMode] Already skipping, ignoring');
            return;
        }

        Logger.debug('[RadioMode] skipToNext called', {
            currentWorkId: this.currentWorkId,
            state: this._state,
        });

        this.isSkipping = true;
        this.manuallyPaused = false;
        this._state = 'skipping';
        this.lastQueueIndex = -1; // Sentinel: suppress queue-change detection during skip
        this.recordActivity();

        AppStore.setRadioState({ state: 'skipping' });

        try {
            this.playbackController.stopPlayback();
            this.folderDiver.reset();

            const fromWorkId = this.currentWorkId;

            Logger.debug('[RadioMode] Selecting next work...');
            const nextWork = await this.workSelector.selectRandomWork(this.currentWorkId || undefined);

            // Re-check after await: radio may have been disabled while we waited
            if (!this._isActive) {
                Logger.debug('[RadioMode] Disabled during skip, aborting');
                return;
            }

            if (nextWork) {
                const toWorkId = String(nextWork.id);
                Logger.debug('[RadioMode] Navigating to next work', {
                    fromWorkId: fromWorkId || '(none)',
                    toWorkId,
                    title: nextWork.title,
                });

                EventBus.emit('radio:skip', {
                    fromWorkId: fromWorkId || '',
                    toWorkId,
                });

                this.workSelector.rememberWork(toWorkId);
                this.bridge.navigateToWork(toWorkId);
            } else {
                Logger.warn('[RadioMode] Failed to select next work - no candidate returned');
            }
        } catch (error) {
            Logger.error('[RadioMode] Skip error:', error);
        } finally {
            this.isSkipping = false;
            // Only restore playing state if radio is still active
            if (this._isActive) {
                this._state = 'playing';
                AppStore.setRadioState({ state: 'playing' });
            }
        }
    }

    async skipToPrevious(): Promise<void> {
        if (!this._isActive) {
            Logger.debug('[RadioMode] skipToPrevious ignored: mode inactive');
            return;
        }

        if (this.isSkipping) {
            Logger.debug('[RadioMode] Already skipping, ignoring previous request');
            return;
        }

        const targetWorkId = this.getPreviousWorkId();
        if (!targetWorkId) {
            Logger.debug('[RadioMode] skipToPrevious ignored: no previous work in history');
            return;
        }

        this.isSkipping = true;
        this.manuallyPaused = false;
        this._state = 'skipping';
        this.lastQueueIndex = -1;
        this.recordActivity();

        AppStore.setRadioState({ state: 'skipping' });

        try {
            const fromWorkId = this.currentWorkId;

            this.playbackController.stopPlayback();
            this.folderDiver.reset();

            Logger.debug('[RadioMode] Navigating to previous work', {
                fromWorkId,
                toWorkId: targetWorkId,
            });

            EventBus.emit('radio:skip', {
                fromWorkId: fromWorkId || '',
                toWorkId: targetWorkId,
            });

            this.bridge.navigateToWork(targetWorkId);
        } catch (error) {
            Logger.error('[RadioMode] skipToPrevious error:', error);
        } finally {
            this.isSkipping = false;
            if (this._isActive) {
                this._state = 'playing';
                AppStore.setRadioState({ state: 'playing' });
            }
        }
    }

    // =========================================================================
    // Private Methods - Cleanup
    // =========================================================================

    /**
     * Centralized cleanup for all timers and pending state
     */
    private cleanupTimers(): void {
        this.stopQueueMonitor();
        this.stopHealthCheck();
        this.clearPlaybackTimeout();

        if (this.workChangeDebounceTimer !== null) {
            clearTimeout(this.workChangeDebounceTimer);
            this.workChangeDebounceTimer = null;
        }
        this.pendingWorkChange = null;
        this.playbackRetryCount = 0;

        // Unsubscribe store watchers
        if (this._queueWatcher) { this._queueWatcher(); this._queueWatcher = null; }
        if (this._playingWatcher) { this._playingWatcher(); this._playingWatcher = null; }
        if (this._trackSrcWatcher) { this._trackSrcWatcher(); this._trackSrcWatcher = null; }
        if (this._routeWatcher) { this._routeWatcher(); this._routeWatcher = null; }

        // Unsubscribe EventBus listeners
        for (const cleanup of this.eventCleanups) cleanup();
        this.eventCleanups = [];

        this.isInitialized = false;
    }

    // =========================================================================
    // Private Methods - Queue Monitor
    // =========================================================================

    /**
     * Start interval-based queue position monitoring
     * This is the primary mechanism for detecting track/queue end
     */
    private startQueueMonitor(): void {
        if (this.checkInterval !== null) return;

        Logger.debug('[RadioMode] Starting queue monitor');
        this.checkInterval = window.setInterval(() => {
            if (!this._isActive) return;
            this.checkQueuePosition();
        }, QUEUE_END_CHECK_INTERVAL);
    }

    private stopQueueMonitor(): void {
        if (this.checkInterval !== null) {
            Logger.debug('[RadioMode] Stopping queue monitor');
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
    }

    /**
     * Check if we're at the end of the queue and should skip to next work
     */
    private checkQueuePosition(): void {
        if (this.isSkipping) return;
        // Sentinel: lastQueueIndex = -1 means we're between skipToNext() completing
        // and beginPlayback() starting the new work. Old queue may still be active
        // so we must ignore all queue position changes until playback resets us.
        if (this.lastQueueIndex < 0) return;

        const player = this.bridge.player;
        const queue = player.queue || player.playlist || [];
        const queueIndex = player.queueIndex ?? 0;
        const currentTime = player.currentTime || 0;
        const duration = player.duration || 0;

        const isLastTrack = queueIndex >= queue.length - 1;
        const nearEnd = duration > 0 && (duration - currentTime) < 5;
        const highProgress = duration > 0 && (currentTime / duration) > 0.95;

        // Only log periodically to avoid spam (every 10th check when playing)
        if (player.playing && duration > 0) {
            Logger.debug('[RadioMode] Queue check:', {
                queueIndex,
                queueLength: queue.length,
                isLastTrack,
                progress: `${((currentTime / duration) * 100).toFixed(1)}%`,
                nearEnd,
                highProgress,
            });
        }

        // When playAllInFolder is off and host app auto-advanced to next track,
        // intercept and skip to the next work instead
        if (!this.playAllInFolder && !isLastTrack
            && queueIndex !== this.lastQueueIndex && this.lastQueueIndex >= 0) {
            Logger.debug('[RadioMode] Track advanced but playAllInFolder=false, skipping to next work', {
                prevIndex: this.lastQueueIndex, queueIndex, queueLength: queue.length,
            });
            this.lastQueueIndex = queueIndex;
            this.recordActivity();
            this.skipToNext();
            return;
        }

        // Last track in queue: skip to next work when near the end
        if (isLastTrack && (nearEnd || highProgress) && !this.isSkipping) {
            Logger.debug('[RadioMode] Near end of last track, trigger skip to next work', {
                isLastTrack, nearEnd, highProgress,
            });
            this.recordActivity();
            this.skipToNext();
        }

        this.lastQueueIndex = queueIndex;
    }

    // =========================================================================
    // Private Methods - Health Check / Auto-Healing
    // =========================================================================

    private startHealthCheck(): void {
        if (this.healthCheckInterval !== null) return;

        Logger.debug('[RadioMode] Starting health check monitor');
        this.healthCheckInterval = window.setInterval(() => {
            this.performHealthCheck();
        }, HEALTH_CHECK_INTERVAL);
    }

    private stopHealthCheck(): void {
        if (this.healthCheckInterval !== null) {
            Logger.debug('[RadioMode] Stopping health check monitor');
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }
    }

    /**
     * Periodic health check to detect and recover from stuck states
     */
    private performHealthCheck(): void {
        if (!this._isActive) return;

        const player = this.bridge.player;
        const timeSinceActivity = Date.now() - this.lastActivityTime;

        Logger.debug('[RadioMode] Health check:', {
            playing: player.playing,
            isSkipping: this.isSkipping,
            timeSinceActivity: `${(timeSinceActivity / 1000).toFixed(0)}s`,
            currentWorkId: this.currentWorkId,
        });

        // Check for stuck state: active but not playing and not skipping for too long
        // Skip recovery if the user manually paused playback
        if (!player.playing && !this.isSkipping && !this.manuallyPaused && timeSinceActivity > MAX_STUCK_TIME) {
            Logger.warn('[RadioMode] Health check: stuck state detected, attempting recovery', {
                timeSinceActivity: `${(timeSinceActivity / 1000).toFixed(0)}s`,
            });
            this.attemptRecovery();
        }
    }

    /**
     * Attempt to recover from a stuck state
     */
    private async attemptRecovery(): Promise<void> {
        Logger.debug('[RadioMode] Attempting auto-recovery');
        this.recordActivity();

        // Try to resume playback first
        const resumed = await this.playbackController.tryPlay();
        if (!resumed) {
            // If can't resume, skip to next work
            Logger.debug('[RadioMode] Recovery: could not resume, skipping to next work');
            this.skipToNext();
        } else {
            Logger.debug('[RadioMode] Recovery: playback resumed successfully');
        }
    }

    /**
     * Record activity timestamp for health check
     */
    private recordActivity(): void {
        this.lastActivityTime = Date.now();
    }

    // =========================================================================
    // Private Methods - Watchers
    // =========================================================================

    private setupStoreWatchers(): void {
        const store = this.bridge.store;

        this._queueWatcher = store.watch?.(
            (state) => state.AudioPlayer?.queue || state.AudioPlayer?.playlist,
            (queue) => {
                if (this._isActive && queue) {
                    Logger.debug('[RadioMode] Queue changed, length:', (queue as PlayerTrack[]).length);
                }
            }
        ) ?? null;

        // Watch playing state to detect manual pauses
        this._playingWatcher = store.watch?.(
            (state) => state.AudioPlayer?.playing ?? false,
            (playing: boolean) => {
                if (!this._isActive) return;
                if (!playing && !this.isSkipping) {
                    // Player stopped while radio is active and we're not skipping — user paused manually
                    this.manuallyPaused = true;
                    Logger.debug('[RadioMode] Manual pause detected');
                } else if (playing) {
                    this.manuallyPaused = false;
                }
            }
        ) ?? null;

        this._trackSrcWatcher = store.watch?.(
            (state) => {
                const track = state.AudioPlayer?.currentTrack || state.AudioPlayer?.currentPlayingFile;
                return track?.src || track?.hash || null;
            },
            (newSrc) => {
                if (newSrc && newSrc !== this.lastTrackSrc) {
                    this.lastTrackSrc = newSrc as string;
                    Logger.debug('[RadioMode] Track changed');
                    if (this._isActive) {
                        this.recordActivity();
                    }
                }
            }
        ) ?? null;
    }

    private setupRouteWatcher(): void {
        const app = this.bridge.app;
        if (!app?.$watch) {
            Logger.warn('[RadioMode] Vue $watch not available');
            return;
        }

        this._routeWatcher = app.$watch(
            () => this.bridge.route.path,
            (newPath: string) => {
                const workMatch = newPath?.match(/\/work\/(\w+)/);
                const newWorkId = workMatch?.[1] || this.bridge.route.params?.id;

                if (newWorkId && newWorkId !== this.currentWorkId) {
                    Logger.debug('[RadioMode] Route changed to work:', newWorkId);
                    this.scheduleWorkChange(newWorkId);
                } else if (!newWorkId && this._isActive) {
                    Logger.debug('[RadioMode] Navigated to non-work page, disabling radio mode');
                    this.disable();
                }
            }
        );

        const currentId = this.bridge.currentWorkId;
        if (currentId) {
            this.currentWorkId = currentId;
            Logger.debug('[RadioMode] Initial work ID:', currentId);
        }
    }

    // =========================================================================
    // Private Methods - Event Handlers
    // =========================================================================

    private scheduleWorkChange(workId: string): void {
        this.pendingWorkChange = workId;

        if (this.workChangeDebounceTimer !== null) {
            clearTimeout(this.workChangeDebounceTimer);
        }

        this.workChangeDebounceTimer = window.setTimeout(() => {
            this.workChangeDebounceTimer = null;
            if (this.pendingWorkChange) {
                this.handleWorkChange(this.pendingWorkChange);
                this.pendingWorkChange = null;
            }
        }, WORK_CHANGE_DEBOUNCE_MS);
    }

    private async handleWorkChange(workId: string): Promise<void> {
        Logger.debug('[RadioMode] handleWorkChange:', workId, 'isActive:', this._isActive);

        this.currentWorkId = workId;

        if (this._isActive) {
            this.workSelector.rememberWork(workId);
            AppStore.setRadioState({
                currentWorkId: workId,
                recentWorkIds: this.workSelector.getRecentWorkIds(),
            });
        } else {
            AppStore.setRadioState({ currentWorkId: workId });
        }

        this.folderDiver.reset();

        if (this._isActive) {
            await this.loadWorkAndStartPlayback(workId);
        }
    }

    private async loadWorkAndStartPlayback(workId: string): Promise<void> {
        if (!this._isActive) return;
        if (workId !== this.currentWorkId) {
            Logger.debug('[RadioMode] Work ID changed during load, aborting');
            return;
        }

        Logger.debug('[RadioMode] loadWorkAndStartPlayback starting', { workId });
        this.startPlaybackTimeout();

        try {
            const work = await WorkService.getWork(workId) as WorkDetail;

            if (!this._isActive || workId !== this.currentWorkId) {
                Logger.debug('[RadioMode] State changed during fetch, aborting');
                return;
            }

            if (!work) {
                Logger.warn('[RadioMode] Failed to fetch work data for:', workId);
                this.handlePlaybackFailure('No work data');
                return;
            }

            Logger.debug('[RadioMode] Work data loaded', {
                workId,
                title: work.title,
                hasDirs: !!(work.dirs?.length || work.children?.length),
                hasTracks: !!(work.tracks?.length),
            });

            // Decide track selection mode based on config
            const useFlatTracks = Config.get('radioUseFlatTracks');
            let tracks: AudioTrack[];

            if (useFlatTracks) {
                // Flat mode: collect ALL audio from the entire tree
                Logger.debug('[RadioMode] Using flat track selection (all files)');
                try {
                    const treeData = await WorkService.getTracks(workId);
                    tracks = treeData ? this.collectAllAudioFromTree(treeData) : [];
                } catch (e) {
                    Logger.warn('[RadioMode] Flat track fetch failed, falling back:', e);
                    tracks = [];
                }
                if (tracks.length === 0) {
                    tracks = this.playbackController.getPlayableTracksFromWork(work);
                }
            } else {
                // Dive mode: navigate into best folder, then play its tracks
                try {
                    const treeData = await WorkService.getTracks(workId);
                    const autoFilter = Config.get('autoFilterFolders');
                    if (!autoFilter) {
                        Logger.debug('[RadioMode] autoFilterFolders disabled, skipping dive');
                    } else if (treeData) {
                        const startPath = this.folderDiver.getHostPath();
                        this.folderDiver.syncPath(startPath);
                        if (this.folderDiver.needsDiveFromPath(treeData, startPath)) {
                            Logger.debug('[RadioMode] Auto-diving into folder structure', {
                                startPath: startPath.join('/') || '(root)',
                            });
                            const result = await this.folderDiver.diveFromPath(treeData, startPath);
                            Logger.debug('[RadioMode] Dive result', {
                                success: result.success,
                                reason: result.reason,
                                path: result.path.join('/') || '(root)',
                                depth: result.depth,
                            });

                            if (!result.success) {
                                Logger.warn('[RadioMode] Dive failed, proceeding with root tracks', {
                                    reason: result.reason,
                                });
                            }
                        }
                    }

                    if (!this._isActive || workId !== this.currentWorkId) {
                        Logger.debug('[RadioMode] State changed during dive, aborting');
                        return;
                    }
                } catch (diveErr) {
                    Logger.warn('[RadioMode] Failed to fetch tracks for dive:', diveErr);
                }

                tracks = this.playbackController.getPlayableTracksFromWork(work);
            }
            Logger.debug('[RadioMode] Extracted playable tracks', {
                count: tracks.length,
                firstTrack: tracks[0]?.title || tracks[0]?.hash || '(none)',
            });
            this.beginPlayback(tracks);
        } catch (error) {
            Logger.error('[RadioMode] Error loading work:', error);
            this.handlePlaybackFailure('API error');
        }
    }

    private handlePlaybackFailure(reason: string): void {
        if (!this._isActive) return;

        this.playbackRetryCount++;
        Logger.warn(`[RadioMode] Playback failure (${reason}), retry ${this.playbackRetryCount}/${MAX_PLAYBACK_RETRIES}`);

        if (this.playbackRetryCount >= MAX_PLAYBACK_RETRIES) {
            Logger.debug('[RadioMode] Max retries reached, skipping to next work');
            this.playbackRetryCount = 0;
            this.clearPlaybackTimeout();
            this.skipToNext();
        } else {
            setTimeout(() => {
                if (this._isActive && this.currentWorkId) {
                    this.loadWorkAndStartPlayback(this.currentWorkId);
                }
            }, WORK_LOAD_RETRY_DELAY);
        }
    }

    private onWorkChange(event: { workId: string; work: WorkDetail }): void {
        const { workId } = event;

        if (!this._isActive) return;
        if (workId !== this.currentWorkId) return;

        const player = this.bridge.player;
        if (player.playing) {
            Logger.debug('[RadioMode] Playback already started via work:change');
            this.clearPlaybackTimeout();
            this.playbackRetryCount = 0;
        }
    }

    private handleTrackEnd(): void {
        if (!this._isActive) return;

        const player = this.bridge.player;
        const queue = player.queue || player.playlist || [];
        const queueIndex = player.queueIndex ?? 0;

        Logger.debug('[RadioMode] Track ended, queueIndex:', queueIndex, 'queueLength:', queue.length);

        if (this.playAllInFolder && queueIndex < queue.length - 1) {
            Logger.debug('[RadioMode] More tracks in queue, continuing');
            return;
        }

        Logger.debug('[RadioMode] Queue ended, trigger skip to next work');
        this.skipToNext();
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

    // =========================================================================
    // Private Methods - Playback
    // =========================================================================

    /**
     * Begin playback with extracted tracks, handling shuffle and fallback
     */
    private beginPlayback(tracks: AudioTrack[]): void {
        if (!this._isActive) return;

        const shuffle = Config.get('shuffle');
        Logger.debug('[RadioMode] beginPlayback', {
            trackCount: tracks.length,
            shuffle,
            firstTrack: tracks[0]?.title || tracks[0]?.hash || '(none)',
        });

        if (tracks.length > 0) {
            this.manuallyPaused = false;
            this.recordActivity();

            if (shuffle) {
                const { queue, index } = this.playbackController.shuffleAndPlay(tracks);
                Logger.debug('[RadioMode] Shuffled queue, starting at index', index);
                this.playbackController.setQueueAndPlay(queue as PlayerTrack[], index);
            } else {
                this.playbackController.setQueueAndPlay(tracks as PlayerTrack[]);
            }
            this.clearPlaybackTimeout();
            this.playbackRetryCount = 0;
            this.lastQueueIndex = 0; // Reset queue tracking for new work
            Logger.debug('[RadioMode] Playback started successfully');
            this.ensurePlaying();
        } else {
            Logger.warn('[RadioMode] No tracks found, trying play button fallback');
            const clicked = this.playbackController.clickPlayButton(shuffle);
            if (clicked) {
                this.recordActivity();
                Logger.debug('[RadioMode] Play button fallback succeeded');
            } else {
                this.handlePlaybackFailure('No tracks and no play button');
            }
        }
    }

    private ensurePlaying(): void {
        setTimeout(async () => {
            if (!this._isActive) return;

            const player = this.bridge.player;
            if (!player.playing) {
                Logger.debug('[RadioMode] Ensuring playback starts...');
                await this.playbackController.tryPlay();
            }
        }, PLAYBACK_START_TIMEOUT);
    }

    // =========================================================================
    // Private Methods - Playback Timeout
    // =========================================================================

    private startPlaybackTimeout(): void {
        this.clearPlaybackTimeout();

        this.playbackTimeoutId = window.setTimeout(() => {
            if (!this._isActive) return;

            const player = this.bridge.player;
            if (!player.playing) {
                Logger.warn('[RadioMode] Playback timeout - no audio playing after', PLAYBACK_START_TIMEOUT, 'ms');
                this.handlePlaybackFailure('Timeout');
            } else {
                Logger.debug('[RadioMode] Playback timeout check passed - audio is playing');
                this.playbackRetryCount = 0;
            }
        }, PLAYBACK_START_TIMEOUT);
    }

    private clearPlaybackTimeout(): void {
        if (this.playbackTimeoutId !== null) {
            clearTimeout(this.playbackTimeoutId);
            this.playbackTimeoutId = null;
        }
    }
}
