import { describe, expect, it } from 'vitest';
import {
    createWhisperInferencePolicyWorkerSource,
    getWhisperInferenceTimeoutMs,
    getWhisperStallWatchdogMs,
    updateWhisperInferenceDurationEwma,
    WHISPER_STALL_WATCHDOG_MARGIN_MS,
} from '../../src/features/whisperInferencePolicy';

describe('whisperInferencePolicy', () => {
    it.each([
        ['webgpu', 29, 145_000],
        ['wasm', 29, 116_000],
        ['webgpu', 6, 120_000],
        ['wasm', 6, 90_000],
    ] as const)('embeds the same %s policy used by the controller', (backend, chunkSeconds, expectedMs) => {
        const getWorkerTimeout = new Function(
            `${createWhisperInferencePolicyWorkerSource()}; return getInferenceTimeoutMs;`,
        )() as typeof getWhisperInferenceTimeoutMs;

        expect(getWhisperInferenceTimeoutMs(backend, chunkSeconds)).toBe(expectedMs);
        expect(getWorkerTimeout(backend, chunkSeconds)).toBe(expectedMs);
    });

    it('allows Firefox WebGPU compilation and contended warm calls to finish', () => {
        const getWorkerTimeout = new Function(
            `${createWhisperInferencePolicyWorkerSource()}; return getInferenceTimeoutMs;`,
        )() as typeof getWhisperInferenceTimeoutMs;

        expect(getWhisperInferenceTimeoutMs('webgpu', 2, true)).toBe(180_000);
        expect(getWorkerTimeout('webgpu', 2, true)).toBe(180_000);
        expect(getWhisperStallWatchdogMs('webgpu', 2, true)).toBe(
            180_000 + WHISPER_STALL_WATCHDOG_MARGIN_MS,
        );

        expect(getWhisperInferenceTimeoutMs('webgpu', 2)).toBe(120_000);
        expect(getWorkerTimeout('webgpu', 2)).toBe(120_000);
        expect(getWhisperInferenceTimeoutMs('wasm', 2, true)).toBe(90_000);
    });

    it('bounds the WebGPU hard ceiling at five minutes', () => {
        const getWorkerTimeout = new Function(
            `${createWhisperInferencePolicyWorkerSource()}; return getInferenceTimeoutMs;`,
        )() as typeof getWhisperInferenceTimeoutMs;

        expect(getWhisperInferenceTimeoutMs('webgpu', 300)).toBe(300_000);
        expect(getWorkerTimeout('webgpu', 300)).toBe(300_000);
    });

    it.each([
        ['onnx-community/whisper-base_timestamped', 120_000],
        ['onnx-community/whisper-small_timestamped', 150_000],
        ['onnx-community/whisper-medium_timestamped', 210_000],
        ['onnx-community/whisper-large-v3-turbo_timestamped', 270_000],
    ] as const)('scales a warm short-window ceiling for the frozen %s plan', (model, expectedMs) => {
        const getWorkerTimeout = new Function(
            `${createWhisperInferencePolicyWorkerSource()}; return getInferenceTimeoutMs;`,
        )() as typeof getWhisperInferenceTimeoutMs;

        expect(getWhisperInferenceTimeoutMs('webgpu', 8, false, model)).toBe(expectedMs);
        expect(getWorkerTimeout('webgpu', 8, false, model)).toBe(expectedMs);
    });

    it('only lengthens the model floor from recent direct inference and remains bounded', () => {
        const getWorkerTimeout = new Function(
            `${createWhisperInferencePolicyWorkerSource()}; return getInferenceTimeoutMs;`,
        )() as typeof getWhisperInferenceTimeoutMs;
        const model = 'onnx-community/whisper-base_timestamped';

        expect(getWhisperInferenceTimeoutMs('webgpu', 8, false, model, 100_000))
            .toBe(150_000);
        expect(getWorkerTimeout('webgpu', 8, false, model, 100_000))
            .toBe(150_000);
        expect(getWhisperInferenceTimeoutMs('webgpu', 8, false, model, 40_000))
            .toBe(120_000);
        expect(getWhisperInferenceTimeoutMs('webgpu', 8, false, model, 250_000))
            .toBe(300_000);
    });

    it('tracks recent successful direct inference with a conservative EWMA', () => {
        const first = updateWhisperInferenceDurationEwma(null, 100_000);
        const second = updateWhisperInferenceDurationEwma(first, 140_000);

        expect(first).toBe(100_000);
        expect(second).toBe(114_000);
        expect(updateWhisperInferenceDurationEwma(second, Number.NaN)).toBe(second);
    });
});
