import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LearnerMode } from '../../src/features/LearnerMode';
import { AppStore } from '../../src/store/AppStore';

vi.mock('../../src/services/TranslationService', () => ({
    TranslationService: {
        translate: vi.fn(async (text: string) => `${text}-en`),
        peekCached: vi.fn((text: string) => `${text}-en`),
        canPrefetch: vi.fn(() => false),
        translateBatch: vi.fn(async () => []),
        formatPair: vi.fn((a: string, b: string) => `${a} · ${b}`),
    }
}));

vi.mock('../../src/infrastructure/KikoeruBridge', () => ({
    KikoeruBridge: {
        getInstance: vi.fn(() => ({
            store: {
                state: {
                    AudioPlayer: {
                        hide: false
                    }
                }
            }
        }))
    }
}));

vi.mock('../../src/core/Utils', async () => {
    const actual = await vi.importActual<any>('../../src/core/Utils');
    return {
        ...actual,
        Config: {
            get: vi.fn((key: string) => {
                if (key === 'subtitleLang') return 'en';
                if (key === 'showJP') return true;
                if (key === 'whisperOverrideSubs') return true;
                if (key === 'learnerBlur') return true;
                return actual.Config?.defaults?.[key];
            }),
            set: vi.fn()
        }
    };
});

describe('LearnerMode', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        document.body.innerHTML = '';
        AppStore.setWhisperState({
            isTranscribing: false,
            isLoadingModel: false,
            progress: 0,
            progressMessage: '',
            currentTrackSrc: null,
        });
    });

    it('updates expanded subtitles with blurred EN by default', () => {
        const learner = new LearnerMode();

        const player = document.createElement('div');
        player.className = 'audio-player';
        document.body.appendChild(player);

        const bar = document.createElement('div');
        bar.className = 'player-bar';
        document.body.appendChild(bar);

        (learner as any).injectExpanded(player);
        (learner as any).injectCollapsedControls(bar);

        (learner as any).updatePrimaryLine('hello');
        (learner as any).updateSecondaryLine('hello-en', false);
        (learner as any).updateVisibility();

        const jpTexts = Array.from(document.querySelectorAll('.learner-jp')).map(el => el.textContent);
        const enEls = Array.from(document.querySelectorAll('.learner-en')) as HTMLElement[];

        expect(jpTexts).toContain('hello');
        expect(enEls.some(el => el.textContent === 'hello-en')).toBe(true);
        expect(enEls.every(el => el.classList.contains('blurred'))).toBe(true);
        expect(bar.querySelector('.learner-collapsed-controls')).not.toBeNull();
    });

    it('cleans up injected UI elements', () => {
        const learner = new LearnerMode();

        const player = document.createElement('div');
        player.className = 'audio-player';
        const controls = document.createElement('div');
        controls.className = 'row self-center';
        player.appendChild(controls);
        document.body.appendChild(player);

        const bar = document.createElement('div');
        bar.className = 'player-bar';
        document.body.appendChild(bar);

        (learner as any).injectExpanded(player);
        (learner as any).injectCollapsedControls(bar);

        expect(document.querySelector('.learner-subs-expanded')).not.toBeNull();
        expect(document.querySelector('.learner-collapsed-controls')).not.toBeNull();

        (learner as any).cleanupInjected();

        expect(document.querySelector('.learner-subs-expanded')).toBeNull();
        expect(document.querySelector('.learner-collapsed-controls')).toBeNull();
        expect(document.querySelector('.learner-controls')).toBeNull();
    });

    it('hides subtitle containers when no text is active', () => {
        const learner = new LearnerMode();

        const player = document.createElement('div');
        player.className = 'audio-player';
        document.body.appendChild(player);

        const bar = document.createElement('div');
        bar.className = 'player-bar';
        document.body.appendChild(bar);

        (learner as any).injectExpanded(player);
        (learner as any).injectCollapsedControls(bar);
        (learner as any).lastText = '';

        (learner as any).updateVisibility();

        const expanded = document.querySelector('.learner-subs-expanded') as HTMLElement | null;

        // Expanded should NOT be hidden (stable layout)
        expect(expanded?.style.display).not.toBe('none');
    });

    it.each([
        ['transcribing', { isTranscribing: true, isLoadingModel: false }],
        ['loading', { isTranscribing: false, isLoadingModel: true }],
    ])('hydrates the legacy panel when Whisper is already %s', async (_state, whisperState) => {
        AppStore.setWhisperState(whisperState);
        document.body.innerHTML = [
            '<div class="audio-player"></div>',
            '<div class="player-bar"></div>',
        ].join('');

        const learner = new LearnerMode();
        await learner.enable();

        const expanded = document.querySelector('.learner-subs-expanded') as HTMLElement | null;
        expect(expanded?.style.visibility).toBe('');

        learner.disable();
        AppStore.setWhisperState({
            isTranscribing: false,
            isLoadingModel: false,
        });
    });

    it('keeps the legacy panel synchronized with canonical Whisper state', async () => {
        document.body.innerHTML = [
            '<div class="audio-player"></div>',
            '<div class="player-bar"></div>',
        ].join('');

        const learner = new LearnerMode();
        await learner.enable();
        const expanded = document.querySelector('.learner-subs-expanded') as HTMLElement;
        expect(expanded.style.visibility).toBe('hidden');

        AppStore.setWhisperState({ isLoadingModel: true });
        expect(expanded.style.visibility).toBe('');

        AppStore.setWhisperState({ isLoadingModel: false });
        expect(expanded.style.visibility).toBe('hidden');
        learner.disable();
    });

    it('defers seeking subtitle refresh to requestAnimationFrame', () => {
        const learner = new LearnerMode();
        const updateSpy = vi.spyOn(learner as any, 'updateLyrics').mockImplementation(() => {});

        let rafCb: any = null;
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: any): number => {
            rafCb = cb;
            return 1;
        });
        vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

        (learner as any).handleAudioSeeking();

        expect(updateSpy).not.toHaveBeenCalled();
        expect(rafCb).not.toBeNull();
        if (rafCb) (rafCb as (time: number) => void)(performance.now());
        expect(updateSpy).toHaveBeenCalledTimes(1);
    });

});
