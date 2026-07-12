import { mount } from '@vue/test-utils';
import { describe, expect, beforeEach, it } from 'vitest';
import SettingsSelect from '../../src/features/settings/SettingsSelect.vue';
import { AppStore } from '../../src/store/AppStore';

describe('SettingsSelect', () => {
    beforeEach(() => {
        (globalThis as any).GM_setValue('whisperModelPreset', 'auto');
    });

    it('renders all options with the current config value selected', () => {
        AppStore.setConfig('whisperModelPreset', 'medium');
        const wrapper = mount(SettingsSelect, {
            props: {
                configKey: 'whisperModelPreset',
                label: 'Model Quality',
                icon: 'tune',
                options: [
                    { value: 'auto', label: 'Auto' },
                    { value: 'small', label: 'Small' },
                    { value: 'medium', label: 'Medium' },
                    { value: 'large-v3-turbo', label: 'Large v3 Turbo' },
                ],
            },
        });

        const select = wrapper.get('select');
        expect(select.findAll('option')).toHaveLength(4);
        expect((select.element as HTMLSelectElement).value).toBe('medium');
        expect(select.attributes('data-asmr-select')).toBe('whisperModelPreset');
    });

    it('persists the selected value to config on change', async () => {
        const wrapper = mount(SettingsSelect, {
            props: {
                configKey: 'whisperModelPreset',
                label: 'Model Quality',
                icon: 'tune',
                options: [
                    { value: 'auto', label: 'Auto' },
                    { value: 'large-v3-turbo', label: 'Large v3 Turbo' },
                ],
            },
        });

        const select = wrapper.get('select');
        (select.element as HTMLSelectElement).value = 'large-v3-turbo';
        await select.trigger('change');

        expect(AppStore.getConfig('whisperModelPreset')).toBe('large-v3-turbo');
    });

    it('renders a contextual hint only when provided', () => {
        const wrapper = mount(SettingsSelect, {
            props: {
                configKey: 'whisperModelPreset',
                label: 'Model Quality',
                icon: 'tune',
                hint: 'Experimental and heavy',
                options: [{ value: 'auto', label: 'Auto' }],
            },
        });
        expect(wrapper.find('.asmr-settings-select-hint').exists()).toBe(true);
        expect(wrapper.find('.asmr-settings-select-hint').text()).toBe('Experimental and heavy');
    });
});
