import type { WhisperState } from '../types';
import { summarizeWhisperCoverage } from './whisperCoverage';
import type { WhisperCoverageRange } from './whisperCoverage';

export type WhisperProgressPhase = 'loading' | 'model' | 'transcribing';

export type WhisperListenerStatusKey =
    | 'whisperPreparingSubtitles'
    | 'whisperListeningForSpeech'
    | 'whisperCatchingUp'
    | 'whisperRestartingTranscription';

/**
 * Map canonical runtime state to calm listener-facing copy.
 *
 * The detailed progress message intentionally remains available in AppStore
 * and EventBus for diagnostics. It combines several scopes (current playhead
 * lag, whole-session coverage, and active work), so it does not belong in the
 * player subtitle lane.
 */
export function resolveWhisperListenerStatusKey(
    stage: WhisperState['stage'],
): WhisperListenerStatusKey | null {
    switch (stage) {
        case 'loading':
            return 'whisperPreparingSubtitles';
        case 'transcribing':
        case 'caught-up':
            return 'whisperListeningForSpeech';
        case 'behind':
            return 'whisperCatchingUp';
        case 'recovering':
            return 'whisperRestartingTranscription';
        default:
            return null;
    }
}

interface RuntimeProgressInput {
    model: string;
    backend: 'webgpu' | 'wasm';
    chunkLengthSeconds: number;
    timingLabel: string;
    timingQuality: WhisperState['timingQuality'];
    pendingChunks: number;
    playbackSeconds: number;
    knownDuration: number;
    pcmDuration: number;
    /** Current playhead window; deliberately separate from durable resume coverage. */
    progressOrigin: number;
    processedRanges: WhisperCoverageRange[];
    unavailableRanges: WhisperCoverageRange[];
    throughputLabel: string;
}

export interface RuntimeProgressSnapshot {
    messageKey: 'whisperCaughtUpProgress' | 'whisperRuntimeProgress';
    messageValues: Record<string, string | number>;
    percent: number;
    state: Partial<WhisperState>;
}

interface DispatchProgressInput {
    message: string;
    loadingFallback: string;
    transcribingFallback: string;
    percent: number;
    phase: WhisperProgressPhase;
    runtime: Partial<WhisperState>;
    transcribing: boolean;
    currentStage: WhisperState['stage'];
}

export interface ProgressDispatchSnapshot {
    displayMessage: string;
    percentSuffix: string;
    stage: WhisperState['stage'];
    state: Partial<WhisperState>;
}

interface CompletionProgressInput {
    completeMessage: string;
    currentTrackSrc: string | null;
    timingQuality: WhisperState['timingQuality'];
    playbackSeconds: number;
    totalSeconds: number;
    coverageOrigin: number;
    processedRanges: WhisperCoverageRange[];
    unavailableRanges: WhisperCoverageRange[];
}

interface PartialProgressInput extends Omit<CompletionProgressInput, 'completeMessage'> {
    partialMessage: string;
}

function runtimeStage(
    backlogSeconds: number,
    pendingChunks: number,
    chunkLengthSeconds: number,
): WhisperState['stage'] {
    if (backlogSeconds > chunkLengthSeconds) return 'behind';
    if (backlogSeconds <= 2 && pendingChunks === 0) return 'caught-up';
    return 'transcribing';
}

export function buildWhisperRuntimeProgress(
    input: RuntimeProgressInput,
): RuntimeProgressSnapshot {
    const totalSeconds = Math.max(
        input.knownDuration,
        input.pcmDuration,
        input.playbackSeconds,
    );
    const coverage = summarizeWhisperCoverage({
        origin: input.progressOrigin,
        processed: input.processedRanges,
        unavailable: input.unavailableRanges,
    }, input.playbackSeconds, totalSeconds);
    const caughtUp = coverage.backlogSeconds <= 2 && input.pendingChunks === 0;
    const percent = totalSeconds > 0
        ? Math.min(99, (coverage.processedSeconds / totalSeconds) * 100)
        : 0;
    const commonValues = {
        plan: `${input.model} · ${input.backend.toUpperCase()}`,
        processed: Math.round(coverage.processedSeconds),
        through: Math.round(coverage.processedThroughSeconds),
        playback: Math.round(input.playbackSeconds),
        total: Math.round(totalSeconds),
        throughput: input.throughputLabel,
        timing: input.timingLabel,
    };

    return {
        messageKey: caughtUp ? 'whisperCaughtUpProgress' : 'whisperRuntimeProgress',
        messageValues: caughtUp
            ? commonValues
            : {
                ...commonValues,
                backlog: Math.round(coverage.backlogSeconds),
                pending: input.pendingChunks,
            },
        percent,
        state: {
            stage: runtimeStage(
                coverage.backlogSeconds,
                input.pendingChunks,
                input.chunkLengthSeconds,
            ),
            model: input.model,
            backend: input.backend,
            processedSeconds: coverage.processedSeconds,
            processedThroughSeconds: coverage.processedThroughSeconds,
            skippedSeconds: coverage.skippedSeconds,
            totalSeconds,
            playbackSeconds: input.playbackSeconds,
            backlogSeconds: coverage.backlogSeconds,
            pendingChunks: input.pendingChunks,
            timingQuality: input.timingQuality,
        },
    };
}

function canonicalStage(input: DispatchProgressInput): WhisperState['stage'] {
    if (input.runtime.stage) return input.runtime.stage;
    const preserveRecovery = input.transcribing
        && input.phase !== 'transcribing'
        && input.currentStage === 'recovering';
    if (preserveRecovery) return 'recovering';
    return input.phase === 'transcribing' ? 'transcribing' : 'loading';
}

export function buildWhisperProgressDispatch(
    input: DispatchProgressInput,
): ProgressDispatchSnapshot {
    const displayMessage = input.message || (
        input.phase === 'transcribing'
            ? input.transcribingFallback
            : input.loadingFallback
    );
    const showPercent = !/\(\d+%\)/.test(displayMessage)
        && input.percent > 0
        && input.percent < 100;
    const stage = canonicalStage(input);

    return {
        displayMessage,
        percentSuffix: showPercent ? ` (${Math.round(input.percent)}%)` : '',
        stage,
        state: {
            isTranscribing: input.transcribing,
            progress: input.percent,
            progressMessage: displayMessage,
            isLoadingModel: input.phase !== 'transcribing',
            stage,
            ...input.runtime,
        },
    };
}

export function buildWhisperCompletionState(
    input: CompletionProgressInput,
): Partial<WhisperState> {
    const coverage = summarizeWhisperCoverage({
        origin: input.coverageOrigin,
        processed: input.processedRanges,
        unavailable: input.unavailableRanges,
    }, input.playbackSeconds, input.totalSeconds);
    return {
        isTranscribing: false,
        isLoadingModel: false,
        progress: 100,
        progressMessage: input.completeMessage,
        currentTrackSrc: input.currentTrackSrc,
        stage: 'complete',
        processedSeconds: coverage.processedSeconds,
        processedThroughSeconds: coverage.processedThroughSeconds,
        skippedSeconds: coverage.skippedSeconds,
        totalSeconds: input.totalSeconds,
        playbackSeconds: input.playbackSeconds,
        backlogSeconds: 0,
        pendingChunks: 0,
        timingQuality: input.timingQuality,
    };
}

export function buildWhisperPartialState(
    input: PartialProgressInput,
): Partial<WhisperState> {
    const coverage = summarizeWhisperCoverage({
        origin: input.coverageOrigin,
        processed: input.processedRanges,
        unavailable: input.unavailableRanges,
    }, input.playbackSeconds, input.totalSeconds);
    const progress = input.totalSeconds > 0
        ? Math.min(99, (coverage.processedSeconds / input.totalSeconds) * 100)
        : 0;
    return {
        isTranscribing: false,
        isLoadingModel: false,
        progress,
        progressMessage: input.partialMessage,
        currentTrackSrc: input.currentTrackSrc,
        stage: 'partial',
        processedSeconds: coverage.processedSeconds,
        processedThroughSeconds: coverage.processedThroughSeconds,
        skippedSeconds: coverage.skippedSeconds,
        totalSeconds: input.totalSeconds,
        playbackSeconds: input.playbackSeconds,
        backlogSeconds: coverage.missingSeconds,
        pendingChunks: 0,
        timingQuality: input.timingQuality,
    };
}
