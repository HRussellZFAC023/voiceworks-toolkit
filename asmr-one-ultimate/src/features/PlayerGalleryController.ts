/**
 * PlayerGalleryController - Thin controller for the PlayerGallery Vue SFC.
 *
 * Extends FeatureController to inject the gallery overlay elements
 * (image, nav arrows, counter) into the .audio-player .albumart container.
 *
 * The heavy lifting (image collection, slideshow, navigation, keyboard,
 * touch swipe, lightbox) lives in the PlayerGallery.vue SFC.
 */

import { type Component } from 'vue';
import { FeatureController } from './FeatureController';
import PlayerGallery from './components/PlayerGallery.vue';

export class PlayerGalleryController extends FeatureController {
    constructor() {
        super('asmr-player-gallery-root');
    }

    get component(): Component {
        return PlayerGallery;
    }

    get debounceMs(): number {
        return 500;
    }

    get insertMode(): 'append' | 'prepend' | 'after' | 'before' {
        return 'append';
    }

    /**
     * The gallery is always active -- it listens for fullscreen/work events
     * internally and shows/hides UI based on image availability.
     */
    protected shouldBeActive(): boolean {
        return true;
    }

    /**
     * Inject into the .albumart container inside .audio-player.
     * Returns null if the player isn't rendered yet.
     */
    findInjectionPoint(): HTMLElement | null {
        const albumart = document.querySelector('.audio-player .albumart') as HTMLElement | null;
        if (!albumart) return null;

        // Ensure positioning context for absolutely positioned children
        if (getComputedStyle(albumart).position === 'static') {
            albumart.style.position = 'relative';
        }

        return albumart;
    }
}
