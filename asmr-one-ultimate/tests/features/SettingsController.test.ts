import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    syncFromHost: vi.fn(),
}));

vi.mock('../../src/features/settings/SettingsPanel.vue', () => ({ default: {} }));
vi.mock('../../src/infrastructure/KikoeruBridge', () => ({
    KikoeruBridge: {
        getInstance: () => ({ route: { path: '/settings' } }),
    },
}));
vi.mock('../../src/core/Config', () => ({
    Config: { get: vi.fn(), set: vi.fn() },
    I18n: { syncFromHost: mocks.syncFromHost },
}));

import { SettingsController } from '../../src/features/settings/SettingsController';

describe('SettingsController theme isolation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = `
            <nav id="sidebar">
                <div id="sidebar-list" class="q-list q-list--dark bg-black text-white"></div>
            </nav>
            <main class="q-pa-md q-gutter-md">
                <div id="host-settings-one" class="q-list q-list--dark bg-black text-white">
                    <div class="q-item q-item--dark"></div>
                </div>
                <div id="host-settings-two" class="q-list q-list--dark bg-black text-white"></div>
            </main>`;
    });

    it('finds the final host settings list without rewriting host or sidebar theme classes', () => {
        const controller = new SettingsController();
        const anchor = controller.findInjectionPoint();

        expect(anchor?.id).toBe('host-settings-two');
        expect(mocks.syncFromHost).toHaveBeenCalledOnce();
        expect(document.getElementById('sidebar-list')?.className)
            .toBe('q-list q-list--dark bg-black text-white');
        expect(document.getElementById('host-settings-one')?.className)
            .toBe('q-list q-list--dark bg-black text-white');
        expect(document.querySelector('#host-settings-one .q-item')?.className)
            .toBe('q-item q-item--dark');
    });
});
