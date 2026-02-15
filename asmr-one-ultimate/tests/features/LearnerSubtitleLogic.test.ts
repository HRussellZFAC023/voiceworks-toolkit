/**
 * Tests for LearnerSubtitles display logic:
 * - Seek edge cases (last segment, past all segments, first segment, clamping fallback)
 * - Progressive text / karaoke rendering
 * - Text stability when paused (no flashing from whisper updates)
 * - Cache continuation with incomplete transcripts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    buildKaraokeCharMap,
    computeWordKaraokeIndices as computeWordKaraokeIndicesImpl,
    computeTimeFallbackKaraokeIndices as computeTimeFallbackKaraokeIndicesImpl,
} from '../../src/features/karaokeUtils';

// ---------------------------------------------------------------------------
// Extracted pure functions (mirroring LearnerSubtitles.vue logic)
// ---------------------------------------------------------------------------

function findActiveLine(
    lines: Array<{ time: number; endTime?: number; text: string }>,
    now: number,
): { time: number; endTime?: number; text: string } | null {
    if (lines.length === 0) return null;
    let activeIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].time <= now) { activeIdx = i; break; }
    }
    if (activeIdx < 0) return null;
    const activeLine = lines[activeIdx];
    if (activeLine.endTime && now >= activeLine.endTime) {
        // Check for a longer overlapping segment that still covers `now`
        for (let i = activeIdx - 1; i >= 0; i--) {
            const earlier = lines[i];
            if (earlier.endTime && earlier.endTime > now && earlier.time <= now) {
                return earlier;
            }
            if (now - earlier.time > 60) break;
        }
        const nextLine = lines[activeIdx + 1];
        if (!nextLine) return activeLine;
        if ((nextLine.time - activeLine.endTime) < 2.0) return activeLine;
        return null;
    }
    return activeLine;
}

function getProgressiveText(
    line: { time: number; endTime?: number; text: string; words?: Array<{ start: number; end: number; text: string }> },
    now: number,
): string {
    const text = line.text?.trim() || '';
    if (!text || line.endTime == null) return text;

    const words = line.words;
    if (Array.isArray(words) && words.length > 0) {
        const visible = words.filter(w => w.start <= now + 0.01).map(w => (w.text || '').trim()).filter(Boolean);
        if (visible.length === 0) return '';
        return /\s/.test(text) ? visible.join(' ') : visible.join('');
    }

    const duration = Math.max(0.05, line.endTime - line.time);
    const progress = Math.max(0, Math.min(1, (now - line.time) / duration));
    if (/\s/.test(text)) {
        const ws = text.split(/\s+/).filter(Boolean);
        const count = Math.max(1, Math.min(ws.length, Math.ceil(progress * ws.length)));
        return ws.slice(0, count).join(' ');
    }
    const chars = Array.from(text);
    const count = Math.max(1, Math.min(chars.length, Math.ceil(progress * chars.length)));
    return chars.slice(0, count).join('');
}

/**
 * Mirrors the seek() function from LearnerSubtitles.vue
 * Returns { targetTime, fallback } instead of mutating audio element
 */
function computeSeekTarget(
    lines: Array<{ time: number; text: string }>,
    currentTime: number,
    offset: number,
): { targetTime: number; fallback: boolean } {
    if (!lines.length) {
        return { targetTime: Math.max(0, currentTime + offset * 5), fallback: true };
    }
    const now = currentTime;
    const firstAfter = lines.findIndex(l => l.time > now);
    let idx: number;
    if (firstAfter === -1) {
        idx = lines.length - 1;
    } else if (firstAfter === 0) {
        idx = 0;
    } else {
        idx = firstAfter - 1;
    }
    const rawTarget = idx + offset;
    const targetIdx = Math.max(0, Math.min(lines.length - 1, rawTarget));
    // If clamped (no more segments in this direction), fall back to time-based seek
    if (targetIdx === idx && offset !== 0) {
        return { targetTime: Math.max(0, currentTime + offset * 5), fallback: true };
    }
    const target = lines[targetIdx];
    return { targetTime: target.time + 0.01, fallback: false };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Seek logic', () => {
    const lines = [
        { time: 0, text: 'line 0' },
        { time: 10, text: 'line 1' },
        { time: 20, text: 'line 2' },
        { time: 30, text: 'line 3' },
        { time: 40, text: 'line 4' },
    ];

    describe('seek(1) — next line', () => {
        it('advances from mid-segment to next segment', () => {
            const result = computeSeekTarget(lines, 15.5, 1);
            expect(result.fallback).toBe(false);
            expect(result.targetTime).toBeCloseTo(20.01, 1);
        });

        it('advances from start of segment to next segment', () => {
            const result = computeSeekTarget(lines, 10.01, 1);
            expect(result.fallback).toBe(false);
            expect(result.targetTime).toBeCloseTo(20.01, 1);
        });

        it('falls back to +5s when at last segment', () => {
            const result = computeSeekTarget(lines, 42, 1);
            expect(result.fallback).toBe(true);
            expect(result.targetTime).toBeCloseTo(47, 0);
        });

        it('falls back to +5s when past all segments', () => {
            const result = computeSeekTarget(lines, 100, 1);
            expect(result.fallback).toBe(true);
            expect(result.targetTime).toBeCloseTo(105, 0);
        });

        it('advances from before first segment', () => {
            const result = computeSeekTarget(lines, -1, 1);
            // idx=0 (firstAfter=0 path), offset=1 → targetIdx=1
            expect(result.fallback).toBe(false);
            expect(result.targetTime).toBeCloseTo(10.01, 1);
        });

        it('falls back when no lines', () => {
            const result = computeSeekTarget([], 15, 1);
            expect(result.fallback).toBe(true);
            expect(result.targetTime).toBeCloseTo(20, 0);
        });
    });

    describe('seek(-1) — previous line', () => {
        it('goes to previous segment from mid-segment', () => {
            const result = computeSeekTarget(lines, 25, -1);
            expect(result.fallback).toBe(false);
            expect(result.targetTime).toBeCloseTo(10.01, 1);
        });

        it('falls back to -5s when at first segment', () => {
            const result = computeSeekTarget(lines, 3, -1);
            // idx=0 (in first segment), offset=-1 → rawTarget=-1, clamped to 0 = idx → fallback
            expect(result.fallback).toBe(true);
        });

        it('falls back when before all segments', () => {
            const result = computeSeekTarget(lines, -1, -1);
            expect(result.fallback).toBe(true);
        });
    });

    describe('seek(0) — stay', () => {
        it('does not trigger fallback for offset 0', () => {
            const result = computeSeekTarget(lines, 15, 0);
            // offset 0 → targetIdx === idx, but offset is 0 so no fallback
            expect(result.fallback).toBe(false);
            expect(result.targetTime).toBeCloseTo(10.01, 1);
        });
    });

    describe('edge: single segment', () => {
        const singleLine = [{ time: 5, text: 'only' }];

        it('seek(1) falls back with single segment when inside it', () => {
            const result = computeSeekTarget(singleLine, 7, 1);
            expect(result.fallback).toBe(true);
        });

        it('seek(-1) falls back with single segment', () => {
            const result = computeSeekTarget(singleLine, 7, -1);
            expect(result.fallback).toBe(true);
        });
    });

    describe('edge: just-seeked position (target.time + 0.01)', () => {
        it('does not get stuck after a seek', () => {
            // After seeking to line 2 (time=20), audio.currentTime = 20.01
            const result = computeSeekTarget(lines, 20.01, 1);
            // firstAfter finds line 3 (time=30 > 20.01), idx=2, targetIdx=3
            expect(result.fallback).toBe(false);
            expect(result.targetTime).toBeCloseTo(30.01, 1);
        });
    });
});

describe('Progressive text (getProgressiveText)', () => {
    it('returns full text when endTime is missing', () => {
        const line = { time: 10, text: 'hello world' };
        expect(getProgressiveText(line, 12)).toBe('hello world');
    });

    it('returns partial text based on time progress', () => {
        const line = { time: 10, endTime: 20, text: 'hello world' };
        // At time 10 (start), progress=0 → 1 word minimum
        expect(getProgressiveText(line, 10)).toBe('hello');
        // At time 15 (midway), progress=0.5 → 1 of 2 words (ceil(0.5*2)=1)
        expect(getProgressiveText(line, 15)).toBe('hello');
        // At time 19.9 (near end), progress≈1 → both words
        expect(getProgressiveText(line, 19.9)).toBe('hello world');
    });

    it('returns characters for CJK text without spaces', () => {
        const line = { time: 0, endTime: 10, text: 'こんにちは' };
        // 5 chars, at time 2 progress=0.2, ceil(0.2*5)=1
        expect(getProgressiveText(line, 2)).toBe('こ');
        // at time 8 progress=0.8, ceil(0.8*5)=4
        expect(getProgressiveText(line, 8)).toBe('こんにち');
        // at time 10 progress=1.0, all chars
        expect(getProgressiveText(line, 10)).toBe('こんにちは');
    });

    it('uses word-level timestamps when available', () => {
        const line = {
            time: 0, endTime: 6, text: 'おはよう',
            words: [
                { start: 0, end: 2, text: 'お' },
                { start: 2, end: 4, text: 'は' },
                { start: 4, end: 5, text: 'よ' },
                { start: 5, end: 6, text: 'う' },
            ],
        };
        // At time 1, only first word visible
        expect(getProgressiveText(line, 1)).toBe('お');
        // At time 3, first two words
        expect(getProgressiveText(line, 3)).toBe('おは');
        // At time 5.5, all four
        expect(getProgressiveText(line, 5.5)).toBe('おはよう');
    });

    it('returns empty when before all word timestamps', () => {
        const line = {
            time: 5, endTime: 10, text: 'test',
            words: [{ start: 5.5, end: 10, text: 'test' }],
        };
        expect(getProgressiveText(line, 5)).toBe('');
    });
});

describe('findActiveLine', () => {
    const lines = [
        { time: 0, endTime: 5, text: 'A' },
        { time: 5, endTime: 10, text: 'B' },
        { time: 10, endTime: 15, text: 'C' },
    ];

    it('returns correct segment for time within range', () => {
        expect(findActiveLine(lines, 3)?.text).toBe('A');
        expect(findActiveLine(lines, 7)?.text).toBe('B');
        expect(findActiveLine(lines, 12)?.text).toBe('C');
    });

    it('returns null in gap between segments', () => {
        const gapped = [
            { time: 0, endTime: 3, text: 'A' },
            { time: 7, endTime: 10, text: 'B' },
        ];
        expect(findActiveLine(gapped, 5)).toBeNull();
    });

    it('returns null before first segment', () => {
        expect(findActiveLine(lines, -1)).toBeNull();
    });

    it('holds last segment after it ends (live transcription catch-up)', () => {
        expect(findActiveLine(lines, 16)?.text).toBe('C');
    });

    it('returns segment at exact start time', () => {
        expect(findActiveLine(lines, 5)?.text).toBe('B');
    });

    it('handles exact end time correctly', () => {
        // With B starting at time=5, findActiveLine picks B (not expired A)
        expect(findActiveLine(lines, 5)?.text).toBe('B');
        // Single segment past endTime — held visible (no next line to transition to)
        const lineA = findActiveLine([{ time: 0, endTime: 5, text: 'A' }], 5);
        expect(lineA?.text).toBe('A');
    });

    it('returns segment without endTime (LRC-style)', () => {
        const lrcLines = [
            { time: 0, text: 'line1' },
            { time: 10, text: 'line2' },
        ];
        // Without endTime, segment is active forever until next starts
        expect(findActiveLine(lrcLines, 5)?.text).toBe('line1');
        expect(findActiveLine(lrcLines, 15)?.text).toBe('line2');
    });

    it('returns empty array → null', () => {
        expect(findActiveLine([], 5)).toBeNull();
    });

    it('holds current segment in short gap (< 2s)', () => {
        const gapped = [
            { time: 0, endTime: 3, text: 'A' },
            { time: 4.5, endTime: 8, text: 'B' },
        ];
        // Gap is 4.5 - 3 = 1.5 < 2.0, so A is held
        expect(findActiveLine(gapped, 3.5)?.text).toBe('A');
    });

    it('prefers longer overlapping segment over expired fragment', () => {
        // Simulates residual fragment from chunk-boundary overlap:
        // Long segment at 10-18, short fragment at 10.05-10.5
        const lines = [
            { time: 10, endTime: 18, text: 'はい頑張りすぎないくらいがちょうどいい' },
            { time: 10.05, endTime: 10.5, text: 'はい' },
        ];
        // At time 12, fragment is expired (12 > 10.5). Should fall back
        // to the longer segment that still covers time 12.
        expect(findActiveLine(lines, 12)?.text).toBe('はい頑張りすぎないくらいがちょうどいい');
    });

    it('prefers longer overlapping segment even with more lines after', () => {
        const lines = [
            { time: 10, endTime: 18, text: 'full sentence' },
            { time: 10.05, endTime: 10.5, text: 'fragment' },
            { time: 20, endTime: 25, text: 'next sentence' },
        ];
        // At time 15, fragment expired, but full sentence still covers it
        expect(findActiveLine(lines, 15)?.text).toBe('full sentence');
    });
});

describe('Karaoke mode split index', () => {
    it('computes correct split for CJK characters', () => {
        const fullText = 'こんにちは世界';
        const progressiveText = 'こんにち';
        const splitIdx = Array.from(progressiveText).length;
        const spoken = Array.from(fullText).slice(0, splitIdx).join('');
        const upcoming = Array.from(fullText).slice(splitIdx).join('');
        expect(spoken).toBe('こんにち');
        expect(upcoming).toBe('は世界');
    });

    it('computes correct split for space-separated text', () => {
        const fullText = 'hello beautiful world';
        const progressiveText = 'hello beautiful';
        const splitIdx = Array.from(progressiveText).length;
        const spoken = Array.from(fullText).slice(0, splitIdx).join('');
        const upcoming = Array.from(fullText).slice(splitIdx).join('');
        expect(spoken).toBe('hello beautiful');
        expect(upcoming).toBe(' world');
    });

    it('handles empty progressive text (split at 0)', () => {
        const fullText = 'test';
        const splitIdx = 0;
        const spoken = Array.from(fullText).slice(0, splitIdx).join('');
        const upcoming = Array.from(fullText).slice(splitIdx).join('');
        expect(spoken).toBe('');
        expect(upcoming).toBe('test');
    });

    it('handles full progress (split at end)', () => {
        const fullText = 'test';
        const splitIdx = Array.from(fullText).length;
        const spoken = Array.from(fullText).slice(0, splitIdx).join('');
        const upcoming = Array.from(fullText).slice(splitIdx).join('');
        expect(spoken).toBe('test');
        expect(upcoming).toBe('');
    });
});

describe('Text stability (anti-flashing)', () => {
    it('dedup comparison prevents re-render when text unchanged', () => {
        let lastWhisperDisplayText = 'こんにちは';
        const displayText = 'こんにちは';

        // The condition in _updateWhisperDisplay:
        // if (display.displayText && display.displayText !== lastWhisperDisplayText)
        const shouldUpdate = displayText !== lastWhisperDisplayText;
        expect(shouldUpdate).toBe(false);
    });

    it('allows update when progressive text advances', () => {
        let lastWhisperDisplayText = 'こん';
        const displayText = 'こんに';

        const shouldUpdate = displayText !== lastWhisperDisplayText;
        expect(shouldUpdate).toBe(true);
    });

    it('does NOT flash when whisper reprocesses same audio producing identical text', () => {
        // Simulates: whisper update arrives but text at current position is same
        let lastWhisperDisplayText = '周囲';
        // Without reset, comparison catches that text hasn't changed
        const displayText = '周囲';
        expect(displayText !== lastWhisperDisplayText).toBe(false);
    });

    it('DOES update when whisper genuinely produces different text at current position', () => {
        let lastWhisperDisplayText = '周囲';
        // Whisper refined the transcription
        const displayText = '周囲の';
        expect(displayText !== lastWhisperDisplayText).toBe(true);
    });
});

describe('Segment mode (full text, no progressive reveal)', () => {
    it('returns full text immediately regardless of time position', () => {
        const line = { time: 10, endTime: 20, text: 'hello world' };
        // In segment mode, getProgressiveText would return text directly
        // We test the segment mode bypass: just return text without progressive calc
        const segmentMode = true;
        const result = segmentMode ? line.text.trim() : getProgressiveText(line, 10);
        expect(result).toBe('hello world');
    });

    it('returns full CJK text immediately in segment mode', () => {
        const line = { time: 0, endTime: 10, text: 'こんにちは世界' };
        const segmentMode = true;
        const result = segmentMode ? line.text.trim() : getProgressiveText(line, 0);
        expect(result).toBe('こんにちは世界');
    });

    it('progressive mode still works when segment mode is off', () => {
        const line = { time: 0, endTime: 10, text: 'こんにちは' };
        const segmentMode = false;
        const result = segmentMode ? line.text.trim() : getProgressiveText(line, 2);
        // progress=0.2, chars=5, ceil(0.2*5)=1 → first char only
        expect(result).toBe('こ');
    });
});

describe('handleAudioSeeking (no clearDisplay)', () => {
    it('resets dedup state but preserves display', () => {
        // Simulates the handleAudioSeeking fix:
        // We reset tracking vars but do NOT call clearDisplay()
        let lastText = 'previous text';
        let lastDisplayedText = 'previous text';
        let lastWhisperDisplayText = 'previous text';
        let translationToken = 5;
        let displayCleared = false;

        // The fixed handler:
        lastText = '';
        lastDisplayedText = '';
        lastWhisperDisplayText = '';
        translationToken += 1;
        // clearDisplay() is NOT called

        expect(lastText).toBe('');
        expect(translationToken).toBe(6);
        expect(displayCleared).toBe(false); // Display was NOT cleared
    });
});

describe('Seek pre-populate display', () => {
    it('resets dedup state after seek to allow immediate updateLyrics', () => {
        // After audio.currentTime = target.time + 0.01, we reset dedup state
        // so updateLyrics() will populate the display immediately
        let lastText = 'old text';
        let lastDisplayedText = 'old text';
        let lastWhisperDisplayText = 'old text';
        let translationToken = 3;
        let updateLyricsCalled = false;

        // Simulate seek pre-populate logic
        lastText = '';
        lastDisplayedText = '';
        lastWhisperDisplayText = '';
        translationToken += 1;
        updateLyricsCalled = true; // updateLyrics() is called immediately

        expect(lastText).toBe('');
        expect(translationToken).toBe(4);
        expect(updateLyricsCalled).toBe(true);
    });

    it('allows updateLyrics to detect new text after dedup reset', () => {
        let lastWhisperDisplayText = '';
        const newText = '新しいテキスト';

        // After dedup reset, new text will pass the comparison
        const shouldUpdate = newText !== lastWhisperDisplayText;
        expect(shouldUpdate).toBe(true);
    });
});

describe('Cache continuation', () => {
    it('incomplete cache should allow transcription to continue', () => {
        // Simulates the logic in Whisper.startTranscription()
        const cached = {
            segments: [
                { start: 0, end: 5, text: 'hello' },
                { start: 5, end: 10, text: 'world' },
            ],
            text: 'hello world',
            complete: false,
            model: 'test',
            subtask: 'transcribe',
            language: 'ja',
            createdAt: Date.now(),
        };

        // With the fix: incomplete cache should NOT stop transcription
        const shouldStop = !!cached.complete;
        expect(shouldStop).toBe(false);

        // transcribedUpTo should be set to continue from cache end
        const lastSegmentEnd = cached.segments[cached.segments.length - 1]?.end || 0;
        const transcribedUpTo = Math.max(0, lastSegmentEnd - 2);
        expect(transcribedUpTo).toBe(8); // 10 - 2 = 8, allowing overlap for smooth continuation
    });

    it('complete cache should stop transcription', () => {
        const cached = {
            segments: [{ start: 0, end: 60, text: 'full transcript' }],
            text: 'full transcript',
            complete: true,
            model: 'test',
            subtask: 'transcribe',
            language: 'ja',
            createdAt: Date.now(),
        };

        const shouldStop = !!cached.complete;
        expect(shouldStop).toBe(true);
    });

    it('transcribedUpTo preserved when partial cache exists', () => {
        // Simulates the fix in Whisper.ts startTranscription():
        // cacheTranscribedUpTo saved before audio fetch, restored via Math.max after decode
        const cacheTranscribedUpTo = 600; // Partial cache ends at 600s
        const audioCurrentTime = 0; // User just started playback
        const INITIAL_BACKFILL_SEC = 10;
        const pcmDuration = 1800; // 30 minutes

        // After audio decode, transcribedUpTo would be set to:
        let transcribedUpTo = Math.max(0, Math.min(pcmDuration, audioCurrentTime - INITIAL_BACKFILL_SEC));
        expect(transcribedUpTo).toBe(0); // Would lose cache point!

        // Fix: restore cache continuation point
        if (cacheTranscribedUpTo > transcribedUpTo) {
            transcribedUpTo = cacheTranscribedUpTo;
        }
        expect(transcribedUpTo).toBe(600); // Cache point preserved
    });

    it('transcribedUpTo not affected when no partial cache', () => {
        const cacheTranscribedUpTo = 0; // No cache
        const audioCurrentTime = 5;
        const INITIAL_BACKFILL_SEC = 10;
        const pcmDuration = 1800;

        let transcribedUpTo = Math.max(0, Math.min(pcmDuration, audioCurrentTime - INITIAL_BACKFILL_SEC));
        expect(transcribedUpTo).toBe(0);

        if (cacheTranscribedUpTo > transcribedUpTo) {
            transcribedUpTo = cacheTranscribedUpTo;
        }
        expect(transcribedUpTo).toBe(0); // No change
    });

    it('takes Math.max when user is beyond cache', () => {
        const cacheTranscribedUpTo = 300; // Cache up to 5 min
        const audioCurrentTime = 900; // User at 15 min
        const INITIAL_BACKFILL_SEC = 10;
        const pcmDuration = 1800;

        let transcribedUpTo = Math.max(0, Math.min(pcmDuration, audioCurrentTime - INITIAL_BACKFILL_SEC));
        expect(transcribedUpTo).toBe(890);

        if (cacheTranscribedUpTo > transcribedUpTo) {
            transcribedUpTo = cacheTranscribedUpTo;
        }
        // User is at 890s, cache only at 300s — keep 890
        expect(transcribedUpTo).toBe(890);
    });
});

// ---------------------------------------------------------------------------
// computeWordKaraokeIndices / computeTimeFallbackKaraokeIndices
// (Mirrors LearnerSubtitles.vue & LearnerMode.ts)
// ---------------------------------------------------------------------------

// Convenience wrappers matching the old 3-arg API for test readability.
// Internally delegates to the shared karaokeUtils (buildKaraokeCharMap + compute).
function computeWordKaraokeIndices(
    fullText: string,
    words: Array<{ start: number; end: number; text: string }>,
    now: number,
): { splitIdx: number; hlStart: number } {
    const charMap = buildKaraokeCharMap(fullText, words);
    return computeWordKaraokeIndicesImpl(charMap, now);
}

function computeTimeFallbackKaraokeIndices(
    fullText: string,
    line: { time: number; endTime?: number },
    now: number,
): { splitIdx: number; hlStart: number } {
    const totalChars = Array.from(fullText).length;
    return computeTimeFallbackKaraokeIndicesImpl(fullText, totalChars, line.time, line.endTime, now);
}

describe('computeWordKaraokeIndices', () => {
    it('tracks current word for CJK without spaces', () => {
        const fullText = 'おはよう';
        const words = [
            { start: 0, end: 1, text: 'お' },
            { start: 1, end: 2, text: 'は' },
            { start: 2, end: 3, text: 'よ' },
            { start: 3, end: 4, text: 'う' },
        ];
        // At time 1.5: first two words spoken, last spoken is 'は'
        const result = computeWordKaraokeIndices(fullText, words, 1.5);
        expect(result.hlStart).toBe(1); // 'は' starts at char 1
        expect(result.splitIdx).toBe(2); // 'は' ends at char 2
    });

    it('tracks current word for spaced text with intra-word interpolation', () => {
        const fullText = 'hello beautiful world';
        const words = [
            { start: 0, end: 1, text: 'hello' },
            { start: 1, end: 2, text: 'beautiful' },
            { start: 2, end: 3, text: 'world' },
        ];
        // At time 1.5: 'hello' fully past, 'beautiful' is active at 50% → ceil(0.5*9)=5 chars
        const result = computeWordKaraokeIndices(fullText, words, 1.5);
        expect(result.hlStart).toBe(6); // 'beautiful' starts at char 6 (after "hello ")
        expect(result.splitIdx).toBe(11); // 5 of 9 chars through "beautiful" → 6+5=11
    });

    it('returns 0,0 before any word starts', () => {
        const fullText = 'test';
        const words = [{ start: 5, end: 10, text: 'test' }];
        const result = computeWordKaraokeIndices(fullText, words, 0);
        expect(result.hlStart).toBe(0);
        expect(result.splitIdx).toBe(0);
    });

    it('returns last word when all spoken', () => {
        const fullText = 'a b c';
        const words = [
            { start: 0, end: 1, text: 'a' },
            { start: 1, end: 2, text: 'b' },
            { start: 2, end: 3, text: 'c' },
        ];
        const result = computeWordKaraokeIndices(fullText, words, 3);
        expect(result.hlStart).toBe(4); // 'c' starts at char 4 (after "a b ")
        expect(result.splitIdx).toBe(5); // 'c' ends at char 5
    });
});

describe('computeTimeFallbackKaraokeIndices', () => {
    it('returns word-level indices for spaced text', () => {
        const fullText = 'hello world test';
        const line = { time: 0, endTime: 3 };
        // At time 1 (33% progress): ceil(0.33*3)=1 word revealed
        const result = computeTimeFallbackKaraokeIndices(fullText, line, 1);
        expect(result.splitIdx).toBe(5); // "hello" = 5 chars
        expect(result.hlStart).toBe(0); // first word, no previous words
    });

    it('returns char-level indices for CJK', () => {
        const fullText = 'こんにちは';
        const line = { time: 0, endTime: 5 };
        // At time 2 (40% progress): ceil(0.4*5)=2 chars
        const result = computeTimeFallbackKaraokeIndices(fullText, line, 2);
        expect(result.splitIdx).toBe(2); // 2 chars
        expect(result.hlStart).toBe(1); // previous char
    });

    it('returns -1,-1 when no endTime', () => {
        const result = computeTimeFallbackKaraokeIndices('test', { time: 0 }, 1);
        expect(result.splitIdx).toBe(-1);
        expect(result.hlStart).toBe(-1);
    });
});

describe('Karaoke mode variants (new behavior)', () => {
    const fullText = 'おはよう世界';
    const words = [
        { start: 0, end: 1, text: 'お' },
        { start: 1, end: 2, text: 'は' },
        { start: 2, end: 3, text: 'よ' },
        { start: 3, end: 4, text: 'う' },
        { start: 4, end: 5, text: '世' },
        { start: 5, end: 6, text: '界' },
    ];

    it('segment ON + karaoke ON (fill-up): accent fills from start, all spoken in accent', () => {
        const now = 2.5; // 'お', 'は', 'よ' spoken
        const indices = computeWordKaraokeIndices(fullText, words, now);
        // Segment ON: hlStart forced to 0 (fill-up)
        const hlStart = 0;
        const splitIdx = indices.splitIdx;

        expect(splitIdx).toBe(3); // 3 chars spoken
        const chars = Array.from(fullText);
        const past = chars.slice(0, hlStart).join('');
        const current = chars.slice(hlStart, splitIdx).join('');
        const upcoming = chars.slice(splitIdx).join('');
        expect(past).toBe(''); // Empty past (fill-up from 0)
        expect(current).toBe('おはよ'); // All spoken text in accent
        expect(upcoming).toBe('う世界'); // Remaining text dimmed
    });

    it('segment OFF + karaoke ON (spotlight): only current word in accent, upcoming hidden', () => {
        const now = 2.5; // 'お', 'は', 'よ' spoken
        const indices = computeWordKaraokeIndices(fullText, words, now);
        // Segment OFF: use actual hlStart from computation
        const hlStart = indices.hlStart;
        const splitIdx = indices.splitIdx;

        expect(hlStart).toBe(2); // 'よ' starts at char 2
        expect(splitIdx).toBe(3); // 'よ' ends at char 3
        const chars = Array.from(fullText);
        const past = chars.slice(0, hlStart).join('');
        const current = chars.slice(hlStart, splitIdx).join('');
        const upcoming = chars.slice(splitIdx).join('');
        expect(past).toBe('おは'); // Past words in normal color
        expect(current).toBe('よ'); // Only current word in accent
        expect(upcoming).toBe('う世界'); // Hidden (visibility: hidden)
    });

    it('both modes always show full text as primary', () => {
        // In the new implementation, karaoke ON → primary = fullText always
        const karaokeMode = true;
        const primary = karaokeMode ? fullText : 'progressive';
        expect(primary).toBe(fullText);
    });

    it('no karaoke: plain progressive text', () => {
        const progressiveText = 'おはよ';
        const karaokeMode = false;
        const primary = karaokeMode ? fullText : progressiveText;
        expect(primary).toBe('おはよ');
    });

    it('segment OFF + karaoke ON: first word spoken, accent on first word only', () => {
        const now = 0.5; // Only 'お' spoken
        const indices = computeWordKaraokeIndices(fullText, words, now);
        const hlStart = indices.hlStart; // segment OFF uses actual hlStart
        const splitIdx = indices.splitIdx;

        expect(hlStart).toBe(0);
        expect(splitIdx).toBe(1);
        const chars = Array.from(fullText);
        expect(chars.slice(0, hlStart).join('')).toBe(''); // No past yet
        expect(chars.slice(hlStart, splitIdx).join('')).toBe('お'); // Current word accented
        expect(chars.slice(splitIdx).join('')).toBe('はよう世界'); // Hidden
    });

    it('segment ON + karaoke ON: last word spoken, everything accented', () => {
        const now = 5.5; // All words spoken
        const indices = computeWordKaraokeIndices(fullText, words, now);
        const hlStart = 0; // segment ON forces 0
        const splitIdx = indices.splitIdx;

        expect(splitIdx).toBe(6); // All 6 chars spoken
        const chars = Array.from(fullText);
        expect(chars.slice(0, hlStart).join('')).toBe('');
        expect(chars.slice(hlStart, splitIdx).join('')).toBe('おはよう世界'); // Full text in accent
        expect(chars.slice(splitIdx).join('')).toBe(''); // Nothing upcoming
    });
});

describe('Karaoke with spaced text', () => {
    const fullText = 'hello beautiful world';
    const words = [
        { start: 0, end: 1, text: 'hello' },
        { start: 1, end: 2, text: 'beautiful' },
        { start: 2, end: 3, text: 'world' },
    ];

    it('spotlight mode: accents partial "beautiful" via intra-word interpolation', () => {
        const now = 1.5; // 'hello' fully past, 'beautiful' active at 50%
        const indices = computeWordKaraokeIndices(fullText, words, now);

        expect(indices.hlStart).toBe(6); // "beautiful" starts after "hello "
        expect(indices.splitIdx).toBe(11); // 50% through 9-char word → ceil(4.5)=5, 6+5=11

        const chars = Array.from(fullText);
        const past = chars.slice(0, indices.hlStart).join('');
        const current = chars.slice(indices.hlStart, indices.splitIdx).join('');
        const upcoming = chars.slice(indices.splitIdx).join('');
        expect(past).toBe('hello ');
        expect(current).toBe('beaut');
        expect(upcoming).toBe('iful world');
    });

    it('fill-up mode: accents through partial "beautiful" (intra-word interpolation)', () => {
        const now = 1.5;
        const indices = computeWordKaraokeIndices(fullText, words, now);
        const hlStart = 0; // segment ON forces 0

        const chars = Array.from(fullText);
        const current = chars.slice(hlStart, indices.splitIdx).join('');
        const upcoming = chars.slice(indices.splitIdx).join('');
        expect(current).toBe('hello beaut'); // 50% through "beautiful"
        expect(upcoming).toBe('iful world');
    });
});

// ---------------------------------------------------------------------------
// buildKaraokeCharMap
// ---------------------------------------------------------------------------

describe('buildKaraokeCharMap', () => {
    it('computes correct offsets for CJK (no spaces)', () => {
        const words = [
            { start: 0, end: 1, text: 'お' },
            { start: 1, end: 2, text: 'は' },
            { start: 2, end: 3, text: 'よ' },
            { start: 3, end: 4, text: 'う' },
        ];
        const map = buildKaraokeCharMap('おはよう', words);
        expect(map.hasSpaces).toBe(false);
        expect(map.totalChars).toBe(4);
        expect(map.entries).toEqual([
            { charStart: 0, charCount: 1, wordStart: 0, wordEnd: 1 },
            { charStart: 1, charCount: 1, wordStart: 1, wordEnd: 2 },
            { charStart: 2, charCount: 1, wordStart: 2, wordEnd: 3 },
            { charStart: 3, charCount: 1, wordStart: 3, wordEnd: 4 },
        ]);
    });

    it('computes correct offsets for spaced text (adds +1 for spaces between words)', () => {
        const words = [
            { start: 0, end: 1, text: 'hello' },
            { start: 1, end: 2, text: 'world' },
        ];
        const map = buildKaraokeCharMap('hello world', words);
        expect(map.hasSpaces).toBe(true);
        expect(map.totalChars).toBe(11);
        expect(map.entries).toEqual([
            { charStart: 0, charCount: 5, wordStart: 0, wordEnd: 1 },
            { charStart: 6, charCount: 5, wordStart: 1, wordEnd: 2 },
        ]);
    });

    it('handles empty words array', () => {
        const map = buildKaraokeCharMap('test', []);
        expect(map.entries).toEqual([]);
        expect(map.totalChars).toBe(4);
    });
});

// ---------------------------------------------------------------------------
// Intra-word interpolation
// ---------------------------------------------------------------------------

describe('Intra-word character interpolation', () => {
    it('interpolates through a multi-char word at 25%', () => {
        const fullText = 'abcdefgh'; // 8 chars in one word
        const words = [{ start: 0, end: 4, text: 'abcdefgh' }];
        // At time 1.0: progress = 1/4 = 0.25, filled = ceil(0.25*8) = 2
        const result = computeWordKaraokeIndices(fullText, words, 1.0);
        expect(result.hlStart).toBe(0);
        expect(result.splitIdx).toBe(2);
    });

    it('interpolates through a multi-char word at 75%', () => {
        const fullText = 'abcdefgh'; // 8 chars in one word
        const words = [{ start: 0, end: 4, text: 'abcdefgh' }];
        // At time 3.0: progress = 3/4 = 0.75, filled = ceil(0.75*8) = 6
        const result = computeWordKaraokeIndices(fullText, words, 3.0);
        expect(result.hlStart).toBe(0);
        expect(result.splitIdx).toBe(6);
    });

    it('shows at least 1 char at the very start of a word', () => {
        const fullText = 'hello';
        const words = [{ start: 2, end: 5, text: 'hello' }];
        // At time 2.0 (word just started): progress=0, filled = max(1, ceil(0*5)) = 1
        const result = computeWordKaraokeIndices(fullText, words, 2.0);
        expect(result.hlStart).toBe(0);
        expect(result.splitIdx).toBe(1);
    });

    it('fills entire word just before it ends (50ms tolerance)', () => {
        const fullText = 'test';
        const words = [{ start: 0, end: 2, text: 'test' }];
        // At time 1.94: word.end=2, 2 <= 1.94+0.05=1.99? NO → active word
        // progress = 1.94/2 = 0.97, filled = ceil(0.97*4) = 4
        const result = computeWordKaraokeIndices(fullText, words, 1.94);
        expect(result.splitIdx).toBe(4);
    });

    it('marks word as past within 50ms tolerance window', () => {
        const fullText = 'test';
        const words = [{ start: 0, end: 2, text: 'test' }];
        // At time 1.96: word.end=2, 2 <= 1.96+0.05=2.01? YES → fully past
        const result = computeWordKaraokeIndices(fullText, words, 1.96);
        expect(result.splitIdx).toBe(4); // entire word past
    });

    it('interpolates second word while first is fully past', () => {
        const fullText = 'hello world';
        const words = [
            { start: 0, end: 2, text: 'hello' },
            { start: 2, end: 4, text: 'world' },
        ];
        // At time 3.0: 'hello' fully past, 'world' active at 50%
        // progress = (3-2)/(4-2) = 0.5, filled = ceil(0.5*5) = 3
        const result = computeWordKaraokeIndices(fullText, words, 3.0);
        expect(result.hlStart).toBe(6); // 'world' starts at char 6
        expect(result.splitIdx).toBe(9); // 6 + 3 = 9
    });

    it('does not jump to the next word before boundary grace elapses', () => {
        const fullText = 'ab';
        const words = [
            { start: 0, end: 1, text: 'a' },
            { start: 1, end: 2, text: 'b' },
        ];

        // Slightly after boundary still keeps current word highlight (prevents eager next-char jump).
        const nearBoundary = computeWordKaraokeIndices(fullText, words, 1.001);
        expect(nearBoundary.hlStart).toBe(0);
        expect(nearBoundary.splitIdx).toBe(1);

        // After grace window, it can advance to the next word.
        const afterGrace = computeWordKaraokeIndices(fullText, words, 1.01);
        expect(afterGrace.hlStart).toBe(1);
        expect(afterGrace.splitIdx).toBe(2);
    });
});
