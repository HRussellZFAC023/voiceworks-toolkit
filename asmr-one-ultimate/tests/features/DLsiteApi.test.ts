
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { DLsiteApi } from '../../src/services/DLsiteApi';
import { HttpClient } from '../../src/infrastructure/HttpClient';
import type { DLsiteProductApiResponse, DLsiteReviewApiResponse } from '../../src/types/dlsite';

// Mock HttpClient
vi.mock('../../src/infrastructure/HttpClient', () => ({
    HttpClient: {
        getJsonViaCors: vi.fn(),
        isRateLimited: vi.fn().mockReturnValue(false),
    },
}));

describe('DLsiteApi', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('getProduct', () => {
        it('should return product when API returns valid data in parallel race', async () => {
            const mockProduct: Partial<DLsiteProductApiResponse> = {
                workno: 'RJ123456',
                work_name: 'Test Product',
            };

            // Mock getJsonViaCors to return a promise that resolves
            (HttpClient.getJsonViaCors as Mock).mockResolvedValue({
                data: [mockProduct],
                status: 200,
            });

            const result = await DLsiteApi.getProduct('RJ123456');

            expect(result).toEqual(mockProduct);
            // Verify at least one call was made
            expect(HttpClient.getJsonViaCors).toHaveBeenCalled();
            const calledUrls = (HttpClient.getJsonViaCors as Mock).mock.calls.map(c => c[0]);
            expect(calledUrls.some(url => url.includes('maniax/api/=/product.json'))).toBe(true);
        });

        it('should return null if all API calls fail', async () => {
            // Mock rejection
            (HttpClient.getJsonViaCors as Mock).mockRejectedValue(new Error('Not found'));

            const result = await DLsiteApi.getProduct('RJ000000');
            expect(result).toBeNull();
        });
    });

    describe('search', () => {
        it('should return list of products for keyword search', async () => {
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
                    params: expect.objectContaining({ keyword_work_name: 'imouto' })
                })
            );
        });
    });

    describe('getReviews', () => {
        it('should return review list', async () => {
            const mockReviewResponse: Partial<DLsiteReviewApiResponse> = {
                review_list: [
                    {
                        review_id: '1',
                        reviewer_name: 'User1',
                        star: 5,
                        comment: 'Great',
                        // ... other fields mocked as needed
                    } as any
                ],
                product_param: {
                    maker_id: 'RG1',
                } as any
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
    });
});
