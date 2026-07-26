import type { WhisperSegment } from '../types';
import { buildLrcFromSegments, buildVttFromSegments } from './transcriptFileUtils';
import { serializeRollingTranscriptRepetitionRuns } from './whisperProcessing';
import type { SerializedRollingRepetitionRun } from './whisperProcessing';
import {
    getWhisperCoverageEnd,
    normalizeWhisperCoverage,
    summarizeWhisperCoverage,
} from './whisperCoverage';
import type { WhisperCoverageRange } from './whisperCoverage';

export interface WhisperCachedTranscript {
    text: string;
    segments: WhisperSegment[];
    model: string;
    subtask: string;
    language: string;
    createdAt: number;
    lrc?: string;
    vtt?: string;
    complete?: boolean;
    timingQuality?: 'word' | 'segment';
    processedRanges?: WhisperCoverageRange[];
    unavailableRanges?: WhisperCoverageRange[];
    coverageOrigin?: number;
    rollingRepetitionRuns?: SerializedRollingRepetitionRun[];
    translations?: Record<string, { text: string; lrc: string; vtt?: string }>;
    /** Original identity string (pre-hash) for collision detection. */
    sourceIdentity?: string;
}

interface TranscriptSanitizers {
    cleanText(text: string): string;
    correctText(text: string): string;
    isNoiseOnly(text: string): boolean;
}

interface SanitizedSegment {
    segment: WhisperSegment | null;
    changed: boolean;
}

export interface SanitizedTranscript {
    transcript: WhisperCachedTranscript | null;
    changed: boolean;
}

export interface CacheCheckpointInput {
    existing: WhisperCachedTranscript | null;
    segments: WhisperSegment[];
    model: string;
    subtask: string;
    language: string;
    createdAt: number;
    requestedComplete: boolean;
    timingQuality: 'word' | 'segment' | null;
    processedRanges: WhisperCoverageRange[];
    unavailableRanges: WhisperCoverageRange[];
    coverageOrigin: number;
    playbackSeconds: number;
    expectedDuration: number;
    sourceIdentity?: string;
}

export type CacheCheckpointDecision =
    | { action: 'persist'; payload: WhisperCachedTranscript }
    | {
        action: 'preserve-existing';
        existingComplete: boolean;
        existingCoverageEnd: number;
        currentCoverageEnd: number;
    };

function sanitizeWords(
    segment: WhisperSegment,
    timingQuality: 'word' | 'segment',
    cleanText: (text: string) => string,
): { words: WhisperSegment['words']; changed: boolean } {
    if (timingQuality !== 'word') {
        return { words: undefined, changed: !!segment.words?.length };
    }
    if (!segment.words) return { words: undefined, changed: false };

    const words = segment.words
        .map(word => ({ ...word, text: cleanText(word.text) }))
        .filter(word => !!word.text);
    const changed = words.length !== segment.words.length
        || words.some((word, index) => word.text !== segment.words?.[index]?.text);
    return { words, changed };
}

function sanitizeSegment(
    segment: WhisperSegment,
    timingQuality: 'word' | 'segment',
    sanitizers: TranscriptSanitizers,
): SanitizedSegment {
    const corrected = sanitizers.correctText(sanitizers.cleanText(segment.text));
    if (!corrected || sanitizers.isNoiseOnly(corrected)) {
        return { segment: null, changed: true };
    }

    const { words, changed: wordsChanged } = sanitizeWords(
        segment,
        timingQuality,
        sanitizers.cleanText,
    );
    return {
        segment: { ...segment, text: corrected, words },
        changed: wordsChanged || corrected !== segment.text,
    };
}

function sameCoverage(
    left: WhisperCoverageRange[] | undefined,
    right: WhisperCoverageRange[],
): boolean {
    return Array.isArray(left)
        && left.length === right.length
        && right.every((range, index) => (
            range.start === left[index]?.start && range.end === left[index]?.end
        ));
}

export function sanitizeWhisperCachedTranscript(
    cached: WhisperCachedTranscript | null | undefined,
    sanitizers: TranscriptSanitizers,
): SanitizedTranscript {
    if (!cached) return { transcript: null, changed: false };
    const sourceSegments = Array.isArray(cached.segments) ? cached.segments : [];
    const timingQuality = cached.timingQuality === 'word' ? 'word' : 'segment';
    const sanitizedSegments = sourceSegments.map(segment => (
        sanitizeSegment(segment, timingQuality, sanitizers)
    ));
    const segments = sanitizedSegments.flatMap(result => (
        result.segment ? [result.segment] : []
    ));
    const processedRanges = normalizeWhisperCoverage(cached.processedRanges);
    if (segments.length === 0 && processedRanges.length === 0) {
        return { transcript: null, changed: sourceSegments.length > 0 };
    }

    const text = segments.map(segment => segment.text).join(' ');
    const unavailableRanges = normalizeWhisperCoverage(cached.unavailableRanges);
    const coverageOrigin = Number.isFinite(cached.coverageOrigin)
        ? Math.max(0, Number(cached.coverageOrigin))
        : processedRanges[0]?.start ?? 0;
    const complete = processedRanges.length > 0 ? !!cached.complete : false;
    const changed = cached.timingQuality !== timingQuality
        || text !== cached.text
        || complete !== !!cached.complete
        || cached.coverageOrigin !== coverageOrigin
        || !sameCoverage(cached.processedRanges, processedRanges)
        || !sameCoverage(cached.unavailableRanges, unavailableRanges)
        || sanitizedSegments.some(result => result.changed);

    return {
        changed,
        transcript: {
            ...cached,
            text,
            segments,
            complete,
            timingQuality,
            processedRanges,
            unavailableRanges,
            coverageOrigin,
            lrc: changed ? buildLrcFromSegments(segments) : cached.lrc,
            vtt: changed ? buildVttFromSegments(segments) : cached.vtt,
            translations: changed ? undefined : cached.translations,
        },
    };
}

function segmentCoverageEnd(
    segments: WhisperSegment[] | undefined,
    processedRanges: WhisperCoverageRange[] | undefined,
): number {
    const segmentEnd = segments?.reduce(
        (maximum, segment) => Math.max(maximum, segment.end || 0),
        0,
    ) || 0;
    return getWhisperCoverageEnd(processedRanges || [], segmentEnd);
}

export function buildWhisperCacheCheckpoint(
    input: CacheCheckpointInput,
): CacheCheckpointDecision {
    const text = input.segments.map(segment => segment.text).join(' ');
    const rollingRepetitionRuns = serializeRollingTranscriptRepetitionRuns(input.segments);
    const currentCoverageEnd = segmentCoverageEnd(input.segments, input.processedRanges);
    const existingCoverageEnd = segmentCoverageEnd(
        input.existing?.segments,
        input.existing?.processedRanges,
    );
    const coverage = summarizeWhisperCoverage({
        origin: input.coverageOrigin,
        processed: input.processedRanges,
        unavailable: input.unavailableRanges,
    }, input.playbackSeconds, input.expectedDuration);
    const complete = input.requestedComplete && coverage.complete;

    if (input.existing && (
        (input.existing.complete && !complete)
        || existingCoverageEnd > currentCoverageEnd + 1
    )) {
        return {
            action: 'preserve-existing',
            existingComplete: !!input.existing.complete,
            existingCoverageEnd,
            currentCoverageEnd,
        };
    }

    return {
        action: 'persist',
        payload: {
            text,
            segments: input.segments,
            model: input.model,
            subtask: input.subtask,
            language: input.language,
            createdAt: input.createdAt,
            lrc: buildLrcFromSegments(input.segments),
            vtt: buildVttFromSegments(input.segments),
            complete,
            timingQuality: input.timingQuality || 'segment',
            processedRanges: normalizeWhisperCoverage(input.processedRanges),
            unavailableRanges: normalizeWhisperCoverage(input.unavailableRanges),
            coverageOrigin: input.coverageOrigin,
            rollingRepetitionRuns: rollingRepetitionRuns.length > 0
                ? rollingRepetitionRuns
                : undefined,
            translations: input.existing?.text === text
                ? input.existing.translations
                : undefined,
            sourceIdentity: input.sourceIdentity,
        },
    };
}
