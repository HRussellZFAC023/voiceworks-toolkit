import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TranslatedTags } from '../../src/features/TranslatedTags';
import { KikoeruBridge } from '../../src/infrastructure/KikoeruBridge';
import { Config } from '../../src/core/Config';
import { TranslationService } from '../../src/services/TranslationService';

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
        (translatedTags as any).augmentTags();
        await Promise.resolve();

        const chipContent = document.querySelector('.q-chip__content') as HTMLElement;
        expect(chipContent.textContent).toBe('耳かき');
        expect(vi.mocked(TranslationService.translateBatch)).not.toHaveBeenCalled();
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
});
