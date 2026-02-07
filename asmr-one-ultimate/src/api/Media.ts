import { getAxios } from './Client';
import type { LrcCheckResponse } from '../types/api';

export const MediaApi = {
    /**
     * Build the streaming URL for a track.
     * @param workId - Numeric work ID
     * @param trackIndex - Zero-based track index
     */
    getStreamUrl(workId: number, trackIndex: number): string {
        return `/api/media/stream/${workId}/${trackIndex}`;
    },

    /**
     * Build the download URL for a track.
     * @param workId - Numeric work ID
     * @param trackIndex - Zero-based track index
     */
    getDownloadUrl(workId: number, trackIndex: number): string {
        return `/api/media/download/${workId}/${trackIndex}`;
    },

    /**
     * Check if an LRC subtitle file exists for a track.
     * @returns result=true with hash if LRC exists, result=false otherwise
     */
    async checkLrc(workId: number, trackIndex: number): Promise<LrcCheckResponse> {
        const res = await getAxios().get<LrcCheckResponse>(
            `/api/media/check-lrc/${workId}/${trackIndex}`
        );
        return res.data;
    },
};
