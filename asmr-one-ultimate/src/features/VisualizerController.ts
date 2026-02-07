/**
 * VisualizerController - FeatureController for the audio frequency visualizer.
 *
 * Mounts VisualizerBar.vue after the album art (or after the learner-subs-root)
 * inside the expanded audio player.  The SFC handles both the expanded bar
 * (in-place) and the collapsed bar (teleported to <body>).
 */

import { type Component } from 'vue';
import { FeatureController } from './FeatureController';
import VisualizerBar from './components/VisualizerBar.vue';

export class VisualizerController extends FeatureController {
    constructor() {
        super('asmr-visualizer-root');
    }

    get component(): Component {
        return VisualizerBar;
    }

    get debounceMs(): number {
        return 500;
    }

    get insertMode(): 'append' | 'prepend' | 'after' | 'before' {
        return 'after';
    }

    protected shouldBeActive(): boolean {
        return true;
    }

    findInjectionPoint(): HTMLElement | null {
        const player = document.querySelector('.audio-player') as HTMLElement | null;
        if (!player) return null;

        // Insert after LearnerSubtitles root if it exists
        const subsRoot = player.querySelector('#asmr-learner-subs-root') as HTMLElement | null;
        if (subsRoot) return subsRoot;

        // Fallback: after album art
        const albumArt = player.querySelector('.albumart') as HTMLElement | null;
        return albumArt || player;
    }
}
