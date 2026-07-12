import { describe, it, expect, beforeEach, vi } from 'vitest';
import { KikoeruBridge } from '../../src/infrastructure/KikoeruBridge';

describe('KikoeruBridge', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="q-app"></div>';
        (KikoeruBridge as any).instance = null;
        delete (window as any).__ASMR_KIKOERU_BRIDGE__;
        vi.useRealTimers();
    });

    it('should timeout if #q-app is missing or not hydrated', async () => {
        vi.useFakeTimers();
        const bridge = KikoeruBridge.getInstance();
        const promise = bridge.initialize();

        vi.advanceTimersByTime(12000); // 50 * 200 = 10000ms

        await expect(promise).rejects.toThrow();
        vi.useRealTimers();
    });

    it('should initialize when __vue__ becomes available', async () => {
        vi.useFakeTimers();
        const bridge = KikoeruBridge.getInstance();
        const mockApp = { $store: {}, $router: {}, $axios: {} };
        const promise = bridge.initialize();

        setTimeout(() => {
            const app = document.getElementById('q-app');
            if (app) (app as any).__vue__ = mockApp;
        }, 100);

        vi.advanceTimersByTime(200);
        await promise;
        expect(bridge.store).toBe(mockApp.$store);
        vi.useRealTimers();
    });

    it('uses the current host playback mutations before legacy fallbacks', () => {
        const bridge = KikoeruBridge.getInstance();
        const commit = vi.fn();
        const store = {
            state: { AudioPlayer: { playing: false } },
            commit,
            _mutations: {
                'AudioPlayer/WANT_PLAY': [vi.fn()],
                'AudioPlayer/WANT_PAUSE': [vi.fn()],
                'AudioPlayer/TOGGLE_WANT_PLAYING': [vi.fn()],
            },
        };
        (bridge as any)._app = { $store: store, $router: {}, $axios: {} };

        expect(bridge.requestPlay()).toBe(true);
        expect(bridge.requestPause()).toBe(true);
        expect(bridge.togglePlayback()).toBe(true);
        expect(commit.mock.calls).toEqual([
            ['AudioPlayer/WANT_PLAY', undefined],
            ['AudioPlayer/WANT_PAUSE', undefined],
            ['AudioPlayer/TOGGLE_WANT_PLAYING', undefined],
        ]);
    });

    it('falls back to SET_PLAYING when mutation metadata is unavailable', () => {
        const bridge = KikoeruBridge.getInstance();
        const commit = vi.fn();
        (bridge as any)._app = {
            $store: { state: { AudioPlayer: { playing: false } }, commit },
            $router: {},
            $axios: {},
        };

        expect(bridge.requestPlay()).toBe(true);
        expect(bridge.requestPause()).toBe(true);
        expect(commit.mock.calls).toEqual([
            ['AudioPlayer/SET_PLAYING', true],
            ['AudioPlayer/SET_PLAYING', false],
        ]);
    });

    it('prefers legacy play/pause actions on action-only hosts', () => {
        const bridge = KikoeruBridge.getInstance();
        const commit = vi.fn();
        const dispatch = vi.fn(async () => undefined);
        (bridge as any)._app = {
            $store: {
                state: { AudioPlayer: { playing: false } },
                commit,
                dispatch,
                _actions: {
                    'AudioPlayer/play': [vi.fn()],
                    'AudioPlayer/pause': [vi.fn()],
                },
            },
            $router: {},
            $axios: {},
        };

        expect(bridge.requestPlay()).toBe(true);
        expect(bridge.requestPause()).toBe(true);
        expect(dispatch.mock.calls).toEqual([
            ['AudioPlayer/play', undefined],
            ['AudioPlayer/pause', undefined],
        ]);
        expect(commit).not.toHaveBeenCalled();
    });
});
