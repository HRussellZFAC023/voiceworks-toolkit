/**
 * InfiniteScrollController - FeatureController for InfiniteScrollGrid SFC
 *
 * Manages the lifecycle of the InfiniteScrollGrid Vue component.
 * The component itself handles all infinite scroll logic (IntersectionObserver,
 * pagination detection, API fetching, work card rendering).
 *
 * The controller's job is simply to:
 * - Find the right injection point (after the works grid)
 * - Mount/unmount the SFC based on route and config
 */

import { type Component } from 'vue';
import { FeatureController } from './FeatureController';
import InfiniteScrollGrid from './components/InfiniteScrollGrid.vue';
import { AppStore } from '../store/AppStore';

export class InfiniteScrollController extends FeatureController {
    private static instance: InfiniteScrollController;

    constructor() {
        super('asmr-infinite-scroll-root');
    }

    static getInstance(): InfiniteScrollController {
        if (!InfiniteScrollController.instance) {
            InfiniteScrollController.instance = new InfiniteScrollController();
        }
        return InfiniteScrollController.instance;
    }

    get component(): Component {
        return InfiniteScrollGrid;
    }

    protected get debounceMs(): number {
        return 500;
    }

    protected get insertMode(): 'append' | 'prepend' | 'after' | 'before' {
        return 'after';
    }

    protected shouldBeActive(): boolean {
        if (!AppStore.getConfig('enableInfiniteScroll')) return false;
        const path = this.bridge.route?.path || '';
        // Skip playlist page which has its own infinite scroll
        if (path === '/playlists') return false;
        return true;
    }

    findInjectionPoint(): HTMLElement | null {
        // Find the works grid container - this is the element we insert after
        const grid = document.querySelector('.row.q-col-gutter-x-sm.q-col-gutter-y-lg')
            || document.querySelector('[class*="q-col-gutter"]');

        if (!grid) return null;

        // Only inject if pagination exists (meaning this is a paginated page)
        const hasPagination = document.querySelector('.ant-pagination')
            || document.querySelector('.q-pagination');
        if (!hasPagination) return null;

        return grid as HTMLElement;
    }
}
