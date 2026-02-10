import { describe, expect, it } from 'vitest';
import {
    extractEmbeddedRjCode,
    extractPrimaryRjCode,
    extractRjCodeFromText,
    normalizeRjCode,
    toRjNumericId,
} from '../../src/features/rjCodeUtils';

describe('rjCodeUtils', () => {
    describe('normalizeRjCode', () => {
        it('normalizes exact RJ and numeric values', () => {
            expect(normalizeRjCode('rj123456')).toBe('RJ123456');
            expect(normalizeRjCode('01234567')).toBe('RJ01234567');
        });

        it('rejects non-exact mixed strings', () => {
            expect(normalizeRjCode('work-RJ123456')).toBe('');
            expect(normalizeRjCode('id=123456')).toBe('');
        });
    });

    describe('extractors', () => {
        it('extracts embedded RJ tokens', () => {
            expect(extractEmbeddedRjCode('foo RJ765432 bar')).toBe('RJ765432');
            expect(extractEmbeddedRjCode('no code')).toBeNull();
        });

        it('extracts RJ or numeric tokens from mixed text', () => {
            expect(extractRjCodeFromText('work-RJ111111')).toBe('RJ111111');
            expect(extractRjCodeFromText('work-222222')).toBe('RJ222222');
        });
    });

    describe('extractPrimaryRjCode', () => {
        it('uses source first, then work id, then title', () => {
            expect(extractPrimaryRjCode({
                sourceId: 'RJ333333',
                workId: 'RJ444444',
                title: 'RJ555555',
            })).toBe('RJ333333');

            expect(extractPrimaryRjCode({
                sourceId: 'invalid',
                workId: 'work-444444',
                title: 'Title RJ555555',
            })).toBe('RJ444444');

            expect(extractPrimaryRjCode({
                sourceId: 'invalid',
                workId: 'invalid',
                title: 'Title RJ555555',
            })).toBe('RJ555555');
        });

        it('supports optional numeric title extraction', () => {
            expect(extractPrimaryRjCode({
                sourceId: 'invalid',
                workId: 'invalid',
                title: 'Title 666666',
                allowTitleNumeric: false,
            })).toBeNull();

            expect(extractPrimaryRjCode({
                sourceId: 'invalid',
                workId: 'invalid',
                title: 'Title 666666',
                allowTitleNumeric: true,
            })).toBe('RJ666666');
        });
    });

    describe('toRjNumericId', () => {
        it('extracts numeric id from any supported RJ input', () => {
            expect(toRjNumericId('RJ777777')).toBe('777777');
            expect(toRjNumericId('work-RJ888888')).toBe('888888');
            expect(toRjNumericId('999999')).toBe('999999');
            expect(toRjNumericId('invalid')).toBeNull();
        });
    });
});
