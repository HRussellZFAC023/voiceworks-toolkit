import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    fetchOwn: vi.fn(),
    fetchPlaylist: vi.fn(),
    cachedCatalog: vi.fn(),
    loadCatalog: vi.fn(),
    cachedDetails: vi.fn(),
    semanticSearch: vi.fn(),
    clearSemanticCache: vi.fn(),
    searchWorks: vi.fn(),
    getTracks: vi.fn(),
    getWorkInfo: vi.fn(),
    recover: vi.fn(),
    runnerStart: vi.fn(),
    runnerResume: vi.fn(),
    runnerPause: vi.fn(),
    loadSettledJob: vi.fn(),
    canCreateDestination: vi.fn(),
    createDestination: vi.fn(),
    supportsPicker: vi.fn(),
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
vi.mock('../../src/features/SemanticWorkSearchService', () => ({
    semanticWorkSearch: mocks.semanticSearch,
    clearSemanticWorkSearchCache: mocks.clearSemanticCache,
    SEMANTIC_WORK_SEARCH_PAGE_SIZE: 100,
}));
vi.mock('../../src/api', () => ({ WorksApi: { searchWorks: mocks.searchWorks } }));
vi.mock('../../src/services/WorkService', () => ({
    WorkService: { getTracks: mocks.getTracks, getWorkInfo: mocks.getWorkInfo },
}));
vi.mock('../../src/features/downloads/DownloadSinkFactory', () => ({
    canCreateDownloadDestination: mocks.canCreateDestination,
    createDownloadDestination: mocks.createDestination,
    supportsDirectoryPicker: mocks.supportsPicker,
    DownloadDestinationCancelledError: class DownloadDestinationCancelledError extends Error {},
}));
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

interface SemanticPage { results: any[]; total: number }

/** `total` is the whole match set, which is larger than one page. */
/** A live-lane response page with explicit pagination, matching the real API. */
function worksPage(works: any[], currentPage: number, totalCount: number): any {
    return { works, pagination: { currentPage, pageSize: 100, totalCount } };
}

function semanticPage(results: any[], total = results.length): SemanticPage {
    return { results, total };
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
        mocks.semanticSearch.mockResolvedValue(semanticPage([]));
        mocks.recover.mockResolvedValue([]);
        mocks.loadSettledJob.mockResolvedValue(undefined);
        mocks.canCreateDestination.mockReturnValue(true);
        mocks.supportsPicker.mockReturnValue(true);
        mocks.createDestination.mockResolvedValue({ kind: 'fsa', handle: {} });
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

    it('selects every file category by default for complete-work downloads', async () => {
        const wrapper = mount(DownloadCenter, { attachTo: document.body });

        await wrapper.get('[data-testid="download-center-open"]').trigger('click');

        for (const category of ['audio', 'video', 'image', 'text', 'other']) {
            const checkbox = document.querySelector(
                `[data-testid="file-filter-${category}"]`,
            ) as HTMLInputElement;
            expect(checkbox.checked).toBe(true);
        }
        wrapper.unmount();
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
        mocks.semanticSearch.mockResolvedValue(semanticPage([{ id: '42', title: '添い寝音声', score: 0.8 }]));
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
        expect(mocks.semanticSearch).toHaveBeenCalledWith('Direct', { limit: 100, offset: 0 });
        expect(mocks.searchWorks).toHaveBeenCalledWith('Direct', { page: 1, pageSize: 100, limit: 100 });
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

        await vi.waitFor(() => expect(document.querySelector('[data-testid="search-work-RJ000046"]')).not.toBeNull());
        // The list view never reads a file manifest; selecting the row does.
        expect(mocks.getTracks).not.toHaveBeenCalled();
        (document.querySelector('[data-testid="search-work-RJ000046"] input') as HTMLInputElement).click();
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
        (document.querySelector('[data-testid="search-work-RJ000047"] input') as HTMLInputElement).click();
        await flushPromises();

        input.value = 'second'; input.dispatchEvent(new Event('input', { bubbles: true }));
        await flushPromises();
        (document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).click();
        await vi.waitFor(() => expect(document.querySelector('[data-testid="search-work-RJ000048"]')).not.toBeNull());
        (document.querySelector('[data-testid="search-work-RJ000048"] input') as HTMLInputElement).click();
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
        await vi.waitFor(() => expect(document.querySelector('[data-testid="search-work-RJ000049"]')).not.toBeNull());
        (document.querySelector('[data-testid="search-work-RJ000049"] input') as HTMLInputElement).click();
        await vi.waitFor(() => expect(document.querySelector('[data-testid="search-work-RJ000049"]')?.textContent).toContain('at least 1 KB'));

        (document.querySelector('[data-testid="search-work-RJ000049"] input') as HTMLInputElement).click();
        (document.querySelector('[data-testid="search-work-RJ000049"] input') as HTMLInputElement).click();
        await flushPromises();

        expect(document.querySelector('[data-testid="search-work-RJ000049"]')?.textContent).toContain('at least 1 KB');
        expect(mocks.getTracks).toHaveBeenCalledTimes(1);
        wrapper.unmount();
    });

    it('replaces a bare unknown size with manifest file count and duration', async () => {
        mocks.searchWorks.mockResolvedValue({
            works: [{
                id: 490,
                title: 'Unknown manifest sizes',
                duration: 815,
                thumbnailCoverUrl: 'https://images.example.test/490.jpg',
                tags: [{ name: 'ASMR' }],
            }],
            pagination: { currentPage: 1, pageSize: 20, totalCount: 1 },
        });
        mocks.getTracks.mockResolvedValue([
            { type: 'audio', title: 'one.wav', mediaDownloadUrl: 'https://media.example.test/one.wav' },
            { type: 'audio', title: 'two.wav', mediaDownloadUrl: 'https://media.example.test/two.wav' },
            { type: 'image', title: 'cover.jpg', mediaDownloadUrl: 'https://media.example.test/cover.jpg' },
        ]);
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        const input = document.querySelector('[data-testid="search"]') as HTMLInputElement;
        input.value = 'unknown sizes';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await flushPromises();
        (document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).click();
        await vi.waitFor(() => expect(document.querySelector('[data-testid^="search-work-"]')).not.toBeNull());
        // Duration is available immediately; file counts arrive with the
        // manifest that selecting the row requests.
        expect(document.querySelector('[data-testid^="search-work-"]')?.textContent).toContain('13:35');
        (document.querySelector('[data-testid^="search-work-"] input') as HTMLInputElement).click();

        await vi.waitFor(() => {
            expect(document.querySelector('[data-testid^="search-work-"]')?.textContent)
                .toContain('13:35 · 3 files');
        });
        expect(document.querySelector('[data-testid^="search-work-"]')?.textContent)
            .not.toContain('size unavailable');
        wrapper.unmount();
    });

    it('never strands a row on Loading when the dialog closes mid-enrichment', async () => {
        const pending = deferred<any[]>();
        mocks.searchWorks.mockResolvedValue({
            works: [{ id: 50, title: 'Interrupted', duration: 60, thumbnailCoverUrl: 'https://images.example.test/50.jpg', tags: [{ name: 'Test' }] }],
            pagination: { currentPage: 1, pageSize: 20, totalCount: 1 },
        });
        mocks.getTracks.mockReturnValue(pending.promise);
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        const input = document.querySelector('[data-testid="search"]') as HTMLInputElement;
        input.value = 'queue'; input.dispatchEvent(new Event('input', { bubbles: true }));
        await flushPromises();
        (document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).click();
        await vi.waitFor(() => expect(document.querySelector('[data-testid="search-work-RJ000050"]')).not.toBeNull());
        (document.querySelector('[data-testid="search-work-RJ000050"] input') as HTMLInputElement).click();
        await vi.waitFor(() => expect(document.querySelector('[data-testid="search-work-RJ000050"]')?.textContent).toContain('Loading'));

        // Close the dialog mid-request, let it settle, then come back to the
        // same row: it must reach a terminal state instead of keeping the
        // spinner forever with no retry path.
        (document.querySelector('[data-testid="close"]') as HTMLButtonElement).click();
        await flushPromises();
        pending.resolve([]);
        await flushPromises();

        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        const reopened = document.querySelector('[data-testid="search"]') as HTMLInputElement;
        reopened.value = 'queue'; reopened.dispatchEvent(new Event('input', { bubbles: true }));
        await flushPromises();
        (document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).click();
        await vi.waitFor(() => expect(document.querySelector('[data-testid="search-work-RJ000050"]')).not.toBeNull());

        expect(document.querySelector('[data-testid="search-work-RJ000050"]')?.textContent).not.toContain('Loading');
        wrapper.unmount();
    });

    it('reads no file manifest for rows the user has not selected', async () => {
        mocks.searchWorks.mockResolvedValue({
            works: [60, 61, 62].map(id => ({
                id, title: `Work ${id}`, duration: 60,
                thumbnailCoverUrl: `https://images.example.test/${id}.jpg`, tags: [{ name: 'Test' }],
            })),
            pagination: { currentPage: 1, pageSize: 20, totalCount: 3 },
        });
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        const input = document.querySelector('[data-testid="search"]') as HTMLInputElement;
        input.value = 'queue'; input.dispatchEvent(new Event('input', { bubbles: true }));
        await flushPromises();
        (document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).click();
        await vi.waitFor(() => expect(document.querySelector('[data-testid="search-work-RJ000062"]')).not.toBeNull());
        await flushPromises();

        expect(mocks.getTracks).not.toHaveBeenCalled();
        (document.querySelector('[data-testid="search-work-RJ000061"] input') as HTMLInputElement).click();
        await flushPromises();
        expect(mocks.getTracks.mock.calls.map((call: unknown[]) => call[0])).toEqual(['RJ000061']);
        wrapper.unmount();
    });

    it('keeps semantic results when the live site search is unavailable', async () => {
        mocks.fetchOwn.mockResolvedValue([]);
        mocks.semanticSearch.mockResolvedValue(semanticPage([{ id: '44', title: '意味検索の結果', score: 0.8 }]));
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
        const semantic = deferred<SemanticPage>();
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
        semantic.resolve(semanticPage([{ id: '44', title: 'Later semantic result', score: 0.8 }]));
        await flushPromises();

        expect(document.querySelector('[data-testid="search-work-RJ000046"]')).not.toBeNull();
        expect(document.querySelector('[data-testid="search-work-RJ000044"]')).not.toBeNull();
        wrapper.unmount();
    });

    it('keeps searching when an empty live response arrives before a useful semantic answer', async () => {
        const semantic = deferred<SemanticPage>();
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
        semantic.resolve(semanticPage([{ id: '44', title: 'Semantic-only result', score: 0.8 }]));
        await flushPromises();

        expect(document.querySelector('[data-testid="search-work-RJ000044"]')).not.toBeNull();
        expect((document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).disabled).toBe(false);
        wrapper.unmount();
    });

    it('ignores a late semantic answer after a newer site query starts', async () => {
        const firstSemantic = deferred<SemanticPage>();
        mocks.fetchOwn.mockResolvedValue([]);
        mocks.semanticSearch
            .mockReturnValueOnce(firstSemantic.promise)
            .mockResolvedValueOnce(semanticPage([]));
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

        firstSemantic.resolve(semanticPage([{ id: '99', title: 'Stale semantic result', score: 0.9 }]));
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

    it('resumes an interrupted Opus job with original audio when requested', async () => {
        const job = {
            id: 'job-opus',
            title: 'Interrupted Opus download',
            status: 'failed',
            options: {
                state: {
                    selectedWorkIds: ['RJ123456'],
                    filters: { audio: true, video: true, image: true, text: true, other: true },
                    titleMode: 'original',
                    convertToOpus: true,
                    opusBitrate: 96,
                    metadataMode: 'additive',
                    includeArtwork: true,
                },
                directory: {},
                enrichment: {},
            },
            createdAt: 1,
            updatedAt: 1,
        };
        mocks.recover.mockResolvedValue([job]);
        mocks.runnerResume.mockResolvedValue({ jobId: job.id, skipped: 0 });
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await flushPromises();
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');

        (document.querySelector(
            '[data-testid="resume-without-opus-job-opus"]',
        ) as HTMLButtonElement).click();
        await flushPromises();

        expect(mocks.runnerResume).toHaveBeenCalledWith(
            job,
            expect.any(Function),
            { disableOpus: true },
        );
        wrapper.unmount();
    });

    it('offers an explicit original-title resume only for translation-blocked jobs', async () => {
        const blockedJob = {
            id: 'job-translation',
            title: 'Waiting for translated titles',
            status: 'paused',
            options: {
                state: {
                    selectedWorkIds: ['RJ123456'],
                    filters: { audio: true, video: true, image: true, text: true, other: true },
                    titleMode: 'original-bracketed-translation',
                    convertToOpus: false,
                    opusBitrate: 96,
                    metadataMode: 'additive',
                    includeArtwork: true,
                },
                directory: {},
                enrichment: {},
                discovery: {
                    works: [{ id: 'RJ123456', title: 'Original title' }],
                    nextIndex: 0,
                    skippedWorkIds: [],
                    titlesReady: false,
                    complete: false,
                },
            },
            createdAt: 1,
            updatedAt: 1,
        };
        const ordinaryJob = {
            ...blockedJob,
            id: 'job-files',
            title: 'Downloading files',
            options: {
                ...blockedJob.options,
                state: { ...blockedJob.options.state, titleMode: 'original' },
                discovery: { ...blockedJob.options.discovery, titlesReady: true },
            },
        };
        mocks.recover.mockResolvedValue([blockedJob, ordinaryJob]);
        mocks.runnerResume.mockResolvedValue({ jobId: blockedJob.id, skipped: 0 });
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await flushPromises();
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');

        expect(document.querySelector('[data-testid="resume-with-original-titles-job-files"]')).toBeNull();
        (document.querySelector(
            '[data-testid="resume-with-original-titles-job-translation"]',
        ) as HTMLButtonElement).click();
        await flushPromises();

        expect(mocks.runnerResume).toHaveBeenCalledWith(
            blockedJob,
            expect.any(Function),
            { useOriginalTitles: true },
        );
        wrapper.unmount();
    });

    it('presents unavailable title translation as a paused choice instead of a failed download', async () => {
        mocks.fetchOwn.mockResolvedValue([{
            id: 'mine',
            name: 'Mine',
            privacy: 0,
            works: ['RJ123456'],
            works_count: 1,
        }]);
        mocks.fetchPlaylist.mockResolvedValue({
            id: 'mine',
            name: 'Mine',
            description: '',
            worksCount: 1,
            works: [{ rjCode: 'RJ123456', title: 'Selected work' }],
        });
        mocks.runnerStart.mockImplementation(async (_works, _state, _directory, _title, onProgress) => {
            onProgress({
                jobId: 'job-translation',
                phase: 'translating',
                current: 0,
                total: 1,
            });
            const ErrorType = (await import('../../src/features/downloads/DownloadCenterRunner')).DownloadCenterRunError;
            throw new ErrorType('title-translation');
        });
        Object.defineProperty(window, 'showDirectoryPicker', {
            configurable: true,
            value: vi.fn(),
        });
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        (document.querySelector('[data-testid="source-own"]') as HTMLButtonElement).click();
        await flushPromises();
        (document.querySelector('[data-testid="playlist-check-mine"]') as HTMLInputElement).click();
        await flushPromises();
        (document.querySelector('[data-testid="start"]') as HTMLButtonElement).click();
        await flushPromises();

        expect(document.querySelector('[data-testid="download-error"]')?.textContent)
            .toContain('Title translation is still unavailable');
        expect(document.querySelector('[data-testid="download-error"]')?.textContent)
            .not.toContain('Work download failed');
        expect(document.querySelector('[data-testid="download-progress"]')?.textContent)
            .toContain('Download paused');
        expect(document.querySelector('[data-testid="progress-count"]')?.textContent)
            .toContain('0 / 1');
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

    it('keeps every live result and reports the real catalogue total', async () => {
        mocks.semanticSearch.mockResolvedValue(semanticPage([]));
        mocks.searchWorks.mockResolvedValue({
            works: Array.from({ length: 45 }, (_, index) => ({ id: 1000 + index, title: `Result ${index}` })),
            pagination: { currentPage: 1, pageSize: 45, totalCount: 1234 },
        });
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        const input = document.querySelector('[data-testid="search"]') as HTMLInputElement;
        input.value = 'many'; input.dispatchEvent(new Event('input', { bubbles: true }));
        await flushPromises();
        (document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).click();
        await flushPromises();

        // The old code truncated every result set to 30 rows and dropped the
        // reported total entirely.
        expect(document.querySelectorAll('[data-testid^="search-work-"]')).toHaveLength(45);
        expect(document.querySelector('[data-testid="search-result-count"]')?.textContent).toBe('Showing 45 of 1,234');
        expect(document.querySelector('[data-testid="load-more"]')).not.toBeNull();
        wrapper.unmount();
    });

    it('appends the next catalogue page without dropping the current selection', async () => {
        mocks.semanticSearch.mockResolvedValue(semanticPage([]));
        mocks.searchWorks
            .mockResolvedValueOnce({
                works: [{ id: 2001, title: 'Page one' }],
                pagination: { currentPage: 1, pageSize: 1, totalCount: 2 },
            })
            .mockResolvedValueOnce({
                works: [{ id: 2002, title: 'Page two' }],
                pagination: { currentPage: 2, pageSize: 1, totalCount: 2 },
            });
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        const input = document.querySelector('[data-testid="search"]') as HTMLInputElement;
        input.value = 'paged'; input.dispatchEvent(new Event('input', { bubbles: true }));
        await flushPromises();
        (document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).click();
        await vi.waitFor(() => expect(document.querySelector('[data-testid="search-work-RJ002001"]')).not.toBeNull());
        (document.querySelector('[data-testid="search-work-RJ002001"] input') as HTMLInputElement).click();
        await flushPromises();

        (document.querySelector('[data-testid="load-more"]') as HTMLButtonElement).click();
        await vi.waitFor(() => expect(document.querySelector('[data-testid="search-work-RJ002002"]')).not.toBeNull());

        expect(mocks.searchWorks).toHaveBeenLastCalledWith('paged', { page: 2, pageSize: 100, limit: 100 });
        expect(document.querySelector('[data-testid="search-work-RJ002001"]')).not.toBeNull();
        expect((document.querySelector('[data-testid="search-work-RJ002001"] input') as HTMLInputElement).checked).toBe(true);
        expect(document.querySelector('[data-testid="load-more"]')).toBeNull();
        wrapper.unmount();
    });

    it('still applies a load-more page when the other lane resolves mid-flight', async () => {
        // Regression: the guard compared BOTH lane refs, but searchAllWorks
        // merges the slower lane's first page in the background. That mutated
        // the other lane's ref and silently discarded a load-more that had
        // nothing to do with it — a dead click with no error and no spinner,
        // during the ordinary first-search window.
        let releaseSemanticFirstPage: (() => void) | undefined;
        mocks.searchWorks
            .mockResolvedValueOnce(worksPage([{ id: 2200, title: 'Live 1' }], 1, 900))
            .mockResolvedValueOnce(worksPage([{ id: 2201, title: 'Live 2' }], 2, 900));
        mocks.semanticSearch.mockImplementationOnce(() => new Promise(resolve => {
            releaseSemanticFirstPage = () => resolve(semanticPage([{ id: '7000', title: 'Sem 1', score: 0.9 }], 1));
        }));

        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        const input = document.querySelector('[data-testid="search"]') as HTMLInputElement;
        input.value = 'race'; input.dispatchEvent(new Event('input', { bubbles: true }));
        await flushPromises();
        (document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).click();
        await flushPromises();

        // Live landed first; the semantic lane is still in flight.
        (document.querySelector('[data-testid="load-more"]') as HTMLButtonElement)?.click();
        releaseSemanticFirstPage?.();
        await vi.waitFor(() => expect(document.querySelector('[data-testid="search-work-RJ002201"]')).not.toBeNull());

        // The requested page must actually render rather than be thrown away.
        expect(document.querySelector('[data-testid="search-work-RJ002201"]')).not.toBeNull();
        wrapper.unmount();
    });

    it('does not present a page-length fallback as an exact total', async () => {
        // readWorksTotalCount falls back to the page length when the API omits
        // pagination. Rendering that as "Showing 5 of 5" states a non-fact.
        mocks.searchWorks.mockResolvedValueOnce({ works: [{ id: 2300, title: 'No pagination' }] } as never);
        mocks.semanticSearch.mockResolvedValueOnce(semanticPage([], 0));
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        const input = document.querySelector('[data-testid="search"]') as HTMLInputElement;
        input.value = 'nototal'; input.dispatchEvent(new Event('input', { bubbles: true }));
        await flushPromises();
        (document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).click();
        await flushPromises();

        expect(document.querySelector('[data-testid="search-result-count"]')?.textContent).toBe('Showing 1');
        expect(document.querySelector('[data-testid="load-more"]')).not.toBeNull();
        wrapper.unmount();
    });

    it('never lets a later page shrink the reported total', async () => {
        // "Showing 3 of 900" must not become "Showing 6 of 6" on the next click.
        mocks.searchWorks
            .mockResolvedValueOnce(worksPage([{ id: 2400, title: 'A' }, { id: 2401, title: 'B' }, { id: 2402, title: 'C' }], 1, 900))
            .mockResolvedValueOnce({ works: [{ id: 2403, title: 'D' }, { id: 2404, title: 'E' }, { id: 2405, title: 'F' }] } as never);
        mocks.semanticSearch.mockResolvedValue(semanticPage([], 0));
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        const input = document.querySelector('[data-testid="search"]') as HTMLInputElement;
        input.value = 'monotonic'; input.dispatchEvent(new Event('input', { bubbles: true }));
        await flushPromises();
        (document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).click();
        await flushPromises();
        expect(document.querySelector('[data-testid="search-result-count"]')?.textContent).toBe('Showing 3 of 900');

        (document.querySelector('[data-testid="load-more"]') as HTMLButtonElement)?.click();
        await vi.waitFor(() => expect(document.querySelector('[data-testid="search-work-RJ002405"]')).not.toBeNull());

        expect(document.querySelector('[data-testid="search-result-count"]')?.textContent).toBe('Showing 6 of 900');
        wrapper.unmount();
    });

    it('reports the whole semantic match count and pages past the first page', async () => {
        const page = (start: number, size: number) => Array.from(
            { length: size },
            (_, index) => ({ id: String(5000 + start + index), title: `Semantic ${start + index}`, score: 0.9 }),
        );
        mocks.semanticSearch
            .mockResolvedValueOnce(semanticPage(page(0, 100), 512))
            .mockResolvedValueOnce(semanticPage(page(100, 100), 512));
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        const input = document.querySelector('[data-testid="search"]') as HTMLInputElement;
        input.value = 'meaning'; input.dispatchEvent(new Event('input', { bubbles: true }));
        await flushPromises();
        (document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).click();
        await flushPromises();

        // The old lane sliced its ranking to 200, discarded the match count and
        // offered no way to reach the rest, so the UI could only say "Showing 200".
        expect(document.querySelector('[data-testid="search-result-count"]')?.textContent).toBe('Showing 100 of 512');
        expect(document.querySelector('[data-testid="load-more"]')).not.toBeNull();

        (document.querySelector('[data-testid="load-more"]') as HTMLButtonElement).click();
        await vi.waitFor(() => expect(document.querySelector('[data-testid="search-work-RJ005100"]')).not.toBeNull());

        expect(mocks.semanticSearch).toHaveBeenLastCalledWith('meaning', { limit: 100, offset: 100 });
        expect(document.querySelectorAll('[data-testid^="search-work-"]')).toHaveLength(200);
        expect(document.querySelector('[data-testid="search-result-count"]')?.textContent).toBe('Showing 200 of 512');
        expect(document.querySelector('[data-testid="search-work-RJ005000"]')).not.toBeNull();
        wrapper.unmount();
    });

    it('pages both search lanes together, merging their overlap onto one row', async () => {
        mocks.searchWorks
            .mockResolvedValueOnce({
                works: [{ id: 6001, title: 'Live one' }],
                pagination: { currentPage: 1, pageSize: 1, totalCount: 3 },
            })
            .mockResolvedValueOnce({
                works: [{ id: 6002, title: 'Live two' }, { id: 6003, title: 'Live three' }],
                pagination: { currentPage: 2, pageSize: 2, totalCount: 3 },
            });
        mocks.semanticSearch
            .mockResolvedValueOnce(semanticPage([
                { id: '6001', title: 'Also live one', score: 0.9 },
                { id: '7001', title: 'Semantic only', score: 0.8 },
            ], 4))
            .mockResolvedValueOnce(semanticPage([
                { id: '6002', title: 'Also live two', score: 0.7 },
                { id: '7002', title: 'Semantic only two', score: 0.6 },
            ], 4));
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        const input = document.querySelector('[data-testid="search"]') as HTMLInputElement;
        input.value = 'both lanes'; input.dispatchEvent(new Event('input', { bubbles: true }));
        await flushPromises();
        (document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).click();
        await vi.waitFor(() => expect(document.querySelector('[data-testid="search-work-RJ007001"]')).not.toBeNull());
        (document.querySelector('[data-testid="search-work-RJ006001"] input') as HTMLInputElement).click();
        await flushPromises();

        // 3 live + 4 semantic with one duplicate already seen.
        expect(document.querySelectorAll('[data-testid^="search-work-"]')).toHaveLength(2);
        expect(document.querySelector('[data-testid="search-result-count"]')?.textContent).toBe('Showing 2 of about 6');

        (document.querySelector('[data-testid="load-more"]') as HTMLButtonElement).click();
        await vi.waitFor(() => expect(document.querySelector('[data-testid="search-work-RJ007002"]')).not.toBeNull());

        expect(mocks.searchWorks).toHaveBeenLastCalledWith('both lanes', { page: 2, pageSize: 100, limit: 100 });
        expect(mocks.semanticSearch).toHaveBeenLastCalledWith('both lanes', { limit: 100, offset: 2 });
        expect(document.querySelectorAll('[data-testid^="search-work-"]')).toHaveLength(5);
        expect(document.querySelector('[data-testid="search-result-count"]')?.textContent).toBe('Showing 5 of 5');
        expect((document.querySelector('[data-testid="search-work-RJ006001"] input') as HTMLInputElement).checked).toBe(true);
        expect(document.querySelector('[data-testid="load-more"]')).toBeNull();
        expect(document.querySelector('[data-testid="load-more-error"]')).toBeNull();
        wrapper.unmount();
    });

    it('names the total even when the first page already holds every match', async () => {
        mocks.semanticSearch.mockResolvedValue(semanticPage([
            { id: '8001', title: 'Only match', score: 0.9 },
            { id: '8002', title: 'Second match', score: 0.8 },
        ], 2));
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        const input = document.querySelector('[data-testid="search"]') as HTMLInputElement;
        input.value = 'narrow'; input.dispatchEvent(new Event('input', { bubbles: true }));
        await flushPromises();
        (document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).click();
        await flushPromises();

        expect(document.querySelector('[data-testid="search-result-count"]')?.textContent).toBe('Showing 2 of 2');
        expect(document.querySelector('[data-testid="load-more"]')).toBeNull();
        wrapper.unmount();
    });

    it('keeps a load-more page usable when only one lane fails', async () => {
        mocks.searchWorks
            .mockResolvedValueOnce({
                works: [{ id: 9001, title: 'Live one' }],
                pagination: { currentPage: 1, pageSize: 1, totalCount: 3 },
            })
            .mockRejectedValueOnce(new Error('catalogue unavailable'));
        mocks.semanticSearch
            .mockResolvedValueOnce(semanticPage([{ id: '9101', title: 'Semantic one', score: 0.9 }], 3))
            .mockResolvedValueOnce(semanticPage([{ id: '9102', title: 'Semantic two', score: 0.8 }], 3));
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        const input = document.querySelector('[data-testid="search"]') as HTMLInputElement;
        input.value = 'half broken'; input.dispatchEvent(new Event('input', { bubbles: true }));
        await flushPromises();
        (document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).click();
        await vi.waitFor(() => expect(document.querySelector('[data-testid="search-work-RJ009101"]')).not.toBeNull());

        (document.querySelector('[data-testid="load-more"]') as HTMLButtonElement).click();
        await vi.waitFor(() => expect(document.querySelector('[data-testid="search-work-RJ009102"]')).not.toBeNull());

        expect(document.querySelector('[data-testid="load-more-error"]')).toBeNull();
        // The failed lane keeps its unread pages, so the button stays available.
        expect(document.querySelector('[data-testid="load-more"]')).not.toBeNull();
        wrapper.unmount();
    });

    it('links each result row to its work page outside the selection control', async () => {
        mocks.semanticSearch.mockResolvedValue(semanticPage([]));
        mocks.searchWorks.mockResolvedValue({
            works: [{ id: 3001, title: 'Linked result' }],
            pagination: { currentPage: 1, pageSize: 1, totalCount: 1 },
        });
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        const input = document.querySelector('[data-testid="search"]') as HTMLInputElement;
        input.value = 'linked'; input.dispatchEvent(new Event('input', { bubbles: true }));
        await flushPromises();
        (document.querySelector('[data-testid="search-all-works"]') as HTMLButtonElement).click();
        await vi.waitFor(() => expect(document.querySelector('[data-testid="open-work-RJ003001"]')).not.toBeNull());

        const link = document.querySelector('[data-testid="open-work-RJ003001"]') as HTMLAnchorElement;
        expect(link.getAttribute('href')).toBe('/work/RJ003001');
        expect(link.target).toBe('_blank');
        expect(link.rel).toBe('noopener');
        // Outside the label so opening the work never toggles the checkbox.
        expect(link.closest('label')).toBeNull();
        link.click();
        await flushPromises();
        expect((document.querySelector('[data-testid="search-work-RJ003001"] input') as HTMLInputElement).checked).toBe(false);
        wrapper.unmount();
    });

    it('starts a staged download in a browser without a folder picker', async () => {
        mocks.supportsPicker.mockReturnValue(false);
        mocks.canCreateDestination.mockReturnValue(true);
        mocks.createDestination.mockResolvedValue({ kind: 'gm', subfolder: 'asmr-one-downloads' });
        mocks.runnerStart.mockResolvedValue({ jobId: 'job-firefox', skipped: 0, exportFailures: 0 });
        mocks.fetchOwn.mockResolvedValue([{ id: 'mine', name: 'Mine', privacy: 0, works: ['RJ123456'], works_count: 1 }]);
        mocks.fetchPlaylist.mockResolvedValue({
            id: 'mine', name: 'Mine', description: '', worksCount: 1,
            works: [{ rjCode: 'RJ123456', title: 'Selected work' }],
        });
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        (document.querySelector('[data-testid="source-own"]') as HTMLButtonElement).click();
        await flushPromises();
        expect(document.querySelector('[data-testid="staged-destination-hint"]')).not.toBeNull();
        (document.querySelector('[data-testid="playlist-check-mine"]') as HTMLInputElement).click();
        await flushPromises();
        (document.querySelector('[data-testid="start"]') as HTMLButtonElement).click();
        await flushPromises();

        expect(document.querySelector('[data-testid="download-error"]')).toBeNull();
        expect(mocks.runnerStart).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            { kind: 'gm', subfolder: 'asmr-one-downloads' },
            expect.any(String),
            expect.any(Function),
        );
        wrapper.unmount();
    });

    it('reports downloads as unsupported only when no destination can be built', async () => {
        mocks.canCreateDestination.mockReturnValue(false);
        mocks.supportsPicker.mockReturnValue(false);
        mocks.fetchOwn.mockResolvedValue([{ id: 'mine', name: 'Mine', privacy: 0, works: ['RJ123456'], works_count: 1 }]);
        mocks.fetchPlaylist.mockResolvedValue({
            id: 'mine', name: 'Mine', description: '', worksCount: 1,
            works: [{ rjCode: 'RJ123456', title: 'Selected work' }],
        });
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        (document.querySelector('[data-testid="source-own"]') as HTMLButtonElement).click();
        await flushPromises();
        (document.querySelector('[data-testid="playlist-check-mine"]') as HTMLInputElement).click();
        await flushPromises();
        (document.querySelector('[data-testid="start"]') as HTMLButtonElement).click();
        await flushPromises();

        expect(document.querySelector('[data-testid="download-error"]')?.textContent)
            .toContain('no writable download storage');
        expect(mocks.createDestination).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it('surfaces an unclassified failure cause instead of the bare failure wall', async () => {
        mocks.runnerStart.mockRejectedValue(new Error('IndexedDB is not available in this context'));
        mocks.fetchOwn.mockResolvedValue([{ id: 'mine', name: 'Mine', privacy: 0, works: ['RJ123456'], works_count: 1 }]);
        mocks.fetchPlaylist.mockResolvedValue({
            id: 'mine', name: 'Mine', description: '', worksCount: 1,
            works: [{ rjCode: 'RJ123456', title: 'Selected work' }],
        });
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        (document.querySelector('[data-testid="source-own"]') as HTMLButtonElement).click();
        await flushPromises();
        (document.querySelector('[data-testid="playlist-check-mine"]') as HTMLInputElement).click();
        await flushPromises();
        (document.querySelector('[data-testid="start"]') as HTMLButtonElement).click();
        await flushPromises();

        expect(document.querySelector('[data-testid="download-error"]')?.textContent)
            .toContain('IndexedDB is not available');
        wrapper.unmount();
    });

    it('reports work folders the browser refused to receive', async () => {
        mocks.runnerStart.mockResolvedValue({ jobId: 'job-export', skipped: 0, exportFailures: 2 });
        mocks.fetchOwn.mockResolvedValue([{ id: 'mine', name: 'Mine', privacy: 0, works: ['RJ123456'], works_count: 1 }]);
        mocks.fetchPlaylist.mockResolvedValue({
            id: 'mine', name: 'Mine', description: '', worksCount: 1,
            works: [{ rjCode: 'RJ123456', title: 'Selected work' }],
        });
        const wrapper = mount(DownloadCenter, { attachTo: document.body });
        await wrapper.get('[data-testid="download-center-open"]').trigger('click');
        (document.querySelector('[data-testid="source-own"]') as HTMLButtonElement).click();
        await flushPromises();
        (document.querySelector('[data-testid="playlist-check-mine"]') as HTMLInputElement).click();
        await flushPromises();
        (document.querySelector('[data-testid="start"]') as HTMLButtonElement).click();
        await flushPromises();

        expect(document.querySelector('[data-testid="download-progress"]')?.textContent)
            .toContain('2 work folders could not be handed to the browser');
        wrapper.unmount();
    });

    it('deduplicates the same work across playlist and direct-search ID shapes', async () => {
        mocks.fetchOwn.mockResolvedValue([]);
        mocks.fetchPlaylist.mockResolvedValue({
            id: '11111111-1111-4111-8111-111111111111', name: 'Cached public', description: '', worksCount: 1,
            works: [{ rjCode: 'RJ000042', title: 'Playlist title' }],
        });
        mocks.semanticSearch.mockResolvedValue(semanticPage([{ id: 'RJ000042', title: 'Search title', score: 0.8 }]));
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
