import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockAxios = {
    get: vi.fn(),
};

vi.mock('../../src/api/Client', () => ({
    getAxios: vi.fn(() => mockAxios),
}));

import { MetadataApi, MetadataRequestTimeoutError } from '../../src/api/Metadata';

describe('MetadataApi', () => {
    beforeEach(() => {
        // resetAllMocks clears implementations (mockRejectedValue, etc.), not just call history
        mockAxios.get.mockReset();
        MetadataApi.clearCache();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('getLabels', () => {
        it('should fetch tags from API', async () => {
            mockAxios.get.mockResolvedValue({ data: [{ id: 1, name: 'ASMR' }] });
            const tags = await MetadataApi.getTagList();
            expect(mockAxios.get).toHaveBeenCalledWith('/api/tags/', expect.anything());
            expect(tags).toEqual([{ id: 1, name: 'ASMR' }]);
        });

        it('should cache results on subsequent calls', async () => {
            mockAxios.get.mockResolvedValue({ data: [{ id: 1, name: 'ASMR' }] });
            await MetadataApi.getTagList();
            await MetadataApi.getTagList();
            expect(mockAxios.get).toHaveBeenCalledOnce();
            expect(mockAxios.get).toHaveBeenCalledWith('/api/tags/', expect.anything());
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

        it('should not reject when the host bridge is unavailable', async () => {
            mockAxios.get.mockImplementation(() => { throw new Error('Bridge not initialized'); });
            await expect(MetadataApi.getTagList()).resolves.toEqual([]);
        });
    });

    describe('fetchLabels terminal outcomes', () => {
        it('reports a network failure instead of silently returning empty', async () => {
            const failure = new Error('Network error');
            mockAxios.get.mockRejectedValue(failure);
            const result = await MetadataApi.fetchTagList();
            expect(result.items).toEqual([]);
            expect(result.error).toBe(failure);
            expect(result.fromCache).toBe(false);
        });

        it('reports an empty success as a non-error outcome', async () => {
            mockAxios.get.mockResolvedValue({ data: [] });
            const result = await MetadataApi.fetchVAList();
            expect(result.items).toEqual([]);
            expect(result.error).toBeNull();
        });

        it('does NOT cache an empty success, so the next call retries the network', async () => {
            // Regression: an empty response used to be cached for the full TTL,
            // which turned every later retry into a silent no-op.
            mockAxios.get.mockResolvedValueOnce({ data: [] });
            expect((await MetadataApi.fetchTagList()).items).toEqual([]);

            mockAxios.get.mockResolvedValueOnce({ data: [{ id: 1, name: 'ASMR' }] });
            const second = await MetadataApi.fetchTagList();

            expect(mockAxios.get).toHaveBeenCalledTimes(2);
            expect(second.items).toEqual([{ id: 1, name: 'ASMR' }]);
        });

        it('does NOT cache a failure, so the next call retries the network', async () => {
            mockAxios.get.mockRejectedValueOnce(new Error('boom'));
            expect((await MetadataApi.fetchCircleList()).error).toBeInstanceOf(Error);

            mockAxios.get.mockResolvedValueOnce({ data: [{ id: 9, name: 'Circle' }] });
            const second = await MetadataApi.fetchCircleList();

            expect(mockAxios.get).toHaveBeenCalledTimes(2);
            expect(second.items).toHaveLength(1);
            expect(second.error).toBeNull();
        });

        it('prefers known-good cached data over a later empty response', async () => {
            mockAxios.get.mockResolvedValueOnce({ data: [{ id: 1, name: 'Good' }] });
            await MetadataApi.fetchTagList();

            mockAxios.get.mockResolvedValueOnce({ data: [] });
            const forced = await MetadataApi.fetchTagList({ force: true });
            expect(forced.items).toEqual([{ id: 1, name: 'Good' }]);
            expect(forced.fromCache).toBe(true);
            expect(forced.error).toBeNull();
        });

        it('shares a single in-flight request between concurrent callers', async () => {
            let resolveGet: (value: unknown) => void = () => undefined;
            mockAxios.get.mockReturnValue(new Promise((resolve) => { resolveGet = resolve; }));

            const a = MetadataApi.fetchTagList();
            const b = MetadataApi.fetchTagList();
            resolveGet({ data: [{ id: 1, name: 'ASMR' }] });

            const [ra, rb] = await Promise.all([a, b]);
            expect(mockAxios.get).toHaveBeenCalledTimes(1);
            expect(ra.items).toEqual(rb.items);
        });
    });

    describe('request timeout', () => {
        it('settles with a timeout error when the request never resolves', async () => {
            vi.useFakeTimers();
            mockAxios.get.mockReturnValue(new Promise(() => { /* never settles */ }));

            const pending = MetadataApi.fetchTagList({ timeoutMs: 1000 });
            await vi.advanceTimersByTimeAsync(1500);
            const result = await pending;

            expect(result.error).toBeInstanceOf(MetadataRequestTimeoutError);
            expect(result.items).toEqual([]);
        });

        it('aborts the underlying request when the timeout wins', async () => {
            vi.useFakeTimers();
            let capturedSignal: AbortSignal | undefined;
            mockAxios.get.mockImplementation((_url: string, config?: { signal?: AbortSignal }) => {
                capturedSignal = config?.signal;
                return new Promise(() => { /* never settles */ });
            });

            const pending = MetadataApi.fetchVAList({ timeoutMs: 500 });
            await vi.advanceTimersByTimeAsync(600);
            await pending;

            expect(capturedSignal?.aborted).toBe(true);
        });

        it('getLabels degrades a timeout to an empty array without rejecting', async () => {
            vi.useFakeTimers();
            mockAxios.get.mockReturnValue(new Promise(() => { /* never settles */ }));

            const pending = MetadataApi.getCircleList();
            await vi.advanceTimersByTimeAsync(25000);

            await expect(pending).resolves.toEqual([]);
        });
    });

    describe('getVAList', () => {
        it('should fetch VAs', async () => {
            mockAxios.get.mockResolvedValueOnce({ data: [{ id: 1, name: 'VA1' }] });
            const vas = await MetadataApi.getVAList();
            expect(mockAxios.get).toHaveBeenCalledWith('/api/vas/', expect.anything());
            expect(vas).toHaveLength(1);
        });
    });

    describe('getCircleList', () => {
        it('should fetch circles', async () => {
            mockAxios.get.mockResolvedValue({ data: [{ id: 1, name: 'Circle1' }] });
            const circles = await MetadataApi.getCircleList();
            expect(mockAxios.get).toHaveBeenCalledWith('/api/circles/', expect.anything());
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

        it('can clear a single field', async () => {
            mockAxios.get.mockResolvedValue({ data: [{ id: 1, name: 'X' }] });
            await MetadataApi.getTagList();
            await MetadataApi.getVAList();
            expect(mockAxios.get).toHaveBeenCalledTimes(2);

            MetadataApi.clearCache('tags');
            await MetadataApi.getTagList();
            await MetadataApi.getVAList();
            expect(mockAxios.get).toHaveBeenCalledTimes(3);
        });
    });
});
