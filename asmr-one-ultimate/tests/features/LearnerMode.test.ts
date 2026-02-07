import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LearnerMode } from '../../src/features/LearnerMode';

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
        document.body.innerHTML = '';
    });

    it('updates expanded subtitles with blurred EN by default', async () => {
        const learner = new LearnerMode();

        const player = document.createElement('div');
        player.className = 'audio-player';
        document.body.appendChild(player);

        const bar = document.createElement('div');
        bar.className = 'player-bar';
        document.body.appendChild(bar);

        (learner as any).injectExpanded(player);
        (learner as any).injectCollapsedControls(bar);

        await (learner as any).displaySubtitle('hello');

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

});
