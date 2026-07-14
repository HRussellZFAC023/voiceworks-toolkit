import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import BackupWorkDownloader from '../../src/features/components/BackupWorkDownloader.vue';
import type {
    BackupDownloadProfile,
    BackupDownloaderLabels,
} from '../../src/features/backupWorkDownloaderTypes';

const labels: BackupDownloaderLabels = {
    dialogTitle: 'Download collection', close: 'Close', search: 'Find works', searchPlaceholder: 'Search',
    expandPlaylist: 'Expand', collapsePlaylist: 'Collapse', selectedSummary: '{count} selected · {bytes}',
    unknownSize: 'unknown size', noResults: 'No results', fileTypes: 'Files', audio: 'Audio', video: 'Video',
    images: 'Images', text: 'Text', other: 'Other', filenameTitle: 'Titles', titleOriginal: 'Original',
    titleTranslated: 'Translated', titleOriginalTranslated: 'Original [Translated]', titleNone: 'No title changes',
    convertToOpus: 'Convert to Opus', opusBitrate: 'Bitrate', metadata: 'Metadata', metadataAdditive: 'Additive',
    metadataOverwrite: 'Overwrite', metadataAdditiveHint: 'Keep existing values.', metadataOverwriteHint: 'Replace values.',
    includeArtwork: 'Add missing artwork', includeArtworkHint: 'Existing artwork remains.', cancel: 'Cancel', start: 'Start',
};

function profile(overrides: Partial<BackupDownloadProfile> = {}): BackupDownloadProfile {
    return {
        labels,
        selectedWorkIds: [],
        filters: { audio: true, video: false, image: true, text: true, other: false },
        titleMode: 'original-bracketed-translation',
        convertToOpus: false,
        opusBitrate: 128,
        metadataMode: 'additive',
        includeArtwork: true,
        ...overrides,
    };
}

const playlists = [{ id: 'p1', title: 'Favorites', workIds: [1, 2] }];
const works = [
    { id: 1, title: '作品一', translatedTitle: 'Work One', sizeBytes: 1024 },
    { id: 2, title: '作品二', translatedTitle: 'Work Two', sizeBytes: 2048 },
];

describe('BackupWorkDownloader', () => {
    it('supports tri-state playlist and per-work selection', async () => {
        const wrapper = mount(BackupWorkDownloader, { props: { playlists, works, profile: profile() } });
        const playlistCheck = wrapper.get('[data-testid="playlist-check-p1"]');

        expect((playlistCheck.element as HTMLInputElement).indeterminate).toBe(false);
        await wrapper.get('[data-testid="expand-p1"]').trigger('click');
        await wrapper.get('[data-testid="work-1"] input').setValue(true);
        expect((playlistCheck.element as HTMLInputElement).indeterminate).toBe(true);
        expect(wrapper.get('[data-testid="selection-summary"]').text()).toContain('1 selected · 1 KB');

        await playlistCheck.setValue(true);
        expect(wrapper.emitted('update')?.at(-1)?.[0]).toMatchObject({ selectedWorkIds: [1, 2] });
        expect(wrapper.get('[data-testid="start"]').attributes('disabled')).toBeUndefined();
    });

    it('searches original and translated titles and exposes expansion state', async () => {
        const wrapper = mount(BackupWorkDownloader, { props: { playlists, works, profile: profile() } });
        expect(wrapper.find('[data-testid="work-1"]').exists()).toBe(false);
        await wrapper.get('[data-testid="expand-p1"]').trigger('click');
        expect(wrapper.get('[data-testid="expand-p1"]').attributes('aria-expanded')).toBe('true');

        await wrapper.get('[data-testid="search"]').setValue('work two');
        expect(wrapper.find('[data-testid="work-1"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="work-2"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="expand-p1"]').exists()).toBe(false);
        expect(wrapper.find('#backup-playlist-p1').exists()).toBe(true);

        await wrapper.get('[data-testid="search"]').setValue('Favorites');
        expect(wrapper.find('[data-testid="work-1"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="work-2"]').exists()).toBe(true);

        await wrapper.get('[data-testid="search"]').setValue('2');
        expect(wrapper.find('[data-testid="work-1"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="work-2"]').exists()).toBe(true);
    });

    it('does not mount collapsed work rows for very large backups', () => {
        const manyWorks = Array.from({ length: 1_000 }, (_, index) => ({ id: index, title: `Work ${index}` }));
        const manyPlaylists = Array.from({ length: 100 }, (_, index) => ({
            id: `p${index}`, title: `Playlist ${index}`, workIds: manyWorks.slice(index * 10, index * 10 + 10).map(work => work.id),
        }));
        const wrapper = mount(BackupWorkDownloader, { props: { playlists: manyPlaylists, works: manyWorks, profile: profile() } });
        expect(wrapper.findAll('.playlist-group')).toHaveLength(100);
        expect(wrapper.findAll('.work-row')).toHaveLength(0);
    });

    it('focuses the search field and closes with Escape', async () => {
        const wrapper = mount(BackupWorkDownloader, { attachTo: document.body, props: { playlists, works, profile: profile() } });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(document.activeElement).toBe(wrapper.get('[data-testid="search"]').element);
        await wrapper.get('[role="dialog"]').trigger('keydown', { key: 'Escape' });
        expect(wrapper.emitted('close')).toHaveLength(1);
        wrapper.unmount();
    });

    it('emits complete settings without permitting an empty start', async () => {
        const wrapper = mount(BackupWorkDownloader, {
            props: { playlists, works, profile: profile({ selectedWorkIds: [1] }) },
        });

        await wrapper.get('[data-testid="opus-toggle"]').setValue(true);
        await wrapper.get('[data-testid="opus-bitrate"]').setValue('160');
        await wrapper.get('[data-testid="title-mode"]').setValue('translated');
        await wrapper.get('[data-testid="start"]').trigger('click');

        expect(wrapper.emitted('start')?.[0]?.[0]).toMatchObject({
            selectedWorkIds: [1], convertToOpus: true, opusBitrate: 160, titleMode: 'translated',
            metadataMode: 'additive', includeArtwork: true,
        });
    });
});
