import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import SettingsRangeSelect from '../../src/features/settings/SettingsRangeSelect.vue';
import { AppStore } from '../../src/store/AppStore';

const options = [
    { value: 'auto', label: 'Auto' },
    { value: 'tiny', label: 'Efficient' },
    { value: 'small', label: 'Balanced' },
    { value: 'medium', label: 'Accurate' },
    { value: 'large-v3-turbo', label: 'Maximum' },
];

describe('SettingsRangeSelect', () => {
    beforeEach(() => {
        (globalThis as any).GM_setValue('whisperModelPreset', 'auto');
        AppStore.setConfig('whisperModelPreset', 'auto');
    });

    it('renders the persisted string preset as a labelled discrete range', () => {
        AppStore.setConfig('whisperModelPreset', 'medium');
        const wrapper = mount(SettingsRangeSelect, {
            props: { configKey: 'whisperModelPreset', label: 'Model quality', icon: 'tune', options },
        });

        const range = wrapper.get('input[type="range"]');
        expect((range.element as HTMLInputElement).value).toBe('3');
        expect(range.attributes('aria-valuetext')).toBe('Accurate');
        expect(wrapper.get('.asmr-range-selected').text()).toBe('Accurate');
    });

    it('persists the selected quality tier', async () => {
        const wrapper = mount(SettingsRangeSelect, {
            props: { configKey: 'whisperModelPreset', label: 'Model quality', icon: 'tune', options },
        });
        const range = wrapper.get('input[type="range"]');
        (range.element as HTMLInputElement).value = '4';
        await range.trigger('input');

        expect(AppStore.getConfig('whisperModelPreset')).toBe('large-v3-turbo');
        expect(range.attributes('aria-valuetext')).toBe('Maximum');
    });

    it('preserves numeric option values for runtime tuning controls', async () => {
        const wrapper = mount(SettingsRangeSelect, {
            props: {
                configKey: 'whisperLiveOverlapSec',
                label: 'Overlap',
                icon: 'join_inner',
                options: [
                    { value: 0, label: 'None' },
                    { value: 2, label: 'Light' },
                    { value: 5, label: 'ASMR' },
                ],
            },
        });
        const range = wrapper.get('input[type="range"]');
        (range.element as HTMLInputElement).value = '2';
        await range.trigger('input');

        expect(AppStore.getConfig('whisperLiveOverlapSec')).toBe(5);
    });

    it('renders a persisted numeric tuning value at its matching tick', () => {
        AppStore.setConfig('whisperLiveOverlapSec', 5);
        const wrapper = mount(SettingsRangeSelect, {
            props: {
                configKey: 'whisperLiveOverlapSec',
                label: 'Overlap',
                icon: 'join_inner',
                options: [
                    { value: 0, label: 'None' },
                    { value: 2, label: 'Light' },
                    { value: 5, label: 'ASMR' },
                ],
            },
        });

        expect((wrapper.get('input[type="range"]').element as HTMLInputElement).value).toBe('2');
        expect(wrapper.get('input[type="range"]').attributes('aria-valuetext')).toBe('ASMR');
        expect(wrapper.findAll('.asmr-range-ticks button')[2].attributes('aria-pressed')).toBe('true');
    });
});
