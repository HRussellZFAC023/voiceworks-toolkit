export interface WhisperSchedulingWindow {
    chunkLengthSeconds: number;
    overlapSeconds: number;
    catchUp: boolean;
}

interface WhisperSchedulingInput {
    adaptive: boolean;
    foregroundChunkSeconds: number;
    foregroundOverlapSeconds: number;
    catchUpChunkSeconds: number;
    catchUpOverlapSeconds: number;
    backlogSeconds: number;
    throughputRatio: number | null;
}

function finitePositive(value: number, fallback: number): number {
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Keep latency low near the playhead and trade latency for throughput only
 * when local coverage is genuinely falling behind. `throughputRatio` is audio
 * timeline seconds completed per wall-clock second, measured on the active
 * model/backend rather than inferred from the device name.
 */
export function selectWhisperSchedulingWindow(
    input: WhisperSchedulingInput,
): WhisperSchedulingWindow {
    const foregroundChunk = finitePositive(input.foregroundChunkSeconds, 8);
    const foregroundOverlap = Math.max(
        0,
        Math.min(foregroundChunk - 0.01, input.foregroundOverlapSeconds),
    );
    const catchUpChunk = Math.max(
        foregroundChunk,
        finitePositive(input.catchUpChunkSeconds, foregroundChunk),
    );
    const catchUpOverlap = Math.max(
        0,
        Math.min(catchUpChunk - 0.01, input.catchUpOverlapSeconds),
    );
    const foreground: WhisperSchedulingWindow = {
        chunkLengthSeconds: foregroundChunk,
        overlapSeconds: foregroundOverlap,
        catchUp: false,
    };
    if (!input.adaptive || catchUpChunk <= foregroundChunk + 0.01) {
        return foreground;
    }

    const backlog = Math.max(0, Number(input.backlogSeconds) || 0);
    const foregroundAdvance = Math.max(0.01, foregroundChunk - foregroundOverlap);
    const enterCatchUpAt = Math.max(16, foregroundChunk * 2);
    if (backlog <= enterCatchUpAt) return foreground;

    const throughput = Number.isFinite(input.throughputRatio)
        ? Math.max(0, Number(input.throughputRatio))
        : null;
    const severelyBehind = backlog >= Math.max(
        enterCatchUpAt + foregroundAdvance,
        catchUpChunk * 2,
    );
    // A moderate lag widens only after this exact run demonstrates that its
    // current short windows are not faster than playback. A severe lag may
    // widen before the first stable sample so recovery is still bounded.
    if (!severelyBehind && (throughput === null || throughput >= 1.05)) {
        return foreground;
    }

    return {
        chunkLengthSeconds: catchUpChunk,
        overlapSeconds: catchUpOverlap,
        catchUp: true,
    };
}
