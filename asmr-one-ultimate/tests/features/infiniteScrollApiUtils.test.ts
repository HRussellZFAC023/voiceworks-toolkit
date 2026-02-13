import { describe, expect, it } from 'vitest';
import { buildInfiniteScrollApiUrl, pickFirstQueryValue } from '../../src/features/infiniteScrollApiUtils';

function parseRelativeUrl(url: string): URL {
    return new URL(url, 'https://example.test');
}

describe('infiniteScrollApiUtils', () => {
    describe('pickFirstQueryValue', () => {
        it('returns first non-empty value from arrays', () => {
            expect(pickFirstQueryValue(['', '  ', 'foo', 'bar'])).toBe('foo');
        });

        it('preserves zero-like values', () => {
            expect(pickFirstQueryValue('0')).toBe('0');
            expect(pickFirstQueryValue(0)).toBe('0');
            expect(pickFirstQueryValue(false)).toBe('false');
        });
    });

    describe('buildInfiniteScrollApiUrl', () => {
        it('builds works URL with defaults and keeps zero-like filters', () => {
            const url = buildInfiniteScrollApiUrl({
                path: '/works',
                page: 2,
                pageSize: 20,
                query: {
                    order: '',
                    sort: undefined,
                    subtitle: ['1'],
                    seed: ['', 'abc-seed'],
                    page: '99',
                    minPrice: '0',
                },
            });

            expect(url).not.toBeNull();
            const parsed = parseRelativeUrl(url!);
            expect(parsed.pathname).toBe('/api/works');
            expect(parsed.searchParams.get('page')).toBe('2');
            expect(parsed.searchParams.get('order')).toBe('release');
            expect(parsed.searchParams.get('sort')).toBe('desc');
            expect(parsed.searchParams.get('subtitle')).toBe('1');
            expect(parsed.searchParams.get('seed')).toBe('abc-seed');
            expect(parsed.searchParams.get('minPrice')).toBe('0');
        });

        it('routes /works with keyword to /api/search/<keyword>', () => {
            const url = buildInfiniteScrollApiUrl({
                path: '/works',
                page: 3,
                pageSize: 20,
                query: {
                    keyword: 'ear cleaning',
                    subtitle: ['1'],
                },
            });

            expect(url).not.toBeNull();
            const parsed = parseRelativeUrl(url!);
            expect(parsed.pathname).toBe('/api/search/ear%20cleaning');
            expect(parsed.searchParams.get('page')).toBe('3');
            expect(parsed.searchParams.get('subtitle')).toBe('1');
            expect(parsed.searchParams.has('keyword')).toBe(false);
        });

        it('builds search URL and ignores incoming page query', () => {
            const url = buildInfiniteScrollApiUrl({
                path: '/search',
                page: 4,
                pageSize: 20,
                query: {
                    keyword: ['voice', 'ignored'],
                    page: '1',
                    subtitle: '0',
                },
            });

            expect(url).not.toBeNull();
            const parsed = parseRelativeUrl(url!);
            expect(parsed.pathname).toBe('/api/search');
            expect(parsed.searchParams.get('page')).toBe('4');
            expect(parsed.searchParams.get('keyword')).toBe('voice');
            expect(parsed.searchParams.get('subtitle')).toBe('0');
        });

        it('builds entity URLs for circle/tag/va paths', () => {
            expect(buildInfiniteScrollApiUrl({
                path: '/circle/12345/',
                page: 3,
                pageSize: 20,
                query: {},
            })).toBe('/api/circles/12345/works?page=3');

            expect(buildInfiniteScrollApiUrl({
                path: '/tag/10',
                page: 5,
                pageSize: 20,
                query: {},
            })).toBe('/api/tags/10/works?page=5');

            expect(buildInfiniteScrollApiUrl({
                path: '/va/777',
                page: 2,
                pageSize: 20,
                query: {},
            })).toBe('/api/vas/777/works?page=2');
        });

        it('builds playlist URL from query id', () => {
            const url = buildInfiniteScrollApiUrl({
                path: '/playlist',
                page: 6,
                pageSize: 100,
                query: {
                    id: ['', 'playlist-1'],
                },
            });

            expect(url).toBe('/api/playlist/get-playlist-works?id=playlist-1&page=6&pageSize=100');
        });

        it('returns null for playlist route without id', () => {
            const url = buildInfiniteScrollApiUrl({
                path: '/playlist',
                page: 1,
                pageSize: 100,
                query: {},
            });
            expect(url).toBeNull();
        });

        it('builds review URL with filter and sort params', () => {
            const url = buildInfiniteScrollApiUrl({
                path: '/review',
                page: 2,
                pageSize: 20,
                query: {
                    order: 'updated_at',
                    sort: 'desc',
                    filter: 'postponed',
                },
            });

            expect(url).not.toBeNull();
            const parsed = parseRelativeUrl(url!);
            expect(parsed.pathname).toBe('/api/review');
            expect(parsed.searchParams.get('page')).toBe('2');
            expect(parsed.searchParams.get('order')).toBe('updated_at');
            expect(parsed.searchParams.get('sort')).toBe('desc');
            expect(parsed.searchParams.get('filter')).toBe('postponed');
        });

        it('builds review URL without optional params', () => {
            const url = buildInfiniteScrollApiUrl({
                path: '/review',
                page: 1,
                pageSize: 20,
                query: {},
            });

            expect(url).not.toBeNull();
            const parsed = parseRelativeUrl(url!);
            expect(parsed.pathname).toBe('/api/review');
            expect(parsed.searchParams.get('page')).toBe('1');
            expect(parsed.searchParams.has('filter')).toBe(false);
        });

        it('returns null for unsupported paths', () => {
            const url = buildInfiniteScrollApiUrl({
                path: '/work/RJ123',
                page: 1,
                pageSize: 20,
                query: {},
            });
            expect(url).toBeNull();
        });
    });
});
