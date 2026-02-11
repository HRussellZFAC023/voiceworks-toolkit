/**
 * MountApp - Vue 3 app mounting utility for parasitic injection
 *
 * Creates isolated Vue 3 app instances at host DOM injection points.
 * Each feature gets its own createApp() with shared services provided
 * via provide/inject.
 */

import { createApp, type App, type Component, type ComponentPublicInstance } from 'vue';
import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { AppStore } from '../store/AppStore';
import { EventBus } from './EventBus';
import { I18n } from './Config';
import { CentralObserver } from './CentralObserver';

export interface MountedApp {
    app: App;
    /** The component proxy returned by app.mount() — works in all builds (dev & prod). */
    proxy: ComponentPublicInstance;
    unmount: () => void;
}

/** Injection keys for provide/inject */
export const INJECT_KEYS = {
    bridge: Symbol('bridge') as symbol,
    appStore: Symbol('appStore') as symbol,
    eventBus: Symbol('eventBus') as symbol,
    i18n: Symbol('i18n') as symbol,
} as const;

/**
 * Create and mount a Vue 3 app instance with shared services provided.
 *
 * @param component - The root SFC component
 * @param props     - Props to pass to the component
 * @param container - The DOM element to mount into
 * @returns MountedApp with unmount() for cleanup
 */
export function mountApp(
    component: Component,
    props: Record<string, unknown>,
    container: HTMLElement
): MountedApp {
    const app = createApp(component, props);

    // Provide shared services (consumed via composables)
    app.provide(INJECT_KEYS.bridge, KikoeruBridge.getInstance());
    app.provide(INJECT_KEYS.appStore, AppStore);
    app.provide(INJECT_KEYS.eventBus, EventBus);
    app.provide(INJECT_KEYS.i18n, I18n);

    // Mount within CentralObserver modification guard.
    // IMPORTANT: app.mount() returns the component proxy (expose proxy if
    // defineExpose was used, else component.proxy). This works in ALL builds.
    // Do NOT use app._instance — it is only set in dev/devtools builds.
    let proxy: ComponentPublicInstance;
    CentralObserver.beginModification();
    try {
        proxy = app.mount(container);
    } finally {
        CentralObserver.endModification();
    }

    return {
        app,
        proxy,
        unmount() {
            CentralObserver.beginModification();
            try {
                app.unmount();
            } finally {
                CentralObserver.endModification();
            }
        },
    };
}
