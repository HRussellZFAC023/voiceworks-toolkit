import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../src/infrastructure/HttpClient';

const { mockApiRequest } = vi.hoisted(() => ({
    mockApiRequest: vi.fn(),
}));

vi.mock('../../src/features/playlist/PlaylistService', () => ({
    apiRequest: (...args: unknown[]) => mockApiRequest(...args),
    getApiBaseUrl: () => 'https://api.asmr.one',
}));

import { PlaylistDiscoveryService } from '../../src/features/playlist/PlaylistDiscoveryService';

describe('PlaylistDiscoveryService cover resolution', () => {
    beforeEach(() => {
        mockApiRequest.mockReset();
        (PlaylistDiscoveryService as unknown as { instance?: PlaylistDiscoveryService }).instance = undefined;
    });

    it('fetches cover from playlist works when metadata endpoint has no cover fields', async () => {
        mockApiRequest.mockImplementation(async (endpoint: string) => {
            if (endpoint === '/api/playlist/get-playlist-metadata') {
                return {
                    id: 'Playlist-1',
                    name: 'Public Playlist',
                    user_name: 'Alice',
                    works_count: 12,
                    privacy: 2,
                };
            }
            if (endpoint === '/api/playlist/get-playlist-works') {
                return {
                    works: [
                        {
                            id: 1014447,
                            mainCoverUrl: 'https://api.asmr.one/api/cover/1014447.jpg?type=main',
                        },
                    ],
                };
            }
            throw new Error(`Unexpected endpoint: ${endpoint}`);
        });

        const service = PlaylistDiscoveryService.getInstance();
        const result = await service.fetchMetadata('Playlist-1');

        expect(result?.coverUrl).toBe('https://api.asmr.one/api/cover/1014447.jpg?type=main');
        expect(result?.latestWorkId).toBe(1014447);
        expect(mockApiRequest).toHaveBeenNthCalledWith(
            2,
            '/api/playlist/get-playlist-works',
            { id: 'playlist-1', page: 1, pageSize: 1 },
        );
    });

    it('uses top-level metadata cover when present without extra cover lookup request', async () => {
        mockApiRequest.mockResolvedValue({
            id: 'Playlist-2',
            name: 'With Cover',
            user_name: 'Bob',
            works_count: 3,
            privacy: 2,
            main_cover_url: 'https://cdn.example.com/cover.jpg',
            works: [],
        });

        const service = PlaylistDiscoveryService.getInstance();
        const result = await service.fetchMetadata('Playlist-2');

        expect(result?.coverUrl).toBe('https://cdn.example.com/cover.jpg');
        expect(mockApiRequest).toHaveBeenCalledTimes(1);
    });

    it('builds cover URL from metadata work source_id when available', async () => {
        mockApiRequest.mockResolvedValue({
            id: 'Playlist-3',
            name: 'Legacy Shape',
            user_name: 'Carol',
            works_count: 7,
            privacy: 2,
            works: [{ source_id: 'RJ01510791' }],
        });

        const service = PlaylistDiscoveryService.getInstance();
        const result = await service.fetchMetadata('Playlist-3');

        expect(result?.coverUrl).toBe('https://api.asmr.one/api/cover/1510791.jpg?type=main');
        expect(result?.latestWorkId).toBe(1510791);
        expect(mockApiRequest).toHaveBeenCalledTimes(1);
    });

    it('collects playlist tags from metadata for tag filtering', async () => {
        mockApiRequest.mockResolvedValue({
            id: 'Playlist-4',
            name: 'Tagged Playlist',
            user_name: 'Dana',
            works_count: 2,
            privacy: 2,
            works: [
                {
                    id: 'RJ01234567',
                    tags: [
                        { name: 'Ear Cleaning' },
                        { title: 'Binaural' },
                    ],
                },
                {
                    id: 'RJ07654321',
                    genres: ['Whisper', 'Ear Cleaning'],
                },
            ],
        });

        const service = PlaylistDiscoveryService.getInstance();
        const result = await service.fetchMetadata('Playlist-4');

        expect(result?.tags).toEqual(['Ear Cleaning', 'Binaural', 'Whisper']);
    });

    it('normalizes legacy cached entries without tags', () => {
        (globalThis as unknown as { GM_setValue: (key: string, value: string) => void }).GM_setValue(
            'asmr_ultimate_playlist_metadata_cache',
            JSON.stringify([{
                id: 'playlist-legacy',
                name: 'Legacy Playlist',
                user_name: 'Legacy User',
                worksCount: 1,
                coverUrl: '',
                cachedAt: Date.now(),
            }]),
        );

        const service = PlaylistDiscoveryService.getInstance();
        const cached = service.getCachedMetadata('playlist-legacy');

        expect(cached?.tags).toEqual([]);
    });

    it('does not mark playlist as permanently failed on 429', async () => {
        mockApiRequest.mockRejectedValue(new HttpError(429, 'HTTP 429: Error'));

        const service = PlaylistDiscoveryService.getInstance();
        const result = await service.fetchMetadata('playlist-rate-limited');

        expect(result).toBeNull();
        expect(service.isFailed('playlist-rate-limited')).toBe(false);
        expect(service.isTransientFailed('playlist-rate-limited')).toBe(true);
    });
});
