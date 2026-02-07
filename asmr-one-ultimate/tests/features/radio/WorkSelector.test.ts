import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock KikoeruBridge
const mockApi = {
    getWorks: vi.fn(),
};

const mockStore = {
    state: {
        View: { works: [] },
        Playlist: { works: [] },
        Works: { list: [] },
        AudioPlayer: { playing: false, currentTime: 0, duration: 0 },
        User: {},
    },
};

vi.mock('../../../src/infrastructure/KikoeruBridge', () => ({
    KikoeruBridge: {
        getInstance: () => ({
            api: mockApi,
            store: mockStore,
        }),
    },
}));

vi.mock('../../../src/store/AppStore', () => ({
    AppStore: {
        getConfig: vi.fn(),
    },
}));

import { WorkSelector } from '../../../src/features/radio/WorkSelector';

describe('WorkSelector', () => {
    let selector: WorkSelector;

    beforeEach(() => {
        vi.clearAllMocks();
        selector = new WorkSelector();
    });

    describe('selectRandomWork', () => {
        it('should return a random work', async () => {
            mockApi.getWorks.mockResolvedValueOnce({
                works: [{ id: '123', title: 'Test Work' }],
            });

            const work = await selector.selectRandomWork();
            expect(work?.id).toBe('123');
        });

        it('should skip recently played works', async () => {
            // First call returns work 1
            mockApi.getWorks.mockResolvedValueOnce({
                works: [{ id: '1', title: 'Work 1' }],
            });
            // Second call returns work 2
            mockApi.getWorks.mockResolvedValueOnce({
                works: [{ id: '2', title: 'Work 2' }],
            });

            // Mark work 1 as recently played
            selector.rememberWork('1');

            const work = await selector.selectRandomWork();
            expect(work?.id).toBe('2');
        });

        it('should return last candidate if all are recent', async () => {
            // All attempts return the same work
            mockApi.getWorks.mockResolvedValue({
                works: [{ id: '1', title: 'Work 1' }],
            });

            selector.rememberWork('1');

            const work = await selector.selectRandomWork();
            // Should still return the work as fallback
            expect(work?.id).toBe('1');
        });

        it('should skip current work', async () => {
            mockApi.getWorks.mockResolvedValueOnce({
                works: [{ id: '1', title: 'Work 1' }],
            });
            mockApi.getWorks.mockResolvedValueOnce({
                works: [{ id: '2', title: 'Work 2' }],
            });

            const work = await selector.selectRandomWork('1');
            expect(work?.id).toBe('2');
        });
    });

    describe('rememberWork', () => {
        it('should add work to recent list', () => {
            selector.rememberWork('123');
            expect(selector.isRecentlyPlayed('123')).toBe(true);
        });

        it('should not duplicate entries', () => {
            selector.rememberWork('123');
            selector.rememberWork('123');
            const recent = selector.getRecentWorkIds();
            expect(recent.filter(id => id === '123')).toHaveLength(1);
        });

        it('should limit recent works', () => {
            // Add more than MAX_RECENT_WORKS
            for (let i = 0; i < 20; i++) {
                selector.rememberWork(String(i));
            }
            expect(selector.getRecentWorkIds().length).toBeLessThanOrEqual(8);
        });
    });

    describe('clearHistory', () => {
        it('should clear all recent works', () => {
            selector.rememberWork('1');
            selector.rememberWork('2');
            selector.clearHistory();
            expect(selector.getRecentWorkIds()).toHaveLength(0);
        });
    });

    describe('findNextInPlaylist', () => {
        it('should find next work in View.works', () => {
            mockStore.state.View.works = [
                { id: '1', title: 'Work 1' },
                { id: '2', title: 'Work 2' },
                { id: '3', title: 'Work 3' },
            ] as any;

            const next = selector.findNextInPlaylist('2');
            expect(next).toBe('3');
        });

        it('should return null at end of list', () => {
            mockStore.state.View.works = [
                { id: '1', title: 'Work 1' },
                { id: '2', title: 'Work 2' },
            ] as any;

            const next = selector.findNextInPlaylist('2');
            expect(next).toBeNull();
        });

        it('should return null if work not in list', () => {
            mockStore.state.View.works = [
                { id: '1', title: 'Work 1' },
            ] as any;

            const next = selector.findNextInPlaylist('999');
            expect(next).toBeNull();
        });
    });
});
