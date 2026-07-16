import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../src/infrastructure/HttpClient';

const { mockApiRequest } = vi.hoisted(() => ({
    mockApiRequest: vi.fn(),
}));

vi.mock('../../src/features/playlist/PlaylistService', () => ({
    apiRequest: (...args: unknown[]) => mockApiRequest(...args),
    getApiBaseUrl: () => 'https://api.asmr.one',
}));

import { PlaylistDiscoveryService, parseCommunityPlaylistCatalog } from '../../src/features/playlist/PlaylistDiscoveryService';

describe('PlaylistDiscoveryService cover resolution', () => {
    beforeEach(() => {
        mockApiRequest.mockReset();
        vi.mocked(fetch).mockReset();
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

    it('yields each paced batch before requesting the next one', async () => {
        vi.useFakeTimers();
        try {
            mockApiRequest.mockImplementation(async (endpoint: string, params: { id: string }) => {
                if (endpoint !== '/api/playlist/get-playlist-metadata') throw new Error(`Unexpected endpoint: ${endpoint}`);
                return {
                    id: params.id,
                    name: params.id,
                    user_name: 'user',
                    works_count: 0,
                    privacy: 2,
                    main_cover_url: `https://cdn.example.com/${params.id}.jpg`,
                    works: [],
                };
            });

            const service = PlaylistDiscoveryService.getInstance();
            const iterator = service.fetchMetadataBatch(['one', 'two'], 1, 500);
            await expect(iterator.next()).resolves.toMatchObject({ value: { id: 'one' }, done: false });
            expect(mockApiRequest).toHaveBeenCalledTimes(1);

            const second = iterator.next();
            await vi.advanceTimersByTimeAsync(500);
            await expect(second).resolves.toMatchObject({ value: { id: 'two' }, done: false });
            expect(mockApiRequest).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('loads one bounded community catalog and seeds metadata without per-playlist requests', async () => {
        const playlist = {
            id: '34f993cb-e8ee-4d3c-9901-9047355a6cd4',
            name: 'Recorded oho',
            userName: 'Wing',
            worksCount: 1,
            coverUrl: 'https://cdn.example.com/cover.jpg',
            tags: ['Whisper'],
        };
        const body = JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), playlists: [playlist] });
        vi.mocked(fetch).mockResolvedValueOnce(new Response(body, {
            status: 200,
            headers: {
                etag: '"catalog-1"',
                'content-length': String(new TextEncoder().encode(body).byteLength),
                'content-type': 'application/json; charset=utf-8',
            },
        }));

        const service = PlaylistDiscoveryService.getInstance();
        await expect(service.loadCommunityCatalog(true)).resolves.toEqual([playlist]);

        expect(fetch).toHaveBeenCalledTimes(1);
        expect(mockApiRequest).not.toHaveBeenCalled();
        expect(service.getDiscoveredIds()).toContain(playlist.id);
        expect(service.getCachedMetadata(playlist.id)).toMatchObject({
            name: playlist.name,
            worksCount: 1,
            coverUrl: playlist.coverUrl,
        });
    });

    it('keeps the verified cached catalog when conditional revalidation returns 304', async () => {
        const playlist = {
            id: '34f993cb-e8ee-4d3c-9901-9047355a6cd4', name: 'Cached', userName: '',
            worksCount: 3, coverUrl: '', tags: [],
        };
        const body = JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), playlists: [playlist] });
        vi.mocked(fetch)
            .mockResolvedValueOnce(new Response(body, {
                status: 200,
                headers: { etag: '"catalog-2"', 'content-type': 'application/json' },
            }))
            .mockResolvedValueOnce(new Response(null, { status: 304 }));

        const service = PlaylistDiscoveryService.getInstance();
        await service.loadCommunityCatalog(true);
        await expect(service.loadCommunityCatalog(true)).resolves.toEqual([playlist]);
        expect(vi.mocked(fetch).mock.calls[1]?.[1]).toMatchObject({
            headers: expect.objectContaining({ 'If-None-Match': '"catalog-2"' }),
        });
    });

    it('does not let an orphaned ETag trap an empty client in a permanent 304 loop', async () => {
        const playlist = {
            id: '34f993cb-e8ee-4d3c-9901-9047355a6cd4', name: 'Recovered', userName: '',
            worksCount: 1, coverUrl: '', tags: [],
        };
        (globalThis as unknown as { GM_setValue: (key: string, value: string) => void }).GM_setValue(
            'asmr_ultimate_community_playlist_catalog_v1',
            JSON.stringify({ catalog: null, loadedAt: 0 }),
        );
        (globalThis as unknown as { GM_setValue: (key: string, value: string) => void }).GM_setValue(
            'asmr_ultimate_community_playlist_catalog_etag_v1', '"orphaned"',
        );
        const body = JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), playlists: [playlist] });
        vi.mocked(fetch)
            .mockResolvedValueOnce(new Response(null, { status: 304 }))
            .mockResolvedValueOnce(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));

        const service = PlaylistDiscoveryService.getInstance();
        await expect(service.loadCommunityCatalog(true)).resolves.toEqual([playlist]);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({ headers: { Accept: 'application/json' } });
        expect(vi.mocked(fetch).mock.calls[1]?.[1]).toMatchObject({ headers: { Accept: 'application/json' } });
    });

    it('rejects malformed or non-UUID catalog entries', () => {
        expect(() => parseCommunityPlaylistCatalog({
            version: 1,
            generatedAt: new Date().toISOString(),
            playlists: [{ id: 'not-a-uuid', name: 'Bad' }],
        })).toThrow('Invalid community playlist catalog entry');
        expect(() => parseCommunityPlaylistCatalog({
            version: 1,
            generatedAt: new Date().toISOString(),
            playlists: [{
                id: '34f993cb-e8ee-1d3c-9901-9047355a6cd4', name: 'Wrong UUID version',
                userName: '', worksCount: 0, coverUrl: '', tags: [],
            }],
        })).toThrow('Invalid community playlist catalog entry');
    });

    it('submits only the normalized playlist UUID and merges the verified response', async () => {
        const playlist = {
            id: '34f993cb-e8ee-4d3c-9901-9047355a6cd4',
            name: 'Shared playlist', userName: 'Wing', worksCount: 2,
            coverUrl: 'https://cdn.example.com/shared.jpg', tags: ['ASMR'],
        };
        vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ status: 'added', playlist }), {
            status: 201,
            headers: { 'content-type': 'application/json; charset=utf-8' },
        }));

        const service = PlaylistDiscoveryService.getInstance();
        await expect(service.submitCommunityPlaylist(`https://asmr.one/playlist/${playlist.id}`)).resolves.toEqual(playlist);
        expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/community-playlists/submissions'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ id: playlist.id }),
        });
        expect(service.getCachedCommunityCatalog()).toContainEqual(playlist);
    });
});
