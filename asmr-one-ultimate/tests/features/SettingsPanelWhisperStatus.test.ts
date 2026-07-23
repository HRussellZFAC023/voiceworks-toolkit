import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { shallowMount, type VueWrapper } from '@vue/test-utils';

const mocks = vi.hoisted(() => ({
    handlers: new Map<string, Array<(payload: unknown) => void>>(),
    configs: {
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
        googleDriveClientId: '',
    } as Record<string, unknown>,
    whisperState: {
        isTranscribing: false,
        isLoadingModel: false,
        progress: 0,
        progressMessage: '',
        currentTrackSrc: null,
    },
    effectiveModel: 'onnx-community/whisper-small_timestamped',
    warmupModel: vi.fn(),
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
        setConfig: (key: string, value: unknown) => { mocks.configs[key] = value; },
        setWhisperState: (next: Record<string, unknown>) => Object.assign(mocks.whisperState, next),
    },
}));

vi.mock('../../src/core/Cache', () => ({
    CacheKeys: { whisperModelReady: (model: string) => `whisper:${model}` },
    SharedCache: { get: vi.fn(() => undefined) },
}));

vi.mock('../../src/features/Whisper', () => ({
    Whisper: {
        getInstance: () => ({
            getEffectiveModelId: () => mocks.effectiveModel,
            warmupModel: mocks.warmupModel,
        }),
    },
}));

vi.mock('../../src/core/DeviceCapabilities', () => ({
    DeviceCapabilities: { isIPhone: false },
}));

import SettingsPanel from '../../src/features/settings/SettingsPanel.vue';

function emit(event: string, payload: unknown): void {
    for (const handler of [...(mocks.handlers.get(event) ?? [])]) handler(payload);
}

describe('SettingsPanel Whisper download status', () => {
    let wrapper: VueWrapper | undefined;

    beforeEach(() => {
        mocks.handlers.clear();
        mocks.warmupModel.mockReset();
        mocks.configs.whisperModelPreset = 'small';
        mocks.configs.whisperModel = 'onnx-community/whisper-small_timestamped';
        mocks.configs.whisperAutoWarmup = false;
        mocks.effectiveModel = 'onnx-community/whisper-small_timestamped';
        Object.assign(mocks.whisperState, {
            isTranscribing: false,
            isLoadingModel: false,
            progress: 0,
            progressMessage: '',
            currentTrackSrc: null,
        });
    });

    afterEach(() => {
        wrapper?.unmount();
        wrapper = undefined;
    });

    it.each([
        'whisperModelPreset',
        'whisperModel',
        'forceWhisperWasm',
    ])('invalidates stale local loading state when %s changes without auto-warmup', async (key) => {
        wrapper = shallowMount(SettingsPanel);
        const section = () => wrapper!.get('#asmr-whisper-settings-section');
        const button = () => section().get('button[aria-label="downloadWhisperModel"]');

        mocks.whisperState.isLoadingModel = true;
        emit('whisper:progress', { stage: 'model', percent: 37, message: 'old model download' });
        await nextTick();
        expect(button().attributes('disabled')).toBeDefined();
        expect(section().text()).toContain('(37%)');

        mocks.whisperState.isLoadingModel = false;
        mocks.whisperState.progress = 0;
        mocks.whisperState.progressMessage = '';
        mocks.effectiveModel = 'onnx-community/whisper-medium_timestamped';
        emit('config:change', { key, value: key === 'forceWhisperWasm' ? true : 'medium' });
        await nextTick();

        expect(button().attributes('disabled')).toBeUndefined();
        expect(section().text()).toContain('downloadWhisperModelSub');
        expect(section().text()).not.toContain('(37%)');
        expect(mocks.warmupModel).not.toHaveBeenCalled();

        // A later explicit warmup remains authoritative and repopulates the
        // same local status for the newly effective model.
        mocks.whisperState.isLoadingModel = true;
        emit('whisper:progress', { stage: 'model', percent: 42, message: 'new model download' });
        await nextTick();

        expect(button().attributes('disabled')).toBeDefined();
        expect(section().text()).toContain('whisper-medium_timestamped (42%)');
    });
});
