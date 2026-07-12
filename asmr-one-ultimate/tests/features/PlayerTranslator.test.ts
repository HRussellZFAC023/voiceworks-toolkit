import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

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
        (translator as any)._enabled = true;
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

    it('restores an exact CN-to-JP text replacement when disabled', () => {
        document.body.innerHTML = `
            <div class="audio-player">
                <span
                    data-asmr-translated="true"
                    data-asmr-source="晚安耳语"
                    data-asmr-translated-text="おやすみ囁き"
                >おやすみ囁き</span>
            </div>
        `;

        const translator = new PlayerTranslator();
        (translator as any)._enabled = true;
        translator.disable();

        const el = document.querySelector('.audio-player span') as HTMLElement;
        expect(el.textContent).toBe('晚安耳语');
        expect(el.hasAttribute('data-asmr-translated')).toBe(false);
        expect(el.hasAttribute('data-asmr-source')).toBe(false);
        expect(el.hasAttribute('data-asmr-translated-text')).toBe(false);
    });

    it('uses a stable accessible ellipsis for translated mini-player titles', () => {
        document.body.innerHTML = `
            <footer class="q-footer">
                <div class="container">
                    <div class="one-line-expand scrolling">
                        <div class="ellipsis-2-lines">非常に長い作品タイトル.mp3</div>
                    </div>
                </div>
            </footer>
        `;

        const translator = new PlayerTranslator();
        const el = document.querySelector('.ellipsis-2-lines') as HTMLElement;
        (translator as any).updateElement(el, '非常に長い作品タイトル.mp3', 'A very long translated work title');

        expect(el.classList.contains('asmr-mini-title-ellipsis')).toBe(true);
        expect(el.closest('.one-line-expand')?.classList.contains('asmr-mini-title-ellipsis-content')).toBe(true);
        expect(el.closest('.container')?.classList.contains('asmr-mini-title-ellipsis-container')).toBe(true);
        expect(el.title).toBe('非常に長い作品タイトル.mp3 (A very long translated work title)');

        const css = fs.readFileSync(path.resolve('src/styles/fixes.css'), 'utf8');
        const stableRule = css.slice(css.indexOf('.asmr-mini-title-ellipsis {'));
        expect(stableRule).toContain('white-space: nowrap !important');
        expect(stableRule).toContain('text-overflow: ellipsis !important');
        expect(stableRule).toContain('animation: none !important');
    });

    it('cancels and rejects a queued animation-frame translation after disable', () => {
        let queuedFrame: FrameRequestCallback | null = null;
        const requestSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
            queuedFrame = callback;
            return 42;
        });
        const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
        const translator = new PlayerTranslator();
        const checkPlayer = vi.spyOn(translator as any, 'checkPlayer');

        translator.enable();
        expect(requestSpy).toHaveBeenCalled();
        translator.disable();
        expect(cancelSpy).toHaveBeenCalledWith(42);

        expect(queuedFrame).not.toBeNull();
        (queuedFrame as unknown as FrameRequestCallback)(performance.now());
        expect(checkPlayer).not.toHaveBeenCalled();

        requestSpy.mockRestore();
        cancelSpy.mockRestore();
    });
});
