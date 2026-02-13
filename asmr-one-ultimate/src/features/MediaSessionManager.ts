import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { Logger } from '../core/Utils';
import { getAudioElement } from '../core/DomUtils';
import { buildCoverUrl } from '../types/api';
import type { KikoeruStoreState } from '../types';
import type { PlayerTrack, WorkDetail } from '../types';

/**
 * Ensure a URL is absolute.  Relative paths (e.g. `/api/cover/…`) are
 * resolved against the current page origin so the Media Session API
 * (and lock-screen artwork on mobile) can fetch them.
 */
function toAbsoluteUrl(url: string): string {
    if (!url) return url;
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:')) {
        return url;
    }
    // Relative path — resolve against origin
    return new URL(url, window.location.origin).href;
}

export class MediaSessionManager {
    private bridge: KikoeruBridge;
    private unwatch: (() => void) | null = null;
    private lastMetadata: string | null = null;
    private timeupdateHandler: (() => void) | null = null;
    private connectedAudio: HTMLAudioElement | null = null;

    constructor() {
        this.bridge = KikoeruBridge.getInstance();
    }

    public enable(): void {
        if (!('mediaSession' in navigator)) {
            Logger.log('[MediaSession] API not supported in this browser');
            return;
        }

        Logger.log('[MediaSession] Enabling media session controls');
        const store = this.bridge.store;
        if (store.watch) {
            // Watch current track specifically for metadata updates
            this.unwatch = store.watch(
                (state: KikoeruStoreState) => ({
                    track: state.AudioPlayer?.currentTrack || state.AudioPlayer?.currentPlayingFile,
                    playing: state.AudioPlayer?.playing,
                    work: state.AudioPlayer?.work
                }),
                (val: { track: PlayerTrack | undefined; playing: boolean | undefined; work: WorkDetail | undefined }) => this.update(val)
            );
        }

        this.setHandlers();
        this.attachPositionSync();

        // Initial sync
        const state = store.state.AudioPlayer;
        if (!state) return;
        this.update({
            track: state.currentTrack || state.currentPlayingFile,
            playing: state.playing || false,
            work: state.work
        });
    }

    private update(state: { track: PlayerTrack | undefined; playing: boolean | undefined; work: WorkDetail | undefined }): void {
        this.updateMetadata(state.track, state.work);
        this.updatePlaybackState(!!state.playing);
        // Re-attach position sync in case the audio element changed (new track)
        this.attachPositionSync();
    }

    private updateMetadata(track: PlayerTrack | undefined, work: WorkDetail | undefined): void {
        const title = track?.title || (work ? (work.title || 'Unknown Work') : 'No Track');
        const artist = work?.name || work?.circle?.name || (track?.workTitle || 'ASMR.one');
        const album = work?.title || 'Unknown Album';

        // Try to find the best cover (comprehensive fallback chain)
        const w = work as (WorkDetail & Record<string, unknown>) | undefined;
        let coverUrl =
            w?.mainCoverUrl ||
            track?.cover ||
            (w?.main_cover as string | undefined) ||
            (w?.cover as string | undefined) ||
            (w?.thumbnail as string | undefined) ||
            ((w?.image_main as { url?: string } | undefined)?.url) ||
            ((w?.image_thum as { url?: string } | undefined)?.url);

        // Last-resort fallback: build cover URL from work ID
        if (!coverUrl && w?.id) {
            coverUrl = buildCoverUrl(w.id, 'main');
        }

        // Ensure the URL is absolute — Media Session requires absolute URLs
        // for lock-screen artwork to load correctly on mobile
        if (coverUrl) {
            coverUrl = toAbsoluteUrl(coverUrl);
        }

        // Avoid spamming updates if metadata hasn't changed
        const key = `${title}|${artist}|${coverUrl}`;
        if (this.lastMetadata === key) return;
        this.lastMetadata = key;

        let artwork: MediaImage[] = [];
        if (coverUrl) {
            artwork = [
                { src: coverUrl, sizes: '512x512', type: 'image/jpeg' },
                { src: coverUrl, sizes: '256x256', type: 'image/jpeg' },
                { src: coverUrl, sizes: '128x128', type: 'image/jpeg' },
            ];
        }

        if (navigator.mediaSession) {
            navigator.mediaSession.metadata = new MediaMetadata({
                title,
                artist,
                album,
                artwork,
            });
            Logger.debug('[MediaSession] Updated metadata:', { title, artist, hasCover: !!coverUrl });
        }
    }

    private updatePlaybackState(playing: boolean): void {
        if (navigator.mediaSession) {
            navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
        }
    }

    // ------------------------------------------------------------------
    // Position state — enables the lock-screen progress bar / scrubber
    // ------------------------------------------------------------------

    private attachPositionSync(): void {
        const audio = getAudioElement();
        if (!audio || audio === this.connectedAudio) return;

        // Detach from previous element
        this.detachPositionSync();

        this.connectedAudio = audio;
        this.timeupdateHandler = () => this.syncPositionState(audio);
        audio.addEventListener('timeupdate', this.timeupdateHandler);

        // Also sync on seeked so the scrubber jumps immediately
        audio.addEventListener('seeked', this.timeupdateHandler);
    }

    private detachPositionSync(): void {
        if (this.connectedAudio && this.timeupdateHandler) {
            this.connectedAudio.removeEventListener('timeupdate', this.timeupdateHandler);
            this.connectedAudio.removeEventListener('seeked', this.timeupdateHandler);
        }
        this.connectedAudio = null;
        this.timeupdateHandler = null;
    }

    private syncPositionState(audio: HTMLAudioElement): void {
        if (!navigator.mediaSession) return;
        const duration = audio.duration;
        // duration must be a valid positive finite number
        if (!duration || !isFinite(duration) || duration <= 0) return;

        try {
            navigator.mediaSession.setPositionState({
                duration,
                playbackRate: audio.playbackRate || 1,
                position: Math.min(audio.currentTime, duration),
            });
        } catch {
            // Some browsers throw if position > duration (race condition)
        }
    }

    // ------------------------------------------------------------------
    // Action handlers (lock-screen / headphone buttons)
    // ------------------------------------------------------------------

    private setHandlers(): void {
        if (!navigator.mediaSession) return;
        const ms = navigator.mediaSession;
        const store = this.bridge.store;

        const safeDispatch = (action: string, payload?: unknown) => {
            Logger.debug(`[MediaSession] Action triggered: ${action}`);
            if (store.dispatch) {
                store.dispatch(action, payload).catch((err: unknown) =>
                    Logger.warn(`[MediaSession] Action ${action} failed:`, err)
                );
            }
        };

        // Play
        ms.setActionHandler('play', () => {
            safeDispatch('AudioPlayer/play');
        });

        // Pause
        ms.setActionHandler('pause', () => {
            safeDispatch('AudioPlayer/pause');
        });

        // Previous Track
        ms.setActionHandler('previoustrack', () => {
            safeDispatch('AudioPlayer/prev');
        });

        // Next Track
        ms.setActionHandler('nexttrack', () => {
            safeDispatch('AudioPlayer/next');
        });

        // Seek Backward (typically 10 seconds)
        ms.setActionHandler('seekbackward', (details) => {
            const skipTime = details.seekOffset || 10;
            const audio = getAudioElement();
            if (audio) {
                audio.currentTime = Math.max(audio.currentTime - skipTime, 0);
                Logger.debug(`[MediaSession] Seeked backward ${skipTime}s`);
            }
        });

        // Seek Forward (typically 10 seconds)
        ms.setActionHandler('seekforward', (details) => {
            const skipTime = details.seekOffset || 10;
            const audio = getAudioElement();
            if (audio) {
                audio.currentTime = Math.min(audio.currentTime + skipTime, audio.duration);
                Logger.debug(`[MediaSession] Seeked forward ${skipTime}s`);
            }
        });

        // Seek To (scrubbing on lock screen)
        ms.setActionHandler('seekto', (details) => {
            const audio = getAudioElement();
            if (audio && details.seekTime !== undefined) {
                audio.currentTime = details.seekTime;
                Logger.debug(`[MediaSession] Seeked to ${details.seekTime}s`);
            }
        });

        Logger.log('[MediaSession] All action handlers registered');
    }

    public disable(): void {
        if (this.unwatch) {
            this.unwatch();
            this.unwatch = null;
        }
        this.detachPositionSync();
        if (navigator.mediaSession) {
            navigator.mediaSession.metadata = null;
            navigator.mediaSession.setActionHandler('play', null);
            navigator.mediaSession.setActionHandler('pause', null);
            navigator.mediaSession.setActionHandler('previoustrack', null);
            navigator.mediaSession.setActionHandler('nexttrack', null);
            navigator.mediaSession.setActionHandler('seekbackward', null);
            navigator.mediaSession.setActionHandler('seekforward', null);
            navigator.mediaSession.setActionHandler('seekto', null);
        }
    }
}
