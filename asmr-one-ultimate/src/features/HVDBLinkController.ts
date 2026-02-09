import { type Component } from 'vue';
import { FeatureController } from './FeatureController';
import HVDBLink from './components/HVDBLink.vue';
import { extractRjCode } from './hvdbLinkUtils';

export class HVDBLinkController extends FeatureController {
    constructor() {
        super('asmr-hvdb-link-root');
    }

    get component(): Component {
        return HVDBLink;
    }

    get debounceMs(): number {
        return 1000;
    }

    get insertMode(): 'append' | 'prepend' | 'after' | 'before' {
        return 'append';
    }

    protected shouldBeActive(): boolean {
        const route = this.bridge.route;
        return !!route?.path?.match(/^\/work\//);
    }

    findInjectionPoint(): HTMLElement | null {
        const workId = this.bridge.currentWorkId;
        const rjCode = extractRjCode(this.bridge.currentWork as any, workId);
        if (!rjCode) return null;

        const dlsiteLink = document.querySelector('a[href*="dlsite.com"]');
        if (!dlsiteLink) return null;
        return dlsiteLink.closest('.row.items-center.q-gutter-xs') as HTMLElement | null;
    }
}
