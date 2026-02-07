import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DLsiteScraper } from '../../src/features/DLsiteScraper';
import { SharedCache } from '../../src/core/Cache';

const { mockDLsiteService } = vi.hoisted(() => ({
    mockDLsiteService: {
        fetchProductApi: vi.fn(),
        fetchDynamicApi: vi.fn(),
        fetchProductPageBody: vi.fn(),
        fetchProductPageReviews: vi.fn(),
    }
}));

vi.mock('../../src/services/DLsiteService', () => ({
    DLsiteService: mockDLsiteService,
}));

describe('DLsiteScraper', () => {
    let scraper: DLsiteScraper;

    beforeEach(() => {
        (DLsiteScraper as any).instance = null;
        SharedCache.clear();
        mockDLsiteService.fetchProductApi.mockReset();
        mockDLsiteService.fetchDynamicApi.mockReset();
        mockDLsiteService.fetchProductPageBody.mockReset();
        mockDLsiteService.fetchProductPageReviews.mockReset();
        scraper = DLsiteScraper.getInstance();
    });

    // =========================================================================
    // parseApi (tested via scrape)
    // =========================================================================
    describe('parseApi', () => {
        it('should parse a full product API response', async () => {
            mockDLsiteService.fetchProductApi.mockResolvedValue({
                work_name: 'My ASMR Work',
                maker_name: 'PEACHY! Peach',
                age_category: 3,
                regist_date: '2025-10-08 00:00:00',
                genres: [
                    { name: 'Genre/Ear Cleaning' },
                    { name: 'Genre/Whispering' },
                ],
                creaters: {
                    voice_by: [{ name: '和泉沙希' }, { name: 'Other VA' }],
                },
                series_name: 'My Series',
                price: 500,
                rate_count_detail: { '1': 0, '2': 0, '3': 0, '4': 10, '5': 90 },
                file_size: '1.2GB',
            });
            mockDLsiteService.fetchDynamicApi.mockResolvedValue(null);
            mockDLsiteService.fetchProductPageBody.mockResolvedValue(null);

            const meta = await scraper.scrape('RJ01382560');
            expect(meta.circle?.name).toBe('PEACHY! Peach');
            expect(meta.cvs).toContainEqual({ name: '和泉沙希' });
            expect(meta.tags.length).toBeGreaterThan(0);
            expect(meta.nsfw).toBe(true);
            expect(meta.rating_average).toBe(4.9);
            expect(meta.age_category_string).toBe('R18');
            expect(meta.file_size_string).toBe('1.2GB');
        });

        it('should use cache on repeated requests', async () => {
            mockDLsiteService.fetchProductApi.mockResolvedValue({
                work_name: 'Cached',
                age_category: 3,
                regist_date: '2025-01-01',
                genres: [],
                creaters: { voice_by: [] },
                price: 100,
                rate_count_detail: { '5': 10 },
            });
            mockDLsiteService.fetchDynamicApi.mockResolvedValue(null);
            mockDLsiteService.fetchProductPageBody.mockResolvedValue(null);

            await scraper.scrape('RJ00001111');
            const callsAfterFirst = mockDLsiteService.fetchProductApi.mock.calls.length;

            await scraper.scrape('RJ00001111');
            expect(mockDLsiteService.fetchProductApi.mock.calls.length).toBe(callsAfterFirst);
        });

        it('should fall back to minimal metadata on empty responses', async () => {
            mockDLsiteService.fetchProductApi.mockResolvedValue(null);
            mockDLsiteService.fetchDynamicApi.mockResolvedValue(null);
            mockDLsiteService.fetchProductPageBody.mockResolvedValue(null);

            const meta = await scraper.scrape('RJ00000000');
            expect(meta.rjcode).toBe('RJ00000000');
            expect(meta.title).toBe('RJ00000000');
            expect(meta.tags.length).toBe(0);
        });
    });

    // =========================================================================
    // getAgeString (tested via parseApi)
    // =========================================================================
    describe('getAgeString', () => {
        it('should return ALL for age_category 1', async () => {
            mockDLsiteService.fetchProductApi.mockResolvedValue({
                work_name: 'All Ages',
                age_category: 1,
                regist_date: '2025-01-01',
                genres: [],
                price: 0,
            });
            mockDLsiteService.fetchDynamicApi.mockResolvedValue(null);
            mockDLsiteService.fetchProductPageBody.mockResolvedValue(null);

            const meta = await scraper.scrape('RJ11111111');
            expect(meta.age_category_string).toBe('ALL');
            expect(meta.nsfw).toBe(false);
        });

        it('should return R15 for age_category 2', async () => {
            mockDLsiteService.fetchProductApi.mockResolvedValue({
                work_name: 'R15',
                age_category: 2,
                regist_date: '2025-01-01',
                genres: [],
                price: 0,
            });
            mockDLsiteService.fetchDynamicApi.mockResolvedValue(null);
            mockDLsiteService.fetchProductPageBody.mockResolvedValue(null);

            const meta = await scraper.scrape('RJ22222222');
            expect(meta.age_category_string).toBe('R15');
            expect(meta.nsfw).toBe(true);
        });

        it('should return R18 for age_category 3', async () => {
            mockDLsiteService.fetchProductApi.mockResolvedValue({
                work_name: 'R18',
                age_category: 3,
                regist_date: '2025-01-01',
                genres: [],
                price: 0,
            });
            mockDLsiteService.fetchDynamicApi.mockResolvedValue(null);
            mockDLsiteService.fetchProductPageBody.mockResolvedValue(null);

            const meta = await scraper.scrape('RJ33333333');
            expect(meta.age_category_string).toBe('R18');
        });
    });

    // =========================================================================
    // calculateRating (tested via parseApi)
    // =========================================================================
    describe('calculateRating', () => {
        it('should calculate weighted average from rate_count_detail', async () => {
            mockDLsiteService.fetchProductApi.mockResolvedValue({
                work_name: 'Rated',
                age_category: 3,
                regist_date: '2025-01-01',
                genres: [],
                price: 0,
                rate_count_detail: { '1': 1, '2': 1, '3': 1, '4': 1, '5': 1 },
            });
            mockDLsiteService.fetchDynamicApi.mockResolvedValue(null);
            mockDLsiteService.fetchProductPageBody.mockResolvedValue(null);

            const meta = await scraper.scrape('RJ44444444');
            expect(meta.rating_average).toBe(3); // (1+2+3+4+5)/5 = 3.0
        });

        it('should use rate_average_2dp when no rate_count_detail', async () => {
            mockDLsiteService.fetchProductApi.mockResolvedValue({
                work_name: 'Rated 2dp',
                age_category: 3,
                regist_date: '2025-01-01',
                genres: [],
                price: 0,
                rate_average_2dp: 4.56,
            });
            mockDLsiteService.fetchDynamicApi.mockResolvedValue(null);
            mockDLsiteService.fetchProductPageBody.mockResolvedValue(null);

            const meta = await scraper.scrape('RJ55555555');
            expect(meta.rating_average).toBe(4.56);
        });

        it('should convert rate_average_star from 0-50 scale', async () => {
            mockDLsiteService.fetchProductApi.mockResolvedValue({
                work_name: 'Star Rated',
                age_category: 3,
                regist_date: '2025-01-01',
                genres: [],
                price: 0,
                rate_average_star: 45, // 45/10 = 4.5
            });
            mockDLsiteService.fetchDynamicApi.mockResolvedValue(null);
            mockDLsiteService.fetchProductPageBody.mockResolvedValue(null);

            const meta = await scraper.scrape('RJ66666666');
            expect(meta.rating_average).toBe(4.5);
        });

        it('should handle rate_average_star <= 5 directly', async () => {
            mockDLsiteService.fetchProductApi.mockResolvedValue({
                work_name: 'Star Low',
                age_category: 3,
                regist_date: '2025-01-01',
                genres: [],
                price: 0,
                rate_average_star: 4.2,
            });
            mockDLsiteService.fetchDynamicApi.mockResolvedValue(null);
            mockDLsiteService.fetchProductPageBody.mockResolvedValue(null);

            const meta = await scraper.scrape('RJ77777777');
            expect(meta.rating_average).toBe(4.2);
        });

        it('should return 0 when no rating data', async () => {
            mockDLsiteService.fetchProductApi.mockResolvedValue({
                work_name: 'No Rating',
                age_category: 3,
                regist_date: '2025-01-01',
                genres: [],
                price: 0,
            });
            mockDLsiteService.fetchDynamicApi.mockResolvedValue(null);
            mockDLsiteService.fetchProductPageBody.mockResolvedValue(null);

            const meta = await scraper.scrape('RJ88888888');
            expect(meta.rating_average).toBe(0);
        });
    });

    // =========================================================================
    // mergeDynamic (tested via scrape with dynamic data)
    // =========================================================================
    describe('mergeDynamic', () => {
        it('should merge dynamic rating when base has none', async () => {
            mockDLsiteService.fetchProductApi.mockResolvedValue({
                work_name: 'No Rating Base',
                age_category: 3,
                regist_date: '2025-01-01',
                genres: [],
                price: 0,
            });
            mockDLsiteService.fetchDynamicApi.mockResolvedValue({
                rate_average_2dp: 4.3,
                price: 800,
                dl_count: 5000,
            });
            mockDLsiteService.fetchProductPageBody.mockResolvedValue(null);

            const meta = await scraper.scrape('RJ10000001');
            expect(meta.rating_average).toBe(4.3);
            expect(meta.dl_count).toBe('5000');
        });

        it('should merge dynamic price when base has none', async () => {
            mockDLsiteService.fetchProductApi.mockResolvedValue({
                work_name: 'No Price',
                age_category: 3,
                regist_date: '2025-01-01',
                genres: [],
                price: 0,
            });
            mockDLsiteService.fetchDynamicApi.mockResolvedValue({
                price: 990,
            });
            mockDLsiteService.fetchProductPageBody.mockResolvedValue(null);

            const meta = await scraper.scrape('RJ10000002');
            expect(meta.price).toBe(990);
        });

        it('should NOT override base rating with dynamic', async () => {
            mockDLsiteService.fetchProductApi.mockResolvedValue({
                work_name: 'Has Rating',
                age_category: 3,
                regist_date: '2025-01-01',
                genres: [],
                price: 500,
                rate_count_detail: { '5': 100 },
            });
            mockDLsiteService.fetchDynamicApi.mockResolvedValue({
                rate_average_2dp: 3.0, // should NOT override
            });
            mockDLsiteService.fetchProductPageBody.mockResolvedValue(null);

            const meta = await scraper.scrape('RJ10000003');
            expect(meta.rating_average).toBe(5.0); // from rate_count_detail
        });

        it('should handle null dynamic data gracefully', async () => {
            mockDLsiteService.fetchProductApi.mockResolvedValue({
                work_name: 'Base Only',
                age_category: 3,
                regist_date: '2025-01-01',
                genres: [],
                price: 500,
            });
            mockDLsiteService.fetchDynamicApi.mockResolvedValue(null);
            mockDLsiteService.fetchProductPageBody.mockResolvedValue(null);

            const meta = await scraper.scrape('RJ10000004');
            expect(meta.title).toBe('Base Only');
            expect(meta.price).toBe(500);
        });
    });

    // =========================================================================
    // buildMinimalMeta (tested via scrape with null product API)
    // =========================================================================
    describe('buildMinimalMeta', () => {
        it('should use dynamic data in minimal fallback', async () => {
            mockDLsiteService.fetchProductApi.mockResolvedValue(null);
            mockDLsiteService.fetchDynamicApi.mockResolvedValue({
                rate_average_2dp: 4.0,
                price: 700,
                dl_count: 3000,
            });
            mockDLsiteService.fetchProductPageBody.mockResolvedValue(null);

            const meta = await scraper.scrape('RJ10000005');
            expect(meta.rjcode).toBe('RJ10000005');
            expect(meta.title).toBe('RJ10000005'); // fallback title is rjcode
            expect(meta.nsfw).toBe(true);
            expect(meta.rating_average).toBe(4.0);
            expect(meta.price).toBe(700);
            expect(meta.dl_count).toBe('3000');
        });

        it('should handle both APIs returning null', async () => {
            mockDLsiteService.fetchProductApi.mockResolvedValue(null);
            mockDLsiteService.fetchDynamicApi.mockResolvedValue(null);
            mockDLsiteService.fetchProductPageBody.mockResolvedValue(null);

            const meta = await scraper.scrape('RJ10000006');
            expect(meta.rjcode).toBe('RJ10000006');
            expect(meta.rating_average).toBe(0);
            expect(meta.price).toBe(0);
            expect(meta.tags).toEqual([]);
            expect(meta.cvs).toEqual([]);
        });
    });

    // =========================================================================
    // CV deduplication
    // =========================================================================
    describe('CV parsing and deduplication', () => {
        it('should deduplicate CVs from multiple sources', async () => {
            mockDLsiteService.fetchProductApi.mockResolvedValue({
                work_name: 'Dup CVs',
                age_category: 3,
                regist_date: '2025-01-01',
                genres: [],
                price: 0,
                creaters: {
                    voice_by: [{ name: 'Alice' }, { name: 'Bob' }],
                },
                voice_by: [{ name: 'Alice' }, { name: 'Charlie' }],
            });
            mockDLsiteService.fetchDynamicApi.mockResolvedValue(null);
            mockDLsiteService.fetchProductPageBody.mockResolvedValue(null);

            const meta = await scraper.scrape('RJ10000007');
            // Alice should appear only once
            const aliceCount = meta.cvs.filter(cv => cv.name === 'Alice').length;
            expect(aliceCount).toBe(1);
            expect(meta.cvs).toHaveLength(3); // Alice, Bob, Charlie
        });

        it('should parse CVs from array-based creaters', async () => {
            mockDLsiteService.fetchProductApi.mockResolvedValue({
                work_name: 'Array CVs',
                age_category: 3,
                regist_date: '2025-01-01',
                genres: [],
                price: 0,
                creaters: [
                    { name: 'VA1', type: 'voice' },
                    { name: 'Writer1', type: 'scenario' },
                    { name: 'VA2', role: 'cv' },
                ],
            });
            mockDLsiteService.fetchDynamicApi.mockResolvedValue(null);
            mockDLsiteService.fetchProductPageBody.mockResolvedValue(null);

            const meta = await scraper.scrape('RJ10000008');
            expect(meta.cvs).toContainEqual({ name: 'VA1' });
            expect(meta.cvs).toContainEqual({ name: 'VA2' });
            // Writer1 should NOT be in cvs
            expect(meta.cvs.find(cv => cv.name === 'Writer1')).toBeUndefined();
        });

        it('should parse CVs from voice array', async () => {
            mockDLsiteService.fetchProductApi.mockResolvedValue({
                work_name: 'Voice Array',
                age_category: 3,
                regist_date: '2025-01-01',
                genres: [],
                price: 0,
                voice: [{ name: 'VoiceActor1' }, { value: 'VoiceActor2' }],
            });
            mockDLsiteService.fetchDynamicApi.mockResolvedValue(null);
            mockDLsiteService.fetchProductPageBody.mockResolvedValue(null);

            const meta = await scraper.scrape('RJ10000009');
            expect(meta.cvs).toContainEqual({ name: 'VoiceActor1' });
            expect(meta.cvs).toContainEqual({ name: 'VoiceActor2' });
        });
    });

    // =========================================================================
    // Genre/tag parsing
    // =========================================================================
    describe('genre and tag parsing', () => {
        it('should extract tag name from slash-separated path', async () => {
            mockDLsiteService.fetchProductApi.mockResolvedValue({
                work_name: 'Tags',
                age_category: 3,
                regist_date: '2025-01-01',
                genres: [
                    { id: 1, name: 'Category/ASMR' },
                    { id: 2, name: 'Deep/Nested/Whispering' },
                ],
                price: 0,
            });
            mockDLsiteService.fetchDynamicApi.mockResolvedValue(null);
            mockDLsiteService.fetchProductPageBody.mockResolvedValue(null);

            const meta = await scraper.scrape('RJ10000010');
            expect(meta.tags).toContainEqual({ id: 1, name: 'ASMR' });
            expect(meta.tags).toContainEqual({ id: 2, name: 'Whispering' });
        });

        it('should prefer genres_replaced over genres', async () => {
            mockDLsiteService.fetchProductApi.mockResolvedValue({
                work_name: 'Replaced',
                age_category: 3,
                regist_date: '2025-01-01',
                genres_replaced: [{ id: 10, name: 'Replaced Tag' }],
                genres: [{ id: 20, name: 'Original Tag' }],
                price: 0,
            });
            mockDLsiteService.fetchDynamicApi.mockResolvedValue(null);
            mockDLsiteService.fetchProductPageBody.mockResolvedValue(null);

            const meta = await scraper.scrape('RJ10000011');
            expect(meta.tags).toContainEqual({ id: 10, name: 'Replaced Tag' });
            expect(meta.tags.find(t => t.name === 'Original Tag')).toBeUndefined();
        });

        it('should skip genres with empty/null names', async () => {
            mockDLsiteService.fetchProductApi.mockResolvedValue({
                work_name: 'Bad Tags',
                age_category: 3,
                regist_date: '2025-01-01',
                genres: [
                    { id: 1, name: 'Valid' },
                    { id: 2, name: '' },
                    null,
                    { id: 3 },
                ],
                price: 0,
            });
            mockDLsiteService.fetchDynamicApi.mockResolvedValue(null);
            mockDLsiteService.fetchProductPageBody.mockResolvedValue(null);

            const meta = await scraper.scrape('RJ10000012');
            expect(meta.tags).toHaveLength(1);
            expect(meta.tags[0].name).toBe('Valid');
        });
    });

    // =========================================================================
    // Image parsing
    // =========================================================================
    describe('image parsing', () => {
        it('should prefix protocol-relative URLs with https:', async () => {
            mockDLsiteService.fetchProductApi.mockResolvedValue({
                work_name: 'Images',
                age_category: 3,
                regist_date: '2025-01-01',
                genres: [],
                price: 0,
                image_main: { url: '//img.dlsite.jp/modpub/images2/main.jpg' },
                image_samples: [
                    { url: '//img.dlsite.jp/modpub/images2/sample1.jpg' },
                    { resize_url: '//img.dlsite.jp/modpub/images2/sample2.jpg' },
                ],
            });
            mockDLsiteService.fetchDynamicApi.mockResolvedValue(null);
            mockDLsiteService.fetchProductPageBody.mockResolvedValue(null);

            const meta = await scraper.scrape('RJ10000013');
            expect(meta.image_main).toBe('https://img.dlsite.jp/modpub/images2/main.jpg');
            expect(meta.image_samples).toContain('https://img.dlsite.jp/modpub/images2/sample1.jpg');
            expect(meta.image_samples).toContain('https://img.dlsite.jp/modpub/images2/sample2.jpg');
        });

        it('should keep https URLs as-is', async () => {
            mockDLsiteService.fetchProductApi.mockResolvedValue({
                work_name: 'Full URLs',
                age_category: 3,
                regist_date: '2025-01-01',
                genres: [],
                price: 0,
                image_main: { url: 'https://img.dlsite.jp/main.jpg' },
            });
            mockDLsiteService.fetchDynamicApi.mockResolvedValue(null);
            mockDLsiteService.fetchProductPageBody.mockResolvedValue(null);

            const meta = await scraper.scrape('RJ10000014');
            expect(meta.image_main).toBe('https://img.dlsite.jp/main.jpg');
        });
    });

    // =========================================================================
    // Additional metadata fields
    // =========================================================================
    describe('additional metadata fields', () => {
        it('should parse series info', async () => {
            mockDLsiteService.fetchProductApi.mockResolvedValue({
                work_name: 'Series Test',
                age_category: 3,
                regist_date: '2025-01-01',
                genres: [],
                price: 0,
                series_name: 'My Series',
            });
            mockDLsiteService.fetchDynamicApi.mockResolvedValue(null);
            mockDLsiteService.fetchProductPageBody.mockResolvedValue(null);

            const meta = await scraper.scrape('RJ10000015');
            expect(meta.series).toEqual({ id: 0, name: 'My Series' });
        });

        it('should parse discount info', async () => {
            mockDLsiteService.fetchProductApi.mockResolvedValue({
                work_name: 'Discount',
                age_category: 3,
                regist_date: '2025-01-01',
                genres: [],
                price: 1000,
                discount: { discount_rate: 30, end_date: '2025-12-31' },
            });
            mockDLsiteService.fetchDynamicApi.mockResolvedValue(null);
            mockDLsiteService.fetchProductPageBody.mockResolvedValue(null);

            const meta = await scraper.scrape('RJ10000016');
            expect(meta.discount).toEqual({ rate: 30, end_date: '2025-12-31' });
        });

        it('should parse ranking data', async () => {
            mockDLsiteService.fetchProductApi.mockResolvedValue({
                work_name: 'Ranked',
                age_category: 3,
                regist_date: '2025-01-01',
                genres: [],
                price: 0,
                rank_week: 5,
                rank_month: 10,
                rank_year: 50,
                rank_total: 100,
            });
            mockDLsiteService.fetchDynamicApi.mockResolvedValue(null);
            mockDLsiteService.fetchProductPageBody.mockResolvedValue(null);

            const meta = await scraper.scrape('RJ10000017');
            expect(meta.rank).toEqual({ week: 5, month: 10, year: 50, total: 100 });
        });

        it('should parse contents list', async () => {
            mockDLsiteService.fetchProductApi.mockResolvedValue({
                work_name: 'Contents',
                age_category: 3,
                regist_date: '2025-01-01',
                genres: [],
                price: 0,
                contents: [
                    { file_name: 'track01.mp3', file_size_unit: '50MB' },
                    { name: 'track02.wav', file_size: '100MB' },
                ],
            });
            mockDLsiteService.fetchDynamicApi.mockResolvedValue(null);
            mockDLsiteService.fetchProductPageBody.mockResolvedValue(null);

            const meta = await scraper.scrape('RJ10000018');
            expect(meta.contents).toHaveLength(2);
            expect(meta.contents![0]).toEqual({ file_name: 'track01.mp3', file_size: '50MB' });
            expect(meta.contents![1]).toEqual({ file_name: 'track02.wav', file_size: '100MB' });
        });

        it('should parse intro_s as description and summary', async () => {
            mockDLsiteService.fetchProductApi.mockResolvedValue({
                work_name: 'Intro',
                age_category: 3,
                regist_date: '2025-01-01',
                genres: [],
                price: 0,
                intro_s: 'Short intro text',
            });
            mockDLsiteService.fetchDynamicApi.mockResolvedValue(null);
            mockDLsiteService.fetchProductPageBody.mockResolvedValue(null);

            const meta = await scraper.scrape('RJ10000019');
            expect(meta.description).toBe('Short intro text');
            expect(meta.summary).toBe('Short intro text');
        });

        it('should parse intro as body', async () => {
            mockDLsiteService.fetchProductApi.mockResolvedValue({
                work_name: 'Body',
                age_category: 3,
                regist_date: '2025-01-01',
                genres: [],
                price: 0,
                intro: 'Full intro body text',
            });
            mockDLsiteService.fetchDynamicApi.mockResolvedValue(null);
            mockDLsiteService.fetchProductPageBody.mockResolvedValue(null);

            const meta = await scraper.scrape('RJ10000020');
            expect(meta.intro).toBe('Full intro body text');
            expect(meta.body).toBe('Full intro body text');
        });

        it('should format release date correctly', async () => {
            mockDLsiteService.fetchProductApi.mockResolvedValue({
                work_name: 'Date Test',
                age_category: 3,
                regist_date: '2025/10/08 00:00:00',
                genres: [],
                price: 0,
            });
            mockDLsiteService.fetchDynamicApi.mockResolvedValue(null);
            mockDLsiteService.fetchProductPageBody.mockResolvedValue(null);

            const meta = await scraper.scrape('RJ10000021');
            expect(meta.release).toBe('2025-10-08');
        });
    });

    // =========================================================================
    // scrapeProgressive
    // =========================================================================
    describe('scrapeProgressive', () => {
        it('should return cached result immediately', async () => {
            // Pre-populate cache
            mockDLsiteService.fetchProductApi.mockResolvedValue({
                work_name: 'Cached Progressive',
                age_category: 3,
                regist_date: '2025-01-01',
                genres: [],
                price: 100,
            });
            mockDLsiteService.fetchDynamicApi.mockResolvedValue(null);
            mockDLsiteService.fetchProductPageBody.mockResolvedValue(null);

            await scraper.scrape('RJ20000001');
            mockDLsiteService.fetchProductApi.mockReset();

            const onProgress = vi.fn();
            const result = await scraper.scrapeProgressive('RJ20000001', onProgress);

            expect(result.title).toBe('Cached Progressive');
            expect(onProgress).not.toHaveBeenCalled(); // cached, no progressive phases
            expect(mockDLsiteService.fetchProductApi).not.toHaveBeenCalled();
        });

        it('should call onProgress with phase 1 data', async () => {
            mockDLsiteService.fetchProductApi.mockResolvedValue({
                work_name: 'Phase1',
                age_category: 3,
                regist_date: '2025-01-01',
                genres: [],
                price: 500,
            });
            mockDLsiteService.fetchDynamicApi.mockResolvedValue(null);
            mockDLsiteService.fetchProductPageBody.mockResolvedValue('Body text');

            const onProgress = vi.fn();
            const result = await scraper.scrapeProgressive('RJ20000002', onProgress);

            expect(onProgress).toHaveBeenCalledTimes(1);
            expect(onProgress.mock.calls[0][0].title).toBe('Phase1');
            expect(result.body).toBe('Body text');
        });

        it('should handle API failure in progressive mode', async () => {
            mockDLsiteService.fetchProductApi.mockRejectedValue(new Error('fail'));
            mockDLsiteService.fetchDynamicApi.mockRejectedValue(new Error('fail'));
            mockDLsiteService.fetchProductPageBody.mockResolvedValue(null);

            const onProgress = vi.fn();
            const result = await scraper.scrapeProgressive('RJ20000003', onProgress);

            expect(result.rjcode).toBe('RJ20000003');
            expect(result.title).toBe('RJ20000003'); // minimal meta fallback
            expect(onProgress).not.toHaveBeenCalled(); // no base = no progress emit
        });
    });

    // =========================================================================
    // scrapeReviews
    // =========================================================================
    describe('scrapeReviews', () => {
        it('should return reviews from service', async () => {
            mockDLsiteService.fetchProductPageReviews.mockResolvedValue([
                { text: 'Great!', rating: 5 },
                { text: 'Good', rating: 4 },
            ]);

            const reviews = await scraper.scrapeReviews('rj30000001');
            expect(reviews).toHaveLength(2);
            expect(reviews[0].source_rjcode).toBe('RJ30000001'); // normalized
        });

        it('should cache non-empty reviews', async () => {
            mockDLsiteService.fetchProductPageReviews.mockResolvedValue([
                { text: 'Cached Review', rating: 5 },
            ]);

            await scraper.scrapeReviews('RJ30000002');
            const callCount = mockDLsiteService.fetchProductPageReviews.mock.calls.length;

            const cached = await scraper.scrapeReviews('RJ30000002');
            expect(mockDLsiteService.fetchProductPageReviews.mock.calls.length).toBe(callCount);
            expect(cached[0].text).toBe('Cached Review');
        });

        it('should return empty array on failure', async () => {
            mockDLsiteService.fetchProductPageReviews.mockRejectedValue(new Error('Network'));

            const reviews = await scraper.scrapeReviews('RJ30000003');
            expect(reviews).toEqual([]);
        });

        it('should normalize rjCode to uppercase', async () => {
            mockDLsiteService.fetchProductPageReviews.mockResolvedValue([]);

            await scraper.scrapeReviews('rj30000004');
            expect(mockDLsiteService.fetchProductPageReviews).toHaveBeenCalledWith('RJ30000004');
        });
    });

    // =========================================================================
    // RJ code normalization
    // =========================================================================
    describe('RJ code normalization', () => {
        it('should normalize lowercase to uppercase', async () => {
            mockDLsiteService.fetchProductApi.mockResolvedValue({
                work_name: 'Normalized',
                age_category: 3,
                regist_date: '2025-01-01',
                genres: [],
                price: 0,
            });
            mockDLsiteService.fetchDynamicApi.mockResolvedValue(null);
            mockDLsiteService.fetchProductPageBody.mockResolvedValue(null);

            const meta = await scraper.scrape('rj40000001');
            expect(meta.rjcode).toBe('RJ40000001');
        });
    });
});
