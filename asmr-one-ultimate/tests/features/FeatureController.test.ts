import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Component } from 'vue';

const mocks = vi.hoisted(() => ({
    register: vi.fn(),
    unregister: vi.fn(),
    routeUnwatch: vi.fn(),
    watch: vi.fn(),
    mount: vi.fn(),
    unmount: vi.fn(),
}));

vi.mock('../../src/core/CentralObserver', () => ({
    CentralObserver: { register: mocks.register, unregister: mocks.unregister },
}));
vi.mock('../../src/infrastructure/KikoeruBridge', () => ({
    KikoeruBridge: {
        getInstance: () => ({ $watch: mocks.watch }),
    },
}));
vi.mock('../../src/core/MountApp', () => ({
    mountApp: mocks.mount,
}));
vi.mock('../../src/core/Utils', () => ({
    Logger: { debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/features/components/DownloadCenter.vue', () => ({
    default: {},
}));

import { FeatureController } from '../../src/features/FeatureController';
import { DownloadCenterController } from '../../src/features/DownloadCenterController';

class TestController extends FeatureController {
    active = true;
    get component(): Component { return {} as Component; }
    findInjectionPoint(): HTMLElement | null { return document.getElementById('anchor'); }
    protected shouldBeActive(): boolean { return this.active; }
}

class PersistentTestController extends TestController {
    protected get preserveMountOnAnchorReplacement(): boolean { return true; }
}

describe('FeatureController lifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = '<div id="anchor"></div>';
        mocks.watch.mockReturnValue(mocks.routeUnwatch);
        mocks.mount.mockReturnValue({ unmount: mocks.unmount, proxy: {} });
    });

    it('is idempotent across repeated enable and disable events', () => {
        const controller = new TestController('feature-root');
        controller.enable();
        controller.enable();

        expect(mocks.register).toHaveBeenCalledTimes(1);
        expect(mocks.watch).toHaveBeenCalledTimes(1);
        expect(mocks.mount).toHaveBeenCalledTimes(1);

        controller.disable();
        controller.disable();
        expect(mocks.unregister).toHaveBeenCalledTimes(1);
        expect(mocks.routeUnwatch).toHaveBeenCalledTimes(1);
        expect(mocks.unmount).toHaveBeenCalledTimes(1);
        expect(document.getElementById('feature-root')).toBeNull();
    });

    it('removes an orphan container when mounting fails', () => {
        mocks.mount.mockImplementationOnce(() => { throw new Error('mount failed'); });
        const controller = new TestController('feature-root');
        controller.enable();

        expect(document.getElementById('feature-root')).not.toBeNull();
        controller.disable();
        expect(document.getElementById('feature-root')).toBeNull();
    });

    it('does not remount from an observer callback queued before disable', () => {
        const controller = new TestController('feature-root');
        controller.enable();
        const observerCallback = mocks.register.mock.calls[0][1] as () => void;

        controller.disable();
        observerCallback();

        expect(mocks.mount).toHaveBeenCalledTimes(1);
        expect(document.getElementById('feature-root')).toBeNull();
    });

    it('unmounts when an observer pass finds the feature is no longer active', () => {
        const controller = new TestController('feature-root');
        controller.enable();
        const observerCallback = mocks.register.mock.calls[0][1] as () => void;

        controller.active = false;
        observerCallback();

        expect(mocks.unmount).toHaveBeenCalledTimes(1);
        expect(document.getElementById('feature-root')).toBeNull();
    });

    it('still unmounts an anchor-preserving feature when its route becomes inactive', () => {
        const controller = new PersistentTestController('feature-root');
        controller.enable();
        const observerCallback = mocks.register.mock.calls[0][1] as () => void;

        document.getElementById('anchor')?.remove();
        controller.active = false;
        observerCallback();

        expect(mocks.unmount).toHaveBeenCalledTimes(1);
        expect(document.getElementById('feature-root')).toBeNull();
    });

    it('reattaches the same Download Center app after the host replaces its toolbar', () => {
        document.body.innerHTML = '<header class="q-header"><div class="q-toolbar"></div></header>';
        const controller = new DownloadCenterController();
        controller.enable();
        const observerCallback = mocks.register.mock.calls.find(
            ([id]) => id === 'asmr-download-center-root',
        )?.[1] as (() => void) | undefined;
        const originalRoot = document.getElementById('asmr-download-center-root');

        expect(observerCallback).toBeTypeOf('function');
        expect(originalRoot?.isConnected).toBe(true);
        expect(mocks.mount).toHaveBeenCalledTimes(1);

        document.querySelector('.q-header')?.remove();
        observerCallback?.();

        // Keep the Vue owner alive while the host is between toolbar renders.
        // Its Teleport children remain connected to <body> throughout.
        expect(originalRoot?.isConnected).toBe(false);
        expect(mocks.unmount).not.toHaveBeenCalled();

        document.body.insertAdjacentHTML(
            'beforeend',
            '<header class="q-header"><div class="q-toolbar"></div></header>',
        );
        observerCallback?.();

        expect(document.getElementById('asmr-download-center-root')).toBe(originalRoot);
        expect(originalRoot?.parentElement?.classList.contains('asmr-header-actions')).toBe(true);
        expect(mocks.mount).toHaveBeenCalledTimes(1);
        expect(mocks.unmount).not.toHaveBeenCalled();

        controller.disable();
        expect(mocks.unmount).toHaveBeenCalledTimes(1);
        expect(originalRoot?.isConnected).toBe(false);
    });
});
