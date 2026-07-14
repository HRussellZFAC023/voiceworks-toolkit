import { getAxios } from './Client';
import { TagEntry, VAEntry, CircleEntry } from '../types/api';

export interface LabelSearchResult<T> {
    items: T[];
    hasMore: boolean;
    total: number;
}

// Cache for labels to avoid repeated API calls
const labelCache: {
    tags?: TagEntry[];
    circles?: CircleEntry[];
    vas?: VAEntry[];
    timestamps: { [key: string]: number };
} = { timestamps: {} };

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export const MetadataApi = {
    /**
     * Get all labels for a field (with caching)
     */
    async getLabels<T extends TagEntry | VAEntry | CircleEntry>(field: 'tags' | 'circles' | 'vas'): Promise<T[]> {
        const now = Date.now();
        const cached = labelCache[field] as T[] | undefined;
        const timestamp = labelCache.timestamps[field] || 0;

        if (cached && (now - timestamp) < CACHE_TTL) {
            return cached;
        }

        try {
            const res = await getAxios().get(`/api/${field}/`);
            // Ensure we always return an array
            const data = Array.isArray(res.data) ? res.data as T[] : [];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic T can't narrow indexed field
            (labelCache as Record<string, unknown>)[field] = data;
            labelCache.timestamps[field] = now;
            return data;
        } catch (error) {
            // Return cached data if available, otherwise empty array
            if (cached) return cached;
            return [];
        }
    },

    async getTagList(): Promise<TagEntry[]> {
        return this.getLabels<TagEntry>('tags');
    },

    /**
     * Get all VAs (voice actors)
     */
    async getVAList(): Promise<VAEntry[]> {
        return this.getLabels<VAEntry>('vas');
    },

    /**
     * Get all circles
     */
    async getCircleList(): Promise<CircleEntry[]> {
        return this.getLabels<CircleEntry>('circles');
    },

    /**
     * Search VAs with filtering and pagination
     */
    async searchVAs(query: string, page = 1, pageSize = 50): Promise<LabelSearchResult<VAEntry>> {
        const allVAs = await this.getVAList();
        const needle = query.toLowerCase().trim();

        const filtered = needle
            ? allVAs.filter(va => va.name.toLowerCase().includes(needle))
            : allVAs;

        const offset = (page - 1) * pageSize;
        return {
            items: filtered.slice(offset, offset + pageSize),
            hasMore: filtered.length > offset + pageSize,
            total: filtered.length,
        };
    },

    /**
     * Search circles with filtering and pagination
     */
    async searchCircles(query: string, page = 1, pageSize = 50): Promise<LabelSearchResult<CircleEntry>> {
        const allCircles = await this.getCircleList();
        const needle = query.toLowerCase().trim();

        const filtered = needle
            ? allCircles.filter(c => c.name.toLowerCase().includes(needle))
            : allCircles;

        const offset = (page - 1) * pageSize;
        return {
            items: filtered.slice(offset, offset + pageSize),
            hasMore: filtered.length > offset + pageSize,
            total: filtered.length,
        };
    },

    /**
     * Clear the label cache (useful after data updates)
     */
    clearCache(): void {
        delete labelCache.tags;
        delete labelCache.circles;
        delete labelCache.vas;
        labelCache.timestamps = {};
    },
};
