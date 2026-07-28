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
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
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
        setConfig('whisperOverrideSubs', true);
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
        const activity = wrapper.get('.learner-subs-expanded .learner-whisper-activity');
        expect(activity.attributes('aria-label')).toBe('whisperCatchingUp');
        expect(activity.text()).toBe('');
        expect(activity.html()).not.toMatch(/WEBGPU|queued|realtime|analyzed|playhead/i);
        expect(activity.find('.learner-whisper-activity-label').exists()).toBe(false);
        expect(AppStore.state.whisper.progressMessage).toBe('21s behind · whisper-base · WEBGPU');
        wrapper.unmount();
    });

    it.each([
        ['loading', 'whisperPreparingSubtitles'],
        ['transcribing', 'whisperListeningForSpeech'],
        ['caught-up', null],
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

        const activity = wrapper.find('.learner-subs-expanded .learner-whisper-activity');
        if (expected) {
            expect(activity.attributes('aria-label')).toBe(expected);
            expect(activity.text()).toBe('');
        } else {
            expect(activity.exists()).toBe(false);
        }
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
        const activity = wrapper.get('.learner-subs-expanded .learner-whisper-activity');
        expect(activity.text())
            .toBe('whisperGpuCrashed');
        expect(activity.classes()).toContain('learner-whisper-activity--error');
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

    it('commits a new segmented Chinese cue only after both Japanese and English are ready', async () => {
        setConfig('learnerSubtitleMode', 'jp-en');
        const japanese = deferred<string>();
        const english = deferred<string>();
        vi.mocked(TranslationService.peekCached).mockImplementation((text, target) => (
            text === '前の字幕' && target === 'en' ? 'Previous subtitle' : null
        ));
        vi.spyOn(TranslationService, 'translate').mockImplementation(async (text, target) => {
            if (text !== '新的字幕') return '';
            return target === 'ja' ? japanese.promise : english.promise;
        });
        const { wrapper, eventBus } = mountLearner();

        eventBus.emit('whisper:update', {
            text: '前の字幕',
            segments: [{ start: 0, end: 10, text: '前の字幕' }],
            final: true,
            live: true,
            source: 'complete',
            sourceLanguageHint: 'ja',
        });
        await nextTick();
        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('前の字幕');
        expect(wrapper.get('.learner-subs-expanded .learner-en').text()).toBe('Previous subtitle');

        eventBus.emit('whisper:update', {
            text: '新的字幕',
            segments: [{ start: 0, end: 10, text: '新的字幕' }],
            final: true,
            live: true,
            source: 'complete',
            sourceLanguageHint: 'zh',
        });
        await nextTick();

        japanese.resolve('新しい字幕');
        await flushPromises();
        await nextTick();
        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('前の字幕');
        expect(wrapper.get('.learner-subs-expanded .learner-en').text()).toBe('Previous subtitle');

        english.resolve('New subtitle');
        await flushPromises();
        await nextTick();
        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('新しい字幕');
        expect(wrapper.get('.learner-subs-expanded .learner-en').text()).toBe('New subtitle');
        wrapper.unmount();
    });

    it('keeps an uncached segmented Japanese fallback stable across the next ticker', async () => {
        setConfig('learnerSubtitleMode', 'jp-en');
        const japanese = deferred<string>();
        vi.mocked(TranslationService.peekCached).mockImplementation((text, target) => {
            if (text === '前の字幕' && target === 'en') return 'Previous subtitle';
            if (text === '缓存的字幕' && target === 'en') return 'Cached subtitle';
            return null;
        });
        vi.spyOn(TranslationService, 'translate').mockImplementation(async (text, target) => {
            if (text === '缓存的字幕' && target === 'ja') return japanese.promise;
            return '';
        });
        const { wrapper, eventBus } = mountLearner();

        eventBus.emit('whisper:update', {
            text: '前の字幕',
            segments: [{ start: 0, end: 10, text: '前の字幕' }],
            final: true,
            live: true,
            source: 'complete',
            sourceLanguageHint: 'ja',
        });
        await nextTick();

        eventBus.emit('whisper:update', {
            text: '缓存的字幕',
            segments: [{ start: 0, end: 10, text: '缓存的字幕' }],
            final: true,
            live: true,
            source: 'complete',
            sourceLanguageHint: 'zh',
        });
        await nextTick();

        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('前の字幕');
        expect(wrapper.get('.learner-subs-expanded .learner-en').text()).toBe('Previous subtitle');

        japanese.resolve('キャッシュ済みの字幕');
        await flushPromises();
        await nextTick();
        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('キャッシュ済みの字幕');
        expect(wrapper.get('.learner-subs-expanded .learner-en').text()).toBe('Cached subtitle');
        expect(TranslationService.translate).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(80);
        await nextTick();

        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('キャッシュ済みの字幕');
        expect(wrapper.get('.learner-subs-expanded .learner-en').text()).toBe('Cached subtitle');
        expect(TranslationService.translate).toHaveBeenCalledTimes(1);
        wrapper.unmount();
    });

    it('commits a text-only Chinese cue atomically after both translations resolve', async () => {
        setConfig('learnerSubtitleMode', 'jp-en');
        const japanese = deferred<string>();
        const english = deferred<string>();
        vi.mocked(TranslationService.peekCached).mockImplementation((text, target) => (
            text === '確定済み字幕' && target === 'en' ? 'Confirmed subtitle' : null
        ));
        vi.spyOn(TranslationService, 'translate').mockImplementation(async (text, target) => {
            if (text !== '只有文字的字幕') return '';
            return target === 'ja' ? japanese.promise : english.promise;
        });
        const { wrapper, eventBus } = mountLearner();

        eventBus.emit('whisper:update', {
            text: '確定済み字幕',
            segments: [{ start: 0, end: 10, text: '確定済み字幕' }],
            final: true,
            live: true,
            source: 'complete',
            sourceLanguageHint: 'ja',
        });
        await nextTick();

        eventBus.emit('whisper:update', {
            text: '只有文字的字幕',
            segments: [],
            final: true,
            live: true,
            source: 'complete',
            sourceLanguageHint: 'zh',
        });
        await nextTick();

        english.resolve('Text-only subtitle');
        await flushPromises();
        await nextTick();
        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('確定済み字幕');
        expect(wrapper.get('.learner-subs-expanded .learner-en').text()).toBe('Confirmed subtitle');

        japanese.resolve('文字だけの字幕');
        await flushPromises();
        await nextTick();
        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('文字だけの字幕');
        expect(wrapper.get('.learner-subs-expanded .learner-en').text()).toBe('Text-only subtitle');
        wrapper.unmount();
    });

    it('keeps an uncached text-only Japanese fallback stable across the next ticker', async () => {
        setConfig('learnerSubtitleMode', 'jp-en');
        const japanese = deferred<string>();
        vi.mocked(TranslationService.peekCached).mockImplementation((text, target) => {
            if (text === '確定済み字幕' && target === 'en') return 'Confirmed subtitle';
            if (text === '缓存的纯文字字幕' && target === 'en') return 'Cached text-only subtitle';
            return null;
        });
        vi.spyOn(TranslationService, 'translate').mockImplementation(async (text, target) => {
            if (text === '缓存的纯文字字幕' && target === 'ja') return japanese.promise;
            return '';
        });
        const { wrapper, eventBus } = mountLearner();

        eventBus.emit('whisper:update', {
            text: '確定済み字幕',
            segments: [{ start: 0, end: 10, text: '確定済み字幕' }],
            final: true,
            live: true,
            source: 'complete',
            sourceLanguageHint: 'ja',
        });
        await nextTick();

        eventBus.emit('whisper:update', {
            text: '缓存的纯文字字幕',
            segments: [],
            final: true,
            live: true,
            source: 'complete',
            sourceLanguageHint: 'zh',
        });
        await nextTick();

        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('確定済み字幕');
        expect(wrapper.get('.learner-subs-expanded .learner-en').text()).toBe('Confirmed subtitle');

        japanese.resolve('キャッシュ済みのテキスト字幕');
        await flushPromises();
        await nextTick();
        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('キャッシュ済みのテキスト字幕');
        expect(wrapper.get('.learner-subs-expanded .learner-en').text()).toBe('Cached text-only subtitle');

        vi.advanceTimersByTime(80);
        await nextTick();

        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('キャッシュ済みのテキスト字幕');
        expect(wrapper.get('.learner-subs-expanded .learner-en').text()).toBe('Cached text-only subtitle');
        expect(TranslationService.translate).toHaveBeenCalledTimes(1);
        wrapper.unmount();
    });

    it('commits a text-only JP-ZH pair without retrying the valid Chinese secondary', async () => {
        setConfig('learnerSubtitleMode', 'jp-zh');
        const source = '中文原文就是有效的中文字幕';
        const translatedJapanese = '中国語の原文が有効な中国語字幕です';
        vi.spyOn(TranslationService, 'translate').mockImplementation(async (_text, target) => (
            target === 'ja' ? translatedJapanese : ''
        ));
        const { wrapper, eventBus } = mountLearner();

        eventBus.emit('whisper:update', {
            text: source,
            segments: [],
            final: true,
            live: true,
            source: 'complete',
            sourceLanguageHint: 'zh',
        });
        await flushPromises();
        await nextTick();

        const japanese = wrapper.get('.learner-subs-expanded .learner-jp');
        const chinese = wrapper.get('.learner-subs-expanded .learner-en');
        const japaneseCallCount = () => vi.mocked(TranslationService.translate).mock.calls
            .filter(([, target]) => target === 'ja').length;
        expect(japanese.text()).toBe(translatedJapanese);
        expect(chinese.text()).toBe(source);
        expect(chinese.attributes('lang')).toBe('zh-CN');
        expect(japaneseCallCount()).toBe(1);

        vi.advanceTimersByTime(1_040);
        await flushPromises();
        await nextTick();

        expect(japanese.text()).toBe(translatedJapanese);
        expect(chinese.text()).toBe(source);
        expect(japaneseCallCount()).toBe(1);
        wrapper.unmount();
    });

    it.each([
        ['segmented', [{ start: 0, end: 10, text: '新的中文字幕' }]],
        ['text-only', []],
    ])(
        'retains a confirmed JP-ZH pair until a %s Chinese cue has Japanese',
        async (_kind, segments) => {
            setConfig('learnerSubtitleMode', 'jp-zh');
            const previousJapanese = '前の日本語字幕';
            const previousChinese = '之前的中文字幕';
            const nextChinese = '新的中文字幕';
            const nextJapanese = '新しい日本語字幕';
            const japanese = deferred<string>();
            vi.mocked(TranslationService.peekCached).mockImplementation((text, target) => (
                text === previousJapanese && (target ?? '').toLowerCase().startsWith('zh') ? previousChinese : null
            ));
            vi.spyOn(TranslationService, 'translate').mockImplementation(async (text, target) => (
                text === nextChinese && target === 'ja' ? japanese.promise : ''
            ));
            const { wrapper, eventBus } = mountLearner();

            eventBus.emit('whisper:update', {
                text: previousJapanese,
                segments: [{ start: 0, end: 10, text: previousJapanese }],
                final: true,
                live: true,
                source: 'complete',
                sourceLanguageHint: 'ja',
            });
            await nextTick();
            expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe(previousJapanese);
            expect(wrapper.get('.learner-subs-expanded .learner-en').text()).toBe(previousChinese);

            eventBus.emit('whisper:update', {
                text: nextChinese,
                segments,
                final: true,
                live: true,
                source: 'complete',
                sourceLanguageHint: 'zh',
            });
            await nextTick();

            expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe(previousJapanese);
            expect(wrapper.get('.learner-subs-expanded .learner-en').text()).toBe(previousChinese);

            japanese.resolve(nextJapanese);
            await flushPromises();
            await nextTick();

            expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe(nextJapanese);
            expect(wrapper.get('.learner-subs-expanded .learner-en').text()).toBe(nextChinese);
            wrapper.unmount();
        },
    );

    it.each(['empty', 'echo', 'rejection'] as const)(
        'retries a text-only Japanese %s result after cooldown and recovers the pair',
        async (failure) => {
            setConfig('learnerSubtitleMode', 'jp-en');
            const source = '再試行する字幕';
            const secondary = 'Subtitle that retries';
            const recoveredJapanese = '再試行で回復した字幕';
            let japaneseAttempts = 0;
            vi.mocked(TranslationService.peekCached).mockImplementation((text, target) => (
                text === source && target === 'en' ? secondary : null
            ));
            vi.spyOn(TranslationService, 'translate').mockImplementation(async (text, target) => {
                if (text !== source || target !== 'ja') return '';
                japaneseAttempts += 1;
                if (japaneseAttempts > 1) return recoveredJapanese;
                if (failure === 'rejection') throw new Error('temporary JA failure');
                return failure === 'echo' ? source : '';
            });
            const { wrapper, eventBus } = mountLearner();

            eventBus.emit('whisper:update', {
                text: source,
                segments: [],
                final: true,
                live: true,
                source: 'complete',
                sourceLanguageHint: 'zh',
            });
            await flushPromises();
            await nextTick();

            const japanese = wrapper.get('.learner-subs-expanded .learner-jp');
            const translation = wrapper.get('.learner-subs-expanded .learner-en');
            const japaneseCallCount = () => vi.mocked(TranslationService.translate).mock.calls
                .filter(([text, target]) => text === source && target === 'ja').length;
            expect(japanese.text()).toBe('');
            expect(translation.text()).toBe(secondary);
            expect(japaneseCallCount()).toBe(1);

            vi.advanceTimersByTime(80);
            await flushPromises();
            await nextTick();

            expect(japanese.text()).toBe('');
            expect(translation.text()).toBe(secondary);
            expect(japaneseCallCount()).toBe(1);

            vi.advanceTimersByTime(960);
            await flushPromises();
            await nextTick();

            expect(japaneseCallCount()).toBe(2);
            expect(japanese.text()).toBe(recoveredJapanese);
            expect(translation.text()).toBe(secondary);

            vi.advanceTimersByTime(1_040);
            await flushPromises();
            await nextTick();

            expect(japanese.text()).toBe(recoveredJapanese);
            expect(translation.text()).toBe(secondary);
            expect(japaneseCallCount()).toBe(2);
            wrapper.unmount();
        },
    );

    it('rejects stale text-only secondary and Japanese callbacks after a same-track seek reset', async () => {
        setConfig('learnerSubtitleMode', 'jp-en');
        const source = 'シークで無効になる中国語字幕';
        const staleSecondary = deferred<string>();
        const staleJapanese = deferred<string>();
        const currentSecondary = deferred<string>();
        const currentJapanese = deferred<string>();
        let secondaryAttempts = 0;
        let japaneseAttempts = 0;
        vi.spyOn(TranslationService, 'translate').mockImplementation(async (text, target) => {
            if (text !== source) return '';
            if (target === 'ja') {
                japaneseAttempts += 1;
                return japaneseAttempts === 1 ? staleJapanese.promise : currentJapanese.promise;
            }
            secondaryAttempts += 1;
            return secondaryAttempts === 1 ? staleSecondary.promise : currentSecondary.promise;
        });
        const { wrapper, eventBus } = mountLearner();
        const audio = document.querySelector('audio')!;

        eventBus.emit('whisper:update', {
            text: source,
            segments: [],
            final: true,
            live: true,
            source: 'complete',
            sourceLanguageHint: 'zh',
        });
        await nextTick();
        expect(secondaryAttempts).toBe(1);
        expect(japaneseAttempts).toBe(1);

        audio.currentTime = 30;
        audio.dispatchEvent(new Event('seeking'));
        audio.dispatchEvent(new Event('seeked'));
        vi.advanceTimersByTime(30);
        await nextTick();
        expect(secondaryAttempts).toBe(2);
        expect(japaneseAttempts).toBe(2);

        staleSecondary.resolve('Stale secondary');
        staleJapanese.reject(new Error('stale Japanese failure'));
        await flushPromises();
        await nextTick();
        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('');
        expect(wrapper.get('.learner-subs-expanded .learner-en').text()).toBe('');

        currentSecondary.resolve('Current secondary');
        await flushPromises();
        await nextTick();
        expect(wrapper.get('.learner-subs-expanded .learner-en').text()).toBe('Current secondary');

        currentJapanese.resolve('現在の日本語字幕');
        await flushPromises();
        await nextTick();
        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('現在の日本語字幕');
        expect(wrapper.get('.learner-subs-expanded .learner-en').text()).toBe('Current secondary');
        wrapper.unmount();
    });

    it('keeps a replacement pending pair intact when stale provider callbacks settle', async () => {
        setConfig('learnerSubtitleMode', 'jp-en');
        const source = '設定変更後に再試行する字幕';
        const staleSecondary = deferred<string>();
        const staleJapanese = deferred<string>();
        const currentSecondary = deferred<string>();
        const currentJapanese = deferred<string>();
        let secondaryAttempts = 0;
        let japaneseAttempts = 0;
        vi.mocked(TranslationService.peekCached).mockImplementation((text, target) => (
            text === '確定済み字幕' && target === 'en' ? 'Confirmed subtitle' : null
        ));
        vi.spyOn(TranslationService, 'translate').mockImplementation(async (text, target) => {
            if (text !== source) return '';
            if (target === 'ja') {
                japaneseAttempts += 1;
                return japaneseAttempts === 1 ? staleJapanese.promise : currentJapanese.promise;
            }
            secondaryAttempts += 1;
            return secondaryAttempts === 1 ? staleSecondary.promise : currentSecondary.promise;
        });
        const { wrapper, eventBus } = mountLearner();

        eventBus.emit('whisper:update', {
            text: '確定済み字幕',
            segments: [{ start: 0, end: 10, text: '確定済み字幕' }],
            final: true,
            live: true,
            source: 'complete',
            sourceLanguageHint: 'ja',
        });
        await nextTick();

        eventBus.emit('whisper:update', {
            text: source,
            segments: [],
            final: true,
            live: true,
            source: 'complete',
            sourceLanguageHint: 'zh',
        });
        await nextTick();
        expect(secondaryAttempts).toBe(1);
        expect(japaneseAttempts).toBe(1);

        eventBus.emit('config:change', {
            key: 'translationApiModel',
            value: 'replacement-provider',
        });
        await nextTick();
        expect(secondaryAttempts).toBe(2);
        expect(japaneseAttempts).toBe(2);

        staleSecondary.reject(new Error('stale provider failure'));
        staleJapanese.resolve('古いプロバイダーの日本語');
        await flushPromises();
        await nextTick();
        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('確定済み字幕');
        expect(wrapper.get('.learner-subs-expanded .learner-en').text()).toBe('Confirmed subtitle');

        currentSecondary.resolve('Replacement secondary');
        await flushPromises();
        await nextTick();
        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('確定済み字幕');
        expect(wrapper.get('.learner-subs-expanded .learner-en').text()).toBe('Confirmed subtitle');

        currentJapanese.resolve('置き換え後の日本語');
        await flushPromises();
        await nextTick();
        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('置き換え後の日本語');
        expect(wrapper.get('.learner-subs-expanded .learner-en').text()).toBe('Replacement secondary');
        wrapper.unmount();
    });

    it('releases a retained Chinese pair when one translation leg rejects', async () => {
        setConfig('learnerSubtitleMode', 'jp-en');
        const japanese = deferred<string>();
        const english = deferred<string>();
        vi.mocked(TranslationService.peekCached).mockImplementation((text, target) => (
            text === '以前の字幕' && target === 'en' ? 'Earlier subtitle' : null
        ));
        vi.spyOn(TranslationService, 'translate').mockImplementation(async (text, target) => {
            if (text !== '翻译失败的字幕') return '';
            return target === 'ja' ? japanese.promise : english.promise;
        });
        const { wrapper, eventBus } = mountLearner();

        eventBus.emit('whisper:update', {
            text: '以前の字幕',
            segments: [{ start: 0, end: 10, text: '以前の字幕' }],
            final: true,
            live: true,
            source: 'complete',
            sourceLanguageHint: 'ja',
        });
        await nextTick();

        eventBus.emit('whisper:update', {
            text: '翻译失败的字幕',
            segments: [{ start: 0, end: 10, text: '翻译失败的字幕' }],
            final: true,
            live: true,
            source: 'complete',
            sourceLanguageHint: 'zh',
        });
        await nextTick();

        japanese.resolve('翻訳に失敗した字幕');
        await flushPromises();
        await nextTick();
        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('以前の字幕');
        expect(wrapper.get('.learner-subs-expanded .learner-en').text()).toBe('Earlier subtitle');

        english.reject(new Error('translation unavailable'));
        await flushPromises();
        await nextTick();
        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('翻訳に失敗した字幕');
        expect(wrapper.get('.learner-subs-expanded .learner-en').text()).toBe('');
        expect(wrapper.text()).not.toContain('Earlier subtitle');
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

    it('routes direct English Whisper translation to the secondary lane without retranslating it', async () => {
        setConfig('learnerSubtitleMode', 'jp-en');
        const translate = vi.spyOn(TranslationService, 'translate').mockResolvedValue('should not run');
        const { wrapper, eventBus } = mountLearner();

        eventBus.emit('whisper:update', {
            text: 'Welcome back.',
            segments: [{ start: 0, end: 10, text: 'Welcome back.' }],
            final: false,
            live: true,
            sourceLanguageHint: 'ja',
            outputLanguageHint: 'en',
            timingQuality: 'segment',
        });
        await nextTick();

        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('');
        expect(wrapper.get('.learner-subs-expanded .learner-en').text()).toBe('Welcome back.');
        expect(wrapper.get('.learner-subs-expanded .learner-en').attributes('lang')).toBe('en');
        expect(translate).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it('keeps a real native Japanese cue above direct English Whisper translation', async () => {
        setConfig('learnerSubtitleMode', 'jp-en');
        const translate = vi.spyOn(TranslationService, 'translate').mockResolvedValue('should not run');
        const { wrapper, eventBus } = mountLearner([
            { time: 0, endTime: 10, text: 'お帰りなさい。' },
        ]);

        eventBus.emit('whisper:update', {
            text: 'Welcome back.',
            segments: [{ start: 0, end: 10, text: 'Welcome back.' }],
            final: false,
            live: true,
            sourceLanguageHint: 'ja',
            outputLanguageHint: 'en',
            timingQuality: 'segment',
        });
        await nextTick();

        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('お帰りなさい。');
        expect(wrapper.get('.learner-subs-expanded .learner-en').text()).toBe('Welcome back.');
        expect(translate).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it('honours whisperOverrideSubs=false when a native subtitle is available', async () => {
        setConfig('whisperOverrideSubs', false);
        const { wrapper, eventBus } = mountLearner([
            { time: 0, endTime: 10, text: 'ネイティブ字幕' },
        ]);

        eventBus.emit('whisper:update', {
            text: 'Whisper transcription',
            segments: [{ start: 0, end: 10, text: 'Whisper transcription' }],
            final: false,
            live: true,
            sourceLanguageHint: 'ja',
            outputLanguageHint: 'ja',
            timingQuality: 'segment',
        });
        await nextTick();

        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('ネイティブ字幕');
        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).not.toContain('Whisper');
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

    it('restores the previous confirmed pair when cumulative history rejects a provisional window', async () => {
        setConfig('learnerSubtitleMode', 'jp-en');
        vi.mocked(TranslationService.peekCached).mockImplementation((text, target) => {
            if (target !== 'en') return null;
            if (text === '確定済み字幕') return 'Previously confirmed subtitle';
            if (text === '暫定テキスト') return 'Provisional subtitle';
            return null;
        });
        const { wrapper, eventBus } = mountLearner();
        const audio = document.querySelector('audio')!;

        eventBus.emit('whisper:update', {
            text: '確定済み字幕',
            segments: [{ start: 0, end: 4, text: '確定済み字幕' }],
            final: false,
            live: true,
            source: 'complete',
            sourceLanguageHint: 'ja',
        });
        await nextTick();
        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('確定済み字幕');
        expect(wrapper.get('.learner-subs-expanded .learner-en').text())
            .toBe('Previously confirmed subtitle');

        audio.currentTime = 11;
        eventBus.emit('whisper:update', {
            text: '暫定テキスト',
            segments: [
                { start: 0, end: 4, text: '確定済み字幕' },
                { start: 10, end: 14, text: '暫定テキスト' },
            ],
            final: false,
            live: true,
            source: 'heartbeat',
            sourceLanguageHint: 'ja',
        });
        await nextTick();
        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('暫定テキスト');
        expect(wrapper.get('.learner-subs-expanded .learner-en').text())
            .toBe('Provisional subtitle');

        // Production completion events carry the cumulative finalized history.
        // If the current chunk produced no speech, the provisional tail is
        // absent while older segments (and their latest text) remain present.
        eventBus.emit('whisper:update', {
            text: '確定済み字幕',
            segments: [{ start: 0, end: 4, text: '確定済み字幕' }],
            final: true,
            live: true,
            source: 'complete',
            sourceLanguageHint: 'ja',
        });
        await nextTick();

        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('確定済み字幕');
        expect(wrapper.get('.learner-subs-expanded .learner-en').text())
            .toBe('Previously confirmed subtitle');
        expect(wrapper.text()).not.toContain('暫定テキスト');
        wrapper.unmount();
    });

    it('restores the last confirmed pair instead of retaining provisional text on seek', async () => {
        setConfig('learnerSubtitleMode', 'jp-en');
        vi.mocked(TranslationService.peekCached).mockImplementation((text, target) => {
            if (target !== 'en') return null;
            if (text === '確定済み字幕') return 'Confirmed subtitle';
            if (text === '暫定テキスト') return 'Provisional subtitle';
            return null;
        });
        const { wrapper, eventBus } = mountLearner();
        const audio = document.querySelector('audio')!;

        eventBus.emit('whisper:update', {
            text: '確定済み字幕',
            segments: [{ start: 0, end: 4, text: '確定済み字幕' }],
            final: true,
            live: true,
            source: 'complete',
            sourceLanguageHint: 'ja',
        });
        await nextTick();

        audio.currentTime = 11;
        eventBus.emit('whisper:update', {
            text: '暫定テキスト',
            segments: [
                { start: 0, end: 4, text: '確定済み字幕' },
                { start: 10, end: 14, text: '暫定テキスト' },
            ],
            final: false,
            live: true,
            source: 'heartbeat',
            sourceLanguageHint: 'ja',
        });
        await nextTick();
        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('暫定テキスト');

        audio.currentTime = 120;
        audio.dispatchEvent(new Event('seeking'));
        await nextTick();

        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('確定済み字幕');
        expect(wrapper.get('.learner-subs-expanded .learner-en').text())
            .toBe('Confirmed subtitle');
        expect(wrapper.text()).not.toContain('暫定テキスト');
        wrapper.unmount();
    });

    it('expires a pre-seek caption when the settled target remains uncovered', async () => {
        setConfig('learnerSubtitleMode', 'jp-en');
        vi.mocked(TranslationService.peekCached).mockImplementation((text, target) => (
            text === 'シーク前の確定字幕' && target === 'en' ? 'Confirmed before seek' : null
        ));
        const { wrapper, eventBus } = mountLearner();
        const audio = document.querySelector('audio')!;
        audio.currentTime = 9.9;

        eventBus.emit('whisper:update', {
            text: 'シーク前の確定字幕',
            segments: [{ start: 0, end: 10, text: 'シーク前の確定字幕' }],
            final: true,
            live: true,
            source: 'complete',
            sourceLanguageHint: 'ja',
        });
        await nextTick();

        audio.currentTime = 120;
        audio.dispatchEvent(new Event('seeking'));
        audio.dispatchEvent(new Event('seeked'));
        await nextTick();
        expect(wrapper.get('.learner-subs-expanded .learner-jp').text())
            .toBe('シーク前の確定字幕');
        expect(wrapper.get('.learner-subs-expanded .learner-en').text())
            .toBe('Confirmed before seek');

        vi.advanceTimersByTime(3_499);
        audio.dispatchEvent(new Event('timeupdate'));
        await nextTick();
        expect(wrapper.get('.learner-subs-expanded .learner-jp').text())
            .toBe('シーク前の確定字幕');

        vi.advanceTimersByTime(2);
        audio.dispatchEvent(new Event('timeupdate'));
        await nextTick();
        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('');
        expect(wrapper.get('.learner-subs-expanded .learner-en').text()).toBe('');
        wrapper.unmount();
    });

    it('cancels seek expiry once the target playhead has a real cue', async () => {
        setConfig('learnerSubtitleMode', 'jp-en');
        vi.mocked(TranslationService.peekCached).mockImplementation((text, target) => {
            if (target !== 'en') return null;
            if (text === 'シーク前の字幕') return 'Before seek';
            if (text === 'シーク先の字幕') return 'At seek target';
            return null;
        });
        const { wrapper, eventBus } = mountLearner();
        const audio = document.querySelector('audio')!;
        audio.currentTime = 9.9;

        eventBus.emit('whisper:update', {
            text: 'シーク前の字幕',
            segments: [{ start: 0, end: 10, text: 'シーク前の字幕' }],
            final: true,
            live: true,
            source: 'complete',
            sourceLanguageHint: 'ja',
        });
        await nextTick();

        audio.currentTime = 20.5;
        audio.dispatchEvent(new Event('seeking'));
        audio.dispatchEvent(new Event('seeked'));
        eventBus.emit('whisper:update', {
            text: 'シーク先の字幕',
            segments: [
                { start: 0, end: 10, text: 'シーク前の字幕' },
                { start: 20, end: 22, text: 'シーク先の字幕' },
            ],
            final: true,
            live: true,
            source: 'complete',
            sourceLanguageHint: 'ja',
        });
        await nextTick();
        expect(wrapper.get('.learner-subs-expanded .learner-jp').text())
            .toBe('シーク先の字幕');
        expect(wrapper.get('.learner-subs-expanded .learner-en').text())
            .toBe('At seek target');

        vi.advanceTimersByTime(3_600);
        audio.currentTime = 23;
        audio.dispatchEvent(new Event('timeupdate'));
        await nextTick();
        expect(wrapper.get('.learner-subs-expanded .learner-jp').text())
            .toBe('シーク先の字幕');
        expect(wrapper.get('.learner-subs-expanded .learner-en').text())
            .toBe('At seek target');
        wrapper.unmount();
    });

    it('retains the last confirmed live cue across a quiet gap', async () => {
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

        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('もう終わった字幕');
        wrapper.unmount();
    });

    it('keeps a late successful result after its delayed marker expires', async () => {
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

        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('遅れて届いた字幕');
        expect(wrapper.find('.learner-subs-expanded .learner-whisper-delayed').exists()).toBe(false);
        wrapper.unmount();
    });

    it('keeps a confirmed delayed caption while the seek target is being transcribed', async () => {
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

        expect(wrapper.get('.learner-subs-expanded .learner-jp').text())
            .toBe('前の再生位置から遅れて届いた字幕');
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

    it('retains the current cue without replaying an older backfill after it ends', async () => {
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

        expect(wrapper.get('.learner-subs-expanded .learner-jp').text()).toBe('現在の字幕');
        expect(wrapper.text()).not.toContain('遅れて埋めた古い字幕');
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
