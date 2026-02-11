import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const cache = new Map<string, unknown>();
    const configState: Record<string, unknown> = {
        debug: false,
        translateCnToJp: false,
    };
    const gmRequestMock = vi.fn(async (opts: { url: string }) => {
        const tlMatch = opts.url.match(/[?&]tl=([^&]+)/);
        const tl = decodeURIComponent(tlMatch?.[1] || 'en');
        return { responseText: JSON.stringify([[[`translated:${tl}`, '', '']]]) };
    });
    return { cache, configState, gmRequestMock };
});

vi.mock('$', () => ({
    GM_listValues: vi.fn(() => []),
    GM_deleteValue: vi.fn(),
}));

vi.mock('../../src/core/Cache', () => ({
    SharedCache: {
        get: vi.fn((key: string) => mocks.cache.get(key) ?? null),
        set: vi.fn((key: string, value: unknown) => { mocks.cache.set(key, value); }),
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
    I18n: { lang: 'en', t: (k: string) => k, format: (k: string) => k },
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

import { TranslationService } from '../../src/services/TranslationService';

describe('TranslationService CN->JP preference', () => {
    beforeEach(() => {
        mocks.cache.clear();
        mocks.gmRequestMock.mockClear();
        mocks.configState.translateCnToJp = false;
    });

    it('routes Chinese text to Japanese when translateCnToJp is enabled (target en)', async () => {
        mocks.configState.translateCnToJp = true;
        const out = await TranslationService.translate('中文标签', 'en');
        expect(out).toBe('translated:ja');
        expect(mocks.gmRequestMock).toHaveBeenCalledTimes(1);
        expect(mocks.gmRequestMock.mock.calls[0][0].url).toContain('tl=ja');
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
});
