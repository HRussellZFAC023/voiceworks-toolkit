import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { DLsiteApi } from '../../src/services/DLsiteApi';
import { HttpClient } from '../../src/infrastructure/HttpClient';
import type { DLsiteProductApiResponse, DLsiteReviewApiResponse } from '../../src/types/dlsite';

vi.mock('../../src/infrastructure/HttpClient', () => ({
    HttpClient: {
        getJsonViaCors: vi.fn(),
        isRateLimited: vi.fn().mockReturnValue(false),
    },
}));

describe('DLsiteApi', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as any).GM_setValue('dlsiteProxyUrl', '');
    });

    describe('getProduct', () => {
        it('returns product when API returns valid data', async () => {
            const mockProduct: Partial<DLsiteProductApiResponse> = {
                workno: 'RJ123456',
                work_name: 'Test Product',
            };

            (HttpClient.getJsonViaCors as Mock).mockResolvedValue({
                data: [mockProduct],
                status: 200,
            });

            const result = await DLsiteApi.getProduct('RJ123456');

            expect(result).toEqual(mockProduct);
            expect(HttpClient.getJsonViaCors).toHaveBeenCalled();
            const calledUrls = (HttpClient.getJsonViaCors as Mock).mock.calls.map((call) => call[0]);
            expect(calledUrls.some((url: string) => url.includes('maniax/api/=/product.json'))).toBe(true);
        });

        it('normalizes and trims workno before request', async () => {
            (HttpClient.getJsonViaCors as Mock).mockResolvedValue({
                data: [{ workno: 'RJ123456', work_name: 'Normalized' }],
                status: 200,
            });

            await DLsiteApi.getProduct('  rj123456  ');

            expect(HttpClient.getJsonViaCors).toHaveBeenCalledWith(
                expect.stringContaining('/maniax/api/=/product.json'),
                expect.objectContaining({
                    params: expect.objectContaining({ workno: 'RJ123456' }),
                }),
            );
        });

        it('returns null and skips requests for empty workno', async () => {
            const result = await DLsiteApi.getProduct('   ');
            expect(result).toBeNull();
            expect(HttpClient.getJsonViaCors).not.toHaveBeenCalled();
        });

        it('returns null if all API calls fail', async () => {
            (HttpClient.getJsonViaCors as Mock).mockRejectedValue(new Error('Not found'));

            const result = await DLsiteApi.getProduct('RJ000000');
            expect(result).toBeNull();
        });

        it('uses proxy for maniax product endpoint when configured', async () => {
            (globalThis as any).GM_setValue('dlsiteProxyUrl', 'wild-sun-1a84.henry-85d.workers.dev');
            (HttpClient.getJsonViaCors as Mock).mockResolvedValue({
                data: [{ workno: 'RJ01510683', work_name: 'Proxy Product' }],
                status: 200,
            });

            const result = await DLsiteApi.getProduct('RJ01510683');

            expect(result?.workno).toBe('RJ01510683');
            expect(HttpClient.getJsonViaCors).toHaveBeenCalledWith(
                'https://wild-sun-1a84.henry-85d.workers.dev/maniax/api/=/product.json',
                expect.objectContaining({
                    params: expect.objectContaining({ workno: 'RJ01510683' }),
                }),
            );
        });

        it('falls back to direct dlsite URL for invalid proxy config', async () => {
            (globalThis as any).GM_setValue('dlsiteProxyUrl', 'javascript:alert(1)');
            (HttpClient.getJsonViaCors as Mock).mockResolvedValue({
                data: [{ workno: 'RJ01510683', work_name: 'Direct Product' }],
                status: 200,
            });

            await DLsiteApi.getProduct('RJ01510683');

            expect(HttpClient.getJsonViaCors).toHaveBeenCalledWith(
                'https://www.dlsite.com/maniax/api/=/product.json',
                expect.any(Object),
            );
        });
    });

    describe('search', () => {
        it('returns list of products for keyword search', async () => {
            const mockProducts: Partial<DLsiteProductApiResponse>[] = [
                { workno: 'RJ111', work_name: 'Imouto 1' },
                { workno: 'RJ222', work_name: 'Imouto 2' },
            ];

            (HttpClient.getJsonViaCors as Mock).mockResolvedValue({
                data: mockProducts,
                status: 200,
            });

            const result = await DLsiteApi.search('imouto');

            expect(result).toHaveLength(2);
            expect(result[0].workno).toBe('RJ111');
            expect(HttpClient.getJsonViaCors).toHaveBeenCalledWith(
                expect.stringContaining('maniax/api/=/product.json'),
                expect.objectContaining({
                    params: expect.objectContaining({ keyword_work_name: 'imouto' }),
                }),
            );
        });

        it('skips search request for empty keyword', async () => {
            const result = await DLsiteApi.search('  ');
            expect(result).toEqual([]);
            expect(HttpClient.getJsonViaCors).not.toHaveBeenCalled();
        });
    });

    describe('getReviews', () => {
        it('returns review list', async () => {
            const mockReviewResponse: Partial<DLsiteReviewApiResponse> = {
                review_list: [
                    {
                        review_id: '1',
                        reviewer_name: 'User1',
                        star: 5,
                        comment: 'Great',
                    } as any,
                ],
                product_param: {
                    maker_id: 'RG1',
                } as any,
            };

            (HttpClient.getJsonViaCors as Mock).mockResolvedValue({
                data: mockReviewResponse,
                status: 200,
            });

            const result = await DLsiteApi.getReviews({ workno: 'RJ123456' });

            expect(result).not.toBeNull();
            expect(result!.review_list).toHaveLength(1);
            expect(result!.review_list[0].reviewer_name).toBe('User1');
        });

        it('uses proxy for maniax review endpoint when configured', async () => {
            (globalThis as any).GM_setValue('dlsiteProxyUrl', 'https://wild-sun-1a84.henry-85d.workers.dev');
            (HttpClient.getJsonViaCors as Mock).mockResolvedValue({
                data: { review_list: [], product_param: {} },
                status: 200,
            });

            await DLsiteApi.getReviews({ workno: 'RJ01510683' });

            expect(HttpClient.getJsonViaCors).toHaveBeenCalledWith(
                'https://wild-sun-1a84.henry-85d.workers.dev/maniax/api/=/review.json',
                expect.objectContaining({
                    params: expect.objectContaining({ workno: 'RJ01510683' }),
                }),
            );
        });
    });
});
