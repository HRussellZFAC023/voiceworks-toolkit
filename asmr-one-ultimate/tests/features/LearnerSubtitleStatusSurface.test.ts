/**
 * Covers the reported player-surface complaints that LearnerSubtitles owns:
 *
 *  - "you still seem to be putting information under the album image - and its
 *    appearing double" / "the album art would cover status": exactly one status
 *    surface may exist, and it may not be the artwork overlay.
 *  - "there is so much content shift rn ... the image above keeps getting
 *    bigger or smaller": the status must not add a box to the flow.
 *  - "I dont like that the pannel if the text is too big it has like the scroll
 *    wrap": long lines shrink to fit instead of being cut, without changing the
 *    lane geometry the artwork height is derived from.
 */
import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import LearnerSubtitles from '../../src/features/components/LearnerSubtitles.vue';
import { INJECT_KEYS } from '../../src/core/MountApp';
import { TranslationService } from '../../src/services/TranslationService';
import { AppStore } from '../../src/store/AppStore';

const learnerCss = readFileSync(
    resolve(process.cwd(), 'src/styles/components/_learner.css'),
    'utf8',
);

type Handler = (payload: unknown) => void;

function createEventBus() {
    const handlers = new Map<string, Set<Handler>>();
    return {
        on(event: string, handler: Handler) {
            const listeners = handlers.get(event) || new Set<Handler>();
            listeners.add(handler);
            handlers.set(event, listeners);
            return () => listeners.delete(handler);
        },
        once(event: string, handler: Handler) {
            const wrapped: Handler = payload => {
                handlers.get(event)?.delete(wrapped);
                handler(payload);
            };
            return this.on(event, wrapped);
        },
        emit(event: string, payload: unknown) {
            for (const handler of [...(handlers.get(event) || [])]) handler(payload);
        },
    };
}

function setConfig(key: string, value: unknown): void {
    (globalThis as typeof globalThis & { GM_setValue: (key: string, value: unknown) => void })
        .GM_setValue(key, value);
}

const IDLE_WHISPER = {
    isTranscribing: false,
    isLoadingModel: false,
    progress: 0,
    progressMessage: '',
    currentTrackSrc: null,
    stage: 'idle',
} as const;

/** Reproduces the node Whisper.ts creates when no dedicated surface exists. */
function injectLegacyWhisperStatus(variant: 'overlay' | 'inline'): HTMLElement {
    const status = document.createElement('div');
    status.className = `whisper-status whisper-status--${variant}`;
    status.innerHTML = '<span class="whisper-loading-indicator">encoder_model.onnx · WEBGPU · 2 queued</span>';
    if (variant === 'overlay') {
        const albumart = document.querySelector('.albumart')!;
        albumart.classList.add('asmr-whisper-status-host');
        albumart.appendChild(status);
    } else {
        document.querySelector('.audio-player')!.prepend(status);
    }
    return status;
}

describe('LearnerSubtitles status surface and long-line fit', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <audio></audio>
            <div class="audio-player">
                <div class="albumart"></div>
                <div id="asmr-learner-subs-root"></div>
            </div>
        `;
        const audio = document.querySelector('audio')!;
        Object.defineProperty(audio, 'currentTime', { configurable: true, writable: true, value: 1 });

        setConfig('learnerSubtitleMode', 'jp-en');
        setConfig('subtitleLang', 'en');
        setConfig('showJP', true);
        setConfig('enablePlayerTranslator', true);
        setConfig('karaokeMode', false);
        setConfig('segmentMode', false);
        setConfig('learnerBlur', false);
        setConfig('enableJpdb', false);
        setConfig('jpdbSubtitleFurigana', false);
        setConfig('jpdbShowFurigana', false);
        setConfig('playbackRate', 1);
        AppStore.setWhisperState({ ...IDLE_WHISPER });

        vi.spyOn(TranslationService, 'peekCached').mockReturnValue(null);
        vi.spyOn(TranslationService, 'canPrefetch').mockReturnValue(true);
        vi.spyOn(TranslationService, 'translate').mockResolvedValue('');
    });

    afterEach(() => {
        vi.restoreAllMocks();
        document.body.innerHTML = '';
        AppStore.setWhisperState({ ...IDLE_WHISPER });
    });

    function mountLearner(lrcLines?: Array<{ time: number; endTime: number; text: string }>) {
        const eventBus = createEventBus();
        const bridge = {
            store: { state: { AudioPlayer: { lrcLines: lrcLines ?? [], hide: false } } },
            app: undefined,
            currentTrack: null,
            currentWorkId: '',
            queue: [],
            queueIndex: -1,
            axios: { get: vi.fn() },
            commit: vi.fn(),
        };
        const wrapper = mount(LearnerSubtitles, {
            attachTo: document.getElementById('asmr-learner-subs-root')!,
            global: {
                provide: {
                    [INJECT_KEYS.bridge]: bridge,
                    [INJECT_KEYS.eventBus]: eventBus,
                    [INJECT_KEYS.i18n]: {
                        lang: 'en',
                        t: (key: string) => key,
                        format: (key: string) => key,
                    },
                },
            },
        });
        return { wrapper, eventBus };
    }

    /**
     * Distinct kana: Whisper's repetition guard collapses `'あ'.repeat(n)`, so a
     * repeated character would never reach the lane at its real length.
     */
    const KANA = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろ';
    const jpLine = (glyphs: number): string => KANA.slice(0, glyphs);

    async function showLine(text: string) {
        const mounted = mountLearner();
        const audio = document.querySelector('audio')! as HTMLAudioElement;
        // Near the end of the cue so the progressive reveal has emitted the
        // whole line and the fit steps see its real length.
        Object.defineProperty(audio, 'currentTime', { configurable: true, writable: true, value: 9.9 });
        mounted.eventBus.emit('whisper:update', {
            text,
            segments: [{ start: 0, end: 10, text }],
            final: true,
            fromCache: true,
            live: false,
            sourceLanguageHint: 'ja',
        });
        await nextTick();
        audio.dispatchEvent(new Event('timeupdate'));
        await nextTick();
        expect(mounted.wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe(text);
        return mounted;
    }

    describe('exactly one status surface', () => {
        it('removes a legacy album-art overlay that existed before this surface mounted', async () => {
            const legacy = injectLegacyWhisperStatus('overlay');
            expect(document.querySelectorAll('.whisper-status')).toHaveLength(1);

            const { wrapper } = mountLearner();
            await nextTick();

            expect(legacy.isConnected).toBe(false);
            expect(document.querySelectorAll('.whisper-status')).toHaveLength(0);
            expect(document.querySelector('.albumart')!.classList
                .contains('asmr-whisper-status-host')).toBe(false);
            wrapper.unmount();
        });

        it('removes the inline fallback so no dead strip is reserved under the artwork', async () => {
            injectLegacyWhisperStatus('inline');

            const { wrapper } = mountLearner();
            await nextTick();

            expect(document.querySelector('.whisper-status--inline')).toBeNull();
            wrapper.unmount();
        });

        it('never lets the legacy node and the Vue placeholder be shown together', async () => {
            AppStore.setWhisperState({
                isTranscribing: true,
                isLoadingModel: false,
                stage: 'transcribing',
                progressMessage: 'encoder_model.onnx · WEBGPU · 2 queued',
            });
            const { wrapper } = mountLearner();
            await nextTick();

            // A host re-render can re-create the legacy node mid-session.
            injectLegacyWhisperStatus('overlay');
            AppStore.setWhisperState({ stage: 'behind', backlogSeconds: 21 });
            await nextTick();

            expect(document.querySelectorAll('.whisper-status')).toHaveLength(0);
            const placeholders = wrapper.findAll('.learner-whisper-placeholder')
                .filter(node => node.text().length > 0);
            expect(placeholders).toHaveLength(1);
            expect(placeholders[0].text()).toBe('whisperCatchingUp');
            wrapper.unmount();
        });

        it('keeps the status inside the subtitle panel, never on the album artwork', async () => {
            AppStore.setWhisperState({
                isTranscribing: true,
                isLoadingModel: false,
                stage: 'transcribing',
                progressMessage: 'running',
            });
            const { wrapper } = mountLearner();
            await nextTick();

            const status = document.querySelector('.learner-whisper-placeholder')!;
            expect(status.closest('.albumart')).toBeNull();
            expect(status.closest('.learner-subs-expanded, .learner-subs-collapsed')).not.toBeNull();
            wrapper.unmount();
        });

        it('keeps model, backend and queue depth out of the player copy', async () => {
            AppStore.setWhisperState({
                isTranscribing: false,
                isLoadingModel: true,
                stage: 'loading',
                progressMessage: 'onnx-community/whisper-base · WEBGPU · 3 queued (45%)',
            });
            const { wrapper } = mountLearner();
            await nextTick();

            const text = wrapper.get('.learner-subs-expanded .learner-whisper-placeholder').text();
            expect(text).toBe('whisperPreparingSubtitles');
            expect(text).not.toMatch(/onnx|webgpu|wasm|queued|%/i);
            wrapper.unmount();
        });
    });

    describe('stable geometry', () => {
        it('paints the status outside the flow so it cannot resize the artwork', () => {
            const rule = /\.learner-whisper-placeholder\s*\{([^}]*)\}/.exec(learnerCss)?.[1] ?? '';
            expect(rule).toMatch(/position:\s*absolute/);
            expect(rule).toMatch(/inset:/);

            const delayed = /\.learner-whisper-delayed\s*\{([^}]*)\}/.exec(learnerCss)?.[1] ?? '';
            expect(delayed).toMatch(/position:\s*absolute/);
        });

        it('declares the subtitle lanes in rem so the auto-fit cannot move the panel', () => {
            // em lanes would shrink together with the scaled font-size and pull
            // the album art up and down on every subtitle change.
            expect(learnerCss).toContain('--asmr-subs-primary-lane, 3.875rem');
            expect(learnerCss).toContain('--asmr-subs-secondary-lane, 2.1125rem');
            expect(learnerCss).toContain('--asmr-subs-collapsed-primary-lane, 3.565rem');
            expect(learnerCss).not.toMatch(/(min|max)-block-size:\s*3\.1em/);
            expect(learnerCss).not.toMatch(/(min|max)-block-size:\s*2\.6em/);
        });

        it('drives the line clamp from the same custom properties', () => {
            expect(learnerCss).toContain('-webkit-line-clamp: var(--asmr-subs-primary-lines, 2)');
            expect(learnerCss).toContain('-webkit-line-clamp: var(--asmr-subs-secondary-lines, 2)');
            expect(learnerCss).toContain('font-size: calc(1.25rem * var(--asmr-subs-primary-scale, 1))');
            expect(learnerCss).toContain('font-size: calc(0.8125rem * var(--asmr-subs-secondary-scale, 1))');
        });
    });

    describe('long lines fit instead of being cut', () => {
        const fitOf = (style: string | undefined) => ({
            scale: /--asmr-subs-primary-scale:\s*([\d.]+)/.exec(style ?? '')?.[1],
            lines: /--asmr-subs-primary-lines:\s*(\d+)/.exec(style ?? '')?.[1],
        });

        it('leaves short lines at full size', async () => {
            const { wrapper } = await showLine(jpLine(7));
            expect(fitOf(wrapper.get('.learner-subs-expanded').attributes('style')))
                .toEqual({ scale: '1', lines: '2' });
            wrapper.unmount();
        });

        it('steps a medium Japanese line down one notch', async () => {
            // 34 full-width glyphs => weight 68, past the 60-unit two-line budget.
            const { wrapper } = await showLine(jpLine(34));
            expect(fitOf(wrapper.get('.learner-subs-expanded').attributes('style')))
                .toEqual({ scale: '0.8', lines: '2' });
            wrapper.unmount();
        });

        it('gives a very long line a third line at the smallest step', async () => {
            const { wrapper } = await showLine(jpLine(42));
            expect(fitOf(wrapper.get('.learner-subs-expanded').attributes('style')))
                .toEqual({ scale: '0.66', lines: '3' });
            wrapper.unmount();
        });

        it('weights Latin text by advance width rather than code points', async () => {
            // 42 Latin characters occupy about half the width of 42 kana, so the
            // same code-point count must not trigger the smallest step.
            const { wrapper } = await showLine('The quick brown fox jumps over a lazy dog.');
            expect(fitOf(wrapper.get('.learner-subs-expanded').attributes('style')))
                .toEqual({ scale: '1', lines: '2' });
            wrapper.unmount();
        });

        it('applies the same fit to the collapsed mini-bar', async () => {
            const { wrapper } = await showLine(jpLine(42));
            const collapsed = document.querySelector('.learner-subs-collapsed') as HTMLElement;
            expect(collapsed.style.getPropertyValue('--asmr-subs-primary-scale')).toBe('0.66');
            expect(collapsed.style.getPropertyValue('--asmr-subs-primary-lines')).toBe('3');
            wrapper.unmount();
        });

        it('still offers the full-text dialog as the escape hatch, with no inner scroller', () => {
            const dialog = /\.learner-subtitle-dialog\s*\{([^}]*)\}/.exec(learnerCss)?.[1] ?? '';
            expect(dialog).not.toMatch(/overflow(-y)?:\s*(auto|scroll)/);
            const content = /\.learner-subtitle-dialog-content\s*\{([^}]*)\}/.exec(learnerCss)?.[1] ?? '';
            expect(content).not.toMatch(/overflow(-y)?:\s*(auto|scroll)/);
        });
    });
});
