import { describe, expect, it } from 'vitest';
import { splitSubtitleSegments } from '../../src/features/subtitleSegmentSplitter';

const countChars = (s: string) => Array.from(s).length;

describe('splitSubtitleSegments', () => {
    it('keeps short lines unchanged', () => {
        const lines = [{ time: 0, endTime: 2, text: 'short subtitle' }];
        const out = splitSubtitleSegments(lines);
        expect(out).toEqual(lines);
    });

    it('splits oversized CJK single-word segments from whisper words', () => {
        const long = 'あ'.repeat(96);
        const out = splitSubtitleSegments([{
            time: 10,
            endTime: 22,
            text: long,
            words: [{ start: 10, end: 22, text: long }],
        }]);

        expect(out.length).toBeGreaterThan(1);
        for (const seg of out) {
            expect(seg.text.trim().length).toBeGreaterThan(0);
            expect(countChars(seg.text)).toBeLessThanOrEqual(48);
        }

        expect(out[0].time).toBe(10);
        expect(out[out.length - 1].endTime).toBeCloseTo(22, 5);
        for (let i = 1; i < out.length; i++) {
            expect(out[i].time).toBeGreaterThanOrEqual(out[i - 1].time);
        }
    });

    it('splits long no-word lines and prefers punctuation boundaries', () => {
        const text = 'First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence. Sixth sentence.';
        const out = splitSubtitleSegments([{ time: 0, endTime: 8, text }]);

        expect(out.length).toBeGreaterThan(1);
        expect(out[0].text.endsWith('.')).toBe(true);
        for (const seg of out) {
            expect(seg.text.trim().length).toBeGreaterThan(0);
            expect(countChars(seg.text)).toBeLessThanOrEqual(70);
        }
    });

    it('keeps trailing closers with preceding punctuation when splitting', () => {
        const text = 'He keeps laughing). Then keeps talking). Then keeps laughing). Then keeps talking). End.';
        const out = splitSubtitleSegments([{ time: 0, endTime: 12, text }]);
        expect(out.length).toBeGreaterThan(1);

        for (let i = 1; i < out.length; i++) {
            const t = out[i].text.trim();
            expect(t.startsWith(')')).toBe(false);
            expect(t.startsWith('"')).toBe(false);
            expect(t.startsWith('”')).toBe(false);
        }

        const merged = out.map(s => s.text).join(' ');
        expect(merged.replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''));
    });

    it('falls back to raw-text splitting when word tokens are lossy', () => {
        const text = 'He said \"hello\" (laughing). Then left after saying \"bye\" (smiling).';
        const out = splitSubtitleSegments([{
            time: 10,
            endTime: 20,
            text,
            // Intentionally lossy tokens (missing punctuation/quotes/brackets)
            words: [
                { start: 10, end: 11, text: 'He' },
                { start: 11, end: 12, text: 'said' },
                { start: 12, end: 13, text: 'hello' },
                { start: 13, end: 14, text: 'laughing' },
                { start: 14, end: 15, text: 'Then' },
                { start: 15, end: 16, text: 'left' },
                { start: 16, end: 17, text: 'after' },
                { start: 17, end: 18, text: 'saying' },
                { start: 18, end: 19, text: 'bye' },
                { start: 19, end: 20, text: 'smiling' },
            ],
        }]);

        expect(out.length).toBeGreaterThan(0);
        const merged = out.map(s => s.text).join(' ');
        expect(merged.replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''));
        expect(merged.includes('(\"')).toBe(false); // sanity: no odd synthetic artifacts
    });

    it('does not split oversized lines when duration is unknown (avoids hidden zero-duration chunks)', () => {
        const long = 'a'.repeat(120);
        const out = splitSubtitleSegments([{ time: 5, text: long }]);
        expect(out).toHaveLength(1);
        expect(out[0].text).toBe(long);
        expect(out[0].time).toBe(5);
        expect(out[0].endTime).toBeUndefined();
    });
});
