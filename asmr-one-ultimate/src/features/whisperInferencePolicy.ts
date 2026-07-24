export type WhisperInferenceBackend = 'webgpu' | 'wasm';

interface WhisperInferenceTimeoutPolicy {
    defaultChunkSeconds: number;
    webgpu: {
        minimumMs: number;
        perChunkSecondMs: number;
    };
    wasm: {
        minimumMs: number;
        maximumMs: number;
        perChunkSecondMs: number;
    };
}

const WHISPER_INFERENCE_TIMEOUT_POLICY = Object.freeze({
    defaultChunkSeconds: 30,
    webgpu: {
        minimumMs: 45_000,
        perChunkSecondMs: 5_000,
    },
    wasm: {
        minimumMs: 90_000,
        maximumMs: 180_000,
        perChunkSecondMs: 4_000,
    },
}) satisfies Readonly<WhisperInferenceTimeoutPolicy>;

export const WHISPER_STALL_WATCHDOG_MARGIN_MS = 15_000;

/**
 * Pure implementation shared with the inline worker. Keep this function
 * closure-free so its source can be embedded without maintaining a second
 * timeout formula inside the worker string.
 */
function calculateWhisperInferenceTimeoutMs(
    policy: WhisperInferenceTimeoutPolicy,
    backend: WhisperInferenceBackend,
    chunkLengthSeconds: number,
): number {
    const chunkSeconds = Number(chunkLengthSeconds) || policy.defaultChunkSeconds;
    if (backend === 'webgpu') {
        return Math.max(
            policy.webgpu.minimumMs,
            chunkSeconds * policy.webgpu.perChunkSecondMs,
        );
    }
    return Math.min(
        policy.wasm.maximumMs,
        Math.max(
            policy.wasm.minimumMs,
            chunkSeconds * policy.wasm.perChunkSecondMs,
        ),
    );
}

export function getWhisperInferenceTimeoutMs(
    backend: WhisperInferenceBackend,
    chunkLengthSeconds: number,
): number {
    return calculateWhisperInferenceTimeoutMs(
        WHISPER_INFERENCE_TIMEOUT_POLICY,
        backend,
        chunkLengthSeconds,
    );
}

export function getWhisperStallWatchdogMs(
    backend: WhisperInferenceBackend,
    chunkLengthSeconds: number,
): number {
    return getWhisperInferenceTimeoutMs(backend, chunkLengthSeconds)
        + WHISPER_STALL_WATCHDOG_MARGIN_MS;
}

export function createWhisperInferencePolicyWorkerSource(): string {
    return `
const WHISPER_INFERENCE_TIMEOUT_POLICY = ${JSON.stringify(WHISPER_INFERENCE_TIMEOUT_POLICY)};
const calculateWhisperInferenceTimeoutMs = ${calculateWhisperInferenceTimeoutMs.toString()};
function getInferenceTimeoutMs(currentBackend, chunkLengthS) {
    return calculateWhisperInferenceTimeoutMs(
        WHISPER_INFERENCE_TIMEOUT_POLICY,
        currentBackend === 'webgpu' ? 'webgpu' : 'wasm',
        chunkLengthS,
    );
}
`;
}
