import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    connectAudioPcmTap,
    downmixSpeechPreserving,
    getOrCreateSourceNode,
    resampleMonoPcm,
    StreamingMonoResampler,
    StreamingSpeechDownmixer,
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

        // Downsampling is anti-alias filtered, so output samples are no longer
        // raw source samples. Rate (3:1) and input immutability still hold.
        expect(output.length).toBe(2);
        expect(input).toEqual(new Float32Array([0, 0.25, 0.5, 0.75, 1, 0.5]));
    });

    it('passes same-rate PCM through untouched', () => {
        const input = new Float32Array([0, 0.25, 0.5, 0.75, 1, 0.5]);
        const output = resampleMonoPcm(input, 16_000, 16_000);

        expect(output).toEqual(input);
    });

    it('preserves resampling duration and continuity across 4096-frame callbacks', () => {
        const sourceRate = 44_100;
        const targetRate = 16_000;
        const blockLength = 4096;
        const blocks = Array.from({ length: 4 }, (_, blockIndex) => (
            Float32Array.from(
                { length: blockLength },
                (_, sampleIndex) => Math.sin(
                    2 * Math.PI * 997 * (blockIndex * blockLength + sampleIndex) / sourceRate,
                ),
            )
        ));
        const combined = new Float32Array(blockLength * blocks.length);
        blocks.forEach((block, index) => combined.set(block, index * blockLength));

        const streaming = new StreamingMonoResampler(sourceRate, targetRate);
        const streamedBlocks = blocks.map(block => streaming.process(block));
        const streamed = new Float32Array(streamedBlocks.reduce((sum, block) => sum + block.length, 0));
        let offset = 0;
        for (const block of streamedBlocks) {
            streamed.set(block, offset);
            offset += block.length;
        }
        const contiguous = new StreamingMonoResampler(sourceRate, targetRate).process(combined);

        expect(streamed.length).toBe(contiguous.length);
        expect(streamed.length / targetRate).toBeCloseTo(combined.length / sourceRate, 3);
        expect(streamed).toEqual(contiguous);
    });

    it('resets streaming phase and carry for a new capture lifecycle', () => {
        const firstBlock = Float32Array.from({ length: 4096 }, (_, index) => index / 4096);
        const secondBlock = Float32Array.from({ length: 4096 }, (_, index) => 1 - index / 4096);
        const resampler = new StreamingMonoResampler(44_100, 16_000);

        resampler.process(firstBlock);
        resampler.process(secondBlock);
        resampler.reset();

        expect(resampler.process(firstBlock)).toEqual(
            new StreamingMonoResampler(44_100, 16_000).process(firstBlock),
        );
    });

    it('preserves anti-phase and one-sided binaural speech instead of cancelling it', () => {
        const speech = Float32Array.from({ length: 512 }, (_, index) => (
            0.4 * Math.sin(2 * Math.PI * index / 32)
        ));
        const antiPhase = Float32Array.from(speech, sample => -sample);
        const silence = new Float32Array(speech.length);

        expect(downmixSpeechPreserving([speech, antiPhase])).toEqual(speech);
        expect(downmixSpeechPreserving([silence, speech])).toEqual(speech);
        expect(downmixSpeechPreserving([speech, silence])).toEqual(speech);
    });

    it('does not hard-switch channels when binaural energy dominance alternates', () => {
        const sampleRate = 48_000;
        const frameSize = 256;
        const left = Float32Array.from({ length: 4096 }, (_, index) => {
            const amplitude = Math.floor(index / frameSize) % 2 === 0 ? 0.6 : 0.5;
            return amplitude * Math.sin(2 * Math.PI * 997 * index / sampleRate);
        });
        const right = Float32Array.from(left, (sample, index) => {
            const leftAmplitude = Math.floor(index / frameSize) % 2 === 0 ? 0.6 : 0.5;
            const rightAmplitude = Math.floor(index / frameSize) % 2 === 0 ? 0.5 : 0.6;
            return -sample * rightAmplitude / leftAmplitude;
        });
        const mono = downmixSpeechPreserving([left, right], frameSize);
        const maxAdjacentDelta = (samples: Float32Array): number => {
            let maximum = 0;
            for (let i = 1; i < samples.length; i++) {
                maximum = Math.max(maximum, Math.abs(samples[i] - samples[i - 1]));
            }
            return maximum;
        };

        const inputDelta = Math.max(maxAdjacentDelta(left), maxAdjacentDelta(right));
        expect(maxAdjacentDelta(mono)).toBeLessThanOrEqual(inputDelta * 1.1);
    });

    it('retains unrelated content from both stereo channels', () => {
        const sampleRate = 48_000;
        const left = Float32Array.from({ length: 8192 }, (_, index) => (
            0.4 * Math.sin(2 * Math.PI * 997 * index / sampleRate)
        ));
        const right = Float32Array.from({ length: left.length }, (_, index) => (
            0.25 * Math.sin(2 * Math.PI * 1603 * index / sampleRate)
        ));
        const mono = downmixSpeechPreserving([left, right]);
        const projection = (reference: Float32Array): number => {
            let dot = 0;
            let energy = 0;
            for (let i = 0; i < mono.length; i++) {
                dot += mono[i] * reference[i];
                energy += reference[i] * reference[i];
            }
            return Math.abs(dot / energy);
        };

        expect(projection(left)).toBeGreaterThan(0.4);
        expect(projection(right)).toBeGreaterThan(0.4);
    });

    it('crossfades phase-mode changes across streaming callbacks', () => {
        const sampleRate = 48_000;
        const left = Float32Array.from({ length: 4096 }, (_, index) => (
            0.4 * Math.sin(2 * Math.PI * 997 * index / sampleRate)
        ));
        const inPhase = left.slice();
        const antiPhase = Float32Array.from(left, sample => -sample);
        const downmixer = new StreamingSpeechDownmixer();
        const first = downmixer.process([left, inPhase]);
        const second = downmixer.process([left, antiPhase]);

        expect(Math.abs(second[0] - first[first.length - 1])).toBeLessThan(0.2);
        expect(second.slice(512)).toEqual(left.slice(512));
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

describe('StreamingMonoResampler anti-aliasing', () => {
    /** Goertzel magnitude of `freq` in `signal`, normalised by sample count. */
    function toneMagnitude(signal: Float32Array, freq: number, sampleRate: number): number {
        const w = (2 * Math.PI * freq) / sampleRate;
        const cosW = Math.cos(w);
        const coeff = 2 * cosW;
        let s1 = 0;
        let s2 = 0;
        for (let i = 0; i < signal.length; i++) {
            const s0 = signal[i] + coeff * s1 - s2;
            s2 = s1;
            s1 = s0;
        }
        const real = s1 - s2 * cosW;
        const imag = s2 * Math.sin(w);
        return (2 * Math.hypot(real, imag)) / signal.length;
    }

    function sine(freq: number, sampleRate: number, samples: number): Float32Array {
        const out = new Float32Array(samples);
        for (let i = 0; i < samples; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate);
        return out;
    }

    it('suppresses the alias when decimating 48kHz to 16kHz', () => {
        // 12 kHz at 48 kHz decimated by 3 folds to |12000 - 16000| = 4 kHz.
        // Unfiltered decimation reproduces it at full amplitude.
        const input = sine(12_000, 48_000, 48_000);
        const resampler = new StreamingMonoResampler(48_000, 16_000);
        const out = resampler.process(input);

        const aliasDb = 20 * Math.log10(Math.max(toneMagnitude(out, 4_000, 16_000), 1e-12));
        expect(aliasDb).toBeLessThan(-40);
    });

    it('preserves speech-band content through the anti-alias filter', () => {
        const input = sine(1_000, 48_000, 48_000);
        const resampler = new StreamingMonoResampler(48_000, 16_000);
        const out = resampler.process(input);

        // 1 kHz is deep in the pass band and must survive essentially intact.
        const passDb = 20 * Math.log10(Math.max(toneMagnitude(out, 1_000, 16_000), 1e-12));
        expect(passDb).toBeGreaterThan(-3);
    });

    it('filters continuously across block boundaries', () => {
        const full = sine(12_000, 48_000, 48_000);
        const streamed = new StreamingMonoResampler(48_000, 16_000);
        const chunks: Float32Array[] = [];
        for (let i = 0; i < full.length; i += 4096) {
            chunks.push(streamed.process(full.subarray(i, Math.min(i + 4096, full.length))));
        }
        const joined = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
        let offset = 0;
        for (const c of chunks) { joined.set(c, offset); offset += c.length; }

        // Block-wise processing must not reintroduce the alias via filter resets.
        const aliasDb = 20 * Math.log10(Math.max(toneMagnitude(joined, 4_000, 16_000), 1e-12));
        expect(aliasDb).toBeLessThan(-40);
    });
});
