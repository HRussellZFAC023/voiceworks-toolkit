import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiRequest: vi.fn() }));

vi.mock('$', () => ({ GM_setValue: vi.fn() }));
vi.mock('../../src/features/playlist/PlaylistService', () => ({ apiRequest: mocks.apiRequest }));
vi.mock('../../src/features/playlist/PlaylistDiscoveryService', () => ({
    PlaylistDiscoveryService: { getInstance: () => ({ getDiscoveredIds: () => [] }) },
}));
vi.mock('../../src/core/Utils', () => ({
    I18n: { t: (key: string) => key, format: (key: string) => key },
    Logger: { info: vi.fn(), warn: vi.fn() },
}));

import { fetchPlaylistAsExported } from '../../src/features/EmergencyExport';

describe('EmergencyExport performance', () => {
    it('starts playlist metadata and first works page concurrently', async () => {
        mocks.apiRequest.mockReset();
        const resolvers: Array<(value: unknown) => void> = [];
        mocks.apiRequest.mockImplementation(() => new Promise(resolve => { resolvers.push(resolve); }));

        const pending = fetchPlaylistAsExported('playlist-id');
        expect(mocks.apiRequest).toHaveBeenCalledTimes(2);
        expect(mocks.apiRequest.mock.calls.map(([url]) => url)).toEqual([
            '/api/playlist/get-playlist-works',
            '/api/playlist/get-playlist-metadata',
        ]);

        resolvers[0]({
            works: [{ source_id: 'RJ123456', title: 'Work' }],
            pagination: { currentPage: 1, pageSize: 100, totalCount: 1 },
        });
        resolvers[1]({ id: 'playlist-id', name: 'Fast backup', works_count: 1 });

        await expect(pending).resolves.toMatchObject({
            id: 'playlist-id',
            name: 'Fast backup',
            works: [{ rjCode: 'RJ123456', title: 'Work' }],
        });
    });

    it('retries a 404 works request with the host-compatible 20-item page size', async () => {
        mocks.apiRequest.mockReset();
        mocks.apiRequest.mockImplementation(async (url: string, params: { pageSize?: number }) => {
            if (url.includes('metadata')) return { id: 'legacy', name: 'Legacy', works_count: 1 };
            if (params.pageSize === 100) throw new Error('HTTP 404: Error');
            return {
                works: [{ source_id: 'RJ765432', title: 'Recovered' }],
                pagination: { currentPage: 1, pageSize: 20, totalCount: 1 },
            };
        });

        const result = await fetchPlaylistAsExported('legacy');

        expect(result.works).toEqual([{ rjCode: 'RJ765432', title: 'Recovered' }]);
        expect(result.error).toBeUndefined();
        expect(mocks.apiRequest).toHaveBeenCalledWith('/api/playlist/get-playlist-works', {
            id: 'legacy', page: 1, pageSize: 20,
        });
    });

    it('uses work IDs embedded in the playlist listing when detail endpoints fail', async () => {
        mocks.apiRequest.mockReset();
        mocks.apiRequest.mockRejectedValue(new Error('HTTP 404: Error'));

        const result = await fetchPlaylistAsExported('own-id', {
            id: 'own-id',
            name: 'Wing backup',
            description: '',
            privacy: 0,
            works: ['RJ111111', 'RJ222222'],
            works_count: 2,
        });

        expect(result.works).toEqual([
            { rjCode: 'RJ111111', title: '' },
            { rjCode: 'RJ222222', title: '' },
        ]);
        expect(result.error).toBeUndefined();
    });

    it('continues compatibility pagination without totalCount until a short page', async () => {
        mocks.apiRequest.mockReset();
        const works = Array.from({ length: 25 }, (_, index) => ({
            source_id: `RJ${String(index + 1).padStart(6, '0')}`,
            title: `Work ${index + 1}`,
        }));
        mocks.apiRequest.mockImplementation(async (url: string, params: { page?: number; pageSize?: number }) => {
            if (url.includes('metadata')) return { id: 'many', name: 'Many', works_count: 25 };
            if (params.pageSize === 100) throw new Error('HTTP 404: Error');
            const start = ((params.page || 1) - 1) * 20;
            return { works: works.slice(start, start + 20) };
        });

        const result = await fetchPlaylistAsExported('many');

        expect(result.works).toHaveLength(25);
        expect(result.worksCount).toBe(25);
        expect(result.error).toBeUndefined();
        expect(mocks.apiRequest).toHaveBeenCalledWith('/api/playlist/get-playlist-works', {
            id: 'many', page: 2, pageSize: 20,
        });
    });
});
