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
});
