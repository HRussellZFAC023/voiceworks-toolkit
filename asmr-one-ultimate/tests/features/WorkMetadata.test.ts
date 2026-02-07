import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkMetadata } from '../../src/features/WorkMetadata';
import { KikoeruBridge } from '../../src/infrastructure/KikoeruBridge';

// Mock all heavy dependencies
const mockScraper = {
    scrape: vi.fn().mockResolvedValue({ rjcode: 'RJ000001', title: '', nsfw: true, release: '', tags: [], cvs: [], rating_average: 0, price: 0, age_category_string: 'R18' })
};
vi.mock('../../src/features/DLsiteScraper', () => ({
    DLsiteScraper: {
        getInstance: vi.fn(() => mockScraper)
    },
    DLsiteMetadata: {}
}));
vi.mock('../../src/services/WorkService', () => ({ WorkService: {} }));
vi.mock('../../src/core/CentralObserver', () => ({ CentralObserver: { register: vi.fn() } }));
vi.mock('../../src/core/Cache', () => ({ CacheKeys: { dlsite: vi.fn() }, SharedCache: { getOrFetch: vi.fn(), set: vi.fn() } }));
vi.mock('../../src/services/TranslationService', () => ({ TranslationService: { translate: vi.fn().mockResolvedValue(null) } }));
vi.mock('../../src/core/Config', () => ({ I18n: { t: (k: string) => k, format: (k: string) => k } }));
vi.mock('../../src/features/MediaViewer', () => ({ MediaViewer: { getInstance: vi.fn() } }));

describe('WorkMetadata', () => {
    let wm: WorkMetadata;

    beforeEach(() => {
        (KikoeruBridge as any).instance = null;
        document.body.innerHTML = '<div id="q-app"></div>';
        const qApp = document.getElementById('q-app');
        if (qApp) {
            (qApp as any).__vue__ = {
                $store: { state: { AudioPlayer: {}, Works: {} }, dispatch: vi.fn() },
                $router: { currentRoute: { name: '', path: '', params: {} } },
                $axios: {}
            };
        }
        wm = new WorkMetadata();
    });

    describe('resolveJpRjCode', () => {
        const resolve = (work: any, currentCode: string) =>
            (wm as any).resolveJpRjCode(work, currentCode);

        it('returns null when work has no translation info', () => {
            expect(resolve({}, 'RJ01267361')).toBeNull();
        });

        it('returns null when work has no relevant fields', () => {
            expect(resolve({ title: 'test', tags: [] }, 'RJ01267361')).toBeNull();
        });

        it('resolves from original_workno field', () => {
            const work = { original_workno: 'RJ250682' };
            expect(resolve(work, 'RJ01267361')).toBe('RJ250682');
        });

        it('resolves from translation_info.original_workno', () => {
            const work = {
                translation_info: {
                    is_child: true,
                    original_workno: 'RJ250682',
                    parent_workno: null
                }
            };
            expect(resolve(work, 'RJ01267361')).toBe('RJ250682');
        });

        it('resolves from translation_info.parent_workno', () => {
            const work = {
                translation_info: {
                    is_child: true,
                    original_workno: null,
                    parent_workno: 'RJ250682'
                }
            };
            expect(resolve(work, 'RJ01267361')).toBe('RJ250682');
        });

        it('resolves from language_editions JPN entry', () => {
            const work = {
                language_editions: [
                    { lang: 'CHI_HANS', workno: 'RJ01267361', label: '中文', edition_type: 'language' },
                    { lang: 'JPN', workno: 'RJ250682', label: '日本語', edition_type: 'language' }
                ]
            };
            expect(resolve(work, 'RJ01267361')).toBe('RJ250682');
        });

        it('returns null when JPN edition matches current code', () => {
            const work = {
                language_editions: [
                    { lang: 'JPN', workno: 'RJ250682', label: '日本語', edition_type: 'language' }
                ]
            };
            expect(resolve(work, 'RJ250682')).toBeNull();
        });

        it('prefers original_workno over language_editions', () => {
            const work = {
                original_workno: 'RJ111111',
                language_editions: [
                    { lang: 'JPN', workno: 'RJ222222', label: '日本語', edition_type: 'language' }
                ]
            };
            expect(resolve(work, 'RJ01267361')).toBe('RJ111111');
        });

        it('prefers translation_info over language_editions', () => {
            const work = {
                translation_info: {
                    original_workno: 'RJ333333'
                },
                language_editions: [
                    { lang: 'JPN', workno: 'RJ444444', label: '日本語', edition_type: 'language' }
                ]
            };
            expect(resolve(work, 'RJ01267361')).toBe('RJ333333');
        });

        it('normalizes lowercase RJ codes to uppercase', () => {
            const work = { original_workno: 'rj250682' };
            expect(resolve(work, 'RJ01267361')).toBe('RJ250682');
        });

        it('handles 8-digit RJ codes', () => {
            const work = { original_workno: 'RJ01234567' };
            expect(resolve(work, 'RJ99999999')).toBe('RJ01234567');
        });
    });
});
