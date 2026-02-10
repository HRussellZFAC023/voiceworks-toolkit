import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { Logger } from '../core/Utils';
import { getAudioElement } from '../core/DomUtils';
import type { KikoeruStoreState, AudioPlayerState } from '../types';
import type { PlayerTrack, WorkDetail } from '../types';

export class MediaSessionManager {
    private bridge: KikoeruBridge;
    private unwatch: (() => void) | null = null;
    private lastMetadata: string | null = null;

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
    }

    private updateMetadata(track: PlayerTrack | undefined, work: WorkDetail | undefined): void {
        const title = track?.title || (work ? (work.title || 'Unknown Work') : 'No Track');
        const artist = work?.name || work?.circle?.name || (track?.workTitle || 'ASMR.one');
        const album = work?.title || 'Unknown Album';

        // Try to find the best cover (comprehensive fallback chain)
        let artwork: MediaImage[] = [];
        const w = work as (WorkDetail & Record<string, unknown>) | undefined;
        const coverUrl =
            track?.cover ||
            w?.mainCoverUrl ||
            (w?.main_cover as string | undefined) ||
            (w?.cover as string | undefined) ||
            (w?.thumbnail as string | undefined) ||
            ((w?.image_main as { url?: string } | undefined)?.url) ||
            ((w?.image_thum as { url?: string } | undefined)?.url);

        if (coverUrl) {
            // Provide multiple sizes for better quality on different devices
            artwork = [
                { src: coverUrl, sizes: '512x512', type: 'image/jpeg' },
                { src: coverUrl, sizes: '256x256', type: 'image/jpeg' },
                { src: coverUrl, sizes: '128x128', type: 'image/jpeg' }
            ];
        }

        // Avoid spamming updates if metadata hasn't changed
        const key = `${title}|${artist}|${coverUrl}`;
        if (this.lastMetadata === key) return;
        this.lastMetadata = key;

        if (navigator.mediaSession) {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: title,
                artist: artist,
                album: album,
                artwork: artwork
            });
            Logger.debug('[MediaSession] Updated metadata:', { title, artist, hasCover: !!coverUrl });
        }
    }

    private updatePlaybackState(playing: boolean): void {
        if (navigator.mediaSession) {
            navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
        }
    }

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
        if (this.unwatch) this.unwatch();
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
