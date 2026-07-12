import { describe, expect, it } from 'vitest';
import {
    finiteWorkMetric,
    normalizeInfiniteScrollRjCode,
    resolveInfiniteScrollCoverUrl,
} from '../../src/features/infiniteScrollCardUtils';

describe('infiniteScrollCardUtils', () => {
    it('accepts only numeric RJ work identifiers', () => {
        expect(normalizeInfiniteScrollRjCode('RJ01052162')).toBe('RJ01052162');
        expect(normalizeInfiniteScrollRjCode(1052162)).toBe('RJ1052162');
        expect(normalizeInfiniteScrollRjCode('bad" onmouseover="alert(1)', 'RJ01409932'))
            .toBe('RJ01409932');
        expect(normalizeInfiniteScrollRjCode('RJ1"><img src=x onerror=alert(1)>')).toBe('');
    });

    it('rejects executable cover schemes and malformed attribute payloads', () => {
        const fallback = '/api/cover/1052162.jpg?type=main';
        expect(resolveInfiniteScrollCoverUrl('javascript:alert(1)', 'RJ1052162')).toBe(fallback);
        expect(resolveInfiniteScrollCoverUrl('data:image/svg+xml,<svg onload=alert(1)>', 'RJ1052162')).toBe(fallback);
        expect(resolveInfiniteScrollCoverUrl('x" onerror="alert(1)', 'RJ1052162')).toBe(fallback);
        expect(resolveInfiniteScrollCoverUrl('/api/cover/1052162.jpg', 'RJ1052162', 'https://asmr.one/work/x'))
            .toBe('https://asmr.one/api/cover/1052162.jpg');
    });

    it('normalizes non-finite runtime metrics', () => {
        expect(finiteWorkMetric('12')).toBe(12);
        expect(finiteWorkMetric('12"><script>alert(1)</script>')).toBe(0);
        expect(finiteWorkMetric(Number.POSITIVE_INFINITY)).toBe(0);
    });
});
