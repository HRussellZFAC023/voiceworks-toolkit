import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    connectAudioPcmTap,
    getOrCreateSourceNode,
    resampleMonoPcm,
} from '../../src/core/AudioAnalysis';
import { DeviceCapabilities } from '../../src/core/DeviceCapabilities';

describe('AudioAnalysis PCM tap', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('resamples mono PCM to the requested rate without mutating the input', () => {
        const input = new Float32Array([0, 0.25, 0.5, 0.75, 1, 0.5]);
        const output = resampleMonoPcm(input, 48_000, 16_000);

        expect(output).toEqual(new Float32Array([0, 0.75]));
        expect(input).toEqual(new Float32Array([0, 0.25, 0.5, 0.75, 1, 0.5]));
    });

    it('reuses one media source and disconnects only the silent analysis branch', () => {
        vi.spyOn(DeviceCapabilities, 'profile', 'get').mockReturnValue({ isMobile: false } as any);

        const source = {
            connect: vi.fn(),
            disconnect: vi.fn(),
        };
        const processor = {
            onaudioprocess: null as ((event: AudioProcessingEvent) => void) | null,
            connect: vi.fn(),
            disconnect: vi.fn(),
        };
        const silentGain = {
            gain: { value: 1 },
            connect: vi.fn(),
            disconnect: vi.fn(),
        };
        const destination = {};
        const createMediaElementSource = vi.fn(() => source);

        class MockAudioContext {
            state = 'running';
            sampleRate = 48_000;
            destination = destination;
            createMediaElementSource = createMediaElementSource;
            createScriptProcessor = vi.fn(() => processor);
            createGain = vi.fn(() => silentGain);
            resume = vi.fn().mockResolvedValue(undefined);
        }
        vi.stubGlobal('AudioContext', MockAudioContext);

        const audio = document.createElement('audio');
        const first = getOrCreateSourceNode(audio);
        const second = getOrCreateSourceNode(audio);
        const tap = connectAudioPcmTap(audio, {
            tag: 'test',
            targetSampleRate: 16_000,
            onData: vi.fn(),
        });

        expect(first?.ctx).toBe(second?.ctx);
        expect(first?.source).toBe(second?.source);
        expect(createMediaElementSource).toHaveBeenCalledTimes(1);
        expect(source.connect).toHaveBeenCalledWith(destination);
        expect(source.connect).toHaveBeenCalledWith(processor);
        expect(silentGain.gain.value).toBe(0);

        tap?.disconnect();
        tap?.disconnect();

        expect(source.disconnect).toHaveBeenCalledTimes(1);
        expect(source.disconnect).toHaveBeenCalledWith(processor);
        expect(processor.disconnect).toHaveBeenCalledTimes(1);
        expect(silentGain.disconnect).toHaveBeenCalledTimes(1);
        // The direct source -> destination playback edge is deliberately kept.
        expect(source.disconnect).not.toHaveBeenCalledWith(destination);
    });
});
