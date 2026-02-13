/**
 * PlaylistDiscoverController — FeatureController for the collapsible
 * "Discover Public Playlists" section on the /playlists page.
 *
 * Appends BELOW the native grid so native search, filter, and pagination
 * remain fully functional.
 */

import { type Component } from 'vue';
import { FeatureController } from './FeatureController';
import { AppStore } from '../store/AppStore';
import PlaylistDiscoverSection from './components/PlaylistDiscoverSection.vue';

export class PlaylistDiscoverController extends FeatureController {
    constructor() {
        super('asmr-playlist-discover-root');
    }

    get component(): Component {
        return PlaylistDiscoverSection;
    }

    protected get debounceMs(): number {
        return 500;
    }

    protected get insertMode(): 'append' | 'prepend' | 'after' | 'before' {
        return 'append';
    }

    protected shouldBeActive(): boolean {
        if (!AppStore.getConfig('enablePlaylistDiscovery')) return false;
        const route = this.bridge.route;
        return route?.path === '/playlists';
    }

    findInjectionPoint(): HTMLElement | null {
        // Append to the q-page so we appear below all native content
        const qPage = document.querySelector('.q-page') as HTMLElement | null;
        if (!qPage) return null;
        const layoutPadding = qPage.querySelector('.q-layout-padding') as HTMLElement;
        return layoutPadding || qPage;
    }
}
