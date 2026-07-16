import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    fetchMetadataBatch: vi.fn(),
    fetchMetadata: vi.fn(),
    triggerGoogleSearch: vi.fn(),
    routerPush: vi.fn(),
}));

vi.mock('../../src/composables/useI18n', () => ({
    useI18n: () => ({ t: (key: string) => key, format: (key: string) => key }),
}));
vi.mock('../../src/composables/useBridge', () => ({
    useBridge: () => ({ router: { push: mocks.routerPush } }),
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
            getDiscoveredIds: () => ['playlist-a'],
            loadCommunityCatalog: async () => [],
            getCachedMetadata: () => null,
            isFailed: () => false,
            isTransientFailed: () => false,
            isRateLimitedNow: () => false,
            fetchMetadataBatch: mocks.fetchMetadataBatch,
            fetchMetadata: mocks.fetchMetadata,
            triggerGoogleSearch: mocks.triggerGoogleSearch,
            addManualPlaylist: () => null,
            submitCommunityPlaylist: vi.fn(),
        }),
    },
}));

import PlaylistDiscoverSection from '../../src/features/components/PlaylistDiscoverSection.vue';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => { resolve = res; });
    return { promise, resolve };
}

describe('PlaylistDiscoverSection async lifecycle', () => {
    beforeEach(() => {
        mocks.fetchMetadataBatch.mockReset();
        mocks.fetchMetadata.mockReset();
        mocks.triggerGoogleSearch.mockReset();
        mocks.routerPush.mockReset();
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('stops consuming a deferred metadata batch after unmount', async () => {
        const gate = deferred();
        const idRead = vi.fn(() => 'playlist-a');
        const metadata = {
            get id() { return idRead(); },
            name: 'Playlist A',
            user_name: 'User',
            worksCount: 1,
            tags: [],
        };
        mocks.fetchMetadataBatch.mockImplementation(async function* () {
            await gate.promise;
            yield metadata;
        });

        const wrapper = mount(PlaylistDiscoverSection, { attachTo: document.body });
        await vi.waitFor(() => expect(mocks.fetchMetadataBatch).toHaveBeenCalledTimes(1));
        wrapper.unmount();
        gate.resolve();
        await flushPromises();

        expect(idRead).not.toHaveBeenCalled();
    });
});
