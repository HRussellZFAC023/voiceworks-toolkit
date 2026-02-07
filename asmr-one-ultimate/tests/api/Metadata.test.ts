import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAxios = {
    get: vi.fn(),
};

vi.mock('../../src/api/Client', () => ({
    getAxios: vi.fn(() => mockAxios),
}));

import { MetadataApi } from '../../src/api/Metadata';

describe('MetadataApi', () => {
    beforeEach(() => {
        // resetAllMocks clears implementations (mockRejectedValue, etc.), not just call history
        mockAxios.get.mockReset();
        MetadataApi.clearCache();
    });

    describe('getLabels', () => {
        it('should fetch tags from API', async () => {
            mockAxios.get.mockResolvedValue({ data: [{ id: 1, name: 'ASMR' }] });
            const tags = await MetadataApi.getTagList();
            expect(mockAxios.get).toHaveBeenCalledWith('/api/tags');
            expect(tags).toEqual([{ id: 1, name: 'ASMR' }]);
        });

        it('should cache results on subsequent calls', async () => {
            mockAxios.get.mockResolvedValue({ data: [{ id: 1, name: 'ASMR' }] });
            await MetadataApi.getTagList();
            await MetadataApi.getTagList();
            expect(mockAxios.get).toHaveBeenCalledTimes(1);
        });

        it('should return empty array when API returns non-array', async () => {
            mockAxios.get.mockResolvedValue({ data: 'not an array' });
            const result = await MetadataApi.getTagList();
            expect(result).toEqual([]);
        });

        it('should return empty array on API failure with no cache', async () => {
            mockAxios.get.mockRejectedValue(new Error('Network error'));
            const result = await MetadataApi.getTagList();
            expect(result).toEqual([]);
        });

        it('should return cached data on API failure', async () => {
            mockAxios.get.mockResolvedValueOnce({ data: [{ id: 1, name: 'Cached' }] });
            await MetadataApi.getTagList();

            // Expire cache
            MetadataApi.clearCache();
            // Re-populate cache
            mockAxios.get.mockResolvedValueOnce({ data: [{ id: 1, name: 'Fresh' }] });
            await MetadataApi.getTagList();

            // Next call fails — should return cached 'Fresh'
            mockAxios.get.mockRejectedValueOnce(new Error('fail'));
            // But cache is still valid (within TTL), so it returns cached
            const result = await MetadataApi.getTagList();
            expect(result).toEqual([{ id: 1, name: 'Fresh' }]);
        });
    });

    describe('getVAList', () => {
        it('should fetch VAs', async () => {
            mockAxios.get.mockResolvedValueOnce({ data: [{ id: 1, name: 'VA1' }] });
            const vas = await MetadataApi.getVAList();
            expect(mockAxios.get).toHaveBeenCalledWith('/api/vas');
            expect(vas).toHaveLength(1);
        });
    });

    describe('getCircleList', () => {
        it('should fetch circles', async () => {
            mockAxios.get.mockResolvedValue({ data: [{ id: 1, name: 'Circle1' }] });
            const circles = await MetadataApi.getCircleList();
            expect(mockAxios.get).toHaveBeenCalledWith('/api/circles');
            expect(circles).toHaveLength(1);
        });
    });

    describe('searchVAs', () => {
        beforeEach(() => {
            mockAxios.get.mockResolvedValue({
                data: [
                    { id: 1, name: 'Alice' },
                    { id: 2, name: 'Bob' },
                    { id: 3, name: 'Alicia' },
                ],
            });
        });

        it('should filter by query (case insensitive)', async () => {
            const result = await MetadataApi.searchVAs('ali');
            expect(result.items).toHaveLength(2);
            expect(result.items.map((v: any) => v.name)).toContain('Alice');
            expect(result.items.map((v: any) => v.name)).toContain('Alicia');
        });

        it('should return all when query is empty', async () => {
            const result = await MetadataApi.searchVAs('');
            expect(result.total).toBe(3);
        });

        it('should paginate results', async () => {
            const result = await MetadataApi.searchVAs('', 1, 2);
            expect(result.items).toHaveLength(2);
            expect(result.hasMore).toBe(true);
        });

        it('should return hasMore=false on last page', async () => {
            const result = await MetadataApi.searchVAs('', 2, 2);
            expect(result.items).toHaveLength(1);
            expect(result.hasMore).toBe(false);
        });
    });

    describe('searchCircles', () => {
        beforeEach(() => {
            mockAxios.get.mockResolvedValue({
                data: [
                    { id: 1, name: 'PEACHY' },
                    { id: 2, name: 'Cotton Soft' },
                ],
            });
        });

        it('should filter circles by query', async () => {
            const result = await MetadataApi.searchCircles('peach');
            expect(result.items).toHaveLength(1);
            expect(result.items[0].name).toBe('PEACHY');
        });

        it('should return all when query is empty', async () => {
            const result = await MetadataApi.searchCircles('');
            expect(result.total).toBe(2);
        });
    });

    describe('clearCache', () => {
        it('should force re-fetch after clearing', async () => {
            mockAxios.get.mockResolvedValue({ data: [{ id: 1, name: 'V1' }] });
            await MetadataApi.getTagList();
            MetadataApi.clearCache();
            mockAxios.get.mockResolvedValue({ data: [{ id: 2, name: 'V2' }] });
            const result = await MetadataApi.getTagList();
            expect(result).toEqual([{ id: 2, name: 'V2' }]);
            expect(mockAxios.get).toHaveBeenCalledTimes(2);
        });
    });
});
