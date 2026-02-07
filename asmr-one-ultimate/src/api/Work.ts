import { WorkService } from '../services/WorkService';
import { Work, WorkInfo, TracksResponse } from '../types/api';
import { getAxios } from './Client';

export interface WorkDetails extends Work {
    // Legacy support
    [key: string]: any;
}

export const WorkApi = {
    async getWork(id: string | number): Promise<WorkDetails> {
        return await WorkService.getWork(id) as WorkDetails;
    },

    /**
     * Get public work info (no user data)
     */
    async getWorkInfo(id: string | number): Promise<WorkInfo> {
        const axios = getAxios();
        const res = await axios.get<WorkInfo>(`/api/workInfo/${id}`);
        return res.data;
    },

    /**
     * Get track/file tree structure
     */
    async getTracks(id: string | number): Promise<TracksResponse> {
        const axios = getAxios();
        const res = await axios.get<TracksResponse>(`/api/tracks/${id}?v=2`);
        return res.data;
    }
};
