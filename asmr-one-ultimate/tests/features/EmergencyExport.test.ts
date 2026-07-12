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
});
