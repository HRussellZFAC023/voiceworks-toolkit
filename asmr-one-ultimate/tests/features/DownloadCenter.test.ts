import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    fetchOwn: vi.fn(),
    fetchPlaylist: vi.fn(),
    cachedCatalog: vi.fn(),
    loadCatalog: vi.fn(),
    searchWorks: vi.fn(),
    recover: vi.fn(),
}));

vi.mock('../../src/features/EmergencyExport', () => ({
    fetchOwnPlaylistEntries: mocks.fetchOwn,
    fetchPlaylistAsExported: mocks.fetchPlaylist,
}));
vi.mock('../../src/features/playlist/PlaylistDiscoveryService', () => ({
    PlaylistDiscoveryService: { getInstance: () => ({ getCachedCommunityCatalog: mocks.cachedCatalog, loadCommunityCatalog: mocks.loadCatalog }) },
}));
vi.mock('../../src/api', () => ({ WorksApi: { searchWorks: mocks.searchWorks } }));
vi.mock('../../src/features/downloads/DownloadCenterRunner', () => ({
    DownloadCenterRunError: class DownloadCenterRunError extends Error { constructor(public code: string) { super(code); } },
    DownloadCenterRunner: class DownloadCenterRunner {
        static getInstance() { return new DownloadCenterRunner(); }
        isRunning = false;
        progress = null;
        recoverInterruptedJobs = mocks.recover;
        start = vi.fn();
        resume = vi.fn();
        pause = vi.fn();
        loadSettledJob = vi.fn();
        subscribe(listener: (progress: null, running: boolean) => void) { listener(null, false); return vi.fn(); }
    },
}));

import DownloadCenter from '../../src/features/components/DownloadCenter.vue';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

describe('DownloadCenter', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = '';
        mocks.cachedCatalog.mockReturnValue([{
            id: '11111111-1111-4111-8111-111111111111', name: 'Cached public', userName: 'Community',
            worksCount: 4, coverUrl: 'https://example.test/public.jpg', tags: ['Relaxing'],
        }]);
        mocks.loadCatalog.mockResolvedValue(mocks.cachedCatalog());
        mocks.recover.mockResolvedValue([]);
        mocks.searchWorks.mockResolvedValue({ works: [], pagination: { currentPage: 1, pageSize: 20, totalCount: 0 } });
    });

    afterEach(() => { document.body.innerHTML = ''; });

    it('opens synchronously on Yours while its network request is still pending', async () => {
        const own = deferred<any[]>();
        mocks.fetchOwn.mockReturnValue(own.promise);
        const wrapper = mount(DownloadCenter, { attachTo: document.body });

        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        expect(document.querySelector('[data-testid="backup-downloader"]')).not.toBeNull();
        expect(document.querySelector('[data-testid="source-own"]')?.getAttribute('aria-selected')).toBe('true');
        expect(document.querySelector('[data-testid="playlist-loading"]')).not.toBeNull();
        expect(mocks.loadCatalog).not.toHaveBeenCalled();

        own.resolve([{ id: 'mine', name: 'Mine', privacy: 0, works: ['RJ123456'], works_count: 1 }]);
        await flushPromises();
        const image = document.querySelector('[data-testid="playlist-mine"] .playlist-cover img') as HTMLImageElement;
        expect(image.src).toContain('/api/cover/123456.jpg?type=240x240');
        wrapper.unmount();
    });

    it('uses two tabs, refreshes community only on demand, and resolves works only on expand', async () => {
        mocks.fetchOwn.mockResolvedValue([]);
        mocks.fetchPlaylist.mockResolvedValue({
            id: '11111111-1111-4111-8111-111111111111', name: 'Cached public', description: '', worksCount: 1,
            works: [{ rjCode: 'RJ9', title: 'Nine' }],
        });
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        await flushPromises();
        expect(document.querySelector('[data-testid="source-all"]')).toBeNull();

        (document.querySelector('[data-testid="source-public"]') as HTMLButtonElement).click();
        await flushPromises();
        expect(mocks.loadCatalog).toHaveBeenCalledTimes(1);
        expect(mocks.fetchPlaylist).not.toHaveBeenCalled();
        (document.querySelector('[data-testid="expand-11111111-1111-4111-8111-111111111111"]') as HTMLButtonElement).click();
        await flushPromises();
        expect(mocks.fetchPlaylist).toHaveBeenCalledTimes(1);
        expect(document.querySelector('[data-testid="work-RJ9"]')).not.toBeNull();
        wrapper.unmount();
    });

    it('retries a playlist whose first lazy work request fails', async () => {
        mocks.fetchOwn.mockResolvedValue([]);
        mocks.fetchPlaylist
            .mockRejectedValueOnce(new Error('temporary outage'))
            .mockResolvedValueOnce({
                id: '11111111-1111-4111-8111-111111111111', name: 'Cached public', description: '', worksCount: 1,
                works: [{ rjCode: 'RJ9', title: 'Nine' }],
            });
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        await flushPromises();
        (document.querySelector('[data-testid="source-public"]') as HTMLButtonElement).click();
        await flushPromises();

        (document.querySelector('[data-testid="playlist-check-11111111-1111-4111-8111-111111111111"]') as HTMLInputElement).click();
        await flushPromises();
        expect(mocks.fetchPlaylist).toHaveBeenCalledTimes(1);

        (document.querySelector('[data-testid="playlist-check-11111111-1111-4111-8111-111111111111"]') as HTMLInputElement).click();
        await flushPromises();
        expect(mocks.fetchPlaylist).toHaveBeenCalledTimes(2);
        expect(document.querySelector('[data-testid="selection-summary"]')?.textContent).toMatch(/1/);
        wrapper.unmount();
    });

    it('adds selectable direct work-search results to the same collection', async () => {
        mocks.fetchOwn.mockResolvedValue([]);
        mocks.searchWorks.mockResolvedValue({ works: [{ id: 42, title: 'Direct result' }], pagination: { currentPage: 1, pageSize: 20, totalCount: 1 } });
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        await flushPromises();
        const input = document.querySelector('[data-testid="search"]') as HTMLInputElement;
        input.value = 'Direct';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await flushPromises();
        (document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).click();
        await flushPromises();
        expect(mocks.searchWorks).toHaveBeenCalledWith('Direct', { page: 1 });
        expect(document.querySelector('[data-testid="search-work-RJ000042"]')?.textContent).toContain('Direct result');
        wrapper.unmount();
    });

    it('retries an uncached community catalog after a transient first failure', async () => {
        mocks.cachedCatalog.mockReturnValue([]);
        mocks.fetchOwn.mockResolvedValue([]);
        mocks.loadCatalog.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([{
            id: '11111111-1111-4111-8111-111111111111', name: 'Recovered', userName: '',
            worksCount: 1, coverUrl: '', tags: [],
        }]);
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        await flushPromises();
        (document.querySelector('[data-testid="source-public"]') as HTMLButtonElement).click();
        await flushPromises();
        (document.querySelector('[data-testid="source-own"]') as HTMLButtonElement).click();
        await flushPromises();
        (document.querySelector('[data-testid="source-public"]') as HTMLButtonElement).click();
        await flushPromises();

        expect(mocks.loadCatalog).toHaveBeenCalledTimes(2);
        expect(document.querySelector('[data-testid="playlist-11111111-1111-4111-8111-111111111111"]')).not.toBeNull();
        wrapper.unmount();
    });

    it('imports a saved backup without making it a prerequisite for live playlists', async () => {
        mocks.fetchOwn.mockResolvedValue([]);
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        await flushPromises();
        const input = document.querySelector('[data-testid="download-center-import-input"]') as HTMLInputElement;
        const file = new File([JSON.stringify({
            format: 'asmr-one-ultimate-playlist-backup', version: 1,
            exportedAt: new Date().toISOString(), source: 'https://asmr.one', errors: [], publicPlaylists: [],
            ownPlaylists: [{ id: 'imported', name: 'Saved offline', description: '', worksCount: 1, works: [{ rjCode: 'RJ777777', title: 'Saved work' }] }],
        })], 'backup.json', { type: 'application/json' });
        Object.defineProperty(input, 'files', { configurable: true, value: [file] });
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await flushPromises();

        await vi.waitFor(() => {
            expect(document.querySelector('[data-testid="playlist-imported"]')?.textContent).toContain('Saved offline');
        });
        wrapper.unmount();
    });

    it('deduplicates the same work across playlist and direct-search ID shapes', async () => {
        mocks.fetchOwn.mockResolvedValue([]);
        mocks.fetchPlaylist.mockResolvedValue({
            id: '11111111-1111-4111-8111-111111111111', name: 'Cached public', description: '', worksCount: 1,
            works: [{ rjCode: 'RJ000042', title: 'Playlist title' }],
        });
        mocks.searchWorks.mockResolvedValue({
            works: [{ id: 42, source_id: 'RJ000042', title: 'Search title' }],
            pagination: { currentPage: 1, pageSize: 20, totalCount: 1 },
        });
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        await flushPromises();
        (document.querySelector('[data-testid="source-public"]') as HTMLButtonElement).click();
        await flushPromises();
        (document.querySelector('[data-testid^="expand-"]') as HTMLButtonElement).click();
        await flushPromises();
        const search = document.querySelector('[data-testid="search"]') as HTMLInputElement;
        search.value = 'Search';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await flushPromises();
        (document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).click();
        await flushPromises();
        (document.querySelector('[data-testid="search-work-RJ000042"] input') as HTMLInputElement).click();
        await flushPromises();

        expect(document.querySelector('[data-testid="selection-summary"]')?.textContent).toMatch(/1/);
        wrapper.unmount();
    });
});
