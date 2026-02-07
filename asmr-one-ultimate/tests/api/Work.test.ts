import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAxios = {
    get: vi.fn(),
};

vi.mock('../../src/api/Client', () => ({
    getAxios: vi.fn(() => mockAxios),
}));

// Mock WorkService for getWork
vi.mock('../../src/services/WorkService', () => ({
    WorkService: {
        getWork: vi.fn(),
    },
}));

import { WorkApi } from '../../src/api/Work';
import { WorkService } from '../../src/services/WorkService';

describe('WorkApi', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('getWork', () => {
        it('should delegate to WorkService', async () => {
            const mockWork = { id: 123, title: 'Test Work' };
            (WorkService.getWork as ReturnType<typeof vi.fn>).mockResolvedValue(mockWork);

            const result = await WorkApi.getWork(123);
            expect(WorkService.getWork).toHaveBeenCalledWith(123);
            expect(result).toEqual(mockWork);
        });
    });

    describe('getWorkInfo', () => {
        it('should GET work info by ID', async () => {
            mockAxios.get.mockResolvedValue({ data: { id: 123, title: 'Info' } });
            const result = await WorkApi.getWorkInfo(123);
            expect(mockAxios.get).toHaveBeenCalledWith('/api/workInfo/123');
            expect(result).toEqual({ id: 123, title: 'Info' });
        });

        it('should handle string ID', async () => {
            mockAxios.get.mockResolvedValue({ data: { id: 456 } });
            await WorkApi.getWorkInfo('456');
            expect(mockAxios.get).toHaveBeenCalledWith('/api/workInfo/456');
        });
    });

    describe('getTracks', () => {
        it('should GET tracks by ID with v=2', async () => {
            const tracks = [{ type: 'audio', title: 'track1.mp3' }];
            mockAxios.get.mockResolvedValue({ data: tracks });
            const result = await WorkApi.getTracks(123);
            expect(mockAxios.get).toHaveBeenCalledWith('/api/tracks/123?v=2');
            expect(result).toEqual(tracks);
        });
    });
});
