import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getWorks: vi.fn(),
    setInterval: vi.fn(),
    embed: vi.fn(),
    clearCancellable: vi.fn(),
    baselineSync: vi.fn(),
    putDelta: vi.fn(),
    baselineActive: false,
    config: new Map<string, unknown>(),
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
        get: (key: string) => mocks.config.get(key) ?? '',
        set: (key: string, value: unknown) => mocks.config.set(key, value),
    },
    Logger: { debug: vi.fn(), info: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/infrastructure/HttpClient', () => ({
    HttpError: class HttpError extends Error { constructor(public status: number) { super(); } },
}));
vi.mock('../../src/features/vectorSearchPolicy', () => ({ shouldAutoIndexVectors: () => true }));
vi.mock('../../src/core/DeviceCapabilities', () => ({ DeviceCapabilities: { profile: {} } }));
vi.mock('../../src/features/vectorSearchBaselineClient', () => ({
    VectorSearchBaselineClient: class {
        synchronize = mocks.baselineSync;
    },
}));
vi.mock('../../src/features/vectorSearchRepository', () => ({
    VectorSearchRepository: class {
        clearDelta = vi.fn();
        getDelta = vi.fn();
        putDelta = mocks.putDelta;
        getState = vi.fn(async () => ({ key: 'state' }));
        hasUsableActiveBaseline = vi.fn(async () => mocks.baselineActive);
        countMerged = vi.fn(async (fallback: unknown[]) => fallback.length);
        getMergedEntries = vi.fn(async (fallback: unknown[]) => fallback);
    },
}));

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
        mocks.baselineSync.mockReset().mockResolvedValue({ status: 'cached', datasetId: 'test', entries: 0 });
        mocks.putDelta.mockReset().mockResolvedValue(true);
        mocks.baselineActive = false;
        mocks.config.clear();
        mocks.config.set('vectorIndexVersion', 4);
        mocks.config.set('vectorSearchModel', 'Xenova/multilingual-e5-small');
        mocks.config.set('vectorIndexCursor', 1);
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
            works: [1, 2, 3, 4].map((id) => ({ id, title: `Work ${id}`, release: '2026-07-15', tags: [] })),
        });
        const wrapper = mount(VectorSearchDialog, { attachTo: document.body });

        await vi.advanceTimersByTimeAsync(3_000);
        await flushPromises();
        expect(mocks.embed).toHaveBeenCalledTimes(3);

        wrapper.unmount();
        embedding.resolve([0.1, 0.2]);
        await flushPromises();

        expect(mocks.clearCancellable).toHaveBeenCalledWith('embedding', 'vector-search-index');
        expect(mocks.putDelta).not.toHaveBeenCalled();
        expect(mocks.embed).toHaveBeenCalledTimes(3);
    });

    it('does not write a deferred current-work embedding after unmount', async () => {
        const embedding = deferred<number[]>();
        mocks.embed.mockReturnValue(embedding.promise);
        mocks.store.state.AudioPlayer.work = {
            id: 99,
            title: 'Current work',
            release: '2026-07-15',
            description: 'Deferred description',
            tags: [],
        };
        const wrapper = mount(VectorSearchDialog, { attachTo: document.body });
        await flushPromises();
        expect(mocks.embed).toHaveBeenCalledOnce();

        wrapper.unmount();
        embedding.resolve([0.3, 0.4]);
        await flushPromises();

        expect(mocks.putDelta).not.toHaveBeenCalled();
    });

    it('never embeds current works at or before the shared baseline cutoff', async () => {
        mocks.baselineActive = true;
        mocks.store.state.AudioPlayer.work = {
            id: 98,
            title: 'Baseline work',
            release: '2026-07-14',
            tags: [],
        };
        const wrapper = mount(VectorSearchDialog, { attachTo: document.body });
        await flushPromises();
        expect(mocks.embed).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it('stops the delta scan when the first page is wholly covered by the baseline', async () => {
        mocks.baselineActive = true;
        mocks.getWorks.mockResolvedValue({
            works: [{ id: 1, title: 'Old', release: '2026-07-14', tags: [] }],
        });
        const wrapper = mount(VectorSearchDialog, { attachTo: document.body });
        await vi.advanceTimersByTimeAsync(3_000);
        await flushPromises();
        expect(mocks.getWorks).toHaveBeenCalledTimes(1);
        expect(mocks.embed).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it('retains full-history indexing while no verified baseline is active', async () => {
        mocks.store.state.AudioPlayer.work = {
            id: 97,
            title: 'Legacy local work',
            release: '2020-01-01',
            tags: [],
        };
        mocks.embed.mockResolvedValue([0.1, 0.2]);
        const wrapper = mount(VectorSearchDialog, { attachTo: document.body });
        await flushPromises();
        expect(mocks.embed).toHaveBeenCalledOnce();
        expect(mocks.putDelta).toHaveBeenCalledOnce();
        wrapper.unmount();
    });

    it('does not treat an old release page as the cutoff before baseline activation', async () => {
        mocks.embed.mockResolvedValue([0.1, 0.2]);
        mocks.getWorks.mockImplementation(async ({ page }: { page: number }) => ({
            works: page === 1
                ? [{ id: 50, title: 'Historical page work', release: '2020-01-01', tags: [] }]
                : [],
        }));
        const wrapper = mount(VectorSearchDialog, { attachTo: document.body });
        await vi.advanceTimersByTimeAsync(3_000);
        await flushPromises();
        await vi.advanceTimersByTimeAsync(2_000);
        await flushPromises();

        expect(mocks.getWorks.mock.calls.map((call) => call[0].page)).toEqual([1, 2]);
        expect(mocks.embed).toHaveBeenCalledOnce();
        wrapper.unmount();
    });

    it('continues baseline delta scanning beyond 200 full pages before stopping at the cutoff', async () => {
        mocks.baselineActive = true;
        mocks.embed.mockResolvedValue([0.1, 0.2]);
        mocks.getWorks.mockImplementation(async ({ page }: { page: number }) => ({
            works: page <= 202
                ? [{ id: page, title: `New ${page}`, release: '2026-07-15', tags: [] }]
                : [{ id: page, title: 'Baseline boundary', release: '2026-07-14', tags: [] }],
        }));
        const wrapper = mount(VectorSearchDialog, { attachTo: document.body });

        await vi.advanceTimersByTimeAsync(520_000);
        await flushPromises();

        const pages = mocks.getWorks.mock.calls.map((call) => call[0].page as number);
        expect(pages).toContain(201);
        expect(pages).toContain(202);
        expect(pages).toContain(203);
        expect(Math.max(...pages)).toBe(203);
        expect(mocks.putDelta.mock.calls.length).toBeGreaterThanOrEqual(200);
        wrapper.unmount();
    });

    it('restarts a full delta scan when the page-one head changes during deep continuation', async () => {
        mocks.baselineActive = true;
        mocks.embed.mockResolvedValue([0.1, 0.2]);
        let pageOneCalls = 0;
        mocks.getWorks.mockImplementation(async ({ page }: { page: number }) => {
            if (page === 1) {
                pageOneCalls += 1;
                return {
                    works: [{
                        id: pageOneCalls === 1 ? 'head-a' : 'head-b',
                        title: 'Newest', release: '2026-07-15', tags: [],
                    }],
                };
            }
            const reachedCutoff = page >= 201 || (pageOneCalls >= 3 && page === 2);
            return {
                works: [{
                    id: `page-${page}-${pageOneCalls}`,
                    title: reachedCutoff ? 'Baseline boundary' : `New ${page}`,
                    release: reachedCutoff ? '2026-07-14' : '2026-07-15',
                    tags: [],
                }],
            };
        });
        const wrapper = mount(VectorSearchDialog, { attachTo: document.body });

        await vi.advanceTimersByTimeAsync(550_000);
        await flushPromises();

        const pages = mocks.getWorks.mock.calls.map((call) => call[0].page as number);
        expect(pages.filter((page) => page === 1)).toHaveLength(3);
        expect(pages.filter((page) => page === 2)).toHaveLength(2);
        expect(mocks.config.get('vectorIndexCursor')).toBe(1);
        expect(mocks.config.get('vectorIndexLatestWorkId')).toBe('head-b');
        wrapper.unmount();
    });
});
