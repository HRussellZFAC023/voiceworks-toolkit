import { describe, expect, it } from 'vitest';
import {
    getFallbackSortOptions,
    parseStoredSortOption,
    resolveSortOrder,
    resolveSortSelection,
    type SortOption,
} from '../../src/features/advancedSearchSortUtils';
import type { WorkOrder } from '../../src/types/api';

const t = (key: string): string => `i18n:${key}`;

describe('advancedSearchSortUtils', () => {
    describe('resolveSortOrder', () => {
        it('keeps known orders unchanged', () => {
            const options = [{ order: 'release' }, { order: 'insert_time' }];
            expect(resolveSortOrder('release', options)).toBe('release');
        });

        it('maps create_date to insert_time when needed', () => {
            const options = [{ order: 'insert_time' }];
            expect(resolveSortOrder('create_date', options)).toBe('insert_time');
        });

        it('maps insert_time to create_date when needed', () => {
            const options = [{ order: 'create_date' }];
            expect(resolveSortOrder('insert_time', options)).toBe('create_date');
        });
    });

    describe('resolveSortSelection', () => {
        it('uses exact host option label when available', () => {
            const hostOptions: SortOption[] = [
                { label: 'works.releaseDesc', order: 'release', sort: 'desc' },
                { label: 'works.releaseAsc', order: 'release', sort: 'asc' },
            ];
            const resolved = resolveSortSelection('release', 'asc', hostOptions, t);
            expect(resolved).toEqual({
                order: 'release',
                sort: 'asc',
                label: 'works.releaseAsc',
            });
        });

        it('falls back to translated fallback labels when host options are absent', () => {
            const resolved = resolveSortSelection('insert_time', 'desc', [], t);
            expect(resolved.order).toBe('insert_time');
            expect(resolved.sort).toBe('desc');
            expect(resolved.label).toBe('i18n:sortNewest');
        });

        it('normalizes order aliases against available options', () => {
            const hostOptions: SortOption[] = [
                { label: 'works.new', order: 'create_date', sort: 'desc' },
            ];
            const resolved = resolveSortSelection('insert_time' as WorkOrder, 'desc', hostOptions, t);
            expect(resolved.order).toBe('create_date');
            expect(resolved.label).toBe('works.new');
        });
    });

    describe('parseStoredSortOption', () => {
        it('parses valid stored sort options', () => {
            const stored = JSON.stringify({ order: 'rating', sort: 'asc' });
            expect(parseStoredSortOption(stored)).toEqual({ order: 'rating', sort: 'asc' });
        });

        it('rejects malformed or invalid stored sort options', () => {
            expect(parseStoredSortOption(null)).toBeNull();
            expect(parseStoredSortOption('{not-json')).toBeNull();
            expect(parseStoredSortOption(JSON.stringify({ order: 'rating' }))).toBeNull();
            expect(parseStoredSortOption(JSON.stringify({ order: 'rating', sort: 'up' }))).toBeNull();
        });
    });

    describe('getFallbackSortOptions', () => {
        it('provides translated fallback options', () => {
            const options = getFallbackSortOptions(t);
            expect(options.length).toBeGreaterThan(0);
            expect(options[0]).toEqual({ order: 'insert_time', label: 'i18n:sortNewest' });
        });
    });
});
