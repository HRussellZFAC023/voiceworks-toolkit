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
const MAX_REPEATS = 8;
const MIN_PATTERN_LEN = 1;
const MAX_PATTERN_LEN = 6;

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

    return cleaned.replace(/\s+/g, ' ').trim();
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
 * Whisper often hallucinates repeating syllables (e.g. ネンネコ×100) on
 * musical/rhythmic content.  We detect when a short pattern repeats more
 * than {@link MAX_REPEATS} times at the tail and truncate.
 */
export function truncateRepetitionLoop<T extends { text?: string }>(words: T[]): T[] {
    if (words.length < MAX_REPEATS * MIN_PATTERN_LEN) return words;
    const texts = words.map(w => (w.text || '').trim());

    for (let pLen = MIN_PATTERN_LEN; pLen <= MAX_PATTERN_LEN; pLen++) {
        if (texts.length < pLen * MAX_REPEATS) continue;
        const pattern = texts.slice(texts.length - pLen).join('|');
        let repeats = 0;
        for (let i = texts.length - pLen; i >= 0; i -= pLen) {
            if (texts.slice(i, i + pLen).join('|') === pattern) repeats++;
            else break;
        }
        if (repeats >= MAX_REPEATS) {
            const repStart = texts.length - repeats * pLen;
            const keepRepeats = Math.min(3, repeats);
            return words.slice(0, repStart + keepRepeats * pLen);
        }
    }
    return words;
}

// ── Word-level detection ───────────────────────────────────────────────

/** True when chunks appear to be word-level (avg duration < 1.5s). */
export function isWordLevelChunks(chunks: RawChunk[]): boolean {
    if (!chunks || chunks.length < 3) return false;
    let totalDur = 0;
    for (const c of chunks) {
        const s = c.timestamp?.[0] ?? 0;
        const e = c.timestamp?.[1] ?? s;
        totalDur += Math.max(0, e - s);
    }
    return (totalDur / chunks.length) < 1.5;
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
 * 2. Detect word-level vs segment-level output
 * 3. Group words into segments (with repetition truncation + char cap)
 *    — or format segment-level chunks directly
 * 4. Restore missing brackets from the full model text
 *
 * @param rawChunks  Chunks from the worker (offset already applied)
 * @param fullText   Optional full model text (for bracket restoration on final results)
 * @returns Processed segments ready for `parseSegments()` in Whisper.ts
 */
export function processRawChunks(
    rawChunks: RawChunk[] | undefined,
    fullText?: string,
): ProcessedSegment[] {
    if (!rawChunks || rawChunks.length === 0) return [];
    // Word timestamps may split a known hallucination across several chunks.
    // Drop it when the model's complete output is only that phrase, while the
    // anchored pattern preserves real speech that merely surrounds the phrase.
    if (isWhisperHallucinationText(fullText)) return [];

    const cleaned = cleanHallucinatedChunks(rawChunks);
    if (cleaned.length === 0) return [];

    const wordLevel = isWordLevelChunks(cleaned);
    let segments: ProcessedSegment[];

    if (wordLevel) {
        segments = groupWordsToSegments(cleaned);
        if (fullText) {
            restoreMissingBrackets(segments, fullText);
        }
    } else {
        segments = formatSegmentChunks(cleaned);
    }

    return segments;
}
