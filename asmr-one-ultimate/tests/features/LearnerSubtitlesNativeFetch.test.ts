import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { INJECT_KEYS } from '../../src/core/MountApp';
import LearnerSubtitles from '../../src/features/components/LearnerSubtitles.vue';
import type { AvailableLyric, KikoeruStoreState, PlayerTrack } from '../../src/types';

type Watcher = {
    getter: (state: KikoeruStoreState) => unknown;
    callback: (value: never, oldValue?: never) => void;
    value: unknown;
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

function createEventBus() {
    const handlers = new Map<string, Set<(payload: unknown) => void>>();
    return {
        on(event: string, handler: (payload: unknown) => void) {
            const listeners = handlers.get(event) || new Set();
            listeners.add(handler);
            handlers.set(event, listeners);
            return () => listeners.delete(handler);
        },
        once(event: string, handler: (payload: unknown) => void) {
            const off = this.on(event, (payload) => {
                off();
                handler(payload);
            });
            return off;
        },
        emit(event: string, payload: unknown) {
            for (const handler of handlers.get(event) || []) handler(payload);
        },
    };
}

function setConfig(key: string, value: unknown): void {
    (globalThis as typeof globalThis & { GM_setValue: (name: string, stored: unknown) => void })
        .GM_setValue(key, value);
}

function lyric(hash: string, url: string): AvailableLyric {
    return { type: 'text', hash, title: `${hash}.vtt`, mediaStreamUrl: url };
}

function track(hash: string, subtitleUrl: string): PlayerTrack {
    return {
        type: 'audio',
        hash,
        title: `${hash}.mp3`,
        mediaStreamUrl: `https://media.example/${hash}.mp3`,
        availableLyrics: [lyric(`${hash}-subtitle`, subtitleUrl)],
    };
}

function createStore(initialTrack: PlayerTrack) {
    const state = {
        AudioPlayer: {
            queue: [initialTrack],
            queueIndex: 0,
            source: initialTrack.mediaStreamUrl,
            hide: false,
            playing: true,
        },
    } as unknown as KikoeruStoreState;
    const watchers: Watcher[] = [];
    const store = {
        state,
        commit: vi.fn(),
        watch(
            getter: Watcher['getter'],
            callback: Watcher['callback'],
            options?: { immediate?: boolean },
        ) {
            const watcher = { getter, callback, value: getter(state) };
            watchers.push(watcher);
            if (options?.immediate) callback(watcher.value as never, undefined);
            return () => {
                const index = watchers.indexOf(watcher);
                if (index >= 0) watchers.splice(index, 1);
            };
        },
    };
    const notify = () => {
        for (const watcher of [...watchers]) {
            const value = watcher.getter(state);
            if (value === watcher.value) continue;
            const oldValue = watcher.value;
            watcher.value = value;
            watcher.callback(value as never, oldValue as never);
        }
    };
    return { store, notify };
}

describe('LearnerSubtitles native subtitle discovery', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = '<audio></audio><div id="mount"></div>';
        Object.defineProperty(document.querySelector('audio'), 'currentTime', {
            configurable: true,
            writable: true,
            value: 1,
        });
        setConfig('showJP', true);
        setConfig('enablePlayerTranslator', false);
        setConfig('karaokeMode', false);
        setConfig('segmentMode', true);
        setConfig('enableJpdb', false);
        setConfig('jpdbSubtitleFurigana', false);
        setConfig('jpdbShowFurigana', false);
        setConfig('playbackRate', 1);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        document.body.innerHTML = '';
    });

    function mountWithTrack(initialTrack: PlayerTrack, axiosGet: ReturnType<typeof vi.fn>) {
        const { store, notify } = createStore(initialTrack);
        const eventBus = createEventBus();
        let routeCallback: ((to: { path?: string }) => void) | null = null;
        const bridge = {
            store,
            app: {
                $watch(_expression: string, callback: (to: { path?: string }) => void) {
                    routeCallback = callback;
                    return () => { routeCallback = null; };
                },
            },
            get currentTrack() {
                const player = store.state.AudioPlayer;
                return player.queue?.[player.queueIndex ?? -1] || null;
            },
            currentWorkId: '123',
            get queue() { return store.state.AudioPlayer.queue; },
            get queueIndex() { return store.state.AudioPlayer.queueIndex; },
            axios: {
                defaults: {
                    baseURL: 'https://media.example/api',
                    headers: { common: { Authorization: 'Bearer host-secret' } },
                },
                get: axiosGet,
            },
            commit: vi.fn(),
        };
        const wrapper = mount(LearnerSubtitles, {
            attachTo: document.getElementById('mount')!,
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
        const navigate = (path: string) => routeCallback?.({ path });
        return { wrapper, store, notify, eventBus, navigate };
    }

    async function renderCurrentTime(): Promise<void> {
        document.querySelector('audio')!.dispatchEvent(new Event('timeupdate'));
        await nextTick();
    }

    it('keeps the initial deferred VTT request alive through first render', async () => {
        const response = deferred<{ data: string }>();
        const mounted = mountWithTrack(
            track('A', 'https://media.example/A.vtt'),
            vi.fn(() => response.promise),
        );

        await nextTick();
        response.resolve({ data: 'WEBVTT\n\n00:00.000 --> 00:04.000\n最初の字幕\n' });
        await flushPromises();
        await renderCurrentTime();

        expect(mounted.wrapper.get('.learner-jp').text()).toBe('最初の字幕');
        mounted.wrapper.unmount();
    });

    it('ignores track A after track B becomes current', async () => {
        const responseA = deferred<{ data: string }>();
        const responseB = deferred<{ data: string }>();
        const axiosGet = vi.fn((url: string) => (
            url.endsWith('/A.vtt') ? responseA.promise : responseB.promise
        ));
        const mounted = mountWithTrack(track('A', 'https://media.example/A.vtt'), axiosGet);

        mounted.store.state.AudioPlayer.queue = [track('B', 'https://media.example/B.vtt')];
        mounted.store.state.AudioPlayer.source = 'https://media.example/B.mp3';
        mounted.notify();
        await vi.advanceTimersByTimeAsync(250);

        responseA.resolve({ data: 'WEBVTT\n\n00:00.000 --> 00:04.000\n古い字幕\n' });
        await flushPromises();
        await renderCurrentTime();
        expect(mounted.wrapper.get('.learner-jp').text()).not.toBe('古い字幕');

        responseB.resolve({ data: 'WEBVTT\n\n00:00.000 --> 00:04.000\n新しい字幕\n' });
        await flushPromises();
        await renderCurrentTime();
        expect(mounted.wrapper.get('.learner-jp').text()).toBe('新しい字幕');
        mounted.wrapper.unmount();
    });

    it('loads native subtitles when host metadata arrives after playback starts', async () => {
        const initialTrack = track('A', 'https://media.example/A.vtt');
        initialTrack.availableLyrics = [];
        const axiosGet = vi.fn((url: string) => Promise.resolve(
            url.endsWith('/A.vtt')
                ? { data: 'WEBVTT\n\n00:00.000 --> 00:04.000\n遅れて届いた字幕\n' }
                : { data: { result: false } },
        ));
        const mounted = mountWithTrack(initialTrack, axiosGet);

        await flushPromises();
        initialTrack.availableLyrics = [{
            type: 'text',
            hash: 'A-subtitle',
            title: 'A.vtt',
            media_stream_url: 'https://media.example/A.vtt',
        }];
        mounted.notify();
        await flushPromises();
        await renderCurrentTime();

        expect(axiosGet).toHaveBeenCalledWith(
            'https://media.example/A.vtt',
            expect.objectContaining({ responseType: 'text', signal: expect.any(AbortSignal) }),
        );
        expect(mounted.wrapper.get('.learner-jp').text()).toBe('遅れて届いた字幕');
        mounted.wrapper.unmount();
    });

    it('does not retry an authenticated LRC endpoint after denial and still accepts late metadata', async () => {
        const initialTrack = track('A', 'https://media.example/A.vtt');
        initialTrack.availableLyrics = [];
        const axiosGet = vi.fn((url: string) => (
            url.includes('/api/media/check-lrc/')
                ? Promise.reject({ response: { status: 401 } })
                : Promise.resolve({
                    data: 'WEBVTT\n\n00:00.000 --> 00:04.000\n後から見つかった字幕\n',
                })
        ));
        const mounted = mountWithTrack(initialTrack, axiosGet);

        await flushPromises();
        await vi.advanceTimersByTimeAsync(10_000);
        await flushPromises();

        expect(axiosGet.mock.calls.filter(([url]) => (
            String(url).includes('/api/media/check-lrc/')
        ))).toHaveLength(1);

        initialTrack.availableLyrics = [lyric('A-subtitle', 'https://media.example/A.vtt')];
        mounted.notify();
        await flushPromises();
        await renderCurrentTime();

        expect(axiosGet).toHaveBeenCalledWith(
            'https://media.example/A.vtt',
            expect.objectContaining({ responseType: 'text', signal: expect.any(AbortSignal) }),
        );
        expect(mounted.wrapper.get('.learner-jp').text()).toBe('後から見つかった字幕');
        mounted.wrapper.unmount();
    });

    it('loads metadata that arrives while an authenticated LRC check is still in flight', async () => {
        const initialTrack = track('A', 'https://media.example/A.vtt');
        initialTrack.availableLyrics = [];
        const deniedCheck = deferred<{ data: { result: boolean } }>();
        const axiosGet = vi.fn((url: string) => (
            url.includes('/api/media/check-lrc/')
                ? deniedCheck.promise
                : Promise.resolve({
                    data: 'WEBVTT\n\n00:00.000 --> 00:04.000\n待機中に見つかった字幕\n',
                })
        ));
        const mounted = mountWithTrack(initialTrack, axiosGet);

        await nextTick();
        expect(axiosGet.mock.calls.filter(([url]) => (
            String(url).includes('/api/media/check-lrc/')
        ))).toHaveLength(1);

        initialTrack.availableLyrics = [lyric('A-subtitle', 'https://media.example/A.vtt')];
        mounted.notify();
        await nextTick();
        expect(axiosGet.mock.calls.some(([url]) => String(url).endsWith('/A.vtt'))).toBe(false);

        deniedCheck.reject({ response: { status: 401 } });
        await flushPromises();
        await renderCurrentTime();

        expect(axiosGet.mock.calls.filter(([url]) => (
            String(url).includes('/api/media/check-lrc/')
        ))).toHaveLength(1);
        expect(axiosGet).toHaveBeenCalledWith(
            'https://media.example/A.vtt',
            expect.objectContaining({ responseType: 'text', signal: expect.any(AbortSignal) }),
        );
        expect(mounted.wrapper.get('.learner-jp').text()).toBe('待機中に見つかった字幕');
        mounted.wrapper.unmount();
    });

    it('aborts an oversized native-hash subtitle before parsing the response', async () => {
        const initialTrack = track('A', 'https://media.example/A.vtt');
        initialTrack.availableLyrics = [];
        const axiosGet = vi.fn((
            url: string,
            config?: {
                signal?: AbortSignal;
                onDownloadProgress?: (event: { loaded: number; total: number }) => void;
            },
        ) => {
            if (url.includes('/api/media/check-lrc/')) {
                return Promise.resolve({ data: { result: true, hash: 'oversized-native-hash' } });
            }
            if (url.includes('/api/media/stream/oversized-native-hash')) {
                config?.onDownloadProgress?.({
                    loaded: (4 * 1024 * 1024) + 1,
                    total: (4 * 1024 * 1024) + 1,
                });
                expect(config?.signal?.aborted).toBe(true);
                return Promise.reject(config?.signal?.reason || new DOMException('Aborted', 'AbortError'));
            }
            return Promise.resolve({ data: { result: false } });
        });
        const mounted = mountWithTrack(initialTrack, axiosGet);

        await flushPromises();
        await renderCurrentTime();

        expect(axiosGet.mock.calls.filter(([url]) => (
            String(url).includes('/api/media/stream/oversized-native-hash')
        ))).toHaveLength(1);
        expect(mounted.wrapper.get('.learner-jp').text()).toBe('');
        mounted.wrapper.unmount();
    });

    it('fetches an external HTTPS subtitle without the authenticated host client or credentials', async () => {
        vi.useRealTimers();
        const axiosGet = vi.fn((_url: string) => Promise.resolve({ data: { result: false } }));
        const externalResponse = deferred<Response>();
        const externalFetch = vi.fn((_url: string, _init?: RequestInit) => externalResponse.promise);
        vi.stubGlobal('fetch', externalFetch);
        const mounted = mountWithTrack(
            track('A', 'https://subtitles.example.org/A.vtt'),
            axiosGet,
        );

        await nextTick();
        externalResponse.resolve(new Response(
            'WEBVTT\n\n00:00.000 --> 00:04.000\n外部字幕です\n',
            { status: 200, headers: { 'content-type': 'text/vtt' } },
        ));
        await flushPromises();
        await renderCurrentTime();

        expect(externalFetch).toHaveBeenCalledWith(
            'https://subtitles.example.org/A.vtt',
            expect.objectContaining({
                credentials: 'omit',
                redirect: 'error',
                referrerPolicy: 'no-referrer',
            }),
        );
        expect(axiosGet.mock.calls.some(([url]) => url === 'https://subtitles.example.org/A.vtt')).toBe(false);
        const requestInit = externalFetch.mock.calls[0]?.[1];
        expect(new Headers(requestInit?.headers).has('Authorization')).toBe(false);
        expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
        expect(requestInit?.signal?.aborted).toBe(false);
        await vi.waitFor(async () => {
            await renderCurrentTime();
            expect(mounted.wrapper.get('.learner-jp').text()).toBe('外部字幕です');
        });
        mounted.wrapper.unmount();
    });

    it('aborts a hanging external subtitle request when the track changes', async () => {
        const axiosGet = vi.fn((_url: string) => Promise.resolve({
            data: 'WEBVTT\n\n00:00.000 --> 00:04.000\n次の字幕\n',
        }));
        let requestSignal: AbortSignal | undefined;
        const externalFetch = vi.fn((_url: string, init?: RequestInit) => {
            requestSignal = init?.signal || undefined;
            return new Promise<Response>((_resolve, reject) => {
                requestSignal?.addEventListener('abort', () => {
                    reject(requestSignal?.reason || new DOMException('Aborted', 'AbortError'));
                }, { once: true });
            });
        });
        vi.stubGlobal('fetch', externalFetch);
        const mounted = mountWithTrack(
            track('A', 'https://subtitles.example.org/A.vtt'),
            axiosGet,
        );

        await nextTick();
        expect(requestSignal?.aborted).toBe(false);

        mounted.store.state.AudioPlayer.queue = [track('B', 'https://media.example/B.vtt')];
        mounted.store.state.AudioPlayer.source = 'https://media.example/B.mp3';
        mounted.notify();
        await vi.advanceTimersByTimeAsync(250);
        await flushPromises();
        await renderCurrentTime();

        expect(requestSignal?.aborted).toBe(true);
        expect(mounted.wrapper.get('.learner-jp').text()).toBe('次の字幕');
        mounted.wrapper.unmount();
    });

    it('rejects an oversized external subtitle before reading its body', async () => {
        const axiosGet = vi.fn((_url: string) => Promise.resolve({ data: { result: false } }));
        const pull = vi.fn();
        const cancel = vi.fn();
        const body = new ReadableStream<Uint8Array>({ pull, cancel });
        const externalFetch = vi.fn(() => Promise.resolve(new Response(body, {
            status: 200,
            headers: {
                'content-length': String((4 * 1024 * 1024) + 1),
                'content-type': 'text/vtt',
            },
        })));
        vi.stubGlobal('fetch', externalFetch);
        const mounted = mountWithTrack(
            track('A', 'https://subtitles.example.org/oversized.vtt'),
            axiosGet,
        );

        await flushPromises();
        await renderCurrentTime();

        expect(cancel).toHaveBeenCalledOnce();
        expect(mounted.wrapper.get('.learner-jp').text()).toBe('');
        mounted.wrapper.unmount();
    });

    it.each([
        'http://127.0.0.1/private.vtt',
        'https://192.168.1.2/private.vtt',
        'https://[::1]/private.vtt',
        'https://[::ffff:127.0.0.1]/private.vtt',
        'https://captions.local/private.vtt',
    ])('blocks private-network subtitle URL %s before transport', async (subtitleUrl) => {
        const axiosGet = vi.fn((_url: string) => Promise.resolve({ data: { result: false } }));
        const externalFetch = vi.fn((_url: string, _init?: RequestInit) => Promise.reject(
            new Error('unexpected external fetch'),
        ));
        vi.stubGlobal('fetch', externalFetch);
        const mounted = mountWithTrack(track('A', subtitleUrl), axiosGet);

        await flushPromises();

        expect(externalFetch).not.toHaveBeenCalled();
        expect(axiosGet.mock.calls.some(([url]) => url === subtitleUrl)).toBe(false);
        mounted.wrapper.unmount();
    });

    it.each([
        '/\\\\evil.example.org/x.vtt',
        '//evil.example.org/x.vtt',
        '/%5cevil.example.org/x.vtt',
        '/%2f%2fevil.example.org/x.vtt',
    ])('does not attach host authorization to ambiguous subtitle URL %s', async (subtitleUrl) => {
        const axiosGet = vi.fn((_url: string) => Promise.resolve({ data: { result: false } }));
        const externalFetch = vi.fn();
        vi.stubGlobal('fetch', externalFetch);
        const mounted = mountWithTrack(track('A', subtitleUrl), axiosGet);

        await flushPromises();

        expect(axiosGet.mock.calls.some(([url]) => String(url).includes('evil.example.org'))).toBe(false);
        expect(externalFetch).not.toHaveBeenCalled();
        mounted.wrapper.unmount();
    });

    it('does not cancel an active native-subtitle fetch on a same-track source update', async () => {
        const response = deferred<{ data: string }>();
        const mounted = mountWithTrack(
            track('A', 'https://media.example/A.vtt'),
            vi.fn(() => response.promise),
        );

        mounted.store.state.AudioPlayer.source = 'blob:https://asmr.one/rebound';
        mounted.notify();
        await vi.advanceTimersByTimeAsync(250);
        response.resolve({ data: 'WEBVTT\n\n00:00.000 --> 00:04.000\n継続した字幕\n' });
        await flushPromises();
        await renderCurrentTime();

        expect(mounted.wrapper.get('.learner-jp').text()).toBe('継続した字幕');
        mounted.wrapper.unmount();
    });

    it('refetches native subtitles after returning to the same active track', async () => {
        const axiosGet = vi.fn((_url: string) => Promise.resolve({
            data: 'WEBVTT\n\n00:00.000 --> 00:04.000\n戻った字幕\n',
        }));
        const mounted = mountWithTrack(track('A', 'https://media.example/A.vtt'), axiosGet);

        await flushPromises();
        await renderCurrentTime();
        expect(mounted.wrapper.get('.learner-jp').text()).toBe('戻った字幕');
        const initialRequests = axiosGet.mock.calls.filter(([url]) => String(url).endsWith('/A.vtt')).length;

        mounted.navigate('/circle/1');
        await nextTick();

        mounted.navigate('/work/RJ00000123');
        await vi.advanceTimersByTimeAsync(150);
        await flushPromises();
        await renderCurrentTime();

        expect(axiosGet.mock.calls.filter(([url]) => String(url).endsWith('/A.vtt'))).toHaveLength(initialRequests + 1);
        expect(mounted.wrapper.get('.learner-jp').text()).toBe('戻った字幕');
        mounted.wrapper.unmount();
    });

    it.each([
        ['work:change', 'still exposes the outgoing track', false],
        ['work:change', 'temporarily exposes no track', true],
        ['track:change', 'still exposes the outgoing track', false],
        ['track:change', 'temporarily exposes no track', true],
    ])('clears stale subtitles when %s fires while the bridge %s', async (event, _case, clearTrack) => {
        const axiosGet = vi.fn((url: string) => Promise.resolve({
            data: url.endsWith('/B.vtt')
                ? 'WEBVTT\n\n00:00.000 --> 00:04.000\n次の作品の字幕\n'
                : 'WEBVTT\n\n00:00.000 --> 00:04.000\n前の作品の字幕\n',
        }));
        const mounted = mountWithTrack(track('A', 'https://media.example/A.vtt'), axiosGet);

        await flushPromises();
        await renderCurrentTime();
        expect(mounted.wrapper.get('.learner-jp').text()).toBe('前の作品の字幕');
        const requestCount = axiosGet.mock.calls.length;

        if (clearTrack) {
            mounted.store.state.AudioPlayer.queue = [];
            mounted.store.state.AudioPlayer.queueIndex = -1;
        }
        mounted.eventBus.emit(event, { workId: '456' });
        await nextTick();

        expect(mounted.wrapper.get('.learner-jp').text()).toBe('');
        expect(axiosGet).toHaveBeenCalledTimes(requestCount);

        mounted.store.state.AudioPlayer.queue = [track('B', 'https://media.example/B.vtt')];
        mounted.store.state.AudioPlayer.queueIndex = 0;
        mounted.store.state.AudioPlayer.source = 'https://media.example/B.mp3';
        mounted.notify();
        await vi.advanceTimersByTimeAsync(250);
        await flushPromises();
        await renderCurrentTime();

        expect(mounted.wrapper.get('.learner-jp').text()).toBe('次の作品の字幕');
        mounted.wrapper.unmount();
    });
});
