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
});
