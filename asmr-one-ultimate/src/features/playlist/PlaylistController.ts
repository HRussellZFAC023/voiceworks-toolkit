/**
 * PlaylistController - Handles playback control for playlist navigation
 */

import { KikoeruBridge } from '../../infrastructure/KikoeruBridge';
import { Logger } from '../../core/Utils';
import type { PlayerTrack } from '../../types';

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
        const queue = (arr: any[]) => {
            for (const item of arr) {
                if (item.type === 'audio' || item.mediaStreamUrl || item.stream_url) {
                    tracks.push(item);
                }
                if (item.children) queue(item.children);
                if (item.tracks) queue(item.tracks);
                if (item.dirs) queue(item.dirs);
            }
        };

        if (work.children) queue(work.children);
        if (work.tracks) queue(work.tracks);
        if (work.dirs) queue(work.dirs);

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

    private setQueueViaCommit(store: any, tracks: PlayerTrack[], index: number): void {
        try {
            store.commit('AudioPlayer/SET_QUEUE', { queue: tracks, index });
            store.commit('AudioPlayer/SET_TRACK', index);
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
