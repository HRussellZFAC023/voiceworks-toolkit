import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAxios = {
    get: vi.fn(),
    put: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
};

vi.mock('../../src/api/Client', () => ({
    getAxios: vi.fn(() => mockAxios),
}));

import { ReviewApi } from '../../src/api/Review';

describe('ReviewApi', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('updateReview', () => {
        it('should try PUT first', async () => {
            mockAxios.put.mockResolvedValue({});
            await ReviewApi.updateReview({ work_id: 123, progress: 'listening', progressOnly: true });
            expect(mockAxios.put).toHaveBeenCalledWith('/api/review', {
                work_id: 123,
                progress: 'listening',
                progressOnly: true,
            });
            expect(mockAxios.post).not.toHaveBeenCalled();
        });

        it('should fallback to POST on 404', async () => {
            mockAxios.put.mockRejectedValue({ response: { status: 404 } });
            mockAxios.post.mockResolvedValue({});
            await ReviewApi.updateReview({ work_id: 123, progress: 'listened', progressOnly: true });
            expect(mockAxios.put).toHaveBeenCalled();
            expect(mockAxios.post).toHaveBeenCalledWith('/api/review', expect.objectContaining({ work_id: 123 }));
        });

        it('should fallback to POST on 405', async () => {
            mockAxios.put.mockRejectedValue({ response: { status: 405 } });
            mockAxios.post.mockResolvedValue({});
            await ReviewApi.updateReview({ work_id: 456, progress: 'marked', progressOnly: true });
            expect(mockAxios.post).toHaveBeenCalled();
        });

        it('should try per-work POST endpoint as third strategy', async () => {
            mockAxios.put.mockRejectedValue({ response: { status: 404 } });
            mockAxios.post
                .mockRejectedValueOnce({ response: { status: 404 } })  // first POST fails
                .mockResolvedValueOnce({});  // per-work POST succeeds
            await ReviewApi.updateReview({ work_id: 789, progress: 'replay', progressOnly: true });
            expect(mockAxios.post).toHaveBeenCalledWith('/api/work/789/review', expect.anything());
        });

        it('should stop on 500 error without trying more strategies', async () => {
            mockAxios.put.mockRejectedValue({ response: { status: 500 } });
            await ReviewApi.updateReview({ work_id: 123, progress: 'listening', progressOnly: true });
            // Should not try POST after a 500
            expect(mockAxios.post).not.toHaveBeenCalled();
        });
    });

    describe('getWorkReview', () => {
        it('should return review data when present', async () => {
            mockAxios.get.mockResolvedValue({
                data: { userRating: 4, review_text: 'Great', progress: 'listened', updated_at: '2024-01-01' },
            });
            const result = await ReviewApi.getWorkReview(123);
            expect(result).toEqual({
                rating: 4,
                review_text: 'Great',
                progress: 'listened',
                updated_at: '2024-01-01',
            });
        });

        it('should return null when no review data', async () => {
            mockAxios.get.mockResolvedValue({ data: { id: 123, title: 'Work' } });
            const result = await ReviewApi.getWorkReview(123);
            expect(result).toBeNull();
        });

        it('should return null on error', async () => {
            mockAxios.get.mockRejectedValue(new Error('Network error'));
            const result = await ReviewApi.getWorkReview(123);
            expect(result).toBeNull();
        });

        it('should handle work with only progress set', async () => {
            mockAxios.get.mockResolvedValue({ data: { progress: 'marked' } });
            const result = await ReviewApi.getWorkReview(123);
            expect(result).not.toBeNull();
            expect(result!.progress).toBe('marked');
            expect(result!.rating).toBe(0);
        });
    });

    describe('deleteReview', () => {
        it('should DELETE review by work ID', async () => {
            mockAxios.delete.mockResolvedValue({});
            await ReviewApi.deleteReview(123);
            expect(mockAxios.delete).toHaveBeenCalledWith('/api/review?work_id=123');
        });

        it('should fallback to per-work delete on error', async () => {
            mockAxios.delete
                .mockRejectedValueOnce(new Error('Not found'))
                .mockResolvedValueOnce({});
            await ReviewApi.deleteReview(456);
            expect(mockAxios.delete).toHaveBeenCalledWith('/api/work/456/review');
        });
    });

    describe('getReviews', () => {
        it('should GET reviews list', async () => {
            mockAxios.get.mockResolvedValue({ data: [{ id: 1 }] });
            const result = await ReviewApi.getReviews({ page: 1 });
            expect(mockAxios.get).toHaveBeenCalledWith('/api/review', { params: { page: 1 } });
            expect(result).toEqual([{ id: 1 }]);
        });
    });
});
