import { type Component } from 'vue';
import { FeatureController } from './FeatureController';
import CommentSection from './components/CommentSection.vue';

export class CommentSectionController extends FeatureController {
    constructor() {
        super('asmr-comments-root');
    }

    get component(): Component {
        return CommentSection;
    }

    get debounceMs(): number {
        return 500;
    }

    get insertMode(): 'append' | 'prepend' | 'after' | 'before' {
        return 'after';
    }

    protected shouldBeActive(): boolean {
        const route = this.bridge.route;
        return route?.name === 'work' || !!route?.path?.startsWith('/work/');
    }

    findInjectionPoint(): HTMLElement | null {
        // Inject after the metadata root if it exists, otherwise after the info container
        const selectors = [
            '#asmr-work-metadata-root',
            '.col-12.col-md-8.q-pa-sm.q-pt-md-md > .q-px-sm.q-py-none',
            '.work-info .q-px-sm.q-py-none',
            '.q-page .q-px-sm.q-py-none',
            'h1.text-h6',
        ];

        for (const selector of selectors) {
            const el = document.querySelector(selector);
            if (el) return el as HTMLElement;
        }

        return null;
    }

    protected tryInject(): void {
        super.tryInject();
        this.ensureSectionOrder();
    }

    /** Ensure comments always appears after metadata regardless of injection order */
    private ensureSectionOrder(): void {
        const comments = document.getElementById(this.containerId);
        const metadata = document.getElementById('asmr-work-metadata-root');
        if (!comments || !metadata || comments.parentElement !== metadata.parentElement) return;

        const siblings = Array.from(comments.parentElement!.children);
        if (siblings.indexOf(comments) < siblings.indexOf(metadata)) {
            metadata.after(comments);
        }
    }
}
