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
    /** Results per page. The API clamps its own maximum. */
    pageSize?: number;
    /** Alias accepted by some deployments; sent alongside pageSize. */
    limit?: number;
    sort?: 'desc' | 'asc';
    order?: WorkOrder;
    seed?: number;
    tags?: string; // Comma separated IDs
    exclude_tags?: string; // Comma separated IDs
    query?: string; // Search query (title, circle, VA name)
}

/** Largest page the API is asked for; it may still return fewer. */
export const WORKS_MAX_PAGE_SIZE = 100;

/**
 * Total results reported by the API, falling back to what actually arrived so
 * callers never advertise a total smaller than the rows they are showing.
 */
export function readWorksTotalCount(response: WorksResponse, alreadyLoaded = 0): number {
    const total = Number(response?.pagination?.totalCount);
    const loaded = alreadyLoaded + (response?.works?.length ?? 0);
    return Number.isSafeInteger(total) && total >= 0 ? Math.max(total, loaded) : loaded;
}

/** True when another page is worth requesting. */
export function hasMoreWorkPages(response: WorksResponse, loadedCount: number): boolean {
    if (!response?.works?.length) return false;
    const total = Number(response?.pagination?.totalCount);
    if (!Number.isSafeInteger(total) || total < 0) {
        // Some mirrors omit pagination entirely (and may clamp a requested
        // 100-row page to a smaller server default). Keep manual paging
        // available until the server returns an empty page.
        return true;
    }
    return loadedCount < readWorksTotalCount(response, loadedCount - response.works.length);
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
