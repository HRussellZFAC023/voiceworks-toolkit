import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ShuffleFeature } from '../../src/features/Shuffle';
import { KikoeruBridge } from '../../src/infrastructure/KikoeruBridge';

describe('ShuffleFeature', () => {
    let bridge: KikoeruBridge;
    let mockStore: any;

    beforeEach(() => {
        // Reset singleton
        (KikoeruBridge as any).instance = null;
        mockStore = {
            state: {
                AudioPlayer: { playMode: 'order' }
            },
            commit: vi.fn((mutation, payload) => {
                if (mutation === 'AudioPlayer/setPlayMode') {
                    mockStore.state.AudioPlayer.playMode = payload;
                } else if (mutation === 'AudioPlayer/CHANGE_PLAY_MODE') {
                    const current = mockStore.state.AudioPlayer.playMode;
                    const modes = ['order', 'shuffle']; // Simplified cycle for test
                    const idx = modes.indexOf(current);
                    mockStore.state.AudioPlayer.playMode = modes[(idx + 1) % modes.length];
                }
            }),
            watch: vi.fn(() => vi.fn()),
        };

        document.body.innerHTML = '<div id="q-app"></div>';
        const app = document.getElementById('q-app');
        if (app) (app as any).__vue__ = { $store: mockStore, $router: {}, $axios: {} };

        bridge = KikoeruBridge.getInstance();
    });

    it('should toggle playMode from order to shuffle', async () => {
        await bridge.initialize();
        const shuffle = new ShuffleFeature();

        await shuffle.toggle();

        expect(mockStore.commit).toHaveBeenCalledWith('AudioPlayer/CHANGE_PLAY_MODE');
        expect(mockStore.state.AudioPlayer.playMode).toBe('shuffle');
    });

    it('should toggle playMode from shuffle to order', async () => {
        mockStore.state.AudioPlayer.playMode = 'shuffle';
        await bridge.initialize();
        const shuffle = new ShuffleFeature();

        await shuffle.toggle();

        expect(mockStore.commit).toHaveBeenCalledWith('AudioPlayer/CHANGE_PLAY_MODE');
        expect(mockStore.state.AudioPlayer.playMode).toBe('order');
    });

    it('uses the action contract when the mutation contract is unavailable', async () => {
        mockStore._mutations = {};
        mockStore._actions = { 'AudioPlayer/CHANGE_PLAY_MODE': [] };
        mockStore.dispatch = vi.fn(async (action: string) => {
            if (action === 'AudioPlayer/CHANGE_PLAY_MODE') {
                mockStore.state.AudioPlayer.playMode = 'shuffle';
            }
        });
        await bridge.initialize();
        const shuffle = new ShuffleFeature();

        await shuffle.toggle();

        expect(mockStore.dispatch).toHaveBeenCalledTimes(1);
        expect(mockStore.dispatch).toHaveBeenCalledWith('AudioPlayer/CHANGE_PLAY_MODE');
        expect(mockStore.commit).not.toHaveBeenCalled();
        expect(mockStore.state.AudioPlayer.playMode).toBe('shuffle');
    });

    it('does not call unsupported mutation or action contracts', async () => {
        mockStore._mutations = {};
        mockStore._actions = {};
        mockStore.dispatch = vi.fn();
        await bridge.initialize();
        const shuffle = new ShuffleFeature();

        await shuffle.toggle();

        expect(mockStore.commit).not.toHaveBeenCalled();
        expect(mockStore.dispatch).not.toHaveBeenCalled();
        expect(mockStore.state.AudioPlayer.playMode).toBe('order');
    });

    it('does not stack store watchers and cleans up its global API on disable', async () => {
        await bridge.initialize();
        const unwatch = vi.fn();
        mockStore.watch.mockReturnValue(unwatch);
        mockStore.watch.mockClear();
        const shuffle = new ShuffleFeature();

        shuffle.enable();
        shuffle.enable();
        expect(mockStore.watch).toHaveBeenCalledOnce();
        const capturedToggle = (window as any).ASMRUlt.toggleShuffle;
        expect(capturedToggle).toBeTypeOf('function');

        shuffle.disable();
        expect(unwatch).toHaveBeenCalledOnce();
        expect((window as any).ASMRUlt.toggleShuffle).toBeUndefined();

        mockStore.commit.mockClear();
        await capturedToggle();
        expect(mockStore.commit).not.toHaveBeenCalled();
    });
});
