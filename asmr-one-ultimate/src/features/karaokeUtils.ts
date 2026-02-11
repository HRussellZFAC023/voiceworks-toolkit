/**
 * Karaoke Utilities
 *
 * Shared pure functions for karaoke highlighting with intra-word
 * character interpolation.  Used by both LearnerSubtitles.vue (Vue SFC)
 * and LearnerMode.ts (class-based).
 *
 * Architecture:
 *   1. buildKaraokeCharMap()  — called once per subtitle line change
 *   2. computeWordKaraokeIndices() — called at rAF frequency (~60 fps)
 *   3. computeTimeFallbackKaraokeIndices() — fallback when no word timestamps
 */

// ============================================================================
// Types
// ============================================================================

export interface KaraokeWord {
    start: number;
    end: number;
    text: string;
}

/** Pre-computed character offset entry for one word. */
export interface KaraokeCharEntry {
    charStart: number;   // character offset in fullText (Array.from index)
    charCount: number;   // character count of this word
    wordStart: number;   // audio start time (seconds)
    wordEnd: number;     // audio end time (seconds)
}

/**
 * Pre-computed character offset map for a subtitle line.
 * Built once per line change; reused at 60 fps without allocation.
 */
export interface KaraokeCharMap {
    fullText: string;
    entries: KaraokeCharEntry[];
    totalChars: number;
    hasSpaces: boolean;
}

const WORD_END_PAST_GRACE_SEC = 0.005;

// ============================================================================
// Build Character Map (once per line change)
// ============================================================================

/**
 * Pre-compute character offsets for each word in a subtitle line.
 * This avoids calling Array.from() on every rAF tick.
 */
export function buildKaraokeCharMap(
    fullText: string,
    words: KaraokeWord[],
): KaraokeCharMap {
    const hasSpaces = /\s/.test(fullText);
    const entries: KaraokeCharEntry[] = [];
    let charOffset = 0;

    for (let i = 0; i < words.length; i++) {
        const wText = (words[i].text || '').trim();
        const wChars = Array.from(wText).length;
        entries.push({
            charStart: charOffset,
            charCount: wChars,
            wordStart: words[i].start,
            wordEnd: words[i].end,
        });
        charOffset += wChars;
        if (hasSpaces && i < words.length - 1) charOffset += 1;
    }

    return {
        fullText,
        entries,
        totalChars: Array.from(fullText).length,
        hasSpaces,
    };
}

// ============================================================================
// Word-Level Karaoke with Intra-Word Interpolation
// ============================================================================

/**
 * Compute karaoke indices from a pre-built character map.
 *
 * When `now` falls inside a word's [start, end) range, interpolates
 * splitIdx proportionally through that word's characters instead of
 * snapping to word boundaries.
 *
 * Returns { splitIdx, hlStart } where:
 *   hlStart  = char index where the current/last word starts
 *   splitIdx = char index up to which text is "spoken"
 *
 * Visual: [past 0..hlStart] [current hlStart..splitIdx] [upcoming splitIdx..end]
 */
export function computeWordKaraokeIndices(
    charMap: KaraokeCharMap,
    now: number,
): { splitIdx: number; hlStart: number } {
    const { entries } = charMap;
    if (entries.length === 0) return { splitIdx: 0, hlStart: 0 };

    let lastPastSplit = 0;
    let lastPastHl = 0;
    let foundPast = false;

    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];

        if (e.wordEnd <= now - WORD_END_PAST_GRACE_SEC) {
            // Word fully in the past (small grace avoids eager next-char highlighting).
            lastPastSplit = e.charStart + e.charCount;
            lastPastHl = e.charStart;
            foundPast = true;
        } else if (e.wordStart <= now) {
            // Active word — interpolate through its characters
            const dur = Math.max(0.01, e.wordEnd - e.wordStart);
            const progress = Math.max(0, Math.min(1, (now - e.wordStart) / dur));
            const filled = Math.max(1, Math.ceil(progress * e.charCount));
            return {
                splitIdx: e.charStart + Math.min(filled, e.charCount),
                hlStart: e.charStart,
            };
        } else {
            // Future word — stop searching (words are time-sorted)
            break;
        }
    }

    if (foundPast) return { splitIdx: lastPastSplit, hlStart: lastPastHl };

    // Before any word started
    return { splitIdx: 0, hlStart: 0 };
}

// ============================================================================
// Time-Based Fallback (no word timestamps)
// ============================================================================

/**
 * Fallback karaoke indices when no word-level timestamps are available.
 * Uses time-based linear interpolation over the line duration.
 *
 * @param totalChars - pre-computed Array.from(fullText).length (avoid recomputing at 60fps)
 */
export function computeTimeFallbackKaraokeIndices(
    fullText: string,
    totalChars: number,
    lineTime: number,
    lineEndTime: number | undefined,
    now: number,
): { splitIdx: number; hlStart: number } {
    if (lineEndTime == null) return { splitIdx: -1, hlStart: -1 };
    const duration = Math.max(0.05, lineEndTime - lineTime);
    const progress = Math.max(0, Math.min(1, (now - lineTime) / duration));

    if (/\s/.test(fullText)) {
        // Space-separated: interpolate by word
        const ws = fullText.split(/\s+/).filter(Boolean);
        const count = Math.max(1, Math.min(ws.length, Math.ceil(progress * ws.length)));
        const spoken = ws.slice(0, count).join(' ');
        const spokenChars = Array.from(spoken).length;
        const prevWords = ws.slice(0, count - 1);
        const prevLen = prevWords.length > 0 ? Array.from(prevWords.join(' ')).length + 1 : 0;
        return { splitIdx: spokenChars, hlStart: prevLen };
    }

    // CJK (no spaces): smooth character-level interpolation
    const splitIdx = Math.max(1, Math.min(totalChars, Math.ceil(progress * totalChars)));
    return { splitIdx, hlStart: Math.max(0, splitIdx - 1) };
}
