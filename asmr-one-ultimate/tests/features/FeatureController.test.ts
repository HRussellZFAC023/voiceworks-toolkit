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

import { FeatureController } from '../../src/features/FeatureController';

class TestController extends FeatureController {
    active = true;
    get component(): Component { return {} as Component; }
    findInjectionPoint(): HTMLElement | null { return document.getElementById('anchor'); }
    protected shouldBeActive(): boolean { return this.active; }
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
});
