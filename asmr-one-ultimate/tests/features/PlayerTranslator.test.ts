import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const appStoreMock = {
        getConfig: vi.fn((key: string) => {
            if (key === 'translateMode') return true;
            if (key === 'translateCnToJp') return false;
            return false;
        }),
        currentTrack: { title: 'old-track.mp4' },
        currentWork: { title: 'New Work Title' },
    };
    return { appStoreMock };
});

vi.mock('../../src/core/CentralObserver', () => ({
    CentralObserver: {
        register: vi.fn(),
        unregister: vi.fn(),
    },
}));

vi.mock('../../src/store/AppStore', () => ({
    AppStore: mocks.appStoreMock,
}));

vi.mock('../../src/core/EventBus', () => ({
    EventBus: {
        on: vi.fn(() => () => {}),
        off: vi.fn(),
        emit: vi.fn(),
    },
}));

vi.mock('../../src/core/Utils', () => ({
    I18n: { lang: 'en' },
}));

vi.mock('../../src/services/TranslationService', () => ({
    TranslationService: {
        translate: vi.fn(async (text: string) => text),
        cleanQuotes: (text: string) => text,
    },
}));

vi.mock('../../src/infrastructure/KikoeruBridge', () => ({
    KikoeruBridge: {
        getInstance: () => ({
            store: {
                watch: vi.fn(() => () => {}),
            },
        }),
    },
}));

import { PlayerTranslator } from '../../src/features/PlayerTranslator';

describe('PlayerTranslator', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        mocks.appStoreMock.currentTrack = { title: 'old-track.mp4' };
        mocks.appStoreMock.currentWork = { title: 'New Work Title' };
        vi.clearAllMocks();
    });

    it('resets stale translated pair even when jpdb removed inner translation spans', () => {
        document.body.innerHTML = `
            <div class="audio-player">
                <span
                    class="text-caption asmr-translation-pair"
                    data-asmr-translated="true"
                    data-asmr-source="王子様系ふたなり獣人にナンパされ"
                    data-asmr-translated-text="Old translated text"
                    data-jpdb="true"
                    data-jpdb-original="王子様系ふたなり獣人にナンパされ (Old translated text)"
                >
                    王子様系ふたなり獣人にナンパされ (Old translated text)
                </span>
            </div>
        `;

        const translator = new PlayerTranslator();
        (translator as any).stripPlayerJpdb();
        (translator as any).resetTranslationState();

        const el = document.querySelector('.audio-player .text-caption') as HTMLElement;
        // With ::after approach, resetTranslationState no longer modifies textContent
        // — it only clears data attributes and classes. Text stays as-is.
        expect(el.classList.contains('asmr-translation-pair')).toBe(false);
        expect(el.hasAttribute('data-asmr-translated')).toBe(false);
        expect(el.hasAttribute('data-asmr-source')).toBe(false);
        expect(el.hasAttribute('data-asmr-translated-text')).toBe(false);
    });

    it('seeds work subtitle from current work title on work change without forcing track title', () => {
        document.body.innerHTML = `
            <div class="audio-player">
                <div class="text-center q-mb-sm column">
                    <div class="ellipsis-2-lines text-bold q-pb-xs">old-track.mp4</div>
                    <div class="container full-width">
                        <div class="one-line-expand">
                            <span
                                class="text-caption asmr-translation-pair"
                                data-asmr-translated="true"
                                data-asmr-source="Old Work Title"
                                data-asmr-translated-text="Old Work Title (EN)"
                            >Old Work Title (Old Work Title (EN))</span>
                        </div>
                    </div>
                </div>
            </div>
        `;

        const translator = new PlayerTranslator();
        (translator as any).checkPlayer = vi.fn();
        (translator as any).onTrackOrWorkChange('', 'New Work Title');

        const trackEl = document.querySelector('.audio-player .ellipsis-2-lines') as HTMLElement;
        const subtitleEl = document.querySelector('.audio-player .text-caption') as HTMLElement;
        expect(trackEl.textContent).toBe('old-track.mp4');
        expect(subtitleEl.textContent).toBe('New Work Title');
    });

    it('clears stale translated-tags attributes/classes in reused player nodes', () => {
        document.body.innerHTML = `
            <div class="audio-player">
                <div
                    class="q-item__label asmr-translated asmr-worktree-translation"
                    data-asmrtag="n20_07_安眠用耳かき（左）.wav"
                    data-asmrtag-state="done"
                    data-asmrtag-scope="01534375|/work/RJ01534375?path=%5B%22WAV%22%5D"
                    data-asmrtag-translation="Track 1: Extra-large elf's sweet embrace, hug kiss & ear licking.mp3"
                >
                    n20_07_安眠用耳かき（左）.wav
                </div>
            </div>
        `;

        const translator = new PlayerTranslator();
        (translator as any).resetTranslationState();

        const el = document.querySelector('.audio-player .q-item__label') as HTMLElement;
        expect(el.hasAttribute('data-asmrtag')).toBe(false);
        expect(el.hasAttribute('data-asmrtag-state')).toBe(false);
        expect(el.hasAttribute('data-asmrtag-scope')).toBe(false);
        expect(el.hasAttribute('data-asmrtag-translation')).toBe(false);
        expect(el.classList.contains('asmr-translated')).toBe(false);
        expect(el.classList.contains('asmr-worktree-translation')).toBe(false);
    });
});
