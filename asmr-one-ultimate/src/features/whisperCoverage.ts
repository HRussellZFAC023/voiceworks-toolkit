export interface WhisperCoverageRange {
    start: number;
    end: number;
}

export interface WhisperCoverageSnapshot {
    origin: number;
    processed: readonly WhisperCoverageRange[];
    unavailable: readonly WhisperCoverageRange[];
}

export interface WhisperCoverageSummary {
    processedSeconds: number;
    processedThroughSeconds: number;
    /** First missing point in durable, whole-track coverage. */
    resumeFromSeconds: number;
    /** Contiguous processed point for the current capture session. */
    sessionResumeFromSeconds: number;
    accountedThroughSeconds: number;
    skippedSeconds: number;
    missingSeconds: number;
    backlogSeconds: number;
    complete: boolean;
}

function finiteNonNegative(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, value)
        : null;
}

export function normalizeWhisperCoverage(
    ranges: readonly WhisperCoverageRange[] | null | undefined,
): WhisperCoverageRange[] {
    const normalized = (ranges || [])
        .map((range) => {
            const start = finiteNonNegative(range?.start);
            const end = finiteNonNegative(range?.end);
            return start !== null && end !== null && end > start
                ? { start, end }
                : null;
        })
        .filter((range): range is WhisperCoverageRange => range !== null)
        .sort((a, b) => a.start - b.start || a.end - b.end);

    const merged: WhisperCoverageRange[] = [];
    for (const range of normalized) {
        const previous = merged.at(-1);
        if (previous && range.start <= previous.end + 0.01) {
            previous.end = Math.max(previous.end, range.end);
        } else {
            merged.push({ ...range });
        }
    }
    return merged;
}

export function addWhisperCoverage(
    ranges: readonly WhisperCoverageRange[],
    start: number,
    end: number,
): WhisperCoverageRange[] {
    return normalizeWhisperCoverage([...ranges, { start, end }]);
}

export function subtractWhisperCoverage(
    ranges: readonly WhisperCoverageRange[],
    start: number,
    end: number,
): WhisperCoverageRange[] {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        return normalizeWhisperCoverage(ranges);
    }
    return normalizeWhisperCoverage(ranges.flatMap((range) => {
        if (range.end <= start || range.start >= end) return [range];
        const remaining: WhisperCoverageRange[] = [];
        if (range.start < start) remaining.push({ start: range.start, end: start });
        if (range.end > end) remaining.push({ start: end, end: range.end });
        return remaining;
    }));
}

export function getWhisperCoveredSeconds(
    ranges: readonly WhisperCoverageRange[],
): number {
    return normalizeWhisperCoverage(ranges)
        .reduce((total, range) => total + range.end - range.start, 0);
}

export function getWhisperCoverageEnd(
    ranges: readonly WhisperCoverageRange[],
    fallback = 0,
): number {
    return normalizeWhisperCoverage(ranges)
        .reduce((latest, range) => Math.max(latest, range.end), Math.max(0, fallback));
}

export function getWhisperContiguousEnd(
    ranges: readonly WhisperCoverageRange[],
    origin = 0,
    leadingToleranceSeconds = 0.01,
): number {
    let cursor = Math.max(0, origin);
    let firstRange = true;
    for (const range of normalizeWhisperCoverage(ranges)) {
        if (range.end <= cursor) continue;
        const tolerance = firstRange
            ? Math.max(0.01, leadingToleranceSeconds)
            : 0.01;
        if (range.start > cursor + tolerance) break;
        cursor = Math.max(cursor, range.end);
        firstRange = false;
    }
    return cursor;
}

export function summarizeWhisperCoverage(
    snapshot: WhisperCoverageSnapshot,
    playbackSeconds: number,
    totalSeconds: number,
): WhisperCoverageSummary {
    const origin = Math.max(0, snapshot.origin);
    const processed = normalizeWhisperCoverage(snapshot.processed);
    const unavailable = processed.reduce(
        (remaining, range) => subtractWhisperCoverage(remaining, range.start, range.end),
        normalizeWhisperCoverage(snapshot.unavailable),
    );
    const accounted = normalizeWhisperCoverage([...processed, ...unavailable]);
    const playback = Math.max(0, playbackSeconds);
    const total = Math.max(0, totalSeconds);
    // Browsers can begin the first captured frame a few milliseconds after
    // media time zero (Firefox on Apple Silicon commonly reports ~80ms).
    // Match the existing trailing 0.5s completion tolerance at this one edge
    // without concealing gaps between analyzed ranges.
    const resumeFromSeconds = getWhisperContiguousEnd(processed, 0, 0.5);
    const sessionResumeFromSeconds = getWhisperContiguousEnd(processed, origin);
    const accountedThroughSeconds = getWhisperContiguousEnd(accounted, origin);
    const processedSeconds = getWhisperCoveredSeconds(processed);

    return {
        processedSeconds,
        processedThroughSeconds: getWhisperCoverageEnd(processed, origin),
        resumeFromSeconds,
        sessionResumeFromSeconds,
        accountedThroughSeconds,
        skippedSeconds: getWhisperCoveredSeconds(unavailable),
        missingSeconds: Math.max(0, total - processedSeconds),
        backlogSeconds: Math.max(0, playback - accountedThroughSeconds),
        complete: total > 0
            && unavailable.length === 0
            && resumeFromSeconds >= total - 0.5,
    };
}
