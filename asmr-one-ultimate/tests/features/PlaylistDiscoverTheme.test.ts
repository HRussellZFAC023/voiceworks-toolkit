import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const playlist = {
    id: 'playlist-theme',
    name: 'Theme Playlist',
    user_name: 'User',
    worksCount: 1,
    coverUrl: '',
    tags: [],
};

vi.mock('../../src/composables/useI18n', () => ({
    useI18n: () => ({ t: (key: string) => key, format: (key: string) => key }),
}));
vi.mock('../../src/composables/useBridge', () => ({
    useBridge: () => ({ router: { push: vi.fn() } }),
}));
vi.mock('../../src/core/Utils', () => ({
    Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/scrapers/GooglePlaylistScraper', () => ({
    GooglePlaylistScraper: {
        safeGetValue: vi.fn(() => false),
        safeSetValue: vi.fn(),
    },
}));
vi.mock('../../src/features/playlist/PlaylistDiscoveryService', () => ({
    PlaylistDiscoveryService: {
        getInstance: () => ({
            discoveredCount: 1,
            isGoogleRateLimited: false,
            getDiscoveredIds: () => ['playlist-theme'],
            loadCommunityCatalog: async () => [],
            getCachedMetadata: () => playlist,
            isFailed: () => false,
            isTransientFailed: () => false,
            isRateLimitedNow: () => false,
            fetchMetadataBatch: async function* () {},
            fetchMetadata: vi.fn(),
            triggerGoogleSearch: vi.fn(),
            addManualPlaylist: () => null,
            submitCommunityPlaylist: vi.fn(),
        }),
    },
}));

import PlaylistDiscoverSection from '../../src/features/components/PlaylistDiscoverSection.vue';

describe('PlaylistDiscoverSection reactive theme', () => {
    beforeEach(() => {
        document.body.className = '';
    });

    afterEach(() => {
        document.body.innerHTML = '';
        document.body.className = '';
    });

    it('updates card theme classes in both directions when the host body changes', async () => {
        const wrapper = mount(PlaylistDiscoverSection, { attachTo: document.body });
        await flushPromises();
        const card = () => wrapper.find('#public-playlists-grid .q-card');
        expect(card().exists()).toBe(true);
        expect(card().classes()).not.toContain('q-dark');

        document.body.classList.add('body--dark');
        await new Promise(resolve => setTimeout(resolve, 0));
        await nextTick();
        expect(card().classes()).toContain('q-dark');

        document.body.classList.remove('body--dark');
        await new Promise(resolve => setTimeout(resolve, 0));
        await nextTick();
        expect(card().classes()).not.toContain('q-dark');
        wrapper.unmount();
    });
});
