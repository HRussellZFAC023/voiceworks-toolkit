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

        // Already mounted and container still in DOM
        const existingContainer = document.getElementById(this.containerId);
        if (this.mounted && existingContainer?.isConnected) return;

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

    protected unmount(): void {
        if (this.mounted) {
            try {
                this.mounted.unmount();
            } catch (err) {
                Logger.error(`[FeatureController] Failed to unmount ${this.containerId}:`, err);
            }
            this.mounted = null;

            // Remove container from DOM
            const container = document.getElementById(this.containerId);
            container?.remove();

            Logger.debug(`[FeatureController] Unmounted: ${this.containerId}`);
        }
    }
}
