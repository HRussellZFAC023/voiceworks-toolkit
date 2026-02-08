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
        it('should try POST first', async () => {
            mockAxios.post.mockResolvedValue({});
            await ReviewApi.updateReview({ work_id: 123, progress: 'listening', progressOnly: true });
            expect(mockAxios.post).toHaveBeenCalledWith('/api/review', {
                work_id: 123,
                progress: 'listening',
                progressOnly: true,
            });
            expect(mockAxios.put).not.toHaveBeenCalled();
        });

        it('should fallback to PUT on 404', async () => {
            mockAxios.post.mockRejectedValue({ response: { status: 404 } });
            mockAxios.put.mockResolvedValue({});
            await ReviewApi.updateReview({ work_id: 123, progress: 'listened', progressOnly: true });
            expect(mockAxios.post).toHaveBeenCalled();
            expect(mockAxios.put).toHaveBeenCalledWith('/api/review', {
                work_id: 123,
                progress: 'listened',
                progressOnly: true,
            });
        });

        it('should fallback to PUT on 405', async () => {
            mockAxios.post.mockRejectedValue({ response: { status: 405 } });
            mockAxios.put.mockResolvedValue({});
            await ReviewApi.updateReview({ work_id: 456, progress: 'marked', progressOnly: true });
            expect(mockAxios.put).toHaveBeenCalled();
        });

        it('should only have two strategies (POST then PUT)', async () => {
            mockAxios.post.mockRejectedValue({ response: { status: 404 } });
            mockAxios.put.mockRejectedValue({ response: { status: 404 } });
            await expect(ReviewApi.updateReview({ work_id: 789, progress: 'replay' }))
                .rejects.toEqual({ response: { status: 404 } });
            expect(mockAxios.post).toHaveBeenCalledTimes(1);
            expect(mockAxios.put).toHaveBeenCalledTimes(1);
        });

        it('should stop on 500 error without trying PUT fallback', async () => {
            mockAxios.post.mockRejectedValue({ response: { status: 500 } });
            await expect(ReviewApi.updateReview({ work_id: 123, progress: 'listening' }))
                .rejects.toEqual({ response: { status: 500 } });
            // Should not try PUT after a 500
            expect(mockAxios.put).not.toHaveBeenCalled();
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

        it('should throw on error', async () => {
            mockAxios.get.mockRejectedValue(new Error('Network error'));
            await expect(ReviewApi.getWorkReview(123)).rejects.toThrow('Network error');
        });

        it('should return null when work has only progress set', async () => {
            mockAxios.get.mockResolvedValue({ data: { progress: 'marked' } });
            const result = await ReviewApi.getWorkReview(123);
            // Only userRating or review_text trigger a non-null return
            expect(result).toBeNull();
        });
    });

    describe('deleteReview', () => {
        it('should DELETE review by work ID', async () => {
            mockAxios.delete.mockResolvedValue({});
            await ReviewApi.deleteReview(123);
            expect(mockAxios.delete).toHaveBeenCalledWith('/api/review?work_id=123');
        });

        it('should throw on error (no fallback)', async () => {
            mockAxios.delete.mockRejectedValue(new Error('Not found'));
            await expect(ReviewApi.deleteReview(456)).rejects.toThrow('Not found');
            expect(mockAxios.delete).toHaveBeenCalledTimes(1);
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
