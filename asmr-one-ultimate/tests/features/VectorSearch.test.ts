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
            payload: 'ear cleaning\near cleaning-translated',
            usedTranslation: true,
            tokens: ['ear', 'cleaning', 'translated'],
        });
    });
});

describe('VectorSearch scoring', () => {
    let bridge: KikoeruBridge;
    let vectorSearch: VectorSearch;

    beforeEach(() => {
        (KikoeruBridge as any).instance = null;
        document.body.innerHTML = '<div id="q-app"></div>';
        const app = document.getElementById('q-app');
        if (app) {
            (app as any).__vue__ = {
                $store: { state: { AudioPlayer: {} } },
                $router: {},
                $axios: { get: vi.fn() }
            };
        }
        bridge = KikoeruBridge.getInstance();
        vectorSearch = new VectorSearch();
    });

    describe('cosineSimilarity', () => {
        it('returns correct value for unit vectors', () => {
            const a = [0.6, 0.8, 0];
            const b = [0.8, 0.6, 0];
            const result = (vectorSearch as any).cosineSimilarity(a, b);
            // cosine similarity = dot(a,b) / (|a| * |b|) = 0.96 / (1.0 * 1.0) = 0.96
            expect(result).toBeCloseTo(0.96, 5);
        });

        it('returns 0 for orthogonal vectors', () => {
            const a = [1, 0, 0];
            const b = [0, 1, 0];
            expect((vectorSearch as any).cosineSimilarity(a, b)).toBe(0);
        });

        it('returns 1 for identical unit vectors', () => {
            const v = [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)];
            expect((vectorSearch as any).cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
        });

        it('returns 0 for zero vectors', () => {
            expect((vectorSearch as any).cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
        });
    });

    describe('calculateKeywordBoost', () => {
        function makeEntry(overrides: Partial<any> = {}): any {
            return {
                id: 'RJ001',
                title: 'テスト作品',
                description: 'テスト説明',
                tags: ['耳かき', 'ASMR'],
                vector: [],
                ...overrides,
            };
        }

        it('returns 0 with no tokens', () => {
            const boost = (vectorSearch as any).calculateKeywordBoost(
                makeEntry(), []
            );
            expect(boost).toBe(0);
        });

        it('gives highest boost for tag match', () => {
            // 'asmr' matches tag 'ASMR' (lowercased) => 0.08
            // matched=1 >= Math.min(2, tokens.length=1)=1, so multi-match bonus +0.04
            const boost = (vectorSearch as any).calculateKeywordBoost(
                makeEntry(), ['asmr']
            );
            expect(boost).toBeCloseTo(0.12, 2);
        });

        it('gives title boost for title match', () => {
            const boost = (vectorSearch as any).calculateKeywordBoost(
                makeEntry({ title: 'futanari teacher adventure' }),
                ['futanari']
            );
            // title match = 0.05 + multi-match bonus 0.04 (matched=1 >= min(2,1)=1)
            expect(boost).toBeCloseTo(0.09, 2);
        });

        it('max boost is significantly lower than old max of 0.40', () => {
            // Maximize every possible boost with many tokens
            const entry = makeEntry({
                title: 'ear cleaning asmr binaural',
                description: 'relaxing ear cleaning session',
                tags: ['ear cleaning', 'ASMR', 'binaural'],
            });
            const tokens = ['ear', 'cleaning', 'asmr', 'binaural'];
            const boost = (vectorSearch as any).calculateKeywordBoost(entry, tokens);
            // New weights should keep it well below 0.40
            expect(boost).toBeLessThan(0.40);
            // Typical single-token boost should be modest
            const singleBoost = (vectorSearch as any).calculateKeywordBoost(
                makeEntry(), ['asmr']
            );
            expect(singleBoost).toBeLessThan(0.15);
        });

        it('gives multi-match bonus when 2+ tokens match', () => {
            // Both '耳かき' and 'asmr' match tags => 0.08 + 0.08 + 0.04 (multi bonus) = 0.20
            const boost = (vectorSearch as any).calculateKeywordBoost(
                makeEntry(), ['耳かき', 'asmr']
            );
            expect(boost).toBeGreaterThan(0.15);
        });
    });

    describe('scoreEntry', () => {
        it('combines cosine similarity with keyword boost', () => {
            const entry = {
                id: 'RJ001', title: 'test', description: '', tags: ['asmr'],
                vector: [0.6, 0.8, 0],
            };
            const queryVector = [0.8, 0.6, 0];
            const meta = { tokens: ['asmr'] };

            const score = (vectorSearch as any).scoreEntry(entry, queryVector, meta);
            // cosineSimilarity ≈ 0.96, plus keyword boost for 'asmr' tag match (0.08)
            expect(score).toBeGreaterThan(0.96);
            expect(score).toBeLessThan(1.2);
        });

        it('semantic similarity dominates over keyword boost', () => {
            // High similarity, no keyword match
            const semanticEntry = {
                id: 'RJ001', title: '意味的に近い', description: '', tags: ['別のタグ'],
                vector: [0.0, 1.0, 0.0],
            };
            // Low similarity, keyword match
            const keywordEntry = {
                id: 'RJ002', title: 'ear cleaning', description: '', tags: ['ear cleaning'],
                vector: [0.9, 0.0, 0.44],
            };
            const queryVector = [0.0, 1.0, 0.0]; // identical to semanticEntry
            const meta = { tokens: ['ear', 'cleaning'] };

            const semanticScore = (vectorSearch as any).scoreEntry(semanticEntry, queryVector, meta);
            const keywordScore = (vectorSearch as any).scoreEntry(keywordEntry, queryVector, meta);

            // Semantic match (sim=1.0) should beat keyword match (sim≈0.0 + boost≈0.15)
            expect(semanticScore).toBeGreaterThan(keywordScore);
        });
    });
});
