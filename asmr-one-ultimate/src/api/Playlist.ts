import { getAxios } from './Client';

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
    works_count?: number;
    worksCount?: number;
    user_name?: string;
    created_at?: string;
    updated_at?: string;
}

export interface PlaylistWithWorks extends PlaylistEntry {
    workDetails?: PlaylistWorkItem[]; // Detailed work info when fetched
}

export interface PlaylistMetadata {
    id: string;
    name: string;
    description?: string;
    privacy: number;
    works: Array<PlaylistMetadataWorkItem | string>;
    works_count?: number;
    user_name?: string;
    created_at?: string;
    updated_at?: string;
    main_cover_url?: string;
    mainCoverUrl?: string;
    thumbnailCoverUrl?: string;
    samCoverUrl?: string;
    coverUrl?: string;
}

export interface PlaylistMetadataWorkItem {
    id?: number | string;
    source_id?: string;
    main_cover_url?: string;
    mainCoverUrl?: string;
    thumbnailCoverUrl?: string;
    samCoverUrl?: string;
    coverUrl?: string;
    cover?: string;
    [key: string]: unknown;
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
     * Get all playlists for the current user
     */
    async getPlaylists(): Promise<PlaylistEntry[]> {
        const axios = getAxios();
        const res = await axios.get('/api/playlists');
        return (res.data || []) as PlaylistEntry[];
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
        const data = (res.data || {}) as PlaylistWorksResponse;
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
        const firstPage = await this.getPlaylistWorks(id, 1, pageSize);
        const allWorks = [...(firstPage.works || [])];

        const totalCount = firstPage.pagination?.totalCount ?? allWorks.length;
        const totalPages = Math.ceil(totalCount / pageSize);

        for (let page = 2; page <= totalPages; page++) {
            const nextPage = await this.getPlaylistWorks(id, page, pageSize);
            if (nextPage.works?.length) {
                allWorks.push(...nextPage.works);
            }
        }

        return allWorks;
    },
};
