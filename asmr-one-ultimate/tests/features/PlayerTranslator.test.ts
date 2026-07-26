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
        currentWork: { title: 'New Work Title', translation_info: undefined as { lang?: string } | undefined },
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
        translateForDisplay: vi.fn(async (text: string) => ({
            sourceText: text,
            sourceLanguage: 'ja',
            primaryText: text,
            primaryLanguage: 'ja',
        })),
        cleanQuotes: (text: string) => text,
    },
}));

vi.mock('../../src/infrastructure/KikoeruBridge', () => ({
    KikoeruBridge: {
        getInstance: () => ({
            get currentWork() { return mocks.appStoreMock.currentWork; },
            store: {
                watch: vi.fn(() => () => {}),
            },
        }),
    },
}));

import { PlayerTranslator } from '../../src/features/PlayerTranslator';
import { TranslationService } from '../../src/services/TranslationService';
import { CentralObserver } from '../../src/core/CentralObserver';

describe('PlayerTranslator', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        mocks.appStoreMock.currentTrack = { title: 'old-track.mp4' };
        mocks.appStoreMock.currentWork = { title: 'New Work Title', translation_info: undefined };
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
                    data-asmrtag-primary="20_07_安眠用耳かき（左）.wav"
                    data-asmrtag-state="done"
                    data-asmrtag-scope="01534375|/work/RJ01534375?path=%5B%22WAV%22%5D"
                    data-asmrtag-translation="Track 1: Extra-large elf's sweet embrace, hug kiss & ear licking.mp3"
                >
                    20_07_安眠用耳かき（左）.wav
                </div>
            </div>
        `;

        const translator = new PlayerTranslator();
        (translator as any).resetTranslationState();

        const el = document.querySelector('.audio-player .q-item__label') as HTMLElement;
        expect(el.hasAttribute('data-asmrtag')).toBe(false);
        expect(el.hasAttribute('data-asmrtag-primary')).toBe(false);
        expect(el.textContent?.trim()).toBe('n20_07_安眠用耳かき（左）.wav');
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

    it('renders confirmed Chinese as Japanese primary with English secondary and restores the source', async () => {
        mocks.appStoreMock.currentWork = {
            title: '晚安耳语',
            translation_info: { lang: 'CHI_HANS' },
        };
        vi.mocked(TranslationService.translateForDisplay).mockResolvedValueOnce({
            sourceText: '晚安耳语',
            sourceLanguage: 'zh',
            primaryText: 'おやすみ耳語り',
            primaryLanguage: 'ja',
            secondaryText: 'Goodnight whispers',
            secondaryLanguage: 'en',
        });
        document.body.innerHTML = '<div class="audio-player"><div class="text-h6">晚安耳语</div></div>';
        const translator = new PlayerTranslator();
        (translator as any)._enabled = true;
        const el = document.querySelector('.text-h6') as HTMLElement;

        await (translator as any).translateElement(el, 'title');

        expect(el.textContent).toBe('おやすみ耳語り');
        expect(el.dataset.asmrPrimaryText).toBe('おやすみ耳語り');
        expect(el.dataset.asmrTranslatedText).toBe('Goodnight whispers');
        expect(el.classList.contains('asmr-translation-pair')).toBe(true);
        expect(el.title).toContain('晚安耳语');
        (translator as any).resetTranslationState();
        expect(el.textContent).toBe('晚安耳语');
    });

    it('keeps an untranslatable mini-player title on a stable ellipsis with the full text reachable', () => {
        document.body.innerHTML = `
            <footer class="q-footer">
                <div class="container">
                    <div class="one-line-expand scrolling">
                        <div class="ellipsis-2-lines">非常に長い作品タイトルなのでミニプレイヤーでは収まりません.mp3</div>
                    </div>
                </div>
            </footer>
        `;

        const translator = new PlayerTranslator();
        const el = document.querySelector('.ellipsis-2-lines') as HTMLElement;
        const original = '非常に長い作品タイトルなのでミニプレイヤーでは収まりません.mp3';

        // No translation is still a clipped title: the host marquee was measured
        // against the previous track, so it hard-clips this one.
        (translator as any).markOriginal(el, original);

        expect(el.classList.contains('asmr-mini-title-ellipsis')).toBe(true);
        expect(el.closest('.one-line-expand')?.classList.contains('asmr-mini-title-ellipsis-content')).toBe(true);
        expect(el.title).toBe(original);
        expect(el.getAttribute('aria-label')).toBe(original);
        expect(el.getAttribute('tabindex')).toBe('0');
    });

    it('hands back the host title and focusability when translation state is reset', () => {
        document.body.innerHTML = `
            <footer class="q-footer">
                <div class="container">
                    <div class="one-line-expand">
                        <div class="ellipsis-2-lines">タイトル.mp3</div>
                    </div>
                </div>
            </footer>
        `;

        const translator = new PlayerTranslator();
        const el = document.querySelector('.ellipsis-2-lines') as HTMLElement;
        (translator as any).updateElement(el, 'タイトル.mp3', 'Title.mp3');
        expect(el.getAttribute('tabindex')).toBe('0');

        (translator as any).resetTranslationState();

        expect(el.hasAttribute('title')).toBe(false);
        expect(el.hasAttribute('aria-label')).toBe(false);
        expect(el.hasAttribute('tabindex')).toBe(false);
        expect(el.classList.contains('asmr-mini-title-ellipsis')).toBe(false);
    });

    it('seeds a track title with its full text available on hover', () => {
        document.body.innerHTML = `
            <footer class="q-footer">
                <div class="container">
                    <div class="one-line-expand">
                        <div class="ellipsis-2-lines">old-track.mp4</div>
                    </div>
                </div>
            </footer>
        `;

        const translator = new PlayerTranslator();
        (translator as any).seedTrackTitle('とても長い新しいトラック名.mp3');

        const el = document.querySelector('.ellipsis-2-lines') as HTMLElement;
        expect(el.textContent).toBe('とても長い新しいトラック名.mp3');
        expect(el.title).toBe('とても長い新しいトラック名.mp3');
    });

    it('never hands the same node to two translation passes in one sweep', async () => {
        // A node that satisfies both the track-name and the player-title
        // selectors would otherwise be translated twice, and the two passes
        // strip different prefixes/extensions before writing to the same slot.
        document.body.innerHTML = `
            <div class="audio-player">
                <div class="ellipsis-2-lines text-h6 text-bold q-pb-xs">01. 耳かき.mp3</div>
            </div>
        `;
        const translator = new PlayerTranslator();
        (translator as any)._enabled = true;
        const trackNameSpy = vi.spyOn(translator as any, 'translateTrackName');
        const elementSpy = vi.spyOn(translator as any, 'translateElement');

        await (translator as any).checkPlayer();

        const el = document.querySelector('.ellipsis-2-lines') as HTMLElement;
        expect(trackNameSpy).toHaveBeenCalledTimes(1);
        expect(trackNameSpy.mock.calls[0][0]).toBe(el);
        expect(elementSpy).not.toHaveBeenCalled();
    });

    it('registers for every mutation and debounces its own player rescans', () => {
        const translator = new PlayerTranslator();
        translator.enable();

        expect(CentralObserver.register).toHaveBeenCalledWith('PlayerTranslator', expect.any(Function), 0);
        const observerCallback = vi.mocked(CentralObserver.register).mock.calls[0][1] as () => void;
        observerCallback();
        observerCallback();
        expect((translator as any).refresh.pending).toBe(true);

        translator.disable();
        expect((translator as any).refresh.pending).toBe(false);
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
