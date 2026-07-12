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
import { getPlayerBar } from '../core/DomUtils';
import { AppStore } from '../store/AppStore';

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
        return AppStore.getConfig('enableLearnerMode');
    }

    findInjectionPoint(): HTMLElement | null {
        // Inject right after the album art inside the expanded audio player,
        // mirroring the old LearnerMode.injectExpanded() placement.
        const player = document.querySelector('.audio-player') as HTMLElement | null;
        if (player) {
            // Prefer album art as anchor so we insert after it.
            const albumArt = player.querySelector('.albumart') as HTMLElement | null;
            return albumArt || player;
        }

        // Newer host builds keep the compact player in the footer and do not
        // create the legacy `.audio-player` wrapper. Mount beside that bar so
        // the component can still render collapsed controls and react to state.
        return getPlayerBar();
    }
}
