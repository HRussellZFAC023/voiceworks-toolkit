/**
 * PlaylistController - Handles playback control for playlist navigation
 */

import { KikoeruBridge } from '../../infrastructure/KikoeruBridge';
import { Logger } from '../../core/Utils';
import type { PlayerTrack, KikoeruStore } from '../../types';

export class PlaylistController {
    private bridge: KikoeruBridge;

    constructor() {
        this.bridge = KikoeruBridge.getInstance();
    }

    /**
     * Get playable tracks from current work
     */
    getPlayableTracks(): PlayerTrack[] {
        const store = this.bridge.store;
        const work = store.state.AudioPlayer?.work;
        if (!work) return [];

        const tracks: PlayerTrack[] = [];
        const collectTracks = (arr: Record<string, unknown>[]) => {
            for (const item of arr) {
                if (item.type === 'audio' || item.mediaStreamUrl || item.stream_url) {
                    tracks.push(item as unknown as PlayerTrack);
                }
                if (item.children) collectTracks(item.children as Record<string, unknown>[]);
                if (item.tracks) collectTracks(item.tracks as Record<string, unknown>[]);
                if (item.dirs) collectTracks(item.dirs as Record<string, unknown>[]);
            }
        };

        if (work.children) collectTracks(work.children as unknown as Record<string, unknown>[]);
        if (work.tracks) collectTracks(work.tracks as unknown as Record<string, unknown>[]);
        if (work.dirs) collectTracks(work.dirs as unknown as Record<string, unknown>[]);

        return tracks;
    }

    /**
     * Set queue and start playback
     */
    async setQueueAndPlay(tracks: PlayerTrack[], index = 0): Promise<void> {
        const store = this.bridge.store;

        if (store.dispatch) {
            try {
                await store.dispatch('AudioPlayer/setPlaylist', tracks);
                await store.dispatch('AudioPlayer/playTrack', tracks[index]);
                Logger.debug('[PlaylistController] Started playback via dispatch');
            } catch (e) {
                Logger.warn('[PlaylistController] Dispatch failed, trying commit:', e);
                this.setQueueViaCommit(store, tracks, index);
            }
        } else if (store.commit) {
            this.setQueueViaCommit(store, tracks, index);
        }
    }

    private setQueueViaCommit(store: KikoeruStore, tracks: PlayerTrack[], index: number): void {
        // Ensure every track has `subtitles` — the deployed host's AudioPlayer
        // watcher accesses track.subtitles.length and crashes on undefined.
        const queue = tracks.map(t => ({ ...t, subtitles: (t as any).subtitles || [] }));
        try {
            store.commit!('AudioPlayer/SET_QUEUE', { queue, index });
            store.commit!('AudioPlayer/SET_TRACK', index);
            Logger.debug('[PlaylistController] Started playback via commit');
        } catch (e) {
            Logger.error('[PlaylistController] Failed to set queue:', e);
        }
    }

    /**
     * Stop current playback
     */
    stopPlayback(): void {
        const store = this.bridge.store;

        try {
            if (store.dispatch) {
                store.dispatch('AudioPlayer/pause');
            } else if (store.commit) {
                store.commit('AudioPlayer/SET_PLAYING', false);
            }
        } catch (e) {
            Logger.warn('[PlaylistController] Failed to stop playback:', e);
        }
    }

    /**
     * Try to start playback
     */
    async tryPlay(): Promise<boolean> {
        const store = this.bridge.store;

        try {
            if (store.dispatch) {
                await store.dispatch('AudioPlayer/play');
                return true;
            } else if (store.commit) {
                store.commit('AudioPlayer/SET_PLAYING', true);
                return true;
            }
        } catch (e) {
            Logger.warn('[PlaylistController] Failed to start playback:', e);
        }

        // Try clicking play button as fallback
        return this.clickPlayButton();
    }

    /**
     * Try clicking the play button as a fallback
     */
    clickPlayButton(): boolean {
        const playBtn = document.querySelector('.q-footer .q-btn:has(.q-icon[name="play_arrow"])') ||
            document.querySelector('.player-bar .play-btn') ||
            document.querySelector('[aria-label="Play"]') ||
            document.querySelector('.q-footer button');

        if (playBtn) {
            (playBtn as HTMLElement).click();
            Logger.debug('[PlaylistController] Clicked play button');
            return true;
        }

        Logger.warn('[PlaylistController] Could not find play button');
        return false;
    }

    /**
     * Check if audio is currently playing
     */
    isPlaying(): boolean {
        const player = this.bridge.player;
        return player.playing ?? false;
    }

    /**
     * Get current track info
     */
    getCurrentTrack(): PlayerTrack | null {
        const player = this.bridge.player;
        return player.currentTrack || player.currentPlayingFile || null;
    }

    /**
     * Get current queue position
     */
    getQueuePosition(): { index: number; total: number } {
        const player = this.bridge.player;
        const queue = player.queue || player.playlist || [];
        const index = player.queueIndex ?? 0;
        return { index, total: queue.length };
    }
}
