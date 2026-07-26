/**
 * Shared Audio Analysis - singleton AudioContext + MediaElementSourceNode
 *
 * `createMediaElementSource()` can only be called once per <audio> element.
 * This module provides a shared source node that multiple features (JoiTool,
 * Visualizer) can branch their own AnalyserNodes from.
 *
 * IMPORTANT — Mobile guard:
 * `createMediaElementSource()` permanently reroutes the <audio> element's
 * output through the Web Audio API graph.  On mobile browsers, the
 * AudioContext is automatically suspended when the page is backgrounded
 * (phone locked / app switched).  Because the audio flows through the
 * suspended context, playback goes silent even though the <audio> element
 * still reports `paused === false`.  This is irreversible per element.
 *
 * To preserve background/lock-screen playback on mobile, we refuse to
 * create the source node on mobile devices.  Visualizer and JoiTool
 * already handle the `null` return gracefully.
 */

import { Logger } from './Utils';
import { DeviceCapabilities } from './DeviceCapabilities';
import { getAudioElement, hasValidAudioSource } from './DomUtils';

const sourceNodes = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
const contexts = new WeakMap<HTMLMediaElement, AudioContext>();

/** Whether another feature has already routed this element through Web Audio. */
export function hasSharedSourceNode(audio: HTMLMediaElement): boolean {
    return sourceNodes.has(audio);
}

/**
 * Get (or create) a shared AudioContext + MediaElementSourceNode for the given
 * audio element.  The source is automatically connected to `ctx.destination`
 * so playback is not interrupted.
 *
 * Returns `null` if the connection fails (e.g. cross-origin) or if the device
 * is mobile (to preserve background audio playback).
 */
export function getOrCreateSourceNode(
    audio: HTMLAudioElement,
): { ctx: AudioContext; source: MediaElementAudioSourceNode } | null {
    // On mobile, never connect createMediaElementSource — it permanently
    // reroutes audio through the AudioContext, which suspends on background
    // and kills lock-screen / background playback.
    const profile = DeviceCapabilities.profile;
    if (profile.isMobile) {
        Logger.debug('[AudioAnalysis] Skipping source node on mobile (preserves background playback)');
        return null;
    }

    try {
        let ctx = contexts.get(audio);
        if (!ctx) {
            ctx = new AudioContext();
            contexts.set(audio, ctx);
        }

        if (ctx.state === 'suspended') {
            ctx.resume().catch(() => {});
        }

        let source = sourceNodes.get(audio);
        if (!source) {
            source = ctx.createMediaElementSource(audio);
            source.connect(ctx.destination);
            sourceNodes.set(audio, source);
        }

        return { ctx, source };
    } catch (err) {
        Logger.debug('[AudioAnalysis] Failed to create source node:', err);
        return null;
    }
}

/**
 * Resume any AudioContext associated with the given audio element.
 * Called on visibilitychange ('visible') to recover from browser-initiated
 * suspension (e.g. returning from a backgrounded tab on desktop).
 */
export function resumeAudioContext(audio: HTMLAudioElement): void {
    const ctx = contexts.get(audio);
    if (ctx && ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
        Logger.debug('[AudioAnalysis] Resumed AudioContext after visibility change');
    }
}

export interface AudioAnalyserOptions {
    fftSize: number;
    smoothingTimeConstant: number;
    tag: string;
    requireValidSource?: boolean;
}

export interface ConnectedAudioAnalyser {
    audio: HTMLAudioElement;
    ctx: AudioContext;
    source: MediaElementAudioSourceNode;
    analyser: AnalyserNode;
}

export interface AudioPcmTapOptions {
    tag: string;
    targetSampleRate: number;
    onData: (monoPcm: Float32Array) => void;
}

export interface ConnectedAudioPcmTap {
    ctx: AudioContext;
    disconnect: () => void;
}

/**
 * Cascaded Butterworth low-pass, transposed direct form II, with state carried
 * across blocks so a continuous stream has no discontinuity at block joins.
 *
 * Required before any decimation. Whisper's mel front-end only looks below
 * 8 kHz, but decimating without a filter does not discard the energy above it —
 * it folds it back into the speech band at full amplitude. ASMR is the
 * pathological case: whispers, sibilance, mouth clicks, tapping and brushing
 * carry most of their energy above 8 kHz while the speech itself sits near the
 * noise floor, so unfiltered decimation buries quiet speech under aliased hash.
 */
export class StreamingLowPassFilter {
    private readonly coefficients: Float64Array;
    private readonly state: Float64Array;

    /** @param sections Number of biquads; filter order is 2 x sections. */
    constructor(cutoffHz: number, sampleRate: number, sections = 4) {
        const nyquist = sampleRate / 2;
        const cutoff = Math.max(1, Math.min(cutoffHz, nyquist * 0.99));
        const w0 = (2 * Math.PI * cutoff) / sampleRate;
        const cosW0 = Math.cos(w0);
        const sinW0 = Math.sin(w0);
        this.coefficients = new Float64Array(sections * 5);
        this.state = new Float64Array(sections * 2);
        for (let s = 0; s < sections; s++) {
            // Butterworth pole Q for section s of a 2*sections-order cascade.
            const q = 1 / (2 * Math.cos(((2 * s + 1) * Math.PI) / (4 * sections)));
            const alpha = sinW0 / (2 * q);
            const a0 = 1 + alpha;
            const base = s * 5;
            this.coefficients[base] = ((1 - cosW0) / 2) / a0;      // b0
            this.coefficients[base + 1] = (1 - cosW0) / a0;        // b1
            this.coefficients[base + 2] = ((1 - cosW0) / 2) / a0;  // b2
            this.coefficients[base + 3] = (-2 * cosW0) / a0;       // a1
            this.coefficients[base + 4] = (1 - alpha) / a0;        // a2
        }
    }

    process(input: Float32Array): Float32Array {
        const sections = this.state.length / 2;
        const output = new Float32Array(input.length);
        for (let i = 0; i < input.length; i++) {
            let sample = input[i];
            for (let s = 0; s < sections; s++) {
                const c = s * 5;
                const z = s * 2;
                const b0 = this.coefficients[c];
                const b1 = this.coefficients[c + 1];
                const b2 = this.coefficients[c + 2];
                const a1 = this.coefficients[c + 3];
                const a2 = this.coefficients[c + 4];
                const y = b0 * sample + this.state[z];
                this.state[z] = b1 * sample - a1 * y + this.state[z + 1];
                this.state[z + 1] = b2 * sample - a2 * y;
                sample = y;
            }
            output[i] = sample;
        }
        return output;
    }

    reset(): void {
        this.state.fill(0);
    }
}

/**
 * Band-limited resampler for a continuous PCM stream. Source position is
 * retained between blocks so callback boundaries cannot duplicate or skip
 * samples, and downsampling is anti-alias filtered before decimation.
 */
export class StreamingMonoResampler {
    private readonly sourceStep: number;
    private readonly antiAlias: StreamingLowPassFilter | null;
    private nextSourcePosition = 0;
    private inputOffset = 0;
    private carrySample: number | null = null;

    constructor(
        readonly sourceSampleRate: number,
        readonly targetSampleRate: number,
    ) {
        if (sourceSampleRate <= 0 || targetSampleRate <= 0) {
            throw new RangeError('Sample rates must be positive');
        }
        this.sourceStep = sourceSampleRate / targetSampleRate;
        // Only downsampling aliases. 45% of the target rate leaves the speech
        // band intact while putting the stop band below the new Nyquist.
        this.antiAlias = sourceSampleRate > targetSampleRate
            ? new StreamingLowPassFilter(targetSampleRate * 0.45, sourceSampleRate)
            : null;
    }

    process(input: Float32Array): Float32Array {
        if (input.length === 0) return new Float32Array(0);

        if (this.sourceSampleRate === this.targetSampleRate) {
            this.inputOffset += input.length;
            this.nextSourcePosition = this.inputOffset;
            this.carrySample = input[input.length - 1];
            return input.slice();
        }

        // Band-limit before decimating; the filter keeps its own state across
        // blocks so this is safe to apply per callback.
        const source = this.antiAlias ? this.antiAlias.process(input) : input;

        const chunkStart = this.inputOffset;
        const chunkEnd = chunkStart + source.length - 1;
        const availableStart = this.carrySample === null ? chunkStart : chunkStart - 1;
        const capacity = Math.ceil(source.length / this.sourceStep) + 1;
        const output = new Float32Array(capacity);
        let outputLength = 0;

        while (this.nextSourcePosition <= chunkEnd) {
            const leftIndex = Math.floor(this.nextSourcePosition);
            const fraction = this.nextSourcePosition - leftIndex;
            const rightIndex = fraction < Number.EPSILON ? leftIndex : leftIndex + 1;
            if (leftIndex < availableStart || rightIndex > chunkEnd) break;

            const left = leftIndex === chunkStart - 1
                ? this.carrySample ?? source[0]
                : source[leftIndex - chunkStart];
            const right = rightIndex === chunkStart - 1
                ? this.carrySample ?? source[0]
                : source[rightIndex - chunkStart];
            output[outputLength++] = left + (right - left) * fraction;
            this.nextSourcePosition += this.sourceStep;
        }

        this.inputOffset += source.length;
        this.carrySample = source[source.length - 1];
        return output.slice(0, outputLength);
    }

    reset(): void {
        this.nextSourcePosition = 0;
        this.inputOffset = 0;
        this.carrySample = null;
        this.antiAlias?.reset();
    }
}

/**
 * One-shot compatibility helper. Live audio should reuse one
 * StreamingMonoResampler for the lifetime of its tap.
 */
export function resampleMonoPcm(
    input: Float32Array,
    sourceSampleRate: number,
    targetSampleRate: number,
): Float32Array {
    if (input.length === 0 || sourceSampleRate <= 0 || targetSampleRate <= 0) {
        return new Float32Array(0);
    }
    return new StreamingMonoResampler(sourceSampleRate, targetSampleRate).process(input);
}

const DOWNMIX_CORRELATION_THRESHOLD = 0.35;
const DOWNMIX_FRAME_SIZE = 1024;
const DOWNMIX_TRANSITION_SAMPLES = 256;
const DOWNMIX_SILENCE_FLOOR = 1e-12;

/**
 * Stateful stereo-to-mono mixer for binaural speech.
 *
 * Independent channels are combined, rather than selecting and discarding the
 * quieter one. Strong negative correlation selects the side signal so
 * opposite-phase audio cannot cancel. Polarity and gain changes are crossfaded
 * to avoid injecting clicks at analysis-frame boundaries.
 */
export class StreamingSpeechDownmixer {
    private rightPolarity = 1;
    private gain = 0.5;
    private initialized = false;

    process(
        channelData: readonly Float32Array[],
        frameSize = DOWNMIX_FRAME_SIZE,
    ): Float32Array {
        if (channelData.length === 0 || frameSize <= 0) return new Float32Array(0);
        const length = Math.min(...channelData.map(channel => channel.length));
        if (length === 0) return new Float32Array(0);
        if (channelData.length === 1) return channelData[0].slice(0, length);

        // The PCM tap requests two input channels. Retain a conservative mean
        // for any non-standard multichannel caller instead of silently dropping
        // channels that this stereo correlation policy cannot classify.
        if (channelData.length > 2) {
            const mono = new Float32Array(length);
            for (const channel of channelData) {
                for (let i = 0; i < length; i++) mono[i] += channel[i] / channelData.length;
            }
            return mono;
        }

        const left = channelData[0];
        const right = channelData[1];
        const mono = new Float32Array(length);

        for (let frameStart = 0; frameStart < length; frameStart += frameSize) {
            const frameEnd = Math.min(length, frameStart + frameSize);
            let leftEnergy = 0;
            let rightEnergy = 0;
            let crossEnergy = 0;
            for (let i = frameStart; i < frameEnd; i++) {
                leftEnergy += left[i] * left[i];
                rightEnergy += right[i] * right[i];
                crossEnergy += left[i] * right[i];
            }

            const correlationDenominator = Math.sqrt(leftEnergy * rightEnergy);
            const correlation = correlationDenominator > DOWNMIX_SILENCE_FLOOR
                ? crossEnergy / correlationDenominator
                : 0;
            let targetPolarity = this.rightPolarity;
            if (correlation <= -DOWNMIX_CORRELATION_THRESHOLD) targetPolarity = -1;
            if (correlation >= DOWNMIX_CORRELATION_THRESHOLD) targetPolarity = 1;

            const mixedEnergy = leftEnergy
                + rightEnergy
                + 2 * targetPolarity * crossEnergy;
            const targetEnergy = Math.max(leftEnergy, rightEnergy);
            const targetGain = mixedEnergy > DOWNMIX_SILENCE_FLOOR
                ? Math.sqrt(targetEnergy / mixedEnergy)
                : this.gain;

            if (!this.initialized) {
                this.rightPolarity = targetPolarity;
                this.gain = targetGain;
                this.initialized = true;
            }

            const startPolarity = this.rightPolarity;
            const startGain = this.gain;
            const transitionLength = Math.min(
                frameEnd - frameStart,
                DOWNMIX_TRANSITION_SAMPLES,
            );
            for (let i = frameStart; i < frameEnd; i++) {
                const transitionIndex = i - frameStart + 1;
                const progress = Math.min(1, transitionIndex / transitionLength);
                const polarity = startPolarity
                    + (targetPolarity - startPolarity) * progress;
                const gain = startGain + (targetGain - startGain) * progress;
                mono[i] = (left[i] + polarity * right[i]) * gain;
            }

            this.rightPolarity = targetPolarity;
            this.gain = targetGain;
        }

        return mono;
    }

    reset(): void {
        this.rightPolarity = 1;
        this.gain = 0.5;
        this.initialized = false;
    }
}

/** One-shot compatibility helper for tests and non-streaming callers. */
export function downmixSpeechPreserving(
    channelData: readonly Float32Array[],
    frameSize = DOWNMIX_FRAME_SIZE,
): Float32Array {
    return new StreamingSpeechDownmixer().process(channelData, frameSize);
}

/**
 * Attach a silent PCM analysis branch to the existing shared media source.
 * Playback remains on the source -> destination connection established by
 * getOrCreateSourceNode(); the zero-gain branch merely keeps audio callbacks
 * alive and can be disconnected independently.
 */
export function connectAudioPcmTap(
    audio: HTMLAudioElement,
    options: AudioPcmTapOptions,
): ConnectedAudioPcmTap | null {
    const result = getOrCreateSourceNode(audio);
    if (!result) return null;

    try {
        // ScriptProcessor is deprecated but remains the only synchronous,
        // CSP-safe PCM tap available to userscripts in Firefox and Safari.
        // A small bounded buffer is sufficient for speech transcription.
        const processor = result.ctx.createScriptProcessor(4096, 2, 1);
        const silentGain = result.ctx.createGain();
        silentGain.gain.value = 0;
        let disconnected = false;
        const resampler = new StreamingMonoResampler(
            result.ctx.sampleRate,
            options.targetSampleRate,
        );
        const downmixer = new StreamingSpeechDownmixer();

        processor.onaudioprocess = (event: AudioProcessingEvent) => {
            if (disconnected) return;
            try {
                const input = event.inputBuffer;
                const channels = Math.max(1, input.numberOfChannels);
                const channelData: Float32Array[] = [];
                for (let channel = 0; channel < channels; channel++) {
                    channelData.push(input.getChannelData(channel));
                }
                const mono = downmixer.process(channelData);
                options.onData(resampler.process(mono));
            } catch (err) {
                Logger.debug(`[${options.tag}] PCM callback failed:`, err);
            }
        };

        result.source.connect(processor);
        processor.connect(silentGain);
        silentGain.connect(result.ctx.destination);

        return {
            ctx: result.ctx,
            disconnect: () => {
                if (disconnected) return;
                disconnected = true;
                processor.onaudioprocess = null;
                resampler.reset();
                downmixer.reset();
                try { result.source.disconnect(processor); } catch { /* already disconnected */ }
                try { processor.disconnect(); } catch { /* already disconnected */ }
                try { silentGain.disconnect(); } catch { /* already disconnected */ }
            },
        };
    } catch (err) {
        Logger.debug(`[${options.tag}] PCM tap failed:`, err);
        return null;
    }
}

/**
 * Build and connect an AnalyserNode to the shared source node for the current
 * page audio element. Returns null when unavailable.
 */
export function connectAudioAnalyser(options: AudioAnalyserOptions): ConnectedAudioAnalyser | null {
    const audio = getAudioElement();
    if (!audio || (options.requireValidSource && !hasValidAudioSource(audio))) {
        Logger.debug(`[${options.tag}] No valid audio source found`);
        return null;
    }

    const result = getOrCreateSourceNode(audio);
    if (!result) {
        Logger.debug(`[${options.tag}] Audio analyser failed (cross-origin?)`);
        return null;
    }

    try {
        const analyser = result.ctx.createAnalyser();
        analyser.fftSize = options.fftSize;
        analyser.smoothingTimeConstant = options.smoothingTimeConstant;
        result.source.connect(analyser);
        return { audio, ctx: result.ctx, source: result.source, analyser };
    } catch (err) {
        Logger.debug(`[${options.tag}] Audio analyser failed:`, err);
        return null;
    }
}
