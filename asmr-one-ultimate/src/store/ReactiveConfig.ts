/**
 * ReactiveConfig - Vue 3 reactive config using reactive()
 *
 * Makes plugin configuration reactive so that UI components automatically
 * update when settings change, without manual event wiring or page reloads.
 */

import { reactive } from 'vue';
import { AppStore } from './AppStore';
import { EventBus } from '../core/EventBus';
import type { PluginConfig, ConfigKey } from '../types';

declare const unsafeWindow: Window & typeof globalThis;

const globalWindow = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) as Window & {
    __ASMR_REACTIVE_CONFIG__?: PluginConfig;
};

let reactiveConfig: PluginConfig | null = null;

/**
 * Initialize reactive config using Vue 3's reactive().
 * Must be called AFTER AppStore is available.
 *
 * The reactive object syncs with EventBus 'config:change' events,
 * so any call to AppStore.setConfig() automatically updates the reactive state.
 */
export function initReactiveConfig(): PluginConfig {
    // Return cached instance if already initialized
    if (globalWindow.__ASMR_REACTIVE_CONFIG__) {
        reactiveConfig = globalWindow.__ASMR_REACTIVE_CONFIG__;
        return reactiveConfig;
    }

    // Build initial config snapshot
    const initial = AppStore.getAllConfig();

    // Vue 3 reactive() makes the object deeply reactive
    reactiveConfig = reactive({ ...initial });

    globalWindow.__ASMR_REACTIVE_CONFIG__ = reactiveConfig;

    // Sync: when config changes via setConfig, update the reactive object
    EventBus.on('config:change', ({ key, value }) => {
        const typedKey = key as ConfigKey;
        if (reactiveConfig && typedKey in reactiveConfig) {
            (reactiveConfig as unknown as Record<ConfigKey, PluginConfig[ConfigKey]>)[typedKey] =
                value as PluginConfig[typeof typedKey];
        }

        // Sync SFW mode body class
        if (key === 'sfwMode') {
            document.body.classList.toggle('asmr-sfw-mode', !!value);
        }
    });

    // Apply SFW mode on init if already enabled
    if (initial.sfwMode) {
        document.body.classList.add('asmr-sfw-mode');
    }

    return reactiveConfig;
}

/**
 * Get the reactive config object.
 * In Vue 3 SFCs, prefer using the useConfig() composable instead.
 */
export function getReactiveConfig(): Readonly<PluginConfig> {
    if (!reactiveConfig) {
        throw new Error('ReactiveConfig not initialized. Call initReactiveConfig() first.');
    }
    return reactiveConfig;
}

/**
 * Watch a specific config key reactively.
 * In Vue 3 SFCs, prefer using useConfig() composable instead.
 *
 * @param key - The config key to watch
 * @param callback - Called when the value changes
 * @param options - Watch options (immediate)
 * @returns Unwatch function
 */
export function watchConfig<K extends ConfigKey>(
    key: K,
    callback: (newVal: PluginConfig[K], oldVal: PluginConfig[K]) => void,
    options?: { immediate?: boolean }
): () => void {
    const config = getReactiveConfig();

    // Use EventBus-based watching (works for both Vue SFC and plain TS contexts)
    if (options?.immediate) {
        callback(config[key], config[key]);
    }

    return EventBus.on('config:change', ({ key: changedKey, value, oldValue }) => {
        if (changedKey === key) {
            callback(value as PluginConfig[K], oldValue as PluginConfig[K]);
        }
    });
}
