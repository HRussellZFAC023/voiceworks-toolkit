import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import LearnerSubtitles from '../../src/features/components/LearnerSubtitles.vue';
import { INJECT_KEYS } from '../../src/core/MountApp';
import { TranslationService } from '../../src/services/TranslationService';
import { AppStore } from '../../src/store/AppStore';

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

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(res => { resolve = res; });
    return { promise, resolve };
}

function setConfig(key: string, value: unknown): void {
    (globalThis as typeof globalThis & { GM_setValue: (key: string, value: unknown) => void })
        .GM_setValue(key, value);
}

describe('LearnerSubtitles Chinese Whisper rendering', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = '<audio></audio><div id="mount"></div>';
        const audio = document.querySelector('audio')!;
        Object.defineProperty(audio, 'currentTime', { configurable: true, writable: true, value: 1 });

        setConfig('learnerSubtitleMode', 'jp-zh');
        setConfig('subtitleLang', 'en');
        setConfig('showJP', true);
        setConfig('enablePlayerTranslator', true);
        setConfig('karaokeMode', false);
        setConfig('segmentMode', true);
        setConfig('learnerBlur', false);
        setConfig('enableJpdb', false);
        setConfig('jpdbSubtitleFurigana', false);
        setConfig('jpdbShowFurigana', false);
        setConfig('playbackRate', 1);
        AppStore.setWhisperState({
            isTranscribing: false,
            isLoadingModel: false,
            progress: 0,
            progressMessage: '',
            currentTrackSrc: null,
            stage: 'idle',
        });

        vi.spyOn(TranslationService, 'peekCached').mockReturnValue(null);
        vi.spyOn(TranslationService, 'canPrefetch').mockReturnValue(true);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        document.body.innerHTML = '';
        AppStore.setWhisperState({
            isTranscribing: false,
            isLoadingModel: false,
            progress: 0,
            progressMessage: '',
            currentTrackSrc: null,
            stage: 'idle',
        });
    });

    function mountLearner(lrcLines?: Array<{ time: number; endTime: number; text: string }>) {
        const eventBus = createEventBus();
        const store = lrcLines ? {
            state: { AudioPlayer: { lrcLines, hide: false } },
        } : undefined;
        const bridge = {
            store,
            app: undefined,
            currentTrack: null,
            currentWorkId: '',
            queue: [],
            queueIndex: -1,
            axios: { get: vi.fn() },
            commit: vi.fn(),
        };
        const wrapper = mount(LearnerSubtitles, {
            attachTo: document.getElementById('mount')!,
            global: {
                provide: {
                    [INJECT_KEYS.bridge]: bridge,
                    [INJECT_KEYS.eventBus]: eventBus,
                    [INJECT_KEYS.i18n]: {
                        lang: 'zh',
                        t: (key: string) => key,
                        format: (key: string) => key,
                    },
                },
            },
        });
        return { wrapper, eventBus };
    }

    async function showNonWhisperLrc(text: string) {
        const mounted = mountLearner([{ time: 0, endTime: 10, text }]);
        document.querySelector('audio')!.dispatchEvent(new Event('timeupdate'));
        await nextTick();
        return mounted;
    }

    async function markPrimaryLaneClamped(): Promise<void> {
        const panel = document.querySelector<HTMLElement>('.learner-subs-expanded:not(.hidden)');
        const primary = panel?.querySelector<HTMLElement>('.learner-jp');
        if (!panel || !primary) throw new Error('Visible learner subtitle panel was unavailable');
        Object.defineProperty(panel, 'getClientRects', {
            configurable: true,
            value: () => ({ length: 1 }) as DOMRectList,
        });
        Object.defineProperties(primary, {
            clientHeight: { configurable: true, value: 40 },
            scrollHeight: { configurable: true, value: 120 },
        });
        window.dispatchEvent(new Event('resize'));
        await nextTick();
        await nextTick();
    }

    it.each([
        ['transcribing', { isTranscribing: true, isLoadingModel: false }],
        ['loading', { isTranscribing: false, isLoadingModel: true }],
    ])('reserves the subtitle panel across a remount while Whisper is %s', async (_state, whisperState) => {
        AppStore.setWhisperState(whisperState);

        const first = mountLearner();
        await nextTick();
        expect(first.wrapper.get('.learner-subs-expanded').classes()).not.toContain('hidden');
        first.wrapper.unmount();

        const remounted = mountLearner();
        await nextTick();
        expect(remounted.wrapper.get('.learner-subs-expanded').classes()).not.toContain('hidden');
        remounted.wrapper.unmount();
    });

    it('shows calm listener copy while retaining technical Whisper progress in state', async () => {
        AppStore.setWhisperState({
            isTranscribing: true,
            isLoadingModel: false,
            stage: 'behind',
            progressMessage: '21s behind · whisper-base · WEBGPU',
        });

        const { wrapper } = mountLearner();
        await nextTick();

        expect(wrapper.get('.learner-subs-expanded').classes()).not.toContain('hidden');
        const placeholder = wrapper.get('.learner-subs-expanded .learner-whisper-placeholder');
        expect(placeholder.text()).toBe('whisperCatchingUp');
        expect(placeholder.text()).not.toMatch(/WEBGPU|queued|realtime|analyzed|playhead/i);
        expect(AppStore.state.whisper.progressMessage).toBe('21s behind · whisper-base · WEBGPU');
        wrapper.unmount();
    });

    it.each([
        ['loading', 'whisperPreparingSubtitles'],
        ['transcribing', 'whisperListeningForSpeech'],
        ['caught-up', 'whisperListeningForSpeech'],
        ['behind', 'whisperCatchingUp'],
        ['recovering', 'whisperRestartingTranscription'],
    ] as const)('maps %s telemetry to one stable listener status', async (stage, expected) => {
        AppStore.setWhisperState({
            isTranscribing: stage !== 'loading',
            isLoadingModel: stage === 'loading',
            stage,
            progressMessage: 'encoder_model.onnx · WEBGPU · 45% · 2 queued',
        });

        const { wrapper } = mountLearner();
        await nextTick();

        expect(wrapper.get('.learner-subs-expanded .learner-whisper-placeholder').text())
            .toBe(expected);
        wrapper.unmount();
    });

    it('keeps a WebGPU failure visible after an active empty session stops', async () => {
        AppStore.setWhisperState({
            isTranscribing: true,
            isLoadingModel: false,
            stage: 'transcribing',
            progressMessage: 'whisperTranscribing',
        });
        const { wrapper } = mountLearner();
        await nextTick();

        AppStore.setWhisperState({
            isTranscribing: false,
            isLoadingModel: false,
            stage: 'error',
            progressMessage: 'whisperGpuCrashed',
        });
        await nextTick();

        expect(wrapper.get('.learner-subs-expanded').classes()).not.toContain('hidden');
        expect(wrapper.get('.learner-subs-expanded .learner-whisper-placeholder').text())
            .toBe('whisperGpuCrashed');
        wrapper.unmount();
    });

    it('releases a loading-only reservation when canonical model state becomes ready', async () => {
        const { wrapper } = mountLearner();

        AppStore.setWhisperState({
            isLoadingModel: true,
            progress: 25,
            progressMessage: 'loading',
        });
        await nextTick();
        expect(wrapper.get('.learner-subs-expanded').classes()).not.toContain('hidden');

        AppStore.setWhisperState({
            isLoadingModel: false,
            progress: 100,
            progressMessage: '',
        });
        await nextTick();
        expect(wrapper.get('.learner-subs-expanded').classes()).toContain('hidden');
        wrapper.unmount();
    });

    it('keeps LRC Chinese in the ZH lane and leaves JA blank until CN-to-JA succeeds', async () => {
        const ja = deferred<string>();
        vi.spyOn(TranslationService, 'translate').mockImplementation(async (_text, target) => {
            if (target === 'ja') return ja.promise;
            return '';
        });

        const { wrapper } = await showNonWhisperLrc('欢迎回来');
        const secondary = wrapper.get('.learner-subs-expanded .learner-en');
        const primary = wrapper.get('.learner-subs-expanded .learner-jp');

        expect(primary.text()).toBe('');
        expect(primary.attributes('lang')).toBe('ja');
        expect(secondary.text()).toBe('欢迎回来');
        expect(secondary.attributes('lang')).toBe('zh-CN');

        ja.resolve('お帰りなさい');
        await flushPromises();
        await nextTick();

        expect(primary.text()).toBe('お帰りなさい');
        expect(secondary.text()).toBe('欢迎回来');
        wrapper.unmount();
    });

    it.each([
        ['echo', false],
        ['failure', true],
    ])('never labels LRC Chinese as Japanese after a CN-to-JA %s', async (_case, shouldReject) => {
        vi.spyOn(TranslationService, 'peekCached').mockImplementation((_text, target) => (
            target === 'ja' ? '欢迎回来' : null
        ));
        vi.spyOn(TranslationService, 'translate').mockImplementation(async (_text, target) => {
            if (target === 'ja') {
                if (shouldReject) throw new Error('translation unavailable');
                return '欢迎回来';
            }
            return '';
        });

        const { wrapper } = await showNonWhisperLrc('欢迎回来');
        await flushPromises();
        await nextTick();

        const secondary = wrapper.get('.learner-subs-expanded .learner-en');
        const primary = wrapper.get('.learner-subs-expanded .learner-jp');
        expect(primary.text()).toBe('');
        expect(primary.attributes('lang')).toBe('ja');
        expect(secondary.text()).toBe('欢迎回来');
        expect(secondary.attributes('lang')).toBe('zh-CN');
        wrapper.unmount();
    });

    it('keeps cached Chinese visible in the ZH lane while replacing the primary with Japanese', async () => {
        const ja = deferred<string>();
        vi.spyOn(TranslationService, 'translate').mockImplementation(async (_text, target) => {
            if (target === 'ja') return ja.promise;
            return '';
        });
        const { wrapper, eventBus } = mountLearner();

        eventBus.emit('whisper:update', {
            text: '欢迎回来',
            segments: [{ start: 0, end: 10, text: '欢迎回来' }],
            final: true,
            fromCache: true,
            live: false,
            sourceLanguageHint: 'zh',
        });
        await nextTick();

        const secondary = wrapper.get('.learner-subs-expanded .learner-en');
        const primary = wrapper.get('.learner-subs-expanded .learner-jp');
        expect(secondary.text()).toBe('欢迎回来');
        expect(secondary.attributes('lang')).toBe('zh-CN');
        expect(primary.text()).toBe('');
        expect(primary.attributes('lang')).toBe('ja');

        ja.resolve('お帰りなさい');
        await flushPromises();
        await nextTick();

        expect(primary.text()).toBe('お帰りなさい');
        expect(primary.attributes('lang')).toBe('ja');
        expect(secondary.text()).toBe('欢迎回来');
        wrapper.unmount();
    });

    it('keeps a live text-only Chinese update visible until Japanese is ready', async () => {
        const ja = deferred<string>();
        vi.spyOn(TranslationService, 'translate').mockImplementation(async (_text, target) => {
            if (target === 'ja') return ja.promise;
            return '';
        });
        const { wrapper, eventBus } = mountLearner();

        eventBus.emit('whisper:update', {
            text: '<|0.00|>今晚好<|2.00|>',
            segments: [{ start: 0, end: 2, text: '<|0.00|>今晚好<|2.00|>' }],
            final: false,
            fromCache: false,
            live: true,
            sourceLanguageHint: 'zh',
        });
        await nextTick();

        const secondary = wrapper.get('.learner-subs-expanded .learner-en');
        const primary = wrapper.get('.learner-subs-expanded .learner-jp');
        expect(secondary.text()).toBe('今晚好');
        expect(secondary.attributes('lang')).toBe('zh-CN');
        expect(primary.text()).toBe('');
        expect(primary.attributes('lang')).toBe('ja');

        ja.resolve('こんばんは');
        await flushPromises();
        await nextTick();

        expect(primary.text()).toBe('こんばんは');
        expect(secondary.text()).toBe('今晚好');
        wrapper.unmount();
    });

    it('renders segment-only Whisper as a stable line instead of fake word karaoke', async () => {
        setConfig('karaokeMode', true);
        const { wrapper, eventBus } = mountLearner();

        eventBus.emit('whisper:update', {
            text: 'お邪魔します',
            segments: [{ start: 0, end: 4, text: 'お邪魔します' }],
            final: false,
            live: true,
            sourceLanguageHint: 'ja',
            timingQuality: 'segment',
        });
        await nextTick();

        const primary = wrapper.get('.learner-subs-expanded .learner-jp');
        expect(primary.text()).toBe('お邪魔します');
        expect(primary.find('.karaoke-spoken').exists()).toBe(false);
        expect(primary.find('.karaoke-upcoming').exists()).toBe(false);
        wrapper.unmount();
    });

    it('renders Japanese plus the configured translation and rejects a stale seek result', async () => {
        setConfig('learnerSubtitleMode', 'jp-en');
        const firstTranslation = deferred<string>();
        vi.spyOn(TranslationService, 'translate').mockImplementation(async (text, target) => {
            if (target !== 'en') return '';
            if (text === '最初の字幕') return firstTranslation.promise;
            if (text === '最後の字幕') return 'Final subtitle';
            return '';
        });
        const { wrapper, eventBus } = mountLearner();
        const audio = document.querySelector('audio')!;

        eventBus.emit('whisper:update', {
            text: '最初の字幕 最後の字幕',
            segments: [
                { start: 0, end: 5, text: '最初の字幕' },
                { start: 10, end: 15, text: '最後の字幕' },
            ],
            final: false,
            live: true,
            sourceLanguageHint: 'ja',
            timingQuality: 'segment',
        });
        await nextTick();
        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('最初の字幕');

        // Rapid forward/backward scrubbing may start several obsolete
        // translation requests before the final seeked event settles.
        for (const currentTime of [11, 1, 11]) {
            audio.currentTime = currentTime;
            audio.dispatchEvent(new Event('seeking'));
            audio.dispatchEvent(new Event('timeupdate'));
        }
        audio.dispatchEvent(new Event('seeked'));
        // The final seek invalidates any callback started by the intermediate
        // timeupdate. The live ticker must then re-request the final line.
        vi.advanceTimersByTime(120);
        await flushPromises();
        await nextTick();

        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('最後の字幕');
        expect(wrapper.get('.learner-subs-expanded .learner-en').text()).toBe('Final subtitle');
        expect(wrapper.get('.learner-subs-expanded .learner-en').attributes('lang')).toBe('en');

        firstTranslation.resolve('Stale first subtitle');
        await flushPromises();
        await nextTick();

        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('最後の字幕');
        expect(wrapper.get('.learner-subs-expanded .learner-en').text()).toBe('Final subtitle');
        wrapper.unmount();
    });

    it('settles native subtitles on the final rapid scrub position and rejects stale translation results', async () => {
        setConfig('learnerSubtitleMode', 'jp-en');
        const firstTranslation = deferred<string>();
        vi.spyOn(TranslationService, 'translate').mockImplementation(async (text, target) => {
            if (target !== 'en') return '';
            if (text === '最初のネイティブ字幕') return firstTranslation.promise;
            if (text === '最後のネイティブ字幕') return 'Final native subtitle';
            return '';
        });
        const { wrapper } = mountLearner([
            { time: 0, endTime: 5, text: '最初のネイティブ字幕' },
            { time: 10, endTime: 15, text: '最後のネイティブ字幕' },
        ]);
        const audio = document.querySelector('audio')!;

        audio.dispatchEvent(new Event('timeupdate'));
        await nextTick();
        expect(wrapper.get('.learner-subs-expanded .learner-jp').text())
            .toBe('最初のネイティブ字幕');

        for (const currentTime of [11, 1, 11]) {
            audio.currentTime = currentTime;
            audio.dispatchEvent(new Event('seeking'));
            audio.dispatchEvent(new Event('timeupdate'));
        }
        audio.dispatchEvent(new Event('seeked'));
        vi.advanceTimersByTime(30);
        await flushPromises();
        await nextTick();

        expect(wrapper.get('.learner-subs-expanded .learner-jp').text())
            .toBe('最後のネイティブ字幕');
        expect(wrapper.get('.learner-subs-expanded .learner-en').text())
            .toBe('Final native subtitle');

        firstTranslation.resolve('Stale first native subtitle');
        await flushPromises();
        await nextTick();

        expect(wrapper.get('.learner-subs-expanded .learner-jp').text())
            .toBe('最後のネイティブ字幕');
        expect(wrapper.get('.learner-subs-expanded .learner-en').text())
            .toBe('Final native subtitle');
        wrapper.unmount();
    });

    it('clears provisional text when the finalized Whisper window is empty', async () => {
        const { wrapper, eventBus } = mountLearner();

        eventBus.emit('whisper:update', {
            text: '暫定テキスト',
            segments: [{ start: 0, end: 4, text: '暫定テキスト' }],
            final: false,
            live: true,
            source: 'heartbeat',
            sourceLanguageHint: 'ja',
        });
        await nextTick();
        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('暫定テキスト');

        eventBus.emit('whisper:update', {
            text: '',
            segments: [],
            final: true,
            live: true,
            source: 'complete',
            sourceLanguageHint: 'ja',
        });
        await nextTick();

        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('');
        expect(wrapper.text()).not.toContain('暫定テキスト');
        wrapper.unmount();
    });

    it('clears an expired live cue instead of presenting stale speech as current', async () => {
        const { wrapper, eventBus } = mountLearner();

        eventBus.emit('whisper:update', {
            text: 'もう終わった字幕',
            segments: [{ start: 0, end: 1, text: 'もう終わった字幕' }],
            final: false,
            live: true,
            source: 'complete',
            sourceLanguageHint: 'ja',
        });
        await nextTick();
        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('もう終わった字幕');

        document.querySelector('audio')!.currentTime = 2;
        document.querySelector('audio')!.dispatchEvent(new Event('timeupdate'));
        await nextTick();

        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('');
        expect(wrapper.get('.learner-subs-expanded .learner-en').text()).toBe('');
        wrapper.unmount();
    });

    it('shows a late successful result briefly and labels it as delayed', async () => {
        const { wrapper, eventBus } = mountLearner();
        const audio = document.querySelector('audio')!;
        audio.currentTime = 11.2;

        eventBus.emit('whisper:update', {
            text: '遅れて届いた字幕',
            segments: [{ start: 0, end: 8, text: '遅れて届いた字幕' }],
            final: false,
            live: true,
            source: 'complete',
            sourceLanguageHint: 'ja',
            timingQuality: 'segment',
        });
        await nextTick();

        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('遅れて届いた字幕');
        expect(wrapper.get('.learner-subs-expanded .learner-whisper-delayed').text())
            .toBe('whisperCaptionDelayed');

        vi.advanceTimersByTime(3_600);
        audio.currentTime = 15;
        audio.dispatchEvent(new Event('timeupdate'));
        await nextTick();

        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('');
        expect(wrapper.find('.learner-subs-expanded .learner-whisper-delayed').exists()).toBe(false);
        wrapper.unmount();
    });

    it('drops a delayed caption immediately when the user scrubs elsewhere', async () => {
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
            callback(performance.now());
            return 1;
        });
        const { wrapper, eventBus } = mountLearner();
        const audio = document.querySelector('audio')!;
        audio.currentTime = 11.2;

        eventBus.emit('whisper:update', {
            text: '前の再生位置から遅れて届いた字幕',
            segments: [{ start: 0, end: 8, text: '前の再生位置から遅れて届いた字幕' }],
            final: false,
            live: true,
            source: 'complete',
            sourceLanguageHint: 'ja',
            timingQuality: 'segment',
        });
        await nextTick();
        expect(wrapper.get('.learner-subs-expanded .learner-jp').text())
            .toBe('前の再生位置から遅れて届いた字幕');

        audio.currentTime = 120;
        audio.dispatchEvent(new Event('seeking'));
        await nextTick();

        // The controller emits the full finalized timeline at the settled
        // position. Existing cues must not be reclassified as newly-arrived
        // delayed speech merely because the playhead changed.
        eventBus.emit('whisper:update', {
            text: '',
            segments: [{ start: 0, end: 8, text: '前の再生位置から遅れて届いた字幕' }],
            final: false,
            live: true,
            source: 'seek',
            sourceLanguageHint: 'ja',
            timingQuality: 'segment',
        });
        await nextTick();

        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('');
        expect(wrapper.get('.learner-subs-expanded .learner-en').text()).toBe('');
        expect(wrapper.find('.learner-subs-expanded .learner-whisper-delayed').exists()).toBe(false);
        wrapper.unmount();
    });

    it('shows a resumed backfill as delayed when a later cached segment is unchanged', async () => {
        const { wrapper, eventBus } = mountLearner();
        const audio = document.querySelector('audio')!;
        audio.currentTime = 30;

        eventBus.emit('whisper:update', {
            text: '後のキャッシュ字幕',
            segments: [{ start: 20, end: 24, text: '後のキャッシュ字幕' }],
            final: false,
            fromCache: true,
            live: false,
            sourceLanguageHint: 'ja',
            timingQuality: 'segment',
        });
        await nextTick();
        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('');

        eventBus.emit('whisper:update', {
            text: '後のキャッシュ字幕',
            segments: [
                { start: 0, end: 8, text: '再開して埋めた字幕' },
                { start: 20, end: 24, text: '後のキャッシュ字幕' },
            ],
            final: false,
            fromCache: false,
            live: true,
            source: 'complete',
            sourceLanguageHint: 'ja',
            timingQuality: 'segment',
        });
        await nextTick();

        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('再開して埋めた字幕');
        expect(wrapper.get('.learner-subs-expanded .learner-whisper-delayed').text())
            .toBe('whisperCaptionDelayed');
        wrapper.unmount();
    });

    it('does not replay an expired backfill after a current cue ends', async () => {
        const { wrapper, eventBus } = mountLearner();
        const audio = document.querySelector('audio')!;
        audio.currentTime = 10.5;

        eventBus.emit('whisper:update', {
            text: '現在の字幕',
            segments: [{ start: 10, end: 12, text: '現在の字幕' }],
            final: false,
            fromCache: true,
            live: false,
            sourceLanguageHint: 'ja',
            timingQuality: 'segment',
        });
        await nextTick();
        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('現在の字幕');

        eventBus.emit('whisper:update', {
            text: '現在の字幕',
            segments: [
                { start: 0, end: 8, text: '遅れて埋めた古い字幕' },
                { start: 10, end: 12, text: '現在の字幕' },
            ],
            final: false,
            fromCache: false,
            live: true,
            source: 'complete',
            sourceLanguageHint: 'ja',
            timingQuality: 'segment',
        });
        await nextTick();

        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('現在の字幕');
        expect(wrapper.find('.learner-subs-expanded .learner-whisper-delayed').exists()).toBe(false);

        audio.currentTime = 13;
        audio.dispatchEvent(new Event('timeupdate'));
        await nextTick();

        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('');
        expect(wrapper.find('.learner-subs-expanded .learner-whisper-delayed').exists()).toBe(false);
        wrapper.unmount();
    });

    it('clears both native subtitle lanes at an explicit cue end time', async () => {
        const { wrapper } = await showNonWhisperLrc('欢迎回来');
        expect(wrapper.get('.learner-subs-expanded .learner-en').text()).toBe('欢迎回来');

        document.querySelector('audio')!.currentTime = 10;
        document.querySelector('audio')!.dispatchEvent(new Event('timeupdate'));
        await nextTick();

        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('');
        expect(wrapper.get('.learner-subs-expanded .learner-en').text()).toBe('');
        wrapper.unmount();
    });

    it('opens the complete subtitle in a keyboard-accessible dialog without changing the player lane', async () => {
        const longJapanese = 'これはタッチ操作でも全文を読めるようにするための長い日本語字幕です。'.repeat(4);
        const { wrapper } = await showNonWhisperLrc(longJapanese);
        await markPrimaryLaneClamped();

        const trigger = wrapper.get('.learner-subs-expanded .learner-subtitle-expand');
        expect(trigger.attributes('aria-label')).toBe('showFullSubtitles');
        expect(trigger.attributes('aria-haspopup')).toBe('dialog');
        await trigger.trigger('click');
        await nextTick();

        const dialog = document.querySelector<HTMLElement>('.learner-subtitle-dialog');
        expect(dialog?.getAttribute('role')).toBe('dialog');
        expect(dialog?.getAttribute('aria-modal')).toBe('true');
        expect(dialog?.querySelector('.learner-subtitle-dialog-primary')?.textContent).toBe(longJapanese);

        dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await nextTick();
        expect(document.querySelector('.learner-subtitle-dialog')).toBeNull();
        wrapper.unmount();
    });

    it('never exposes a blurred translation in the full-text dialog before an explicit reveal', async () => {
        setConfig('learnerSubtitleMode', 'jp-en');
        setConfig('learnerBlur', true);
        const translated = 'The complete translated subtitle remains hidden until the learner asks to reveal it.';
        vi.spyOn(TranslationService, 'translate').mockResolvedValue(translated);

        const { wrapper } = await showNonWhisperLrc('翻訳を隠したまま全文表示を開きます。');
        await flushPromises();
        await nextTick();
        await markPrimaryLaneClamped();

        await wrapper.get('.learner-subs-expanded .learner-subtitle-expand').trigger('click');
        await nextTick();
        const dialog = document.querySelector<HTMLElement>('.learner-subtitle-dialog');
        expect(dialog?.querySelector('.learner-subtitle-dialog-secondary')).toBeNull();
        expect(dialog?.textContent).not.toContain(translated);

        const reveal = dialog?.querySelector<HTMLButtonElement>('.learner-subtitle-dialog-reveal');
        expect(reveal?.textContent?.trim()).toBe('revealTranslation');
        reveal?.click();
        await nextTick();
        expect(dialog?.querySelector('.learner-subtitle-dialog-secondary')?.textContent?.trim()).toBe(translated);
        wrapper.unmount();
    });
});
