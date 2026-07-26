import { mount } from '@vue/test-utils';
import { describe, expect, beforeEach, it } from 'vitest';
import * as ValidatedInputModule from '../../src/features/settings/SettingsValidatedInput.vue';
import SettingsNumberInput from '../../src/features/settings/SettingsNumberInput.vue';
import { AppStore } from '../../src/store/AppStore';

const SettingsValidatedInput = ValidatedInputModule.default;

// The blanket `*.vue` shim in src/env.d.ts declares only a default export, so
// plain `tsc` cannot see the SFC's named export even though vite and vue-tsc
// both resolve it. Reached through the namespace rather than by widening a
// shim shared with every other component in the project.
const { isHuggingFaceModelId } = ValidatedInputModule as unknown as {
    isHuggingFaceModelId: (value: unknown) => boolean;
};

/** Config keys owned by the Whisper "Advanced" disclosure. */
const ADVANCED_DEFAULTS = {
    whisperCustomModelId: '',
    whisperEncoderDtype: 'auto',
    whisperDecoderDtype: 'auto',
    whisperExecutionDevice: 'auto',
    whisperNoRepeatNgramSize: 6,
    whisperRepetitionPenalty: 1.15,
    whisperLiveChunkSec: 29,
    whisperLiveOverlapSec: 5,
    whisperTask: 'transcribe',
    whisperLanguage: 'auto',
} as const;

function resetAdvancedConfig(): void {
    for (const key of Object.keys(ADVANCED_DEFAULTS) as Array<keyof typeof ADVANCED_DEFAULTS>) {
        (globalThis as any).GM_setValue(key, ADVANCED_DEFAULTS[key]);
    }
}

describe('Whisper advanced config defaults', () => {
    beforeEach(resetAdvancedConfig);

    // The whole point of the disclosure is that an untouched install keeps
    // transcribing exactly as it did before it existed.
    it.each(Object.entries(ADVANCED_DEFAULTS))(
        'ships %s defaulting to the pre-existing behaviour',
        (key, expected) => {
            expect(AppStore.getConfigDefault(key as any)).toBe(expected);
        },
    );

    it('exposes every advanced key through the normal config mechanism', () => {
        for (const key of Object.keys(ADVANCED_DEFAULTS) as Array<keyof typeof ADVANCED_DEFAULTS>) {
            expect(AppStore.getConfig(key as any)).toBe(ADVANCED_DEFAULTS[key]);
        }
    });
});

describe('isHuggingFaceModelId', () => {
    it.each([
        'onnx-community/whisper-small_timestamped',
        'openai/whisper-large-v3',
        'distil-whisper/distil-large-v3.5',
        'Xenova/whisper-tiny.en',
        'a/b',
    ])('accepts %s', (value) => {
        expect(isHuggingFaceModelId(value)).toBe(true);
    });

    it.each([
        ['', 'empty'],
        ['whisper-small', 'no owner'],
        ['owner/', 'no name'],
        ['/name', 'no owner segment'],
        ['owner/name/extra', 'more than one segment separator'],
        ['owner name/model', 'whitespace'],
        ['owner/../etc', 'path traversal'],
        ['../owner/name', 'leading traversal'],
        ['-owner/name', 'segment starting with punctuation'],
        ['owner/#model', 'illegal character'],
        ['https://huggingface.co/owner/name', 'a URL rather than an id'],
    ])('rejects %s (%s)', (value) => {
        expect(isHuggingFaceModelId(value)).toBe(false);
    });

    it('rejects an id longer than the hub allows', () => {
        expect(isHuggingFaceModelId(`owner/${'m'.repeat(200)}`)).toBe(false);
    });
});

describe('SettingsValidatedInput', () => {
    beforeEach(resetAdvancedConfig);

    function mountInput() {
        return mount(SettingsValidatedInput, {
            props: {
                configKey: 'whisperCustomModelId' as const,
                label: 'Custom model ID',
                icon: 'hub',
                validate: isHuggingFaceModelId,
                invalidText: 'Not stored.',
                activeText: 'In use instead of Model Quality.',
            },
        });
    }

    it('persists an accepted model id through the config mechanism', async () => {
        const wrapper = mountInput();
        const input = wrapper.get('input');
        (input.element as HTMLInputElement).value = 'openai/whisper-large-v3';
        await input.trigger('input');
        await input.trigger('change');

        expect(AppStore.getConfig('whisperCustomModelId')).toBe('openai/whisper-large-v3');
        expect(wrapper.find('[data-asmr-invalid]').exists()).toBe(false);
        expect(wrapper.text()).toContain('In use instead of Model Quality.');
    });

    it('trims surrounding whitespace before storing', async () => {
        const wrapper = mountInput();
        const input = wrapper.get('input');
        (input.element as HTMLInputElement).value = '  openai/whisper-large-v3  ';
        await input.trigger('input');
        await input.trigger('change');

        expect(AppStore.getConfig('whisperCustomModelId')).toBe('openai/whisper-large-v3');
    });

    it('refuses a malformed id and leaves the stored value untouched', async () => {
        AppStore.setConfig('whisperCustomModelId', 'openai/whisper-large-v3');
        const wrapper = mountInput();
        const input = wrapper.get('input');
        (input.element as HTMLInputElement).value = 'not-a-repo';
        await input.trigger('input');
        await input.trigger('change');

        expect(AppStore.getConfig('whisperCustomModelId')).toBe('openai/whisper-large-v3');
        expect(wrapper.get('[data-asmr-invalid="whisperCustomModelId"]').text()).toBe('Not stored.');
    });

    it('clears the rejection notice as soon as the field is edited again', async () => {
        const wrapper = mountInput();
        const input = wrapper.get('input');
        (input.element as HTMLInputElement).value = 'nope';
        await input.trigger('input');
        await input.trigger('change');
        expect(wrapper.find('[data-asmr-invalid]').exists()).toBe(true);

        (input.element as HTMLInputElement).value = 'nope/ok';
        await input.trigger('input');
        expect(wrapper.find('[data-asmr-invalid]').exists()).toBe(false);
    });

    it('treats an empty field as clearing the override, not as invalid', async () => {
        AppStore.setConfig('whisperCustomModelId', 'openai/whisper-large-v3');
        const wrapper = mountInput();
        const input = wrapper.get('input');
        (input.element as HTMLInputElement).value = '';
        await input.trigger('input');
        await input.trigger('change');

        expect(AppStore.getConfig('whisperCustomModelId')).toBe('');
        expect(wrapper.find('[data-asmr-invalid]').exists()).toBe(false);
    });
});

describe('SettingsNumberInput', () => {
    beforeEach(resetAdvancedConfig);

    function mountNumber(overrides: Record<string, unknown> = {}) {
        return mount(SettingsNumberInput, {
            props: {
                configKey: 'whisperNoRepeatNgramSize' as const,
                label: 'No-repeat n-gram size',
                icon: 'repeat_on',
                min: 0,
                max: 10,
                step: 1,
                invalidText: 'Enter 0 to 10.',
                ...overrides,
            },
        });
    }

    it('persists an in-range value', async () => {
        const wrapper = mountNumber();
        const input = wrapper.get('input');
        (input.element as HTMLInputElement).value = '3';
        await input.trigger('input');
        await input.trigger('change');

        expect(AppStore.getConfig('whisperNoRepeatNgramSize')).toBe(3);
    });

    it('accepts the boundary values of the declared range', async () => {
        for (const entry of ['0', '10']) {
            const wrapper = mountNumber();
            const input = wrapper.get('input');
            (input.element as HTMLInputElement).value = entry;
            await input.trigger('input');
            await input.trigger('change');
            expect(AppStore.getConfig('whisperNoRepeatNgramSize')).toBe(Number(entry));
        }
    });

    it('refuses an out-of-range value rather than silently clamping it', async () => {
        const wrapper = mountNumber();
        const input = wrapper.get('input');
        (input.element as HTMLInputElement).value = '99';
        await input.trigger('input');
        await input.trigger('change');

        // Clamping to 10 would report a choice the user never made.
        expect(AppStore.getConfig('whisperNoRepeatNgramSize')).toBe(6);
        expect(wrapper.get('[data-asmr-invalid="whisperNoRepeatNgramSize"]').text()).toBe('Enter 0 to 10.');
    });

    it('refuses a non-numeric entry', async () => {
        const wrapper = mountNumber();
        const input = wrapper.get('input');
        (input.element as HTMLInputElement).value = 'fast';
        await input.trigger('input');
        await input.trigger('change');

        expect(AppStore.getConfig('whisperNoRepeatNgramSize')).toBe(6);
        expect(wrapper.find('[data-asmr-invalid]').exists()).toBe(true);
    });

    it('persists fractional values when the step allows them', async () => {
        const wrapper = mountNumber({
            configKey: 'whisperRepetitionPenalty' as const,
            min: 1,
            max: 2,
            step: 0.01,
        });
        const input = wrapper.get('input');
        (input.element as HTMLInputElement).value = '1.35';
        await input.trigger('input');
        await input.trigger('change');

        expect(AppStore.getConfig('whisperRepetitionPenalty')).toBe(1.35);
    });

    it('shows the contextual hint only while no entry is being rejected', async () => {
        const wrapper = mountNumber({ hint: 'Anti-repetition is off at this value.' });
        expect(wrapper.text()).toContain('Anti-repetition is off at this value.');

        const input = wrapper.get('input');
        (input.element as HTMLInputElement).value = '-4';
        await input.trigger('input');
        await input.trigger('change');

        expect(wrapper.text()).not.toContain('Anti-repetition is off at this value.');
        expect(wrapper.find('[data-asmr-invalid]').exists()).toBe(true);
    });

    it('follows the stored value when it changes elsewhere', async () => {
        const wrapper = mountNumber();
        AppStore.setConfig('whisperNoRepeatNgramSize', 2);
        await wrapper.vm.$nextTick();

        expect((wrapper.get('input').element as HTMLInputElement).value).toBe('2');
    });
});
