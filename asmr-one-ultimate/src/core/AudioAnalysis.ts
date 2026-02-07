/**
 * Shared Audio Analysis - singleton AudioContext + MediaElementSourceNode
 *
 * `createMediaElementSource()` can only be called once per <audio> element.
 * This module provides a shared source node that multiple features (JoiTool,
 * Visualizer) can branch their own AnalyserNodes from.
 */

import { Logger } from './Utils';

const sourceNodes = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
const contexts = new WeakMap<HTMLMediaElement, AudioContext>();

/**
 * Get (or create) a shared AudioContext + MediaElementSourceNode for the given
 * audio element.  The source is automatically connected to `ctx.destination`
 * so playback is not interrupted.
 *
 * Returns `null` if the connection fails (e.g. cross-origin).
 */
export function getOrCreateSourceNode(
    audio: HTMLAudioElement,
): { ctx: AudioContext; source: MediaElementAudioSourceNode } | null {
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
