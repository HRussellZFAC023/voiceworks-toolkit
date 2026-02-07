/**
 * FlatViewController - Thin controller for the FlatView Vue 3 SFC
 *
 * Extends FeatureController to inject the FlatViewPanel toggle button
 * near the download button on work pages. The SFC teleports its drawer
 * panel to document.body.
 *
 * Exposes prefetch() for WorkTreeManager integration.
 */

import { type Component } from 'vue';
import { FeatureController } from './FeatureController';
import FlatViewPanel from './components/FlatViewPanel.vue';
import { Logger } from '../core/Logger';

/** Type for the exposed API from FlatViewPanel.vue */
interface FlatViewPanelExposed {
    show(): void;
    hide(): void;
    toggle(): void;
    prefetch(workId: string): void;
    getItems(): any[];
    readonly active: boolean;
}

export class FlatViewController extends FeatureController {
    /** Queue of prefetch calls that arrived before the component mounted */
    private pendingPrefetch: string | null = null;

    constructor() {
        super('asmr-flat-view-root');
    }

    get component(): Component {
        return FlatViewPanel;
    }

    get debounceMs(): number {
        return 500;
    }

    get insertMode(): 'append' | 'prepend' | 'after' | 'before' {
        return 'append';
    }

    protected shouldBeActive(): boolean {
        return !!location.pathname.includes('/work/');
    }

    findInjectionPoint(): HTMLElement | null {
        // Find the download button's container (same logic as the old FlatView)
        const downloadBtn = document.querySelector('button .q-btn__content .block')?.closest('button');
        if (!downloadBtn) return null;
        return downloadBtn.parentElement as HTMLElement | null;
    }

    /**
     * Prefetch tree data for a work so the panel opens instantly.
     * Called by WorkTreeManager when navigating to a work page.
     */
    public prefetch(workId: string): void {
        const exposed = this.getExposed();
        if (exposed) {
            exposed.prefetch(workId);
        } else {
            // Component not mounted yet - queue the prefetch
            this.pendingPrefetch = workId;
        }
    }

    /** Get the current flat items (for external consumers) */
    public getItems(): any[] {
        return this.getExposed()?.getItems() ?? [];
    }

    /** Whether the drawer panel is currently open */
    public get active(): boolean {
        return this.getExposed()?.active ?? false;
    }

    public show(): void {
        this.getExposed()?.show();
    }

    public hide(): void {
        this.getExposed()?.hide();
    }

    protected override tryInject(): void {
        super.tryInject();

        // Flush any pending prefetch after mount
        if (this.pendingPrefetch && this.mounted) {
            const exposed = this.getExposed();
            if (exposed) {
                exposed.prefetch(this.pendingPrefetch);
                this.pendingPrefetch = null;
            }
        }
    }

    private getExposed(): FlatViewPanelExposed | null {
        if (!this.mounted) return null;
        // Vue 3 app instance exposes component methods via _instance.exposed
        const appInstance = this.mounted.app;
        const rootComponent = (appInstance as any)?._instance;
        return rootComponent?.exposed as FlatViewPanelExposed | null;
    }
}
