import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetAxios, mockGetJsonViaCors } = vi.hoisted(() => ({
    mockGetAxios: vi.fn(),
    mockGetJsonViaCors: vi.fn(),
}));

vi.mock('../../src/api/Client', () => ({
    getAxios: mockGetAxios,
}));

vi.mock('../../src/infrastructure/HttpClient', () => ({
    HttpClient: {
        getJsonViaCors: mockGetJsonViaCors,
    },
}));

import { hasMoreWorkPages, readWorksTotalCount, WorksApi, type WorksResponse } from '../../src/api/Works';

const MOCK_RESPONSE = {
    data: {
        works: [{ id: 1, title: 'Test Work' }],
        pagination: { currentPage: 1, pageSize: 20, totalCount: 1 },
    },
};

describe('WorksApi', () => {
    beforeEach(() => {
        mockGetAxios.mockReset();
        mockGetJsonViaCors.mockReset();
        mockGetJsonViaCors.mockResolvedValue(MOCK_RESPONSE);
    });

    // =========================================================================
    // getApiBaseUrl (tested indirectly via API calls)
    // =========================================================================
    describe('getApiBaseUrl (via getWorks)', () => {
        it('should use axios baseURL when available', async () => {
            mockGetAxios.mockReturnValue({
                defaults: { baseURL: 'https://api.asmr-100.com' },
            });

            await WorksApi.getWorks();
            expect(mockGetJsonViaCors).toHaveBeenCalledWith(
                'https://api.asmr-100.com/api/works',
                expect.any(Object),
            );
        });

        it('should strip trailing slash from baseURL', async () => {
            mockGetAxios.mockReturnValue({
                defaults: { baseURL: 'https://api.asmr-100.com/' },
            });

            await WorksApi.getWorks();
            expect(mockGetJsonViaCors).toHaveBeenCalledWith(
                'https://api.asmr-100.com/api/works',
                expect.any(Object),
            );
        });

        it('should fall back to default server when axios not ready', async () => {
            mockGetAxios.mockImplementation(() => { throw new Error('not ready'); });

            await WorksApi.getWorks();
            expect(mockGetJsonViaCors).toHaveBeenCalledWith(
                'https://api.asmr-200.com/api/works',
                expect.any(Object),
            );
        });

        it('should fall back when baseURL is empty', async () => {
            mockGetAxios.mockReturnValue({ defaults: { baseURL: '' } });

            await WorksApi.getWorks();
            expect(mockGetJsonViaCors).toHaveBeenCalledWith(
                'https://api.asmr-200.com/api/works',
                expect.any(Object),
            );
        });

        it('should fall back when baseURL is not http', async () => {
            mockGetAxios.mockReturnValue({ defaults: { baseURL: '/api' } });

            await WorksApi.getWorks();
            expect(mockGetJsonViaCors).toHaveBeenCalledWith(
                'https://api.asmr-200.com/api/works',
                expect.any(Object),
            );
        });
    });

    // =========================================================================
    // getWorks
    // =========================================================================
    describe('getWorks', () => {
        beforeEach(() => {
            mockGetAxios.mockReturnValue({
                defaults: { baseURL: 'https://api.asmr-200.com' },
            });
        });

        it('should call /api/works with no params', async () => {
            const result = await WorksApi.getWorks();
            expect(mockGetJsonViaCors).toHaveBeenCalledWith(
                'https://api.asmr-200.com/api/works',
                expect.objectContaining({ params: undefined }),
            );
            expect(result).toEqual(MOCK_RESPONSE.data);
        });

        it('should pass params through', async () => {
            await WorksApi.getWorks({ page: 2, order: 'rating', sort: 'desc' });
            expect(mockGetJsonViaCors).toHaveBeenCalledWith(
                'https://api.asmr-200.com/api/works',
                expect.objectContaining({
                    params: { page: 2, order: 'rating', sort: 'desc' },
                }),
            );
        });

        it('should include retry config', async () => {
            await WorksApi.getWorks();
            expect(mockGetJsonViaCors).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    retry: { attempts: 2, backoffMs: 1000, multiplier: 2 },
                }),
            );
        });
    });

    // =========================================================================
    // searchWorks
    // =========================================================================
    describe('searchWorks', () => {
        beforeEach(() => {
            mockGetAxios.mockReturnValue({
                defaults: { baseURL: 'https://api.asmr-200.com' },
            });
        });

        it('should encode keyword in URL', async () => {
            await WorksApi.searchWorks('耳かき ASMR');
            expect(mockGetJsonViaCors).toHaveBeenCalledWith(
                expect.stringContaining('/api/search/' + encodeURIComponent('耳かき ASMR')),
                expect.any(Object),
            );
        });

        it('should handle special characters in keyword', async () => {
            await WorksApi.searchWorks('test/query&param');
            const url = mockGetJsonViaCors.mock.calls[0][0];
            expect(url).toContain(encodeURIComponent('test/query&param'));
        });

        it('should pass additional params', async () => {
            await WorksApi.searchWorks('ASMR', { page: 3, sort: 'asc' });
            expect(mockGetJsonViaCors).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    params: { page: 3, sort: 'asc' },
                }),
            );
        });
    });

    // =========================================================================
    // getWorksByVA
    // =========================================================================
    describe('getWorksByVA', () => {
        beforeEach(() => {
            mockGetAxios.mockReturnValue({
                defaults: { baseURL: 'https://api.asmr-200.com' },
            });
        });

        it('should build correct URL with numeric VA ID', async () => {
            await WorksApi.getWorksByVA(12345);
            expect(mockGetJsonViaCors).toHaveBeenCalledWith(
                'https://api.asmr-200.com/api/vas/12345/works',
                expect.any(Object),
            );
        });

        it('should build correct URL with string VA ID', async () => {
            await WorksApi.getWorksByVA('67890');
            expect(mockGetJsonViaCors).toHaveBeenCalledWith(
                'https://api.asmr-200.com/api/vas/67890/works',
                expect.any(Object),
            );
        });
    });

    // =========================================================================
    // getWorksByCircle
    // =========================================================================
    describe('getWorksByCircle', () => {
        beforeEach(() => {
            mockGetAxios.mockReturnValue({
                defaults: { baseURL: 'https://api.asmr-200.com' },
            });
        });

        it('should build correct URL with circle ID', async () => {
            await WorksApi.getWorksByCircle(999);
            expect(mockGetJsonViaCors).toHaveBeenCalledWith(
                'https://api.asmr-200.com/api/circles/999/works',
                expect.any(Object),
            );
        });
    });

    // =========================================================================
    // getWorksByTag
    // =========================================================================
    describe('getWorksByTag', () => {
        beforeEach(() => {
            mockGetAxios.mockReturnValue({
                defaults: { baseURL: 'https://api.asmr-200.com' },
            });
        });

        it('should build correct URL with tag ID', async () => {
            await WorksApi.getWorksByTag(42);
            expect(mockGetJsonViaCors).toHaveBeenCalledWith(
                'https://api.asmr-200.com/api/tags/42/works',
                expect.any(Object),
            );
        });

        it('should pass params for tag works', async () => {
            await WorksApi.getWorksByTag(42, { page: 2, order: 'dl_count' });
            expect(mockGetJsonViaCors).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    params: { page: 2, order: 'dl_count' },
                }),
            );
        });
    });
});

describe('work pagination helpers', () => {
    const response = (works: number, totalCount: number): WorksResponse => ({
        works: Array.from({ length: works }, (_, index) => ({ id: index } as never)),
        pagination: { currentPage: 1, pageSize: works, totalCount },
    });

    it('reports the catalogue total the API advertises', () => {
        expect(readWorksTotalCount(response(20, 1234))).toBe(1234);
    });

    it('never advertises a total smaller than the rows already loaded', () => {
        expect(readWorksTotalCount(response(20, 5), 100)).toBe(120);
    });

    it('falls back to the loaded count when the API omits a usable total', () => {
        expect(readWorksTotalCount({ works: [{} as never], pagination: undefined as never }, 10)).toBe(11);
    });

    it('offers another page only while loaded rows trail the total', () => {
        expect(hasMoreWorkPages(response(20, 100), 20)).toBe(true);
        expect(hasMoreWorkPages(response(20, 20), 20)).toBe(false);
        expect(hasMoreWorkPages(response(0, 100), 20)).toBe(false);
    });

    it('forwards page-size hints to the search endpoint', async () => {
        mockGetAxios.mockReturnValue({ defaults: { baseURL: 'https://api.asmr-100.com' } });
        await WorksApi.searchWorks('query', { page: 2, pageSize: 100, limit: 100 });
        expect(mockGetJsonViaCors).toHaveBeenCalledWith(
            'https://api.asmr-100.com/api/search/query',
            expect.objectContaining({ params: { page: 2, pageSize: 100, limit: 100 } }),
        );
    });
});
