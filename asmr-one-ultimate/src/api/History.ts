import { getAxios } from './Client';
import type { HistoryParams, HistoryRecord } from '../types/api';

export const HistoryApi = {
    /**
     * Record or update playback history for a specific track.
     * Uses UPSERT - replaces existing record for same (user, work_id, file_index).
     */
    async recordHistory(params: HistoryParams): Promise<void> {
        await getAxios().put('/api/history', params);
    },

    /**
     * Get play history for a specific track by work ID and file index.
     */
    async getByWorkIdIndex(workId: number, fileIndex: number): Promise<HistoryRecord | null> {
        const res = await getAxios().get<HistoryRecord>('/api/history/getByWorkIdIndex', {
            params: { work_id: workId, file_index: fileIndex }
        });
        return res.data || null;
    },

    /**
     * Get recent play history grouped by work (most recent first).
     * Limit configured server-side via recentCount.
     */
    async getRecent(): Promise<HistoryRecord[]> {
        const res = await getAxios().get<HistoryRecord[]>('/api/history/recent');
        return res.data || [];
    },

    /**
     * Delete all play history for the current user.
     */
    async deleteRecent(): Promise<void> {
        await getAxios().get('/api/history/deleteRecent');
    },
};
