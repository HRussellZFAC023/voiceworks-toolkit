import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    fetchOwn: vi.fn(),
    fetchPlaylist: vi.fn(),
    cachedCatalog: vi.fn(),
    loadCatalog: vi.fn(),
    cachedDetails: vi.fn(),
    semanticSearch: vi.fn(),
    searchWorks: vi.fn(),
    getTracks: vi.fn(),
    getWorkInfo: vi.fn(),
    recover: vi.fn(),
    runnerStart: vi.fn(),
    runnerResume: vi.fn(),
    runnerPause: vi.fn(),
    loadSettledJob: vi.fn(),
    chooseDirectory: vi.fn(),
    getAuthHeader: vi.fn(),
}));

vi.mock('../../src/features/EmergencyExport', () => ({
    fetchOwnPlaylistEntries: mocks.fetchOwn,
    fetchPlaylistAsExported: mocks.fetchPlaylist,
}));
vi.mock('../../src/features/playlist/PlaylistDiscoveryService', () => ({
    PlaylistDiscoveryService: { getInstance: () => ({ getCachedCommunityCatalog: mocks.cachedCatalog, loadCommunityCatalog: mocks.loadCatalog }) },
}));
vi.mock('../../src/features/playlist/CommunityPlaylistDetailsService', () => ({
    fetchCachedCommunityPlaylist: mocks.cachedDetails,
}));
vi.mock('../../src/features/playlist/PlaylistService', () => ({
    getAuthHeader: mocks.getAuthHeader,
    getApiBaseUrl: () => 'https://api.example.test',
}));
vi.mock('../../src/features/SemanticWorkSearchService', () => ({ semanticWorkSearch: mocks.semanticSearch }));
vi.mock('../../src/api', () => ({ WorksApi: { searchWorks: mocks.searchWorks } }));
vi.mock('../../src/services/WorkService', () => ({
    WorkService: { getTracks: mocks.getTracks, getWorkInfo: mocks.getWorkInfo },
}));
vi.mock('../../src/features/downloads/DirectoryDownloadSink', () => ({ chooseDownloadDirectory: mocks.chooseDirectory }));
vi.mock('../../src/features/downloads/DownloadCenterRunner', () => ({
    DownloadCenterRunError: class DownloadCenterRunError extends Error {
        constructor(public code: string, cause?: unknown) {
            super(code);
            if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
        }
    },
    DownloadCenterRunner: class DownloadCenterRunner {
        static getInstance() { return new DownloadCenterRunner(); }
        isRunning = false;
        progress = null;
        recoverInterruptedJobs = mocks.recover;
        start = mocks.runnerStart;
        resume = mocks.runnerResume;
        pause = mocks.runnerPause;
        loadSettledJob = mocks.loadSettledJob;
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
        mocks.runnerStart.mockReset();
        mocks.runnerResume.mockReset();
        mocks.runnerPause.mockReset();
        document.body.innerHTML = '';
        mocks.cachedCatalog.mockReturnValue([{
            id: '11111111-1111-4111-8111-111111111111', name: 'Cached public', userName: 'Community',
            worksCount: 4, coverUrl: 'https://example.test/public.jpg', tags: ['Relaxing'],
        }]);
        mocks.loadCatalog.mockResolvedValue(mocks.cachedCatalog());
        mocks.cachedDetails.mockRejectedValue(new Error('cache miss'));
        mocks.semanticSearch.mockResolvedValue([]);
        mocks.recover.mockResolvedValue([]);
        mocks.loadSettledJob.mockResolvedValue(undefined);
        mocks.chooseDirectory.mockResolvedValue({});
        mocks.getAuthHeader.mockReturnValue({ Authorization: 'Bearer unit-test' });
        mocks.searchWorks.mockResolvedValue({ works: [], pagination: { currentPage: 1, pageSize: 20, totalCount: 0 } });
        mocks.getTracks.mockResolvedValue([]);
        mocks.getWorkInfo.mockResolvedValue({ title: '', duration: 0, tags: [] });
    });

    afterEach(() => {
        vi.useRealTimers();
        document.body.innerHTML = '';
        delete (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker;
    });

    it('opens synchronously on Site and loads Yours only when selected', async () => {
        const own = deferred<any[]>();
        mocks.fetchOwn.mockReturnValue(own.promise);
        const wrapper = mount(DownloadCenter, { attachTo: document.body });

        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        expect(document.querySelector('[data-testid="backup-downloader"]')).not.toBeNull();
        expect(document.querySelector('[data-testid="source-site"]')?.getAttribute('aria-selected')).toBe('true');
        expect(mocks.fetchOwn).not.toHaveBeenCalled();
        expect(mocks.loadCatalog).not.toHaveBeenCalled();
        (document.querySelector('[data-testid="source-own"]') as HTMLButtonElement).click();
        await flushPromises();
        expect(document.querySelector('[data-testid="playlist-loading"]')).not.toBeNull();
        expect(mocks.loadCatalog).not.toHaveBeenCalled();

        own.resolve([{ id: 'mine', name: 'Mine', privacy: 0, works: ['RJ123456'], works_count: 1 }]);
        await flushPromises();
        const image = document.querySelector('[data-testid="playlist-mine"] .playlist-cover img') as HTMLImageElement;
        expect(image.src).toContain('/api/cover/123456.jpg?type=240x240');
        wrapper.unmount();
    });

    it('opens signed-out users on Site and loads Community only when selected', async () => {
        mocks.getAuthHeader.mockReturnValue({});
        mocks.fetchOwn.mockRejectedValue(new Error('should not be requested'));
        const wrapper = mount(DownloadCenter, { attachTo: document.body });

        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        await flushPromises();

        expect(mocks.fetchOwn).not.toHaveBeenCalled();
        expect(mocks.loadCatalog).not.toHaveBeenCalled();
        expect(document.querySelector('[data-testid="source-own"]')).toBeNull();
        expect(document.querySelector('[data-testid="source-site"]')?.getAttribute('aria-selected')).toBe('true');
        expect(document.querySelector('[data-testid="source-load-error"]')).toBeNull();
        (document.querySelector('[data-testid="source-public"]') as HTMLButtonElement).click();
        await flushPromises();
        expect(mocks.loadCatalog).toHaveBeenCalledTimes(1);
        expect(document.querySelector('[data-testid="playlist-11111111-1111-4111-8111-111111111111"]')).not.toBeNull();
        wrapper.unmount();
    });

    it('switches to Community when a stale session is rejected', async () => {
        mocks.fetchOwn.mockRejectedValue(Object.assign(new Error('HTTP 401: Unauthorized'), { status: 401 }));
        const wrapper = mount(DownloadCenter, { attachTo: document.body });

        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        (document.querySelector('[data-testid="source-own"]') as HTMLButtonElement).click();
        await flushPromises();

        expect(document.querySelector('[data-testid="source-own"]')).toBeNull();
        expect(document.querySelector('[data-testid="source-site"]')?.getAttribute('aria-selected')).toBe('true');
        expect(document.querySelector('[data-testid="source-load-error"]')).toBeNull();
        expect(mocks.loadCatalog).toHaveBeenCalledTimes(1);
        wrapper.unmount();
    });

    it('uses Site, Yours, and Community tabs and resolves playlist works only on expand', async () => {
        mocks.fetchOwn.mockResolvedValue([]);
        mocks.fetchPlaylist.mockResolvedValue({
            id: '11111111-1111-4111-8111-111111111111', name: 'Cached public', description: '', worksCount: 1,
            works: [{ rjCode: 'RJ9', title: 'Nine' }],
        });
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        await flushPromises();
        expect(document.querySelector('[data-testid="source-site"]')?.getAttribute('aria-selected')).toBe('true');
        expect(mocks.fetchOwn).not.toHaveBeenCalled();
        (document.querySelector('[data-testid="source-own"]') as HTMLButtonElement).click();
        await flushPromises();
        expect(mocks.fetchOwn).toHaveBeenCalledTimes(1);

        (document.querySelector('[data-testid="source-public"]') as HTMLButtonElement).click();
        await flushPromises();
        expect(mocks.loadCatalog).toHaveBeenCalledTimes(1);
        expect(mocks.fetchPlaylist).not.toHaveBeenCalled();
        (document.querySelector('[data-testid="expand-11111111-1111-4111-8111-111111111111"]') as HTMLButtonElement).click();
        await flushPromises();
        expect(mocks.cachedDetails).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
        expect(mocks.fetchPlaylist).toHaveBeenCalledTimes(1);
        expect(document.querySelector('[data-testid="work-RJ9"]')).not.toBeNull();
        wrapper.unmount();
    });

    it('uses shared community details first and maps duration and size without the live playlist request', async () => {
        mocks.fetchOwn.mockResolvedValue([]);
        mocks.cachedCatalog.mockReturnValue([{
            id: '11111111-1111-4111-8111-111111111111', name: 'Cached public', userName: 'Community',
            worksCount: 1, coverUrl: 'https://example.test/public.jpg', tags: ['Relaxing'],
        }]);
        mocks.loadCatalog.mockResolvedValue(mocks.cachedCatalog());
        mocks.cachedDetails.mockResolvedValue({
            version: 1, fetchedAt: new Date().toISOString(),
            works: [{ rjCode: 'RJ123456', title: 'Shared work', sizeBytes: 1234, durationSeconds: 600 }],
        });
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        await flushPromises();
        (document.querySelector('[data-testid="source-public"]') as HTMLButtonElement).click();
        await flushPromises();
        (document.querySelector('[data-testid^="expand-"]') as HTMLButtonElement).click();
        await flushPromises();

        expect(mocks.cachedDetails).toHaveBeenCalledTimes(1);
        expect(mocks.fetchPlaylist).not.toHaveBeenCalled();
        expect(document.querySelector('[data-testid="work-RJ123456"]')?.textContent).toContain('1.2 KB');
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

    it('uses full-site semantic search and adds its direct results to the same collection', async () => {
        mocks.fetchOwn.mockResolvedValue([]);
        mocks.semanticSearch.mockResolvedValue([{ id: '42', title: '添い寝音声', score: 0.8 }]);
        mocks.searchWorks.mockResolvedValue({
            works: [{ id: 43, title: 'Newest live result' }],
            pagination: { currentPage: 1, pageSize: 20, totalCount: 1 },
        });
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        await flushPromises();
        const input = document.querySelector('[data-testid="search"]') as HTMLInputElement;
        input.value = 'Direct';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await flushPromises();
        (document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).click();
        await flushPromises();
        expect(mocks.semanticSearch).toHaveBeenCalledWith('Direct', 20);
        expect(mocks.searchWorks).toHaveBeenCalledWith('Direct', { page: 1 });
        expect(document.querySelector('[data-testid="search-work-RJ000042"]')?.textContent).toContain('添い寝音声');
        expect(document.querySelector('[data-testid="search-work-RJ000043"]')?.textContent).toContain('Newest live result');
        wrapper.unmount();
    });

    it('renders site-result covers and replaces loading size with the track-manifest total', async () => {
        mocks.fetchOwn.mockResolvedValue([]);
        mocks.searchWorks.mockResolvedValue({
            works: [{
                id: 46, title: 'Covered result', thumbnailCoverUrl: 'https://images.example.test/46.jpg',
                duration: 600, tags: [{ name: 'Relaxing' }],
            }],
            pagination: { currentPage: 1, pageSize: 20, totalCount: 1 },
        });
        mocks.getTracks.mockResolvedValue([
            { type: 'audio', title: 'track.wav', size: 1024 * 1024, mediaDownloadUrl: 'https://media.example.test/track.wav' },
            { type: 'image', title: 'cover.jpg', size: 512 * 1024, mediaDownloadUrl: 'https://media.example.test/cover.jpg' },
        ]);
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        const input = document.querySelector('[data-testid="search"]') as HTMLInputElement;
        input.value = 'covered';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await flushPromises();
        (document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).click();

        await vi.waitFor(() => expect(document.querySelector('[data-testid="search-work-RJ000046"]')?.textContent).toContain('1.5 MB'));
        const image = document.querySelector('[data-testid="search-work-RJ000046"] .work-cover img') as HTMLImageElement;
        expect(image.src).toBe('https://images.example.test/46.jpg');
        expect(mocks.getTracks).toHaveBeenCalledWith('RJ000046');
        expect(mocks.getWorkInfo).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it('does not let stale size enrichment from an earlier query replace current results', async () => {
        const firstTracks = deferred<any[]>();
        mocks.searchWorks
            .mockResolvedValueOnce({
                works: [{ id: 47, title: 'First', duration: 60, thumbnailCoverUrl: 'https://images.example.test/47.jpg', tags: [{ name: 'First' }] }],
                pagination: { currentPage: 1, pageSize: 20, totalCount: 1 },
            })
            .mockResolvedValueOnce({
                works: [{ id: 48, title: 'Second', duration: 60, thumbnailCoverUrl: 'https://images.example.test/48.jpg', tags: [{ name: 'Second' }] }],
                pagination: { currentPage: 1, pageSize: 20, totalCount: 1 },
            });
        mocks.getTracks.mockImplementation((id: string) => id === 'RJ000047'
            ? firstTracks.promise
            : Promise.resolve([{ type: 'audio', title: 'second.wav', size: 2048, mediaDownloadUrl: 'https://media.example.test/second.wav' }]));
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        const input = document.querySelector('[data-testid="search"]') as HTMLInputElement;
        input.value = 'first'; input.dispatchEvent(new Event('input', { bubbles: true }));
        await flushPromises();
        (document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).click();
        await vi.waitFor(() => expect(document.querySelector('[data-testid="search-work-RJ000047"]')).not.toBeNull());

        input.value = 'second'; input.dispatchEvent(new Event('input', { bubbles: true }));
        await flushPromises();
        (document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).click();
        await vi.waitFor(() => expect(document.querySelector('[data-testid="search-work-RJ000048"]')?.textContent).toContain('2 KB'));
        firstTracks.resolve([{ type: 'audio', title: 'first.wav', size: 999999, mediaDownloadUrl: 'https://media.example.test/first.wav' }]);
        await flushPromises();

        expect(document.querySelector('[data-testid="search-work-RJ000047"]')).toBeNull();
        expect(document.querySelector('[data-testid="search-work-RJ000048"]')?.textContent).toContain('2 KB');
        wrapper.unmount();
    });

    it('removes a selected direct-only result when a later site query replaces it', async () => {
        mocks.searchWorks
            .mockResolvedValueOnce({
                works: [{ id: 47, title: 'First direct result' }],
                pagination: { currentPage: 1, pageSize: 20, totalCount: 1 },
            })
            .mockResolvedValueOnce({
                works: [{ id: 48, title: 'Second direct result' }],
                pagination: { currentPage: 1, pageSize: 20, totalCount: 1 },
            });
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        const input = document.querySelector('[data-testid="search"]') as HTMLInputElement;

        input.value = 'first';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await flushPromises();
        (document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).click();
        await vi.waitFor(() => expect(document.querySelector('[data-testid="search-work-RJ000047"]')).not.toBeNull());
        (document.querySelector('[data-testid="search-work-RJ000047"] input') as HTMLInputElement).click();
        await flushPromises();
        expect(document.querySelector('[data-testid="selection-summary"]')?.textContent).toMatch(/^1 /);

        input.value = 'second';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await flushPromises();
        (document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).click();
        await vi.waitFor(() => expect(document.querySelector('[data-testid="search-work-RJ000048"]')).not.toBeNull());

        expect(document.querySelector('[data-testid="search-work-RJ000047"]')).toBeNull();
        expect(document.querySelector('[data-testid="selection-summary"]')?.textContent).toMatch(/^0 /);
        expect((document.querySelector('[data-testid="start"]') as HTMLButtonElement).disabled).toBe(true);
        wrapper.unmount();
    });

    it('does not promote a cached partial manifest to an exact size on repeated enrichment', async () => {
        mocks.searchWorks.mockResolvedValue({
            works: [{ id: 49, title: 'Partial', duration: 60, thumbnailCoverUrl: 'https://images.example.test/49.jpg', tags: [{ name: 'Partial' }] }],
            pagination: { currentPage: 1, pageSize: 20, totalCount: 1 },
        });
        mocks.getTracks.mockResolvedValue([
            { type: 'audio', title: 'known.wav', size: 1024, mediaDownloadUrl: 'https://media.example.test/known.wav' },
            { type: 'image', title: 'unknown.jpg', mediaDownloadUrl: 'https://media.example.test/unknown.jpg' },
        ]);
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        const input = document.querySelector('[data-testid="search"]') as HTMLInputElement;
        input.value = 'partial'; input.dispatchEvent(new Event('input', { bubbles: true }));
        await flushPromises();
        (document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).click();
        await vi.waitFor(() => expect(document.querySelector('[data-testid="search-work-RJ000049"]')?.textContent).toContain('at least 1 KB'));

        (document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).click();
        await flushPromises();

        expect(document.querySelector('[data-testid="search-work-RJ000049"]')?.textContent).toContain('at least 1 KB');
        expect(mocks.getTracks).toHaveBeenCalledTimes(1);
        wrapper.unmount();
    });

    it('stops queued work enrichment when the component unmounts', async () => {
        const tracks = [deferred<any[]>(), deferred<any[]>(), deferred<any[]>()];
        mocks.searchWorks.mockResolvedValue({
            works: [50, 51, 52, 53].map(id => ({
                id, title: `Work ${id}`, duration: 60,
                thumbnailCoverUrl: `https://images.example.test/${id}.jpg`, tags: [{ name: 'Test' }],
            })),
            pagination: { currentPage: 1, pageSize: 20, totalCount: 4 },
        });
        mocks.getTracks.mockImplementation((_id: string) => tracks[mocks.getTracks.mock.calls.length - 1]?.promise ?? Promise.resolve([]));
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        const input = document.querySelector('[data-testid="search"]') as HTMLInputElement;
        input.value = 'queue'; input.dispatchEvent(new Event('input', { bubbles: true }));
        await flushPromises();
        (document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).click();
        await vi.waitFor(() => expect(mocks.getTracks).toHaveBeenCalledTimes(3));

        wrapper.unmount();
        tracks.forEach(item => item.resolve([]));
        await flushPromises();

        expect(mocks.getTracks).toHaveBeenCalledTimes(3);
    });

    it('keeps semantic results when the live site search is unavailable', async () => {
        mocks.fetchOwn.mockResolvedValue([]);
        mocks.semanticSearch.mockResolvedValue([{ id: '44', title: '意味検索の結果', score: 0.8 }]);
        mocks.searchWorks.mockRejectedValue(new Error('live site unavailable'));
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        await flushPromises();
        const input = document.querySelector('[data-testid="search"]') as HTMLInputElement;
        input.value = 'comfort';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await flushPromises();
        (document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).click();
        await flushPromises();

        expect(document.querySelector('[data-testid="search-work-RJ000044"]')).not.toBeNull();
        expect(document.querySelector('[data-testid="all-work-search-error"]')).toBeNull();
        wrapper.unmount();
    });

    it('keeps live site results when the hosted semantic search is unavailable', async () => {
        mocks.fetchOwn.mockResolvedValue([]);
        mocks.semanticSearch.mockRejectedValue(new Error('semantic baseline unavailable'));
        mocks.searchWorks.mockResolvedValue({
            works: [{ id: 45, title: 'Live catalogue result' }],
            pagination: { currentPage: 1, pageSize: 20, totalCount: 1 },
        });
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        await flushPromises();
        const input = document.querySelector('[data-testid="search"]') as HTMLInputElement;
        input.value = 'latest';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await flushPromises();
        (document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).click();
        await flushPromises();

        expect(document.querySelector('[data-testid="search-work-RJ000045"]')).not.toBeNull();
        expect(document.querySelector('[data-testid="all-work-search-error"]')).toBeNull();
        wrapper.unmount();
    });

    it('does not leave live site results blocked behind a stalled semantic model load', async () => {
        mocks.fetchOwn.mockResolvedValue([]);
        mocks.semanticSearch.mockReturnValue(new Promise(() => {}));
        mocks.searchWorks.mockResolvedValue({
            works: [{ id: 46, title: 'Live result while model loads' }],
            pagination: { currentPage: 1, pageSize: 20, totalCount: 1 },
        });
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        await flushPromises();
        const input = document.querySelector('[data-testid="search"]') as HTMLInputElement;
        input.value = 'quiet whisper';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await flushPromises();
        (document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).click();
        await flushPromises();

        expect(document.querySelector('[data-testid="search-work-RJ000046"]')).not.toBeNull();
        expect(document.querySelector('[data-testid="all-work-search-error"]')).toBeNull();
        wrapper.unmount();
    });

    it('renders live results first and merges a slower semantic answer for the active query', async () => {
        const semantic = deferred<any[]>();
        mocks.fetchOwn.mockResolvedValue([]);
        mocks.semanticSearch.mockReturnValue(semantic.promise);
        mocks.searchWorks.mockResolvedValue({
            works: [{ id: 46, title: 'Immediate live result' }],
            pagination: { currentPage: 1, pageSize: 20, totalCount: 1 },
        });
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        await flushPromises();
        const input = document.querySelector('[data-testid="search"]') as HTMLInputElement;
        input.value = 'comfort';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await flushPromises();
        (document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).click();
        await flushPromises();

        expect(document.querySelector('[data-testid="search-work-RJ000046"]')).not.toBeNull();
        expect(document.querySelector('[data-testid="search-work-RJ000044"]')).toBeNull();
        semantic.resolve([{ id: '44', title: 'Later semantic result', score: 0.8 }]);
        await flushPromises();

        expect(document.querySelector('[data-testid="search-work-RJ000046"]')).not.toBeNull();
        expect(document.querySelector('[data-testid="search-work-RJ000044"]')).not.toBeNull();
        wrapper.unmount();
    });

    it('keeps searching when an empty live response arrives before a useful semantic answer', async () => {
        const semantic = deferred<any[]>();
        mocks.fetchOwn.mockResolvedValue([]);
        mocks.semanticSearch.mockReturnValue(semantic.promise);
        mocks.searchWorks.mockResolvedValue({
            works: [],
            pagination: { currentPage: 1, pageSize: 20, totalCount: 0 },
        });
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        await flushPromises();
        const input = document.querySelector('[data-testid="search"]') as HTMLInputElement;
        input.value = 'meaning-based query';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await flushPromises();
        (document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).click();
        await flushPromises();

        expect((document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).disabled).toBe(true);
        expect(document.querySelector('[data-testid="search-work-RJ000044"]')).toBeNull();
        semantic.resolve([{ id: '44', title: 'Semantic-only result', score: 0.8 }]);
        await flushPromises();

        expect(document.querySelector('[data-testid="search-work-RJ000044"]')).not.toBeNull();
        expect((document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).disabled).toBe(false);
        wrapper.unmount();
    });

    it('ignores a late semantic answer after a newer site query starts', async () => {
        const firstSemantic = deferred<any[]>();
        mocks.fetchOwn.mockResolvedValue([]);
        mocks.semanticSearch
            .mockReturnValueOnce(firstSemantic.promise)
            .mockResolvedValueOnce([]);
        mocks.searchWorks
            .mockResolvedValueOnce({
                works: [{ id: 46, title: 'First live result' }],
                pagination: { currentPage: 1, pageSize: 20, totalCount: 1 },
            })
            .mockResolvedValueOnce({
                works: [{ id: 47, title: 'Second live result' }],
                pagination: { currentPage: 1, pageSize: 20, totalCount: 1 },
            });
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        await flushPromises();
        const input = document.querySelector('[data-testid="search"]') as HTMLInputElement;
        input.value = 'first';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await flushPromises();
        (document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).click();
        await flushPromises();
        expect(document.querySelector('[data-testid="search-work-RJ000046"]')).not.toBeNull();

        input.value = 'second';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await flushPromises();
        (document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).click();
        await flushPromises();
        expect(document.querySelector('[data-testid="search-work-RJ000047"]')).not.toBeNull();

        firstSemantic.resolve([{ id: '99', title: 'Stale semantic result', score: 0.9 }]);
        await flushPromises();

        expect(document.querySelector('[data-testid="search-work-RJ000099"]')).toBeNull();
        expect(document.querySelector('[data-testid="search-work-RJ000047"]')).not.toBeNull();
        wrapper.unmount();
    });

    it('ends a search with an error when both the live catalogue and semantic model are unavailable', async () => {
        vi.useFakeTimers();
        mocks.fetchOwn.mockResolvedValue([]);
        mocks.semanticSearch.mockReturnValue(new Promise(() => {}));
        mocks.searchWorks.mockRejectedValue(new Error('live site unavailable'));
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        await flushPromises();
        const input = document.querySelector('[data-testid="search"]') as HTMLInputElement;
        input.value = 'offline query';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await flushPromises();
        (document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).click();
        await flushPromises();

        expect(document.querySelector('[data-testid="all-work-search-error"]')).toBeNull();
        await vi.advanceTimersByTimeAsync(30_000);
        await flushPromises();

        expect(document.querySelector('[data-testid="all-work-search-error"]')).not.toBeNull();
        wrapper.unmount();
    });

    it('shows a search error only when both site-wide search sources fail', async () => {
        mocks.fetchOwn.mockResolvedValue([]);
        mocks.semanticSearch.mockRejectedValue(new Error('semantic baseline unavailable'));
        mocks.searchWorks.mockRejectedValue(new Error('live site unavailable'));
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        await flushPromises();
        const input = document.querySelector('[data-testid="search"]') as HTMLInputElement;
        input.value = 'anything';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await flushPromises();
        (document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).click();
        await flushPromises();

        expect(document.querySelector('[data-testid="all-work-search-error"]')).not.toBeNull();
        wrapper.unmount();
    });

    it('shows a search error when an exact RJ lookup cannot reach the live catalogue', async () => {
        mocks.fetchOwn.mockResolvedValue([]);
        mocks.searchWorks.mockRejectedValue(new Error('live site unavailable'));
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        await flushPromises();
        const input = document.querySelector('[data-testid="search"]') as HTMLInputElement;
        input.value = 'RJ123456';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await flushPromises();
        (document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).click();
        await flushPromises();

        expect(mocks.semanticSearch).not.toHaveBeenCalled();
        expect(document.querySelector('[data-testid="all-work-search-error"]')).not.toBeNull();
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

    it('keeps source-loading failures out of job progress and has no backup import action', async () => {
        mocks.fetchOwn.mockRejectedValue(new Error('offline'));
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        (document.querySelector('[data-testid="source-own"]') as HTMLButtonElement).click();
        await flushPromises();

        expect(document.querySelector('[data-testid="source-load-error"]')).not.toBeNull();
        expect(document.querySelector('[data-testid="download-progress"]')).toBeNull();
        expect(document.querySelector('[data-testid="download-center-import-input"]')).toBeNull();
        wrapper.unmount();
    });

    it('preserves the runner file counts when a work download fails', async () => {
        mocks.fetchOwn.mockResolvedValue([{ id: 'mine', name: 'Mine', privacy: 0, works: ['RJ123456'], works_count: 1 }]);
        mocks.fetchPlaylist.mockResolvedValue({
            id: 'mine', name: 'Mine', description: '', worksCount: 1,
            works: [{ rjCode: 'RJ123456', title: 'Selected work' }],
        });
        mocks.runnerStart.mockImplementation(async (_works, _state, _directory, _title, onProgress) => {
            onProgress({ jobId: 'job-1', phase: 'downloading', current: 2, total: 5, label: 'Selected work/track.wav' });
            const ErrorType = (await import('../../src/features/downloads/DownloadCenterRunner')).DownloadCenterRunError;
            throw new ErrorType(
                'failed',
                new Error('Selected work/track.wav: HTTP 403 at https://cdn.example.test/file?token=do-not-leak'),
            );
        });
        Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: vi.fn() });
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        (document.querySelector('[data-testid="source-own"]') as HTMLButtonElement).click();
        await flushPromises();
        (document.querySelector('[data-testid="playlist-check-mine"]') as HTMLInputElement).click();
        await flushPromises();
        (document.querySelector('[data-testid="start"]') as HTMLButtonElement).click();
        await flushPromises();

        expect(document.querySelector('[data-testid="download-error"]')?.textContent).toMatch(/failed/i);
        expect(document.querySelector('[data-testid="download-error"]')?.textContent).toContain('Selected work/track.wav');
        expect(document.querySelector('[data-testid="download-error"]')?.textContent).toContain('HTTP 403');
        expect(document.querySelector('[data-testid="download-error"]')?.textContent).not.toContain('do-not-leak');
        expect(document.querySelector('[data-testid="download-error"]')?.textContent).not.toContain('cdn.example.test');
        expect(document.querySelector('[data-testid="progress-count"]')?.textContent).toContain('2 / 5');
        expect(document.querySelector('[data-testid="download-progress"]')?.textContent).not.toContain('0 / 0');
        wrapper.unmount();
    });

    it('deduplicates the same work across playlist and direct-search ID shapes', async () => {
        mocks.fetchOwn.mockResolvedValue([]);
        mocks.fetchPlaylist.mockResolvedValue({
            id: '11111111-1111-4111-8111-111111111111', name: 'Cached public', description: '', worksCount: 1,
            works: [{ rjCode: 'RJ000042', title: 'Playlist title' }],
        });
        mocks.semanticSearch.mockResolvedValue([{ id: 'RJ000042', title: 'Search title', score: 0.8 }]);
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        await flushPromises();
        (document.querySelector('[data-testid="source-public"]') as HTMLButtonElement).click();
        await flushPromises();
        (document.querySelector('[data-testid^="expand-"]') as HTMLButtonElement).click();
        await flushPromises();
        (document.querySelector('[data-testid="source-site"]') as HTMLButtonElement).click();
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
