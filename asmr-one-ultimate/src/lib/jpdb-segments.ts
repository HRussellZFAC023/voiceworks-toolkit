/**
 * JPDB Segment Utilities
 *
 * Converts JPDB tokens into a flat segment array that can be split
 * at arbitrary character boundaries for karaoke integration.
 *
 * Segments represent the smallest renderable units: either a plain text
 * span or a ruby-annotated kanji group.
 */

import type { JPDBToken, JPDBRuby } from '../types/jpdb';

// ============================================================================
// Types
// ============================================================================

export interface FuriganaSegment {
    /** The base text (kanji or kana) */
    base: string;
    /** Ruby reading text (undefined for plain kana segments) */
    rt?: string;
    /** JPDB vocabulary ID (for popover interaction) */
    vid?: number;
    /** JPDB sense ID */
    sid?: number;
    /** Pitch accent class (heiban, atamadaka, etc.) */
    pitchClass?: string;
    /** Card state CSS class (jpdb-new, jpdb-known, etc.) */
    stateClass?: string;
    /** Character start index in the full text (Array.from index, not UTF-16) */
    charStart: number;
    /** Character end index (exclusive) */
    charEnd: number;
}

// ============================================================================
// Build Segments from Tokens
// ============================================================================

/**
 * Convert JPDB tokens for a single paragraph into a flat array of renderable segments.
 *
 * The tokens use UTF-16 positions, but we need character indices (Array.from).
 * This function handles the mapping between the two coordinate systems.
 */
export function buildSegments(fullText: string, tokens: JPDBToken[]): FuriganaSegment[] {
    if (!tokens.length || !fullText) return [];

    const chars = Array.from(fullText);
    const segments: FuriganaSegment[] = [];

    // Build a UTF-16 offset → char index map
    const utf16ToCharIdx = new Map<number, number>();
    let utf16Offset = 0;
    for (let i = 0; i < chars.length; i++) {
        utf16ToCharIdx.set(utf16Offset, i);
        // Each character may be 1 or 2 UTF-16 code units
        utf16Offset += chars[i].length; // .length gives UTF-16 code unit count
    }
    // Map the end position too
    utf16ToCharIdx.set(utf16Offset, chars.length);

    const toCharIdx = (utf16Pos: number): number => {
        const idx = utf16ToCharIdx.get(utf16Pos);
        if (idx !== undefined) return idx;
        // Fallback: find nearest
        let closest = 0;
        for (const [pos, ci] of utf16ToCharIdx) {
            if (pos <= utf16Pos) closest = ci;
        }
        return closest;
    };

    let lastCharEnd = 0;

    for (const token of tokens) {
        const tokenCharStart = toCharIdx(token.start);
        const tokenCharEnd = toCharIdx(token.end);

        // Fill gap before this token (unmatched text)
        if (tokenCharStart > lastCharEnd) {
            segments.push({
                base: chars.slice(lastCharEnd, tokenCharStart).join(''),
                charStart: lastCharEnd,
                charEnd: tokenCharStart,
            });
        }

        const card = token.card;
        const stateClass = card.cardState[0] ? `jpdb-${card.cardState[0]}` : undefined;

        if (token.rubies.length === 0) {
            // No furigana — single plain segment for the whole token
            segments.push({
                base: chars.slice(tokenCharStart, tokenCharEnd).join(''),
                vid: card.vid,
                sid: card.sid,
                pitchClass: token.pitchClass || undefined,
                stateClass,
                charStart: tokenCharStart,
                charEnd: tokenCharEnd,
            });
        } else {
            // Has furigana — split into sub-segments (kana gaps + ruby groups)
            let rubyLastCharEnd = tokenCharStart;

            for (const ruby of token.rubies) {
                const rubyCharStart = toCharIdx(ruby.start);
                const rubyCharEnd = toCharIdx(ruby.end);

                // Kana gap before this ruby
                if (rubyCharStart > rubyLastCharEnd) {
                    segments.push({
                        base: chars.slice(rubyLastCharEnd, rubyCharStart).join(''),
                        vid: card.vid,
                        sid: card.sid,
                        pitchClass: token.pitchClass || undefined,
                        stateClass,
                        charStart: rubyLastCharEnd,
                        charEnd: rubyCharStart,
                    });
                }

                // Ruby segment
                segments.push({
                    base: chars.slice(rubyCharStart, rubyCharEnd).join(''),
                    rt: ruby.text,
                    vid: card.vid,
                    sid: card.sid,
                    pitchClass: token.pitchClass || undefined,
                    stateClass,
                    charStart: rubyCharStart,
                    charEnd: rubyCharEnd,
                });

                rubyLastCharEnd = rubyCharEnd;
            }

            // Trailing kana after last ruby
            if (rubyLastCharEnd < tokenCharEnd) {
                segments.push({
                    base: chars.slice(rubyLastCharEnd, tokenCharEnd).join(''),
                    vid: card.vid,
                    sid: card.sid,
                    pitchClass: token.pitchClass || undefined,
                    stateClass,
                    charStart: rubyLastCharEnd,
                    charEnd: tokenCharEnd,
                });
            }
        }

        lastCharEnd = tokenCharEnd;
    }

    // Trailing text after all tokens
    if (lastCharEnd < chars.length) {
        segments.push({
            base: chars.slice(lastCharEnd).join(''),
            charStart: lastCharEnd,
            charEnd: chars.length,
        });
    }

    return segments;
}

// ============================================================================
// Slice Segments at Character Boundaries
// ============================================================================

/**
 * Slice a segment array at arbitrary character boundaries.
 *
 * Used for karaoke: split segments into past/current/upcoming portions.
 * Handles the case where a ruby group straddles the boundary by splitting
 * it into two segments (the ruby text is assigned to the first half).
 */
export function sliceSegments(
    segments: FuriganaSegment[] | null,
    fromCharIdx: number,
    toCharIdx: number,
): FuriganaSegment[] {
    if (!segments || fromCharIdx >= toCharIdx) return [];

    const result: FuriganaSegment[] = [];

    for (const seg of segments) {
        // Completely before range
        if (seg.charEnd <= fromCharIdx) continue;
        // Completely after range
        if (seg.charStart >= toCharIdx) break;

        // Fully contained
        if (seg.charStart >= fromCharIdx && seg.charEnd <= toCharIdx) {
            result.push(seg);
            continue;
        }

        // Partial overlap — split the segment
        const chars = Array.from(seg.base);
        const segLen = seg.charEnd - seg.charStart;
        const clipStart = Math.max(0, fromCharIdx - seg.charStart);
        const clipEnd = Math.min(segLen, toCharIdx - seg.charStart);

        if (clipStart >= clipEnd) continue;

        const clippedChars = chars.slice(clipStart, clipEnd);

        result.push({
            base: clippedChars.join(''),
            // Only keep ruby if this is the full ruby group (or the first portion)
            rt: clipStart === 0 ? seg.rt : undefined,
            vid: seg.vid,
            sid: seg.sid,
            pitchClass: seg.pitchClass,
            stateClass: seg.stateClass,
            charStart: seg.charStart + clipStart,
            charEnd: seg.charStart + clipEnd,
        });
    }

    return result;
}

// ============================================================================
// Utility: Render segments to HTML string (for LearnerMode.ts class-based)
// ============================================================================

/**
 * Render furigana segments to an HTML string.
 * Used by the class-based LearnerMode (not the Vue component).
 */
export function segmentsToHtml(segments: FuriganaSegment[]): string {
    return segments.map(seg => {
        const classes: string[] = [];
        if (seg.vid !== undefined) classes.push('jpdb-word');
        if (seg.stateClass) classes.push(seg.stateClass);
        if (seg.pitchClass) classes.push(seg.pitchClass);

        const attrs: string[] = [];
        if (classes.length) attrs.push(`class="${classes.join(' ')}"`);
        if (seg.vid !== undefined) attrs.push(`data-vid="${seg.vid}"`);
        if (seg.sid !== undefined) attrs.push(`data-sid="${seg.sid}"`);
        attrs.push('data-jpdb="true"');

        if (seg.rt) {
            return `<span ${attrs.join(' ')}><ruby>${escapeHtml(seg.base)}<rt class="jpdb-furi">${escapeHtml(seg.rt)}</rt></ruby></span>`;
        }

        if (seg.vid !== undefined) {
            return `<span ${attrs.join(' ')}>${escapeHtml(seg.base)}</span>`;
        }

        return escapeHtml(seg.base);
    }).join('');
}

function escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
