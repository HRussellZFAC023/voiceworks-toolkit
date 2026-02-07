import { type Component } from 'vue';
import { FeatureController } from './FeatureController';
import WorkMetadataPanel from './components/WorkMetadataPanel.vue';

export class WorkMetadataController extends FeatureController {
    constructor() {
        super('asmr-work-metadata-root');
    }

    get component(): Component {
        return WorkMetadataPanel;
    }

    get debounceMs(): number {
        return 500;
    }

    get insertMode(): 'append' | 'prepend' | 'after' | 'before' {
        return 'after';
    }

    protected shouldBeActive(): boolean {
        const route = this.bridge.route;
        return !!(route?.name === 'work' || route?.path?.startsWith('/work/'));
    }

    findInjectionPoint(): HTMLElement | null {
        // Target the info container on work pages
        const selectors = [
            '.col-12.col-md-8.q-pa-sm.q-pt-md-md > .q-px-sm.q-py-none',
            '.work-info .q-px-sm.q-py-none',
            '.q-page .q-px-sm.q-py-none',
            'h1.text-h6',
        ];

        for (const selector of selectors) {
            const target = document.querySelector(selector);
            if (target && target.parentElement) {
                return target as HTMLElement;
            }
        }
        return null;
    }

    protected tryInject(): void {
        super.tryInject();
        this.ensureSectionOrder();
    }

    /** Ensure metadata always appears before comments regardless of injection order */
    private ensureSectionOrder(): void {
        const metadata = document.getElementById(this.containerId);
        const comments = document.getElementById('asmr-comments-root');
        if (!metadata || !comments || metadata.parentElement !== comments.parentElement) return;

        const siblings = Array.from(metadata.parentElement!.children);
        if (siblings.indexOf(comments) < siblings.indexOf(metadata)) {
            metadata.after(comments);
        }
    }
}
