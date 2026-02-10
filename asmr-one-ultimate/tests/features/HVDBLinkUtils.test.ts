import { describe, expect, it } from 'vitest';
import {
    extractRjCode,
    buildHvdbUrl,
    buildChobitUrl,
    findDlsiteMetaRow,
    findRatingRow,
    findHvdbInjectionPoint,
    resolveHvdbRjCode,
} from '../../src/features/hvdbLinkUtils';

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

        it('extracts RJ code from mixed source_id text', () => {
            const code = extractRjCode({ sourceId: 'work-RJ765432' }, null);
            expect(code).toBe('RJ765432');
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

    describe('resolveHvdbRjCode', () => {
        it('resolves from route params when explicit workId is empty', () => {
            const code = resolveHvdbRjCode({
                work: undefined,
                workId: '',
                route: { params: { id: 'RJ123456' } },
            });
            expect(code).toBe('RJ123456');
        });

        it('resolves from route path when route params are missing', () => {
            const code = resolveHvdbRjCode({
                work: undefined,
                workId: '',
                route: { path: '/work/RJ654321' },
            });
            expect(code).toBe('RJ654321');
        });

        it('prefers source_id over route fallback values', () => {
            const code = resolveHvdbRjCode({
                work: { source_id: 'RJ777777' },
                workId: '',
                route: { path: '/work/RJ111111' },
            });
            expect(code).toBe('RJ777777');
        });
    });

    describe('buildHvdbUrl', () => {
        it('builds hvdb URL from RJ code', () => {
            expect(buildHvdbUrl('RJ123456')).toBe('https://hvdb.me/Dashboard/Add?id=123456');
        });

        it('accepts numeric work code and normalizes', () => {
            expect(buildHvdbUrl('12345678')).toBe('https://hvdb.me/Dashboard/Add?id=12345678');
        });

        it('accepts embedded RJ token and normalizes', () => {
            expect(buildHvdbUrl('work/RJ999999')).toBe('https://hvdb.me/Dashboard/Add?id=999999');
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

    describe('findDlsiteMetaRow', () => {
        it('prefers the dlsite link row matching the current RJ code', () => {
            document.body.innerHTML = `
                <div class="row items-center q-gutter-xs" id="row-a">
                    <a href="https://www.dlsite.com/home/work/=/product_id/RJ111111.html">DLsite A</a>
                </div>
                <div class="row items-center q-gutter-xs" id="row-b">
                    <a href="https://www.dlsite.com/home/work/=/product_id/RJ222222.html">DLsite B</a>
                </div>
            `;

            const row = findDlsiteMetaRow(document, 'RJ222222');
            expect(row?.id).toBe('row-b');
        });

        it('falls back to first dlsite row when no matching code is found', () => {
            document.body.innerHTML = `
                <div class="row items-center q-gutter-xs" id="row-first">
                    <a href="https://www.dlsite.com/home/work/=/product_id/RJ333333.html">DLsite first</a>
                </div>
                <div class="row items-center q-gutter-xs" id="row-second">
                    <a href="https://www.dlsite.com/home/work/=/product_id/RJ444444.html">DLsite second</a>
                </div>
            `;

            const row = findDlsiteMetaRow(document, 'RJ999999');
            expect(row?.id).toBe('row-first');
        });

        it('returns null for invalid RJ code input', () => {
            document.body.innerHTML = `
                <div class="row items-center q-gutter-xs" id="row-only">
                    <a href="https://www.dlsite.com/home/work/=/product_id/RJ555555.html">DLsite only</a>
                </div>
            `;

            const row = findDlsiteMetaRow(document, 'work-1');
            expect(row).toBeNull();
        });

        it('supports dlsite.jp and generic row fallback class', () => {
            document.body.innerHTML = `
                <div class="row" id="row-jp">
                    <a href="https://www.dlsite.jp/home/work/=/product_id/RJ666666.html">DLsite JP</a>
                </div>
            `;

            const row = findDlsiteMetaRow(document, 'RJ666666');
            expect(row?.id).toBe('row-jp');
        });

        it('supports relative product links', () => {
            document.body.innerHTML = `
                <div class="row items-center q-gutter-xs" id="row-relative">
                    <a href="/home/work/=/product_id/RJ777777.html">relative</a>
                </div>
            `;

            const row = findDlsiteMetaRow(document, 'RJ777777');
            expect(row?.id).toBe('row-relative');
        });

        it('prefers metadata-scoped dlsite links over unrelated global links', () => {
            document.body.innerHTML = `
                <div class="row items-center q-gutter-xs" id="row-unrelated">
                    <a href="https://www.dlsite.com/home/work/=/product_id/RJ111111.html">Unrelated DLsite</a>
                </div>
                <div class="work-info">
                    <div class="row items-center q-gutter-xs" id="row-scoped">
                        <a href="https://www.dlsite.com/home/work/=/product_id/RJ222222.html">Scoped DLsite</a>
                    </div>
                </div>
            `;

            const row = findDlsiteMetaRow(document, 'RJ999999');
            expect(row?.id).toBe('row-scoped');
        });
    });

    describe('findRatingRow', () => {
        it('finds the row containing q-rating', () => {
            document.body.innerHTML = `
                <div class="row items-center q-gutter-xs" id="rating-row">
                    <div class="q-rating"></div>
                    <a href="https://www.dlsite.com/home/work/=/product_id/RJ111111.html">DLsite</a>
                </div>
            `;

            const row = findRatingRow(document);
            expect(row?.id).toBe('rating-row');
        });

        it('returns null when no q-rating exists', () => {
            document.body.innerHTML = `
                <div class="row items-center q-gutter-xs" id="no-rating">
                    <a href="https://www.dlsite.com/home/work/=/product_id/RJ111111.html">DLsite</a>
                </div>
            `;

            expect(findRatingRow(document)).toBeNull();
        });
    });

    describe('findHvdbInjectionPoint', () => {
        it('prefers dlsite row over generic rating row', () => {
            document.body.innerHTML = `
                <div class="row items-center q-gutter-xs" id="rating-row">
                    <div class="q-rating"></div>
                </div>
                <div class="row items-center q-gutter-xs" id="row-dlsite">
                    <a href="https://www.dlsite.com/home/work/=/product_id/RJ111111.html">DLsite 2</a>
                </div>
                <div id="asmr-work-metadata-root"></div>
            `;

            const point = findHvdbInjectionPoint(document, 'RJ111111');
            expect(point?.id).toBe('row-dlsite');
        });

        it('falls back to rating row when dlsite row is missing', () => {
            document.body.innerHTML = `
                <div class="row items-center q-gutter-xs" id="rating-row">
                    <div class="q-rating"></div>
                </div>
                <div id="asmr-work-metadata-root"></div>
            `;

            const point = findHvdbInjectionPoint(document, 'RJ111111');
            expect(point?.id).toBe('rating-row');
        });

        it('falls back to metadata root when dlsite row is missing', () => {
            document.body.innerHTML = `
                <div id="asmr-work-metadata-root"></div>
            `;

            const point = findHvdbInjectionPoint(document, 'RJ123456');
            expect(point?.id).toBe('asmr-work-metadata-root');
        });

        it('returns null when RJ code is invalid even if fallback exists', () => {
            document.body.innerHTML = `
                <div id="asmr-work-metadata-root"></div>
            `;

            const point = findHvdbInjectionPoint(document, 'work-x');
            expect(point).toBeNull();
        });

        it('uses metadata-root fallback when only unrelated global dlsite links exist', () => {
            document.body.innerHTML = `
                <div class="row items-center q-gutter-xs" id="row-unrelated">
                    <a href="https://www.dlsite.com/home/work/=/product_id/RJ111111.html">Other work</a>
                </div>
                <div id="asmr-work-metadata-root"></div>
            `;

            const point = findHvdbInjectionPoint(document, 'RJ999999');
            expect(point?.id).toBe('asmr-work-metadata-root');
        });
    });
});
