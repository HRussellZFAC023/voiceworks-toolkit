import { describe, it, expect, beforeEach, vi } from 'vitest';
import { KikoeruBridge } from '../../src/infrastructure/KikoeruBridge';
import { Config } from '../../src/core/Utils';

const { mockWorksApi } = vi.hoisted(() => ({
    mockWorksApi: {
        getWorks: vi.fn(),
    }
}));

vi.mock('../../src/services/TranslationService', () => ({
    TranslationService: {
        translate: vi.fn(async (text: string) => `${text}-translated`)
    }
}));

vi.mock('idb', () => {
    return {
        openDB: vi.fn().mockResolvedValue({
            count: vi.fn().mockResolvedValue(0),
            get: vi.fn(),
            put: vi.fn(),
            getAll: vi.fn()
        }),
        deleteDB: vi.fn().mockResolvedValue(undefined)
    };
});

vi.mock('../../src/api', () => ({
    WorksApi: mockWorksApi,
}));

import { VectorSearch } from '../../src/features/VectorSearch';

describe('VectorSearch bulk indexing', () => {
    let bridge: KikoeruBridge;
    let mockAxios: any;

    beforeEach(() => {
        (KikoeruBridge as any).instance = null;
        document.body.innerHTML = '<div id="q-app"></div>';
        mockAxios = { get: vi.fn() };
        mockWorksApi.getWorks.mockReset();
        const app = document.getElementById('q-app');
        if (app) {
            (app as any).__vue__ = {
                $store: { state: { AudioPlayer: {} } },
                $router: {},
                $axios: mockAxios
            };
        }
        bridge = KikoeruBridge.getInstance();
    });

    it('continues paging on repeated bulk index runs', async () => {
        await bridge.initialize();

        mockWorksApi.getWorks.mockImplementation(({ page }: any) => {
            return Promise.resolve({ works: [{ id: `RJ${page}` }] });
        });

        const configSpy = vi.spyOn(Config, 'get').mockImplementation((key: string) => {
            return key === 'vectorSearchApiKey' ? 'jina_test' : '';
        });
        const setSpy = vi.spyOn(Config, 'set').mockImplementation(() => undefined);

        const vectorSearch = new VectorSearch();
        (vectorSearch as any).indexWork = vi.fn().mockResolvedValue(true);
        (vectorSearch as any).updateIndexCount = vi.fn();

        await (vectorSearch as any).bulkIndex({ maxPages: 2, maxWorks: 10 });
        await (vectorSearch as any).bulkIndex({ maxPages: 2, maxWorks: 10 });

        const pages = mockWorksApi.getWorks.mock.calls.map((call: any) => call[0]?.page);
        expect(pages).toEqual([1, 2, 3, 4]);
        expect(setSpy).toHaveBeenLastCalledWith('vectorIndexCursor', 5);

        configSpy.mockRestore();
        setSpy.mockRestore();
    });

    it('dedupes embedding requests for the same payload', async () => {
        await bridge.initialize();

        const configSpy = vi.spyOn(Config, 'get').mockImplementation((key: string) => {
            return key === 'vectorSearchApiKey' ? 'jina_test' : '';
        });

        const vectorSearch = new VectorSearch();
        const fetchSpy = vi.fn().mockResolvedValue([0.1, 0.2]);
        (vectorSearch as any).fetchEmbedding = fetchSpy;

        const [a, b] = await Promise.all([
            (vectorSearch as any).getEmbedding('hello world'),
            (vectorSearch as any).getEmbedding('hello world')
        ]);

        expect(a).toEqual([0.1, 0.2]);
        expect(b).toEqual([0.1, 0.2]);
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        configSpy.mockRestore();
    });

    it('auto-indexes in the background when API key is set', async () => {
        await bridge.initialize();

        vi.useFakeTimers();
        const configSpy = vi.spyOn(Config, 'get').mockImplementation((key: string) => {
            return key === 'vectorSearchApiKey' ? 'jina_test' : '';
        });

        const vectorSearch = new VectorSearch();
        const autoSpy = vi.spyOn(vectorSearch as any, 'scheduleAutoIndex').mockResolvedValue(undefined);
        vi.spyOn(vectorSearch as any, 'startIndexWatcher').mockImplementation(() => undefined);

        (vectorSearch as any).scheduleBackgroundIndex();
        await vi.advanceTimersByTimeAsync(3500);

        expect(autoSpy).toHaveBeenCalled();

        configSpy.mockRestore();
        vi.useRealTimers();
    });

    it('re-indexes from page 1 when new works are detected', async () => {
        await bridge.initialize();

        mockWorksApi.getWorks.mockResolvedValue({ works: [{ id: 'RJ999' }] });
        const configSpy = vi.spyOn(Config, 'get').mockImplementation((key: string) => {
            if (key === 'vectorSearchApiKey') return 'jina_test';
            if (key === 'vectorIndexLatestWorkId') return 'RJ100';
            return '';
        });

        const vectorSearch = new VectorSearch();
        const bulkSpy = vi.spyOn(vectorSearch as any, 'bulkIndex').mockResolvedValue(undefined);

        await (vectorSearch as any).checkForNewWorks();

        expect(bulkSpy).toHaveBeenCalledWith({
            maxPages: 3,
            maxWorks: 150,
            order: 'release',
            sort: 'desc',
            startPage: 1
        });

        configSpy.mockRestore();
    });

    it('limits concurrent embedding work per batch', async () => {
        await bridge.initialize();

        const configSpy = vi.spyOn(Config, 'get').mockImplementation((key: string) => {
            return key === 'vectorSearchApiKey' ? 'jina_test' : '';
        });

        const vectorSearch = new VectorSearch();
        let active = 0;
        let maxActive = 0;
        (vectorSearch as any).indexWork = vi.fn(async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise(resolve => setTimeout(resolve, 10));
            active -= 1;
            return true;
        });

        await (vectorSearch as any).indexWorks([1, 2, 3, 4, 5]);
        expect(maxActive).toBeLessThanOrEqual(3);

        configSpy.mockRestore();
    });

    it('translates non-Japanese queries before embedding', async () => {
        await bridge.initialize();

        const vectorSearch = new VectorSearch();

        const payload = await (vectorSearch as any).buildSearchContext('ear cleaning');

        expect(payload).toEqual({
            payload: 'ear cleaning\nRelated: ear cleaning-translated',
            usedTranslation: true,
            tokens: ['ear', 'cleaning', 'translated'],
            tagHints: []
        });
    });
});
