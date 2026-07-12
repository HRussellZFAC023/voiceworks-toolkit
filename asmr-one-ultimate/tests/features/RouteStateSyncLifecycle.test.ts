import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    route: { path: '/works', fullPath: '/works?order=release&sort=desc', query: {} as Record<string, unknown> },
    unwatch: vi.fn(),
}));

vi.mock('$', () => ({ GM_getValue: vi.fn(), GM_setValue: vi.fn() }));
vi.mock('../../src/infrastructure/KikoeruBridge', () => ({
    KikoeruBridge: {
        getInstance: () => ({
            route: mocks.route,
            $watch: vi.fn(() => mocks.unwatch),
            axios: {},
            app: {},
            findComponent: vi.fn(() => null),
        }),
    },
}));
vi.mock('../../src/core/Utils', () => ({
    Logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    I18n: { lang: 'en', t: (key: string) => key },
}));
vi.mock('../../src/store/AppStore', () => ({
    AppStore: { state: { search: {} } },
}));

import { RouteStateSync } from '../../src/features/RouteStateSync';

describe('RouteStateSync retry lifecycle', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        mocks.route.path = '/works';
        mocks.route.fullPath = '/works?order=release&sort=desc';
        mocks.route.query = {};
        mocks.unwatch.mockReset();
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('cancels stale component retries on disable', async () => {
        const feature = new RouteStateSync();
        (feature as any)._enabled = true;
        (feature as any).lifecycleGeneration = 1;
        const find = vi.spyOn(feature as any, 'findWorksComponent').mockReturnValue(null);
        const setSort = vi.spyOn(feature as any, 'setSortOption');

        (feature as any).applySortToComponent('release', 'desc');
        expect(vi.getTimerCount()).toBe(1);
        feature.disable();
        find.mockReturnValue({ sortOption: {}, sortOptions: [] });
        await vi.advanceTimersByTimeAsync(10_000);

        expect(vi.getTimerCount()).toBe(0);
        expect(setSort).not.toHaveBeenCalled();
    });

    it('rejects retries captured for an older route', async () => {
        const feature = new RouteStateSync();
        (feature as any)._enabled = true;
        (feature as any).lifecycleGeneration = 1;
        vi.spyOn(feature as any, 'findWorksComponent').mockReturnValue(null);
        const setSort = vi.spyOn(feature as any, 'setSortOption');

        (feature as any).applySortToComponent('release', 'desc');
        mocks.route.fullPath = '/works?order=price&sort=asc';
        await vi.advanceTimersByTimeAsync(1_000);

        expect(setSort).not.toHaveBeenCalled();
    });
});
