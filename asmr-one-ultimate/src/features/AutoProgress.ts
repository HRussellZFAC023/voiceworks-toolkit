import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { ReviewApi } from '../api';
import { EventBus } from '../core/EventBus';
import { CentralObserver } from '../core/CentralObserver';
import { Logger, Config } from '../core/Utils';
import { THRESHOLDS } from '../core/Constants';
import { RadioMode } from './radio';
import { getAudioElement, getVueItem } from '../core/DomUtils';
import { GM_getValue, GM_setValue } from '$';

/**
 * Progress status ordering for no-downgrade rule.
 * Higher number = more advanced status. Postponed is special (lateral).
 */
const PROGRESS_RANK: Record<string, number> = {
    'marked': 1,
    'listening': 2,
    'listened': 3,
    'replay': 4,
};

type ProgressStatus = 'marked' | 'listening' | 'listened' | 'replay' | 'postponed';

const STATUS_TO_NUMBER: Record<string, number> = {
    'marked': 1,
    'listening': 2,
    'listened': 3,
    'replay': 4,
    'postponed': 5,
};

const NUMBER_TO_STATUS: Record<number, ProgressStatus> = {
    1: 'marked',
    2: 'listening',
    3: 'listened',
    4: 'replay',
    5: 'postponed',
};

/** GM storage key for persisting play counts across sessions */
const PLAY_COUNTS_KEY = 'autoProgressPlayCounts';
/** GM storage key for visits-without-listening counter */
const VISITS_NO_PLAY_KEY = 'autoProgress:visitsNoPlay';

export class AutoProgress {
    private bridge: KikoeruBridge;
    private listenedTracks: Set<string> = new Set();
    private pollId: number | null = null;
    private sentUpdates: Set<string> = new Set();

    /** Cached flattened audio tracks for isLastTrackInWork (invalidated on work change) */
    private cachedFlatTracks: any[] | null = null;
    private cachedFlatTracksWorkId: string | null = null;

    /** In-memory cache for play counts (avoids JSON.parse from GM storage on every read) */
    private playCountsCache: Record<string, number> | null = null;

    /** Persistent visits-without-listening counter (replaces in-memory radio skip counter) */
    private visitsNoPlay: Record<string, number> = {};

    /** Work ID the user is currently visiting (via route, not audio player) */
    private currentVisitWorkId: string | null = null;
    /** Whether the user has played audio during the current visit */
    private currentVisitPlayed = false;

    /** Track the work being listened to for partial-listen detection */
    private currentListeningWorkId: string | null = null;
    /** Tracks played >50% per workId — used for per-work partial-listen detection */
    private playedTracksInWork: Map<string, Set<string>> = new Map();
    /** Whether the current track has >5s playback (distinguishes "actually started" from "just browsed") */
    private currentTrackStarted = false;

    /** EventBus cleanup functions */
    private cleanups: (() => void)[] = [];

    /** Route unwatch function */
    private _routeUnwatch: (() => void) | undefined; // stored for future cleanup

    /** Interval ID for retrying audio element discovery */
    private audioRetryId: number | null = null;

    constructor() {
        this.bridge = KikoeruBridge.getInstance();
        this.loadVisitsNoPlay();
    }

    public enable(): void {
        this.setupCurrentTimeWatcher();
        this.setupRouteWatcher();
        this.setupEventListeners();
        this.injectCheckmarks();
        CentralObserver.register('auto-progress-checkmarks', () => this.injectCheckmarks(), 500);
    }

    public disable(): void {
        if (this.audioRetryId !== null) {
            clearInterval(this.audioRetryId);
            this.audioRetryId = null;
        }
        if (this.pollId !== null) {
            clearInterval(this.pollId);
            this.pollId = null;
        }
        if (this.boundAudio && this.timeupdateHandler) {
            this.boundAudio.removeEventListener('timeupdate', this.timeupdateHandler);
            this.boundAudio = null;
            this.timeupdateHandler = null;
        }
        if (this._routeUnwatch) {
            this._routeUnwatch();
            this._routeUnwatch = undefined;
        }
        for (const cleanup of this.cleanups) cleanup();
        this.cleanups = [];
        this.sentUpdates.clear();
        CentralObserver.unregister('auto-progress-checkmarks');
    }

    // =========================================================================
    // Setup
    // =========================================================================

    private setupCurrentTimeWatcher(): void {
        // The host app does NOT keep currentTime in reactive Vuex state,
        // so store.watch never fires. Instead, listen to the HTML5 audio
        // element's timeupdate event directly.
        const attach = () => {
            const audio = getAudioElement();
            if (audio) {
                this.bindAudioElement(audio);
            } else {
                // Audio element may not exist yet; retry briefly
                let retries = 0;
                this.audioRetryId = window.setInterval(() => {
                    const el = getAudioElement();
                    if (el) {
                        this.bindAudioElement(el);
                        if (this.audioRetryId !== null) { clearInterval(this.audioRetryId); this.audioRetryId = null; }
                    } else if (++retries > 20) {
                        if (this.audioRetryId !== null) { clearInterval(this.audioRetryId); this.audioRetryId = null; }
                        Logger.debug('[AutoProgress] No audio element found, falling back to poll');
                        this.startPoll();
                    }
                }, 500);
            }
        };

        attach();

        // Re-attach when track changes (audio element may be replaced)
        this.cleanups.push(
            EventBus.on('track:change', () => {
                const audio = getAudioElement();
                if (audio && audio !== this.boundAudio) {
                    this.bindAudioElement(audio);
                }
            })
        );
    }

    private boundAudio: HTMLAudioElement | null = null;
    private timeupdateHandler: (() => void) | null = null;

    private bindAudioElement(audio: HTMLAudioElement): void {
        // Remove old listener if switching elements
        if (this.boundAudio && this.timeupdateHandler) {
            this.boundAudio.removeEventListener('timeupdate', this.timeupdateHandler);
        }

        this.boundAudio = audio;
        this.timeupdateHandler = () => {
            this.checkAndMark(audio.currentTime);
        };
        audio.addEventListener('timeupdate', this.timeupdateHandler);
        Logger.debug('[AutoProgress] Bound to audio element timeupdate');
    }

    private startPoll(): void {
        if (this.pollId !== null) return;
        this.pollId = window.setInterval(() => {
            const audio = getAudioElement();
            if (audio) {
                this.checkAndMark(audio.currentTime);
            }
        }, 1000);
    }

    /**
     * Watch route changes to detect work page visits for "marked" status.
     */
    private setupRouteWatcher(): void {
        const app = this.bridge.app;
        if (app?.$watch) {
            this._routeUnwatch = app.$watch('$route', (newRoute: any) => {
                this.handleRouteChange(newRoute);
            });
        }
    }

    /**
     * Listen to EventBus events for radio skip tracking and partial-listen detection.
     */
    private setupEventListeners(): void {
        this.cleanups.push(
            EventBus.on('radio:skip', (event) => {
                this.handleRadioSkip(event.fromWorkId);
            }),
            EventBus.on('work:change', (event) => {
                this.handleWorkChange(event.workId);
            })
        );
    }

    // =========================================================================
    // Route-based: Mark on Visit
    // =========================================================================

    private handleRouteChange(route: any): void {
        const path: string = route?.path || '';
        const workIdMatch = path.match(/\/work\/(?:RJ)?(\d+)/i);
        const newWorkId = workIdMatch?.[1] || null;

        // Check if leaving a work page without having played anything
        if (this.currentVisitWorkId && this.currentVisitWorkId !== newWorkId && !this.currentVisitPlayed) {
            this.recordVisitWithoutPlay(this.currentVisitWorkId);
        }

        // Update current visit tracking
        this.currentVisitWorkId = newWorkId;
        this.currentVisitPlayed = false;

        // Mark on visit (existing logic)
        if (!Config.get('autoProgress') || !Config.get('autoProgressMarked')) return;
        if (newWorkId) {
            const currentStatus = this.getCurrentStatus(newWorkId);
            if (currentStatus === null || currentStatus === 0) {
                this.setProgress(newWorkId, 'marked');
            }
        }
    }

    // =========================================================================
    // Playback-based: Listening, Listened, Replay
    // =========================================================================

    /** Throttle diagnostic logging to avoid spam */
    private lastDiagTime = 0;

    private checkAndMark(currentTime: number): void {
        if (!Config.get('autoProgress')) return;

        const now = Date.now();
        const shouldDiag = now - this.lastDiagTime > 10_000; // every 10s at most

        const player = this.bridge.store.state.AudioPlayer;
        if (!player) {
            if (shouldDiag) { this.lastDiagTime = now; Logger.debug('[AutoProgress] Guard: no AudioPlayer state'); }
            return;
        }
        const track = player.currentTrack || player.currentPlayingFile
            || (player.queue?.length ? player.queue[player.queueIndex ?? 0] : undefined);
        if (!track) {
            if (shouldDiag) {
                this.lastDiagTime = now;
                Logger.debug(`[AutoProgress] Guard: no track. AudioPlayer keys: ${Object.keys(player).join(',')}, queue.length=${player.queue?.length}, queueIndex=${player.queueIndex}, playing=${player.playing}`);
            }
            return;
        }

        const audio = this.boundAudio || getAudioElement();
        const duration = (audio?.duration && isFinite(audio.duration) ? audio.duration : 0)
            || track.duration || player.duration || 0;
        if (!duration) {
            if (shouldDiag) { this.lastDiagTime = now; Logger.debug(`[AutoProgress] Guard: duration=0 (audio.duration=${audio?.duration}, track.duration=${track.duration}, player.duration=${player.duration})`); }
            return;
        }

        const progress = currentTime / duration;
        const workId = this.resolveWorkId(track);
        if (!workId) {
            if (shouldDiag) { this.lastDiagTime = now; Logger.debug(`[AutoProgress] Guard: workId=null (track keys: ${Object.keys(track).join(',')}, work.id=${player.work?.id})`); }
            return;
        }

        if (shouldDiag) {
            this.lastDiagTime = now;
            Logger.debug(`[AutoProgress] Checking: workId=${workId}, currentTime=${currentTime.toFixed(1)}, duration=${duration.toFixed(1)}, progress=${(progress * 100).toFixed(1)}%`);
        }

        // Per-work partial-listen tracking
        if (workId !== this.currentListeningWorkId) {
            // Switched to a different work — check if previous work was a partial listen
            this.checkPartialListen();
            this.currentListeningWorkId = workId;
            this.currentTrackStarted = false;
        }

        // Track whether the user actually started listening (>5s)
        if (currentTime > 5) {
            this.currentTrackStarted = true;
            // Mark the route visit as "played" and clear visits-without-play counter
            if (workId === this.currentVisitWorkId && !this.currentVisitPlayed) {
                this.currentVisitPlayed = true;
                if (this.visitsNoPlay[workId]) {
                    delete this.visitsNoPlay[workId];
                    this.saveVisitsNoPlay();
                }
            }
        }

        // When a track reaches >50%, record it as "played" for this work
        const trackKey = this.getTrackKey(track);
        if (trackKey && progress > 0.50) {
            if (!this.playedTracksInWork.has(workId)) {
                this.playedTracksInWork.set(workId, new Set());
            }
            this.playedTracksInWork.get(workId)!.add(trackKey);
        }

        // 1. Mark as "listening" after 5 seconds of playback
        if (Config.get('autoProgressListening') && currentTime > 5 && progress < THRESHOLDS.NEAR_END_PROGRESS) {
            this.setProgress(workId, 'listening');
        }

        // 2. Mark as "listened" when last track reaches threshold
        if (Config.get('autoProgressListened') && progress > THRESHOLDS.LISTENED_PROGRESS) {
            const key = this.getTrackKey(track);
            if (key && !this.listenedTracks.has(key)) {
                this.listenedTracks.add(key);

                // Only mark as "listened" if this is the last audio track in the work tree
                if (this.isLastTrackInWork(track)) {
                    this.markAsListened(workId);
                }

                this.markTrackLocal(track);
                this.injectCheckmarks();
            }
        }
    }

    /**
     * Mark a work as "listened" and check for replay threshold.
     */
    private markAsListened(workId: string): void {
        // Radio mode guard: don't mark listened/replay when radio is active
        if (RadioMode.isActive) {
            Logger.debug(`[AutoProgress] Radio guard: skipping "listened" for ${workId}`);
            return;
        }

        // Increment play count
        const count = this.incrementPlayCount(workId);

        // Check replay threshold
        const threshold = Config.get('autoProgressReplayThreshold') || 2;
        if (Config.get('autoProgressReplay') && count >= threshold) {
            this.setProgress(workId, 'replay');
        } else {
            this.setProgress(workId, 'listened');
        }
    }

    // =========================================================================
    // Partial-listen detection: Postponed
    // =========================================================================

    /**
     * When navigating away from a work, check if the user only listened to < 30%.
     * If so, mark as "postponed".
     */
    private handleWorkChange(newWorkId: string): void {
        this.checkPartialListen();
        // Reset tracking for the new work
        this.currentListeningWorkId = newWorkId;
        this.currentTrackStarted = false;
        // Invalidate cached flat tracks so isLastTrackInWork re-builds for new work
        this.cachedFlatTracks = null;
        this.cachedFlatTracksWorkId = null;
    }

    private checkPartialListen(): void {
        if (!Config.get('autoProgress') || !Config.get('autoProgressPostponed')) return;
        if (!this.currentListeningWorkId) return;
        // Must have actually started a track (>5s playback) to count as partial
        if (!this.currentTrackStarted) return;

        const workId = this.currentListeningWorkId;
        const playedTracks = this.playedTracksInWork.get(workId);
        const playedCount = playedTracks?.size ?? 0;

        // Get total tracks in the work
        const work = this.bridge.store.state.AudioPlayer?.work;
        const totalTracks = work ? this.flattenAudioTracks(work).length : 0;

        // Compute per-work progress as fraction of tracks played >50%
        const workProgress = totalTracks > 0 ? playedCount / totalTracks : 0;

        // Mark postponed if <30% of tracks played
        if (workProgress < 0.30) {
            const currentStatus = this.getCurrentStatus(workId);
            const currentStatusStr = currentStatus ? NUMBER_TO_STATUS[currentStatus] : null;
            // Don't downgrade: only apply postponed if status is <= listening
            const rank = currentStatusStr ? (PROGRESS_RANK[currentStatusStr] ?? 0) : 0;
            if (rank <= (PROGRESS_RANK['listening'] ?? 0)) {
                Logger.debug(`[AutoProgress] Partial listen (${playedCount}/${totalTracks} tracks) for ${workId}, marking postponed`);
                this.setProgress(workId, 'postponed', true);
            }
        }
    }

    // =========================================================================
    // Visits without listening: Postponed
    // =========================================================================

    /**
     * Record that the user visited a work without listening.
     * Triggered by: leaving a work page without playing, or radio skip.
     * Persistent across sessions via GM storage.
     */
    private recordVisitWithoutPlay(workId: string): void {
        if (!Config.get('autoProgress') || !Config.get('autoProgressPostponed')) return;

        this.visitsNoPlay[workId] = (this.visitsNoPlay[workId] || 0) + 1;
        this.saveVisitsNoPlay();

        const threshold = Config.get('autoProgressRadioSkipThreshold') || 3;
        if (this.visitsNoPlay[workId] >= threshold) {
            Logger.debug(`[AutoProgress] Visit-without-play threshold reached (${this.visitsNoPlay[workId]}) for ${workId}`);
            this.setProgress(workId, 'postponed', true);
        }
    }

    /**
     * Handle radio skip — also counts as a visit without listening.
     */
    private handleRadioSkip(fromWorkId: string): void {
        this.recordVisitWithoutPlay(fromWorkId);
    }

    private loadVisitsNoPlay(): void {
        try {
            const raw = GM_getValue(VISITS_NO_PLAY_KEY, '{}');
            this.visitsNoPlay = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
        } catch {
            this.visitsNoPlay = {};
        }
    }

    private saveVisitsNoPlay(): void {
        GM_setValue(VISITS_NO_PLAY_KEY, JSON.stringify(this.visitsNoPlay));
    }

    // =========================================================================
    // Core: Set progress via API
    // =========================================================================

    /**
     * Central method to update a work's progress status.
     * Enforces: master toggle, per-status toggles, no-downgrade, radio guard, dedup.
     *
     * @param workId - The work ID (numeric string)
     * @param progress - The target progress status
     * @param bypassRank - If true, skip the no-downgrade check (used for postponed)
     */
    private setProgress(workId: string, progress: ProgressStatus, bypassRank = false): void {
        if (!Config.get('autoProgress')) return;

        const currentStatusNum = this.getCurrentStatus(workId) || 0;
        const currentStatusStr = NUMBER_TO_STATUS[currentStatusNum] || null;
        const newStatusNum = STATUS_TO_NUMBER[progress] || 0;

        // No-downgrade rule (unless bypassed for postponed)
        if (!bypassRank) {
            const currentRank = currentStatusStr ? (PROGRESS_RANK[currentStatusStr] ?? 0) : 0;
            const newRank = PROGRESS_RANK[progress] ?? 0;
            if (currentRank >= newRank && newRank > 0) return;
        }

        // Dedup: don't re-send the same status
        const dedupKey = `${workId}-${progress}`;
        if (this.sentUpdates.has(dedupKey)) return;

        Logger.debug(`[AutoProgress] ${workId}: ${currentStatusStr || 'none'} -> ${progress}`);

        // Optimistic update (capture previous value for rollback)
        const previousStatusNum = currentStatusNum;
        if (this.bridge.store.state.User) {
            if (!this.bridge.store.state.User.marks) {
                this.bridge.store.state.User.marks = {};
            }
            this.bridge.store.state.User.marks[workId] = newStatusNum;
        }

        this.sentUpdates.add(dedupKey);

        // Emit event for other features
        EventBus.emit('progress:update', {
            workId,
            progress,
            oldProgress: currentStatusStr,
        });

        ReviewApi.updateReview({
            work_id: parseInt(workId, 10),
            progress,
            progressOnly: true,
        }).then(() => {
            Logger.debug(`[AutoProgress] API Success: ${workId} -> ${progress}`);
        }).catch((err: any) => {
            Logger.error(`[AutoProgress] API Failed for ${workId}:`, err);
            this.sentUpdates.delete(dedupKey); // Allow retry
            // Rollback optimistic update
            if (this.bridge.store.state.User?.marks) {
                if (previousStatusNum) {
                    this.bridge.store.state.User.marks[workId] = previousStatusNum;
                } else {
                    delete this.bridge.store.state.User.marks[workId];
                }
            }
        });
    }

    // =========================================================================
    // Play count persistence (GM storage)
    // =========================================================================

    private getPlayCounts(): Record<string, number> {
        if (this.playCountsCache) return this.playCountsCache;
        try {
            const raw = typeof GM_getValue === 'function'
                ? GM_getValue(PLAY_COUNTS_KEY, '{}')
                : localStorage.getItem(PLAY_COUNTS_KEY) || '{}';
            this.playCountsCache = JSON.parse(raw as string);
            return this.playCountsCache!;
        } catch (err) {
            Logger.warn('[AutoProgress] Failed to parse play counts from storage', err);
            this.playCountsCache = {};
            return this.playCountsCache;
        }
    }

    private savePlayCounts(counts: Record<string, number>): void {
        this.playCountsCache = counts;
        const json = JSON.stringify(counts);
        if (typeof GM_setValue === 'function') {
            GM_setValue(PLAY_COUNTS_KEY, json);
        } else {
            localStorage.setItem(PLAY_COUNTS_KEY, json);
        }
    }

    private incrementPlayCount(workId: string): number {
        const counts = this.getPlayCounts();
        counts[workId] = (counts[workId] || 0) + 1;

        // LRU eviction: keep at most 1000 entries
        const keys = Object.keys(counts);
        if (keys.length > 1000) {
            // Remove oldest entries (first inserted keys)
            const toRemove = keys.slice(0, keys.length - 1000);
            for (const k of toRemove) delete counts[k];
        }

        this.savePlayCounts(counts);
        return counts[workId];
    }

    public getPlayCount(workId: string): number {
        return this.getPlayCounts()[workId] || 0;
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    private getCurrentStatus(workId: string): number | null {
        const marks = this.bridge.store.state.User?.marks;
        if (!marks) return null;
        return marks[workId] ?? null;
    }

    private resolveWorkId(track: any): string | null {
        // Try direct properties first
        const raw = track.workId || track.work_id
            || this.bridge.store.state.AudioPlayer?.work?.id;
        if (raw != null) return String(raw);

        // Extract from hash (format: "{workID}/{fileIndex}")
        const hash: string = track.hash || '';
        if (hash.includes('/')) {
            const id = hash.split('/')[0];
            if (id && /^\d+$/.test(id)) return id;
        }

        // Fall back to route params
        const routeId = this.bridge.router?.currentRoute?.params?.id;
        if (routeId) {
            const match = String(routeId).match(/(?:RJ)?(\d+)/i);
            if (match) return match[1];
        }

        return null;
    }

    /**
     * Check if the given track is the last audio track in the entire work tree.
     * Flattens the tree and compares by hash/src.
     */
    private isLastTrackInWork(track: any): boolean {
        // Try the work tree first (with caching to avoid O(n) tree walk on every ~4Hz timeupdate)
        const work = this.bridge.store.state.AudioPlayer?.work;
        if (work) {
            const workId = String(work.id || '');
            if (workId !== this.cachedFlatTracksWorkId || !this.cachedFlatTracks) {
                this.cachedFlatTracks = this.flattenAudioTracks(work);
                this.cachedFlatTracksWorkId = workId;
            }
            if (this.cachedFlatTracks.length > 0) {
                const lastTrack = this.cachedFlatTracks[this.cachedFlatTracks.length - 1];
                const trackKey = this.getTrackKey(track);
                const lastKey = this.getTrackKey(lastTrack);
                return !!trackKey && trackKey === lastKey;
            }
        }

        // Fallback: use the playback queue
        const player = this.bridge.store.state.AudioPlayer;
        const queue = player?.queue || [];
        const queueIndex = player?.queueIndex ?? 0;
        if (queue.length > 0) {
            return queueIndex >= queue.length - 1;
        }

        // No tree or queue data: assume last track
        return true;
    }

    /**
     * Recursively collect all audio tracks from a work's directory tree.
     */
    private flattenAudioTracks(node: any): any[] {
        const tracks: any[] = [];

        // Collect audio tracks from this node
        if (node.tracks) {
            for (const t of node.tracks) {
                if (this.isAudioTrack(t)) tracks.push(t);
            }
        }

        // Recurse into children (could be dirs or mixed)
        const children = node.dirs || node.children || [];
        for (const child of children) {
            if (child.type === 'folder' || child.type === 'directory' || child.dirs || child.children || child.tracks) {
                tracks.push(...this.flattenAudioTracks(child));
            } else if (this.isAudioTrack(child)) {
                tracks.push(child);
            }
        }

        return tracks;
    }

    private isAudioTrack(item: any): boolean {
        if (item.type === 'audio' || item.is_audio) return true;
        if (item.src || item.mediaStreamUrl || item.media_stream_url) return true;
        // Check file extension in title/hash
        const name = (item.title || item.hash || '').toLowerCase();
        return /\.(mp3|wav|flac|opus|m4a|aac|ogg|wma)$/.test(name);
    }

    private getTrackKey(track: any): string | null {
        return track?.src || track?.mediaStreamUrl || track?.hash || track?.title || null;
    }

    // =========================================================================
    // Visual checkmarks (existing functionality preserved)
    // =========================================================================

    private markTrackLocal(track: any): void {
        Logger.debug('[AutoProgress] Track finished locally:', track.title);
    }

    private injectCheckmarks(): void {
        if (!Config.get('autoProgress')) return;

        const items = document.querySelectorAll('.q-item, .file-list-item');
        items.forEach(item => {
            const track = this.findTrackByItem(item as HTMLElement);
            if (!track) return;

            const key = this.getTrackKey(track);
            const marked = (key && this.listenedTracks.has(key));
            this.applyCheck(item as HTMLElement, !!marked);
        });
    }

    private findTrackByItem(item: HTMLElement): any {
        const tracks = this.getCurrentFolderTracks();

        const vueData = getVueItem(item) as Record<string, any> | null;
        if (vueData?.hash) {
            const match = tracks.find((t: any) => t.hash === vueData.hash);
            if (match) return match;
        }

        const dataId = item.getAttribute('data-id') || item.getAttribute('data-key');
        if (dataId) {
            const match = tracks.find((t: any) =>
                String(t.id) === dataId || String(t.hash) === dataId
            );
            if (match) return match;
        }

        const label = item.querySelector('.q-item__label, .ellipsis')?.textContent?.trim();
        if (label) {
            return tracks.find((t: any) => t.title === label || t.name === label);
        }

        return null;
    }

    private getCurrentFolderTracks(): any[] {
        const store = this.bridge.store;
        const work = store.state.AudioPlayer?.work;
        if (!work) return [];

        const currentPathStr = this.bridge.router?.currentRoute?.query?.path;
        let p: string[] = [];
        try {
            if (currentPathStr) {
                p = typeof currentPathStr === 'string' ? JSON.parse(currentPathStr) : currentPathStr;
            }
        } catch (err) {
            Logger.warn('[AutoProgress] Failed to parse folder path from route query', err);
        }

        let currentDir = work;
        for (const segment of p) {
            if (!currentDir) break;
            const searchDirs = currentDir.dirs || currentDir.children || [];
            currentDir = (searchDirs.find((d: any) => d.title === segment || d.name === segment) as any);
        }

        if (!currentDir) return [];

        let tracks: any[] = [];
        if (currentDir.tracks) tracks = tracks.concat(currentDir.tracks);
        if (currentDir.children) {
            tracks = tracks.concat(currentDir.children.filter((c: any) =>
                c.type === 'audio' || c.is_audio || c.src || c.mediaStreamUrl
            ));
        }

        return tracks;
    }

    private applyCheck(el: HTMLElement, marked: boolean): void {
        const existing = el.querySelector('.asmr-check');
        if (marked && existing) return;
        if (!marked) {
            existing?.remove();
            return;
        }

        const icon = document.createElement('i');
        icon.className = 'q-icon material-icons asmr-check text-green q-ml-sm';
        icon.textContent = 'check_circle';
        icon.style.fontSize = '14px';

        const labelEl = el.querySelector('.q-item__label, .ellipsis');
        const target = labelEl || el.querySelector('.q-item__section--main');
        target?.appendChild(icon);
    }

}
