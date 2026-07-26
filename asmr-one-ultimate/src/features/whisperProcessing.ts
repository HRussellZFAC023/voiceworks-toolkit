/**
 * whisperProcessing.ts — Pure post-processing functions for Whisper output.
 *
 * Extracted from the inline worker template so they can be typed, tested,
 * and shared between the worker (via the template string) and the host.
 *
 * All functions here are side-effect-free.  The worker sends **raw chunks**
 * (words with time offset already applied) and the host calls
 * `processRawChunks()` to do hallucination filtering, repetition truncation,
 * word grouping, and bracket restoration.
 */

// ── Types ──────────────────────────────────────────────────────────────

/** Raw chunk as emitted by the Whisper pipeline / worker. */
export interface RawChunk {
    text: string;
    timestamp: [number | null, number | null];
}

/** Word entry inside a processed segment. */
export interface ProcessedWord {
    text: string;
    start: number | null;
    end: number | null;
}

/** A fully processed segment ready for the host's `parseSegments()`. */
export interface ProcessedSegment {
    text: string;
    timestamp: [number | null, number | null];
    words?: ProcessedWord[];
}

// ── Constants ──────────────────────────────────────────────────────────

/**
 * Silence gap (seconds) for splitting words into separate subtitle segments.
 * 0.5s splits mid-sentence on ASMR breath pauses; 1.5s merges sentences.
 */
const SEGMENT_GAP_S = 1.0;

/** Maximum characters per segment before forcing a split. */
const MAX_SEGMENT_CHARS = 80;

/** Repetition-loop detection thresholds. */
const MIN_PATHOLOGICAL_REPEATS = 12;
const VISIBLE_REPEATS = 6;
const MIN_PATTERN_LEN = 1;
const MAX_PATTERN_LEN = 6;
const MAX_TEXT_PATTERN_CODE_POINTS = 4;
const MAX_ROLLING_PATTERN_CODE_POINTS = 2;
// One hallucination may appear once per maximum-length inference window.
// A larger break starts a new run so unrelated phrases later in the track do
// not contribute to the threshold.
const MAX_ROLLING_GAP_S = 35;

// ── Regexes ────────────────────────────────────────────────────────────

/** Bracketed non-speech annotations (e.g. [laughter], (music)). */
const HALLUCINATION_RE =
    /^\s*[\[(](laughter|laughing|crying|music|applause|cheering|singing|sighing|coughing|clapping|crowd noise|background noise|inaudible|silence|blank audio|no speech|ため息|笑い|泣き|拍手|音楽|音乐|音樂|笑声|笑聲|哭声|哭聲|掌声|掌聲|叹气|嘆氣|静音|靜音)[\])]\s*$/i;

/** Common YouTube/subtitle hallucinations from Whisper's training data. */
const SUBTITLE_HALLUCINATION_RE =
    /^\s*(thank you(\s+for\s+watching)?|thanks for watching|please subscribe|like and subscribe|see you next time|ご視聴ありがとう(?:ございます|ございました)|チャンネル登録|谢谢观看|謝謝觀看|请订阅|請訂閱|下次见|下次見)\s*[.!。！]*\s*$/i;

/** Bracket/paren openers for `restoreMissingBrackets`. */
const OPEN_BRACKET_RE = /^([\[（「『【〈《〔(]+)/;
/** Bracket/paren closers for `restoreMissingBrackets`. */
const CLOSE_BRACKET_RE = /([\]）」』】〉》〕)]+)$/;

// ── Helpers ────────────────────────────────────────────────────────────

function isCJKText(text: string): boolean {
    return /[\u3040-\u30ff\u4e00-\u9fff]/.test(text);
}

function codePointsMatchAt(
    input: string[],
    pattern: string[],
    offset: number,
): boolean {
    if (offset + pattern.length > input.length) return false;
    return pattern.every((codePoint, index) => input[offset + index] === codePoint);
}

/**
 * Bound pathological decoder loops inside one text chunk.
 *
 * Short repeated vocalisations are valid ASMR speech, so a run is only capped
 * after 12 exact repetitions of a tiny (1–4 code point) pattern. Six
 * repetitions remain as a representative sample and an ellipsis makes the
 * omission explicit. Text after the run is always retained.
 */
export function capPathologicalTextRepetition(text: string): string {
    const input = Array.from(text);
    if (input.length < MIN_PATHOLOGICAL_REPEATS) return text;

    const output: string[] = [];
    let offset = 0;

    while (offset < input.length) {
        let repeatedPattern: string[] | undefined;
        let repeatedCount = 0;

        for (
            let patternLength = MIN_PATTERN_LEN;
            patternLength <= MAX_TEXT_PATTERN_CODE_POINTS;
            patternLength++
        ) {
            if (offset + patternLength * MIN_PATHOLOGICAL_REPEATS > input.length) {
                continue;
            }

            const pattern = input.slice(offset, offset + patternLength);
            if (!pattern.join('').trim()) continue;

            let count = 1;
            while (codePointsMatchAt(input, pattern, offset + count * patternLength)) {
                count++;
            }
            if (count >= MIN_PATHOLOGICAL_REPEATS) {
                repeatedPattern = pattern;
                repeatedCount = count;
                break;
            }
        }

        if (!repeatedPattern) {
            output.push(input[offset]);
            offset++;
            continue;
        }

        for (let repeat = 0; repeat < VISIBLE_REPEATS; repeat++) {
            output.push(...repeatedPattern);
        }
        output.push('…');
        offset += repeatedPattern.length * repeatedCount;
    }

    return output.join('');
}

/**
 * Remove Whisper decoder control tokens from user-visible text.
 *
 * Whisper timestamp tokens are deliberately not marked as "special" by the
 * tokenizer, so a generic TextStreamer can surface them even when
 * `skip_special_tokens` is enabled. Streaming callbacks may also begin in the
 * middle of a token (for example `00|>`), hence the anchored fragment cleanup.
 */
export function sanitizeWhisperText(text: string | null | undefined): string {
    let cleaned = String(text || '')
        // Complete Whisper control tokens: timestamps, language/task markers,
        // start/end markers, and no-timestamps markers.
        .replace(/<\|[^<>|]{0,64}\|>/g, '');

    // A streaming callback can start after the `<|` part was consumed. Remove
    // one or more timestamp suffixes only at the beginning so ordinary numeric
    // text elsewhere is preserved.
    let previous = '';
    while (cleaned !== previous) {
        previous = cleaned;
        cleaned = cleaned.replace(
            /^\s*(?:(?:<\|)?\d{1,5}(?:\.\d{0,3})?\|>|\|>)\s*/,
            '',
        );
    }

    // Do not render an incomplete control token while the next streamer
    // callback is still pending.
    cleaned = cleaned.replace(/\s*<\|[^<>|]{0,64}$/, '');

    const normalized = cleaned.replace(/\s+/g, ' ').trim();
    return capPathologicalTextRepetition(normalized);
}

// ── Hallucination filtering ────────────────────────────────────────────

/** True when the complete text is a known non-speech/subtitle hallucination. */
export function isWhisperHallucinationText(text: string | null | undefined): boolean {
    const normalized = sanitizeWhisperText(text);
    if (!normalized) return false;
    return HALLUCINATION_RE.test(normalized) || SUBTITLE_HALLUCINATION_RE.test(normalized);
}

/**
 * Remove chunks that are known non-speech hallucinations.
 * Returns a filtered copy (does not mutate the input).
 */
export function cleanHallucinatedChunks<T extends { text?: string }>(chunks: T[]): T[] {
    if (!chunks) return chunks;
    return chunks
        .map(c => ({ ...c, text: sanitizeWhisperText(c.text) }) as T)
        .filter(c => {
            const text = c.text || '';
            if (!text) return false;
            return !isWhisperHallucinationText(text);
        });
}

// ── Repetition truncation ──────────────────────────────────────────────

/**
 * Detect and truncate repetitive hallucination loops in word arrays.
 *
 * Whisper can emit long runs of the same tiny word pattern. Short repeated
 * vocalisations remain untouched. For a pathological run, retain samples from
 * both its beginning and end so timestamped input keeps the run's original
 * temporal bounds. Distinct text after a run is never dropped.
 */
export function truncateRepetitionLoop<T extends { text?: string }>(words: T[]): T[] {
    if (words.length < MIN_PATHOLOGICAL_REPEATS * MIN_PATTERN_LEN) return words;

    const texts = words.map(word => sanitizeWhisperText(word.text));
    const output: T[] = [];
    let offset = 0;

    while (offset < words.length) {
        let patternLength = 0;
        let repeatedCount = 0;

        for (let candidateLength = MIN_PATTERN_LEN; candidateLength <= MAX_PATTERN_LEN; candidateLength++) {
            if (offset + candidateLength * MIN_PATHOLOGICAL_REPEATS > words.length) {
                continue;
            }

            const pattern = texts.slice(offset, offset + candidateLength);
            if (pattern.every(text => !text)) continue;

            let count = 1;
            while (
                offset + (count + 1) * candidateLength <= texts.length
                && texts
                    .slice(offset + count * candidateLength, offset + (count + 1) * candidateLength)
                    .every((text, index) => text === pattern[index])
            ) {
                count++;
            }
            if (count >= MIN_PATHOLOGICAL_REPEATS) {
                patternLength = candidateLength;
                repeatedCount = count;
                break;
            }
        }

        if (patternLength === 0) {
            output.push(words[offset]);
            offset++;
            continue;
        }

        const leadingRepeats = Math.ceil(VISIBLE_REPEATS / 2);
        const trailingRepeats = Math.floor(VISIBLE_REPEATS / 2);
        const repeatedWordCount = patternLength * repeatedCount;
        const trailingStart = offset + repeatedWordCount - trailingRepeats * patternLength;

        output.push(
            ...words.slice(offset, offset + leadingRepeats * patternLength),
            ...words.slice(trailingStart, offset + repeatedWordCount),
        );
        offset += repeatedWordCount;
    }

    return output;
}

export interface TimedTranscriptSegment {
    text: string;
    start: number;
    end: number;
}

interface RollingRepetitionRun {
    fingerprint: string;
    runStart: number;
    observedCount: number;
}

export interface SerializedRollingRepetitionRun {
    fingerprint: string;
    runStart: number;
    observedCount: number;
    retainedStarts: number[];
}

const ROLLING_REPETITION_RUN = Symbol('whisperRollingRepetitionRun');

type RollingRepetitionTaggedSegment = TimedTranscriptSegment & {
    [ROLLING_REPETITION_RUN]?: RollingRepetitionRun;
};

function getRollingRepetitionRun(
    segment: TimedTranscriptSegment,
): RollingRepetitionRun | undefined {
    return (segment as RollingRepetitionTaggedSegment)[ROLLING_REPETITION_RUN];
}

function belongsToRollingRepetitionRun(
    candidate: RollingRepetitionRun | undefined,
    active: RollingRepetitionRun,
): boolean {
    return candidate?.fingerprint === active.fingerprint
        && candidate.runStart === active.runStart;
}

function tagRollingRepetitionSegment<T extends TimedTranscriptSegment>(
    segment: T,
    run: RollingRepetitionRun,
): T {
    const tagged = { ...segment } as T & RollingRepetitionTaggedSegment;
    // Keep the live-run identity out of user data, cache serialization, and
    // ordinary equality/iteration while retaining it on the timeline objects
    // that cumulative merges carry forward.
    Object.defineProperty(tagged, ROLLING_REPETITION_RUN, {
        value: run,
        configurable: true,
    });
    return tagged;
}

function normalizeRollingRepetitionText(text: string): string {
    return sanitizeWhisperText(text)
        .toLowerCase()
        .replace(/[\s.,!?…。！？、…'"「」『』【】（）()[\]{}]/g, '');
}

/**
 * Serialize only the minimal sidecar needed to continue an already-verified
 * rolling cap after a cache reload. Ordinary transcript segments stay clean.
 */
export function serializeRollingTranscriptRepetitionRuns(
    segments: readonly TimedTranscriptSegment[],
): SerializedRollingRepetitionRun[] {
    const runs = new Map<string, SerializedRollingRepetitionRun>();
    for (const segment of segments) {
        const run = getRollingRepetitionRun(segment);
        if (!run || normalizeRollingRepetitionText(segment.text) !== run.fingerprint) continue;
        const key = `${run.fingerprint}\u0000${run.runStart}`;
        const serialized = runs.get(key) || {
            ...run,
            retainedStarts: [],
        };
        serialized.retainedStarts.push(segment.start);
        runs.set(key, serialized);
    }
    return Array.from(runs.values()).filter(run => (
        run.observedCount >= MIN_PATHOLOGICAL_REPEATS
        && run.retainedStarts.length === VISIBLE_REPEATS
    ));
}

/**
 * Restore a cache sidecar defensively. A run is reattached only when all six
 * retained samples and their tiny fingerprint still match; stale or malformed
 * metadata cannot cause legitimate short ASMR repetitions to be capped.
 */
export function restoreRollingTranscriptRepetitionRuns<T extends TimedTranscriptSegment>(
    segments: readonly T[],
    serializedRuns: readonly SerializedRollingRepetitionRun[] | null | undefined,
): T[] {
    if (!Array.isArray(serializedRuns) || serializedRuns.length === 0) {
        return [...segments];
    }

    const restoredRuns = new Map<number, RollingRepetitionRun>();
    for (const candidate of serializedRuns) {
        const retainedStarts: number[] = Array.isArray(candidate?.retainedStarts)
            ? candidate.retainedStarts.map(Number)
            : [];
        const observedCount = Math.floor(Number(candidate?.observedCount));
        const runStart = Number(candidate?.runStart);
        const fingerprint = String(candidate?.fingerprint || '');
        if (
            !fingerprint
            || Array.from(fingerprint).length > MAX_ROLLING_PATTERN_CODE_POINTS
            || !Number.isFinite(runStart)
            || observedCount < MIN_PATHOLOGICAL_REPEATS
            || retainedStarts.length !== VISIBLE_REPEATS
            || retainedStarts.some((start: number) => !Number.isFinite(start))
            || new Set(retainedStarts).size !== VISIBLE_REPEATS
        ) {
            continue;
        }

        const matchingIndexes = segments.flatMap((segment, index) => (
            normalizeRollingRepetitionText(segment.text) === fingerprint
            && retainedStarts.some((start: number) => Math.abs(start - segment.start) < 0.001)
                ? [index]
                : []
        ));
        if (
            matchingIndexes.length !== VISIBLE_REPEATS
            || Math.abs(segments[matchingIndexes[0]].start - runStart) >= 0.001
        ) {
            continue;
        }

        const run: RollingRepetitionRun = {
            fingerprint,
            runStart,
            observedCount: Math.min(observedCount, 1_000_000),
        };
        for (const index of matchingIndexes) restoredRuns.set(index, run);
    }

    return segments.map((segment, index) => {
        const run = restoredRuns.get(index);
        return run ? tagRollingRepetitionSegment(segment, run) : segment;
    });
}

function isRollingRepetitionContinuation(
    previous: TimedTranscriptSegment,
    next: TimedTranscriptSegment,
): boolean {
    if (!Number.isFinite(previous.end) || !Number.isFinite(next.start)) return false;
    const gap = next.start - previous.end;
    return gap >= -0.5 && gap <= MAX_ROLLING_GAP_S;
}

/**
 * Bound a decoder loop that spans several completed inference windows.
 *
 * The worker-level cap cannot see disjoint results, so the host reapplies this
 * guard to its cumulative timeline after each merge. Only 12 exact, very short,
 * temporally-contiguous outputs qualify. Samples from both ends remain intact.
 *
 * Retained samples carry symbol-only live metadata. Without it, the intentional
 * time gap between the retained beginning/end would split the next cumulative
 * pass and let an unbounded loop grow by another trailing sample every window.
 */
export function capRollingTranscriptRepetition<T extends TimedTranscriptSegment>(
    segments: readonly T[],
): T[] {
    if (
        segments.length < MIN_PATHOLOGICAL_REPEATS
        && !segments.some(segment => getRollingRepetitionRun(segment))
    ) {
        return [...segments];
    }

    const output: T[] = [];
    let offset = 0;

    while (offset < segments.length) {
        const normalized = normalizeRollingRepetitionText(segments[offset].text);
        const patternLength = Array.from(normalized).length;
        if (!normalized || patternLength > MAX_ROLLING_PATTERN_CODE_POINTS) {
            output.push(segments[offset]);
            offset++;
            continue;
        }

        const existingRun = getRollingRepetitionRun(segments[offset]);
        let end = offset + 1;
        let newObservations = existingRun ? 0 : 1;
        while (
            end < segments.length
            && normalizeRollingRepetitionText(segments[end].text) === normalized
        ) {
            const candidateRun = getRollingRepetitionRun(segments[end]);
            if (existingRun && belongsToRollingRepetitionRun(candidateRun, existingRun)) {
                // The retained leading and trailing samples intentionally have
                // a large time gap. Shared live-run metadata bridges only that
                // previously verified omission.
                end++;
                continue;
            }
            if (candidateRun || !isRollingRepetitionContinuation(
                segments[end - 1],
                segments[end],
            )) {
                break;
            }
            newObservations++;
            end++;
        }

        const runLength = end - offset;
        if (!existingRun && runLength < MIN_PATHOLOGICAL_REPEATS) {
            output.push(...segments.slice(offset, end));
        } else {
            const leading = Math.ceil(VISIBLE_REPEATS / 2);
            const trailing = Math.floor(VISIBLE_REPEATS / 2);
            const run: RollingRepetitionRun = {
                fingerprint: normalized,
                runStart: existingRun?.runStart ?? segments[offset].start,
                observedCount: (existingRun?.observedCount ?? 0) + newObservations,
            };
            output.push(
                ...segments
                    .slice(offset, offset + leading)
                    .map(segment => tagRollingRepetitionSegment(segment, run)),
                ...segments
                    .slice(end - trailing, end)
                    .map(segment => tagRollingRepetitionSegment(segment, run)),
            );
        }
        offset = end;
    }

    return output;
}

// ── Segment building ───────────────────────────────────────────────────

function buildSegmentFromWords(words: RawChunk[]): ProcessedSegment {
    const texts = words.map(w => sanitizeWhisperText(w.text)).filter(Boolean);
    const joinChar = texts.some(t => isCJKText(t)) ? '' : ' ';
    const text = texts.join(joinChar).trim();
    const first = words[0];
    const last = words[words.length - 1];
    const startRaw = first.timestamp?.[0];
    const endRaw = last.timestamp?.[1] ?? last.timestamp?.[0];
    return {
        text,
        timestamp: [startRaw ?? null, endRaw ?? null],
        words: words.map(w => ({
            text: sanitizeWhisperText(w.text),
            start: w.timestamp?.[0] ?? null,
            end: (w.timestamp?.[1] ?? w.timestamp?.[0]) ?? null,
        })).filter(w => !!w.text),
    };
}

/**
 * Group word-level chunks into subtitle-sized segments, splitting on
 * silence gaps > {@link SEGMENT_GAP_S} or character count > {@link MAX_SEGMENT_CHARS}.
 * Also applies repetition truncation.
 */
export function groupWordsToSegments(words: RawChunk[]): ProcessedSegment[] {
    if (!words || words.length === 0) return [];
    words = truncateRepetitionLoop(words);
    const segments: ProcessedSegment[] = [];
    let seg: RawChunk[] = [words[0]];
    let segChars = (words[0].text || '').trim().length;

    for (let i = 1; i < words.length; i++) {
        const prev = words[i - 1];
        const curr = words[i];
        const prevEnd = prev.timestamp?.[1] ?? prev.timestamp?.[0] ?? 0;
        const currStart = curr.timestamp?.[0] ?? prevEnd;
        const currText = (curr.text || '').trim();
        const gapSplit = currStart - prevEnd > SEGMENT_GAP_S;
        const charSplit = segChars > 0 && segChars + currText.length > MAX_SEGMENT_CHARS;
        if (gapSplit || charSplit) {
            segments.push(buildSegmentFromWords(seg));
            seg = [curr];
            segChars = currText.length;
        } else {
            seg.push(curr);
            segChars += currText.length;
        }
    }
    if (seg.length > 0) segments.push(buildSegmentFromWords(seg));
    return segments;
}

// ── Segment-level formatting (non-word) ────────────────────────────────

/** Convert segment-level chunks to ProcessedSegment (no word timestamps). */
export function formatSegmentChunks(chunks: RawChunk[]): ProcessedSegment[] {
    return chunks
        .map(c => ({
            text: sanitizeWhisperText(c.text),
            timestamp: [c.timestamp?.[0] ?? null, c.timestamp?.[1] ?? null] as [number | null, number | null],
        }))
        .filter(segment => !!segment.text);
}

// ── Bracket restoration ────────────────────────────────────────────────

/**
 * Restore brackets/parens that word-level timestamps may drop.
 * Whisper's tokenizer often excludes speechless punctuation tokens from
 * word-level chunks even though they appear in `result.text`.
 * Mutates `segments` in-place.
 */
export function restoreMissingBrackets(segments: ProcessedSegment[], fullText: string | undefined): void {
    if (!segments.length || !fullText) return;
    const ft = sanitizeWhisperText(fullText);
    if (!ft) return;

    const leadM = ft.match(OPEN_BRACKET_RE);
    if (leadM) {
        const brackets = leadM[1];
        const first = segments[0];
        if (!first.text.startsWith(brackets)) {
            first.text = brackets + first.text;
            if (first.words && first.words.length > 0) {
                first.words[0].text = brackets + first.words[0].text;
            }
        }
    }

    const trailM = ft.match(CLOSE_BRACKET_RE);
    if (trailM) {
        const brackets = trailM[1];
        const last = segments[segments.length - 1];
        if (!last.text.endsWith(brackets)) {
            last.text = last.text + brackets;
            if (last.words && last.words.length > 0) {
                const lastWord = last.words[last.words.length - 1];
                lastWord.text = lastWord.text + brackets;
            }
        }
    }
}

// ── Main entry point ───────────────────────────────────────────────────

/**
 * Process raw Whisper chunks from the worker into display-ready segments.
 *
 * Steps:
 * 1. Filter hallucinated non-speech chunks
 * 2. Use the worker-reported timestamp granularity
 * 3. Group words into segments (with repetition truncation + char cap)
 *    — or format segment-level chunks directly
 * 4. Restore missing brackets from the full model text
 *
 * @param rawChunks  Chunks from the worker (offset already applied)
 * @param fullText   Optional full model text (for bracket restoration on final results)
 * @param granularity Exact capability reported by the worker for this result
 * @returns Processed segments ready for `parseSegments()` in Whisper.ts
 */
export function processRawChunks(
    rawChunks: RawChunk[] | undefined,
    fullText?: string,
    granularity: 'word' | 'segment' = 'segment',
): ProcessedSegment[] {
    if (!rawChunks || rawChunks.length === 0) return [];
    // Word timestamps may split a known hallucination across several chunks.
    // Drop it when the model's complete output is only that phrase, while the
    // anchored pattern preserves real speech that merely surrounds the phrase.
    if (isWhisperHallucinationText(fullText)) return [];

    const cleaned = cleanHallucinatedChunks(rawChunks);
    if (cleaned.length === 0) return [];
    const capped = truncateRepetitionLoop(cleaned);

    let segments: ProcessedSegment[];

    if (granularity === 'word') {
        segments = groupWordsToSegments(capped);
        if (fullText) {
            restoreMissingBrackets(segments, fullText);
        }
    } else {
        segments = formatSegmentChunks(capped);
    }

    return segments;
}
