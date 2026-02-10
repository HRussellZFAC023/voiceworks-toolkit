import { describe, expect, it } from 'vitest';
import {
    arraysEqual,
    getRouteKey,
    getSegmentsFromRoute,
    getWorkIdFromRoute,
    hasExplicitPath,
    normalizeQuery,
} from '../../src/features/workTreeManagerUtils';

describe('workTreeManagerUtils', () => {
    it('compares array equality correctly', () => {
        expect(arraysEqual([], [])).toBe(true);
        expect(arraysEqual(['a'], ['a'])).toBe(true);
        expect(arraysEqual(['a'], ['b'])).toBe(false);
        expect(arraysEqual(['a', 'b'], ['a'])).toBe(false);
    });

    it('extracts work id from params or path', () => {
        expect(getWorkIdFromRoute({ params: { id: 'RJ123' } })).toBe('RJ123');
        expect(getWorkIdFromRoute({ path: '/work/RJ0001?foo=1' })).toBe('RJ0001');
        expect(getWorkIdFromRoute({ path: '/settings' })).toBeNull();
    });

    it('parses path segments from route query', () => {
        expect(getSegmentsFromRoute({ query: { path: ['A', 'B'] } as any })).toEqual(['A', 'B']);
        expect(getSegmentsFromRoute({ query: { path: '["A","B"]' } as any })).toEqual(['A', 'B']);
        expect(getSegmentsFromRoute({ query: { path: 'bad-json' } as any })).toEqual([]);
        expect(getSegmentsFromRoute({ query: {} as any })).toEqual([]);
    });

    it('normalizes query deterministically', () => {
        const a = normalizeQuery({ b: 2, a: 1 });
        const b = normalizeQuery({ a: 1, b: 2 });
        expect(a).toBe(b);
        expect(a).toContain('"a"');
        expect(a).toContain('"b"');
    });

    it('builds route keys from fullPath or sorted query', () => {
        expect(getRouteKey({ fullPath: '/work/RJ1?z=1#foo' })).toBe('/work/RJ1?z=1');
        const keyA = getRouteKey({ path: '/work/RJ1', query: { z: '1', a: '2' } });
        const keyB = getRouteKey({ path: '/work/RJ1', query: { a: '2', z: '1' } });
        expect(keyA).toBe(keyB);
    });

    it('detects explicit path query key', () => {
        expect(hasExplicitPath({ query: { path: '[]' } })).toBe(true);
        expect(hasExplicitPath({ query: { foo: 'bar' } })).toBe(false);
        expect(hasExplicitPath(undefined)).toBe(false);
    });
});
