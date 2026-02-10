import { getAxios } from './Client';
import type { ReviewListParams, ReviewListResponse, Work } from '../types/api';

export interface ReviewUpdateParams {
    work_id: number;
    rating?: number;
    review_text?: string;
    progress?: 'marked' | 'listening' | 'listened' | 'replay' | 'postponed';
    starOnly?: boolean;
    progressOnly?: boolean;
}

export interface ReviewData {
    rating: number;
    review_text: string;
    progress: string;
    updated_at: string;
}

export const ReviewApi = {
    async updateReview(params: ReviewUpdateParams): Promise<void> {
        const { work_id, ...rest } = params;
        const body = { work_id, ...rest };
        try {
            await getAxios().post('/api/review', body);
        } catch (err: unknown) {
            const status = (err as { response?: { status?: number } })?.response?.status;
            if (status === 404 || status === 405) {
                await getAxios().put('/api/review', body);
            } else {
                throw err;
            }
        }
    },

    async getWorkReview(workId: number): Promise<ReviewData | null> {
        const response = await getAxios().get(`/api/work/${workId}`);
        const work = response.data as Work;
        if (work?.userRating || work?.review_text) {
            return {
                rating: work.userRating || 0,
                review_text: work.review_text || '',
                progress: work.progress || '',
                updated_at: work.updated_at || '',
            };
        }
        return null;
    },

    async deleteReview(workId: number): Promise<void> {
        await getAxios().delete(`/api/review?work_id=${workId}`);
    },

    /**
     * List user's reviewed/marked works with optional progress filter.
     * GET /api/review?page=1&sort=desc&filter=marked
     */
    async getReviews(params?: ReviewListParams): Promise<ReviewListResponse> {
        const res = await getAxios().get<ReviewListResponse>('/api/review', {
            params: params as Record<string, unknown>
        });
        return res.data;
    },
};
