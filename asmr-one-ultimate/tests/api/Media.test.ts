import { describe, it, expect, vi } from 'vitest';

// Mock the Client module
vi.mock('../../src/api/Client', () => ({
    getAxios: vi.fn(() => ({
        get: vi.fn().mockResolvedValue({ data: { result: true, hash: 'abc123' } }),
    })),
}));

import { MediaApi } from '../../src/api/Media';

describe('MediaApi', () => {
    describe('getStreamUrl', () => {
        it('should build correct stream URL', () => {
            expect(MediaApi.getStreamUrl(123, 0)).toBe('/api/media/stream/123/0');
            expect(MediaApi.getStreamUrl(456, 5)).toBe('/api/media/stream/456/5');
        });
    });

    describe('getDownloadUrl', () => {
        it('should build correct download URL', () => {
            expect(MediaApi.getDownloadUrl(123, 0)).toBe('/api/media/download/123/0');
            expect(MediaApi.getDownloadUrl(789, 3)).toBe('/api/media/download/789/3');
        });
    });

    describe('checkLrc', () => {
        it('should fetch LRC check result', async () => {
            const result = await MediaApi.checkLrc(123, 0);
            expect(result).toEqual({ result: true, hash: 'abc123' });
        });
    });
});
