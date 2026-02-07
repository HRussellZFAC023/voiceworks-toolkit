import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TranslatedTags } from '../../src/features/TranslatedTags';
import { KikoeruBridge } from '../../src/infrastructure/KikoeruBridge';

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
        cleanQuotes: (text: string) => text,
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
});
