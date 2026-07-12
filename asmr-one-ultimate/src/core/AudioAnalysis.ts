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
 * Resample a short mono block with linear interpolation. The audio tap uses a
 * 4096-frame block, so this keeps allocations bounded while producing the
 * 16 kHz input expected by Whisper.
 */
export function resampleMonoPcm(
    input: Float32Array,
    sourceSampleRate: number,
    targetSampleRate: number,
): Float32Array {
    if (input.length === 0 || sourceSampleRate <= 0 || targetSampleRate <= 0) {
        return new Float32Array(0);
    }
    if (sourceSampleRate === targetSampleRate) return input.slice();

    const outputLength = Math.max(1, Math.floor(input.length * targetSampleRate / sourceSampleRate));
    const output = new Float32Array(outputLength);
    const sourceStep = sourceSampleRate / targetSampleRate;
    for (let i = 0; i < outputLength; i++) {
        const sourcePosition = i * sourceStep;
        const leftIndex = Math.min(input.length - 1, Math.floor(sourcePosition));
        const rightIndex = Math.min(input.length - 1, leftIndex + 1);
        const fraction = sourcePosition - leftIndex;
        output[i] = input[leftIndex] + (input[rightIndex] - input[leftIndex]) * fraction;
    }
    return output;
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

        processor.onaudioprocess = (event: AudioProcessingEvent) => {
            if (disconnected) return;
            try {
                const input = event.inputBuffer;
                const channels = Math.max(1, input.numberOfChannels);
                const mono = new Float32Array(input.length);
                for (let channel = 0; channel < channels; channel++) {
                    const data = input.getChannelData(channel);
                    for (let i = 0; i < data.length; i++) mono[i] += data[i] / channels;
                }
                options.onData(resampleMonoPcm(mono, result.ctx.sampleRate, options.targetSampleRate));
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
