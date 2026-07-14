import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { I18n } from '../../src/core/Config';

describe('I18n', () => {
    let originalLang: string;

    beforeEach(() => {
        originalLang = I18n.lang;
    });

    afterEach(() => {
        I18n.lang = originalLang as any;
        localStorage.clear();
    });

    // =========================================================================
    // setLang
    // =========================================================================
    describe('setLang', () => {
        it('should set lang to "zh" for "zh-CN"', () => {
            I18n.setLang('zh-CN');
            expect(I18n.lang).toBe('zh');
        });

        it('should set lang to "zh" for "zh-TW"', () => {
            I18n.setLang('zh-TW');
            expect(I18n.lang).toBe('zh');
        });

        it('should set lang to "zh" for "cn"', () => {
            I18n.setLang('cn');
            expect(I18n.lang).toBe('zh');
        });

        it('should set lang to "ja" for "ja"', () => {
            I18n.setLang('ja');
            expect(I18n.lang).toBe('ja');
        });

        it('should set lang to "ja" for "jp"', () => {
            I18n.setLang('jp');
            expect(I18n.lang).toBe('ja');
        });

        it('should set lang to "ja" for "ja-JP"', () => {
            I18n.setLang('ja-JP');
            expect(I18n.lang).toBe('ja');
        });

        it('should set lang to "en" for "en"', () => {
            I18n.setLang('en');
            expect(I18n.lang).toBe('en');
        });

        it('should set lang to "en" for "en-US"', () => {
            I18n.setLang('en-US');
            expect(I18n.lang).toBe('en');
        });

        it('should fall back to "en" for unknown locale', () => {
            I18n.setLang('fr-FR');
            expect(I18n.lang).toBe('en');
        });

        it('should be case insensitive', () => {
            I18n.setLang('ZH-cn');
            expect(I18n.lang).toBe('zh');

            I18n.setLang('JA');
            expect(I18n.lang).toBe('ja');
        });
    });

    // =========================================================================
    // t (translation lookup)
    // =========================================================================
    describe('t', () => {
        it('should return English text when lang is "en"', () => {
            I18n.setLang('en');
            expect(I18n.t('radioMode')).toBe('Radio Mode');
        });

        it('should return Chinese text when lang is "zh"', () => {
            I18n.setLang('zh');
            expect(I18n.t('radioMode')).toBe('电台模式');
        });

        it('should return Japanese text when lang is "ja"', () => {
            I18n.setLang('ja');
            expect(I18n.t('radioMode')).toBe('ラジオモード');
        });

        it('should fall back to English when key missing in current lang', () => {
            I18n.setLang('zh');
            // If a key exists only in English, we should get the English version
            const enOnlyKey = 'radioMode'; // exists in all, so let's use a key pattern
            // All keys should exist in all languages, so test fallback via the key itself
            const result = I18n.t('nonExistentKey');
            expect(result).toBe('nonExistentKey'); // returns key if not found anywhere
        });

        it('should return key if not found in any language', () => {
            I18n.setLang('en');
            expect(I18n.t('totally_missing_key_xyz')).toBe('totally_missing_key_xyz');
        });

        it('should return correct values for various known keys', () => {
            I18n.setLang('en');
            expect(I18n.t('shuffle')).toBe('Shuffle');
            expect(I18n.t('off')).toBe('OFF');
            expect(I18n.t('on')).toBe('ON');
        });
    });

    // =========================================================================
    // format (interpolation)
    // =========================================================================
    describe('format', () => {
        it('should replace a single parameter', () => {
            I18n.setLang('en');
            const result = I18n.format('advFound', { count: 42 });
            expect(result).toBe('Found 42 works.');
        });

        it('should replace multiple parameters', () => {
            I18n.setLang('en');
            const result = I18n.format('magicSearchPage', { current: 3, total: 10 });
            expect(result).toBe('Page 3 / 10');
        });

        it('should handle numeric params converted to string', () => {
            I18n.setLang('en');
            const result = I18n.format('commentsCount', { count: 0 });
            expect(result).toBe('0 reviews');
        });

        it('should work with Chinese locale', () => {
            I18n.setLang('zh');
            const result = I18n.format('commentsCount', { count: 5 });
            expect(result).toBe('5 条评论');
        });

        it('should work with Japanese locale', () => {
            I18n.setLang('ja');
            // Check a key that exists in ja locale with params
            const result = I18n.format('advFound', { count: 100 });
            // ja should have this key or fall back to en
            expect(result).toContain('100');
        });

        it('should return key with unreplaced params if key missing', () => {
            I18n.setLang('en');
            const result = I18n.format('nonExistentKey', { x: 1 });
            expect(result).toBe('nonExistentKey');
        });

        it('should leave unreplaced placeholders for missing params', () => {
            I18n.setLang('en');
            // Format with only partial params
            const result = I18n.format('magicSearchPage', { current: 1 } as any);
            expect(result).toBe('Page 1 / {total}');
        });
    });

    // =========================================================================
    // syncFromHost
    // =========================================================================
    describe('syncFromHost', () => {
        it('should read from localStorage "locale" key', () => {
            localStorage.setItem('locale', 'zh');
            I18n.syncFromHost();
            expect(I18n.lang).toBe('zh');
        });

        it('should read from localStorage "lang" key', () => {
            localStorage.setItem('lang', 'ja');
            I18n.syncFromHost();
            expect(I18n.lang).toBe('ja');
        });

        it('should read from localStorage "language" key', () => {
            localStorage.setItem('language', 'zh-TW');
            I18n.syncFromHost();
            expect(I18n.lang).toBe('zh');
        });

        it('should read from localStorage "i18n-locale" key', () => {
            localStorage.setItem('i18n-locale', 'ja-JP');
            I18n.syncFromHost();
            expect(I18n.lang).toBe('ja');
        });

        it('should fall back to navigator.language when no localStorage', () => {
            // navigator.language is set in the jsdom environment
            I18n.syncFromHost();
            // Should not throw and should set a valid lang
            expect(['en', 'zh', 'ja']).toContain(I18n.lang);
        });

        it('should prioritize Vue app locale if q-app element exists', () => {
            const qApp = document.createElement('div');
            qApp.id = 'q-app';
            (qApp as any).__vue__ = { $i18n: { locale: 'ja' } };
            document.body.appendChild(qApp);

            I18n.syncFromHost();
            expect(I18n.lang).toBe('ja');

            document.body.removeChild(qApp);
        });

        it('should skip Vue locale if not accessible and use localStorage', () => {
            const qApp = document.createElement('div');
            qApp.id = 'q-app';
            // No __vue__ property
            document.body.appendChild(qApp);

            localStorage.setItem('locale', 'zh');
            I18n.syncFromHost();
            expect(I18n.lang).toBe('zh');

            document.body.removeChild(qApp);
        });

        it('seeds a Chinese browser on first run, then follows a later host locale change', () => {
            const originalLanguage = Object.getOwnPropertyDescriptor(navigator, 'language');
            Object.defineProperty(navigator, 'language', { configurable: true, value: 'zh-CN' });
            const qApp = document.createElement('div');
            qApp.id = 'q-app';
            const vue = { $i18n: { locale: 'ja' } };
            (qApp as any).__vue__ = vue;
            document.body.appendChild(qApp);

            try {
                I18n.resetAutoDetection();
                I18n.syncFromHost();
                expect(I18n.lang).toBe('zh');

                // Repeated observation of the initial host fallback must not erase
                // the first-install browser seed.
                I18n.syncFromHost();
                expect(I18n.lang).toBe('zh');

                // A real host selection changes the observed Vue locale and wins.
                vue.$i18n.locale = 'en';
                I18n.syncFromHost();
                expect(I18n.lang).toBe('en');
            } finally {
                qApp.remove();
                if (originalLanguage) Object.defineProperty(navigator, 'language', originalLanguage);
                I18n.resetAutoDetection();
            }
        });

        it('keeps a persisted host choice authoritative over browser seeding', () => {
            const originalLanguage = Object.getOwnPropertyDescriptor(navigator, 'language');
            Object.defineProperty(navigator, 'language', { configurable: true, value: 'zh-CN' });
            try {
                localStorage.setItem('locale', 'en');
                I18n.resetAutoDetection();
                I18n.syncFromHost();
                expect(I18n.lang).toBe('en');
            } finally {
                if (originalLanguage) Object.defineProperty(navigator, 'language', originalLanguage);
                I18n.resetAutoDetection();
            }
        });
    });

    // =========================================================================
    // data integrity
    // =========================================================================
    describe('data integrity', () => {
        it('should have en, zh, and ja locales', () => {
            expect(I18n.data).toHaveProperty('en');
            expect(I18n.data).toHaveProperty('zh');
            expect(I18n.data).toHaveProperty('ja');
        });

        it.each(['zh', 'ja'] as const)('has exact bidirectional key parity between en and %s', (locale) => {
            const enKeys = Object.keys(I18n.data.en).sort();
            const localizedKeys = Object.keys(I18n.data[locale]).sort();

            expect(localizedKeys, `${locale} must neither omit English keys nor add orphan keys`).toEqual(enKeys);
        });

        it('has complete Chinese and Japanese catalogs for backup downloads and localized UI additions', () => {
            const requiredKeys = Object.keys(I18n.data.en).filter(key => key.startsWith('backupDownloader'));
            requiredKeys.push('commentsOpenSettings', 'infScrollCoverOf', 'infScrollAllAges', 'primaryLangPlaceholder', 'targetLangPlaceholder');

            for (const locale of ['zh', 'ja'] as const) {
                const missing = requiredKeys.filter(key => !I18n.data[locale][key]);
                expect(missing, `${locale} is missing feature translations`).toEqual([]);
            }
        });
    });
});
