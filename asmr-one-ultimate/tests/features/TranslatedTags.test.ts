import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { TranslatedTags } from '../../src/features/TranslatedTags';
import { KikoeruBridge } from '../../src/infrastructure/KikoeruBridge';
import { Config, I18n } from '../../src/core/Config';
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
vi.mock('../../src/services/TranslationService', () => {
    const translateBatch = vi.fn().mockResolvedValue([]);
    return { TranslationService: {
        formatPair: (original: string, translated: string) => {
            if (!translated || translated === original) return original;
            return `${original} (${translated})`;
        },
        autoTranslate: vi.fn().mockResolvedValue(null),
        translate: vi.fn().mockResolvedValue(null),
        translateBatch,
        translateForDisplayBatch: vi.fn(async (texts: string[], targetLang: string, options?: { sourceLanguageHint?: string }) => {
            const translated = await translateBatch(texts, targetLang, options);
            return texts.map((text, index) => {
                const value = translated[index] || text;
                const promoted = options?.sourceLanguageHint === 'zh' && value !== text;
                return {
                    sourceText: text,
                    sourceLanguage: options?.sourceLanguageHint === 'zh' ? 'zh' : 'ja',
                    primaryText: promoted ? value : text,
                    primaryLanguage: promoted ? 'ja' : (options?.sourceLanguageHint === 'zh' ? 'zh' : 'ja'),
                    secondaryText: promoted || value === text ? undefined : value,
                    secondaryLanguage: promoted || value === text ? undefined : targetLang,
                };
            });
        }),
        cancelPending: vi.fn(),
        cleanQuotes: (text: string) => text,
        isUserLang: vi.fn().mockReturnValue(false),
        isTargetLanguage: vi.fn().mockReturnValue(false),
        isRateLimited: vi.fn().mockReturnValue(false),
    } };
});

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

/**
 * jsdom does not render pseudo-elements, so reproduce what the injected
 * `.asmr-worktree-translation::after { content: " (" attr(data-asmrtag-translation) ")" }`
 * rule paints. This is what the user actually reads on screen.
 */
function renderWithSuffixes(root: Element): string {
    let out = '';
    for (const node of Array.from(root.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE) out += node.textContent || '';
        else if (node instanceof Element) out += renderWithSuffixes(node);
    }
    if (root instanceof HTMLElement
        && root.classList.contains('asmr-worktree-translation')
        && root.dataset.asmrtagTranslation) {
        out += ` (${root.dataset.asmrtagTranslation})`;
    }
    return out.replace(/\s+/g, ' ').trim();
}

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
        vi.mocked(TranslationService.translateForDisplayBatch).mockClear();
        vi.mocked(TranslationService.isUserLang).mockReset();
        vi.mocked(TranslationService.isUserLang).mockReturnValue(false);
        vi.mocked(TranslationService.isTargetLanguage).mockReset();
        vi.mocked(TranslationService.isTargetLanguage).mockReturnValue(false);
        vi.mocked(EventBus.on).mockClear();
        vi.mocked(CentralObserver.register).mockClear();
        vi.mocked(CentralObserver.unregister).mockClear();
        (I18n as { lang: string }).lang = 'en';
        window.history.pushState({}, '', '/');
    });

    afterEach(() => {
        (I18n as { lang: string }).lang = 'en';
        window.history.pushState({}, '', '/');
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
        vi.mocked(TranslationService.translateForDisplayBatch).mockResolvedValueOnce([{
            sourceText: '晚安耳语',
            sourceLanguage: 'zh',
            primaryText: 'おやすみ耳語り',
            primaryLanguage: 'ja',
            secondaryText: 'Goodnight whispers',
            secondaryLanguage: 'en',
        }]);

        document.body.innerHTML += `
            <div class="q-card" lang="zh-CN">
                <div class="ellipsis-3-lines"><a href="/work/RJ000002">晚安耳语</a></div>
            </div>
        `;

        const translatedTags = TranslatedTags.getInstance();
        (translatedTags as any).isEnabled = true;
        (translatedTags as any).augmentTags();
        await vi.waitFor(() => {
            expect(document.querySelector('.q-card a')?.textContent).toBe('おやすみ耳語り');
            expect(document.querySelector('.asmr-card-translation')?.textContent)
                .toContain('Goodnight whispers');
        });

        expect(TranslationService.translateForDisplayBatch).toHaveBeenCalledWith(
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

    it('renders one suffix per breadcrumb label when Quasar wraps it in nested spans', async () => {
        await bridge.initialize();
        vi.mocked(TranslationService.translateBatch).mockResolvedValue(['compression']);

        // Real Quasar breadcrumb markup: the crumb is a q-btn, so the label sits
        // inside `.q-btn__content` > `span.block` and `.q-breadcrumbs__el span`
        // matches it three times.
        document.body.innerHTML += `
            <div id="work-tree">
                <div class="q-breadcrumbs">
                    <button class="q-btn q-breadcrumbs__el">
                        <span class="q-focus-helper"></span>
                        <span class="q-btn__content text-center col items-center q-anchor--skip justify-center row">
                            <span class="block">圧縮</span>
                        </span>
                    </button>
                </div>
            </div>
        `;

        const translatedTags = TranslatedTags.getInstance();
        (translatedTags as any).isEnabled = true;
        (translatedTags as any).augmentTags();

        const crumb = document.querySelector('#work-tree .q-breadcrumbs__el') as HTMLElement;
        for (let i = 0; i < 20; i++) {
            if (crumb.querySelector('.asmr-worktree-translation')) break;
            await new Promise(resolve => setTimeout(resolve, 10));
        }

        expect(renderWithSuffixes(crumb)).toBe('圧縮 (compression)');
        expect(crumb.querySelectorAll('.asmr-worktree-translation')).toHaveLength(1);
    });

    it('is idempotent — a second pass over translated breadcrumbs changes nothing', async () => {
        await bridge.initialize();
        vi.mocked(TranslationService.translateBatch).mockResolvedValue(['compression']);

        document.body.innerHTML += `
            <div id="work-tree">
                <div class="q-breadcrumbs">
                    <button class="q-btn q-breadcrumbs__el">
                        <span class="q-focus-helper"></span>
                        <span class="q-btn__content">
                            <span class="block">圧縮</span>
                        </span>
                    </button>
                </div>
            </div>
        `;

        const translatedTags = TranslatedTags.getInstance();
        (translatedTags as any).isEnabled = true;
        (translatedTags as any).augmentTags();

        const crumb = document.querySelector('#work-tree .q-breadcrumbs__el') as HTMLElement;
        for (let i = 0; i < 20; i++) {
            if (crumb.querySelector('.asmr-worktree-translation')) break;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        const afterFirstPass = crumb.outerHTML;

        (translatedTags as any).augmentTags();
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(crumb.outerHTML).toBe(afterFirstPass);
        expect(renderWithSuffixes(crumb)).toBe('圧縮 (compression)');
    });

    it('still suffixes a nested label that carries a different original', () => {
        const translatedTags = TranslatedTags.getInstance();
        document.body.innerHTML += `
            <div id="work-tree">
                <div class="outer" data-asmrtag="親フォルダ"></div>
            </div>
        `;
        const outer = document.querySelector('.outer') as HTMLElement;
        const inner = document.createElement('span');
        inner.textContent = '子ファイル.wav';
        outer.appendChild(inner);

        (translatedTags as any).applyWorkTreeTranslation(outer, '親フォルダ', 'Parent folder');
        (translatedTags as any).applyWorkTreeTranslation(inner, '子ファイル.wav', 'Child file.wav');

        // Different labels — each keeps its own suffix.
        expect(outer.classList.contains('asmr-worktree-translation')).toBe(true);
        expect(inner.classList.contains('asmr-worktree-translation')).toBe(true);
        expect(inner.dataset.asmrtagSuffix).toBeUndefined();
    });

    it('suppresses the second suffix when the same label is marked twice in one chain', () => {
        const translatedTags = TranslatedTags.getInstance();
        document.body.innerHTML += `
            <div id="work-tree">
                <span class="outer" data-asmrtag="圧縮"><span class="inner">圧縮</span></span>
            </div>
        `;
        const outer = document.querySelector('.outer') as HTMLElement;
        const inner = document.querySelector('.inner') as HTMLElement;
        inner.dataset.asmrtag = '圧縮';

        (translatedTags as any).applyWorkTreeTranslation(outer, '圧縮', 'compression');
        (translatedTags as any).applyWorkTreeTranslation(inner, '圧縮', 'compression');

        expect(outer.classList.contains('asmr-worktree-translation')).toBe(true);
        expect(inner.classList.contains('asmr-worktree-translation')).toBe(false);
        expect(inner.dataset.asmrtagSuffix).toBe('nested');
        expect(renderWithSuffixes(outer)).toBe('圧縮 (compression)');
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

    // =========================================================================
    // Keeping up with the host: mutation bursts, route changes, card recycling
    // =========================================================================

    it('takes every mutation signal and coalesces it into a guaranteed pass', async () => {
        await bridge.initialize();
        (bridge as any)._apiClient = { getTags: vi.fn().mockResolvedValue({ data: [] }) };
        const translatedTags = TranslatedTags.getInstance();
        await translatedTags.enable();

        // A per-feature debounce on CentralObserver silently drops runs inside
        // its window, which is why late content stayed untranslated. Own the
        // debouncing instead so no signal is ever discarded.
        expect(CentralObserver.register).toHaveBeenCalledWith('TranslatedTags', expect.any(Function), 0);
        const observerCallback = vi.mocked(CentralObserver.register).mock.calls[0][1] as () => void;
        const augmentSpy = vi.spyOn(translatedTags as any, 'augmentTags');

        observerCallback();
        observerCallback();
        observerCallback();
        expect(augmentSpy).not.toHaveBeenCalled();

        await vi.waitFor(() => expect(augmentSpy).toHaveBeenCalledTimes(1));
    });

    it('re-translates after a route change instead of waiting for an unrelated mutation', async () => {
        await bridge.initialize();
        (bridge as any)._apiClient = { getTags: vi.fn().mockResolvedValue({ data: [] }) };
        let routeWatcher: ((next: string, prev: string) => void) | null = null;
        (bridge as any).$watch = vi.fn((_getter: unknown, callback: (next: string, prev: string) => void) => {
            routeWatcher = callback;
            return () => {};
        });
        const translatedTags = TranslatedTags.getInstance();
        await translatedTags.enable();

        const augmentSpy = vi.spyOn(translatedTags as any, 'augmentTags');
        expect(routeWatcher).toBeTruthy();
        (routeWatcher as unknown as (next: string, prev: string) => void)(
            'RJ2|/work/RJ2',
            'RJ1|/work/RJ1',
        );

        // The route change cancels every in-flight batch, so without an explicit
        // re-run the new page renders untranslated.
        await vi.waitFor(() => expect(augmentSpy).toHaveBeenCalled());
    });

    it('reacts to an in-place text rewrite when Vue recycles a card', async () => {
        await bridge.initialize();
        (bridge as any)._apiClient = { getTags: vi.fn().mockResolvedValue({ data: [] }) };
        const translatedTags = TranslatedTags.getInstance();
        await translatedTags.enable();

        const qApp = document.getElementById('q-app') as HTMLElement;
        qApp.insertAdjacentHTML('beforeend', `
            <div class="q-card">
                <div class="ellipsis-3-lines"><a href="/work/RJ000001">耳かき</a></div>
            </div>
        `);
        const link = qApp.querySelector('a[href*="/work/"]') as HTMLElement;
        (translatedTags as any).refresh.cancel();
        expect((translatedTags as any).refresh.pending).toBe(false);

        // Vue 2 patches a re-used node by writing to the existing text node.
        // That emits characterData and nothing else — CentralObserver only
        // watches childList, so this is the recycling case it cannot see.
        (link.firstChild as Text).data = '囁き';

        await vi.waitFor(() => expect((translatedTags as any).refresh.pending).toBe(true));
    });

    it('stops watching in-place text edits after disable', async () => {
        await bridge.initialize();
        (bridge as any)._apiClient = { getTags: vi.fn().mockResolvedValue({ data: [] }) };
        const translatedTags = TranslatedTags.getInstance();
        await translatedTags.enable();
        expect((translatedTags as any).textObserver).not.toBeNull();

        translatedTags.disable();

        expect((translatedTags as any).textObserver).toBeNull();
        expect((translatedTags as any).refresh.pending).toBe(false);
    });

    // =========================================================================
    // One translation per label
    // =========================================================================

    it('gives a list-view work row exactly one translation', async () => {
        await bridge.initialize();
        window.history.pushState({}, '', '/works');
        vi.mocked(TranslationService.translateBatch).mockResolvedValue(['Ear cleaning']);

        document.body.insertAdjacentHTML('beforeend', `
            <div class="q-list">
                <div class="q-item">
                    <a href="/work/RJ000001"></a>
                    <div class="q-item__label text-body2">耳かき</div>
                </div>
            </div>
        `);

        const translatedTags = TranslatedTags.getInstance();
        (translatedTags as any).isEnabled = true;
        (translatedTags as any).augmentTags();

        await vi.waitFor(() => {
            expect(document.querySelector('.asmr-card-translation')).not.toBeNull();
        });

        const label = document.querySelector('.q-item__label.text-body2') as HTMLElement;
        // The generic list pass would have rewritten the label to
        // "耳かき (Ear cleaning)" while the work-title pass added the subtitle,
        // rendering the translation twice.
        expect(label.textContent).toBe('耳かき');
        expect(document.querySelectorAll('.asmr-card-translation')).toHaveLength(1);
        expect(label.title).toBe('耳かき (Ear cleaning)');
    });

    it('leaves player queue rows to PlayerTranslator', async () => {
        await bridge.initialize();
        window.history.pushState({}, '', '/works');

        document.body.insertAdjacentHTML('beforeend', `
            <div class="current-play-list">
                <div class="q-list">
                    <div class="q-item">
                        <div class="q-item__label">安眠用耳かき.wav</div>
                    </div>
                </div>
            </div>
        `);

        const translatedTags = TranslatedTags.getInstance();
        (translatedTags as any).isEnabled = true;
        (translatedTags as any).augmentTags();
        await new Promise(resolve => setTimeout(resolve, 20));

        const label = document.querySelector('.current-play-list .q-item__label') as HTMLElement;
        expect(label.hasAttribute('data-asmrtag')).toBe(false);
        expect(label.textContent?.trim()).toBe('安眠用耳かき.wav');
        expect(TranslationService.translateForDisplayBatch).not.toHaveBeenCalled();
    });

    it('queues an element at most once even when several selectors match it', async () => {
        await bridge.initialize();
        const translatedTags = TranslatedTags.getInstance();
        (translatedTags as any).isEnabled = true;
        window.history.pushState({}, '', '/works');

        document.body.insertAdjacentHTML('beforeend', `
            <div class="q-list">
                <div class="q-item">
                    <a href="/work/RJ000002"></a>
                    <div class="q-item__label text-body2">耳かき</div>
                </div>
            </div>
        `);

        (translatedTags as any).augmentTags();

        const requestedTexts = vi.mocked(TranslationService.translateForDisplayBatch).mock.calls
            .flatMap(([texts]) => texts as string[]);
        expect(requestedTexts).toEqual(['耳かき']);
    });

    // =========================================================================
    // Full text stays reachable
    // =========================================================================

    it('keeps the untruncated original and translation reachable on a clamped card title', async () => {
        await bridge.initialize();
        vi.mocked(TranslationService.translateBatch).mockResolvedValue(['Sweet whispered ear cleaning for a restful night']);

        document.body.insertAdjacentHTML('beforeend', `
            <div class="q-card">
                <div class="ellipsis-3-lines"><a href="/work/RJ000003">安眠のための甘い囁き耳かき</a></div>
            </div>
        `);

        const translatedTags = TranslatedTags.getInstance();
        (translatedTags as any).isEnabled = true;
        (translatedTags as any).augmentTags();

        await vi.waitFor(() => {
            expect(document.querySelector('.asmr-card-translation')).not.toBeNull();
        });

        const link = document.querySelector('.q-card a') as HTMLElement;
        const sub = document.querySelector('.asmr-card-translation') as HTMLElement;
        // Host clamps both lines, so neither the original nor the translation is
        // fully readable from the rendered text alone.
        expect(link.title).toBe('安眠のための甘い囁き耳かき (Sweet whispered ear cleaning for a restful night)');
        expect(sub.title).toBe('Sweet whispered ear cleaning for a restful night');
        expect(sub.getAttribute('aria-expanded')).toBe('false');
        expect(sub.tagName).toBe('BUTTON');
    });

    it('drops a tooltip left over from a recycled label', () => {
        const translatedTags = TranslatedTags.getInstance();
        const el = document.createElement('div');
        el.textContent = '耳かき';
        document.body.appendChild(el);

        (translatedTags as any).markTranslationPending(el, '耳かき');
        (translatedTags as any).finalizeTranslation(el, '耳かき', 'Ear cleaning', (value: string) => {
            el.textContent = value;
            el.title = value;
        });
        expect(el.title).toBe('Ear cleaning');

        (translatedTags as any).clearTranslationPending(el, true);
        expect(el.hasAttribute('title')).toBe(false);
    });

    // =========================================================================
    // Chinese as a first-class reading language
    // =========================================================================

    it('uses the official Chinese tag name for a Chinese reader instead of a machine round-trip', async () => {
        await bridge.initialize();
        (I18n as { lang: string }).lang = 'zh';

        document.body.insertAdjacentHTML('beforeend', `
            <div class="q-chip"><div class="q-chip__content">耳かき</div></div>
        `);

        const translatedTags = TranslatedTags.getInstance();
        (translatedTags as any).isEnabled = true;
        (translatedTags as any).tags = [{
            id: 53,
            ja: '耳かき',
            en: 'Ear Cleaning',
            i18n: { 'zh-cn': { name: '掏耳' }, 'en-us': { name: 'Ear Cleaning' } },
        }];

        (translatedTags as any).augmentTags();

        const chipContent = document.querySelector('.q-chip__content') as HTMLElement;
        const chip = document.querySelector('.q-chip') as HTMLElement;
        expect(chipContent.textContent).toBe('耳かき (掏耳)');
        // Chips are clipped to a fixed max-width; the tag must stay readable.
        expect(chip.title).toBe('耳かき (掏耳)');
        expect(TranslationService.translateForDisplayBatch).not.toHaveBeenCalled();
    });

    it('targets Chinese for a Chinese reader and sends the Japanese source hint', async () => {
        await bridge.initialize();
        (I18n as { lang: string }).lang = 'zh';
        vi.mocked(TranslationService.translateBatch).mockResolvedValue(['掏耳朵']);

        document.body.insertAdjacentHTML('beforeend', `
            <div class="q-card">
                <div class="ellipsis-3-lines"><a href="/work/RJ000004">耳かき</a></div>
            </div>
        `);

        const translatedTags = TranslatedTags.getInstance();
        (translatedTags as any).isEnabled = true;
        expect((translatedTags as any).targetLang).toBe('zh-CN');
        (translatedTags as any).augmentTags();

        await vi.waitFor(() => {
            expect(document.querySelector('.asmr-card-translation')?.textContent).toContain('掏耳朵');
        });
        expect(TranslationService.translateForDisplayBatch).toHaveBeenCalledWith(
            ['耳かき'],
            'zh-CN',
            expect.objectContaining({ sourceLanguageHint: 'ja' }),
        );
        // The Japanese original is preserved; the Chinese lane is additive.
        expect(document.querySelector('.q-card a')?.textContent).toBe('耳かき');
    });

    it('replaces a Chinese-edition title with Japanese and carries the Chinese lane off it', async () => {
        await bridge.initialize();
        (I18n as { lang: string }).lang = 'zh';
        vi.mocked(TranslationService.translateForDisplayBatch).mockResolvedValueOnce([{
            sourceText: '晚安耳语',
            sourceLanguage: 'zh',
            primaryText: 'おやすみ耳語り',
            primaryLanguage: 'ja',
            secondaryText: '晚安低语',
            secondaryLanguage: 'zh',
        }]);

        document.body.insertAdjacentHTML('beforeend', `
            <div class="q-card" lang="zh-CN">
                <div class="ellipsis-3-lines"><a href="/work/RJ000005">晚安耳语</a></div>
            </div>
        `);

        const translatedTags = TranslatedTags.getInstance();
        (translatedTags as any).isEnabled = true;
        (translatedTags as any).augmentTags();

        await vi.waitFor(() => {
            expect(document.querySelector('.q-card a')?.textContent).toBe('おやすみ耳語り');
        });
        expect(document.querySelector('.asmr-card-translation')?.textContent).toContain('晚安低语');
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
