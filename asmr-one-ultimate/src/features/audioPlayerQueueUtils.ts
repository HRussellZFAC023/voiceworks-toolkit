/**
 * Replace the host player's queue without exposing its synchronous stale-index
 * watcher to an out-of-bounds entry from the previous queue.
 */

import type { KikoeruStore } from '../types/store';

export interface HostPlaybackBridge {
    hasMutation(mutation: string): boolean;
    requestPlay(): boolean;
}

export interface ReplaceHostPlaybackQueueOptions {
    requestPlayback?: boolean;
}

function trackIdentity(track: object | null | undefined): string | null {
    if (!track) return null;
    const candidate = track as Record<string, unknown>;
    for (const field of ['hash', 'mediaStreamUrl', 'src', 'url']) {
        const value = candidate[field];
        if (typeof value === 'string' && value) return `${field}:${value}`;
    }
    return null;
}

function isSameTrack(left: object | null | undefined, right: object | null | undefined): boolean {
    if (!left || !right) return false;
    if (left === right) return true;
    const leftIdentity = trackIdentity(left);
    return leftIdentity !== null && leftIdentity === trackIdentity(right);
}

/**
 * Prove that the host selected the requested target. A playback request alone
 * is not proof: unsupported Vuex mutations only warn and otherwise look like a
 * successful call.
 */
export function isHostPlaybackQueueTrackSelected<T extends object>(
    store: KikoeruStore,
    queue: T[],
    index: number,
): boolean {
    const target = queue[index];
    if (!target) return false;

    const player = store.state.AudioPlayer;
    if (isSameTrack(player.currentTrack, target) || isSameTrack(player.currentPlayingFile, target)) {
        return true;
    }

    if (player.queueIndex !== index) return false;
    return isSameTrack(player.queue?.[index], target)
        || isSameTrack(player.playlist?.[index], target);
}

export function replaceHostPlaybackQueue<T extends object>(
    store: KikoeruStore,
    bridge: HostPlaybackBridge,
    queue: T[],
    index: number,
    options: ReplaceHostPlaybackQueueOptions = {},
): boolean {
    if (!store.commit) return false;
    const track = queue[index];
    if (!track) return false;

    // SET_QUEUE updates queue before queueIndex in deployed host builds. Its
    // synchronous watcher reads queue[queueIndex].subtitles, so move the index
    // first while the old queue is still intact.
    const canSetTrack = bridge.hasMutation('AudioPlayer/SET_TRACK') || !store._mutations;
    if (canSetTrack) {
        store.commit('AudioPlayer/SET_TRACK', index);
    }

    // Some host variants do not copy this compatibility field. Always replace
    // an existing field so active-track readers cannot retain the old file.
    const player = store.state.AudioPlayer;
    if (!canSetTrack && player && 'queueIndex' in player) {
        player.queueIndex = index;
    }
    if (player && 'currentPlayingFile' in player) {
        player.currentPlayingFile = { ...track } as unknown as typeof player.currentPlayingFile;
    }

    store.commit('AudioPlayer/SET_QUEUE', { queue, index });

    // requestPlay owns the compatibility mutation selection; invoking PLAY
    // separately here would double-commit it on legacy hosts.
    if (options.requestPlayback !== false) bridge.requestPlay();
    return true;
}
