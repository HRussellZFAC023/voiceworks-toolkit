/**
 * SidebarMenuController - Thin controller for the SidebarMenu Vue SFC
 *
 * Extends FeatureController to handle injection of the sidebar menu
 * into the host app's navigation drawer. The SFC handles all reactive
 * state via composables and EventBus subscriptions.
 */

import { type Component } from 'vue';
import { FeatureController } from '../features/FeatureController';
import SidebarMenu from './components/SidebarMenu.vue';

export class SidebarMenuController extends FeatureController {
    private radioToggleCallback: () => void;

    constructor(onRadioToggle: () => void) {
        super('asmr-sidebar-menu-root');
        this.radioToggleCallback = onRadioToggle;
    }

    get component(): Component {
        return SidebarMenu;
    }

    protected getProps(): Record<string, unknown> {
        return {
            onRadioToggle: this.radioToggleCallback,
        };
    }

    get debounceMs(): number {
        return 500;
    }

    get insertMode(): 'append' | 'prepend' | 'after' | 'before' {
        return 'append';
    }

    protected shouldBeActive(): boolean {
        // Sidebar is present on all pages
        return true;
    }

    findInjectionPoint(): HTMLElement | null {
        return (
            document.querySelector('.q-drawer--left .q-list') ||
            document.querySelector('.q-drawer .q-list') ||
            document.querySelector('.q-drawer--left .q-scrollarea__content') ||
            document.querySelector('.q-drawer')
        ) as HTMLElement | null;
    }
}
