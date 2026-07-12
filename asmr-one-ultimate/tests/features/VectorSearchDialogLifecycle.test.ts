import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getWorks: vi.fn(),
    setInterval: vi.fn(),
    embed: vi.fn(),
    clearCancellable: vi.fn(),
    db: {
        count: vi.fn(),
        get: vi.fn(),
        put: vi.fn(),
        getAll: vi.fn(),
        close: vi.fn(),
    },
    store: {
        state: { AudioPlayer: { work: undefined as Record<string, unknown> | undefined } },
    },
}));

vi.mock('idb', () => ({
    openDB: vi.fn(async () => mocks.db),
    deleteDB: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/composables', () => ({
    useBridge: () => ({
        $watch: vi.fn(() => vi.fn()),
        api: { getTags: vi.fn().mockResolvedValue({ data: [] }) },
        axios: { defaults: { baseURL: 'https://api.asmr.one' } },
        store: mocks.store,
    }),
    useI18n: () => ({ t: (key: string) => key, format: (key: string) => key }),
    useEventBus: () => ({ on: vi.fn() }),
}));
vi.mock('../../src/api', () => ({ WorksApi: { getWorks: mocks.getWorks } }));
vi.mock('../../src/services/TranslationService', () => ({
    TranslationService: {
        translate: vi.fn(),
        cancelPending: vi.fn(),
        getUiTargetLang: () => 'en',
    },
}));
vi.mock('../../src/services/EmbeddingService', () => ({
    EmbeddingService: {
        embed: mocks.embed,
        isDead: () => false,
        isSuspended: () => false,
    },
}));
vi.mock('../../src/core/GpuScheduler', () => ({
    GpuScheduler: { clearCancellable: mocks.clearCancellable },
    Priority: { REALTIME: 0, NORMAL: 1, LOW: 2 },
}));
vi.mock('../../src/core/Utils', () => ({
    Config: {
        get: (key: string) => key === 'vectorIndexVersion' ? 4
            : key === 'vectorSearchModel' ? 'Xenova/multilingual-e5-small'
                : key === 'vectorIndexCursor' ? 1 : '',
        set: vi.fn(),
    },
    Logger: { debug: vi.fn(), info: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/infrastructure/HttpClient', () => ({
    HttpError: class HttpError extends Error { constructor(public status: number) { super(); } },
}));
vi.mock('../../src/features/vectorSearchPolicy', () => ({ shouldAutoIndexVectors: () => true }));
vi.mock('../../src/core/DeviceCapabilities', () => ({ DeviceCapabilities: { profile: {} } }));

import VectorSearchDialog from '../../src/features/components/VectorSearchDialog.vue';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
}

describe('VectorSearchDialog lifecycle', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        mocks.getWorks.mockReset();
        mocks.setInterval.mockReset();
        mocks.embed.mockReset();
        mocks.clearCancellable.mockReset();
        mocks.db.count.mockReset().mockResolvedValue(0);
        mocks.db.get.mockReset().mockResolvedValue(undefined);
        mocks.db.put.mockReset().mockResolvedValue(undefined);
        mocks.db.getAll.mockReset().mockResolvedValue([]);
        mocks.db.close.mockReset();
        mocks.store.state.AudioPlayer.work = undefined;
        vi.spyOn(window, 'setInterval').mockImplementation(((callback: TimerHandler, timeout?: number) => {
            mocks.setInterval(callback, timeout);
            return 91;
        }) as typeof window.setInterval);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('does not install an index watcher after unmount during auto-seed', async () => {
        const works = deferred<{ works: [] }>();
        mocks.getWorks.mockReturnValue(works.promise);
        const wrapper = mount(VectorSearchDialog, { attachTo: document.body });

        await vi.advanceTimersByTimeAsync(3_000);
        await vi.waitFor(() => expect(mocks.getWorks).toHaveBeenCalled());
        wrapper.unmount();
        works.resolve({ works: [] });
        await flushPromises();

        expect(mocks.setInterval).not.toHaveBeenCalled();
    });

    it('stops a bulk batch without writes or claiming more work after unmount', async () => {
        const embedding = deferred<number[]>();
        mocks.embed.mockReturnValue(embedding.promise);
        mocks.getWorks.mockResolvedValue({
            works: [1, 2, 3, 4].map((id) => ({ id, title: `Work ${id}`, tags: [] })),
        });
        const wrapper = mount(VectorSearchDialog, { attachTo: document.body });

        await vi.advanceTimersByTimeAsync(3_000);
        await flushPromises();
        expect(mocks.embed).toHaveBeenCalledTimes(3);

        wrapper.unmount();
        embedding.resolve([0.1, 0.2]);
        await flushPromises();

        expect(mocks.clearCancellable).toHaveBeenCalledWith('embedding', 'vector-search-index');
        expect(mocks.db.put).not.toHaveBeenCalled();
        expect(mocks.embed).toHaveBeenCalledTimes(3);
    });

    it('does not write a deferred current-work embedding after unmount', async () => {
        const embedding = deferred<number[]>();
        mocks.embed.mockReturnValue(embedding.promise);
        mocks.store.state.AudioPlayer.work = {
            id: 99,
            title: 'Current work',
            description: 'Deferred description',
            tags: [],
        };
        const wrapper = mount(VectorSearchDialog, { attachTo: document.body });
        await flushPromises();
        expect(mocks.embed).toHaveBeenCalledOnce();

        wrapper.unmount();
        embedding.resolve([0.3, 0.4]);
        await flushPromises();

        expect(mocks.db.put).not.toHaveBeenCalled();
    });
});
