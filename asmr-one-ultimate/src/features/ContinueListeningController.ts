/**
 * ContinueListeningController - FeatureController for the Continue Listening section
 *
 * Injects a "Continue Listening" horizontal carousel above the "All works" header
 * on the homepage, showing works with progress status "listening".
 */

import { type Component } from 'vue';
import { FeatureController } from './FeatureController';
import ContinueListeningPanel from './components/ContinueListeningPanel.vue';

export class ContinueListeningController extends FeatureController {
    constructor() {
        super('asmr-continue-listening-root');
    }

    get component(): Component {
        return ContinueListeningPanel;
    }

    protected get debounceMs(): number {
        return 500;
    }

    protected get insertMode(): 'append' | 'prepend' | 'after' | 'before' {
        return 'before';
    }

    protected shouldBeActive(): boolean {
        const path = this.bridge.route?.path || '';
        const query = this.bridge.route?.query || {};
        const isHome = path === '/' || path === '/works';
        const isIdle = Object.keys(query).length === 0;
        return isHome && isIdle;
    }

    findInjectionPoint(): HTMLElement | null {
        // Inject before the "All works" header (div with h1.text-h5 or h2.text-h5)
        const header = document.querySelector('.q-pt-lg.q-px-md.text-h5');
        if (header) return header as HTMLElement;

        // Fallback: inject before the main works grid
        const grid = document.querySelector('.row.q-col-gutter-x-sm.q-col-gutter-y-lg');
        return grid as HTMLElement | null;
    }
}
