import { type Component } from 'vue';
import { FeatureController } from '../FeatureController';
import SettingsPanel from './SettingsPanel.vue';
import { Config, I18n } from '../../core/Config';
import type { ConfigKey, PluginConfig } from '../../types';

/**
 * SettingsController - Vue 3 SFC-based settings panel
 *
 * Extends FeatureController to mount the SettingsPanel Vue component
 * into the asmr.one settings page. Replaces the imperative DOM
 * manipulation in the legacy SettingsManager.
 *
 * Active only on the /settings route.
 */
export class SettingsController extends FeatureController {
    constructor() {
        super('asmr-settings-panel-root');
    }

    get component(): Component {
        return SettingsPanel;
    }

    get debounceMs(): number {
        return 300;
    }

    get insertMode(): 'append' | 'prepend' | 'after' | 'before' {
        return 'after';
    }

    protected shouldBeActive(): boolean {
        const route = this.bridge.route;
        return route?.path === '/settings';
    }

    /**
     * Find the settings page container.
     *
     * The host app renders settings as .q-list sections inside
     * a .q-pa-md.q-gutter-md container. We look for the last
     * .q-list on the page (the player/general sections) and
     * insert our panel after it.
     */
    findInjectionPoint(): HTMLElement | null {
        I18n.syncFromHost();

        // Find the settings container
        const container = document.querySelector('.q-pa-md.q-gutter-md');
        if (!container) return null;

        // Find all host q-lists in the settings page
        const lists = container.querySelectorAll(':scope > .q-list');
        if (lists.length === 0) return null;

        // Insert after the last host settings list
        return lists[lists.length - 1] as HTMLElement;
    }
}

/**
 * Legacy API for global access (used by main.ts global API object).
 * Provides get/set/toggle for plugin configuration via Config.
 */
export const API = {
    get: (key: string) => Config.get(key as ConfigKey),
    set: (key: string, val: unknown) => Config.set(key as ConfigKey, val as PluginConfig[ConfigKey]),
    toggle: (key: string) => Config.set(key as ConfigKey, !Config.get(key as ConfigKey) as PluginConfig[ConfigKey]),
};
