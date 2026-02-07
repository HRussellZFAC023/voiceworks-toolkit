import { ref, watch, type Ref } from 'vue';
import { useEventBus } from './useEventBus';
import { AppStore } from '../store/AppStore';
import type { ConfigKey, PluginConfig } from '../types';

/**
 * Reactive two-way binding to a plugin config key (GM_storage backed).
 *
 * Reading: returns a ref that updates when the config changes (from any source).
 * Writing: assigning to the ref persists the value to GM_storage and emits config:change.
 */
export function useConfig<K extends ConfigKey>(key: K): Ref<PluginConfig[K]> {
    const { on } = useEventBus();
    const value = ref(AppStore.getConfig(key)) as Ref<PluginConfig[K]>;

    // Listen for external changes (other features, settings panel)
    on('config:change', ({ key: changedKey, value: newVal }) => {
        if (changedKey === key) {
            value.value = newVal as PluginConfig[K];
        }
    });

    // Write back to GM_storage when the ref changes locally
    watch(value, (newVal) => {
        // Skip if the store already has this value (avoids echo from config:change listener)
        if (AppStore.getConfig(key) === newVal) return;
        AppStore.setConfig(key, newVal);
    });

    return value;
}
