import { getAxios } from './Client';
import { WorkDetails } from './Work';
import { HttpClient } from '../infrastructure/HttpClient';
import { DEFAULT_API_SERVER, RETRY } from '../core/Constants';

export interface WorksResponse {
    works: WorkDetails[];
    pagination: {
        currentPage: number;
        pageSize: number;
        totalCount: number;
    };
}

export type WorkOrder =
    | 'id'
    | 'release'
    | 'rating'
    | 'dl_count'
    | 'review_count'
    | 'price'
    | 'rate_average_2dp'
    | 'nsfw'
    | 'insert_time'
    | 'create_date'
    | 'random'
    | 'betterRandom';

export interface WorksParams {
    page?: number;
    sort?: 'desc' | 'asc';
    order?: WorkOrder;
    seed?: number;
    tags?: string; // Comma separated IDs
    exclude_tags?: string; // Comma separated IDs
    query?: string; // Search query (title, circle, VA name)
}

/**
 * Get the API base URL from the host app's axios defaults (set by the "Select server" setting).
 * Falls back to default API server if axios is not yet initialized.
 */
function getApiBaseUrl(): string {
    // Read from the host app's axios baseURL (set by "Select server" setting)
    try {
        const axios = getAxios();
        const baseURL = axios?.defaults?.baseURL;
        if (baseURL && baseURL.startsWith('http')) {
            return baseURL.replace(/\/$/, '');
        }
    } catch {
        // Ignore - axios may not be ready
    }
    
    // Fallback to default API server
    return DEFAULT_API_SERVER;
}

export const WorksApi = {
    async getWorks(params?: WorksParams): Promise<WorksResponse> {
        const baseUrl = getApiBaseUrl();
        const url = `${baseUrl}/api/works`;
        const response = await HttpClient.getJsonViaCors<WorksResponse>(url, {
            params: params as Record<string, string | number | boolean | undefined>,
            retry: RETRY.API_JSON,
        });
        return response.data;
    },

    async searchWorks(keyword: string, params?: WorksParams): Promise<WorksResponse> {
        const baseUrl = getApiBaseUrl();
        const url = `${baseUrl}/api/search/${encodeURIComponent(keyword)}`;
        const response = await HttpClient.getJsonViaCors<WorksResponse>(url, {
            params: params as Record<string, string | number | boolean | undefined>,
            retry: RETRY.API_JSON,
        });
        return response.data;
    },

    /**
     * Get works by Voice Actor (VA) ID
     */
    async getWorksByVA(vaId: number | string, params?: Omit<WorksParams, 'query'>): Promise<WorksResponse> {
        const baseUrl = getApiBaseUrl();
        const url = `${baseUrl}/api/vas/${vaId}/works`;
        const response = await HttpClient.getJsonViaCors<WorksResponse>(url, {
            params: params as Record<string, string | number | boolean | undefined>,
            retry: RETRY.API_JSON,
        });
        return response.data;
    },

    /**
     * Get works by Circle ID
     */
    async getWorksByCircle(circleId: number | string, params?: Omit<WorksParams, 'query'>): Promise<WorksResponse> {
        const baseUrl = getApiBaseUrl();
        const url = `${baseUrl}/api/circles/${circleId}/works`;
        const response = await HttpClient.getJsonViaCors<WorksResponse>(url, {
            params: params as Record<string, string | number | boolean | undefined>,
            retry: RETRY.API_JSON,
        });
        return response.data;
    },

    /**
     * Get works by Tag ID
     */
    async getWorksByTag(tagId: number | string, params?: Omit<WorksParams, 'tags'>): Promise<WorksResponse> {
        const baseUrl = getApiBaseUrl();
        const url = `${baseUrl}/api/tags/${tagId}/works`;
        const response = await HttpClient.getJsonViaCors<WorksResponse>(url, {
            params: params as Record<string, string | number | boolean | undefined>,
            retry: RETRY.API_JSON,
        });
        return response.data;
    },
};
