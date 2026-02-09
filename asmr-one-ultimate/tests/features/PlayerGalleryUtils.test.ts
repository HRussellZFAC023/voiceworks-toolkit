import { describe, it, expect } from 'vitest';
import { normalizeWorkId, parseWorkIdFromCoverUrl } from '../../src/features/playerGalleryUtils';

describe('playerGalleryUtils', () => {
    describe('normalizeWorkId', () => {
        it('normalizes numeric strings', () => {
            expect(normalizeWorkId('1052162')).toBe('1052162');
        });

        it('normalizes RJ-prefixed ids', () => {
            expect(normalizeWorkId('RJ01052162')).toBe('1052162');
            expect(normalizeWorkId('rj000123')).toBe('123');
        });

        it('rejects invalid values', () => {
            expect(normalizeWorkId('')).toBeNull();
            expect(normalizeWorkId('RJ')).toBeNull();
            expect(normalizeWorkId('abc')).toBeNull();
            expect(normalizeWorkId('0')).toBeNull();
            expect(normalizeWorkId(undefined)).toBeNull();
        });
    });

    describe('parseWorkIdFromCoverUrl', () => {
        it('parses numeric cover urls', () => {
            expect(parseWorkIdFromCoverUrl('/api/cover/1052162.jpg?type=main')).toBe('1052162');
            expect(parseWorkIdFromCoverUrl('https://api.asmr.one/api/cover/1052162.jpg')).toBe('1052162');
        });

        it('parses RJ cover urls and normalizes', () => {
            expect(parseWorkIdFromCoverUrl('/api/cover/RJ01052162.jpg?type=main')).toBe('1052162');
        });

        it('returns null for non-cover urls', () => {
            expect(parseWorkIdFromCoverUrl('/api/work/1052162')).toBeNull();
            expect(parseWorkIdFromCoverUrl('')).toBeNull();
        });
    });
});
