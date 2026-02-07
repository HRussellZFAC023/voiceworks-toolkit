/**
 * LearnerModeController - FeatureController for the Learner Mode subtitle display.
 *
 * Replaces the old imperative LearnerMode class with a Vue 3 SFC mount managed
 * by FeatureController lifecycle.  The SFC (LearnerSubtitles.vue) handles both
 * the expanded subtitle area (inside the audio player) and the collapsed bar
 * (teleported to <body>).
 */

import { type Component } from 'vue';
import { FeatureController } from './FeatureController';
import LearnerSubtitles from './components/LearnerSubtitles.vue';

export class LearnerModeController extends FeatureController {
    constructor() {
        super('asmr-learner-subs-root');
    }

    get component(): Component {
        return LearnerSubtitles;
    }

    get debounceMs(): number {
        return 300;
    }

    get insertMode(): 'append' | 'prepend' | 'after' | 'before' {
        return 'after';
    }

    protected shouldBeActive(): boolean {
        // Always active — visibility is handled by the component based on
        // whether there is content to show and the player state.
        return true;
    }

    findInjectionPoint(): HTMLElement | null {
        // Inject right after the album art inside the expanded audio player,
        // mirroring the old LearnerMode.injectExpanded() placement.
        const player = document.querySelector('.audio-player') as HTMLElement | null;
        if (!player) return null;

        // Prefer album art as anchor so we insert after it
        const albumArt = player.querySelector('.albumart') as HTMLElement | null;
        if (albumArt) return albumArt;

        // Fallback: prepend to the player itself (insertMode won't matter here,
        // but the component still renders correctly)
        return player;
    }
}
