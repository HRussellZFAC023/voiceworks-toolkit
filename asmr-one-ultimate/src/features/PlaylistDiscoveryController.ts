/**
 * PlaylistDiscoveryController - FeatureController for the PlaylistDiscovery Vue SFC
 *
 * Handles lifecycle: mounts PlaylistDiscoveryPanel.vue into the playlists page
 * when the user navigates to /playlists, unmounts on route change.
 */

import { type Component } from 'vue';
import { FeatureController } from './FeatureController';
import PlaylistDiscoveryPanel from './components/PlaylistDiscoveryPanel.vue';

export class PlaylistDiscoveryController extends FeatureController {
    constructor() {
        super('asmr-playlist-discovery-root');
    }

    get component(): Component {
        return PlaylistDiscoveryPanel;
    }

    protected get debounceMs(): number {
        return 500;
    }

    protected get insertMode(): 'append' | 'prepend' | 'after' | 'before' {
        return 'append';
    }

    protected shouldBeActive(): boolean {
        const route = this.bridge.route;
        return route?.path === '/playlists';
    }

    findInjectionPoint(): HTMLElement | null {
        // Look for the q-page container which holds the playlists page content.
        // We inject after the native layout padding area.
        const qPage = document.querySelector('.q-page') as HTMLElement | null;
        if (!qPage) return null;

        // Prefer the layout padding wrapper if it exists
        const layoutPadding = qPage.querySelector('.q-layout-padding') as HTMLElement;
        return layoutPadding || qPage;
    }
}
