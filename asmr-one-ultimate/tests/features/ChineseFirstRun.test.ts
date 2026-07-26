/**
 * A fresh install on a Chinese browser must translate Japanese content into
 * Chinese out of the box — no settings, no host language switch (GitHub #2).
 *
 * This exercises the real auto-detection chain (navigator locale -> I18n.lang
 * -> translation target -> wire request), not a mocked stand-in for it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    gmRequest: vi.fn(),
}));

vi.mock('../../src/infrastructure/HttpClient', () => ({
    gmRequest: mocks.gmRequest,
    retryWithBackoff: vi.fn(async (fn: () => Promise<unknown>) => await fn()),
    HttpError: class HttpError extends Error {
        status = 0;
        retryable = false;
    },
}));

import { Config, I18n } from '../../src/core/Config';
import { TranslationService, _testExports } from '../../src/services/TranslationService';

const originalLanguage = Object.getOwnPropertyDescriptor(Navigator.prototype, 'language')
    || Object.getOwnPropertyDescriptor(navigator, 'language');
const originalLanguages = Object.getOwnPropertyDescriptor(Navigator.prototype, 'languages')
    || Object.getOwnPropertyDescriptor(navigator, 'languages');

function pretendBrowserLocale(primary: string, ...rest: string[]): void {
    Object.defineProperty(navigator, 'language', { configurable: true, value: primary });
    Object.defineProperty(navigator, 'languages', { configurable: true, value: [primary, ...rest] });
    I18n.resetAutoDetection();
}

function restoreBrowserLocale(): void {
    delete (navigator as unknown as Record<string, unknown>).language;
    delete (navigator as unknown as Record<string, unknown>).languages;
    if (originalLanguage) Object.defineProperty(navigator, 'language', originalLanguage);
    if (originalLanguages) Object.defineProperty(navigator, 'languages', originalLanguages);
    I18n.resetAutoDetection();
}

describe('Chinese first run', () => {
    beforeEach(() => {
        localStorage.clear();
        document.body.innerHTML = '';
        TranslationService.clearCache();
        _testExports.resetRemoteStateForTests();
        mocks.gmRequest.mockReset();
        mocks.gmRequest.mockImplementation(async (opts: { url: string }) => {
            const url = new URL(opts.url);
            return {
                responseText: JSON.stringify([[[
                    `translated[${url.searchParams.get('sl')}->${url.searchParams.get('tl')}]`,
                    '', '',
                ]]]),
                response: undefined as unknown,
            };
        });
    });

    afterEach(() => {
        restoreBrowserLocale();
        I18n.setLang('en');
        localStorage.clear();
    });

    it('ships with the Chinese-to-Japanese metadata lane enabled by default', () => {
        // CN metadata is replaced with Japanese, and it is that Japanese text
        // that then carries the EN/CN lane. Requiring a settings visit first
        // would leave a fresh Chinese install unable to read titles at all.
        expect(Config.get('translateCnToJp')).toBe(true);
        expect(Config.get('translateMode')).toBe(true);
    });

    it('detects a zh-CN browser with no persisted host choice', () => {
        pretendBrowserLocale('zh-CN');
        I18n.syncFromHost();

        expect(I18n.lang).toBe('zh');
        expect(TranslationService.getUiTargetLang()).toBe('zh');
        expect(TranslationService.getUiRegionalTargetLang()).toBe('zh-CN');
    });

    it('detects a zh-TW browser and keeps it on Traditional Chinese', () => {
        pretendBrowserLocale('zh-TW', 'en-GB');
        I18n.syncFromHost();

        expect(I18n.lang).toBe('zh');
        expect(TranslationService.getUiRegionalTargetLang()).toBe('zh-TW');
    });

    it('keeps a zh browser seed when the host has only ever reported its own default', () => {
        pretendBrowserLocale('zh-CN');
        const qApp = document.createElement('div');
        qApp.id = 'q-app';
        (qApp as unknown as { __vue__: unknown }).__vue__ = { $i18n: { locale: 'en-US' } };
        document.body.appendChild(qApp);

        I18n.syncFromHost();
        I18n.syncFromHost();

        expect(I18n.lang).toBe('zh');
    });

    it('translates a Japanese work title into Chinese end to end', async () => {
        pretendBrowserLocale('zh-CN');
        I18n.syncFromHost();
        mocks.gmRequest.mockResolvedValueOnce({
            responseText: JSON.stringify([[['抓耳朵和窃窃私语', '', '']]]),
            response: undefined as unknown,
        });

        const display = await TranslationService.translateForDisplay(
            '耳かきと囁き',
            TranslationService.getUiTargetLang(),
            { sourceLanguageHint: 'ja' },
        );

        expect(display.primaryText).toBe('耳かきと囁き');
        expect(display.primaryLanguage).toBe('ja');
        expect(display.secondaryText).toBe('抓耳朵和窃窃私语');
        expect(display.secondaryLanguage).toBe('zh');

        const url = new URL(mocks.gmRequest.mock.calls[0][0].url);
        expect(url.searchParams.get('sl')).toBe('ja');
        expect(url.searchParams.get('tl')).toBe('zh-CN');
    });

    it('promotes a Chinese-edition title to Japanese and derives the Chinese lane from it', async () => {
        pretendBrowserLocale('zh-CN');
        I18n.syncFromHost();
        mocks.gmRequest
            .mockResolvedValueOnce({
                responseText: JSON.stringify([[['おやすみ耳かき', '', '']]]),
                response: undefined as unknown,
            })
            .mockResolvedValueOnce({
                responseText: JSON.stringify([[['晚安掏耳朵', '', '']]]),
                response: undefined as unknown,
            });

        const display = await TranslationService.translateForDisplay(
            '晚安耳语',
            TranslationService.getUiTargetLang(),
            { sourceLanguageHint: 'zh' },
        );

        expect(display).toMatchObject({
            sourceText: '晚安耳语',
            sourceLanguage: 'zh',
            primaryText: 'おやすみ耳かき',
            primaryLanguage: 'ja',
            secondaryText: '晚安掏耳朵',
        });

        // The Chinese lane must be derived from the Japanese text, never from
        // the original Chinese — that is what makes the title readable.
        const stages = mocks.gmRequest.mock.calls.map(([request]) => {
            const url = new URL(request.url);
            return [url.searchParams.get('sl'), url.searchParams.get('tl'), url.searchParams.get('q')];
        });
        expect(stages).toEqual([
            ['zh', 'ja', '晚安耳语'],
            ['ja', 'zh-CN', 'おやすみ耳かき'],
        ]);
    });

    it('does not mistake an ambiguous Han-only Japanese title for Chinese', async () => {
        pretendBrowserLocale('zh-CN');
        I18n.syncFromHost();
        mocks.gmRequest.mockResolvedValueOnce({
            responseText: JSON.stringify([[['边缘村庄', '', '']]]),
            response: undefined as unknown,
        });

        const display = await TranslationService.translateForDisplay(
            '限界集落',
            TranslationService.getUiTargetLang(),
            { sourceLanguageHint: 'auto' },
        );

        expect(display.sourceLanguage).toBe('ja');
        expect(display.primaryText).toBe('限界集落');
        expect(display.secondaryText).toBe('边缘村庄');
        expect(new URL(mocks.gmRequest.mock.calls[0][0].url).searchParams.get('sl')).toBe('ja');
    });
});
