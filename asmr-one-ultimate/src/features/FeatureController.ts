/**
 * FeatureController - Base class for Vue 3 SFC-based features
 *
 * Handles CentralObserver registration, route watching, and
 * mount/unmount lifecycle. Subclasses define what component to
 * render and where to inject it.
 */

import { type Component, markRaw } from 'vue';
import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { CentralObserver } from '../core/CentralObserver';
import { mountApp, type MountedApp } from '../core/MountApp';
import { Logger } from '../core/Utils';

export abstract class FeatureController {
    protected bridge: KikoeruBridge;
    protected mounted: MountedApp | null = null;
    protected containerId: string;
    private mountedContainer: HTMLElement | null = null;
    private routeUnwatch: (() => void) | undefined;
    private enabled = false;

    constructor(containerId: string) {
        this.bridge = KikoeruBridge.getInstance();
        this.containerId = containerId;
    }

    /** The Vue SFC component to mount */
    abstract get component(): Component;

    /** Props to pass to the component */
    protected getProps(): Record<string, unknown> {
        return {};
    }

    /** Find the DOM element to inject into. Return null if not available yet. */
    abstract findInjectionPoint(): HTMLElement | null;

    /** Whether this feature should be active on the current route */
    protected shouldBeActive(): boolean {
        return true;
    }

    /** CentralObserver debounce interval (ms) */
    protected get debounceMs(): number {
        return 500;
    }

    /** How the container is placed relative to the injection point */
    protected get insertMode(): 'append' | 'prepend' | 'after' | 'before' {
        return 'append';
    }

    /**
     * Preserve the mounted Vue app when the host temporarily removes its
     * injection anchor, then move the same root into the replacement anchor.
     *
     * This is opt-in because some route-scoped components intentionally use a
     * remount to rediscover host DOM. Components that teleport persistent UI
     * to <body> should opt in so a volatile host shell cannot destroy that UI.
     */
    protected get preserveMountOnAnchorReplacement(): boolean {
        return false;
    }

    public enable(): void {
        if (this.enabled) return;
        this.enabled = true;
        CentralObserver.register(this.containerId, () => this.tryInject(), this.debounceMs);

        this.routeUnwatch = this.bridge.$watch?.('$route', () => this.onRouteChange());

        // Initial injection attempt
        this.tryInject();
    }

    public disable(): void {
        if (!this.enabled) return;
        this.enabled = false;
        CentralObserver.unregister(this.containerId);
        this.routeUnwatch?.();
        this.routeUnwatch = undefined;
        this.unmount();
        // A failed mount may still have created the injection container.
        document.getElementById(this.containerId)?.remove();
    }

    protected onRouteChange(): void {
        if (!this.enabled) return;
        if (!this.shouldBeActive()) {
            this.unmount();
            return;
        }
        // Route changes do not always cause an observable body mutation (for
        // example when a host reuses its shell), so also attempt immediately.
        this.tryInject();
    }

    protected tryInject(): void {
        // Observer/route callbacks may already be queued when disable() tears
        // down their registrations. Never let a stale callback resurrect UI.
        if (!this.enabled) return;
        if (!this.shouldBeActive()) {
            this.unmount();
            // Also clean up a container left behind by an earlier failed mount.
            document.getElementById(this.containerId)?.remove();
            return;
        }

        // Already mounted and its original container is still in the DOM.
        const existingContainer = document.getElementById(this.containerId);
        if (
            this.mounted
            && this.mountedContainer?.isConnected
            && existingContainer === this.mountedContainer
        ) return;

        if (this.mounted && this.mountedContainer && this.preserveMountOnAnchorReplacement) {
            const anchor = this.findInjectionPoint();
            if (!anchor) {
                // The host often removes the old toolbar one render before it
                // inserts the replacement. Keep the Vue app (and any Teleport
                // children) alive until a later observer pass finds the anchor.
                return;
            }
            if (existingContainer && existingContainer !== this.mountedContainer) {
                existingContainer.remove();
            }
            this.insertContainer(anchor, this.mountedContainer);
            Logger.debug(`[FeatureController] Reattached: ${this.containerId}`);
            return;
        }

        // If we had a mounted instance but container was removed, clean up
        if (this.mounted) {
            this.unmount();
        }

        const anchor = this.findInjectionPoint();
        if (!anchor) {
            Logger.debug(`[FeatureController] No injection point for: ${this.containerId}`);
            return;
        }

        let container = document.getElementById(this.containerId);
        if (!container) {
            container = document.createElement('div');
            container.id = this.containerId;
            this.insertContainer(anchor, container);
        }

        this.mountedContainer = container;
        try {
            this.mounted = mountApp(
                markRaw(this.component),
                this.getProps(),
                container
            );
            Logger.debug(`[FeatureController] Mounted: ${this.containerId}`);
        } catch (err) {
            Logger.error(`[FeatureController] Failed to mount ${this.containerId}:`, err);
        }
    }

    private insertContainer(anchor: HTMLElement, container: HTMLElement): void {
        switch (this.insertMode) {
            case 'append':
                anchor.appendChild(container);
                break;
            case 'prepend':
                anchor.prepend(container);
                break;
            case 'after':
                anchor.after(container);
                break;
            case 'before':
                anchor.before(container);
                break;
        }
    }

    protected unmount(): void {
        const container = this.mountedContainer ?? document.getElementById(this.containerId);
        if (this.mounted) {
            try {
                this.mounted.unmount();
            } catch (err) {
                Logger.error(`[FeatureController] Failed to unmount ${this.containerId}:`, err);
            }
            this.mounted = null;
            Logger.debug(`[FeatureController] Unmounted: ${this.containerId}`);
        }
        container?.remove();
        this.mountedContainer = null;
    }
}
