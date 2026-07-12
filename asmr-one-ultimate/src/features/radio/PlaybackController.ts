/**
 * PlaybackController - Controls audio playback for Radio Mode
 *
 * Handles play, pause, queue management, and shuffle.
 */

import { KikoeruBridge } from '../../infrastructure/KikoeruBridge';
import { AppStore } from '../../store/AppStore';
import { Logger } from '../../core/Utils';
import {
    collectTracks,
    filterAudioTracks,
    selectBestFolder,
    shuffleInPlace,
} from '../../core/WorkUtils';
import { getAudioElement } from '../../core/DomUtils';
import { findButtonByText, findPlayButtons, findAudioItems } from '../../core/DomUtils';
import { FolderDiver } from '../FolderDiver';
import {
    isHostPlaybackQueueTrackSelected,
    replaceHostPlaybackQueue,
} from '../audioPlayerQueueUtils';
import { Config } from '../../core/Config';
import type { PlayerTrack, WorkFolder, WorkDetail, AudioTrack } from '../../types';

export class PlaybackController {
    private bridge: KikoeruBridge;

    constructor() {
        this.bridge = KikoeruBridge.getInstance();
    }

    /**
     * Stop current playback.
     *
     * Important: Do NOT strip the audio element's `src` or call `audio.load()`.
     * Removing the src puts the element in a broken state that the host app's
     * Vue reactivity tries to "fix" by restoring the old track source — causing
     * the previous track to resume. Instead, just pause and clear the Vuex queue.
     * Our setQueueAndPlay() will replace the queue + source cleanly.
     */
    stopPlayback(): void {
        const audio = getAudioElement();
        const pauseRequested = this.bridge.requestPause();
        if (!pauseRequested && audio && !audio.paused) {
            audio.pause();
            Logger.debug('[PlaybackController] Paused audio playback');
        }

        // Clear the queue to prevent host app from auto-advancing old tracks
        try {
            this.bridge.commit('AudioPlayer/SET_QUEUE', { queue: [], index: 0 });
        } catch (e) {
            Logger.debug('[PlaybackController] SET_QUEUE clear not available');
        }

    }

    /**
     * Try to start playback using multiple fallback strategies
     */
    async tryPlay(): Promise<boolean> {
        const player = this.bridge.player;
        const queueLength = (player.queue?.length || player.playlist?.length || 0);
        const hasCurrentTrack = !!(player.currentTrack || player.currentPlayingFile);

        // Try store dispatch first
        if (this.bridge.hasAction('AudioPlayer/play')) {
            try {
                await this.bridge.dispatch('AudioPlayer/play');
                return true;
            } catch {
                // Fall through to alternatives
            }
        }

        const storeRequested = this.bridge.requestPlay();

        // A recognized Vuex mutation means the request was dispatched, not
        // necessarily that an older host acted on it. Prefer a concrete media
        // play when an initialized element is available before reporting success.
        const audio = getAudioElement();
        const canUseDirectAudioFallback = queueLength > 0 || hasCurrentTrack;
        if (audio?.paused && canUseDirectAudioFallback && (audio.currentSrc || audio.getAttribute('src'))) {
            try {
                await audio.play();
                return true;
            } catch {
                // Fall through
            }
        }

        if (storeRequested) return true;

        // Try clicking play button
        return this.clickPlayButton();
    }

    /**
     * Set queue and start playback
     */
    async setQueueAndPlay(tracks: PlayerTrack[], startIndex = 0): Promise<void> {
        Logger.debug('[PlaybackController] setQueueAndPlay:', tracks.length, 'tracks, startIndex:', startIndex);

        // Ensure every track has `subtitles` — the deployed host's AudioPlayer
        // watcher accesses track.subtitles.length and crashes on undefined.
        const queue = tracks.map(t => ({
            ...t,
            subtitles: (t as PlayerTrack & { subtitles?: unknown[] }).subtitles || [],
        }));

        const track = queue[startIndex];
        if (!track) {
            Logger.warn('[PlaybackController] No track at startIndex');
            return;
        }

        Logger.debug('[PlaybackController] Playing track:', track.title || track.hash);

        try {
            if (!replaceHostPlaybackQueue(this.bridge.store, this.bridge, queue, startIndex)) {
                Logger.warn('[PlaybackController] Host queue contract unavailable');
            }
        } catch (err) {
            Logger.error('[PlaybackController] Failed to set queue:', err);
        }
    }

    /**
     * Force-play a specific queue index. Used when host auto-advance stalls.
     */
    async forcePlayQueueTrack(queue: PlayerTrack[], targetIndex: number): Promise<boolean> {
        const track = queue[targetIndex];
        if (!track) return false;

        const normalizedQueue = queue.map(item => ({
            ...item,
            subtitles: (item as PlayerTrack & { subtitles?: unknown[] }).subtitles || [],
        }));
        let playbackRequested = false;
        let selectedByQueueReplacement = false;

        // Current hosts expose playTrack as the authoritative selection action.
        // Await it, then verify state because Vuex silently ignores unknown
        // contracts and a resolved dispatch is not sufficient proof by itself.
        if (this.bridge.hasAction('AudioPlayer/playTrack')) {
            try {
                await this.bridge.dispatch('AudioPlayer/playTrack', normalizedQueue[targetIndex]);
                playbackRequested = true;
            } catch (err) {
                Logger.warn('[PlaybackController] force playTrack dispatch failed:', err);
            }
        }

        let selected = isHostPlaybackQueueTrackSelected(
            this.bridge.store,
            normalizedQueue,
            targetIndex,
        );

        if (!selected) {
            try {
                selectedByQueueReplacement = replaceHostPlaybackQueue(
                    this.bridge.store,
                    this.bridge,
                    normalizedQueue,
                    targetIndex,
                    { requestPlayback: false },
                );
            } catch (err) {
                Logger.warn('[PlaybackController] Failed to select queue track:', err);
            }
            selected = isHostPlaybackQueueTrackSelected(
                this.bridge.store,
                normalizedQueue,
                targetIndex,
            );
        }

        if (!selected) {
            Logger.warn('[PlaybackController] Host did not select requested queue track');
            return false;
        }

        if (selectedByQueueReplacement || !playbackRequested) {
            playbackRequested = this.bridge.requestPlay() || playbackRequested;
        }

        // Fallback: direct audio element play if mutations alone didn't start playback
        const audio = getAudioElement();
        if (audio?.paused && (audio.currentSrc || audio.getAttribute('src'))) {
            try {
                await audio.play();
                return true;
            } catch (err) {
                Logger.warn('[PlaybackController] force audio.play failed:', err);
            }
        }

        return playbackRequested || audio?.paused === false;
    }

    /**
     * Get playable tracks from a fetched work object
     */
    getPlayableTracksFromWork(work: WorkDetail): AudioTrack[] {
        if (!work) return [];

        // Check if FolderDiver has navigated to a specific folder
        const folderDiver = FolderDiver.getInstance();
        const currentPath = folderDiver.getPath();

        if (currentPath.length > 0) {
            const folder = folderDiver.getCurrentFolder(work);
            if (folder) {
                Logger.debug('[PlaybackController] Using folder from FolderDiver:', currentPath.join('/'));
                const tracks = collectTracks(folder);
                if (tracks.length > 0) {
                    return filterAudioTracks(tracks);
                }
            }
        }

        return this.extractTracksFromWork(work);
    }

    /**
     * Shuffle tracks and return queue starting at index 0
     */
    shuffleAndPlay(tracks: AudioTrack[]): { queue: AudioTrack[]; index: number } {
        const shuffled = [...tracks];
        shuffleInPlace(shuffled);
        return { queue: shuffled, index: 0 };
    }

    /**
     * Click a play button in the UI as a fallback
     */
    clickPlayButton(shuffleEnabled = AppStore.getConfig('shuffle')): boolean {
        const container = document.querySelector('.q-page-container');
        if (!container) return false;

        // Try Play All button first (non-shuffle)
        if (!shuffleEnabled) {
            const playAll = findButtonByText(['Play All', '全部播放'], container);
            if (playAll) {
                playAll.click();
                Logger.debug('[PlaybackController] Clicked Play All button');
                return true;
            }
        }

        // Find play buttons
        const playButtons = findPlayButtons(container);
        if (playButtons.length > 0) {
            let btn = playButtons[0];

            if (shuffleEnabled) {
                // Pick random audio button
                const audioItems = findAudioItems(container);
                const audioButtons = playButtons.filter((b) => {
                    const item = b.closest('.q-item, .file-list-item');
                    return item && audioItems.includes(item as HTMLElement);
                });

                if (audioButtons.length > 0) {
                    btn = audioButtons[Math.floor(Math.random() * audioButtons.length)];
                } else {
                    btn = playButtons[Math.floor(Math.random() * playButtons.length)];
                }
            }

            btn.click();
            Logger.debug('[PlaybackController] Clicked play button');
            return true;
        }

        // Fallback: click audio items directly
        const audioItems = findAudioItems(container);
        if (audioItems.length > 0) {
            const item = shuffleEnabled
                ? audioItems[Math.floor(Math.random() * audioItems.length)]
                : audioItems[0];
            item.click();
            Logger.debug('[PlaybackController] Clicked audio item');
            return true;
        }

        return false;
    }

    // =========================================================================
    // Private Methods
    // =========================================================================

    private extractTracksFromWork(work: WorkDetail): AudioTrack[] {
        const dirs = work.dirs || work.children || [];
        if (Array.isArray(dirs) && dirs.length > 0) {
            const bestFolder = selectBestFolder(
                dirs as WorkFolder[],
                undefined,
                Config.get('sePref'),
                Config.get('bgmPref'),
            );
            if (bestFolder) {
                const tracks = collectTracks(bestFolder);
                if (tracks.length > 0) {
                    return filterAudioTracks(tracks);
                }
            }
        }

        const allTracks = collectTracks(work as unknown as WorkFolder);
        return filterAudioTracks(allTracks);
    }
}
