import { describe, expect, it } from 'vitest';
import {
    isPostBaselineRelease,
    isValidSemanticReleaseDate,
    pageIsAtOrBeforeBaselineCutoff,
    postBaselineWorks,
} from '../../src/features/vectorSearchDeltaPolicy';

describe('semantic search delta cutoff', () => {
    it('indexes only valid dates strictly later than the inclusive baseline cutoff', () => {
        expect(isPostBaselineRelease('2026-07-14')).toBe(false);
        expect(isPostBaselineRelease('2026-07-15')).toBe(true);
        expect(isPostBaselineRelease('2027-01-01')).toBe(true);
        expect(isPostBaselineRelease('2026-02-30')).toBe(false);
        expect(isPostBaselineRelease('14/07/2026')).toBe(false);
        expect(isPostBaselineRelease(undefined)).toBe(false);
        expect(isValidSemanticReleaseDate('2024-02-29')).toBe(true);
    });

    it('does not stop a scan on pages containing unknown release dates', () => {
        expect(pageIsAtOrBeforeBaselineCutoff([
            { release: '2026-07-14' }, { release: '2026-07-13' },
        ])).toBe(true);
        expect(pageIsAtOrBeforeBaselineCutoff([
            { release: '2026-07-13' }, { release: undefined },
        ])).toBe(false);
        expect(pageIsAtOrBeforeBaselineCutoff([])).toBe(false);
    });

    it('filters a mixed API page without inferring age from IDs', () => {
        const works = [
            { id: 1, release: '2026-07-15' },
            { id: 999999, release: '2026-07-14' },
            { id: 2, release: 'invalid' },
        ];
        expect(postBaselineWorks(works).map((work) => work.id)).toEqual([1]);
    });
});

