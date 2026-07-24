import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import BackupWorkDownloader from '../../src/features/components/BackupWorkDownloader.vue';
import type { BackupDownloadProfile, BackupDownloaderLabels, BackupWorkDownloadItem } from '../../src/features/backupWorkDownloaderTypes';

const labels: BackupDownloaderLabels = {
    dialogTitle: 'Download collection', close: 'Close', search: 'Find works', searchPlaceholder: 'Search',
    searchAll: 'Search all works', searchAllLoading: 'Searching', searchResults: 'Search results', searchFailed: 'Search failed',
    playlistSource: 'Playlist source', sourceAll: 'All', sourceOwn: 'My playlists', sourcePublic: 'Community playlists',
    selectAll: 'Select all shown', clearAll: 'Clear all', filterTags: 'Tags', allTags: 'All tags',
    playlistOwner: 'by {owner}', playlistWorks: '{count} works', loading: 'Loading', loadFailed: 'Unavailable',
    options: 'Options', progress: 'Progress', pause: 'Pause', resume: 'Resume', resumeWithoutOpus: 'Resume without Opus', alreadyRunning: 'Already running', resumableDownloads: 'Resume jobs',
    expandPlaylist: 'Expand', collapsePlaylist: 'Collapse', selectedSummary: '{count} selected · {bytes}',
    unknownSize: 'size unavailable', partialSize: 'at least {size}', estimatedOpusSize: 'about {size} after Opus', noResults: 'No results', fileTypes: 'Files', audio: 'Audio', video: 'Video',
    images: 'Images', text: 'Text', other: 'Other', filenameTitle: 'Titles', titleOriginal: 'Original',
    titleTranslated: 'Translated', titleOriginalTranslated: 'Original [Translated]', titleNone: 'No title changes',
    convertToOpus: 'Convert to Opus', convertToOpusMemoryWarning: 'Large sources stay original.', opusBitrate: 'Bitrate', metadata: 'Metadata', metadataAdditive: 'Additive',
    metadataOverwrite: 'Overwrite', metadataAdditiveHint: 'Keep existing values.', metadataOverwriteHint: 'Replace values.',
    includeArtwork: 'Add missing artwork', includeArtworkHint: 'Existing artwork remains.', cancel: 'Cancel', start: 'Start',
};

function profile(overrides: Partial<BackupDownloadProfile> = {}): BackupDownloadProfile {
    return {
        labels, selectedWorkIds: [],
        filters: { audio: true, video: false, image: true, text: true, other: false },
        titleMode: 'original-bracketed-translation', convertToOpus: false, opusBitrate: 128,
        metadataMode: 'additive', includeArtwork: true, ...overrides,
    };
}

const works = [
    { id: 1, title: '作品一', translatedTitle: 'Work One', sizeBytes: 1024, durationSeconds: 600, playlistIds: ['p1'] },
    { id: 2, title: '作品二', translatedTitle: 'Work Two', sizeBytes: 2048, playlistIds: ['p1'] },
];
const playlists = [{
    id: 'p1', title: 'Favorites', source: 'own' as const, workIds: [1, 2], worksCount: 2,
    owner: 'Alice', coverUrl: 'https://example.test/cover.jpg', tags: ['ASMR'],
}];

describe('BackupWorkDownloader', () => {
    it('defaults to Site and keeps playlists isolated in Yours and Community', async () => {
        const wrapper = mount(BackupWorkDownloader, {
            props: { playlists: [...playlists, { id: 'p2', title: 'Public', source: 'public', worksCount: 1 }], works, profile: profile() },
        });
        expect(wrapper.get('[data-testid="source-site"]').attributes('aria-selected')).toBe('true');
        expect(wrapper.find('[data-testid="playlist-p1"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="playlist-p2"]').exists()).toBe(false);
        await wrapper.get('[data-testid="source-own"]').trigger('click');
        expect(wrapper.emitted('sourceChange')?.at(-1)).toEqual(['own']);
        expect(wrapper.find('[data-testid="playlist-p1"]').exists()).toBe(true);
        await wrapper.get('[data-testid="source-public"]').trigger('click');
        expect(wrapper.emitted('sourceChange')?.at(-1)).toEqual(['public']);
        expect(wrapper.find('[data-testid="playlist-p2"]').exists()).toBe(true);
    });

    it('renders a fixed thumbnail, owner/count metadata, and tag filtering', async () => {
        const wrapper = mount(BackupWorkDownloader, { props: { playlists, works, profile: profile() } });
        await wrapper.get('[data-testid="source-own"]').trigger('click');
        const image = wrapper.get('.playlist-cover img');
        expect(image.attributes('src')).toContain('cover.jpg');
        expect(wrapper.get('.playlist-copy').text()).toContain('by Alice');
        expect(wrapper.get('.playlist-copy').text()).toContain('2 works');
        expect(wrapper.get('[data-testid="tag-filter"] option').text()).toBe('All tags');
        await wrapper.get('[data-testid="tag-filter"]').setValue('ASMR');
        expect(wrapper.find('[data-testid="playlist-p1"]').exists()).toBe(true);
    });

    it('resolves playlist works only on expand/select and supports clear all', async () => {
        const lazyPlaylist = [{ id: 'lazy', title: 'Lazy', source: 'own' as const, worksCount: 1 }];
        const mutableWorks: BackupWorkDownloadItem[] = [];
        const resolvePlaylist = vi.fn(async (playlist: typeof lazyPlaylist[number]) => {
            mutableWorks.push({ id: 9, title: 'Nine', sizeBytes: 9, playlistIds: ['lazy'] });
            await (wrapper as any).setProps({
                works: mutableWorks,
                playlists: [{ ...playlist, workIds: [9] }],
            });
        });
        const wrapper = mount(BackupWorkDownloader, { props: { playlists: lazyPlaylist, works: mutableWorks, profile: profile(), resolvePlaylist } });
        await wrapper.get('[data-testid="source-own"]').trigger('click');
        expect(resolvePlaylist).not.toHaveBeenCalled();
        await wrapper.get('[data-testid="expand-lazy"]').trigger('click');
        await vi.waitFor(() => expect(resolvePlaylist).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(wrapper.find('[data-testid="work-9"]').exists()).toBe(true));
        await wrapper.get('[data-testid="playlist-check-lazy"]').setValue(true);
        expect(wrapper.emitted('update')?.at(-1)?.[0]).toMatchObject({ selectedWorkIds: [9] });
        await wrapper.get('[data-testid="clear-all"]').trigger('click');
        expect(wrapper.emitted('update')?.at(-1)?.[0]).toMatchObject({ selectedWorkIds: [] });
    });

    it('shows meaning-based results whose title does not literally contain the query', async () => {
        const searchAllWorks = vi.fn(async () => {
            await (wrapper as any).setProps({ works: [...works, { id: 99, title: '添い寝音声', directSearchResult: true }] });
        });
        const wrapper = mount(BackupWorkDownloader, { props: { playlists, works, profile: profile(), searchAllWorks } });
        await wrapper.get('[data-testid="search"]').setValue('sleepy comfort');
        await wrapper.get('[data-testid="search-all-works"]').trigger('click');
        await vi.waitFor(() => expect(searchAllWorks).toHaveBeenCalledWith('sleepy comfort'));
        expect(wrapper.get('[data-testid="all-work-results"]').text()).toContain('添い寝音声');
        await wrapper.get('[data-testid="search-work-99"] input').setValue(true);
        expect(wrapper.emitted('update')?.at(-1)?.[0]).toMatchObject({ selectedWorkIds: [99] });
    });

    it('renders site covers and recalculates manifest bytes when file filters change', async () => {
        const result: BackupWorkDownloadItem = {
            id: 'RJ99', title: 'Covered work', coverUrl: 'https://example.test/work.jpg', directSearchResult: true,
            sizeBytes: 1.5 * 1024 * 1024, sizeBytesByType: { audio: 1024 * 1024, image: 512 * 1024 }, sizeState: 'resolved',
        };
        const searchAllWorks = vi.fn(async () => { await (wrapper as any).setProps({ works: [result] }); });
        const wrapper = mount(BackupWorkDownloader, { props: { playlists: [], works: [], profile: profile(), searchAllWorks } });
        await wrapper.get('[data-testid="search"]').setValue('covered');
        await wrapper.get('[data-testid="search-all-works"]').trigger('click');
        await vi.waitFor(() => expect(wrapper.find('[data-testid="search-work-RJ99"]').exists()).toBe(true));

        expect(wrapper.get('[data-testid="search-work-RJ99"] .work-cover img').attributes('src')).toBe('https://example.test/work.jpg');
        expect(wrapper.get('[data-testid="search-work-RJ99"] .work-size').text()).toBe('1.5 MB');
        await wrapper.get('[data-testid="file-filter-image"]').setValue(false);
        expect(wrapper.get('[data-testid="search-work-RJ99"] .work-size').text()).toBe('1 MB');
    });

    it('labels incomplete manifest totals only when an enabled category is incomplete', async () => {
        const result: BackupWorkDownloadItem = {
            id: 'RJ98', title: 'Partial work', directSearchResult: true,
            sizeBytes: 1024 * 1024, sizeBytesByType: { audio: 1024 * 1024 },
            unknownSizeCountByType: { image: 1 }, sizeState: 'partial',
        };
        const searchAllWorks = vi.fn(async () => { await (wrapper as any).setProps({ works: [result] }); });
        const wrapper = mount(BackupWorkDownloader, { props: { playlists: [], works: [], profile: profile(), searchAllWorks } });
        await wrapper.get('[data-testid="search"]').setValue('partial');
        await wrapper.get('[data-testid="search-all-works"]').trigger('click');
        await vi.waitFor(() => expect(wrapper.find('[data-testid="search-work-RJ98"]').exists()).toBe(true));

        expect(wrapper.get('[data-testid="search-work-RJ98"] .work-size').text()).toBe('at least 1 MB');
        await wrapper.get('[data-testid="file-filter-image"]').setValue(false);
        expect(wrapper.get('[data-testid="search-work-RJ98"] .work-size').text()).toBe('1 MB');
        await wrapper.get('[data-testid="file-filter-audio"]').setValue(false);
        await wrapper.get('[data-testid="file-filter-image"]').setValue(true);
        expect(wrapper.get('[data-testid="search-work-RJ98"] .work-size').text()).toBe('size unavailable');
    });

    it('hides results from the previous query until the next search completes', async () => {
        const searchAllWorks = vi.fn(async (query: string) => {
            const direct = query === 'first' ? [{ id: 'RJ9', title: 'First result', directSearchResult: true }] : [];
            await (wrapper as any).setProps({ works: direct });
        });
        const wrapper = mount(BackupWorkDownloader, { props: { playlists: [], works: [], profile: profile(), searchAllWorks } });
        await wrapper.get('[data-testid="search"]').setValue('first');
        await wrapper.get('[data-testid="search-all-works"]').trigger('click');
        await vi.waitFor(() => expect(wrapper.find('[data-testid="search-work-RJ9"]').exists()).toBe(true));

        await wrapper.get('[data-testid="search"]').setValue('second');
        expect(wrapper.find('[data-testid="search-work-RJ9"]').exists()).toBe(false);
        await wrapper.get('[data-testid="search-all-works"]').trigger('click');
        await vi.waitFor(() => expect(searchAllWorks).toHaveBeenLastCalledWith('second'));
        expect(wrapper.find('[data-testid="search-work-RJ9"]').exists()).toBe(false);
    });

    it('selects standalone direct-search results even when no playlist row is visible', async () => {
        const searchAllWorks = vi.fn(async () => {
            await (wrapper as any).setProps({ works: [{ id: 'RJ9', title: 'Direct only', directSearchResult: true }] });
        });
        const wrapper = mount(BackupWorkDownloader, { props: { playlists: [], works: [], profile: profile(), searchAllWorks } });
        await wrapper.get('[data-testid="search"]').setValue('direct');
        await wrapper.get('[data-testid="search-all-works"]').trigger('click');
        await vi.waitFor(() => expect(wrapper.find('[data-testid="search-work-RJ9"]').exists()).toBe(true));

        expect(wrapper.get('[data-testid="select-all"]').attributes('disabled')).toBeUndefined();
        await wrapper.get('[data-testid="select-all"]').trigger('click');

        expect(wrapper.emitted('update')?.at(-1)?.[0]).toMatchObject({ selectedWorkIds: ['RJ9'] });
    });

    it('shows a localized inline error when direct search fails', async () => {
        const wrapper = mount(BackupWorkDownloader, {
            props: { playlists: [], works: [], profile: profile(), searchAllWorks: vi.fn().mockRejectedValue(new Error('offline')) },
        });
        await wrapper.get('[data-testid="search"]').setValue('anything');
        await wrapper.get('[data-testid="search-all-works"]').trigger('click');
        await vi.waitFor(() => expect(wrapper.get('[data-testid="all-work-search-error"]').text()).toBe('Search failed'));
    });

    it('keeps progress and resume actions inside the open panel', async () => {
        const wrapper = mount(BackupWorkDownloader, {
            props: {
                playlists, works, profile: profile({ selectedWorkIds: [1] }), busy: true,
                progress: { phase: 'downloading', current: 3, total: 10, label: 'track.opus' },
                resumableJobs: [{ id: 'job-1', title: 'Yesterday' }],
            },
        });
        expect(wrapper.get('[data-testid="download-progress"]').text()).toContain('3 / 10');
        expect(wrapper.get('.progress-track > div').attributes('style')).toContain('30%');
        await wrapper.get('[data-testid="pause"]').trigger('click');
        expect(wrapper.emitted('pause')).toHaveLength(1);
        expect(wrapper.get('[data-testid="resume-job-1"]').attributes('disabled')).toBeDefined();
        await wrapper.get('[data-testid="close"]').trigger('click');
        expect(wrapper.emitted('close')).toHaveLength(1);
    });

    it('offers an explicit original-audio resume for interrupted Opus jobs', async () => {
        const wrapper = mount(BackupWorkDownloader, {
            props: {
                playlists,
                works,
                profile: profile({ selectedWorkIds: [1] }),
                resumableJobs: [{ id: 'job-opus', title: 'Interrupted', convertToOpus: true }],
            },
        });

        await wrapper.get('[data-testid="resume-without-opus-job-opus"]').trigger('click');

        expect(wrapper.emitted('resumeWithoutOpus')).toEqual([['job-opus']]);
        expect(wrapper.get('[data-testid="resume-without-opus-job-opus"]').text()).toBe('Resume without Opus');
    });

    it('shows incremental Opus conversion progress and keeps pause available', () => {
        const wrapper = mount(BackupWorkDownloader, {
            props: {
                playlists, works, profile: profile({ selectedWorkIds: [1] }), busy: true,
                progress: { phase: 'converting', current: 2, total: 4, conversionRatio: 0.5, label: 'Converting to Opus… 50%' },
            },
        });

        expect(wrapper.get('[data-testid="download-progress"] p').text()).toContain('50%');
        expect(wrapper.get('.progress-track > div').attributes('style')).toContain('62.5%');
        expect(wrapper.find('[data-testid="pause"]').exists()).toBe(true);
    });

    it.each(['recovering', 'discovering', 'translating', 'downloading', 'converting'] as const)(
        'offers pause throughout the active %s phase',
        phase => {
            const wrapper = mount(BackupWorkDownloader, {
                props: {
                    playlists, works, profile: profile({ selectedWorkIds: [1] }), busy: true,
                    progress: { phase, current: 0, total: 2, label: phase },
                },
            });

            expect(wrapper.find('[data-testid="pause"]').exists()).toBe(true);
        },
    );

    it('keeps source and job errors outside progress and never prints 0 / 0', async () => {
        const wrapper = mount(BackupWorkDownloader, {
            props: {
                playlists: [], works: [], profile: profile(), ownLoadFailed: true,
                errorMessage: 'Folder access is unavailable',
                progress: { phase: 'failed', current: 0, total: 0, label: 'Stopped' },
            },
        });

        await wrapper.get('[data-testid="source-own"]').trigger('click');
        expect(wrapper.get('[data-testid="source-load-error"]').text()).toBe('Unavailable');
        expect(wrapper.get('[data-testid="download-error"]').text()).toContain('Folder access is unavailable');
        expect(wrapper.find('[data-testid="progress-count"]').exists()).toBe(false);
        expect(wrapper.get('[data-testid="download-progress"]').text()).not.toContain('0 / 0');
    });

    it('uses duration and selected bitrate for Opus size estimates', async () => {
        const wrapper = mount(BackupWorkDownloader, {
            props: { playlists, works, profile: profile({ selectedWorkIds: [1], convertToOpus: true, opusBitrate: 128 }) },
        });
        await wrapper.get('[data-testid="source-own"]').trigger('click');
        await wrapper.get('[data-testid="expand-p1"]').trigger('click');

        expect(wrapper.get('[data-testid="work-1"] .work-size').text()).toMatch(/about 9\.3 MB after Opus/);
        expect(wrapper.get('[data-testid="selection-summary"]').text()).toMatch(/about 9\.3 MB after Opus/);
        await wrapper.get('[data-testid="opus-bitrate"]').setValue('64');
        expect(wrapper.get('[data-testid="work-1"] .work-size').text()).toMatch(/about 4\.7 MB after Opus/);
    });

    it('uses a real options-content stack and has no backup-import control', async () => {
        const wrapper = mount(BackupWorkDownloader, { props: { playlists, works, profile: profile() } });

        expect(wrapper.find('.download-options-content').exists()).toBe(true);
        expect(wrapper.get('[data-testid="opus-option"]').classes()).toContain('option-row');
        expect(wrapper.get('[data-testid="opus-memory-warning"]').text()).toBe('Large sources stay original.');
        expect(wrapper.get('[data-testid="artwork-option"]').classes()).toContain('hinted-option');
        expect(wrapper.find('[data-testid="download-center-import-input"]').exists()).toBe(false);
    });

    it('keeps dark-theme contrast local to the dialog and follows host theme changes', async () => {
        document.body.classList.add('body--dark');
        const wrapper = mount(BackupWorkDownloader, { props: { playlists, works, profile: profile() } });
        try {
            await vi.waitFor(() => expect(wrapper.get('.backup-downloader').classes()).toContain('theme-dark'));
            expect(document.body.classList).not.toContain('theme-dark');

            document.body.classList.remove('body--dark');
            await vi.waitFor(() => expect(wrapper.get('.backup-downloader').classes()).not.toContain('theme-dark'));
        } finally {
            wrapper.unmount();
            document.body.classList.remove('body--dark');
        }
    });

    it('emits the safe download options and never closes itself on start', async () => {
        const wrapper = mount(BackupWorkDownloader, { props: { playlists, works, profile: profile({ selectedWorkIds: [1] }) } });
        await wrapper.get('[data-testid="opus-toggle"]').setValue(true);
        await wrapper.get('[data-testid="opus-bitrate"]').setValue('160');
        await wrapper.get('[data-testid="start"]').trigger('click');
        expect(wrapper.emitted('start')?.[0]?.[0]).toMatchObject({ selectedWorkIds: [1], convertToOpus: true, opusBitrate: 160, metadataMode: 'additive', includeArtwork: true });
        expect(wrapper.emitted('close')).toBeUndefined();
    });
});
