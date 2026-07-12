import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    route: { path: '/work/RJ000123' },
    routeCallback: null as ((to: { path?: string }) => void) | null,
    observerCallback: null as (() => void) | null,
    unwatch: vi.fn(),
    gmGetValue: vi.fn(),
    gmSetValue: vi.fn(),
}));

vi.mock('$', () => ({
    GM_getValue: mocks.gmGetValue,
    GM_setValue: mocks.gmSetValue,
}));

vi.mock('../../src/infrastructure/KikoeruBridge', () => ({
    KikoeruBridge: {
        getInstance: () => ({
            route: mocks.route,
            $watch: vi.fn((_path: string, callback: (to: { path?: string }) => void) => {
                mocks.routeCallback = callback;
                return mocks.unwatch;
            }),
        }),
    },
}));

vi.mock('../../src/core/CentralObserver', () => ({
    CentralObserver: {
        register: vi.fn((_name: string, callback: () => void) => {
            mocks.observerCallback = callback;
        }),
        unregister: vi.fn(),
        withModification: (callback: () => void) => callback(),
    },
}));

vi.mock('../../src/core/Utils', () => ({
    Logger: { debug: vi.fn() },
}));

import { VisitCounter } from '../../src/features/VisitCounter';

describe('VisitCounter lifecycle', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <div class="q-card">
                <a href="/work/RJ000123"><div class="q-img__content"></div></a>
            </div>
        `;
        mocks.route.path = '/work/RJ000123';
        mocks.routeCallback = null;
        mocks.observerCallback = null;
        mocks.unwatch.mockReset();
        mocks.gmGetValue.mockReset().mockReturnValue('{}');
        mocks.gmSetValue.mockReset();
    });

    it('is idempotent, removes badges, and does not count a same-route re-enable', () => {
        const counter = new VisitCounter();
        counter.enable();
        counter.enable();
        expect(document.querySelectorAll('.asmr-visit-badge')).toHaveLength(1);
        expect(mocks.gmSetValue).toHaveBeenCalledOnce();

        counter.disable();
        expect(mocks.unwatch).toHaveBeenCalledOnce();
        expect(document.querySelector('.asmr-visit-badge')).toBeNull();

        counter.enable();
        expect(mocks.gmSetValue).toHaveBeenCalledOnce();
    });

    it('rejects queued route and observer callbacks after disable', () => {
        const counter = new VisitCounter();
        counter.enable();
        const queuedRoute = mocks.routeCallback;
        const queuedObserver = mocks.observerCallback;
        counter.disable();
        mocks.gmSetValue.mockClear();

        queuedRoute?.({ path: '/work/RJ000999' });
        queuedObserver?.();

        expect(mocks.gmSetValue).not.toHaveBeenCalled();
        expect(document.querySelector('.asmr-visit-badge')).toBeNull();
    });
});
