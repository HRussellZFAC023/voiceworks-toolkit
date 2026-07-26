export type WhisperInferenceBackend = 'webgpu' | 'wasm';

interface WhisperInferenceTimeoutPolicy {
    defaultChunkSeconds: number;
    durationEwmaAlpha: number;
    observedDurationHeadroom: number;
    modelMultipliers: {
        small: number;
        medium: number;
        large: number;
    };
    webgpu: {
        minimumMs: number;
        coldStartMinimumMs: number;
        maximumMs: number;
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
    durationEwmaAlpha: 0.35,
    observedDurationHeadroom: 1.5,
    modelMultipliers: {
        small: 1.25,
        medium: 1.75,
        large: 2.25,
    },
    webgpu: {
        // This is a hard ceiling, not the liveness watchdog. The controller
        // remains responsible for inactivity detection through worker
        // heartbeats. Healthy Firefox/Apple Silicon ORT calls can exceed 45s
        // under contention, so short warm windows need a generous floor.
        minimumMs: 120_000,
        // The first WebGPU inference includes ORT shader compilation. Firefox
        // on Apple Silicon can spend longer compiling a short bootstrap window
        // than decoding it; terminating at a short warm floor tears down an
        // in-flight readback and surfaces as BufferManager "Buffer unmapped".
        coldStartMinimumMs: 180_000,
        maximumMs: 300_000,
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
    coldStart = false,
    model = '',
    recentInferenceDurationMs = 0,
): number {
    const chunkSeconds = Number(chunkLengthSeconds) || policy.defaultChunkSeconds;
    const backendPolicy = backend === 'webgpu' ? policy.webgpu : policy.wasm;
    const modelName = String(model || '').toLowerCase();
    const modelMultiplier = /large/.test(modelName)
        ? policy.modelMultipliers.large
        : /medium/.test(modelName)
            ? policy.modelMultipliers.medium
            : /small/.test(modelName)
                ? policy.modelMultipliers.small
                : 1;
    const minimumMs = backend === 'webgpu' && coldStart
        ? policy.webgpu.coldStartMinimumMs
        : backendPolicy.minimumMs;
    const baseBudgetMs = Math.max(
        minimumMs,
        chunkSeconds * backendPolicy.perChunkSecondMs,
    );
    const modelBudgetMs = baseBudgetMs * modelMultiplier;
    const observedMs = Number(recentInferenceDurationMs);
    const observedBudgetMs = Number.isFinite(observedMs) && observedMs > 0
        ? observedMs * policy.observedDurationHeadroom
        : 0;

    return Math.min(
        backendPolicy.maximumMs,
        Math.max(
            baseBudgetMs,
            modelBudgetMs,
            observedBudgetMs,
        ),
    );
}

function calculateWhisperInferenceDurationEwma(
    policy: WhisperInferenceTimeoutPolicy,
    previousDurationMs: number | null,
    observedDurationMs: number,
): number | null {
    const observed = Number(observedDurationMs);
    if (!Number.isFinite(observed) || observed <= 0) return previousDurationMs;
    const previous = Number(previousDurationMs);
    if (!Number.isFinite(previous) || previous <= 0) return observed;
    return previous * (1 - policy.durationEwmaAlpha)
        + observed * policy.durationEwmaAlpha;
}

export function getWhisperInferenceTimeoutMs(
    backend: WhisperInferenceBackend,
    chunkLengthSeconds: number,
    coldStart = false,
    model = '',
    recentInferenceDurationMs = 0,
): number {
    return calculateWhisperInferenceTimeoutMs(
        WHISPER_INFERENCE_TIMEOUT_POLICY,
        backend,
        chunkLengthSeconds,
        coldStart,
        model,
        recentInferenceDurationMs,
    );
}

export function getWhisperStallWatchdogMs(
    backend: WhisperInferenceBackend,
    chunkLengthSeconds: number,
    coldStart = false,
    model = '',
    recentInferenceDurationMs = 0,
): number {
    return getWhisperInferenceTimeoutMs(
        backend,
        chunkLengthSeconds,
        coldStart,
        model,
        recentInferenceDurationMs,
    )
        + WHISPER_STALL_WATCHDOG_MARGIN_MS;
}

export function updateWhisperInferenceDurationEwma(
    previousDurationMs: number | null,
    observedDurationMs: number,
): number | null {
    return calculateWhisperInferenceDurationEwma(
        WHISPER_INFERENCE_TIMEOUT_POLICY,
        previousDurationMs,
        observedDurationMs,
    );
}

export function createWhisperInferencePolicyWorkerSource(): string {
    return `
const WHISPER_INFERENCE_TIMEOUT_POLICY = ${JSON.stringify(WHISPER_INFERENCE_TIMEOUT_POLICY)};
const calculateWhisperInferenceTimeoutMs = ${calculateWhisperInferenceTimeoutMs.toString()};
const calculateWhisperInferenceDurationEwma = ${calculateWhisperInferenceDurationEwma.toString()};
function getInferenceTimeoutMs(
    currentBackend,
    chunkLengthS,
    coldStart = false,
    model = '',
    recentInferenceDurationMs = 0,
) {
    return calculateWhisperInferenceTimeoutMs(
        WHISPER_INFERENCE_TIMEOUT_POLICY,
        currentBackend === 'webgpu' ? 'webgpu' : 'wasm',
        chunkLengthS,
        coldStart,
        model,
        recentInferenceDurationMs,
    );
}
function updateInferenceDurationEwma(previousDurationMs, observedDurationMs) {
    return calculateWhisperInferenceDurationEwma(
        WHISPER_INFERENCE_TIMEOUT_POLICY,
        previousDurationMs,
        observedDurationMs,
    );
}
`;
}
