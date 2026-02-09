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
        const query = this.bridge.route?.query || {};
        // Only active on listing pages that support pagination
        if (path === '/' || path === '/works' || path.startsWith('/works')) return true;
        if (path === '/search') return true;
        if (path.startsWith('/circle/') || path.startsWith('/tag/') || path.startsWith('/va/')) return true;
        if (path === '/playlist' && query.id) return true;
        // Check query-based routes (asmr.one style)
        if (query.circleId || query.tagId || query.vaId || query.keyword) return true;
        return false;
    }

    findInjectionPoint(): HTMLElement | null {
        const path = this.bridge.route?.path || '';
        const query = this.bridge.route?.query || {};

        // Playlist detail page: find the works grid directly
        if (path === '/playlist' && query.id) {
            return this.findWorksGrid();
        }

        // For paginated pages, find pagination and inject after it.
        // This is more reliable than finding the grid, since the grid's
        // CSS classes vary across asmr.one versions.
        const pagination = document.querySelector('.q-pagination')
            || document.querySelector('.ant-pagination');
        if (!pagination) return null;

        return pagination.parentElement || pagination as HTMLElement;
    }

    private findWorksGrid(): HTMLElement | null {
        const candidates = document.querySelectorAll('[class*="q-col-gutter"]');
        for (const el of candidates) {
            if (el.classList.contains('no-wrap')) continue;
            if (el.className.includes('q-col-gutter-y-')) return el as HTMLElement;
        }
        // Fallback: find parent of work cards
        const card = document.querySelector('.q-card');
        if (card?.parentElement?.parentElement) {
            const grid = card.parentElement.parentElement;
            if (grid.children.length > 1) return grid as HTMLElement;
        }
        return null;
    }
}
