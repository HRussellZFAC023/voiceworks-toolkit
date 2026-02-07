import { type Component } from 'vue';
import { FeatureController } from './FeatureController';
import { HeaderActions } from '../ui/HeaderActions';
import VectorSearchDialog from './components/VectorSearchDialog.vue';

export class VectorSearchController extends FeatureController {
    constructor() {
        super('asmr-vector-search-root');
    }

    get component(): Component {
        return VectorSearchDialog;
    }

    get debounceMs(): number {
        return 500;
    }

    get insertMode(): 'append' | 'prepend' | 'after' | 'before' {
        return 'append';
    }

    protected shouldBeActive(): boolean {
        // Always active - the button lives in the header toolbar
        return true;
    }

    findInjectionPoint(): HTMLElement | null {
        return HeaderActions.ensure();
    }
}
