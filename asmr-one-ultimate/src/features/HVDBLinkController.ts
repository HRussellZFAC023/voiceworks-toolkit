import { type Component } from 'vue';
import { FeatureController } from './FeatureController';
import HVDBLink from './components/HVDBLink.vue';
import { findHvdbInjectionPoint, resolveHvdbRjCode } from './hvdbLinkUtils';

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
        return route?.name === 'work' || !!route?.path?.startsWith('/work/');
    }

    protected tryInject(): void {
        super.tryInject();
        const container = document.getElementById(this.containerId);
        if (container) {
            container.style.display = 'contents';
        }
    }

    findInjectionPoint(): HTMLElement | null {
        const rjCode = resolveHvdbRjCode({
            work: this.bridge.currentWork,
            workId: this.bridge.currentWorkId,
            route: this.bridge.route,
        });
        if (!rjCode) return null;
        return findHvdbInjectionPoint(document, rjCode);
    }
}
