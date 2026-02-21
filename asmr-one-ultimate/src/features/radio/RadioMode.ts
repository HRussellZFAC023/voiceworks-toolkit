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
import { getAudioElement } from '../../core/DomUtils';
import type { PlayerTrack, RadioState, WorkDetail, AudioTrack } from '../../types';
import type { TrackFolder, TrackItem, TracksResponse } from '../../types/api';

const PLAYBACK_START_TIMEOUT = 3000;
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
    /** Tracks whether refreshDependencies() has already run in this script context */
    private static _refreshed = false;
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
    private deferredSkipRequested = false;
    private eventCleanups: (() => void)[] = [];

    // Queue monitoring
    private checkInterval: number | null = null;
    private lastQueueIndex = 0;

    // Health check / auto-healing
    private healthCheckInterval: number | null = null;
    private lastActivityTime = Date.now();

    // Audio element tracking for reliable ended detection
    private boundAudio: HTMLAudioElement | null = null;
    private audioEndedHandler: (() => void) | null = null;

    // Grace period: suppress false-positive "manual pause" detection right after
    // beginPlayback(), where the host app may briefly report playing=false while
    // the audio element is still loading.
    private playbackGraceUntil = 0;

    // Cancellable ensurePlaying timeout
    private ensurePlayingTimeoutId: number | null = null;

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
            // Only refresh bridge refs once per script context — avoids wiping
            // WorkSelector history (recentWorkIds) on every call
            if (!RadioMode._refreshed) {
                RadioMode._refreshed = true;
                RadioMode._instance.refreshBridgeRefs();
                Logger.debug('[RadioMode] Reusing persisted instance (refreshed bridge refs)');
            }
            return RadioMode._instance;
        }

        if (!RadioMode._instance) {
            RadioMode._instance = new RadioMode();
            globalWindow.__ASMR_RADIO_MODE__ = RadioMode._instance;
            RadioMode._refreshed = true;
        }
        return RadioMode._instance;
    }

    /**
     * Refresh stale bridge references after script re-injection.
     * Preserves WorkSelector (and its recentWorkIds history) across refreshes.
     */
    private refreshBridgeRefs(): void {
        this.bridge = KikoeruBridge.getInstance();
        // DO NOT recreate workSelector — it holds recentWorkIds for back-button history
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
        if (this.currentWorkId) {
            this.syncRecentWorkHistory(this.currentWorkId);
        }

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
        this.bindAudioEndedListener();
        this.recordActivity();

        // If user had manually paused before refresh, stay paused on current work —
        // but only if there IS a current work. On the home screen (no track/queue),
        // clear the stale flag and proceed to select a new work.
        if (wasPaused && (hasTrack || hasQueue)) {
            Logger.debug('[RadioMode] Restored manually-paused state, staying paused on current work');
            return;
        }
        if (wasPaused) {
            this.manuallyPaused = false;
            Logger.debug('[RadioMode] Cleared stale manuallyPaused (nothing to stay paused on)');
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

    private syncRecentWorkHistory(workId: string): void {
        if (!workId) return;
        this.workSelector.rememberWork(workId);
        AppStore.setRadioState({ recentWorkIds: this.workSelector.getRecentWorkIds() });
    }

    /**
     * Skip to next work.
     *
     * Key design: after navigating, we DIRECTLY call handleWorkChange instead of
     * relying on the route watcher → 500ms debounce chain. This eliminates the
     * window where the host app can "revive" the old track or enter a stuck state.
     * isSkipping stays true until loadWorkAndStartPlayback completes.
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
            if (fromWorkId) {
                this.syncRecentWorkHistory(fromWorkId);
            }

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

                this.syncRecentWorkHistory(toWorkId);
                this.bridge.navigateToWork(toWorkId);

                // Cancel any pending debounced work change — we handle it directly below.
                // This prevents the route watcher from double-triggering loadWorkAndStartPlayback.
                this.cancelPendingWorkChange();

                // Directly handle work change (bypass debounce).
                // isSkipping stays true so queue monitor / health check won't interfere.
                await this.handleWorkChange(toWorkId);
            } else {
                Logger.warn('[RadioMode] Failed to select next work - no candidate returned');
            }
        } catch (error) {
            Logger.error('[RadioMode] Skip error:', error);
        } finally {
            this.isSkipping = false;
            if (this._isActive && this.deferredSkipRequested) {
                this.deferredSkipRequested = false;
                void this.skipToNext();
                return;
            }
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

            // Cancel debounce and directly handle (same pattern as skipToNext)
            this.cancelPendingWorkChange();
            await this.handleWorkChange(targetWorkId);
        } catch (error) {
            Logger.error('[RadioMode] skipToPrevious error:', error);
        } finally {
            this.isSkipping = false;
            if (this._isActive && this.deferredSkipRequested) {
                this.deferredSkipRequested = false;
                void this.skipToNext();
                return;
            }
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
        this.cancelEnsurePlaying();

        if (this.workChangeDebounceTimer !== null) {
            clearTimeout(this.workChangeDebounceTimer);
            this.workChangeDebounceTimer = null;
        }
        this.pendingWorkChange = null;
        this.playbackRetryCount = 0;
        this.deferredSkipRequested = false;

        // Detach audio ended listener
        this.unbindAudioEndedListener();

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
     * Check if we're at the end of the queue and should skip to next work.
     *
     * Reads currentTime/duration from the HTML5 audio element as primary source
     * (Vuex state may be stale or zero after a track ends). Also checks the
     * audio element's `ended` property for immediate end-of-track detection.
     */
    private checkQueuePosition(): void {
        if (this.isSkipping) return;
        if (this.manuallyPaused) return;
        // Sentinel: lastQueueIndex = -1 means we're between skipToNext() completing
        // and beginPlayback() starting the new work. Old queue may still be active
        // so we must ignore all queue position changes until playback resets us.
        if (this.lastQueueIndex < 0) return;

        const player = this.bridge.player;
        const queue = this.getActiveQueue(player);
        const queueIndex = player.queueIndex ?? 0;
        const hasNextPlayable = this.hasNextPlayableTrack(queue, queueIndex);

        // Prefer HTML5 audio element for accurate time info (Vuex may lag or reset)
        const audio = getAudioElement();
        const currentTime = audio?.currentTime ?? player.currentTime ?? 0;
        const duration = (audio?.duration && isFinite(audio.duration))
            ? audio.duration
            : (player.duration || 0);
        const audioEnded = audio?.ended ?? false;

        // Re-bind ended listener if audio element changed (host app may recreate it)
        if (audio && audio !== this.boundAudio) {
            this.bindAudioEndedListener();
        }

        const isLastTrack = !hasNextPlayable;
        const atNaturalEnd = duration > 0 && (duration - currentTime) <= 0.15;

        // Only log periodically to avoid spam (every 10th check when playing)
        if (player.playing && duration > 0) {
            Logger.debug('[RadioMode] Queue check:', {
                queueIndex,
                queueLength: queue.length,
                isLastTrack,
                progress: `${((currentTime / duration) * 100).toFixed(1)}%`,
                atNaturalEnd,
                audioEnded,
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

        // If playAllInFolder is enabled but host auto-advance stalls after ended,
        // force-start the next playable track in the current queue.
        if (this.playAllInFolder && hasNextPlayable && audioEnded && !player.playing) {
            this.forcePlayNextTrackInQueue(queue, queueIndex);
            return;
        }

        // Last track in queue: skip to next work only at true end.
        // Avoid early transitions around ~90-95% progress.
        if (isLastTrack && (atNaturalEnd || audioEnded) && !this.isSkipping) {
            Logger.debug('[RadioMode] End of last track detected, trigger skip to next work', {
                isLastTrack, atNaturalEnd, audioEnded,
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
    // Private Methods - Audio Element Tracking
    // =========================================================================

    /**
     * Attach an `ended` event listener to the HTML5 audio element.
     * This provides immediate, reliable detection when a track finishes —
     * unlike the 1.5s polling in checkQueuePosition which can miss the window
     * if Vuex state resets after a track ends.
     */
    private bindAudioEndedListener(): void {
        const audio = getAudioElement();
        if (!audio) return;
        if (audio === this.boundAudio) return; // Already bound to this element

        // Detach from previous element
        this.unbindAudioEndedListener();

        this.boundAudio = audio;
        this.audioEndedHandler = () => this.handleAudioEnded();
        audio.addEventListener('ended', this.audioEndedHandler);
        Logger.debug('[RadioMode] Bound audio ended listener');
    }

    private unbindAudioEndedListener(): void {
        if (this.boundAudio && this.audioEndedHandler) {
            this.boundAudio.removeEventListener('ended', this.audioEndedHandler);
        }
        this.boundAudio = null;
        this.audioEndedHandler = null;
    }

    /**
     * Called when the HTML5 audio element fires the `ended` event.
     * Same logic as handleTrackEnd — checks if we should skip to next work.
     */
    private handleAudioEnded(): void {
        if (!this._isActive) return;
        if (this.isSkipping) return;

        const player = this.bridge.player;
        const queue = this.getActiveQueue(player);
        const queueIndex = player.queueIndex ?? 0;
        const hasNextPlayable = this.hasNextPlayableTrack(queue, queueIndex);

        Logger.debug('[RadioMode] Audio ended event', { queueIndex, queueLength: queue.length });

        // If playAllInFolder and more tracks remain, force-advance if needed.
        if (this.playAllInFolder && hasNextPlayable) {
            this.forcePlayNextTrackInQueue(queue, queueIndex);
            return;
        }

        Logger.debug('[RadioMode] Audio ended on last track, trigger skip to next work');
        this.recordActivity();
        this.skipToNext();
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
                    // Distinguish "user clicked pause" from "track ended naturally".
                    // If the audio element's `ended` property is true, the track finished
                    // on its own — this is NOT a manual pause and should not block
                    // health check recovery or queue advancement.
                    const audio = getAudioElement();
                    if (audio?.ended) {
                        Logger.debug('[RadioMode] Track ended naturally, not marking as manual pause');
                    } else if (Date.now() < this.playbackGraceUntil) {
                        // After beginPlayback(), the host app may briefly report
                        // playing=false while the audio element loads. Ignore it.
                        Logger.debug('[RadioMode] Ignoring playing=false during playback grace period');
                    } else {
                        this.manuallyPaused = true;
                        Logger.debug('[RadioMode] Manual pause detected');
                    }
                } else if (playing) {
                    this.manuallyPaused = false;
                    this.playbackGraceUntil = 0;
                    this.cancelEnsurePlaying();
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

    private cancelPendingWorkChange(): void {
        this.pendingWorkChange = null;
        if (this.workChangeDebounceTimer !== null) {
            clearTimeout(this.workChangeDebounceTimer);
            this.workChangeDebounceTimer = null;
        }
    }

    private scheduleWorkChange(workId: string): void {
        // If we already set currentWorkId via direct handleWorkChange (from skipToNext),
        // the route watcher fires with the same workId — skip the redundant debounce.
        if (workId === this.currentWorkId) return;

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
            this.syncRecentWorkHistory(workId);
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

            const useTrackPool = Boolean(Config.get('playlistUseFlatTracks') || Config.get('radioUseFlatTracks'));
            let tracks: AudioTrack[];
            let treeData: TracksResponse | null = null;

            try {
                treeData = await WorkService.getTracks(workId);
                if (treeData) {
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

            if (useTrackPool) {
                tracks = treeData ? this.collectTracksFromTree(treeData) : [];
                if (tracks.length === 0) {
                    tracks = this.playbackController.getPlayableTracksFromWork(work);
                }
            } else {
                tracks = this.playbackController.getPlayableTracksFromWork(work);

                // Fallback: work metadata from /api/work/{id} often has no file tree.
                // Extract tracks from treeData (/api/tracks/{id}) which always has them.
                if (tracks.length === 0 && treeData) {
                    Logger.debug('[RadioMode] Work metadata had no tracks, extracting from tree data');
                    tracks = this.collectTracksFromTree(treeData);
                }
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
            if (this.isSkipping) {
                this.deferredSkipRequested = true;
                return;
            }
            void this.skipToNext();
        } else {
            setTimeout(() => {
                if (this._isActive && this.currentWorkId) {
                    void this.loadWorkAndStartPlayback(this.currentWorkId);
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
        const queue = this.getActiveQueue(player);
        const queueIndex = player.queueIndex ?? 0;
        const hasNextPlayable = this.hasNextPlayableTrack(queue, queueIndex);

        Logger.debug('[RadioMode] Track ended, queueIndex:', queueIndex, 'queueLength:', queue.length);

        if (this.playAllInFolder && hasNextPlayable) {
            Logger.debug('[RadioMode] More tracks in queue, continuing');
            return;
        }

        Logger.debug('[RadioMode] Queue ended, trigger skip to next work');
        this.skipToNext();
    }

    /**
     * Merge host queue + playlist so "play entire work" does not prematurely
     * skip when the host moves remaining tracks into playlist.
     */
    private getActiveQueue(player = this.bridge.player): PlayerTrack[] {
        const queue = Array.isArray(player.queue) ? player.queue as PlayerTrack[] : [];
        const playlist = Array.isArray(player.playlist) ? player.playlist as PlayerTrack[] : [];
        if (queue.length === 0) return playlist;
        if (playlist.length === 0) return queue;

        const merged: PlayerTrack[] = [...queue];
        const seen = new Set<string>();

        for (const track of queue) {
            const id = this.getTrackId(track);
            if (id) seen.add(id);
        }

        for (const track of playlist) {
            const id = this.getTrackId(track);
            if (id && seen.has(id)) continue;
            if (id) seen.add(id);
            merged.push(track);
        }

        return merged;
    }

    private getTrackId(track: PlayerTrack | null | undefined): string | null {
        if (!track) return null;
        const anyTrack = track as PlayerTrack & { hash?: string; mediaStreamUrl?: string; src?: string; title?: string };
        const stableKey = anyTrack.hash || anyTrack.mediaStreamUrl || anyTrack.src || anyTrack.title;
        if (!stableKey) return null;
        return `${anyTrack.type || 'track'}:${stableKey}`;
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

        Logger.debug('[RadioMode] Forcing next track playback', { from: currentIndex, to: nextIndex });
        this.recordActivity();
        void this.playbackController.forcePlayQueueTrack(queue, nextIndex);
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
        const playAll = this.playAllInFolder;
        Logger.debug('[RadioMode] beginPlayback', {
            trackCount: tracks.length,
            shuffle,
            playAll,
            firstTrack: tracks[0]?.title || tracks[0]?.hash || '(none)',
        });

        if (tracks.length > 0) {
            this.manuallyPaused = false;
            this.playbackGraceUntil = Date.now() + PLAYBACK_START_TIMEOUT;
            this.recordActivity();

            if (!playAll && tracks.length > 1) {
                const pickIndex = shuffle
                    ? Math.floor(Math.random() * tracks.length)
                    : 0;
                const selected = tracks[pickIndex];
                this.playbackController.setQueueAndPlay([selected as PlayerTrack], 0);
                Logger.debug('[RadioMode] Play Entire Work disabled; selected a single track from pool', {
                    pickIndex,
                    title: selected?.title || selected?.hash || '(unknown)',
                });
            } else if (shuffle) {
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
            Logger.warn('[RadioMode] No tracks found, triggering recovery');
            this.handlePlaybackFailure('No playable tracks');
        }
    }

    private ensurePlaying(): void {
        this.cancelEnsurePlaying();
        this.ensurePlayingTimeoutId = window.setTimeout(async () => {
            this.ensurePlayingTimeoutId = null;
            if (!this._isActive) return;
            if (this.manuallyPaused) return;

            // Trust the actual audio element over Vuex state — the host app's
            // SET_QUEUE watcher can crash, leaving player.playing=false even
            // though audio is actually playing at the DOM level.
            const audio = getAudioElement();
            if (audio && !audio.paused) return;

            const player = this.bridge.player;
            if (!player.playing) {
                Logger.debug('[RadioMode] Ensuring playback starts...');
                const started = await this.playbackController.tryPlay();
                if (!started && !this.isSkipping && !this.manuallyPaused) {
                    this.handlePlaybackFailure('Playback did not start');
                }
            }
        }, PLAYBACK_START_TIMEOUT);
    }

    private cancelEnsurePlaying(): void {
        if (this.ensurePlayingTimeoutId !== null) {
            clearTimeout(this.ensurePlayingTimeoutId);
            this.ensurePlayingTimeoutId = null;
        }
    }

    /**
     * Recursively collect audio tracks from a TracksResponse tree.
     * The /api/tracks/{id} endpoint returns TrackFolder/TrackItem nodes
     * (different structure from WorkFolder used in work metadata).
     */
    private collectTracksFromTree(nodes: TracksResponse): AudioTrack[] {
        const tracks: AudioTrack[] = [];
        const queue: Array<TrackFolder | TrackItem> = [...nodes];

        while (queue.length) {
            const node = queue.shift()!;
            if (node.type === 'folder') {
                queue.push(...(node as TrackFolder).children);
            } else if (node.type === 'audio') {
                tracks.push(node as AudioTrack);
            }
        }

        return tracks;
    }

    // =========================================================================
    // Private Methods - Playback Timeout
    // =========================================================================

    private clearPlaybackTimeout(): void {
        if (this.playbackTimeoutId !== null) {
            clearTimeout(this.playbackTimeoutId);
            this.playbackTimeoutId = null;
        }
    }
}
