import { getAxios } from './Client';
import type { ReviewUpdateParams, ReviewData } from '../types/api';
import { Logger } from '../core/Logger';

/**
 * ReviewApi - Handles interactions with the ASMR.one review and progress system.
 * 
 * Includes robust fallbacks for different site versions and API hosts.
 */
export const ReviewApi = {
    async updateReview(params: ReviewUpdateParams): Promise<void> {
        const { work_id, ...rest } = params;
        const payload = { work_id, ...rest };

        // Try multiple strategy patterns to satisfy different API versions
        // PUT is the correct method for kikoeru-express; POST is fallback for other hosts
        const strategies = [
            async () => getAxios().put('/api/review', payload),
            async () => getAxios().post('/api/review', payload),
            async () => getAxios().post(`/api/work/${work_id}/review`, payload),
        ];

        let lastError: any = null;
        for (const strategy of strategies) {
            try {
                await strategy();
                return; // Success
            } catch (error: any) {
                lastError = error;
                const status = error?.response?.status;
                // If it's a 404 or 405, try the next strategy
                if (status === 404 || status === 405) continue;
                // For other errors (401, 500), stop and throw
                break;
            }
        }

        Logger.warn(`[ReviewApi] All update strategies failed for ${work_id}`, lastError);
    },

    async getWorkReview(workId: number | string): Promise<ReviewData | null> {
        try {
            const response = await getAxios().get(`/api/work/${workId}`);
            const work = response.data as Record<string, any>;
            if (work?.userRating || work?.review_text || work?.progress) {
                return {
                    rating: work.userRating || 0,
                    review_text: work.review_text || '',
                    progress: work.progress || '',
                    updated_at: work.updated_at || '',
                };
            }
        } catch (e) {
            Logger.debug(`[ReviewApi] Failed to fetch review for ${workId}`, e);
        }
        return null;
    },

    async deleteReview(workId: number | string): Promise<void> {
        try {
            await getAxios().delete(`/api/review?work_id=${workId}`);
        } catch (e) {
            // Fallback to per-work delete if global delete fails
            await getAxios().delete(`/api/work/${workId}/review`).catch(fallbackErr => {
                Logger.warn(`[ReviewApi] All delete strategies failed for ${workId}`, fallbackErr);
            });
        }
    },

    /**
     * List user's reviewed/marked works.
     */
    async getReviews(params?: any): Promise<any> {
        const res = await getAxios().get('/api/review', { params });
        return res.data;
    },
};
