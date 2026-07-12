import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    lang: 'en',
    config: {
        translateMode: true,
        translateCnToJp: false,
    } as Record<string, unknown>,
    observerCallback: null as (() => void) | null,
}));

vi.mock('../../src/core/CentralObserver', () => ({
    CentralObserver: {
        register: vi.fn((_name: string, callback: () => void) => {
            mocks.observerCallback = callback;
        }),
        unregister: vi.fn(),
    },
}));

vi.mock('../../src/core/Utils', () => ({
    I18n: {
        get lang() { return mocks.lang; },
    },
    Logger: {
        debug: vi.fn(),
    },
}));

vi.mock('../../src/store/AppStore', () => ({
    AppStore: {
        getConfig: vi.fn((key: string) => mocks.config[key]),
    },
}));

import { InterfaceTranslator } from '../../src/features/InterfaceTranslator';

describe('InterfaceTranslator locale targeting', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        mocks.lang = 'en';
        mocks.config.translateMode = true;
        mocks.config.translateCnToJp = false;
        mocks.observerCallback = null;
    });

    function translateLabel(text: string): string {
        document.body.innerHTML = `<div class="q-btn__content"><span>${text}</span></div>`;
        const translator = InterfaceTranslator.getInstance() as unknown as {
            _enabled: boolean;
            translate(): void;
        };
        translator._enabled = true;
        translator.translate();
        translator._enabled = false;
        return document.querySelector('span')?.textContent || '';
    }

    it('maps Japanese controls to Chinese in Chinese UI mode', () => {
        mocks.lang = 'zh-CN';
        expect(translateLabel('リリース日')).toBe('发布日期');
    });

    it('maps Chinese controls to Japanese in Japanese UI mode', () => {
        mocks.lang = 'ja';
        expect(translateLabel('发布时间')).toBe('リリース日');
    });

    it('retains the English map in English UI mode', () => {
        expect(translateLabel('リリース日')).toBe('Release Date');
    });

    it('replaces Chinese controls with Japanese primary plus English when both modes are enabled', () => {
        mocks.config.translateCnToJp = true;
        expect(translateLabel('发布时间')).toBe('リリース日 (Release Date)');
        expect(translateLabel('🔥 热门作品')).toBe('🔥 人気作品 (🔥 Popular works)');
    });

    it('restores host text when the feature is disabled', () => {
        document.body.innerHTML = '<div class="q-btn__content"><span>リリース日</span></div>';
        const translator = InterfaceTranslator.getInstance();

        translator.enable();
        expect(document.querySelector('span')?.textContent).toBe('Release Date');

        translator.disable();
        expect(document.querySelector('span')?.textContent).toBe('リリース日');
        expect(document.querySelector('[data-asmritran]')).toBeNull();
    });

    it('rejects a captured observer callback after disable', () => {
        document.body.innerHTML = '<div class="q-btn__content"><span>リリース日</span></div>';
        const translator = InterfaceTranslator.getInstance();
        translator.enable();
        const queued = mocks.observerCallback;
        translator.disable();

        document.body.innerHTML = '<div class="q-btn__content"><span>リリース日</span></div>';
        queued?.();

        expect(document.querySelector('span')?.textContent).toBe('リリース日');
        expect(document.querySelector('[data-asmritran]')).toBeNull();
    });
});
