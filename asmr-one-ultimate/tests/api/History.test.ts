import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HistoryApi } from '../../src/api/History';

const mockGet = vi.fn();
const mockPut = vi.fn();

vi.mock('../../src/api/Client', () => ({
    getAxios: () => ({
        get: mockGet,
        put: mockPut,
    }),
}));

describe('HistoryApi', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('recordHistory', () => {
        it('should PUT to /api/history with params', async () => {
            mockPut.mockResolvedValue({});
            const params = {
                work_id: 123,
                file_index: 2,
                file_name: 'track.mp3',
                play_time: 45,
                total_time: 300,
            };
            await HistoryApi.recordHistory(params);
            expect(mockPut).toHaveBeenCalledWith('/api/history', params);
        });
    });

    describe('getByWorkIdIndex', () => {
        it('should GET /api/history/getByWorkIdIndex with query params', async () => {
            const record = { work_id: 123, file_index: 2, play_time: 45, total_time: 300 };
            mockGet.mockResolvedValue({ data: record });
            const result = await HistoryApi.getByWorkIdIndex(123, 2);
            expect(mockGet).toHaveBeenCalledWith('/api/history/getByWorkIdIndex', {
                params: { work_id: 123, file_index: 2 },
            });
            expect(result).toEqual(record);
        });

        it('should return null when no data', async () => {
            mockGet.mockResolvedValue({ data: null });
            const result = await HistoryApi.getByWorkIdIndex(123, 2);
            expect(result).toBeNull();
        });
    });

    describe('getRecent', () => {
        it('should GET /api/history/recent', async () => {
            const records = [{ work_id: 1 }, { work_id: 2 }];
            mockGet.mockResolvedValue({ data: records });
            const result = await HistoryApi.getRecent();
            expect(mockGet).toHaveBeenCalledWith('/api/history/recent');
            expect(result).toEqual(records);
        });

        it('should return empty array when no data', async () => {
            mockGet.mockResolvedValue({ data: null });
            const result = await HistoryApi.getRecent();
            expect(result).toEqual([]);
        });
    });

    describe('deleteRecent', () => {
        it('should GET /api/history/deleteRecent', async () => {
            mockGet.mockResolvedValue({});
            await HistoryApi.deleteRecent();
            expect(mockGet).toHaveBeenCalledWith('/api/history/deleteRecent');
        });
    });
});
