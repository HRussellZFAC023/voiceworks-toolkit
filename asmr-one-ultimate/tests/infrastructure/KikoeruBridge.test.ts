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
});
