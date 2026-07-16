import { type Component } from 'vue';
import { HeaderActions } from '../ui/HeaderActions';
import DownloadCenter from './components/DownloadCenter.vue';
import { FeatureController } from './FeatureController';

/** Always-on header entry point for playlist and direct work downloads. */
export class DownloadCenterController extends FeatureController {
    constructor() { super('asmr-download-center-root'); }
    get component(): Component { return DownloadCenter; }
    protected get debounceMs(): number { return 500; }
    protected get insertMode(): 'append' { return 'append'; }
    protected shouldBeActive(): boolean { return true; }
    findInjectionPoint(): HTMLElement | null { return HeaderActions.ensure(); }
}
