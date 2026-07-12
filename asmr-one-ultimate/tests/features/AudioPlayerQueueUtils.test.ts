import { describe, expect, it, vi } from 'vitest';
import {
    isHostPlaybackQueueTrackSelected,
    replaceHostPlaybackQueue,
} from '../../src/features/audioPlayerQueueUtils';

describe('replaceHostPlaybackQueue', () => {
    it('moves the index and compatibility track before replacing a smaller queue', () => {
        const state = {
            AudioPlayer: {
                currentTime: 0,
                duration: 0,
                queueIndex: 5,
                currentPlayingFile: { hash: 'old', title: 'Old' },
            },
            User: {},
        };
        const commit = vi.fn((mutation: string, payload?: unknown) => {
            if (mutation === 'AudioPlayer/SET_TRACK') {
                state.AudioPlayer.queueIndex = payload as number;
            }
            if (mutation === 'AudioPlayer/SET_QUEUE') {
                expect(state.AudioPlayer.queueIndex).toBe(0);
                expect(state.AudioPlayer.currentPlayingFile.hash).toBe('new');
            }
        });
        const store = {
            state,
            commit,
            _mutations: { 'AudioPlayer/SET_TRACK': [] },
        };
        const bridge = {
            hasMutation: (mutation: string) => mutation === 'AudioPlayer/SET_TRACK',
            requestPlay: vi.fn(() => true),
        };
        const queue = [{ hash: 'new', title: 'New', subtitles: [] }];

        expect(replaceHostPlaybackQueue(store as any, bridge, queue, 0)).toBe(true);
        expect(commit.mock.calls.map(([mutation]) => mutation)).toEqual([
            'AudioPlayer/SET_TRACK',
            'AudioPlayer/SET_QUEUE',
        ]);
        expect(state.AudioPlayer.currentPlayingFile).toEqual(queue[0]);
        expect(bridge.requestPlay).toHaveBeenCalledTimes(1);
    });

    it('uses the legacy PLAY mutation when SET_TRACK is unavailable', () => {
        const commit = vi.fn();
        const store = {
            state: {
                AudioPlayer: { currentTime: 0, duration: 0, queueIndex: 5, currentPlayingFile: undefined },
                User: {},
            },
            commit,
            _mutations: { 'AudioPlayer/PLAY': [] },
        };
        const bridge = {
            hasMutation: (mutation: string) => mutation === 'AudioPlayer/PLAY',
            requestPlay: vi.fn(() => {
                commit('AudioPlayer/PLAY');
                return true;
            }),
        };

        replaceHostPlaybackQueue(store as any, bridge, [{ hash: 'new' }], 0);

        expect(store.state.AudioPlayer.queueIndex).toBe(0);
        expect(commit.mock.calls.map(([mutation]) => mutation)).toEqual([
            'AudioPlayer/SET_QUEUE',
            'AudioPlayer/PLAY',
        ]);
        expect(bridge.requestPlay).toHaveBeenCalledTimes(1);
    });

    it('requires concrete current-track or queue-index evidence of target selection', () => {
        const target = { hash: 'target' };
        const store = {
            state: {
                AudioPlayer: {
                    currentTime: 0,
                    duration: 0,
                    queueIndex: 0,
                    queue: [{ hash: 'other' }, target],
                },
                User: {},
            },
        };

        expect(isHostPlaybackQueueTrackSelected(store as any, [store.state.AudioPlayer.queue[0], target], 1)).toBe(false);
        store.state.AudioPlayer.queueIndex = 1;
        expect(isHostPlaybackQueueTrackSelected(store as any, [store.state.AudioPlayer.queue[0], target], 1)).toBe(true);
    });
});
