/**
 * AdvancedSearchController - Thin FeatureController for the Advanced Search button.
 *
 * Injects the AdvancedSearchButton Vue component into the header toolbar.
 * The button internally manages the AdvancedSearchDialog via v-model.
 */

import { type Component } from 'vue';
import { FeatureController } from './FeatureController';
import { HeaderActions } from '../ui/HeaderActions';
import AdvancedSearchButton from './components/AdvancedSearchButton.vue';

export class AdvancedSearchController extends FeatureController {
    constructor() {
        super('asmr-advanced-search-root');
    }

    get component(): Component {
        return AdvancedSearchButton;
    }

    get debounceMs(): number {
        return 500;
    }

    get insertMode(): 'append' | 'prepend' | 'after' | 'before' {
        return 'append';
    }

    protected shouldBeActive(): boolean {
        // The button should always be visible in the header (like the original)
        return true;
    }

    findInjectionPoint(): HTMLElement | null {
        return HeaderActions.ensure();
    }
}
