import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAxios = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
};

vi.mock('../../src/api/Client', () => ({
    getAxios: vi.fn(() => mockAxios),
}));

import { PlaylistApi } from '../../src/api/Playlist';

describe('PlaylistApi', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('createPlaylist', () => {
        it('should POST to create-playlist endpoint', async () => {
            mockAxios.post.mockResolvedValue({ data: { id: 'p1', name: 'Test' } });
            const result = await PlaylistApi.createPlaylist({
                name: 'Test',
                privacy: 0,
                works: ['RJ123456'],
            });
            expect(mockAxios.post).toHaveBeenCalledWith('/api/playlist/create-playlist', {
                name: 'Test',
                description: '',
                privacy: 0,
                works: ['RJ123456'],
                locale: 'en',
            });
            expect(result).toEqual({ id: 'p1', name: 'Test' });
        });

        it('should pass custom description and locale', async () => {
            mockAxios.post.mockResolvedValue({ data: {} });
            await PlaylistApi.createPlaylist({
                name: 'My List',
                description: 'Favorites',
                privacy: 2,
                works: [],
                locale: 'ja',
            });
            expect(mockAxios.post).toHaveBeenCalledWith('/api/playlist/create-playlist', expect.objectContaining({
                description: 'Favorites',
                locale: 'ja',
            }));
        });
    });

    describe('getPlaylists', () => {
        it('should GET playlists from /api/playlists', async () => {
            mockAxios.get.mockResolvedValue({
                data: [{ id: 'p1' }],
            });
            const result = await PlaylistApi.getPlaylists();
            expect(mockAxios.get).toHaveBeenCalledWith('/api/playlists');
            expect(result).toHaveLength(1);
        });

        it('should handle array response', async () => {
            mockAxios.get.mockResolvedValue({ data: [{ id: 'p1' }, { id: 'p2' }] });
            const result = await PlaylistApi.getPlaylists();
            expect(result).toHaveLength(2);
        });

        it('should handle empty/null response', async () => {
            mockAxios.get.mockResolvedValue({ data: null });
            const result = await PlaylistApi.getPlaylists();
            expect(result).toEqual([]);
        });

        it('should return empty array when data is falsy', async () => {
            mockAxios.get.mockResolvedValue({ data: undefined });
            const result = await PlaylistApi.getPlaylists();
            expect(mockAxios.get).toHaveBeenCalledWith('/api/playlists');
            expect(result).toEqual([]);
        });
    });

    describe('getPlaylist', () => {
        it('should GET playlist by ID', async () => {
            mockAxios.get.mockResolvedValue({ data: { id: 'p1', name: 'Test' } });
            const result = await PlaylistApi.getPlaylist('p1');
            expect(mockAxios.get).toHaveBeenCalledWith('/api/playlist/p1');
            expect(result.name).toBe('Test');
        });
    });

    describe('addWorks', () => {
        it('should PUT works to playlist', async () => {
            mockAxios.put.mockResolvedValue({ data: {} });
            await PlaylistApi.addWorks('p1', ['RJ111', 'RJ222']);
            expect(mockAxios.put).toHaveBeenCalledWith('/api/playlist/p1/works', { works: ['RJ111', 'RJ222'] });
        });
    });

    describe('removeWorks', () => {
        it('should DELETE works from playlist', async () => {
            mockAxios.delete.mockResolvedValue({ data: {} });
            await PlaylistApi.removeWorks('p1', ['RJ111']);
            expect(mockAxios.delete).toHaveBeenCalledWith('/api/playlist/p1/works', { data: { works: ['RJ111'] } });
        });
    });

    describe('deletePlaylist', () => {
        it('should DELETE playlist by ID', async () => {
            mockAxios.delete.mockResolvedValue({ data: {} });
            await PlaylistApi.deletePlaylist('p1');
            expect(mockAxios.delete).toHaveBeenCalledWith('/api/playlist/p1');
        });
    });

    describe('updatePlaylist', () => {
        it('should PUT playlist metadata', async () => {
            mockAxios.put.mockResolvedValue({ data: { id: 'p1', name: 'Updated' } });
            const result = await PlaylistApi.updatePlaylist('p1', { name: 'Updated' });
            expect(mockAxios.put).toHaveBeenCalledWith('/api/playlist/p1', { name: 'Updated' });
            expect(result.name).toBe('Updated');
        });
    });

    describe('getPlaylistMetadata', () => {
        it('should GET metadata with id param', async () => {
            mockAxios.get.mockResolvedValue({ data: { id: 'p1', works: ['RJ111'] } });
            const result = await PlaylistApi.getPlaylistMetadata('p1');
            expect(mockAxios.get).toHaveBeenCalledWith('/api/playlist/get-playlist-metadata', { params: { id: 'p1' } });
            expect(result.works).toEqual(['RJ111']);
        });
    });

    describe('getPlaylistWorks', () => {
        it('should GET works with pagination', async () => {
            mockAxios.get.mockResolvedValue({
                data: { works: [{ id: 1, source_id: 'RJ111', title: 'Work 1' }], pagination: { currentPage: 1, pageSize: 100, totalCount: 1 } },
            });
            const result = await PlaylistApi.getPlaylistWorks('p1');
            expect(mockAxios.get).toHaveBeenCalledWith('/api/playlist/get-playlist-works', {
                params: { id: 'p1', page: 1, pageSize: 100 },
            });
            expect(result.works).toHaveLength(1);
        });

        it('should handle empty works response', async () => {
            mockAxios.get.mockResolvedValue({ data: { works: null } });
            const result = await PlaylistApi.getPlaylistWorks('p1');
            expect(result.works).toEqual([]);
        });

        it('should handle empty data', async () => {
            mockAxios.get.mockResolvedValue({ data: null });
            const result = await PlaylistApi.getPlaylistWorks('p1');
            expect(result.works).toEqual([]);
        });
    });

    describe('getAllPlaylistWorks', () => {
        it('should return works from single page', async () => {
            mockAxios.get.mockResolvedValue({
                data: {
                    works: [{ id: 1, source_id: 'RJ111', title: 'W1' }],
                    pagination: { currentPage: 1, pageSize: 100, totalCount: 1 },
                },
            });
            const result = await PlaylistApi.getAllPlaylistWorks('p1');
            expect(result).toHaveLength(1);
            expect(mockAxios.get).toHaveBeenCalledTimes(1);
        });

        it('should fetch multiple pages when totalCount exceeds pageSize', async () => {
            // First call: page 1 with 100 items
            mockAxios.get.mockResolvedValueOnce({
                data: {
                    works: Array.from({ length: 100 }, (_, i) => ({ id: i, source_id: `RJ${i}`, title: `W${i}` })),
                    pagination: { currentPage: 1, pageSize: 100, totalCount: 150 },
                },
            });
            // Second call: page 2 with 50 items
            mockAxios.get.mockResolvedValueOnce({
                data: {
                    works: Array.from({ length: 50 }, (_, i) => ({ id: 100 + i, source_id: `RJ${100 + i}`, title: `W${100 + i}` })),
                    pagination: { currentPage: 2, pageSize: 100, totalCount: 150 },
                },
            });

            const result = await PlaylistApi.getAllPlaylistWorks('p1');
            expect(result).toHaveLength(150);
            expect(mockAxios.get).toHaveBeenCalledTimes(2);
        });

        it('should throw when subsequent page fails', async () => {
            mockAxios.get.mockResolvedValueOnce({
                data: {
                    works: Array.from({ length: 100 }, (_, i) => ({ id: i, source_id: `RJ${i}`, title: `W${i}` })),
                    pagination: { currentPage: 1, pageSize: 100, totalCount: 200 },
                },
            });
            // Page 2 fails
            mockAxios.get.mockRejectedValueOnce(new Error('Server error'));

            await expect(PlaylistApi.getAllPlaylistWorks('p1')).rejects.toThrow('Server error');
        });

        it('should throw when first page fails', async () => {
            mockAxios.get.mockRejectedValue(new Error('Network error'));
            await expect(PlaylistApi.getAllPlaylistWorks('p1')).rejects.toThrow('Network error');
        });
    });
});
