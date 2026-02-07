import { reactive, onUnmounted } from 'vue';
import { AppStore } from '../store/AppStore';
import { EventBus } from '../core/EventBus';
import type { AppState, ConfigKey, PluginConfig } from '../types';

/**
 * Reactive access to the application state.
 *
 * Returns a reactive snapshot that syncs via EventBus events
 * for state changes that AppStore emits.
 */
export function useAppStore() {
    const state = reactive<AppState>({ ...AppStore.state });
    const cleanups: (() => void)[] = [];

    // Sync radio state
    cleanups.push(EventBus.on('radio:toggle', ({ isActive }) => {
        state.radio.isActive = isActive;
    }));

    // Sync playlist state
    cleanups.push(EventBus.on('playlist:active', ({ isActive }) => {
        state.playlist.isActive = isActive;
    }));

    // Sync whisper state
    cleanups.push(EventBus.on('whisper:progress', ({ percent, message }) => {
        state.whisper.progress = percent;
        state.whisper.progressMessage = message;
    }));

    onUnmounted(() => {
        cleanups.forEach(fn => fn());
        cleanups.length = 0;
    });

    return {
        state,
        getConfig: <K extends ConfigKey>(key: K): PluginConfig[K] => AppStore.getConfig(key),
        setConfig: <K extends ConfigKey>(key: K, value: PluginConfig[K]): void => AppStore.setConfig(key, value),
    };
}
