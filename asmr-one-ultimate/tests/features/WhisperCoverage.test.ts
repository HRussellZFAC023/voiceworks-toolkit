import { describe, expect, it } from 'vitest';
import {
    addWhisperCoverage,
    getWhisperContiguousEnd,
    getWhisperCoverageEnd,
    getWhisperCoveredSeconds,
    normalizeWhisperCoverage,
    subtractWhisperCoverage,
    summarizeWhisperCoverage,
} from '../../src/features/whisperCoverage';

describe('whisperCoverage', () => {
    it('normalizes, sorts, and merges overlapping or adjacent ranges', () => {
        expect(normalizeWhisperCoverage([
            { start: 10, end: 20 },
            { start: 0, end: 8 },
            { start: 7.995, end: 12 },
            { start: 30, end: 30 },
            { start: Number.NaN, end: 40 },
        ])).toEqual([{ start: 0, end: 20 }]);
    });

    it('counts actual analyzed duration rather than the furthest timeline cursor', () => {
        const ranges = addWhisperCoverage(
            [{ start: 0, end: 20 }],
            70,
            80,
        );

        expect(getWhisperCoveredSeconds(ranges)).toBe(30);
        expect(getWhisperCoverageEnd(ranges)).toBe(80);
        expect(getWhisperContiguousEnd(ranges)).toBe(20);
    });

    it('supports live capture that intentionally starts partway through a track', () => {
        const ranges = [{ start: 120, end: 126 }];

        expect(getWhisperCoveredSeconds(ranges)).toBe(6);
        expect(getWhisperContiguousEnd(ranges, 120)).toBe(126);
        expect(summarizeWhisperCoverage({
            origin: 120,
            processed: ranges,
            unavailable: [],
        }, 128, 360)).toMatchObject({
            processedSeconds: 6,
            processedThroughSeconds: 126,
            resumeFromSeconds: 0,
            sessionResumeFromSeconds: 126,
            backlogSeconds: 2,
            complete: false,
        });
    });

    it('accepts the browser first-frame offset without hiding later gaps', () => {
        const summary = summarizeWhisperCoverage({
            origin: 0,
            processed: [{ start: 0.08, end: 20 }],
            unavailable: [],
        }, 20, 20);
        expect(summary).toMatchObject({
            resumeFromSeconds: 20,
            complete: true,
        });
        expect(summary.missingSeconds).toBeCloseTo(0.08, 8);

        expect(summarizeWhisperCoverage({
            origin: 0,
            processed: [
                { start: 0.08, end: 10 },
                { start: 10.2, end: 20 },
            ],
            unavailable: [],
        }, 20, 20)).toMatchObject({
            resumeFromSeconds: 10,
            complete: false,
        });
    });

    it('does not forgive a material missing prefix', () => {
        expect(summarizeWhisperCoverage({
            origin: 0,
            processed: [{ start: 0.6, end: 20 }],
            unavailable: [],
        }, 20, 20)).toMatchObject({
            resumeFromSeconds: 0,
            complete: false,
        });
    });

    it('uses explicit unavailable ranges only for current-run accounting', () => {
        expect(summarizeWhisperCoverage({
            origin: 0,
            processed: [{ start: 0, end: 20 }],
            unavailable: [{ start: 20, end: 100 }],
        }, 100, 200)).toMatchObject({
            processedSeconds: 20,
            resumeFromSeconds: 20,
            accountedThroughSeconds: 100,
            skippedSeconds: 80,
            backlogSeconds: 0,
            complete: false,
        });
    });

    it('removes unavailable time once that range is successfully analyzed', () => {
        expect(subtractWhisperCoverage(
            [{ start: 20, end: 100 }],
            40,
            80,
        )).toEqual([
            { start: 20, end: 40 },
            { start: 80, end: 100 },
        ]);

        expect(summarizeWhisperCoverage({
            origin: 0,
            processed: [{ start: 0, end: 100 }],
            unavailable: [{ start: 20, end: 100 }],
        }, 100, 100)).toMatchObject({
            processedSeconds: 100,
            skippedSeconds: 0,
            complete: true,
        });
    });
});
