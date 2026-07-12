import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    initialize: vi.fn(),
    commit: vi.fn(),
    gmGetValue: vi.fn(),
    gmSetValue: vi.fn(),
}));

vi.mock('../../src/infrastructure/KikoeruBridge', () => ({
    KikoeruBridge: {
        getInstance: () => ({
            initialize: mocks.initialize,
            commit: mocks.commit,
            store: { state: { Playlist: {}, Works: {} } },
        }),
    },
}));

vi.mock('../../src/store/AppStore', () => ({
    AppStore: { state: { learner: { isActive: false } } },
}));

vi.mock('$', () => ({
    GM_getValue: mocks.gmGetValue,
    GM_setValue: mocks.gmSetValue,
}));

vi.mock('../../src/core/Utils', () => ({
    Logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { StoreBackup } from '../../src/features/StoreBackup';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
}

describe('StoreBackup lifecycle', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        mocks.initialize.mockReset().mockResolvedValue(undefined);
        mocks.commit.mockReset();
        mocks.gmGetValue.mockReset().mockReturnValue(JSON.stringify({
            timestamp: Date.now(),
            siteState: { Playlist: { playlists: [] }, Works: { list: [] } },
            app: { learnerActive: false },
        }));
        mocks.gmSetValue.mockReset();
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('does not restore or start a timer after disable during bridge initialization', async () => {
        const ready = deferred<void>();
        mocks.initialize.mockReturnValue(ready.promise);
        const feature = new StoreBackup();

        const first = feature.enable();
        const duplicate = feature.enable();
        feature.disable();
        ready.resolve();
        await Promise.all([first, duplicate]);

        expect(mocks.initialize).toHaveBeenCalledOnce();
        expect(mocks.commit).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('clears its periodic timer on disable', async () => {
        mocks.gmGetValue.mockReturnValue(null);
        const feature = new StoreBackup();
        await feature.enable();
        expect(vi.getTimerCount()).toBe(1);

        feature.disable();
        expect(vi.getTimerCount()).toBe(0);
    });
});
