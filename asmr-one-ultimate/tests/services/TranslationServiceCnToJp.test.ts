import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const cache = new Map<string, unknown>();
    const configState: Record<string, unknown> = {
        debug: false,
        translateCnToJp: false,
        translationApiEndpoint: '',
        translationApiKey: '',
        translationApiModel: 'gpt-4o-mini',
    };
    const gmRequestMock = vi.fn(async (opts: {
        url: string;
        method?: string;
        headers?: Record<string, string>;
        data?: string;
    }) => {
        const tlMatch = opts.url.match(/[?&]tl=([^&]+)/);
        const tl = decodeURIComponent(tlMatch?.[1] || 'en');
        return {
            responseText: JSON.stringify([[[`translated:${tl}`, '', '']]]),
            response: undefined as unknown,
        };
    });
    const i18nState = { lang: 'en' };
    return { cache, configState, gmRequestMock, i18nState };
});

vi.mock('$', () => ({
    GM_listValues: vi.fn(() => []),
    GM_deleteValue: vi.fn(),
}));

vi.mock('../../src/core/Cache', () => ({
    SharedCache: {
        get: vi.fn((key: string) => mocks.cache.get(key) ?? null),
        set: vi.fn((key: string, value: unknown) => { mocks.cache.set(key, value); }),
        getMemory: vi.fn((key: string) => mocks.cache.get(`memory:${key}`) ?? null),
        setMemory: vi.fn((key: string, value: unknown) => { mocks.cache.set(`memory:${key}`, value); }),
        clear: vi.fn(() => { mocks.cache.clear(); }),
        delete: vi.fn((key: string) => { mocks.cache.delete(key); }),
    },
    CacheKeys: {
        translation: (text: string, lang: string, source: string) => `tr:${source}:${lang}:${text}`,
        translationRateLimit: () => 'tr:rate-limit',
    },
    hashString: vi.fn((s: string) => s),
}));

vi.mock('../../src/infrastructure/HttpClient', () => ({
    gmRequest: mocks.gmRequestMock,
    retryWithBackoff: vi.fn(async (fn: () => Promise<unknown>) => await fn()),
    HttpError: class HttpError extends Error {
        status: number;
        constructor(status: number) {
            super(String(status));
            this.status = status;
        }
    },
}));

vi.mock('../../src/core/Config', () => ({
    I18n: { ...mocks.i18nState, get lang() { return mocks.i18nState.lang; }, t: (k: string) => k, format: (k: string) => k },
    Config: {
        get: vi.fn((key: string) => mocks.configState[key]),
    },
}));

vi.mock('../../src/core/Utils', () => ({
    Logger: {
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
    },
}));

import { TranslationService, _testExports } from '../../src/services/TranslationService';

describe('TranslationService CN->JP preference', () => {
    beforeEach(() => {
        mocks.cache.clear();
        mocks.gmRequestMock.mockReset();
        mocks.gmRequestMock.mockImplementation(async (opts: { url: string }) => {
            const tlMatch = opts.url.match(/[?&]tl=([^&]+)/);
            const tl = decodeURIComponent(tlMatch?.[1] || 'en');
            return {
                responseText: JSON.stringify([[[`translated:${tl}`, '', '']]]),
                response: undefined as unknown,
            };
        });
        _testExports.resetRemoteStateForTests();
        mocks.configState.translateCnToJp = false;
        mocks.configState.translationApiEndpoint = '';
        mocks.configState.translationApiKey = '';
        mocks.configState.translationApiModel = 'gpt-4o-mini';
        mocks.i18nState.lang = 'en';
    });

    it('uses the active Chinese UI language for user-facing translations', async () => {
        mocks.i18nState.lang = 'zh-CN';

        expect(TranslationService.getUiTargetLang()).toBe('zh');
        const out = await TranslationService.translate('今日は雨です', TranslationService.getUiTargetLang());

        expect(out).toBe('translated:zh-CN');
        expect(mocks.gmRequestMock.mock.calls[0][0].url).toContain('tl=zh-CN');
    });

    it('uses a Japanese source hint to reject a Han-only echo before accepting fallback', async () => {
        mocks.gmRequestMock
            .mockResolvedValueOnce({ responseText: JSON.stringify([[['限界集落', '', '']]]), response: undefined as unknown })
            .mockResolvedValueOnce({ responseText: JSON.stringify([[['边缘村庄', '', '']]]), response: undefined as unknown });

        await expect(TranslationService.translate('限界集落', 'zh', {
            sourceLanguageHint: 'ja',
        })).resolves.toBe('边缘村庄');
        expect(mocks.gmRequestMock).toHaveBeenCalledTimes(2);
    });

    it('short-circuits an explicit Chinese source already targeting Chinese', async () => {
        await expect(TranslationService.translate('中文标签', 'zh-CN', {
            sourceLanguageHint: 'zh',
        })).resolves.toBe('中文标签');
        await expect(TranslationService.translate('中文标签', 'zh-CN', {
            sourceLanguageHint: 'zh',
        })).resolves.toBe('中文标签');
        expect(mocks.gmRequestMock).not.toHaveBeenCalled();
    });

    it('briefly caches an unchanged remote result to prevent observer retry storms', async () => {
        mocks.gmRequestMock.mockResolvedValue({
            responseText: JSON.stringify([[['限界集落', '', '']]]),
            response: undefined as unknown,
        });

        await expect(TranslationService.translate('限界集落', 'zh', {
            sourceLanguageHint: 'ja',
        })).resolves.toBe('限界集落');
        const callsAfterFirst = mocks.gmRequestMock.mock.calls.length;
        await expect(TranslationService.translate('限界集落', 'zh', {
            sourceLanguageHint: 'ja',
        })).resolves.toBe('限界集落');
        expect(mocks.gmRequestMock).toHaveBeenCalledTimes(callsAfterFirst);
    });

    it('routes Chinese text to Japanese when translateCnToJp is enabled (target en)', async () => {
        mocks.configState.translateCnToJp = true;
        const out = await TranslationService.translate('中文标签', 'en');
        expect(out).toBe('translated:ja');
        expect(mocks.gmRequestMock).toHaveBeenCalledTimes(1);
        expect(mocks.gmRequestMock.mock.calls[0][0].url).toContain('tl=ja');
    });

    it('preserves an explicit learner secondary target while CN-to-JA remains enabled', async () => {
        mocks.configState.translateCnToJp = true;
        const out = await TranslationService.translate('中文标签', 'en', {
            sourceLanguageHint: 'zh',
            preserveRequestedTarget: true,
        });

        expect(out).toBe('translated:en');
        expect(mocks.gmRequestMock.mock.calls[0][0].url).toContain('tl=en');
    });

    it('builds a Japanese-primary display and derives English from that Japanese text', async () => {
        mocks.configState.translateCnToJp = true;
        mocks.gmRequestMock
            .mockResolvedValueOnce({ responseText: JSON.stringify([[['日本語の題名', '', '']]]), response: undefined as unknown })
            .mockResolvedValueOnce({ responseText: JSON.stringify([[['English title', '', '']]]), response: undefined as unknown });

        const out = await TranslationService.translateForDisplay('中文标题', 'en', {
            sourceLanguageHint: 'zh',
        });

        expect(out).toMatchObject({
            sourceText: '中文标题',
            sourceLanguage: 'zh',
            primaryText: '日本語の題名',
            primaryLanguage: 'ja',
            secondaryText: 'English title',
            secondaryLanguage: 'en',
        });
        expect(mocks.gmRequestMock).toHaveBeenCalledTimes(2);
        expect(mocks.gmRequestMock.mock.calls[0][0].url).toContain('sl=zh');
        expect(mocks.gmRequestMock.mock.calls[0][0].url).toContain('tl=ja');
        expect(mocks.gmRequestMock.mock.calls[1][0].url).toContain('sl=ja');
        expect(mocks.gmRequestMock.mock.calls[1][0].url).toContain('tl=en');
        expect(mocks.gmRequestMock.mock.calls[1][0].url).toContain(encodeURIComponent('日本語の題名'));
    });

    it('treats ambiguous Han-only auto input as Japanese unless metadata confirms Chinese', async () => {
        mocks.configState.translateCnToJp = true;

        const out = await TranslationService.translateForDisplay('限界集落', 'en', {
            sourceLanguageHint: 'auto',
        });

        expect(out.sourceLanguage).toBe('ja');
        expect(out.primaryLanguage).toBe('ja');
        expect(mocks.gmRequestMock).toHaveBeenCalledOnce();
        expect(mocks.gmRequestMock.mock.calls[0][0].url).toContain('sl=ja');
        expect(mocks.gmRequestMock.mock.calls[0][0].url).toContain('tl=en');
    });

    it('does not attempt English when the Chinese-to-Japanese stage echoes the source', async () => {
        mocks.configState.translateCnToJp = true;
        mocks.gmRequestMock.mockResolvedValue({
            responseText: JSON.stringify([[['中文标题', '', '']]]),
            response: undefined as unknown,
        });

        const out = await TranslationService.translateForDisplay('中文标题', 'en', {
            sourceLanguageHint: 'zh',
        });

        expect(out.primaryText).toBe('中文标题');
        expect(out.primaryLanguage).toBe('zh');
        expect(out.secondaryText).toBeUndefined();
        expect(mocks.gmRequestMock.mock.calls.every(([request]) => !request.url.includes('tl=en'))).toBe(true);
    });

    it('keeps batched CN-to-JA and JA-to-EN stages ordered', async () => {
        mocks.configState.translateCnToJp = true;
        mocks.gmRequestMock.mockImplementation(async (opts: { url: string }) => {
            const url = new URL(opts.url);
            const target = url.searchParams.get('tl');
            const input = url.searchParams.get('q');
            const translations: Record<string, string> = {
                'ja:中文一': '日本語一',
                'ja:中文二': '日本語二',
                'en:日本語一': 'English one',
                'en:日本語二': 'English two',
            };
            return {
                responseText: JSON.stringify([[[translations[`${target}:${input}`], '', '']]]),
                response: undefined as unknown,
            };
        });

        const out = await TranslationService.translateForDisplayBatch(['中文一', '中文二'], 'en', {
            sourceLanguageHint: 'zh',
        });

        expect(out.map((item) => [item.primaryText, item.secondaryText])).toEqual([
            ['日本語一', 'English one'],
            ['日本語二', 'English two'],
        ]);
        const targets = mocks.gmRequestMock.mock.calls.map(([request]) => new URL(request.url).searchParams.get('tl'));
        expect(targets).toEqual(['ja', 'ja', 'en', 'en']);
    });

    it('keeps non-Chinese text on requested English target when translateCnToJp is enabled', async () => {
        mocks.configState.translateCnToJp = true;
        const out = await TranslationService.translate('今日は雨です', 'en');
        expect(out).toBe('translated:en');
        expect(mocks.gmRequestMock).toHaveBeenCalledTimes(1);
        expect(mocks.gmRequestMock.mock.calls[0][0].url).toContain('tl=en');
    });

    it('keeps Chinese text on requested English target when translateCnToJp is disabled', async () => {
        mocks.configState.translateCnToJp = false;
        const out = await TranslationService.translate('中文标签', 'en');
        expect(out).toBe('translated:en');
        expect(mocks.gmRequestMock).toHaveBeenCalledTimes(1);
        expect(mocks.gmRequestMock.mock.calls[0][0].url).toContain('tl=en');
    });

    it('translates Japanese into Chinese when zh-CN is selected', async () => {
        const out = await TranslationService.translate('今日は雨です', 'zh-CN');
        expect(out).toBe('translated:zh-CN');
        expect(mocks.gmRequestMock.mock.calls[0][0].url).toContain('tl=zh-CN');
    });

    it('sends the Japanese-to-Chinese request with an explicit Japanese source hint', async () => {
        mocks.i18nState.lang = 'zh-CN';
        mocks.gmRequestMock.mockResolvedValueOnce({
            responseText: JSON.stringify([[['抓耳朵和窃窃私语', '', '']]]),
            response: undefined as unknown,
        });

        const display = await TranslationService.translateForDisplay('耳かきと囁き', 'zh-CN', {
            sourceLanguageHint: 'ja',
        });

        expect(display).toMatchObject({
            sourceLanguage: 'ja',
            primaryText: '耳かきと囁き',
            primaryLanguage: 'ja',
            secondaryText: '抓耳朵和窃窃私语',
        });
        expect(mocks.gmRequestMock).toHaveBeenCalledOnce();
        expect(mocks.gmRequestMock.mock.calls[0][0].url).toContain('sl=ja');
        expect(mocks.gmRequestMock.mock.calls[0][0].url).toContain('tl=zh-CN');
    });

    it('serves Traditional Chinese to a zh-TW reader and caches it apart from Simplified', async () => {
        const original = Object.getOwnPropertyDescriptor(navigator, 'languages');
        Object.defineProperty(navigator, 'languages', { value: ['zh-TW', 'en'], configurable: true });
        try {
            const out = await TranslationService.translate('今日は雨です', 'zh-CN');
            expect(out).toBe('translated:zh-TW');
            expect(mocks.gmRequestMock.mock.calls[0][0].url).toContain('tl=zh-TW');

            // A Simplified reader must not be served the Traditional cache entry.
            Object.defineProperty(navigator, 'languages', { value: ['zh-CN'], configurable: true });
            const simplified = await TranslationService.translate('今日は雨です', 'zh-CN');
            expect(simplified).toBe('translated:zh-CN');
            expect(mocks.gmRequestMock).toHaveBeenCalledTimes(2);
        } finally {
            if (original) Object.defineProperty(navigator, 'languages', original);
            else Object.defineProperty(navigator, 'languages', { value: ['en'], configurable: true });
        }
    });

    it('recognizes normalized same-language targets while preserving CN-to-JA mode', () => {
        expect(TranslationService.isTargetLanguage('中文标签', 'zh-CN')).toBe(true);
        expect(TranslationService.isTargetLanguage('耳かき', 'ja-JP')).toBe(true);

        mocks.configState.translateCnToJp = true;
        expect(TranslationService.isTargetLanguage('中文标签', 'zh-CN')).toBe(false);
    });

    it('uses an OpenAI-compatible custom endpoint with model and bearer token', async () => {
        mocks.configState.translationApiEndpoint = 'https://translator.example/v1/chat/completions';
        mocks.configState.translationApiKey = 'local-test-token';
        mocks.configState.translationApiModel = 'translator-model';
        mocks.gmRequestMock.mockResolvedValueOnce({
            response: { choices: [{ message: { content: '今天下雨。' } }] },
            responseText: '',
        });

        const out = await TranslationService.translate('今日は雨です', 'zh');

        expect(out).toBe('今天下雨。');
        const request = mocks.gmRequestMock.mock.calls[0][0] as unknown as {
            method: string;
            url: string;
            headers: Record<string, string>;
            data: string;
        };
        expect(request.method).toBe('POST');
        expect(request.url).toBe('https://translator.example/v1/chat/completions');
        expect(request.headers.Authorization).toBe('Bearer local-test-token');
        expect(JSON.parse(request.data)).toMatchObject({ model: 'translator-model', temperature: 0 });
    });

    it('falls back to Google when the custom endpoint fails', async () => {
        mocks.configState.translationApiEndpoint = 'https://translator.example/v1/chat/completions';
        mocks.gmRequestMock.mockRejectedValueOnce(new Error('custom unavailable'));

        const out = await TranslationService.translate('今日は雨です', 'en');

        expect(out).toBe('translated:en');
        expect(mocks.gmRequestMock).toHaveBeenCalledTimes(2);
        expect(mocks.gmRequestMock.mock.calls[1][0].url).toContain('translate_a/single');
    });

    it('does not cache a transient Google fallback under the custom provider', async () => {
        mocks.configState.translationApiEndpoint = 'https://translator.example/v1/chat/completions';
        mocks.gmRequestMock.mockRejectedValueOnce(new Error('custom unavailable'));

        await expect(TranslationService.translate('一時的な障害です', 'en')).resolves.toBe('translated:en');
        expect(mocks.cache.size).toBe(0);

        mocks.gmRequestMock.mockResolvedValueOnce({
            response: { choices: [{ message: { content: 'The outage was temporary.' } }] },
            responseText: '',
        });
        await expect(TranslationService.translate('一時的な障害です', 'en'))
            .resolves.toBe('The outage was temporary.');
        expect(mocks.gmRequestMock).toHaveBeenCalledTimes(3);
    });

    it('does not send text or bearer keys to a non-local plain HTTP endpoint', async () => {
        mocks.configState.translationApiEndpoint = 'http://translator.example/v1/chat/completions';
        mocks.configState.translationApiKey = 'must-not-leak';

        const out = await TranslationService.translate('安全な通信', 'en');

        expect(out).toBe('translated:en');
        expect(mocks.gmRequestMock).toHaveBeenCalledTimes(1);
        expect(mocks.gmRequestMock.mock.calls[0][0].url).toContain('https://translate.');
        expect(mocks.gmRequestMock.mock.calls[0][0].headers?.Authorization).toBeUndefined();
    });

    it('caps custom endpoint requests at two across concurrent callers', async () => {
        mocks.configState.translationApiEndpoint = 'https://translator.example/v1/chat/completions';
        const pending: Array<(value: { response: unknown; responseText: string }) => void> = [];
        mocks.gmRequestMock.mockImplementation(() => new Promise(resolve => pending.push(resolve)));

        const translations = [
            TranslationService.translate('一つ目です', 'en'),
            TranslationService.translate('二つ目です', 'en'),
            TranslationService.translate('三つ目です', 'en'),
        ];

        await vi.waitFor(() => expect(mocks.gmRequestMock).toHaveBeenCalledTimes(2));
        expect(pending).toHaveLength(2);
        pending.shift()!({ response: { choices: [{ message: { content: 'First' } }] }, responseText: '' });
        await vi.waitFor(() => expect(mocks.gmRequestMock).toHaveBeenCalledTimes(3));
        pending.shift()!({ response: { choices: [{ message: { content: 'Second' } }] }, responseText: '' });
        pending.shift()!({ response: { choices: [{ message: { content: 'Third' } }] }, responseText: '' });

        await expect(Promise.all(translations)).resolves.toEqual(expect.arrayContaining(['First', 'Second', 'Third']));
    });

    it('keeps an in-flight provider result in the provider cache it started with', async () => {
        mocks.configState.translationApiEndpoint = 'https://provider-a.example/v1/chat/completions';
        mocks.configState.translationApiModel = 'model-a';
        let resolveProviderA!: (value: { response: unknown; responseText: string }) => void;
        mocks.gmRequestMock.mockImplementationOnce(() => new Promise(resolve => {
            resolveProviderA = resolve;
        }));

        const providerA = TranslationService.translate('設定変更中の文章です', 'en');
        await vi.waitFor(() => expect(mocks.gmRequestMock).toHaveBeenCalledTimes(1));

        mocks.configState.translationApiEndpoint = 'https://provider-b.example/v1/chat/completions';
        mocks.configState.translationApiModel = 'model-b';
        mocks.gmRequestMock.mockResolvedValueOnce({
            response: { choices: [{ message: { content: 'Provider B result' } }] },
            responseText: '',
        });
        await expect(TranslationService.translate('設定変更中の文章です', 'en'))
            .resolves.toBe('Provider B result');

        resolveProviderA({
            response: { choices: [{ message: { content: 'Provider A result' } }] },
            responseText: '',
        });
        await expect(providerA).resolves.toBe('Provider A result');

        await expect(TranslationService.translate('設定変更中の文章です', 'en'))
            .resolves.toBe('Provider B result');
        expect(mocks.gmRequestMock).toHaveBeenCalledTimes(2);
    });

    it('reserves per-host pacing slots before concurrent requests wait', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        _testExports.resetRemoteStateForTests();
        const calls: Array<{ host: string; at: number }> = [];
        mocks.gmRequestMock.mockImplementation(async (opts: { url: string }) => {
            calls.push({ host: new URL(opts.url).host, at: Date.now() });
            return {
                responseText: JSON.stringify([[['Translated output', '', '']]]),
                response: undefined,
            };
        });

        try {
            const translations = Promise.all([
                TranslationService.translate('一番目の文章', 'en'),
                TranslationService.translate('二番目の文章', 'en'),
                TranslationService.translate('三番目の文章', 'en'),
                TranslationService.translate('四番目の文章', 'en'),
            ]);
            await vi.advanceTimersByTimeAsync(61);
            await translations;

            const sameHost = calls.filter(call => call.host === 'translate.googleapis.com');
            expect(sameHost).toHaveLength(2);
            expect(sameHost[1].at - sameHost[0].at).toBeGreaterThanOrEqual(60);
        } finally {
            vi.useRealTimers();
        }
    });
});
