import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    bridge: {
        currentWork: undefined as unknown,
        route: { path: '/work/RJ01484672', params: { id: 'RJ01484672' } },
        $watch: vi.fn(),
    },
    handlers: new Map<string, (payload: any) => void>(),
    translate: vi.fn(),
    targetLang: 'zh',
}));

vi.mock('../../src/infrastructure/KikoeruBridge', () => ({
    KikoeruBridge: { getInstance: () => mocks.bridge },
}));

vi.mock('../../src/core/EventBus', () => ({
    EventBus: {
        on: vi.fn((event: string, handler: (payload: any) => void) => {
            mocks.handlers.set(event, handler);
            return () => mocks.handlers.delete(event);
        }),
    },
}));

vi.mock('../../src/services/TranslationService', () => ({
    TranslationService: {
        getUiTargetLang: () => mocks.targetLang,
        isUserLang: vi.fn(() => false),
        translate: mocks.translate,
    },
}));

vi.mock('../../src/core/Utils', () => ({
    Logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { PageTitleManager } from '../../src/features/PageTitleManager';

const flush = async () => {
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
};

describe('PageTitleManager', () => {
    beforeEach(() => {
        document.head.innerHTML = '<title>ASMR Online</title>';
        document.body.innerHTML = '<h1 class="text-h6">作品</h1>';
        mocks.handlers.clear();
        mocks.translate.mockReset();
        mocks.bridge.$watch.mockReset().mockReturnValue(() => undefined);
        mocks.bridge.currentWork = undefined;
        mocks.targetLang = 'zh';
    });

    it('preserves an official Simplified-Chinese work title in a Chinese UI', async () => {
        const title = '【简体中文版】【湿衣若隐×贴身汗味】濒临消亡的村落';
        mocks.bridge.currentWork = {
            id: 1484672,
            title,
            translation_info: { lang: 'CHI_HANS', is_original: false },
        };
        mocks.translate.mockImplementation(async (text: string) => text);

        const manager = new PageTitleManager();
        manager.enable();
        await flush();

        expect(mocks.translate).toHaveBeenCalledWith(title, 'zh', {
            sourceLanguageHint: 'zh',
        });
        expect(document.title).toBe(`${title} - ASMR Online`);
        manager.disable();
    });

    it('reapplies a translated Japanese title after a delayed host overwrite', async () => {
        const source = '限界集落の物語';
        const translated = '边缘村庄的故事';
        mocks.bridge.currentWork = {
            id: 1478227,
            title: source,
            translation_info: { lang: 'JPN', is_original: true },
        };
        mocks.translate.mockResolvedValue(translated);

        const manager = new PageTitleManager();
        manager.enable();
        await flush();
        expect(document.title).toBe(`${translated} - ASMR Online`);

        document.title = 'RJ01478227 - ASMR Online';
        await flush();

        expect(document.title).toBe(`${translated} - ASMR Online`);
        expect(mocks.translate).toHaveBeenLastCalledWith(source, 'zh', {
            sourceLanguageHint: 'ja',
        });
        manager.disable();
    });

    it('translates an original title:update payload using its declared source language', async () => {
        const source = '限界集落';
        const translated = '边缘村庄';
        mocks.bridge.currentWork = {
            id: 1478227,
            title: source,
            translation_info: { lang: 'JPN', is_original: true },
        };
        mocks.translate.mockResolvedValue(translated);

        const manager = new PageTitleManager();
        manager.enable();
        await flush();
        mocks.translate.mockClear();

        mocks.handlers.get('title:update')?.({
            title: source,
            sourceLanguageHint: 'ja',
        });
        await flush();

        expect(mocks.translate).toHaveBeenCalledWith(source, 'zh', {
            sourceLanguageHint: 'ja',
        });
        expect(document.title).toBe(`${translated} - ASMR Online`);
        manager.disable();
    });

    it('rejects captured title callbacks and direct applies after disable', async () => {
        const manager = new PageTitleManager();
        manager.enable();
        const queuedTitleUpdate = mocks.handlers.get('title:update');
        manager.disable();
        document.title = 'Host title';

        queuedTitleUpdate?.({ title: '遅いタイトル', sourceLanguageHint: 'ja' });
        (manager as any).applyTitle('Late title');
        await flush();

        expect(mocks.translate).not.toHaveBeenCalled();
        expect(document.title).toBe('Host title');
    });
});
