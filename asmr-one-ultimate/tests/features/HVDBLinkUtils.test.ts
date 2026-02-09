import { describe, expect, it } from 'vitest';
import { extractRjCode, buildHvdbUrl, buildChobitUrl } from '../../src/features/hvdbLinkUtils';

describe('hvdbLinkUtils', () => {
    describe('extractRjCode', () => {
        it('prefers source_id when already RJ format', () => {
            const code = extractRjCode({ source_id: 'RJ123456' }, 'RJ999999');
            expect(code).toBe('RJ123456');
        });

        it('normalizes numeric source_id to RJ format', () => {
            const code = extractRjCode({ sourceId: '01234567' }, null);
            expect(code).toBe('RJ01234567');
        });

        it('falls back to workId when source_id is missing', () => {
            const code = extractRjCode({}, 7654321);
            expect(code).toBe('RJ7654321');
        });

        it('returns empty string for invalid inputs', () => {
            const code = extractRjCode({ source_id: 'abc' }, 'work-1');
            expect(code).toBe('');
        });
    });

    describe('buildHvdbUrl', () => {
        it('builds hvdb URL from RJ code', () => {
            expect(buildHvdbUrl('RJ123456')).toBe('https://hvdb.me/Dashboard/Add?id=123456');
        });

        it('accepts numeric work code and normalizes', () => {
            expect(buildHvdbUrl('12345678')).toBe('https://hvdb.me/Dashboard/Add?id=12345678');
        });

        it('returns empty string for invalid code', () => {
            expect(buildHvdbUrl('invalid')).toBe('');
        });
    });

    describe('buildChobitUrl', () => {
        it('builds chobit URL with normalized RJ code', () => {
            expect(buildChobitUrl('123456')).toBe('https://chobit.cc/s/?f_category=all&q_keyword=RJ123456');
        });
    });
});

