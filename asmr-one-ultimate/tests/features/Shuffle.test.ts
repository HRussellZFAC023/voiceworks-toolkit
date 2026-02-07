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
            })
        };

        document.body.innerHTML = '<div id="q-app"></div>';
        const app = document.getElementById('q-app');
        if (app) (app as any).__vue__ = { $store: mockStore, $router: {}, $axios: {} };

        bridge = KikoeruBridge.getInstance();
    });

    it('should toggle playMode from order to shuffle', async () => {
        await bridge.initialize();
        const shuffle = new ShuffleFeature();

        shuffle.toggle();

        expect(mockStore.commit).toHaveBeenCalledWith('AudioPlayer/CHANGE_PLAY_MODE');
        expect(mockStore.state.AudioPlayer.playMode).toBe('shuffle');
    });

    it('should toggle playMode from shuffle to order', async () => {
        mockStore.state.AudioPlayer.playMode = 'shuffle';
        await bridge.initialize();
        const shuffle = new ShuffleFeature();

        shuffle.toggle();

        expect(mockStore.commit).toHaveBeenCalledWith('AudioPlayer/CHANGE_PLAY_MODE');
        expect(mockStore.state.AudioPlayer.playMode).toBe('order');
    });
});
