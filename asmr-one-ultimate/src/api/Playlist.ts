import { getAxios } from './Client';
import { Logger } from '../core/Utils';

export interface CreatePlaylistRequest {
    name: string;
    description?: string;
    privacy: 0 | 1 | 2; // 0 = private, 1 = unlisted, 2 = public
    works: string[]; // Array of RJ codes like "RJ123456"
    locale?: string;
}

export interface CreatePlaylistResponse {
    id: string;
    name: string;
    description?: string;
    privacy: number;
    works: string[];
}

export interface PlaylistEntry {
    id: string;
    name: string;
    description?: string;
    privacy: number;
    works: string[];
    user_name?: string;
    worksCount?: number;
    works_count?: number; // API returns snake_case
    mainCoverUrl?: string;
    created_at?: string;
    updated_at?: string;
}

export interface PlaylistWithWorks extends PlaylistEntry {
    workDetails?: any[]; // Detailed work info when fetched
}

export interface PlaylistMetadata {
    id: string;
    name: string;
    description?: string;
    privacy: number;
    works: Array<{ id: number; source_id: string } | string>;
    works_count?: number;
    user_name?: string;
    created_at?: string;
    updated_at?: string;
}

/** Work item in playlist works response */
export interface PlaylistWorkItem {
    id: number;
    source_id: string;
    title: string;
    mainCoverUrl?: string;
    [key: string]: unknown;
}

export interface PlaylistWorksResponse {
    works: PlaylistWorkItem[];
    pagination?: { currentPage: number; pageSize: number; totalCount: number };
}


export const PlaylistApi = {
    /**
     * Create a new playlist on ASMR.one
     */
    async createPlaylist(data: CreatePlaylistRequest): Promise<CreatePlaylistResponse> {
        const axios = getAxios();
        const res = await axios.post('/api/playlist/create-playlist', {
            name: data.name,
            description: data.description || '',
            privacy: data.privacy,
            works: data.works,
            locale: data.locale || 'en',
        });
        return res.data as CreatePlaylistResponse;
    },

    /**
     * Get playlists for the current user via /api/playlist/get-playlists.
     * @param filterBy 'all' (owned + liked), 'liked', or 'owned'
     */
    async getPlaylists(
        filterBy: 'all' | 'liked' | 'owned' = 'all',
        page = 1,
        pageSize = 200,
    ): Promise<{ playlists: PlaylistEntry[]; pagination?: { page: number; pageSize: number; totalCount: number } }> {
        const axios = getAxios();
        const res = await axios.get('/api/playlist/get-playlists', {
            params: { filterBy, page, pageSize },
        });
        const data = (res.data || {}) as any;
        return {
            playlists: Array.isArray(data.playlists) ? data.playlists : Array.isArray(data) ? data : [],
            pagination: data.pagination,
        };
    },


    /**
     * Get a specific playlist by ID
     */
    async getPlaylist(id: string): Promise<PlaylistWithWorks> {
        const axios = getAxios();
        const res = await axios.get(`/api/playlist/${id}`);
        return res.data as PlaylistWithWorks;
    },

    /**
     * Add works to an existing playlist
     */
    async addWorks(playlistId: string, works: string[]): Promise<void> {
        const axios = getAxios();
        await axios.put(`/api/playlist/${playlistId}/works`, { works });
    },

    /**
     * Remove works from a playlist
     */
    async removeWorks(playlistId: string, works: string[]): Promise<void> {
        const axios = getAxios();
        await axios.delete(`/api/playlist/${playlistId}/works`, { data: { works } });
    },

    /**
     * Delete a playlist
     */
    async deletePlaylist(id: string): Promise<void> {
        const axios = getAxios();
        await axios.delete(`/api/playlist/${id}`);
    },

    /**
     * Update playlist metadata (name, description, privacy)
     */
    async updatePlaylist(id: string, data: Partial<CreatePlaylistRequest>): Promise<PlaylistEntry> {
        const axios = getAxios();
        const res = await axios.put(`/api/playlist/${id}`, data);
        return res.data as PlaylistEntry;
    },

    /**
     * Get playlist metadata including work list
     * Uses the get-playlist-metadata endpoint which returns work details
     */
    async getPlaylistMetadata(id: string): Promise<PlaylistMetadata> {
        const axios = getAxios();
        const res = await axios.get('/api/playlist/get-playlist-metadata', { params: { id } });
        return res.data as PlaylistMetadata;
    },

    /**
     * Get playlist works with pagination.
     * Fetches all pages to build the complete work list.
     */
    async getPlaylistWorks(id: string, page = 1, pageSize = 100): Promise<PlaylistWorksResponse> {
        const axios = getAxios();
        const res = await axios.get('/api/playlist/get-playlist-works', {
            params: { id, page, pageSize },
        });
        // Normalize response - ensure works is always an array
        const data = (res.data || {}) as any;
        return {
            works: Array.isArray(data.works) ? data.works : [],
            pagination: data.pagination,
        };
    },

    /**
     * Fetch all works from a playlist across all pages.
     */
    async getAllPlaylistWorks(id: string): Promise<PlaylistWorkItem[]> {
        const pageSize = 100;
        const batchSize = 20;
        Logger.debug(`[PlaylistApi] Fetching all works for playlist: ${id}`);

        let firstPage: PlaylistWorksResponse;
        try {
            firstPage = await this.getPlaylistWorks(id, 1, pageSize);
        } catch (error) {
            Logger.error(`[PlaylistApi] Failed to fetch first page of playlist ${id}:`, error);
            throw error;
        }

        const allWorks = [...(firstPage.works || [])];
        const totalCount = firstPage.pagination?.totalCount ?? allWorks.length;
        const totalPages = Math.ceil(totalCount / pageSize);

        if (totalPages > 1) {
            Logger.debug(`[PlaylistApi] Playlist ${id} has ${totalCount} works across ${totalPages} pages. Fetching remaining pages...`);

            const pages: number[] = [];
            for (let page = 2; page <= totalPages; page++) {
                pages.push(page);
            }

            const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

            for (let i = 0; i < pages.length; i += batchSize) {
                const batch = pages.slice(i, i + batchSize);
                const results = await Promise.allSettled(
                    batch.map(async (page) => {
                        const nextPage = await this.getPlaylistWorks(id, page, pageSize);
                        return { page, works: nextPage.works || [] };
                    })
                );

                let hadError = false;
                let rateLimited = false;
                results.forEach((result, index) => {
                    if (result.status === 'fulfilled') {
                        if (result.value.works.length) {
                            allWorks.push(...result.value.works);
                        }
                    } else {
                        hadError = true;
                        const status = (result.reason as any)?.response?.status || (result.reason as any)?.status;
                        if (status === 429) rateLimited = true;
                        Logger.error(`[PlaylistApi] Error fetching page ${batch[index]} of playlist ${id}:`, result.reason);
                    }
                });

                const fetchedPages = Math.min(i + batchSize, pages.length);
                Logger.debug(`[PlaylistApi] Fetched ${allWorks.length}/${totalCount} works... (${fetchedPages}/${pages.length} pages)`);

                // Delay between batches to reduce rate limiting risk.
                if (i + batchSize < pages.length) {
                    await delay(rateLimited ? 1500 : hadError ? 750 : 200);
                }
            }
        }

        Logger.debug(`[PlaylistApi] Successfully fetched ${allWorks.length} works for playlist ${id}`);
        return allWorks;
    },
};
