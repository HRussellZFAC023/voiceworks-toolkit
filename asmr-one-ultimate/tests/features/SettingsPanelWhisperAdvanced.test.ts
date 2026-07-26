import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { nextTick } from 'vue';
import { shallowMount, type VueWrapper } from '@vue/test-utils';

const ADVANCED_DEFAULTS: Record<string, unknown> = {
    whisperCustomModelId: '',
    whisperEncoderDtype: 'auto',
    whisperDecoderDtype: 'auto',
    whisperExecutionDevice: 'auto',
    whisperLiveChunkSec: 29,
    whisperLiveOverlapSec: 5,
    whisperNoRepeatNgramSize: 6,
    whisperRepetitionPenalty: 1.15,
    whisperTask: 'transcribe',
};

const mocks = vi.hoisted(() => ({
    handlers: new Map<string, Array<(payload: unknown) => void>>(),
    configs: {} as Record<string, unknown>,
    defaults: {} as Record<string, unknown>,
    whisperState: {
        isTranscribing: false,
        isLoadingModel: false,
        progress: 0,
        progressMessage: '',
        currentTrackSrc: null,
    },
}));

vi.mock('../../src/composables/useEventBus', () => ({
    useEventBus: () => ({
        on: (event: string, handler: (payload: unknown) => void) => {
            const handlers = mocks.handlers.get(event) ?? [];
            handlers.push(handler);
            mocks.handlers.set(event, handlers);
        },
        emit: vi.fn(),
        once: vi.fn(),
    }),
}));

vi.mock('../../src/composables/useI18n', () => ({
    useI18n: () => ({
        t: (key: string) => key,
        format: (key: string, values: Record<string, unknown>) => `${key}:${JSON.stringify(values)}`,
    }),
}));

vi.mock('../../src/store/AppStore', () => ({
    AppStore: {
        state: { whisper: mocks.whisperState },
        getConfig: (key: string) => mocks.configs[key],
        getConfigDefault: (key: string) => mocks.defaults[key],
        setConfig: (key: string, value: unknown) => {
            mocks.configs[key] = value;
            for (const handler of [...(mocks.handlers.get('config:change') ?? [])]) {
                handler({ key, value });
            }
        },
        setWhisperState: (next: Record<string, unknown>) => Object.assign(mocks.whisperState, next),
    },
}));

vi.mock('../../src/core/Cache', () => ({
    CacheKeys: {
        whisperModelReady: (model: string, backend: string) => `whisper:${model}:${backend}`,
    },
    SharedCache: { get: vi.fn(() => undefined) },
}));

vi.mock('../../src/features/Whisper', () => ({
    Whisper: {
        getInstance: () => ({
            getEffectiveModelId: () => 'onnx-community/whisper-small_timestamped',
            getEffectiveBackend: () => 'webgpu',
            getAutoWarmupSuppressionReason: () => null,
            warmupModel: vi.fn(),
        }),
    },
}));

vi.mock('../../src/core/DeviceCapabilities', () => ({
    DeviceCapabilities: { isIPhone: false },
}));

import SettingsPanel from '../../src/features/settings/SettingsPanel.vue';

const ADVANCED_KEYS = Object.keys(ADVANCED_DEFAULTS);

function section(wrapper: VueWrapper) {
    return wrapper.get('#asmr-whisper-settings-section');
}

function advancedToggle(wrapper: VueWrapper) {
    return section(wrapper).get('button[data-asmr-whisper-advanced-toggle]');
}

function configKeysOf(wrapper: VueWrapper, name: string): string[] {
    return wrapper
        .findAllComponents({ name })
        .map(control => String(control.props('configKey')));
}

async function expand(wrapper: VueWrapper) {
    await advancedToggle(wrapper).trigger('click');
    await nextTick();
}

describe('SettingsPanel Whisper advanced disclosure', () => {
    let wrapper: VueWrapper | undefined;

    beforeEach(() => {
        mocks.handlers.clear();
        Object.assign(mocks.defaults, ADVANCED_DEFAULTS);
        mocks.configs = {
            enableVectorSearch: false,
            enableWhisper: true,
            enablePlayerTranslator: false,
            autoProgress: false,
            playlistAutoProgress: false,
            enableStoreBackup: false,
            enableJpdb: false,
            whisperModelPreset: 'small',
            whisperModel: 'onnx-community/whisper-small_timestamped',
            whisperAutoWarmup: false,
            forceWhisperWasm: false,
            whisperLanguage: 'auto',
            googleDriveClientId: '',
            ...ADVANCED_DEFAULTS,
        };
    });

    afterEach(() => {
        wrapper?.unmount();
        wrapper = undefined;
    });

    it('is collapsed on first render so ordinary users never see it', () => {
        wrapper = shallowMount(SettingsPanel);

        expect(advancedToggle(wrapper).attributes('aria-expanded')).toBe('false');
        expect(advancedToggle(wrapper).text()).toBe('whisperAdvancedShow');

        // Nothing the section owns is rendered while it is closed.
        for (const key of ['whisperEncoderDtype', 'whisperDecoderDtype', 'whisperExecutionDevice', 'whisperTask']) {
            expect(configKeysOf(wrapper, 'SettingsSelect')).not.toContain(key);
        }
        expect(wrapper.findAllComponents({ name: 'SettingsValidatedInput' })).toHaveLength(0);
        expect(wrapper.findAllComponents({ name: 'SettingsNumberInput' })).toHaveLength(0);
        expect(section(wrapper).find('button[data-asmr-whisper-advanced-reset]').exists()).toBe(false);
    });

    it('marks itself as advanced and experimental rather than as a normal row', () => {
        wrapper = shallowMount(SettingsPanel);
        expect(section(wrapper).text()).toContain('whisperAdvanced');
        expect(section(wrapper).text()).toContain('whisperAdvancedSub');
    });

    it('reveals every advanced control once expanded, and hides them again', async () => {
        wrapper = shallowMount(SettingsPanel);
        await expand(wrapper);

        expect(advancedToggle(wrapper).attributes('aria-expanded')).toBe('true');
        expect(advancedToggle(wrapper).text()).toBe('whisperAdvancedHide');

        expect(configKeysOf(wrapper, 'SettingsValidatedInput')).toEqual(['whisperCustomModelId']);
        expect(configKeysOf(wrapper, 'SettingsNumberInput')).toEqual([
            'whisperLiveChunkSec',
            'whisperLiveOverlapSec',
            'whisperNoRepeatNgramSize',
            'whisperRepetitionPenalty',
        ]);
        const selects = configKeysOf(wrapper, 'SettingsSelect');
        expect(selects).toContain('whisperEncoderDtype');
        expect(selects).toContain('whisperDecoderDtype');
        expect(selects).toContain('whisperExecutionDevice');
        expect(selects).toContain('whisperTask');
        // Spoken Language is already a row of the same section, so the advanced
        // block must not render a second, identical control for it.
        expect(selects.filter(key => key === 'whisperLanguage')).toHaveLength(1);

        await advancedToggle(wrapper).trigger('click');
        await nextTick();
        expect(advancedToggle(wrapper).attributes('aria-expanded')).toBe('false');
        expect(wrapper.findAllComponents({ name: 'SettingsNumberInput' })).toHaveLength(0);
    });

    it('validates the free-text model id with a hub-shape check', async () => {
        wrapper = shallowMount(SettingsPanel);
        await expand(wrapper);

        const control = wrapper
            .findAllComponents({ name: 'SettingsValidatedInput' })
            .find(item => item.props('configKey') === 'whisperCustomModelId');
        const validate = control?.props('validate') as (value: string) => boolean;

        expect(validate('onnx-community/whisper-small_timestamped')).toBe(true);
        expect(validate('whisper-small')).toBe(false);
        expect(validate('owner/../escape')).toBe(false);
    });

    it('offers the fp16 speed-against-accuracy note only on the select set to fp16', async () => {
        wrapper = shallowMount(SettingsPanel);
        await expand(wrapper);

        const hintFor = (key: string) => wrapper!
            .findAllComponents({ name: 'SettingsSelect' })
            .find(item => item.props('configKey') === key)
            ?.props('hint');

        expect(hintFor('whisperEncoderDtype')).toBe('');
        expect(hintFor('whisperDecoderDtype')).toBe('');

        (wrapper.vm as unknown as Record<string, unknown>).whisperEncoderDtype = 'fp16';
        await nextTick();

        expect(hintFor('whisperEncoderDtype')).toBe('whisperDtypeFp16Hint');
        expect(hintFor('whisperDecoderDtype')).toBe('');
    });

    it('names the precedence instead of letting Force WASM and the device select disagree silently', async () => {
        mocks.configs.forceWhisperWasm = true;
        mocks.configs.whisperExecutionDevice = 'webgpu';
        wrapper = shallowMount(SettingsPanel);
        await expand(wrapper);

        const deviceSelect = wrapper
            .findAllComponents({ name: 'SettingsSelect' })
            .find(item => item.props('configKey') === 'whisperExecutionDevice');

        expect(deviceSelect?.props('hint')).toBe('whisperExecutionDeviceConflict');
    });

    it('explains the split-device measurement when split is selected', async () => {
        mocks.configs.whisperExecutionDevice = 'split';
        wrapper = shallowMount(SettingsPanel);
        await expand(wrapper);

        const deviceSelect = wrapper
            .findAllComponents({ name: 'SettingsSelect' })
            .find(item => item.props('configKey') === 'whisperExecutionDevice');

        expect(deviceSelect?.props('hint')).toBe('whisperDeviceSplitHint');
    });

    it('warns when anti-repetition has been turned off rather than accepting it silently', async () => {
        mocks.configs.whisperNoRepeatNgramSize = 0;
        mocks.configs.whisperRepetitionPenalty = 1;
        wrapper = shallowMount(SettingsPanel);
        await expand(wrapper);

        const hintFor = (key: string) => wrapper!
            .findAllComponents({ name: 'SettingsNumberInput' })
            .find(item => item.props('configKey') === key)
            ?.props('hint');

        expect(hintFor('whisperNoRepeatNgramSize')).toBe('whisperAntiRepetitionDisabled');
        expect(hintFor('whisperRepetitionPenalty')).toBe('whisperAntiRepetitionDisabled');
    });

    it('warns when the overlap would leave a pass with no new audio', async () => {
        mocks.configs.whisperLiveChunkSec = 8;
        mocks.configs.whisperLiveOverlapSec = 10;
        wrapper = shallowMount(SettingsPanel);
        await expand(wrapper);

        const overlap = wrapper
            .findAllComponents({ name: 'SettingsNumberInput' })
            .find(item => item.props('configKey') === 'whisperLiveOverlapSec');

        expect(overlap?.props('hint')).toBe('whisperOverlapExceedsWindow');
    });

    it('restores every advanced key to its default and confirms it', async () => {
        Object.assign(mocks.configs, {
            whisperCustomModelId: 'openai/whisper-large-v3',
            whisperEncoderDtype: 'fp16',
            whisperDecoderDtype: 'q4f16',
            whisperExecutionDevice: 'split',
            whisperLiveChunkSec: 8,
            whisperLiveOverlapSec: 0,
            whisperNoRepeatNgramSize: 0,
            whisperRepetitionPenalty: 1,
            whisperTask: 'translate',
        });
        wrapper = shallowMount(SettingsPanel);
        await expand(wrapper);

        expect(section(wrapper).text()).not.toContain('whisperAdvancedResetDone');

        await section(wrapper).get('button[data-asmr-whisper-advanced-reset]').trigger('click');
        await nextTick();

        for (const key of ADVANCED_KEYS) {
            expect(mocks.configs[key], key).toBe(ADVANCED_DEFAULTS[key]);
        }
        expect(section(wrapper).text()).toContain('whisperAdvancedResetDone');
    });

    it('retires the reset confirmation as soon as an advanced value moves again', async () => {
        mocks.configs.whisperEncoderDtype = 'fp16';
        wrapper = shallowMount(SettingsPanel);
        await expand(wrapper);

        await section(wrapper).get('button[data-asmr-whisper-advanced-reset]').trigger('click');
        await nextTick();
        expect(section(wrapper).text()).toContain('whisperAdvancedResetDone');

        (wrapper.vm as unknown as Record<string, unknown>).whisperDecoderDtype = 'q8';
        await nextTick();

        expect(section(wrapper).text()).not.toContain('whisperAdvancedResetDone');
    });

    it('leaves settings outside the advanced section alone when resetting', async () => {
        mocks.configs.whisperModelPreset = 'medium';
        mocks.configs.forceWhisperWasm = true;
        mocks.configs.whisperAutoWarmup = true;
        wrapper = shallowMount(SettingsPanel);
        await expand(wrapper);

        await section(wrapper).get('button[data-asmr-whisper-advanced-reset]').trigger('click');
        await nextTick();

        expect(mocks.configs.whisperModelPreset).toBe('medium');
        expect(mocks.configs.forceWhisperWasm).toBe(true);
        expect(mocks.configs.whisperAutoWarmup).toBe(true);
        // Spoken Language belongs to the plain section, so Reset must not touch it.
        expect(mocks.configs.whisperLanguage).toBe('auto');
    });

    it('does not render the advanced disclosure when Whisper itself is disabled', () => {
        mocks.configs.enableWhisper = false;
        wrapper = shallowMount(SettingsPanel);

        expect(wrapper.find('#asmr-whisper-settings-section').exists()).toBe(false);
    });
});

/**
 * The panel is checked for row overlap and overflow at 360px by the Playwright
 * spec 'no settings row overlaps or overflows its section at any panel width'.
 * These are the cheap structural preconditions for that spec, so a regression
 * is caught without a browser.
 */
describe('Whisper advanced section layout preconditions', () => {
    const panelSource = readFileSync(
        resolve(process.cwd(), 'src/features/settings/SettingsPanel.vue'),
        'utf8',
    );
    const settingsCss = readFileSync(
        resolve(process.cwd(), 'src/styles/components/_settings.css'),
        'utf8',
    );
    // Bound to the Whisper advanced markup, so unrelated sections further down
    // the panel cannot satisfy or fail these assertions on its behalf.
    const blockStart = panelSource.indexOf('data-asmr-whisper-advanced-toggle');
    const resetEnd = panelSource.indexOf("t('whisperAdvancedResetAction')");
    const advancedBlock = panelSource.slice(
        blockStart,
        panelSource.indexOf('</template>', resetEnd),
    );

    it('locates the advanced markup it is asserting against', () => {
        expect(blockStart).toBeGreaterThan(-1);
        expect(resetEnd).toBeGreaterThan(blockStart);
        expect(advancedBlock).toContain('config-key="whisperCustomModelId"');
        expect(advancedBlock).toContain('config-key="whisperExecutionDevice"');
    });

    it('introduces no q-gutter container, whose negative top margin overlaps the row above', () => {
        expect(advancedBlock).not.toMatch(/q-gutter-/);
    });

    it('adds no negative margin anywhere in the settings stylesheet', () => {
        expect(settingsCss.match(/margin(?:-top|-bottom)?:\s*-/g) ?? []).toEqual([]);
    });

    it('spaces a stacked control from the label above and the caption below it', () => {
        const above = settingsCss.match(
            /\.q-item__label \+ \.asmr-settings-stacked-control\s*\{[^}]*margin-top:\s*(\d+)px/,
        );
        const below = settingsCss.match(
            /\.asmr-settings-stacked-control \+ \.q-item__label\s*\{[^}]*margin-top:\s*(\d+)px/,
        );
        expect(above).not.toBeNull();
        expect(below).not.toBeNull();
        expect(Number(above![1])).toBeGreaterThan(0);
        expect(Number(below![1])).toBeGreaterThan(0);
    });

    it('keeps stacked controls inside the row at the narrowest panel width', () => {
        expect(settingsCss).toMatch(
            /\.asmr-settings-stacked-control\s*\{[^}]*max-width:\s*100%/,
        );
        expect(settingsCss).toMatch(
            /\.asmr-settings-stacked-control\s*\{[^}]*box-sizing:\s*border-box/,
        );
        // The numeric cap must not apply at 360px, where full width is what fits.
        const cappedAt = settingsCss.match(
            /@media \(min-width:\s*(\d+)px\)\s*\{[^}]*\.asmr-settings-number-input/,
        );
        expect(cappedAt).not.toBeNull();
        expect(Number(cappedAt![1])).toBeGreaterThan(360);
    });

    it('renders every advanced row with the same q-item structure the layout rules target', () => {
        const rows = advancedBlock.match(/<div role="listitem"[^>]*class="([^"]*)"/g) ?? [];
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
            expect(row).toContain('q-item');
            expect(row).toContain('asmr-settings-item');
        }
    });
});
