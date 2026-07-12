import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TranslatedTags } from '../../src/features/TranslatedTags';
import { KikoeruBridge } from '../../src/infrastructure/KikoeruBridge';
import { Config } from '../../src/core/Config';
import { TranslationService } from '../../src/services/TranslationService';
import { EventBus } from '../../src/core/EventBus';
import { CentralObserver } from '../../src/core/CentralObserver';

// Mock TagDatabase
vi.mock('../../src/infrastructure/TagDatabase', () => {
    return {
        TagDatabase: vi.fn().mockImplementation(() => {
            return {
                getAllTags: vi.fn().mockResolvedValue([]),
                setTag: vi.fn().mockResolvedValue(1),
                getTag: vi.fn()
            };
        })
    };
});

// Mock CentralObserver
vi.mock('../../src/core/CentralObserver', () => ({
    CentralObserver: {
        register: vi.fn(),
        unregister: vi.fn(),
    }
}));

// Mock EventBus
vi.mock('../../src/core/EventBus', () => ({
    EventBus: {
        on: vi.fn().mockReturnValue(() => {}),
        off: vi.fn(),
        emit: vi.fn(),
    }
}));

// Mock Config and I18n
vi.mock('../../src/core/Config', () => ({
    Config: {
        get: vi.fn().mockReturnValue(true),
    },
    I18n: {
        lang: 'en',
        t: (k: string) => k,
        format: (k: string) => k,
    }
}));

// Mock TranslationService
vi.mock('../../src/services/TranslationService', () => ({
    TranslationService: {
        formatPair: (original: string, translated: string) => {
            if (!translated || translated === original) return original;
            return `${original} (${translated})`;
        },
        autoTranslate: vi.fn().mockResolvedValue(null),
        translate: vi.fn().mockResolvedValue(null),
        translateBatch: vi.fn().mockResolvedValue([]),
        cancelPending: vi.fn(),
        cleanQuotes: (text: string) => text,
        isUserLang: vi.fn().mockReturnValue(false),
        isTargetLanguage: vi.fn().mockReturnValue(false),
        isRateLimited: vi.fn().mockReturnValue(false),
    }
}));

// Mock Logger
vi.mock('../../src/core/Logger', () => ({
    Logger: {
        log: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    }
}));

describe('TranslatedTags', () => {
    let bridge: KikoeruBridge;
    let mockStore: any;

    beforeEach(() => {
        (TranslatedTags as any).instance = null;
        (KikoeruBridge as any).instance = null;
        // Clear global window references used by TranslatedTags singleton
        delete (window as any).__ASMR_TRANSLATED_TAGS__;
        delete (window as any).__ASMR_TRANSLATED_TAGS_VERSION__;

        mockStore = {
            dispatch: vi.fn(),
            state: { AudioPlayer: {} },
        };

        document.body.innerHTML = '<div class="q-header"><input type="search" /></div>';
        document.documentElement.lang = 'en';

        // Bridge setup
        document.body.insertAdjacentHTML('beforeend', '<div id="q-app"></div>');
        const qApp = document.getElementById('q-app');
        if (qApp) (qApp as any).__vue__ = { $store: mockStore, $router: {}, $axios: {} };

        bridge = KikoeruBridge.getInstance();

        vi.mocked(Config.get).mockReset();
        vi.mocked(Config.get).mockReturnValue(true);
        vi.mocked(TranslationService.translateBatch).mockReset();
        vi.mocked(TranslationService.translateBatch).mockResolvedValue([]);
        vi.mocked(TranslationService.cancelPending).mockClear();
        vi.mocked(TranslationService.isUserLang).mockReset();
        vi.mocked(TranslationService.isUserLang).mockReturnValue(false);
        vi.mocked(TranslationService.isTargetLanguage).mockReset();
        vi.mocked(TranslationService.isTargetLanguage).mockReturnValue(false);
        vi.mocked(EventBus.on).mockClear();
        vi.mocked(CentralObserver.register).mockClear();
        vi.mocked(CentralObserver.unregister).mockClear();
    });

    it('should suppress translation during keydown on input fields', async () => {
        await bridge.initialize();

        const translatedTags = TranslatedTags.getInstance();

        // Mock bridge.api.getTags to return empty array
        (bridge as any)._apiClient = {
            getTags: vi.fn().mockResolvedValue({ data: [] }),
        };

        await translatedTags.enable();

        const input = document.querySelector('input[type="search"]') as HTMLInputElement;
        input.value = 'Ear Cleaning';

        // Dispatch Enter keydown
        const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        input.dispatchEvent(event);

        // The new handleKeydown suppresses translation by calling beginDOMModification
        // Verify that isModifyingDOM is true after keydown on an input
        expect((translatedTags as any).modifyingDOMCount).toBeGreaterThan(0);
    });

    it('should augment tag chips with English names via augmentTags()', async () => {
        await bridge.initialize();

        // Set up DOM with a .q-chip element containing a Japanese tag name
        document.body.innerHTML += `
            <div class="q-chip">
                <div class="q-chip__content">耳かき</div>
            </div>
        `;

        const translatedTags = TranslatedTags.getInstance();
        (translatedTags as any).isEnabled = true;
        // Set up the tags cache with a known tag
        (translatedTags as any).tags = [{ id: 53, ja: '耳かき', en: 'Ear Cleaning' }];

        // Call augmentTags directly
        (translatedTags as any).augmentTags();

        const chipContent = document.querySelector('.q-chip__content') as HTMLElement;
        expect(chipContent.textContent).toBe('耳かき (Ear Cleaning)');
    });

    it('should replace Chinese chip text with Japanese when translateMode is off and translateCnToJp is on', async () => {
        await bridge.initialize();
        vi.mocked(Config.get).mockImplementation((key: string) => {
            if (key === 'translateMode') return false;
            if (key === 'translateCnToJp') return true;
            return true;
        });
        vi.mocked(TranslationService.translateBatch).mockResolvedValue(['日本語タグ']);

        document.body.innerHTML += `
            <div class="q-chip">
                <div class="q-chip__content">中文标签</div>
            </div>
        `;

        const translatedTags = TranslatedTags.getInstance();
        (translatedTags as any).isEnabled = true;
        (translatedTags as any).augmentTags();
        for (let i = 0; i < 20; i++) {
            const chipContent = document.querySelector('.q-chip__content') as HTMLElement;
            if (chipContent.textContent === '日本語タグ') break;
            await new Promise(resolve => setTimeout(resolve, 10));
        }

        expect(vi.mocked(TranslationService.translateBatch)).toHaveBeenCalledWith(
            ['中文标签'],
            'ja',
            expect.objectContaining({ cancellable: true }),
        );
        const chipContent = document.querySelector('.q-chip__content') as HTMLElement;
        expect(chipContent.textContent).toBe('日本語タグ');
    });

    it('should skip non-Chinese text in CN-only mode', async () => {
        await bridge.initialize();
        vi.mocked(Config.get).mockImplementation((key: string) => {
            if (key === 'translateMode') return false;
            if (key === 'translateCnToJp') return true;
            return true;
        });

        document.body.innerHTML += `
            <div class="q-chip">
                <div class="q-chip__content">耳かき</div>
            </div>
        `;

        const translatedTags = TranslatedTags.getInstance();
        (translatedTags as any).isEnabled = true;
        (translatedTags as any).augmentTags();
        await Promise.resolve();

        const chipContent = document.querySelector('.q-chip__content') as HTMLElement;
        expect(chipContent.textContent).toBe('耳かき');
        expect(vi.mocked(TranslationService.translateBatch)).not.toHaveBeenCalled();
    });

    it('does not skip ambiguous Han-only work text when translating to Chinese', () => {
        vi.mocked(TranslationService.isTargetLanguage).mockReturnValue(true);
        const translatedTags = TranslatedTags.getInstance();

        expect((translatedTags as any).shouldSkipAutoTranslate('限界集落', 'zh-CN')).toBe(false);
        expect(TranslationService.isTargetLanguage).not.toHaveBeenCalled();
    });

    it('treats an unannotated Han-only card title as Japanese under clean defaults', async () => {
        await bridge.initialize();
        // The host UI locale describes controls, not the language of every
        // work card. It must not override Japanese-first content inference.
        document.documentElement.lang = 'zh-CN';
        vi.mocked(Config.get).mockImplementation((key: string) => {
            if (key === 'translateMode' || key === 'translateCnToJp') return true;
            return true;
        });
        vi.mocked(TranslationService.translateBatch).mockResolvedValue(['Marginal village']);

        document.body.innerHTML += `
            <div class="q-card">
                <div class="ellipsis-3-lines"><a href="/work/RJ000001">限界集落</a></div>
            </div>
        `;

        const translatedTags = TranslatedTags.getInstance();
        (translatedTags as any).isEnabled = true;
        (translatedTags as any).augmentTags();
        await vi.waitFor(() => {
            expect(document.querySelector('.asmr-card-translation')?.textContent)
                .toContain('Marginal village');
        });

        expect(TranslationService.translateBatch).toHaveBeenCalledWith(
            ['限界集落'],
            'en',
            expect.objectContaining({ sourceLanguageHint: 'ja' }),
        );
    });

    it('honors explicit Chinese edition metadata for a Han-only card title', async () => {
        await bridge.initialize();
        vi.mocked(Config.get).mockImplementation((key: string) => {
            if (key === 'translateMode' || key === 'translateCnToJp') return true;
            return true;
        });
        vi.mocked(TranslationService.translateBatch).mockResolvedValue(['おやすみ耳語り']);

        document.body.innerHTML += `
            <div class="q-card" lang="zh-CN">
                <div class="ellipsis-3-lines"><a href="/work/RJ000002">晚安耳语</a></div>
            </div>
        `;

        const translatedTags = TranslatedTags.getInstance();
        (translatedTags as any).isEnabled = true;
        (translatedTags as any).augmentTags();
        await vi.waitFor(() => {
            expect(document.querySelector('.asmr-card-translation')?.textContent)
                .toContain('おやすみ耳語り');
        });

        expect(TranslationService.translateBatch).toHaveBeenCalledWith(
            ['晚安耳语'],
            'en',
            expect.objectContaining({ sourceLanguageHint: 'zh' }),
        );
    });

    it('makes a clamped card translation keyboard-readable and expandable in place', () => {
        const translatedTags = TranslatedTags.getInstance();
        const translation = document.createElement('button');
        translation.className = 'asmr-card-translation';
        document.body.appendChild(translation);
        const fullText = 'This is the complete translated card description that must remain readable.';

        (translatedTags as any).setExpandableCardTranslation(translation, fullText);

        expect(translation.querySelector('.asmr-card-translation-text')?.textContent).toBe(fullText);
        expect(translation.title).toBe(fullText);
        expect(translation.getAttribute('aria-expanded')).toBe('false');

        translation.click();
        expect(translation.classList.contains('asmr-card-translation--expanded')).toBe(true);
        expect(translation.getAttribute('aria-expanded')).toBe('true');
        expect(translation.querySelector('.asmr-card-translation-toggle')?.textContent).toBe('expand_less');
    });

    it('restores a raw CN-to-JP replacement when the feature is disabled', () => {
        const translatedTags = TranslatedTags.getInstance();
        const el = document.createElement('span');
        el.textContent = '晚安耳语';
        document.body.appendChild(el);

        (translatedTags as any).markTranslationPending(el, '晚安耳语');
        (translatedTags as any).finalizeTranslation(
            el,
            '晚安耳语',
            'おやすみ囁き',
            (value: string) => { el.textContent = value; },
        );
        (translatedTags as any).isEnabled = true;
        translatedTags.disable();

        expect(el.textContent).toBe('晚安耳语');
        expect(el.hasAttribute('data-asmrtag')).toBe(false);
        expect(el.hasAttribute('data-asmrtag-translation')).toBe(false);
        expect(el.classList.contains('asmr-translated')).toBe(false);
    });

    it('should keep breadcrumb base text stable and apply translation as worktree suffix', async () => {
        await bridge.initialize();
        vi.mocked(TranslationService.translateBatch).mockResolvedValue(['Main story']);

        document.body.innerHTML += `
            <div id="work-tree">
                <span class="q-breadcrumbs__el"><span>【本編】長乳エルフお姉さん</span></span>
            </div>
        `;

        const translatedTags = TranslatedTags.getInstance();
        (translatedTags as any).isEnabled = true;
        (translatedTags as any).augmentTags();

        const crumb = document.querySelector('#work-tree .q-breadcrumbs__el span') as HTMLElement;
        for (let i = 0; i < 20; i++) {
            if (crumb.dataset.asmrtagState === 'done') break;
            await new Promise(resolve => setTimeout(resolve, 10));
        }

        expect(crumb.textContent).toBe('【本編】長乳エルフお姉さん');
        expect(crumb.classList.contains('asmr-worktree-translation')).toBe(true);
        expect(crumb.dataset.asmrtagTranslation).toBe('Main story');
    });

    it('should strip legacy inline breadcrumb translation before re-translating', async () => {
        await bridge.initialize();
        vi.mocked(TranslationService.translateBatch).mockResolvedValue(['Main story']);

        document.body.innerHTML += `
            <div id="work-tree">
                <span class="q-breadcrumbs__el">
                    <span class="asmr-translated" data-asmrtag="【本編】長乳エルフお姉さん" data-asmrtag-state="done">
                        【本編】長乳エルフお姉さん (Main story)
                    </span>
                </span>
            </div>
        `;

        const translatedTags = TranslatedTags.getInstance();
        (translatedTags as any).isEnabled = true;
        (translatedTags as any).augmentTags();

        const crumb = document.querySelector('#work-tree .q-breadcrumbs__el span') as HTMLElement;
        for (let i = 0; i < 20; i++) {
            if (crumb.dataset.asmrtagState === 'done' && crumb.classList.contains('asmr-worktree-translation')) break;
            await new Promise(resolve => setTimeout(resolve, 10));
        }

        expect(crumb.textContent).toBe('【本編】長乳エルフお姉さん');
        expect(crumb.classList.contains('asmr-worktree-translation')).toBe(true);
        expect(crumb.dataset.asmrtagTranslation).toBe('Main story');
    });

    it('clears stale translated state in player surfaces', async () => {
        await bridge.initialize();
        document.body.innerHTML += `
            <div class="audio-player">
                <div
                    class="q-item__label asmr-translated asmr-worktree-translation"
                    data-asmrtag="古いタイトル.wav"
                    data-asmrtag-state="done"
                    data-asmrtag-translation="Old title.wav"
                >
                    古いタイトル.wav
                </div>
            </div>
        `;

        const translatedTags = TranslatedTags.getInstance();
        (translatedTags as any).resetPlayerTranslationState();

        const label = document.querySelector('.audio-player .q-item__label') as HTMLElement;
        expect(label.hasAttribute('data-asmrtag')).toBe(false);
        expect(label.hasAttribute('data-asmrtag-state')).toBe(false);
        expect(label.hasAttribute('data-asmrtag-translation')).toBe(false);
        expect(label.classList.contains('asmr-translated')).toBe(false);
        expect(label.classList.contains('asmr-worktree-translation')).toBe(false);
    });

    it('cancels active translation queue on track change', async () => {
        await bridge.initialize();

        const translatedTags = TranslatedTags.getInstance();
        (bridge as any)._apiClient = {
            getTags: vi.fn().mockResolvedValue({ data: [] }),
        };
        await translatedTags.enable();

        (translatedTags as any).activeQueueKey = 'translated-tags:RJ999|/work/RJ999';
        const trackChangeCall = [...vi.mocked(EventBus.on).mock.calls]
            .reverse()
            .find(([event]) => event === 'track:change');
        expect(trackChangeCall).toBeTruthy();

        const trackChangeHandler = trackChangeCall?.[1] as (payload: unknown) => void;
        trackChangeHandler({ track: { title: 'next' } });

        expect(vi.mocked(TranslationService.cancelPending)).toHaveBeenCalledWith({
            cancellableKey: 'translated-tags:RJ999|/work/RJ999'
        });
    });

    it('cannot resurrect after disable while the tag cache is still loading', async () => {
        await bridge.initialize();
        let resolveTags!: (value: { data: unknown[] }) => void;
        const getTags = vi.fn(() => new Promise<{ data: unknown[] }>((resolve) => {
            resolveTags = resolve;
        }));
        (bridge as any)._apiClient = { getTags };
        const translatedTags = TranslatedTags.getInstance();

        const firstEnable = translatedTags.enable();
        const duplicateEnable = translatedTags.enable();
        translatedTags.disable();
        resolveTags({ data: [] });
        await Promise.all([firstEnable, duplicateEnable]);

        expect(getTags).toHaveBeenCalledOnce();
        expect((translatedTags as any).isEnabled).toBe(false);
        expect(CentralObserver.register).not.toHaveBeenCalled();
        expect(EventBus.on).not.toHaveBeenCalled();
    });

    it('rejects captured observer and animation-frame callbacks after disable', async () => {
        await bridge.initialize();
        (bridge as any)._apiClient = {
            getTags: vi.fn().mockResolvedValue({ data: [] }),
        };
        let queuedFrame: FrameRequestCallback | null = null;
        const requestSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
            queuedFrame = callback;
            return 77;
        });
        const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
        const translatedTags = TranslatedTags.getInstance();
        await translatedTags.enable();
        const observerCallback = vi.mocked(CentralObserver.register).mock.calls[0]?.[1] as (() => void) | undefined;
        const trackHandler = vi.mocked(EventBus.on).mock.calls
            .find(([event]) => event === 'track:change')?.[1] as ((payload: unknown) => void) | undefined;

        trackHandler?.({ track: { title: 'next' } });
        translatedTags.disable();
        document.body.insertAdjacentHTML('beforeend', `
            <div class="q-chip"><div class="q-chip__content">耳かき</div></div>
        `);
        observerCallback?.();
        expect(queuedFrame).not.toBeNull();
        (queuedFrame as unknown as FrameRequestCallback)(performance.now());

        const chip = document.querySelector('.q-chip') as HTMLElement;
        expect(chip.hasAttribute('data-asmrtag')).toBe(false);
        expect(chip.textContent).toContain('耳かき');
        expect(cancelSpy).toHaveBeenCalledWith(77);

        requestSpy.mockRestore();
        cancelSpy.mockRestore();
    });
});
