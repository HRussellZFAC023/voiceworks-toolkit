import { describe, expect, it } from 'vitest';
import {
    createWhisperInferencePolicyWorkerSource,
    getWhisperInferenceTimeoutMs,
} from '../../src/features/whisperInferencePolicy';

describe('whisperInferencePolicy', () => {
    it.each([
        ['webgpu', 29, 145_000],
        ['wasm', 29, 116_000],
        ['webgpu', 6, 45_000],
        ['wasm', 6, 90_000],
    ] as const)('embeds the same %s policy used by the controller', (backend, chunkSeconds, expectedMs) => {
        const getWorkerTimeout = new Function(
            `${createWhisperInferencePolicyWorkerSource()}; return getInferenceTimeoutMs;`,
        )() as typeof getWhisperInferenceTimeoutMs;

        expect(getWhisperInferenceTimeoutMs(backend, chunkSeconds)).toBe(expectedMs);
        expect(getWorkerTimeout(backend, chunkSeconds)).toBe(expectedMs);
    });
});
