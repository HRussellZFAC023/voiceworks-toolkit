import { describe, it, expect, beforeEach } from 'vitest';
import { Whisper, resolveWhisperLanguage, resolveWhisperModelPreset } from '../../src/features/Whisper';
import { DeviceCapabilities } from '../../src/core/DeviceCapabilities';
import { GpuScheduler, Priority } from '../../src/core/GpuScheduler';
import { Config } from '../../src/core/Utils';
import { EventBus } from '../../src/core/EventBus';
import { TranslationService } from '../../src/services/TranslationService';
import { MLCrashGuard } from '../../src/core/MLCrashGuard';
import { SharedCache } from '../../src/core/Cache';
import { AppStore } from '../../src/store/AppStore';

const { gmSpy, trustedCorsSpy } = vi.hoisted(() => ({
    gmSpy: vi.fn(),
    trustedCorsSpy: vi.fn(() => false),
}));

vi.mock('../../src/infrastructure/HttpClient', async () => {
    const actual = await vi.importActual<any>('../../src/infrastructure/HttpClient');
    return {
        ...actual,
        gmRequest: gmSpy,
    };
});

vi.mock('../../src/infrastructure/AudioCache', () => ({
    AudioCache: class {
        static objectUrls = new Map<string, string>();
        static hasTrustedCorsPlayback = trustedCorsSpy;
        getBlob() {
            return null;
        }
    }
}));

describe('Whisper', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        document.body.innerHTML = '';
        (Whisper as any).instance = null;
        (Whisper as any).webgpuFailed = false;
        (Whisper as any).webgpuRetryNotBefore = 0;
        (Whisper as any).gpuRecoveryAttempts = 0;
        (Whisper as any).crashRecoveries = 0;
        SharedCache.clear();
        trustedCorsSpy.mockReset();
        trustedCorsSpy.mockReturnValue(false);
    });

    describe('spoken-language policy', () => {
        it('is Japanese-first for auto, using catalogue language only for original works', () => {
            expect(resolveWhisperLanguage('auto')).toBe('japanese');
            expect(resolveWhisperLanguage('auto', {
                translation_info: { lang: 'CHI_HANS', is_original: false },
            })).toBe('japanese');
            expect(resolveWhisperLanguage('auto', {
                translation_info: { lang: 'ENG', is_original: false },
            })).toBe('japanese');
            expect(resolveWhisperLanguage('auto', {
                translation_info: { lang: 'CHI_HANS', is_original: true },
            })).toBe('chinese');
            expect(resolveWhisperLanguage('auto', {
                translation_info: { lang: 'ENG', is_original: true },
            })).toBe('english');
            expect(resolveWhisperLanguage('detect')).toBe('');
            expect(resolveWhisperLanguage('en')).toBe('english');
        });

        it('keeps RJ01503719-shaped translated editions on Japanese audio', () => {
            expect(resolveWhisperLanguage('auto', {
                id: 1503719,
                source_id: 'RJ01503719',
                original_workno: 'RJ01501861',
                translation_info: { lang: 'CHI_HANS', is_original: false },
            })).toBe('japanese');
        });
    });

    describe('feature lifecycle', () => {
        it('rejects non-HTTP audio URLs before invoking a download transport', async () => {
            const whisper = new Whisper();
            await expect((whisper as any).fetchAndDecodeAudio('javascript:alert(1)'))
                .rejects.toThrow('Unsupported audio URL protocol');
            expect(gmSpy).not.toHaveBeenCalled();
        });

        it('uses the RJ01503719 source ladder: low quality, stream, then download', () => {
            const whisper = new Whisper();

            expect((whisper as any).resolveTrackUrl({
                type: 'audio',
                hash: 'track-a',
                title: 'Track A',
                streamLowQualityUrl: 'https://raw.kiko-play-niptan.one/low/track-a.m4a',
                mediaStreamUrl: 'https://example.com/camel-stream',
                media_stream_url: 'https://example.com/snake-stream',
                mediaDownloadUrl: 'https://example.com/large-download.zip',
            })).toBe('https://raw.kiko-play-niptan.one/low/track-a.m4a');

            expect((whisper as any).resolveTrackUrl({
                type: 'audio',
                hash: 'track-b',
                title: 'Track B',
                stream_low_quality_url: 'https://raw.kiko-play-niptan.one/low/track-b.m4a',
                mediaStreamUrl: '',
                media_stream_url: 'https://example.com/snake-stream',
                stream_url: 'https://example.com/alternate-stream',
                mediaDownloadUrl: 'https://example.com/large-download.zip',
            })).toBe('https://raw.kiko-play-niptan.one/low/track-b.m4a');

            expect((whisper as any).resolveTrackUrl({
                type: 'audio',
                hash: 'track-c',
                title: 'Track C',
                mediaStreamUrl: 'https://example.com/full-stream',
                mediaDownloadUrl: 'https://example.com/full-download',
            })).toBe('https://example.com/full-stream');

            expect((whisper as any).resolveTrackUrl({
                type: 'audio',
                hash: 'track-d',
                title: 'Track D',
                mediaStreamUrl: '',
                mediaDownloadUrl: 'https://example.com/full-download',
            })).toBe('https://example.com/full-download');

            expect((whisper as any).resolveFallbackAudioSource({
                type: 'audio',
                hash: 'rj01503719-track',
                title: 'RJ01503719 Track',
                streamLowQualityUrl: 'https://raw.kiko-play-niptan.one/low/track.m4a',
                mediaStreamUrl: 'https://raw.kiko-play-niptan.one/full/track.flac',
                mediaDownloadUrl: 'https://api.asmr.one/api/media/download/track',
                size: 39_762_038,
            }, 'fallback')).toEqual({
                url: 'https://raw.kiko-play-niptan.one/low/track.m4a',
                knownSizeBytes: null,
                allowUnknownSize: true,
                preferBoundedStreaming: true,
            });

            expect((whisper as any).resolveFallbackAudioSource({
                type: 'audio',
                hash: 'small-full-track',
                title: 'Small Full Track',
                mediaStreamUrl: 'https://example.com/full-stream',
                size: 30_186_038,
            }, 'fallback')).toEqual({
                url: 'https://example.com/full-stream',
                knownSizeBytes: 30_186_038,
                allowUnknownSize: false,
                preferBoundedStreaming: false,
            });
        });

        it('does not start an unbounded fallback download for unknown or large files', async () => {
            const whisper = new Whisper();
            const axiosGet = vi.fn();
            vi.spyOn((whisper as any).bridge, 'axios', 'get').mockReturnValue({ get: axiosGet });
            gmSpy.mockClear();
            const fetchSpy = vi.mocked(fetch);
            fetchSpy.mockClear();

            await expect((whisper as any).fetchAndDecodeAudio(
                'https://example.com/unknown.mp3',
                undefined,
                null,
            )).rejects.toThrow(/32|known size|whisperLiveCaptureFallbackLimit/i);
            await expect((whisper as any).fetchAndDecodeAudio(
                'https://example.com/large.mp3',
                undefined,
                64 * 1024 * 1024,
            )).rejects.toThrow(/32|known size|whisperLiveCaptureFallbackLimit/i);

            expect(axiosGet).not.toHaveBeenCalled();
            expect(gmSpy).not.toHaveBeenCalled();
            expect(fetchSpy).not.toHaveBeenCalled();
        });

        it('streams an unknown-size low-quality source through the same 32 MiB cap', async () => {
            const whisper = new Whisper();
            const decode = vi.spyOn(whisper as any, 'decodeToPcm')
                .mockResolvedValue(new Float32Array([0.25]));
            const response = {
                ok: true,
                headers: new Headers(),
                body: new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
                        controller.close();
                    },
                }),
                blob: vi.fn(),
            } as unknown as Response;
            vi.mocked(fetch).mockResolvedValueOnce(response);

            const pcm = await (whisper as any).fetchAndDecodeAudio(
                'https://raw.kiko-play-niptan.one/low/track.m4a',
                undefined,
                null,
                true,
                true,
            );

            expect(pcm).toEqual(new Float32Array([0.25]));
            expect(fetch).toHaveBeenCalledTimes(1);
            expect(decode).toHaveBeenCalledWith(expect.any(ArrayBuffer), undefined);
        });

        it('rejects an oversized low-quality response before reading or decoding it', async () => {
            const whisper = new Whisper();
            const decode = vi.spyOn(whisper as any, 'decodeToPcm');
            const response = {
                ok: true,
                headers: new Headers({ 'content-length': String(33 * 1024 * 1024) }),
                body: new ReadableStream<Uint8Array>(),
                blob: vi.fn(),
            } as unknown as Response;
            vi.mocked(fetch).mockResolvedValueOnce(response);

            await expect((whisper as any).fetchAndDecodeAudio(
                'https://raw.kiko-play-niptan.one/low/oversized.m4a',
                undefined,
                null,
                true,
                true,
            )).rejects.toThrow(/32|whisperLiveCaptureFallbackLimit/i);
            expect(decode).not.toHaveBeenCalled();
        });

        it('will not allocate an unknown-size low-quality response without a streaming body', async () => {
            const whisper = new Whisper();
            const decode = vi.spyOn(whisper as any, 'decodeToPcm');
            const blob = vi.fn();
            vi.mocked(fetch).mockResolvedValueOnce({
                ok: true,
                headers: new Headers(),
                body: null,
                blob,
            } as unknown as Response);

            await expect((whisper as any).fetchAndDecodeAudio(
                'https://raw.kiko-play-niptan.one/low/no-stream-body.m4a',
                undefined,
                null,
                true,
                true,
            )).rejects.toThrow(/32|known size|whisperLiveCaptureFallbackLimit/i);
            expect(blob).not.toHaveBeenCalled();
            expect(decode).not.toHaveBeenCalled();
        });

        it('allows the hard-cap boundary but rejects a full source one byte over it', () => {
            const whisper = new Whisper();
            expect(() => (whisper as any).assertFallbackAudioSize(32 * 1024 * 1024)).not.toThrow();
            expect(() => (whisper as any).assertFallbackAudioSize(32 * 1024 * 1024 + 1))
                .toThrow(/32|whisperLiveCaptureFallbackLimit/i);
        });

        it('starts from live capture without fetching the track again', async () => {
            const whisper = new Whisper();
            const audio = document.createElement('audio');
            audio.src = `${window.location.origin}/api/media/stream/track-a`;
            document.body.appendChild(audio);
            vi.spyOn((whisper as any).bridge, 'currentTrack', 'get').mockReturnValue({
                type: 'audio',
                hash: 'track-a',
                title: 'Track A',
                mediaStreamUrl: audio.src,
                mediaDownloadUrl: `${window.location.origin}/api/media/download/track-a`,
                size: 500 * 1024 * 1024,
            });
            vi.spyOn((whisper as any).bridge, 'currentWorkId', 'get').mockReturnValue('RJ000001');
            vi.spyOn(whisper as any, 'getWhisperSettings').mockReturnValue({
                model: 'onnx-community/whisper-tiny',
                subtask: 'transcribe',
                language: 'ja',
                multilingual: true,
                chunkLengthS: 29,
                strideLengthS: 5,
                cacheTranscripts: false,
                autoWarmup: false,
                silenceThreshold: 0,
                maxPendingChunks: 1,
                pollIntervalMs: 500,
                workerUpdateIntervalMs: 350,
                idleUnloadMs: 120_000,
                forceWasm: true,
                preferLowPowerAdapter: true,
                minWebgpuBufferBytes: 256 * 1024 * 1024,
            });
            vi.spyOn(whisper as any, 'initWorker').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'startProcessingLoop').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'scheduleIdleUnload').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'persistCache').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'startLiveAudioCapture').mockReturnValue(true);
            const fetchAudio = vi.spyOn(whisper as any, 'fetchAndDecodeAudio');
            (whisper as any).enabled = true;

            await (whisper as any).startTranscription();

            expect((whisper as any).startLiveAudioCapture).toHaveBeenCalled();
            expect(fetchAudio).not.toHaveBeenCalled();
            expect((whisper as any).transcribing).toBe(true);
            (whisper as any).stopTranscription('test');
        });

        it('uses bounded low-quality fallback without touching the oversized full source', async () => {
            const whisper = new Whisper();
            const audio = document.createElement('audio');
            document.body.appendChild(audio);
            const lowUrl = 'https://raw.kiko-play-niptan.one/low/RJ01503719-track.m4a';
            const fullStreamUrl = 'https://raw.kiko-play-niptan.one/full/RJ01503719-track.flac';
            const fullDownloadUrl = 'https://api.asmr.one/api/media/download/RJ01503719-track';
            vi.spyOn((whisper as any).bridge, 'currentTrack', 'get').mockReturnValue({
                type: 'audio',
                hash: 'rj01503719-track',
                title: 'RJ01503719 Track',
                streamLowQualityUrl: lowUrl,
                mediaStreamUrl: fullStreamUrl,
                mediaDownloadUrl: fullDownloadUrl,
                size: 39_762_038,
            });
            vi.spyOn((whisper as any).bridge, 'currentWorkId', 'get').mockReturnValue('RJ01503719');
            vi.spyOn(whisper as any, 'getWhisperSettings').mockReturnValue({
                model: 'onnx-community/whisper-tiny',
                subtask: 'transcribe',
                language: 'ja',
                multilingual: true,
                chunkLengthS: 29,
                strideLengthS: 5,
                cacheTranscripts: false,
                autoWarmup: false,
                silenceThreshold: 0,
                maxPendingChunks: 1,
                pollIntervalMs: 500,
                workerUpdateIntervalMs: 350,
                idleUnloadMs: 120_000,
                forceWasm: true,
                preferLowPowerAdapter: true,
                minWebgpuBufferBytes: 256 * 1024 * 1024,
            });
            vi.spyOn(whisper as any, 'initWorker').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'startProcessingLoop').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'scheduleIdleUnload').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'persistCache').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'startLiveAudioCapture').mockReturnValue(false);
            const fetchAudio = vi.spyOn(whisper as any, 'fetchAndDecodeAudio')
                .mockResolvedValue(new Float32Array(6 * 16_000));
            (whisper as any).enabled = true;

            await (whisper as any).startTranscription();

            expect(fetchAudio).toHaveBeenCalledWith(
                lowUrl,
                expect.any(AbortSignal),
                null,
                true,
                true,
            );
            expect(fetchAudio).not.toHaveBeenCalledWith(
                expect.stringMatching(/full|download/),
                expect.anything(),
                expect.anything(),
                expect.anything(),
                expect.anything(),
            );
            (whisper as any).stopTranscription('test');
        });

        it('binds listeners once, disposes them, and rebinds once', () => {
            const whisper = new Whisper();
            const unwatch = vi.fn();
            const watch = vi.fn().mockReturnValue(unwatch);
            vi.spyOn((whisper as any).bridge, 'store', 'get').mockReturnValue({
                state: {},
                watch,
            });
            vi.spyOn(Config, 'get').mockImplementation((key) => key === 'whisperAutoWarmup' ? false : false);

            const baseline = EventBus.listenerCount('whisper:toggle');

            whisper.enable();
            whisper.enable();
            expect(EventBus.listenerCount('whisper:toggle')).toBe(baseline + 1);
            expect(watch).toHaveBeenCalledTimes(1);

            whisper.disable();
            whisper.disable();
            expect(EventBus.listenerCount('whisper:toggle')).toBe(baseline);
            expect(unwatch).toHaveBeenCalledTimes(1);

            whisper.enable();
            expect(EventBus.listenerCount('whisper:toggle')).toBe(baseline + 1);
            expect(watch).toHaveBeenCalledTimes(2);
            whisper.disable();
        });

        it('cancels active runtime work and unloads the worker on disable', () => {
            vi.useFakeTimers();
            try {
                const whisper = new Whisper();
                const unwatch = vi.fn();
                vi.spyOn((whisper as any).bridge, 'store', 'get').mockReturnValue({
                    state: {},
                    watch: vi.fn().mockReturnValue(unwatch),
                });
                vi.spyOn(Config, 'get').mockReturnValue(false);

                whisper.enable();
                const abort = vi.fn();
                const terminate = vi.fn();
                (whisper as any).fetchAbortController = { abort };
                (whisper as any).worker = { postMessage: vi.fn(), terminate };
                (whisper as any).transcribing = true;
                (whisper as any).autoTranscribeWorkId = 'RJ000001';
                (whisper as any).processingLoopId = window.setInterval(() => {}, 1000);

                whisper.disable();
                vi.advanceTimersByTime(500);

                expect(abort).toHaveBeenCalledTimes(1);
                expect(terminate).toHaveBeenCalledTimes(1);
                expect(unwatch).toHaveBeenCalledTimes(1);
                expect((whisper as any).enabled).toBe(false);
                expect((whisper as any).transcribing).toBe(false);
                expect((whisper as any).autoTranscribeWorkId).toBeNull();
                expect((whisper as any).processingLoopId).toBeNull();
                expect((whisper as any).worker).toBeNull();
            } finally {
                vi.useRealTimers();
            }
        });

        it('mounts status as a no-flow cover overlay before first load and removes it on disable', () => {
            const player = document.createElement('div');
            player.className = 'audio-player';
            const albumArt = document.createElement('div');
            albumArt.className = 'albumart';
            player.appendChild(albumArt);
            document.body.appendChild(player);

            const whisper = new Whisper();
            vi.spyOn((whisper as any).bridge, 'store', 'get').mockReturnValue({
                state: {},
                watch: vi.fn().mockReturnValue(vi.fn()),
            });
            vi.spyOn(Config, 'get').mockReturnValue(false);

            whisper.enable();
            const status = document.querySelector('.whisper-status') as HTMLElement;
            expect(status).not.toBeNull();
            expect(status.parentElement).toBe(albumArt);
            expect(status.classList.contains('whisper-status--overlay')).toBe(true);
            expect(status.innerHTML).toBe('');
            expect(status.style.visibility).toBe('hidden');

            (whisper as any).showStatus('<span>Loading</span>');

            (whisper as any).clearStatus();
            expect(status.style.display).toBe('none');
            expect(status.style.visibility).toBe('hidden');

            whisper.disable();
            expect(status.isConnected).toBe(false);
        });
    });

    describe('transcription restart races', () => {
        const settings = {
            model: 'onnx-community/whisper-small_timestamped',
            subtask: 'transcribe',
            language: 'ja',
            multilingual: true,
            chunkLengthS: 29,
            strideLengthS: 5,
            cacheTranscripts: false,
            autoWarmup: false,
            silenceThreshold: 0,
            maxPendingChunks: 6,
            pollIntervalMs: 250,
            workerUpdateIntervalMs: 200,
            idleUnloadMs: 600_000,
            forceWasm: false,
            preferLowPowerAdapter: false,
            minWebgpuBufferBytes: 256 * 1024 * 1024,
        };

        function deferred<T>() {
            let resolve!: (value: T) => void;
            let reject!: (error: unknown) => void;
            const promise = new Promise<T>((res, rej) => {
                resolve = res;
                reject = rej;
            });
            return { promise, resolve, reject };
        }

        function setupRestartRace() {
            const whisper = new Whisper();
            const audio = document.createElement('audio');
            document.body.appendChild(audio);
            let trackUrl = 'https://example.com/a.mp3';
            vi.spyOn((whisper as any).bridge, 'currentTrack', 'get').mockImplementation(() => ({
                type: 'audio',
                hash: trackUrl,
                title: trackUrl.endsWith('a.mp3') ? 'A' : 'B',
                mediaStreamUrl: trackUrl,
            }));
            vi.spyOn((whisper as any).bridge, 'currentWorkId', 'get').mockReturnValue('RJ000001');
            vi.spyOn(whisper as any, 'getWhisperSettings').mockReturnValue(settings);
            vi.spyOn(whisper as any, 'initWorker').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'startProcessingLoop').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'scheduleIdleUnload').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'persistCache').mockImplementation(() => {});
            (whisper as any).enabled = true;

            const first = deferred<Float32Array>();
            const second = deferred<Float32Array>();
            vi.spyOn(whisper as any, 'fetchAndDecodeAudio')
                .mockReturnValueOnce(first.promise)
                .mockReturnValueOnce(second.promise);

            return {
                whisper,
                first,
                second,
                useTrackB: () => { trackUrl = 'https://example.com/b.mp3'; },
            };
        }

        async function startReplacement(setup: ReturnType<typeof setupRestartRace>) {
            const firstRun = (setup.whisper as any).startTranscription();
            (setup.whisper as any).stopTranscription('track-change');
            (setup.whisper as any).resetState('track-change');
            setup.useTrackB();
            const secondRun = (setup.whisper as any).startTranscription();
            const secondBuffer = new Float32Array(32_000);
            setup.second.resolve(secondBuffer);
            await secondRun;
            return { firstRun, secondBuffer };
        }

        it('does not let an uncancellable old download overwrite the replacement PCM', async () => {
            const setup = setupRestartRace();
            const { firstRun, secondBuffer } = await startReplacement(setup);

            setup.first.resolve(new Float32Array(16_000));
            await firstRun;

            expect((setup.whisper as any).transcribing).toBe(true);
            expect((setup.whisper as any).pcmBuffer).toBe(secondBuffer);
            expect((setup.whisper as any).pcmSourceUrl).toBe('https://example.com/b.mp3');
        });

        it('does not let an old AbortError stop the replacement transcription', async () => {
            const setup = setupRestartRace();
            const { firstRun, secondBuffer } = await startReplacement(setup);

            setup.first.reject(new DOMException('old request aborted', 'AbortError'));
            await firstRun;

            expect((setup.whisper as any).transcribing).toBe(true);
            expect((setup.whisper as any).pcmBuffer).toBe(secondBuffer);
            expect((setup.whisper as any).pcmSourceUrl).toBe('https://example.com/b.mp3');
        });
    });

    describe('worker replacement races', () => {
        it('settles a controlled init reset so crash sentinels do not accumulate', () => {
            const whisper = new Whisper();
            const initComplete = vi.spyOn(MLCrashGuard, 'initComplete').mockImplementation(() => {});
            (whisper as any).workerInitPending = {
                worker: { postMessage: vi.fn(), terminate: vi.fn() },
                generation: 1,
            };

            (whisper as any).resetWorker('model-load-timeout-smaller-model');

            expect(initComplete).toHaveBeenCalledWith('whisper');
            expect((whisper as any).workerInitPending).toBeNull();
        });

        it('ignores queued ready/error/load callbacks from a detached worker', () => {
            vi.useFakeTimers();
            const workers: Array<{
                onmessage: ((event: MessageEvent) => void) | null;
                onerror: ((event: ErrorEvent) => void) | null;
                postMessage: ReturnType<typeof vi.fn>;
                terminate: ReturnType<typeof vi.fn>;
            }> = [];
            class MockWorker {
                onmessage: ((event: MessageEvent) => void) | null = null;
                onerror: ((event: ErrorEvent) => void) | null = null;
                postMessage = vi.fn();
                terminate = vi.fn();
                constructor() { workers.push(this); }
            }

            const NativeURL = URL;
            class MockURL extends NativeURL {}
            Object.assign(MockURL, {
                createObjectURL: vi.fn(() => 'blob:whisper-test'),
                revokeObjectURL: vi.fn(),
            });
            vi.stubGlobal('URL', MockURL);
            vi.stubGlobal('Worker', MockWorker);
            try {
                const whisper = new Whisper();
                (whisper as any).ensureWorker();
                const oldWorker = workers[0];
                const queuedMessage = oldWorker.onmessage!;
                const queuedError = oldWorker.onerror!;

                (whisper as any).resetWorker('replacement-test');
                (whisper as any).ensureWorker();
                (whisper as any).modelReady = false;
                (whisper as any).transcribing = true;
                const stopSpy = vi.spyOn(whisper as any, 'stopTranscription');

                queuedMessage({ data: { status: 'ready' } } as MessageEvent);
                queuedError({ message: 'createBuffer failed' } as ErrorEvent);
                queuedMessage({
                    data: {
                        status: 'load-failed',
                        backend: 'wasm',
                        data: { message: 'stale session failure', sessionPoisoned: true },
                    },
                } as MessageEvent);

                expect((whisper as any).modelReady).toBe(false);
                expect(stopSpy).not.toHaveBeenCalled();
                expect((whisper as any).worker).toBe(workers[1]);
            } finally {
                vi.runOnlyPendingTimers();
                vi.unstubAllGlobals();
                vi.useRealTimers();
            }
        });

        it('replaces a poisoned WebGPU loader with a fresh tiny worker forced to WASM', async () => {
            vi.useFakeTimers();
            const workers: Array<{
                onmessage: ((event: MessageEvent) => void) | null;
                onerror: ((event: ErrorEvent) => void) | null;
                postMessage: ReturnType<typeof vi.fn>;
                terminate: ReturnType<typeof vi.fn>;
            }> = [];
            class MockWorker {
                onmessage: ((event: MessageEvent) => void) | null = null;
                onerror: ((event: ErrorEvent) => void) | null = null;
                postMessage = vi.fn();
                terminate = vi.fn();
                constructor() { workers.push(this); }
            }

            const NativeURL = URL;
            class MockURL extends NativeURL {}
            Object.assign(MockURL, {
                createObjectURL: vi.fn(() => 'blob:whisper-load-recovery'),
                revokeObjectURL: vi.fn(),
            });
            vi.stubGlobal('URL', MockURL);
            vi.stubGlobal('Worker', MockWorker);
            const releaseLease = vi.fn();
            vi.spyOn(GpuScheduler, 'acquireLoadLease').mockResolvedValue(releaseLease);

            let whisper: Whisper | null = null;
            try {
                whisper = new Whisper();
                (whisper as any).enabled = true;
                (whisper as any).transcribing = true;
                (whisper as any).consecutiveInferenceTimeouts = 1;
                (whisper as any).ensureWorker();
                const oldWorker = workers[0];
                const stopSpy = vi.spyOn(whisper as any, 'stopTranscription');

                oldWorker.onmessage!({
                    data: {
                        status: 'load-failed',
                        backend: 'webgpu',
                        model: 'onnx-community/whisper-small_timestamped',
                        dtype: '{"encoder_model":"fp32","decoder_model_merged":"q4"}',
                        data: {
                            message: 'WebGPU session creation failed',
                            sessionPoisoned: true,
                        },
                    },
                } as MessageEvent);
                await Promise.resolve();
                await Promise.resolve();

                expect(workers).toHaveLength(2);
                expect(oldWorker.terminate).toHaveBeenCalledTimes(1);
                expect((whisper as any).worker).toBe(workers[1]);
                expect((whisper as any).modelOverride).toBe('onnx-community/whisper-tiny');
                expect((Whisper as any).webgpuFailed).toBe(true);
                expect((whisper as any).transcribing).toBe(true);
                expect(stopSpy).not.toHaveBeenCalled();
                expect((whisper as any).consecutiveInferenceTimeouts).toBe(1);

                expect(workers[1].postMessage.mock.calls[0]?.[0]).toEqual({ type: 'skip-webgpu' });
                expect(workers[1].postMessage).toHaveBeenCalledWith(expect.objectContaining({
                    type: 'init',
                    model: 'onnx-community/whisper-tiny',
                }));
            } finally {
                if (whisper) (whisper as any).resetWorker('test-cleanup', true);
                vi.clearAllTimers();
                vi.unstubAllGlobals();
                vi.useRealTimers();
            }
        });

        it('treats a WASM load failure as terminal without consuming inference retries', () => {
            const whisper = new Whisper();
            const worker = {
                postMessage: vi.fn(),
                terminate: vi.fn(),
                onmessage: null,
                onerror: null,
            };
            const initSpy = vi.spyOn(whisper as any, 'initWorker').mockImplementation(() => {});
            const stopSpy = vi.spyOn(whisper as any, 'stopTranscription').mockImplementation(() => {
                (whisper as any).transcribing = false;
            });
            vi.spyOn(whisper as any, 'showStatus').mockImplementation(() => {});
            (whisper as any).worker = worker;
            (whisper as any).workerBackend = 'wasm';
            (whisper as any).transcribing = true;
            (whisper as any).consecutiveInferenceTimeouts = 1;

            (whisper as any).handleWorkerMessage({
                data: {
                    status: 'load-failed',
                    backend: 'wasm',
                    model: 'onnx-community/whisper-tiny',
                    dtype: 'q8-basic',
                    data: {
                        message: 'WASM session creation failed',
                        sessionPoisoned: true,
                    },
                },
            });

            expect(worker.terminate).toHaveBeenCalledTimes(1);
            expect(worker.postMessage).not.toHaveBeenCalledWith({ type: 'reset' });
            expect((whisper as any).worker).toBeNull();
            expect(stopSpy).toHaveBeenCalledWith('wasm-model-load-failed');
            expect(initSpy).not.toHaveBeenCalled();
            expect((whisper as any).transcribing).toBe(false);
            expect((whisper as any).consecutiveInferenceTimeouts).toBe(1);
        });

        it('deduplicates warmup and transcription init on the same worker', async () => {
            const whisper = new Whisper();
            const worker = {
                postMessage: vi.fn(),
                terminate: vi.fn(),
                onmessage: null,
                onerror: null,
            };
            const release = vi.fn();
            let resolveLease!: (release: () => void) => void;
            const lease = new Promise<() => void>(resolve => { resolveLease = resolve; });
            const acquireSpy = vi.spyOn(GpuScheduler, 'acquireLoadLease').mockReturnValue(lease);
            const settings = {
                model: 'onnx-community/whisper-small_timestamped',
                subtask: 'transcribe',
                language: 'ja',
                multilingual: true,
                chunkLengthS: 29,
                strideLengthS: 5,
                cacheTranscripts: true,
                autoWarmup: true,
                silenceThreshold: 0,
                maxPendingChunks: 6,
                pollIntervalMs: 250,
                workerUpdateIntervalMs: 200,
                idleUnloadMs: 600_000,
                forceWasm: false,
                preferLowPowerAdapter: false,
                minWebgpuBufferBytes: 256 * 1024 * 1024,
            };
            (whisper as any).enabled = true;
            (whisper as any).worker = worker;
            vi.spyOn(whisper as any, 'ensureWorker').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'getWhisperSettings').mockReturnValue(settings);

            (whisper as any).initWorker(settings);
            (whisper as any).initWorker(settings);
            expect(acquireSpy).toHaveBeenCalledTimes(1);

            resolveLease(release);
            await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(1));
            expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'init' }));

            (whisper as any).handleWorkerMessage({ data: { status: 'ready' } });
            (whisper as any).initWorker(settings);
            expect(acquireSpy).toHaveBeenCalledTimes(1);
            expect(release).toHaveBeenCalledTimes(1);
        });
    });

    describe('audio decode watchdog', () => {
        it('rejects a browser decode that hangs instead of staying at 55% forever', async () => {
            vi.useFakeTimers();
            class HangingOfflineAudioContext {
                decodeAudioData(): Promise<AudioBuffer> {
                    return new Promise(() => {});
                }
            }
            vi.stubGlobal('OfflineAudioContext', HangingOfflineAudioContext);
            try {
                const whisper = new Whisper();
                const decode = (whisper as any).decodeToPcm(new ArrayBuffer(1024));
                const rejection = expect(decode).rejects.toThrow(/timed out|whisperDecodeTimeout/i);

                await vi.advanceTimersByTimeAsync(90_001);
                await rejection;
            } finally {
                vi.unstubAllGlobals();
                vi.useRealTimers();
            }
        });

        it('scales decode timeouts for large files but caps them', () => {
            const whisper = new Whisper();
            expect((whisper as any).getAudioDecodeTimeoutMs(1024)).toBe(90_000);
            expect((whisper as any).getAudioDecodeTimeoutMs(500 * 1024 * 1024)).toBe(600_000);
        });
    });

    describe('bounded live PCM scheduling', () => {
        const liveSettings = {
            chunkLengthS: 29,
            strideLengthS: 5,
            silenceThreshold: 0,
            maxPendingChunks: 6,
        };

        function setupLiveBuffer(startTime: number, validSeconds: number) {
            const whisper = new Whisper();
            const audio = document.createElement('audio');
            audio.currentTime = startTime + validSeconds;
            vi.spyOn((whisper as any).bridge, 'currentTrack', 'get').mockReturnValue(undefined);
            vi.spyOn(whisper as any, 'getWhisperSettings').mockReturnValue(liveSettings);
            const send = vi.spyOn(whisper as any, 'sendChunk').mockImplementation(() => {});

            const capacity = 12 * 16_000;
            const validLength = validSeconds * 16_000;
            const buffer = new Float32Array(capacity);
            buffer.fill(0.5, 0, validLength);
            (whisper as any).audio = audio;
            (whisper as any).transcribing = true;
            (whisper as any).modelReady = true;
            (whisper as any).liveCaptureActive = true;
            (whisper as any).liveCaptureEnded = false;
            (whisper as any).pcmBuffer = buffer;
            (whisper as any).pcmBufferStartTime = startTime;
            (whisper as any).pcmSampleLength = validLength;
            (whisper as any).pcmDuration = startTime + validSeconds;
            (whisper as any).transcribedUpTo = startTime;
            return { whisper, audio, send };
        }

        it('will not create a new Web Audio source for cross-origin media even with a CORS attribute', () => {
            vi.spyOn(DeviceCapabilities, 'profile', 'get').mockReturnValue({ isMobile: false } as any);
            vi.stubGlobal('AudioContext', class {});
            try {
                const whisper = new Whisper();
                const audio = document.createElement('audio');
                audio.crossOrigin = 'anonymous';
                audio.src = 'https://media.example.net/track.mp3';

                expect((whisper as any).canUseLiveAudioCapture(audio)).toBe(false);
            } finally {
                vi.unstubAllGlobals();
            }
        });

        it('accepts cross-origin media only when the pre-load trusted-CORS proof matches', () => {
            vi.spyOn(DeviceCapabilities, 'profile', 'get').mockReturnValue({ isMobile: false } as any);
            vi.stubGlobal('AudioContext', class {});
            try {
                const whisper = new Whisper();
                const audio = document.createElement('audio');
                audio.crossOrigin = 'anonymous';
                audio.src = 'https://raw.kiko-play-niptan.one/audio/track.mp3';
                Object.defineProperty(audio, 'paused', { configurable: true, value: false });

                trustedCorsSpy.mockReturnValue(true);
                expect((whisper as any).canUseLiveAudioCapture(audio)).toBe(true);
                expect(trustedCorsSpy).toHaveBeenCalledWith(audio);
            } finally {
                vi.unstubAllGlobals();
            }
        });

        it('uses compatibility decode instead of an empty live tap when audio is paused', () => {
            vi.spyOn(DeviceCapabilities, 'profile', 'get').mockReturnValue({ isMobile: false } as any);
            vi.stubGlobal('AudioContext', class {});
            try {
                const whisper = new Whisper();
                const audio = document.createElement('audio');
                audio.src = `${window.location.origin}/track.mp3`;
                expect(audio.paused).toBe(true);
                expect((whisper as any).canUseLiveAudioCapture(audio)).toBe(false);
            } finally {
                vi.unstubAllGlobals();
            }
        });

        it('indexes a nonzero live window from its start and ignores spare capacity', () => {
            const { whisper, send } = setupLiveBuffer(100, 6);

            (whisper as any).maybeProcessNextChunk();

            expect(send).toHaveBeenCalledTimes(1);
            const chunk = send.mock.calls[0][0] as Float32Array;
            expect(send.mock.calls[0][1]).toBe(100);
            expect(chunk.length).toBe(6 * 16_000);
            expect(chunk[0]).toBe(0.5);
            expect(chunk[chunk.length - 1]).toBe(0.5);
        });

        it('waits on a paused partial chunk, then pads it only after the track ends', () => {
            const { whisper, send } = setupLiveBuffer(100, 2);

            (whisper as any).handlePause();
            expect(send).not.toHaveBeenCalled();
            expect((whisper as any).finalizeOnIdle).toBe(false);

            (whisper as any).handleEnded();
            expect((whisper as any).liveCaptureEnded).toBe(true);
            expect(send).toHaveBeenCalledTimes(1);
            const chunk = send.mock.calls[0][0] as Float32Array;
            expect(chunk.length).toBe(6 * 16_000);
            expect(chunk[2 * 16_000 - 1]).toBe(0.5);
            expect(chunk[2 * 16_000]).toBe(0);
        });

        it('sends a silent final partial chunk because quiet ASMR must not be VAD-filtered', () => {
            const { whisper, send } = setupLiveBuffer(100, 2);
            vi.spyOn(whisper as any, 'getWhisperSettings').mockReturnValue({
                ...liveSettings,
                silenceThreshold: 1,
            });

            (whisper as any).handleEnded();

            expect(send).toHaveBeenCalledTimes(1);
            expect(send.mock.calls[0][1]).toBe(100);
        });

        it('disconnects the live tap exactly once when transcription stops', () => {
            const whisper = new Whisper();
            const disconnect = vi.fn();
            vi.spyOn(whisper as any, 'scheduleIdleUnload').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'persistCache').mockImplementation(() => {});
            (whisper as any).transcribing = true;
            (whisper as any).liveCaptureActive = true;
            (whisper as any).liveCaptureCleanup = disconnect;

            (whisper as any).stopTranscription('test');
            (whisper as any).stopLiveAudioCapture();

            expect(disconnect).toHaveBeenCalledTimes(1);
            expect((whisper as any).liveCaptureActive).toBe(false);
        });

        it('ignores PCM callbacks from a stale track generation or audio element', () => {
            const whisper = new Whisper();
            const audio = document.createElement('audio');
            const replacementAudio = document.createElement('audio');
            Object.defineProperty(audio, 'paused', { configurable: true, value: false });
            Object.defineProperty(replacementAudio, 'paused', { configurable: true, value: false });
            (whisper as any).audio = audio;
            (whisper as any).transcribing = true;
            (whisper as any).transcriptionGeneration = 2;
            (whisper as any).liveCaptureActive = true;
            const append = vi.spyOn(whisper as any, 'appendLivePcm').mockImplementation(() => {});
            const samples = new Float32Array(1600);

            (whisper as any).handleLivePcm(samples, audio, 1);
            (whisper as any).handleLivePcm(samples, replacementAudio, 2);
            expect(append).not.toHaveBeenCalled();

            (whisper as any).handleLivePcm(samples, audio, 2);
            expect(append).toHaveBeenCalledTimes(1);
        });

        it('keeps the live PCM window bounded and trims it in batches', () => {
            const whisper = new Whisper();
            const maxSamples = 180 * 16_000;
            (whisper as any).liveCaptureActive = true;
            (whisper as any).pcmBuffer = new Float32Array(maxSamples);
            (whisper as any).pcmSampleLength = maxSamples;
            (whisper as any).pcmBufferStartTime = 0;
            (whisper as any).transcribedUpTo = 0;
            const lag = vi.spyOn(whisper as any, 'reportLiveLag').mockImplementation(() => {});

            (whisper as any).appendLivePcm(new Float32Array(16_000));

            expect((whisper as any).pcmBuffer.length).toBe(maxSamples);
            expect((whisper as any).pcmSampleLength).toBe(151 * 16_000);
            expect((whisper as any).pcmBufferStartTime).toBe(30);
            expect((whisper as any).pcmDuration).toBe(181);
            expect((whisper as any).transcribedUpTo).toBe(30);
            expect(lag).toHaveBeenCalledWith('capture-buffer-trim', 30);
        });
    });

    describe('getWhisperSettings', () => {
        it('keeps full-tier defaults for current machines', () => {
            vi.spyOn(Config, 'get').mockImplementation((key) => {
                const map: Record<string, string | number | boolean> = {
                    primarySubtitleLang: 'ja',
                    whisperTask: 'transcribe',
                    whisperAutoWarmup: true,
                    whisperCacheTranscripts: true,
                };
                return map[key as string] ?? false;
            });
            vi.spyOn(DeviceCapabilities, 'profile', 'get').mockReturnValue({
                tier: 'full',
                hasGpu: true,
                memory: 16,
                cores: 8,
                isTouch: false,
                isMobile: false,
                screenWidth: 1920,
                reason: 'full-tier test profile',
            } as any);
            vi.spyOn(DeviceCapabilities, 'shouldWarmup', 'get').mockReturnValue(true);
            vi.spyOn(DeviceCapabilities, 'budget', 'get').mockReturnValue({
                whisperIdleMs: 10 * 60 * 1000,
            } as any);
            vi.spyOn(GpuScheduler, 'getMemoryPressure').mockReturnValue('low');

            const whisper = new Whisper();
            const settings = (whisper as any).getWhisperSettings();

            expect(settings.maxPendingChunks).toBe(2);
            expect(settings.pollIntervalMs).toBe(250);
            expect(settings.workerUpdateIntervalMs).toBe(200);
            expect(settings.preferLowPowerAdapter).toBe(false);
            expect(settings.autoWarmup).toBe(true);
            expect(settings.idleUnloadMs).toBe(10 * 60 * 1000);
        });

        it('starts the exact M1 Firefox compatibility profile on WebGPU tiny', () => {
            vi.spyOn(Config, 'get').mockImplementation((key) => {
                const map: Record<string, string | number | boolean> = {
                    whisperModel: 'onnx-community/whisper-small_timestamped',
                    whisperLanguage: 'auto',
                    whisperTask: 'transcribe',
                    whisperAutoWarmup: true,
                    whisperCacheTranscripts: true,
                    forceWhisperWasm: false,
                };
                return map[key as string] ?? false;
            });
            vi.spyOn(DeviceCapabilities, 'profile', 'get').mockReturnValue({
                tier: 'full',
                hasGpu: true,
                memory: -1,
                cores: 10,
                isTouch: false,
                isMobile: false,
                screenWidth: 1728,
                gpuVendor: 'mozilla apple m1, or similar',
                reason: 'full, GPU, 10 cores, 1728px',
            });
            vi.spyOn(DeviceCapabilities, 'shouldWarmup', 'get').mockReturnValue(true);
            vi.spyOn(DeviceCapabilities, 'budget', 'get').mockReturnValue({
                whisperIdleMs: 10 * 60 * 1000,
            } as any);
            vi.spyOn(GpuScheduler, 'getMemoryPressure').mockReturnValue('low');

            const settings = (new Whisper() as any).getWhisperSettings();

            expect(settings.model).toBe('onnx-community/whisper-tiny');
            expect(settings.forceWasm).toBe(false);
            expect(settings.preferLowPowerAdapter).toBe(false);
            expect(settings.maxPendingChunks).toBe(2);
            expect(settings.autoWarmup).toBe(true);
        });

        it('keeps the configured model on newer or known-memory Apple Silicon', () => {
            vi.spyOn(Config, 'get').mockImplementation((key) => {
                const map: Record<string, string | number | boolean> = {
                    whisperModel: 'onnx-community/whisper-small_timestamped',
                    whisperLanguage: 'auto',
                    whisperTask: 'transcribe',
                    whisperAutoWarmup: false,
                    whisperCacheTranscripts: true,
                    forceWhisperWasm: false,
                };
                return map[key as string] ?? false;
            });
            const profileSpy = vi.spyOn(DeviceCapabilities, 'profile', 'get').mockReturnValue({
                tier: 'full',
                hasGpu: true,
                memory: -1,
                cores: 12,
                isTouch: false,
                isMobile: false,
                screenWidth: 1800,
                gpuVendor: 'mozilla apple m3 gpu',
                reason: 'full, GPU, 12 cores, 1800px',
            });
            vi.spyOn(DeviceCapabilities, 'shouldWarmup', 'get').mockReturnValue(true);
            vi.spyOn(DeviceCapabilities, 'budget', 'get').mockReturnValue({
                whisperIdleMs: 10 * 60 * 1000,
            } as any);
            vi.spyOn(GpuScheduler, 'getMemoryPressure').mockReturnValue('low');

            expect((new Whisper() as any).getWhisperSettings().model)
                .toBe('onnx-community/whisper-small_timestamped');

            profileSpy.mockReturnValue({
                tier: 'full',
                hasGpu: true,
                memory: 8,
                cores: 10,
                isTouch: false,
                isMobile: false,
                screenWidth: 1728,
                gpuVendor: 'mozilla apple m1, or similar',
                reason: 'full, GPU, 8GB, 10 cores, 1728px',
            });
            expect((new Whisper() as any).getWhisperSettings().model)
                .toBe('onnx-community/whisper-small_timestamped');
        });

        it('reduces pressure on limited-tier desktop machines without forcing low-power adapters', () => {
            vi.spyOn(Config, 'get').mockImplementation((key) => {
                const map: Record<string, string | number | boolean> = {
                    primarySubtitleLang: 'ja',
                    whisperTask: 'transcribe',
                    whisperAutoWarmup: true,
                    whisperCacheTranscripts: true,
                };
                return map[key as string] ?? false;
            });
            vi.spyOn(DeviceCapabilities, 'profile', 'get').mockReturnValue({
                tier: 'limited',
                hasGpu: true,
                memory: 8,
                cores: 4,
                isTouch: false,
                isMobile: false,
                screenWidth: 1366,
                reason: 'limited-tier test profile',
            } as any);
            vi.spyOn(DeviceCapabilities, 'shouldWarmup', 'get').mockReturnValue(false);
            vi.spyOn(DeviceCapabilities, 'budget', 'get').mockReturnValue({
                whisperIdleMs: 5 * 60 * 1000,
            } as any);
            vi.spyOn(GpuScheduler, 'getMemoryPressure').mockReturnValue('medium');

            const whisper = new Whisper();
            const settings = (whisper as any).getWhisperSettings();

            expect(settings.maxPendingChunks).toBe(2);
            expect(settings.pollIntervalMs).toBe(325);
            expect(settings.workerUpdateIntervalMs).toBe(260);
            expect(settings.preferLowPowerAdapter).toBe(false);
            // shouldWarmup is mocked false, so autoWarmup is false
            expect(settings.autoWarmup).toBe(false);
            expect(settings.idleUnloadMs).toBe(5 * 60 * 1000);
            expect(settings.minWebgpuBufferBytes).toBe(384 * 1024 * 1024);
        });

        it('starts no-WebGPU desktop and Apple Silicon compatibility profiles on tiny/WASM-safe model', () => {
            vi.spyOn(Config, 'get').mockImplementation((key) => {
                const map: Record<string, string | number | boolean> = {
                    whisperModel: 'onnx-community/whisper-small_timestamped',
                    whisperLanguage: 'auto',
                    whisperTask: 'transcribe',
                    whisperAutoWarmup: true,
                    whisperCacheTranscripts: true,
                    forceWhisperWasm: false,
                };
                return map[key as string] ?? false;
            });
            vi.spyOn(DeviceCapabilities, 'profile', 'get').mockReturnValue({
                tier: 'limited',
                hasGpu: false,
                memory: -1,
                cores: 8,
                isTouch: false,
                isMobile: false,
                screenWidth: 1440,
                gpuVendor: '',
                reason: 'limited, no-GPU, 8 cores, 1440px',
            });
            vi.spyOn(DeviceCapabilities, 'shouldWarmup', 'get').mockReturnValue(false);
            vi.spyOn(DeviceCapabilities, 'budget', 'get').mockReturnValue({
                whisperIdleMs: 5 * 60 * 1000,
            } as any);
            vi.spyOn(GpuScheduler, 'getMemoryPressure').mockReturnValue('low');

            const settings = (new Whisper() as any).getWhisperSettings();

            expect(settings.model).toBe('onnx-community/whisper-tiny');
            expect(settings.maxPendingChunks).toBe(2);
            expect(settings.autoWarmup).toBe(false);
        });

        it('prefers low-power adapters on Intel-mac limited profiles', () => {
            vi.spyOn(Config, 'get').mockImplementation((key) => {
                const map: Record<string, string | number | boolean> = {
                    primarySubtitleLang: 'ja',
                    whisperTask: 'transcribe',
                    whisperAutoWarmup: true,
                    whisperCacheTranscripts: true,
                };
                return map[key as string] ?? false;
            });
            vi.spyOn(DeviceCapabilities, 'profile', 'get').mockReturnValue({
                tier: 'limited',
                hasGpu: true,
                memory: 8,
                cores: 4,
                isTouch: false,
                isMobile: false,
                screenWidth: 1440,
                reason: 'limited, GPU, 8GB, 4 cores, intel-mac, 1440px',
            } as any);
            vi.spyOn(DeviceCapabilities, 'shouldWarmup', 'get').mockReturnValue(false);
            vi.spyOn(DeviceCapabilities, 'budget', 'get').mockReturnValue({
                whisperIdleMs: 5 * 60 * 1000,
            } as any);
            vi.spyOn(GpuScheduler, 'getMemoryPressure').mockReturnValue('low');

            const whisper = new Whisper();
            const settings = (whisper as any).getWhisperSettings();

            expect(settings.preferLowPowerAdapter).toBe(true);
        });

        it('aggressively throttles pending work under high pressure', () => {
            vi.spyOn(Config, 'get').mockImplementation((key) => {
                const map: Record<string, string | number | boolean> = {
                    primarySubtitleLang: 'ja',
                    whisperTask: 'transcribe',
                    whisperAutoWarmup: true,
                    whisperCacheTranscripts: true,
                };
                return map[key as string] ?? false;
            });
            vi.spyOn(DeviceCapabilities, 'profile', 'get').mockReturnValue({
                tier: 'constrained',
                hasGpu: false,
                memory: 2,
                cores: 2,
                isTouch: true,
                isMobile: true,
                screenWidth: 414,
                reason: 'constrained-tier test profile',
            } as any);
            vi.spyOn(DeviceCapabilities, 'shouldWarmup', 'get').mockReturnValue(false);
            vi.spyOn(DeviceCapabilities, 'budget', 'get').mockReturnValue({
                whisperIdleMs: 2 * 60 * 1000,
            } as any);
            vi.spyOn(GpuScheduler, 'getMemoryPressure').mockReturnValue('high');

            const whisper = new Whisper();
            const settings = (whisper as any).getWhisperSettings();

            expect(settings.maxPendingChunks).toBe(1);
            expect(settings.pollIntervalMs).toBe(500);
            expect(settings.workerUpdateIntervalMs).toBe(350);
            expect(settings.preferLowPowerAdapter).toBe(true);
        });

        it('supports forced WASM mode from settings', () => {
            vi.spyOn(Config, 'get').mockImplementation((key) => {
                const map: Record<string, string | number | boolean> = {
                    primarySubtitleLang: 'ja',
                    whisperTask: 'transcribe',
                    whisperAutoWarmup: true,
                    whisperCacheTranscripts: true,
                    forceWhisperWasm: true,
                };
                return map[key as string] ?? false;
            });
            vi.spyOn(DeviceCapabilities, 'profile', 'get').mockReturnValue({
                tier: 'full',
                hasGpu: true,
                memory: 16,
                cores: 8,
                isTouch: false,
                isMobile: false,
                screenWidth: 1920,
                reason: 'full-tier test profile',
            } as any);
            vi.spyOn(DeviceCapabilities, 'shouldWarmup', 'get').mockReturnValue(true);
            vi.spyOn(DeviceCapabilities, 'budget', 'get').mockReturnValue({
                whisperIdleMs: 10 * 60 * 1000,
            } as any);
            vi.spyOn(GpuScheduler, 'getMemoryPressure').mockReturnValue('low');

            const whisper = new Whisper();
            const settings = (whisper as any).getWhisperSettings();

            expect(settings.forceWasm).toBe(true);
            expect(settings.autoWarmup).toBe(false);
            expect(settings.maxPendingChunks).toBe(2);
        });

        it('keeps WebGPU enabled on Firefox by default when WASM is not forced', () => {
            vi.spyOn(Config, 'get').mockImplementation((key) => {
                const map: Record<string, string | number | boolean> = {
                    primarySubtitleLang: 'ja',
                    whisperTask: 'transcribe',
                    whisperAutoWarmup: true,
                    whisperCacheTranscripts: true,
                    forceWhisperWasm: false,
                };
                return map[key as string] ?? false;
            });
            vi.spyOn(DeviceCapabilities, 'profile', 'get').mockReturnValue({
                tier: 'limited',
                hasGpu: true,
                memory: 8,
                cores: 4,
                isTouch: false,
                isMobile: false,
                screenWidth: 1440,
                reason: 'limited-tier test profile',
            } as any);
            vi.spyOn(DeviceCapabilities, 'shouldWarmup', 'get').mockReturnValue(false);
            vi.spyOn(DeviceCapabilities, 'budget', 'get').mockReturnValue({
                whisperIdleMs: 5 * 60 * 1000,
            } as any);
            vi.spyOn(GpuScheduler, 'getMemoryPressure').mockReturnValue('low');

            const whisper = new Whisper();
            const settings = (whisper as any).getWhisperSettings();

            expect(settings.forceWasm).toBe(false);
        });

        it('keeps WebGPU enabled on Firefox full-tier desktop GPUs', () => {
            vi.spyOn(Config, 'get').mockImplementation((key) => {
                const map: Record<string, string | number | boolean> = {
                    primarySubtitleLang: 'ja',
                    whisperTask: 'transcribe',
                    whisperAutoWarmup: true,
                    whisperCacheTranscripts: true,
                    forceWhisperWasm: false,
                };
                return map[key as string] ?? false;
            });
            vi.spyOn(DeviceCapabilities, 'profile', 'get').mockReturnValue({
                tier: 'full',
                hasGpu: true,
                memory: 16,
                cores: 8,
                isTouch: false,
                isMobile: false,
                screenWidth: 1920,
                reason: 'full-tier test profile',
            } as any);
            vi.spyOn(DeviceCapabilities, 'shouldWarmup', 'get').mockReturnValue(true);
            vi.spyOn(DeviceCapabilities, 'budget', 'get').mockReturnValue({
                whisperIdleMs: 10 * 60 * 1000,
            } as any);
            vi.spyOn(GpuScheduler, 'getMemoryPressure').mockReturnValue('low');

            const whisper = new Whisper();
            const settings = (whisper as any).getWhisperSettings();

            expect(settings.forceWasm).toBe(false);
        });

        it('allows Firefox WebGPU when explicit opt-in is enabled', () => {
            vi.spyOn(Config, 'get').mockImplementation((key) => {
                const map: Record<string, string | number | boolean> = {
                    primarySubtitleLang: 'ja',
                    whisperTask: 'transcribe',
                    whisperAutoWarmup: true,
                    whisperCacheTranscripts: true,
                    forceWhisperWasm: false,
                    whisperFirefoxWebgpu: true,
                };
                return map[key as string] ?? false;
            });
            vi.spyOn(DeviceCapabilities, 'profile', 'get').mockReturnValue({
                tier: 'limited',
                hasGpu: true,
                memory: 8,
                cores: 4,
                isTouch: false,
                isMobile: false,
                screenWidth: 1366,
                reason: 'limited-tier test profile',
            } as any);
            vi.spyOn(DeviceCapabilities, 'shouldWarmup', 'get').mockReturnValue(false);
            vi.spyOn(DeviceCapabilities, 'budget', 'get').mockReturnValue({
                whisperIdleMs: 5 * 60 * 1000,
            } as any);
            vi.spyOn(GpuScheduler, 'getMemoryPressure').mockReturnValue('low');

            const whisper = new Whisper();
            const settings = (whisper as any).getWhisperSettings();

            expect(settings.forceWasm).toBe(false);
        });
    });

    describe('gpu error detection', () => {
        it('treats WebGPU invalid buffer mapping as recoverable GPU error', () => {
            const whisper = new Whisper();
            const isGpuError = (whisper as any).isGpuErrorMessage('Mapping WebGPU buffer failed: Invalid buffer');
            expect(isGpuError).toBe(true);
        });
    });

    describe('webgpu retry gate', () => {
        it('never re-enables WebGPU after crash (permanent for session)', () => {
            vi.spyOn(Config, 'get').mockImplementation((key) => {
                if (key === 'forceWhisperWasm') return false;
                return false;
            });
            vi.spyOn(DeviceCapabilities, 'profile', 'get').mockReturnValue({
                tier: 'full',
                hasGpu: true,
                memory: 16,
                cores: 8,
                isTouch: false,
                isMobile: false,
                screenWidth: 1920,
                reason: 'full-tier test profile',
            } as any);

            const whisper = new Whisper();
            (Whisper as any).webgpuFailed = true;
            (whisper as any).gpuCrashed = true;

            const result = (whisper as any).maybeReenableWebgpu('test');

            expect(result).toBe(false);
            expect((Whisper as any).webgpuFailed).toBe(true);
            expect((whisper as any).gpuCrashed).toBe(true);
        });
    });

    describe('worker timeout handling', () => {
        it('does not permanently mark WebGPU failed on inference timeout errors', () => {
            const whisper = new Whisper();
            const markWebgpuFailedSpy = vi.spyOn(whisper as any, 'markWebgpuFailed').mockImplementation(() => {});
            const resetWorkerSpy = vi.spyOn(whisper as any, 'resetWorker').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'clearModelLoadTimer').mockImplementation(() => {});

            (whisper as any).transcribing = false;
            (whisper as any).pendingChunks = 1;
            (whisper as any).chunkSendTimes.set(42, performance.now());
            (whisper as any).chunkGenerations.set(42, (whisper as any).transcriptionGeneration);
            (whisper as any).chunkOffsets.set(42, 0);
            (whisper as any).chunkLastActivity.set(42, performance.now());

            (whisper as any).handleWorkerMessage({
                data: {
                    status: 'error',
                    data: { message: 'WebGPU inference timed out after 45s' },
                    chunkId: 42,
                },
            } as any);

            expect(markWebgpuFailedSpy).not.toHaveBeenCalled();
            expect((whisper as any).pendingChunks).toBe(0);
            expect((whisper as any).chunkSendTimes.has(42)).toBe(false);
            expect((whisper as any).chunkGenerations.has(42)).toBe(false);
            expect((whisper as any).chunkOffsets.has(42)).toBe(false);
            expect((whisper as any).chunkLastActivity.has(42)).toBe(false);
            expect(resetWorkerSpy).toHaveBeenCalledWith('error');
        });

        it('routes an explicitly signalled WebGPU timeout to tiny/WASM recovery', () => {
            const whisper = new Whisper();
            const markWebgpuFailedSpy = vi.spyOn(whisper as any, 'markWebgpuFailed').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'resetWorker').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'clearModelLoadTimer').mockImplementation(() => {});
            (whisper as any).workerBackend = 'webgpu';
            (whisper as any).transcribing = false;
            (whisper as any).pendingChunks = 1;
            (whisper as any).chunkSendTimes.set(9, performance.now());
            (whisper as any).chunkGenerations.set(9, (whisper as any).transcriptionGeneration);

            (whisper as any).handleWorkerMessage({
                data: {
                    status: 'error',
                    data: { message: 'WebGPU inference timed out after 45s', gpuFallback: true },
                    chunkId: 9,
                },
            } as any);

            expect(markWebgpuFailedSpy).toHaveBeenCalledWith('webgpu-inference-timeout');
            expect((whisper as any).modelOverride).toBe('onnx-community/whisper-tiny');
        });

        it('ignores a stale active-chunk error after a seek flush', () => {
            const whisper = new Whisper();
            const resetWorkerSpy = vi.spyOn(whisper as any, 'resetWorker').mockImplementation(() => {});
            const stopSpy = vi.spyOn(whisper as any, 'stopTranscription').mockImplementation(() => {});
            const initSpy = vi.spyOn(whisper as any, 'initWorker').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'dispatchProgress').mockImplementation(() => {});
            (whisper as any).transcribing = true;
            (whisper as any).worker = { postMessage: vi.fn() };
            // Seek/flush has already removed the old chunk from controller
            // ownership, while the uncancellable worker call settles later.
            (whisper as any).chunkSendTimes.clear();
            (whisper as any).chunkGenerations.clear();

            (whisper as any).handleWorkerMessage({
                data: {
                    status: 'error',
                    data: { message: 'WebGPU inference timed out after 45s', gpuFallback: true },
                    chunkId: 99,
                },
            } as any);

            expect(resetWorkerSpy).not.toHaveBeenCalled();
            expect(stopSpy).not.toHaveBeenCalled();
            expect((whisper as any).transcribing).toBe(true);

            // The worker separately reports that it is poisoned. Preserve the
            // live run, replace the worker, and resume the post-seek range.
            (whisper as any).chunkOffsets.set(100, 42);
            (whisper as any).handleWorkerMessage({
                data: {
                    status: 'worker-poisoned',
                    data: { reason: 'inference-timeout', gpuFallback: false },
                },
            } as any);
            expect(resetWorkerSpy).toHaveBeenCalledWith('inference-timeout');
            expect(initSpy).toHaveBeenCalled();
            expect(stopSpy).not.toHaveBeenCalled();
            expect((whisper as any).transcribedUpTo).toBe(42);
        });

        it('surfaces audio that expired before a poisoned worker can retry it', () => {
            const whisper = new Whisper();
            const resetWorkerSpy = vi.spyOn(whisper as any, 'resetWorker').mockImplementation(() => {});
            const initSpy = vi.spyOn(whisper as any, 'initWorker').mockImplementation(() => {});
            const progressSpy = vi.spyOn(whisper as any, 'dispatchProgress').mockImplementation(() => {});
            const lagSpy = vi.spyOn(whisper as any, 'reportLiveLag').mockImplementation(() => {});
            (whisper as any).transcribing = true;
            (whisper as any).worker = { postMessage: vi.fn() };
            (whisper as any).pcmBufferStartTime = 50;
            (whisper as any).chunkOffsets.set(100, 42);

            (whisper as any).handleWorkerMessage({
                data: {
                    status: 'worker-poisoned',
                    data: { reason: 'inference-timeout', gpuFallback: false },
                },
            } as any);

            expect(resetWorkerSpy).toHaveBeenCalledWith('inference-timeout');
            expect(initSpy).toHaveBeenCalled();
            expect((whisper as any).transcribedUpTo).toBe(50);
            expect((whisper as any).droppedBufferSeconds).toBe(8);
            expect(lagSpy).toHaveBeenCalledWith('capture-buffer-trim', 8);
            expect(progressSpy).not.toHaveBeenCalled();
        });

        it('stops after repeated bounded-backend inference timeouts', () => {
            const whisper = new Whisper();
            const resetWorkerSpy = vi.spyOn(whisper as any, 'resetWorker').mockImplementation(() => {});
            const stopSpy = vi.spyOn(whisper as any, 'stopTranscription').mockImplementation(() => {
                (whisper as any).transcribing = false;
            });
            const initSpy = vi.spyOn(whisper as any, 'initWorker').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'dispatchProgress').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'showStatus').mockImplementation(() => {});
            (whisper as any).transcribing = true;
            (whisper as any).worker = { postMessage: vi.fn() };

            (whisper as any).handleWorkerMessage({
                data: {
                    status: 'worker-poisoned',
                    data: { reason: 'inference-timeout', gpuFallback: false },
                },
            } as any);
            expect(initSpy).toHaveBeenCalledTimes(1);
            expect(stopSpy).not.toHaveBeenCalled();

            // Simulate the replacement worker timing out too. A "started"
            // heartbeat must not erase consecutive timeout accounting.
            (whisper as any).worker = { postMessage: vi.fn() };
            (whisper as any).markChunkActivity();
            (whisper as any).handleWorkerMessage({
                data: {
                    status: 'worker-poisoned',
                    data: { reason: 'inference-timeout', gpuFallback: false },
                },
            } as any);

            expect(resetWorkerSpy).toHaveBeenLastCalledWith('inference-timeout-terminal');
            expect(stopSpy).toHaveBeenCalledWith('inference-timeout-terminal');
            expect(initSpy).toHaveBeenCalledTimes(1);
            expect((whisper as any).transcribing).toBe(false);
        });

        it('ignores stale chunk-scoped ready and fallback lifecycle after a seek flush', () => {
            const whisper = new Whisper();
            (whisper as any).transcribing = true;
            (whisper as any).modelReady = false;

            (whisper as any).handleWorkerMessage({
                data: {
                    status: 'fallback',
                    originalModel: 'onnx-community/whisper-small_timestamped',
                    fallbackModel: 'onnx-community/whisper-tiny',
                    chunkId: 77,
                },
            } as any);
            (whisper as any).handleWorkerMessage({
                data: {
                    status: 'ready',
                    model: 'onnx-community/whisper-tiny',
                    backend: 'wasm',
                    dtype: 'q8',
                    chunkId: 77,
                },
            } as any);

            expect((whisper as any).modelOverride).toBeNull();
            expect((whisper as any).effectiveModelId).toBeNull();
            expect((whisper as any).modelReady).toBe(false);
        });

        it('marks WebGPU failed for non-timeout GPU errors from worker fallback', () => {
            const whisper = new Whisper();
            const markWebgpuFailedSpy = vi.spyOn(whisper as any, 'markWebgpuFailed').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'resetWorker').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'clearModelLoadTimer').mockImplementation(() => {});

            (whisper as any).transcribing = false;
            (whisper as any).pendingChunks = 1;
            (whisper as any).chunkSendTimes.set(7, performance.now());
            (whisper as any).chunkGenerations.set(7, (whisper as any).transcriptionGeneration);
            (whisper as any).chunkOffsets.set(7, 24);
            (whisper as any).chunkLastActivity.set(7, performance.now());

            (whisper as any).handleWorkerMessage({
                data: {
                    status: 'error',
                    data: { message: 'createBuffer failed', gpuFallback: true },
                    chunkId: 7,
                },
            } as any);

            expect(markWebgpuFailedSpy).toHaveBeenCalledWith('worker-message');
        });
    });

    describe('progressive decoding display', () => {
        function ownChunk(whisper: Whisper, chunkId: number, offset: number, advance: number): void {
            (whisper as any).transcribing = true;
            (whisper as any).pendingChunks = 1;
            (whisper as any).chunkSendTimes.set(chunkId, performance.now());
            (whisper as any).chunkGenerations.set(chunkId, (whisper as any).transcriptionGeneration);
            (whisper as any).chunkOffsets.set(chunkId, offset);
            (whisper as any).chunkAdvances.set(chunkId, advance);
            (whisper as any).chunkLastActivity.set(chunkId, performance.now());
        }

        it('emits finalized history plus a safe non-persisted provisional segment', () => {
            const whisper = new Whisper();
            vi.spyOn(whisper as any, 'getWhisperSettings').mockReturnValue({ language: 'japanese' });
            vi.spyOn(whisper as any, 'updateTranscribingProgress').mockImplementation(() => {});
            const emit = vi.spyOn(EventBus, 'emit');
            (whisper as any).segments = [{ start: 0, end: 12, text: '確定済み' }];
            (whisper as any).lastSegmentEnd = 12;
            (whisper as any).pcmDuration = 25;
            ownChunk(whisper, 4, 10, 20);

            (whisper as any).handleWorkerMessage({
                data: {
                    status: 'heartbeat',
                    chunkId: 4,
                    data: { phase: 'decoding', partialText: '  ただいま  解析中  ' },
                },
            });

            const update = emit.mock.calls.find(([event]) => event === 'whisper:update')?.[1] as any;
            expect(update).toMatchObject({
                text: 'ただいま 解析中',
                final: false,
                live: true,
                source: 'heartbeat',
                chunkIndex: 4,
            });
            expect(update.segments).toEqual([
                { start: 0, end: 12, text: '確定済み' },
                { start: 12, end: 25, text: 'ただいま 解析中' },
            ]);
            expect((whisper as any).segments).toEqual([{ start: 0, end: 12, text: '確定済み' }]);
        });

        it('dedupes identical partials and rejects stale chunk generations', () => {
            const whisper = new Whisper();
            vi.spyOn(whisper as any, 'getWhisperSettings').mockReturnValue({ language: 'japanese' });
            vi.spyOn(whisper as any, 'updateTranscribingProgress').mockImplementation(() => {});
            const emit = vi.spyOn(EventBus, 'emit');
            (whisper as any).pcmDuration = 20;
            ownChunk(whisper, 5, 3, 10);
            const heartbeat = {
                data: {
                    status: 'heartbeat',
                    chunkId: 5,
                    data: { phase: 'decoding', partialText: '同じ途中結果' },
                },
            };

            (whisper as any).handleWorkerMessage(heartbeat);
            (whisper as any).handleWorkerMessage(heartbeat);
            expect(emit.mock.calls.filter(([event]) => event === 'whisper:update')).toHaveLength(1);

            (whisper as any).chunkGenerations.set(5, (whisper as any).transcriptionGeneration - 1);
            (whisper as any).handleWorkerMessage({
                data: {
                    status: 'heartbeat',
                    chunkId: 5,
                    data: { phase: 'decoding', partialText: '古いワーカーの結果' },
                },
            });
            expect(emit.mock.calls.filter(([event]) => event === 'whisper:update')).toHaveLength(1);
        });

        it('replaces provisional output with finalized timestamps without caching the provisional text', () => {
            const whisper = new Whisper();
            vi.spyOn(whisper as any, 'getWhisperSettings').mockReturnValue({ language: 'japanese' });
            vi.spyOn(whisper as any, 'updateTranscribingProgress').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'logNewTranscriptSegments').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'translateAhead').mockResolvedValue(undefined);
            vi.spyOn(whisper as any, 'maybeFinalizeTranscript').mockImplementation(() => {});
            const persist = vi.spyOn(whisper as any, 'persistCache').mockImplementation(() => {});
            const emit = vi.spyOn(EventBus, 'emit');
            (whisper as any).pcmDuration = 20;
            ownChunk(whisper, 6, 10, 10);

            (whisper as any).handleWorkerMessage({
                data: {
                    status: 'heartbeat',
                    chunkId: 6,
                    data: { phase: 'decoding', partialText: '暫定テキスト' },
                },
            });
            expect((whisper as any).segments).toEqual([]);
            expect(persist).not.toHaveBeenCalled();

            (whisper as any).handleWorkerMessage({
                data: {
                    status: 'complete',
                    chunkId: 6,
                    data: {
                        text: '確定テキスト',
                        rawChunks: [{ text: '確定テキスト', timestamp: [10, 14] }],
                        inputRms: 0.01,
                    },
                },
            });

            const updates = emit.mock.calls
                .filter(([event]) => event === 'whisper:update')
                .map(([, payload]) => payload as any);
            expect(updates).toHaveLength(2);
            expect(updates[0].segments).toEqual([
                { start: 10, end: 20, text: '暫定テキスト' },
            ]);
            expect(updates[1]).toMatchObject({ source: 'complete', text: '確定テキスト' });
            expect(updates[1].segments).toEqual([
                expect.objectContaining({ start: 10, end: 14, text: '確定テキスト' }),
            ]);
            expect(updates[1].segments.some((segment: { text: string }) => segment.text === '暫定テキスト')).toBe(false);
            expect((whisper as any).segments.some((segment: { text: string }) => segment.text === '暫定テキスト')).toBe(false);
            expect((whisper as any).provisionalChunkText.has(6)).toBe(false);
            expect(persist).toHaveBeenCalledOnce();
        });
    });

    describe('parseSegments', () => {
        it('preserves recognized output when VAD is off even for a low-RMS final chunk', () => {
            const whisper = new Whisper();
            (whisper as any).transcribing = true;
            (whisper as any).pendingChunks = 1;
            (whisper as any).chunkGenerations.set(12, (whisper as any).transcriptionGeneration);
            (whisper as any).chunkSendTimes.set(12, performance.now());
            (whisper as any).chunkOffsets.set(12, 0);
            (whisper as any).chunkLastActivity.set(12, performance.now());
            const merge = vi.spyOn(whisper as any, 'mergeSegments');
            const finalize = vi.spyOn(whisper as any, 'maybeFinalizeTranscript');
            vi.spyOn(whisper as any, 'translateAhead').mockResolvedValue(undefined);

            (whisper as any).handleWorkerMessage({
                data: {
                    status: 'complete',
                    chunkId: 12,
                    data: {
                        text: 'お気に入りしさせると',
                        rawChunks: [{ text: 'お気に入りしさせると', timestamp: [0, 2] }],
                        inputRms: 0,
                    },
                },
            } as any);

            expect(merge).toHaveBeenCalledOnce();
            expect((whisper as any).segments).toHaveLength(1);
            expect((whisper as any).pendingChunks).toBe(0);
            expect(finalize).toHaveBeenCalled();
        });

        it('does not apply Japanese glossary rewrites to explicit Chinese transcription', () => {
            vi.spyOn(Config, 'get').mockImplementation((key) => {
                if (key === 'whisperLanguage') return 'zh-CN';
                if (key === 'whisperModel') return 'onnx-community/whisper-small_timestamped';
                if (key === 'whisperTask') return 'transcribe';
                return false;
            });
            const whisper = new Whisper();
            const segments = (whisper as any).parseSegments([
                { text: '写生课程和重生故事', timestamp: [0, 3] },
            ]);
            expect(segments[0].text).toBe('写生课程和重生故事');
        });

        it('parses chunks with timestamps into segments', () => {
            const whisper = new Whisper();
            const chunks = [
                { text: 'hello', timestamp: [0, 5] as [number, number] },
                { text: 'world', timestamp: [5, 10] as [number, number] },
            ];
            const segments = (whisper as any).parseSegments(chunks);
            expect(segments).toHaveLength(2);
            expect(segments[0].text).toBe('hello');
            expect(segments[0].start).toBe(0);
            expect(segments[0].end).toBe(5);
            expect(segments[1].text).toBe('world');
        });

        it('filters out chunks with null timestamps', () => {
            const whisper = new Whisper();
            const chunks = [
                { text: 'hello', timestamp: [0, 5] as [number, number] },
                { text: 'pending', timestamp: [null, null] as [null, null] },
            ];
            const segments = (whisper as any).parseSegments(chunks);
            expect(segments).toHaveLength(1);
            expect(segments[0].text).toBe('hello');
        });

        it('returns empty array for undefined input', () => {
            const whisper = new Whisper();
            expect((whisper as any).parseSegments(undefined)).toEqual([]);
        });

        it('returns empty array for empty array', () => {
            const whisper = new Whisper();
            expect((whisper as any).parseSegments([])).toEqual([]);
        });
    });

    describe('seek synchronization', () => {
        it('defers seek snapshot update to requestAnimationFrame', () => {
            vi.useFakeTimers();
            try {
                const whisper = new Whisper();
                const audio = document.createElement('audio');
                audio.currentTime = 12.34;
                (whisper as any).audio = audio;

                const snapshotSpy = vi.spyOn(whisper as any, 'emitWhisperSnapshot').mockImplementation(() => {});
                const processSpy = vi.spyOn(whisper as any, 'maybeProcessNextChunk').mockImplementation(() => {});

                let rafCb: any = null;
                vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: any): number => {
                    rafCb = cb;
                    return 1;
                });
                vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

                (whisper as any).handleSeek();

                expect(snapshotSpy).not.toHaveBeenCalled();
                expect(rafCb).not.toBeNull();

                if (rafCb) (rafCb as (time: number) => void)(performance.now());
                expect(snapshotSpy).toHaveBeenCalledWith('seek');

                vi.advanceTimersByTime(101);
                expect(processSpy).toHaveBeenCalled();
            } finally {
                vi.useRealTimers();
            }
        });

        it('drops discontinuous live PCM and flushes queued work after a seek', () => {
            vi.useFakeTimers();
            try {
                const whisper = new Whisper();
                const audio = document.createElement('audio');
                audio.currentTime = 42;
                const worker = { postMessage: vi.fn() };
                (whisper as any).audio = audio;
                (whisper as any).worker = worker;
                (whisper as any).transcribing = true;
                (whisper as any).liveCaptureActive = true;
                (whisper as any).pcmBuffer = new Float32Array(12 * 16_000);
                (whisper as any).pcmBufferStartTime = 100;
                (whisper as any).pcmSampleLength = 6 * 16_000;
                (whisper as any).pcmDuration = 106;
                (whisper as any).transcribedUpTo = 106;
                vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
                vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
                vi.spyOn(whisper as any, 'maybeProcessNextChunk').mockImplementation(() => {});

                (whisper as any).handleSeek();
                vi.advanceTimersByTime(101);

                expect(worker.postMessage).toHaveBeenCalledWith({ type: 'flush-queue' });
                expect((whisper as any).pcmBufferStartTime).toBe(42);
                expect((whisper as any).pcmSampleLength).toBe(0);
                expect((whisper as any).pcmDuration).toBe(42);
                expect((whisper as any).transcribedUpTo).toBe(42);
            } finally {
                vi.useRealTimers();
            }
        });
    });

    describe('chunk stall watchdog', () => {
        const settings = {
            model: 'onnx-community/whisper-small_timestamped',
            subtask: 'transcribe',
            language: 'ja',
            multilingual: true,
            chunkLengthS: 29,
            strideLengthS: 5,
            cacheTranscripts: true,
            autoWarmup: true,
            silenceThreshold: 0,
            maxPendingChunks: 6,
            pollIntervalMs: 250,
            workerUpdateIntervalMs: 200,
            idleUnloadMs: 600_000,
            forceWasm: false,
            preferLowPowerAdapter: false,
            minWebgpuBufferBytes: 256 * 1024 * 1024,
        };

        it('scales chunk stall timeout based on chunk length', () => {
            const whisper = new Whisper();

            // v149: getChunkStallTimeoutMs(settings) uses chunkLengthS * 1000 * 3
            // with floor of CHUNK_STALL_TIMEOUT_FLOOR_MS (25_000)
            const timeout = (whisper as any).getChunkStallTimeoutMs(settings);

            // 29s * 1000 * 3 = 87_000, floor = 25_000 → 87_000
            expect(timeout).toBeGreaterThanOrEqual(25_000);
            expect(timeout).toBe(87_000);
        });

        it('detects stalled in-flight chunks and triggers recovery', () => {
            const whisper = new Whisper();
            const recoverSpy = vi.spyOn(whisper as any, 'recoverFromStalledChunks').mockImplementation(() => {});

            (whisper as any).transcribing = true;
            (whisper as any).pendingChunks = 1;
            (whisper as any).hasWorkerChunkActivity = true;
            (whisper as any).chunkSendTimes.set(7, performance.now() - 260_000);
            (whisper as any).chunkStartedAt.set(7, performance.now() - 260_000);
            (whisper as any).chunkLastActivity.set(7, performance.now() - 260_000);

            (whisper as any).checkForStalledChunks(settings);

            expect(recoverSpy).toHaveBeenCalledTimes(1);
            expect(recoverSpy.mock.calls[0]?.[1]).toBe(7);
        });

        it('never treats a queued-but-not-started chunk as stalled', () => {
            const whisper = new Whisper();
            const recoverSpy = vi.spyOn(whisper as any, 'recoverFromStalledChunks').mockImplementation(() => {});

            (whisper as any).transcribing = true;
            (whisper as any).pendingChunks = 1;
            (whisper as any).chunkSendTimes.set(8, performance.now() - 260_000);
            (whisper as any).chunkLastActivity.set(8, performance.now() - 260_000);

            (whisper as any).checkForStalledChunks(settings);

            expect(recoverSpy).not.toHaveBeenCalled();
        });

        it('starts the watchdog only after the worker reports inference started', () => {
            const whisper = new Whisper();
            (whisper as any).transcribing = true;
            (whisper as any).pendingChunks = 1;
            (whisper as any).chunkSendTimes.set(9, performance.now());
            (whisper as any).chunkGenerations.set(9, (whisper as any).transcriptionGeneration);

            (whisper as any).handleWorkerMessage({
                data: { status: 'queued', chunkId: 9 },
            });
            expect((whisper as any).chunkStartedAt.has(9)).toBe(false);

            (whisper as any).handleWorkerMessage({
                data: { status: 'started', chunkId: 9 },
            });
            expect((whisper as any).chunkStartedAt.has(9)).toBe(true);
            expect((whisper as any).hasWorkerChunkActivity).toBe(true);
        });

        it('rewinds a worker-dropped queued range so it is retried', () => {
            const whisper = new Whisper();
            vi.spyOn(whisper as any, 'reportLiveLag').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'maybeProcessNextChunk').mockImplementation(() => {});
            (whisper as any).transcribing = true;
            (whisper as any).pendingChunks = 1;
            (whisper as any).transcribedUpTo = 40;
            (whisper as any).chunkSendTimes.set(10, performance.now());
            (whisper as any).chunkGenerations.set(10, (whisper as any).transcriptionGeneration);
            (whisper as any).chunkOffsets.set(10, 18);
            (whisper as any).chunkAdvances.set(10, 15);

            (whisper as any).handleWorkerMessage({
                data: { status: 'dropped', chunkId: 10, data: { reason: 'queue-replaced' } },
            });

            expect((whisper as any).pendingChunks).toBe(0);
            expect((whisper as any).transcribedUpTo).toBe(18);
            expect((whisper as any).chunkSendTimes.has(10)).toBe(false);
        });

        it('surfaces queued audio that expired before a dropped range can be retried', () => {
            const whisper = new Whisper();
            const lagSpy = vi.spyOn(whisper as any, 'reportLiveLag').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'maybeProcessNextChunk').mockImplementation(() => {});
            (whisper as any).transcribing = true;
            (whisper as any).pendingChunks = 1;
            (whisper as any).pcmBufferStartTime = 30;
            (whisper as any).transcribedUpTo = 40;
            (whisper as any).chunkSendTimes.set(10, performance.now());
            (whisper as any).chunkGenerations.set(10, (whisper as any).transcriptionGeneration);
            (whisper as any).chunkOffsets.set(10, 18);
            (whisper as any).chunkAdvances.set(10, 15);

            (whisper as any).handleWorkerMessage({
                data: { status: 'dropped', chunkId: 10, data: { reason: 'queue-replaced' } },
            });

            expect((whisper as any).transcribedUpTo).toBe(30);
            expect((whisper as any).droppedBufferSeconds).toBe(12);
            expect(lagSpy).toHaveBeenCalledTimes(1);
            expect(lagSpy).toHaveBeenCalledWith('capture-buffer-trim', 12);
        });

        it('resets stalled worker state and rewinds transcription cursor', () => {
            const whisper = new Whisper();
            const resetSpy = vi.spyOn(whisper as any, 'resetWorker').mockImplementation(() => {});
            const initSpy = vi.spyOn(whisper as any, 'initWorker').mockImplementation(() => {});
            const progressSpy = vi.spyOn(whisper as any, 'dispatchProgress').mockImplementation(() => {});

            (whisper as any).pendingChunks = 3;
            (whisper as any).chunkSendTimes.set(1, performance.now() - 150_000);
            (whisper as any).chunkSendTimes.set(2, performance.now() - 120_000);
            (whisper as any).chunkGenerations.set(1, 2);
            (whisper as any).chunkGenerations.set(2, 2);
            (whisper as any).chunkOffsets.set(1, 84);
            (whisper as any).chunkOffsets.set(2, 96);
            (whisper as any).chunkLastActivity.set(1, performance.now() - 150_000);
            (whisper as any).chunkLastActivity.set(2, performance.now() - 120_000);
            (whisper as any).transcribedUpTo = 120;
            (whisper as any).modelReady = true;
            (whisper as any).lastChunkStallRecoveryAt = -1_000_000;

            (whisper as any).recoverFromStalledChunks(settings, 1, 150_000);

            expect(resetSpy).toHaveBeenCalledWith('chunk-stall-timeout');
            expect(initSpy).toHaveBeenCalledWith((whisper as any).getWhisperSettings());
            expect(progressSpy).toHaveBeenCalled();
            expect((whisper as any).pendingChunks).toBe(0);
            expect((whisper as any).chunkSendTimes.size).toBe(0);
            expect((whisper as any).chunkGenerations.size).toBe(0);
            expect((whisper as any).chunkOffsets.size).toBe(0);
            expect((whisper as any).chunkLastActivity.size).toBe(0);
            expect((whisper as any).transcribedUpTo).toBeCloseTo(69, 5); // minOffset(84) - SEEK_BACKFILL(15)
            expect((whisper as any).modelReady).toBe(false);
        });

        it('clears modelReady on reset', () => {
            const whisper = new Whisper();

            (whisper as any).modelReady = true;
            (whisper as any).resetWorker('test-reset');

            expect((whisper as any).modelReady).toBe(false);
        });

        it('limits startup to one in-flight chunk until first worker activity', () => {
            const whisper = new Whisper();
            const sendSpy = vi.spyOn(whisper as any, 'sendChunk').mockImplementation(() => {});
            vi.spyOn((whisper as any).bridge, 'currentTrack', 'get').mockReturnValue(null);

            const audio = document.createElement('audio');
            audio.currentTime = 0;
            (whisper as any).audio = audio;
            (whisper as any).transcribing = true;
            (whisper as any).modelReady = true;
            (whisper as any).hasWorkerChunkActivity = false;
            (whisper as any).pendingChunks = 1;
            (whisper as any).pcmBuffer = new Float32Array(16_000 * 120);
            (whisper as any).pcmDuration = 120;
            (whisper as any).transcribedUpTo = 0;

            (whisper as any).maybeProcessNextChunk();

            expect(sendSpy).not.toHaveBeenCalled();
        });

        it('uses a shorter bootstrap chunk before first worker activity', () => {
            const whisper = new Whisper();
            const sendSpy = vi.spyOn(whisper as any, 'sendChunk').mockImplementation(() => {});
            vi.spyOn((whisper as any).bridge, 'currentTrack', 'get').mockReturnValue(null);

            const audio = document.createElement('audio');
            audio.currentTime = 0;
            (whisper as any).audio = audio;
            (whisper as any).transcribing = true;
            (whisper as any).modelReady = true;
            (whisper as any).hasWorkerChunkActivity = false;
            (whisper as any).pendingChunks = 0;
            (whisper as any).pcmBuffer = new Float32Array(16_000 * 120);
            (whisper as any).pcmDuration = 120;
            (whisper as any).transcribedUpTo = 0;

            (whisper as any).maybeProcessNextChunk();

            expect(sendSpy).toHaveBeenCalledTimes(1);
            expect(sendSpy.mock.calls[0]?.[4]).toBe(6);
        });

        it('uses the same bootstrap chunk size on WebGPU', () => {
            const whisper = new Whisper();
            const sendSpy = vi.spyOn(whisper as any, 'sendChunk').mockImplementation(() => {});
            vi.spyOn((whisper as any).bridge, 'currentTrack', 'get').mockReturnValue(null);

            const audio = document.createElement('audio');
            audio.currentTime = 0;
            (whisper as any).audio = audio;
            (whisper as any).transcribing = true;
            (whisper as any).modelReady = true;
            (whisper as any).hasWorkerChunkActivity = false;
            (whisper as any).workerBackend = 'webgpu';
            (whisper as any).pendingChunks = 0;
            (whisper as any).pcmBuffer = new Float32Array(16_000 * 120);
            (whisper as any).pcmDuration = 120;
            (whisper as any).transcribedUpTo = 0;

            (whisper as any).maybeProcessNextChunk();

            expect(sendSpy).toHaveBeenCalledTimes(1);
            expect(sendSpy.mock.calls[0]?.[4]).toBe(6);
        });
    });

    describe('translation ahead retry cursor', () => {
        it('retries a failed CN-to-JA-only lane before advancing the segment marker', async () => {
            vi.spyOn(Config, 'get').mockImplementation((key) => {
                if (key === 'subtitleLang') return 'zh-CN';
                if (key === 'translateMode' || key === 'translateCnToJp') return true;
                return false;
            });
            const whisper = new Whisper();
            vi.spyOn(whisper as any, 'getWhisperSettings').mockReturnValue({ language: '' });
            (whisper as any).segments = [
                { start: 1, end: 3, text: '你好，欢迎回来' },
            ];
            (whisper as any).currentCacheKey = 'cache-a';
            (whisper as any).currentCacheIdentity = 'track-a';

            const translateBatch = vi.spyOn(TranslationService, 'translateBatch')
                .mockResolvedValueOnce(['你好，欢迎回来'])
                .mockResolvedValueOnce(['こんにちは、お帰りなさい']);

            await (whisper as any).translateAhead();
            expect((whisper as any).lastTranslatedSegmentCount).toBe(0);
            expect((whisper as any).translateAheadUpTo).toBe(0);

            await (whisper as any).translateAhead();
            expect((whisper as any).lastTranslatedSegmentCount).toBe(1);
            expect((whisper as any).translateAheadUpTo).toBe(3);
            expect(translateBatch).toHaveBeenCalledTimes(2);
            expect(translateBatch).toHaveBeenLastCalledWith(
                ['你好，欢迎回来'],
                'ja',
                expect.objectContaining({
                    priority: Priority.HIGH,
                    cancellable: true,
                    sourceLanguageHint: 'zh',
                }),
            );
        });

        it('does not misroute explicit Japanese Han-only text through CN-to-JA', async () => {
            vi.spyOn(Config, 'get').mockImplementation((key) => {
                if (key === 'subtitleLang') return 'zh-CN';
                if (key === 'translateMode') return true;
                return false;
            });
            const whisper = new Whisper();
            vi.spyOn(whisper as any, 'getWhisperSettings').mockReturnValue({ language: 'japanese' });
            (whisper as any).segments = [{ start: 0, end: 2, text: '限界集落' }];
            (whisper as any).currentCacheKey = 'cache-ja';
            (whisper as any).currentCacheIdentity = 'track-ja';
            const translateBatch = vi.spyOn(TranslationService, 'translateBatch')
                .mockResolvedValue(['边缘村落']);

            await (whisper as any).translateAhead();

            expect(translateBatch).toHaveBeenCalledTimes(1);
            expect(translateBatch).toHaveBeenCalledWith(
                ['限界集落'],
                'zh-cn',
                expect.objectContaining({
                    priority: Priority.HIGH,
                    sourceLanguageHint: 'ja',
                    preserveRequestedTarget: true,
                }),
            );
            expect((whisper as any).lastTranslatedSegmentCount).toBe(1);
        });

        it('routes Japanese live transcription to Chinese in the explicit JP+ZH mode', async () => {
            vi.spyOn(Config, 'get').mockImplementation((key) => {
                if (key === 'learnerSubtitleMode') return 'jp-zh';
                if (key === 'subtitleLang') return 'en';
                if (key === 'translateMode') return true;
                return false;
            });
            const whisper = new Whisper();
            vi.spyOn(whisper as any, 'getWhisperSettings').mockReturnValue({ language: 'japanese' });
            (whisper as any).segments = [{ start: 0, end: 2, text: 'お帰りなさい' }];
            (whisper as any).currentCacheKey = 'cache-jp-zh';
            (whisper as any).currentCacheIdentity = 'track-jp-zh';
            const translateBatch = vi.spyOn(TranslationService, 'translateBatch')
                .mockResolvedValue(['欢迎回来']);

            await (whisper as any).translateAhead();

            expect(translateBatch).toHaveBeenCalledOnce();
            expect(translateBatch).toHaveBeenCalledWith(
                ['お帰りなさい'],
                'zh-cn',
                expect.objectContaining({
                    sourceLanguageHint: 'ja',
                    preserveRequestedTarget: true,
                    priority: Priority.HIGH,
                }),
            );
        });

        it('keeps Chinese Whisper secondary translation in English while separately warming Japanese', async () => {
            vi.spyOn(Config, 'get').mockImplementation((key) => {
                if (key === 'subtitleLang') return 'en';
                if (key === 'translateMode' || key === 'translateCnToJp') return true;
                return false;
            });
            const whisper = new Whisper();
            vi.spyOn(whisper as any, 'getWhisperSettings').mockReturnValue({ language: 'chinese' });
            (whisper as any).segments = [{ start: 0, end: 2, text: '欢迎回来' }];
            (whisper as any).currentCacheKey = 'cache-zh';
            (whisper as any).currentCacheIdentity = 'track-zh';
            const translateBatch = vi.spyOn(TranslationService, 'translateBatch')
                .mockImplementation(async (_texts, target) => [target === 'ja' ? 'お帰りなさい' : 'Welcome back']);

            await (whisper as any).translateAhead();

            expect(translateBatch).toHaveBeenCalledWith(
                ['欢迎回来'],
                'en',
                expect.objectContaining({
                    sourceLanguageHint: 'zh',
                    preserveRequestedTarget: true,
                }),
            );
            expect(translateBatch).toHaveBeenCalledWith(
                ['欢迎回来'],
                'ja',
                expect.objectContaining({ sourceLanguageHint: 'zh' }),
            );
        });

        it('stores completed Chinese transcript secondary output under its requested English lane', async () => {
            vi.spyOn(Config, 'get').mockImplementation((key) => {
                if (key === 'subtitleLang') return 'en';
                if (key === 'translateMode' || key === 'translateCnToJp') return true;
                return false;
            });
            const whisper = new Whisper();
            (whisper as any).currentCacheKey = 'complete-zh';
            const payload: {
                text: string;
                segments: Array<{ start: number; end: number; text: string }>;
                complete: boolean;
                translations?: Record<string, { text: string }>;
            } = {
                text: '欢迎回来',
                segments: [{ start: 0, end: 2, text: '欢迎回来' }],
                complete: true,
            };
            const translateBatch = vi.spyOn(TranslationService, 'translateBatch')
                .mockImplementation(async (_texts, target) => [target === 'ja' ? 'お帰りなさい' : 'Welcome back']);

            await (whisper as any).ensureTranslatedTranscript(payload, { language: 'chinese' });

            expect(translateBatch).toHaveBeenCalledWith(
                ['欢迎回来'],
                'en',
                expect.objectContaining({
                    sourceLanguageHint: 'zh',
                    preserveRequestedTarget: true,
                }),
            );
            expect(payload.translations?.en.text).toBe('Welcome back');
        });
    });

    describe('buildWordTimings', () => {
        it('splits text into word timings for whitespace languages', () => {
            const whisper = new Whisper();
            const words = (whisper as any).buildWordTimings('hello world', 0, 2);
            expect(words).toHaveLength(2);
            expect(words[0].text).toBe('hello');
            expect(words[1].text).toBe('world');
            expect(words[0].start).toBe(0);
            expect(words[1].end).toBe(2);
        });

        it('splits Japanese text into characters', () => {
            const whisper = new Whisper();
            const words = (whisper as any).buildWordTimings('こんにちは', 0, 1);
            expect(words).toHaveLength(5);
            expect(words[0].text).toBe('こ');
            expect(words[4].text).toBe('は');
        });

        it('returns empty array for empty text', () => {
            const whisper = new Whisper();
            expect((whisper as any).buildWordTimings('', 0, 1)).toEqual([]);
        });
    });

    describe('mergeSegments', () => {
        it('adds new segments', () => {
            const whisper = new Whisper();
            (whisper as any).segments = [];
            (whisper as any).lastSegmentEnd = 0;
            const newSegments = [
                { start: 0, end: 2, text: 'hello' },
                { start: 3, end: 5, text: 'world' },
            ];
            (whisper as any).mergeSegments(newSegments, { preferNew: true });
            expect((whisper as any).segments).toHaveLength(2);
        });

        it('updates existing segment when overlap detected', () => {
            const whisper = new Whisper();
            (whisper as any).segments = [
                { start: 0, end: 2, text: 'hi' },
            ];
            (whisper as any).lastSegmentEnd = 2;
            const newSegments = [
                { start: 0.1, end: 2.5, text: 'hello there' },
            ];
            (whisper as any).mergeSegments(newSegments, { preferNew: true });
            expect((whisper as any).segments).toHaveLength(1);
            expect((whisper as any).segments[0].text).toBe('hello there');
        });

        it('does nothing with empty input', () => {
            const whisper = new Whisper();
            (whisper as any).segments = [];
            (whisper as any).lastSegmentEnd = 0;
            (whisper as any).mergeSegments([], { preferNew: false });
            expect((whisper as any).segments).toHaveLength(0);
        });

        it('does not replace long segment with short fragment (duration guard)', () => {
            const whisper = new Whisper();
            // Cached long segment: full sentence spanning 8 seconds
            (whisper as any).segments = [
                { start: 10.0, end: 18.0, text: 'はい頑張りすぎないくらいがちょうどいい' },
            ];
            (whisper as any).lastSegmentEnd = 18.0;
            // Chunk boundary fragment: only 0.5s, similar start time
            const fragment = [
                { start: 10.05, end: 10.5, text: 'はい' },
            ];
            (whisper as any).mergeSegments(fragment, { preferNew: true });
            // The long segment should be preserved
            expect((whisper as any).segments).toHaveLength(1);
            expect((whisper as any).segments[0].text).toBe('はい頑張りすぎないくらいがちょうどいい');
        });

        it('does not add fragment contained within existing longer segment', () => {
            const whisper = new Whisper();
            (whisper as any).segments = [
                { start: 10.0, end: 18.0, text: 'full sentence here' },
            ];
            (whisper as any).lastSegmentEnd = 18.0;
            // Fragment with start time too far for match (>0.3) but within existing range
            const fragment = [
                { start: 10.4, end: 10.8, text: 'frag' },
            ];
            (whisper as any).mergeSegments(fragment, { preferNew: true });
            // Fragment should be dropped (contained within existing)
            expect((whisper as any).segments).toHaveLength(1);
            expect((whisper as any).segments[0].text).toBe('full sentence here');
        });

        it('replaces short fragment with longer segment (correct direction)', () => {
            const whisper = new Whisper();
            // Short fragment exists from a partial update
            (whisper as any).segments = [
                { start: 10.0, end: 10.5, text: 'はい' },
            ];
            (whisper as any).lastSegmentEnd = 10.5;
            // Complete transcription arrives with full sentence
            const full = [
                { start: 10.05, end: 18.0, text: 'はい頑張りすぎないくらいがちょうどいい' },
            ];
            (whisper as any).mergeSegments(full, { preferNew: true });
            // Fragment should be replaced by the longer segment
            expect((whisper as any).segments).toHaveLength(1);
            expect((whisper as any).segments[0].text).toBe('はい頑張りすぎないくらいがちょうどいい');
        });

        it('normal overlap with similar durations still works', () => {
            const whisper = new Whisper();
            (whisper as any).segments = [
                { start: 25.0, end: 32.0, text: 'old transcription' },
            ];
            (whisper as any).lastSegmentEnd = 32.0;
            const updated = [
                { start: 24.9, end: 31.5, text: 'corrected transcription' },
            ];
            (whisper as any).mergeSegments(updated, { preferNew: true });
            expect((whisper as any).segments).toHaveLength(1);
            expect((whisper as any).segments[0].text).toBe('corrected transcription');
        });

        it('dedup keeps longer segment when starts are near-identical', () => {
            const whisper = new Whisper();
            (whisper as any).segments = [];
            (whisper as any).lastSegmentEnd = 0;
            // Both pushed (different enough to not match, but will collide in dedup)
            const segs = [
                { start: 10.0, end: 18.0, text: 'full sentence' },
                { start: 10.1, end: 10.5, text: 'fragment' },
            ];
            (whisper as any).mergeSegments(segs, { preferNew: true });
            // Dedup should keep the longer segment
            expect((whisper as any).segments).toHaveLength(1);
            expect((whisper as any).segments[0].text).toBe('full sentence');
        });
    });

    describe('isNoiseOnly', () => {
        it('detects known whisper annotation patterns', () => {
            const whisper = new Whisper();
            expect((whisper as any).isNoiseOnly('[音楽]')).toBe(true);
            expect((whisper as any).isNoiseOnly('[laughter]')).toBe(true);
            expect((whisper as any).isNoiseOnly('[silence]')).toBe(true);
            expect((whisper as any).isNoiseOnly('(music)')).toBe(true);
            expect((whisper as any).isNoiseOnly('  applause  ')).toBe(true);
        });

        it('returns false for normal text', () => {
            const whisper = new Whisper();
            expect((whisper as any).isNoiseOnly('こんにちは')).toBe(false);
            expect((whisper as any).isNoiseOnly('Hello world')).toBe(false);
        });

        it('returns false for empty/whitespace and symbols (ASMR content)', () => {
            const whisper = new Whisper();
            // Empty/whitespace and symbols like ♪ are kept — they are valid ASMR content
            expect((whisper as any).isNoiseOnly('')).toBe(false);
            expect((whisper as any).isNoiseOnly('   ')).toBe(false);
            expect((whisper as any).isNoiseOnly('♪')).toBe(false);
            expect((whisper as any).isNoiseOnly('~')).toBe(false);
        });
    });

    describe('cleanText', () => {
        it('collapses whitespace', () => {
            const whisper = new Whisper();
            expect((whisper as any).cleanText('hello    world')).toBe('hello world');
        });

        it('trims whitespace', () => {
            const whisper = new Whisper();
            expect((whisper as any).cleanText('  hello  ')).toBe('hello');
        });

        it('handles empty/null input', () => {
            const whisper = new Whisper();
            expect((whisper as any).cleanText('')).toBe('');
            expect((whisper as any).cleanText(null)).toBe('');
        });
    });

    describe('resolveWhisperModelPreset', () => {
        it('maps explicit presets to official browser-compatible model IDs', () => {
            expect(resolveWhisperModelPreset('tiny', 'ignored'))
                .toBe('onnx-community/whisper-tiny');
            expect(resolveWhisperModelPreset('small', 'ignored'))
                .toBe('onnx-community/whisper-small_timestamped');
            expect(resolveWhisperModelPreset('medium', 'ignored'))
                .toBe('onnx-community/whisper-medium_timestamped');
            expect(resolveWhisperModelPreset('large-v3-turbo', 'ignored'))
                .toBe('onnx-community/whisper-large-v3-turbo_timestamped');
        });

        it('defers auto (or unknown) to the configured compatibility model', () => {
            expect(resolveWhisperModelPreset('auto', 'onnx-community/whisper-small_timestamped'))
                .toBe('onnx-community/whisper-small_timestamped');
            expect(resolveWhisperModelPreset('bogus', 'onnx-community/custom-model'))
                .toBe('onnx-community/custom-model');
            expect(resolveWhisperModelPreset('', '')).toBe('onnx-community/whisper-small_timestamped');
        });
    });

    describe('model preset + ASMR-safe live settings', () => {
        function mockConfig(overrides: Record<string, string | number | boolean>) {
            const map: Record<string, string | number | boolean> = {
                whisperModel: 'onnx-community/whisper-small_timestamped',
                whisperModelPreset: 'auto',
                whisperVadMode: 'off',
                whisperLanguage: 'auto',
                whisperTask: 'transcribe',
                whisperAutoWarmup: false,
                whisperCacheTranscripts: true,
                forceWhisperWasm: false,
                ...overrides,
            };
            vi.spyOn(Config, 'get').mockImplementation((key) => map[key as string] ?? false);
            return map;
        }

        function mockDevice(profile: Record<string, unknown>, shouldWarmup = false) {
            vi.spyOn(DeviceCapabilities, 'profile', 'get').mockReturnValue(profile as any);
            vi.spyOn(DeviceCapabilities, 'shouldWarmup', 'get').mockReturnValue(shouldWarmup);
            vi.spyOn(DeviceCapabilities, 'budget', 'get').mockReturnValue({ whisperIdleMs: 60_000 } as any);
            vi.spyOn(GpuScheduler, 'getMemoryPressure').mockReturnValue('low');
        }

        const fullProfile = {
            tier: 'full', hasGpu: true, memory: 16, cores: 8,
            isTouch: false, isMobile: false, screenWidth: 1920, reason: 'full',
        };

        it('defaults config to auto preset and exposes no runtime VAD threshold', () => {
            mockConfig({});
            mockDevice(fullProfile);
            const settings = (new Whisper() as any).getWhisperSettings();
            expect(settings.model).toBe('onnx-community/whisper-small_timestamped');
            expect(settings.chunkLengthS).toBe(29);
            expect(settings.strideLengthS).toBe(5);
            expect(settings).not.toHaveProperty('silenceThreshold');
            expect(settings).not.toHaveProperty('vadMode');
        });

        it('resolves an explicit medium preset to the official medium model', () => {
            mockConfig({ whisperModelPreset: 'medium' });
            mockDevice(fullProfile);
            expect((new Whisper() as any).getWhisperSettings().model)
                .toBe('onnx-community/whisper-medium_timestamped');
        });

        it('honors an explicit higher preset on unknown-memory Apple Silicon (no silent tiny downgrade)', () => {
            mockConfig({ whisperModelPreset: 'large-v3-turbo' });
            mockDevice({
                tier: 'full', hasGpu: true, memory: -1, cores: 10,
                isTouch: false, isMobile: false, screenWidth: 1728,
                gpuVendor: 'mozilla apple m1, or similar', reason: 'full, GPU, 10 cores',
            });
            // auto would downgrade this profile to tiny; an explicit preset must not.
            expect((new Whisper() as any).getWhisperSettings().model)
                .toBe('onnx-community/whisper-large-v3-turbo_timestamped');
        });

        it('keeps auto conservative downgrade to tiny on the same constrained profile', () => {
            mockConfig({ whisperModelPreset: 'auto' });
            mockDevice({
                tier: 'full', hasGpu: true, memory: -1, cores: 10,
                isTouch: false, isMobile: false, screenWidth: 1728,
                gpuVendor: 'mozilla apple m1, or similar', reason: 'full, GPU, 10 cores',
            });
            expect((new Whisper() as any).getWhisperSettings().model)
                .toBe('onnx-community/whisper-tiny');
        });

        it('force-WASM deterministically falls back to tiny even for an explicit preset, with a localized warning', () => {
            mockConfig({ whisperModelPreset: 'large-v3-turbo', forceWhisperWasm: true });
            mockDevice(fullProfile);
            const fallback = vi.fn();
            EventBus.on('whisper:fallback', fallback);
            try {
                const settings = (new Whisper() as any).getWhisperSettings();
                expect(settings.model).toBe('onnx-community/whisper-tiny');
                expect(fallback).toHaveBeenCalledWith(expect.objectContaining({
                    originalModel: 'onnx-community/whisper-large-v3-turbo_timestamped',
                    fallbackModel: 'onnx-community/whisper-tiny',
                    reason: expect.any(String),
                }));
            } finally {
                EventBus.off('whisper:fallback', fallback);
            }
        });

        it('no-GPU device deterministically falls back to tiny for an explicit preset', () => {
            mockConfig({ whisperModelPreset: 'medium' });
            mockDevice({
                tier: 'limited', hasGpu: false, memory: -1, cores: 8,
                isTouch: false, isMobile: false, screenWidth: 1440, gpuVendor: '', reason: 'no-GPU',
            });
            expect((new Whisper() as any).getWhisperSettings().model)
                .toBe('onnx-community/whisper-tiny');
        });

        it('ignores a legacy conservative VAD setting', () => {
            mockConfig({ whisperVadMode: 'conservative' });
            mockDevice(fullProfile);
            const settings = (new Whisper() as any).getWhisperSettings();
            expect(settings).not.toHaveProperty('silenceThreshold');
            expect(settings).not.toHaveProperty('vadMode');
        });

        it('uses configured live chunk and overlap values with safe bounds', () => {
            mockConfig({ whisperLiveChunkSec: 20, whisperLiveOverlapSec: 4 });
            mockDevice(fullProfile);
            const settings = (new Whisper() as any).getWhisperSettings();
            expect(settings.chunkLengthS).toBe(20);
            expect(settings.strideLengthS).toBe(4);

            vi.restoreAllMocks();
            mockConfig({ whisperLiveChunkSec: 90, whisperLiveOverlapSec: 90 });
            mockDevice(fullProfile);
            const bounded = (new Whisper() as any).getWhisperSettings();
            expect(bounded.chunkLengthS).toBe(29);
            expect(bounded.strideLengthS).toBe(8);
        });

        it('starts an idle background load when auto-warmup is enabled in settings', () => {
            const config = mockConfig({ whisperAutoWarmup: false });
            mockDevice(fullProfile, true);
            const whisper = new Whisper();
            const initSpy = vi.spyOn(whisper as any, 'initWorker').mockImplementation(() => {});
            (whisper as any).setupEventListeners();

            try {
                config.whisperAutoWarmup = true;
                EventBus.emit('config:change', {
                    key: 'whisperAutoWarmup',
                    value: true,
                    oldValue: false,
                });

                expect(initSpy).toHaveBeenCalledWith(expect.objectContaining({
                    autoWarmup: true,
                }));
                expect((whisper as any).autoWarmupStarted).toBe(true);
            } finally {
                (whisper as any).eventCleanups.splice(0).forEach((cleanup: () => void) => cleanup());
            }
        });

        it('clears stale ready UI and warms the newly selected idle model', () => {
            const config = mockConfig({
                whisperAutoWarmup: true,
                whisperModelPreset: 'small',
            });
            mockDevice(fullProfile, true);
            const whisper = new Whisper();
            const worker = {
                postMessage: vi.fn(),
                terminate: vi.fn(),
                onmessage: null,
                onerror: null,
            };
            (whisper as any).worker = worker;
            (whisper as any).modelReady = true;
            AppStore.setWhisperState({
                isTranscribing: false,
                isLoadingModel: false,
                progress: 100,
                progressMessage: '',
            });
            const initSpy = vi.spyOn(whisper as any, 'initWorker').mockImplementation(() => {});
            (whisper as any).setupEventListeners();

            try {
                config.whisperModelPreset = 'medium';
                EventBus.emit('config:change', {
                    key: 'whisperModelPreset',
                    value: 'medium',
                    oldValue: 'small',
                });

                expect(worker.postMessage).toHaveBeenCalledWith({ type: 'reset' });
                expect(AppStore.state.whisper.progress).toBe(0);
                expect((whisper as any).modelReady).toBe(false);
                expect(initSpy).toHaveBeenCalledWith(expect.objectContaining({
                    model: 'onnx-community/whisper-medium_timestamped',
                    autoWarmup: true,
                }));
            } finally {
                (whisper as any).eventCleanups.splice(0).forEach((cleanup: () => void) => cleanup());
            }
        });

        it('re-keys transcript caching to the model the worker actually loaded', () => {
            mockConfig({ whisperModelPreset: 'small' });
            mockDevice(fullProfile);
            const whisper = new Whisper();
            const source = 'https://example.test/audio.mp3';
            const requestedSettings = (whisper as any).getWhisperSettings();
            const requestedIdentity = (whisper as any).buildCacheIdentity(source, requestedSettings);
            (whisper as any).currentCacheSource = source;
            (whisper as any).currentCacheIdentity = requestedIdentity;
            (whisper as any).currentCacheKey = (whisper as any).buildCacheKey(source, requestedSettings);

            (whisper as any).adoptEffectiveWorkerModel('onnx-community/whisper-tiny', 'q8');

            expect(whisper.getEffectiveModelId()).toBe('onnx-community/whisper-tiny');
            expect((whisper as any).currentCacheIdentity).toContain('onnx-community/whisper-tiny');
            expect((whisper as any).currentCacheIdentity).not.toBe(requestedIdentity);
        });

        it('does not corrupt a complete effective-model cache after fallback re-keying', () => {
            mockConfig({ whisperModelPreset: 'small' });
            mockDevice(fullProfile);
            const whisper = new Whisper();
            const source = 'https://example.test/fallback-cache.mp3';
            const requestedSettings = (whisper as any).getWhisperSettings();
            const tinySettings = { ...requestedSettings, model: 'onnx-community/whisper-tiny' };
            const tinyKey = (whisper as any).buildCacheKey(source, tinySettings);
            SharedCache.set(tinyKey, {
                text: 'complete tiny transcript',
                segments: [{ start: 0, end: 120, text: 'complete tiny transcript' }],
                model: tinySettings.model,
                subtask: tinySettings.subtask,
                language: tinySettings.language,
                createdAt: Date.now(),
                complete: true,
            }, 60_000);

            (whisper as any).currentCacheSource = source;
            (whisper as any).currentCacheIdentity = (whisper as any).buildCacheIdentity(source, requestedSettings);
            (whisper as any).currentCacheKey = (whisper as any).buildCacheKey(source, requestedSettings);
            (whisper as any).segments = [{ start: 0, end: 10, text: 'partial fallback output' }];
            (whisper as any).lastPersistAt = 0;
            (whisper as any).adoptEffectiveWorkerModel('onnx-community/whisper-tiny', 'q8');

            (whisper as any).persistCache(false);

            const preserved = SharedCache.get<any>(tinyKey);
            expect(preserved?.text).toBe('complete tiny transcript');
            expect(preserved?.complete).toBe(true);
            expect(preserved?.segments).toHaveLength(1);
            expect(preserved?.segments[0]?.end).toBe(120);
        });
    });

    describe('ASMR-safe scheduling never drops low-RMS chunks', () => {
        it('sends a near-silent chunk even when a legacy threshold-shaped field is present', () => {
            const whisper = new Whisper();
            const audio = document.createElement('audio');
            audio.currentTime = 0;
            (whisper as any).audio = audio;
            (whisper as any).transcribing = true;
            (whisper as any).modelReady = true;
            (whisper as any).liveCaptureActive = false;
            const buffer = new Float32Array(6 * 16_000);
            buffer.fill(0.00005); // ~ -85 dBFS, far below any conservative threshold
            (whisper as any).pcmBuffer = buffer;
            (whisper as any).pcmDuration = 6;
            (whisper as any).pcmBufferStartTime = 0;
            (whisper as any).transcribedUpTo = 0;
            vi.spyOn((whisper as any).bridge, 'currentTrack', 'get').mockReturnValue(undefined);
            vi.spyOn(whisper as any, 'getWhisperSettings').mockReturnValue({
                chunkLengthS: 29, strideLengthS: 5, silenceThreshold: 0,
                maxPendingChunks: 6, pollIntervalMs: 250,
            });
            const send = vi.spyOn(whisper as any, 'sendChunk').mockImplementation(() => {});

            (whisper as any).maybeProcessNextChunk();

            expect(send).toHaveBeenCalledTimes(1);
            expect(send.mock.calls[0][3]).toBe(0);
            expect(send.mock.calls[0][6]).toBe(0);
        });
    });

    describe('decode-ready race (model ready before pcmBuffer)', () => {
        it('kicks a chunk synchronously when the loop starts, without a timer tick or seek', () => {
            const whisper = new Whisper();
            const audio = document.createElement('audio');
            audio.currentTime = 0;
            (whisper as any).audio = audio;
            // Model reported ready first (compatibility decode only now supplies PCM).
            (whisper as any).modelReady = true;
            (whisper as any).transcribing = true;
            (whisper as any).liveCaptureActive = false;
            const buffer = new Float32Array(29 * 16_000);
            buffer.fill(0.5);
            (whisper as any).pcmBuffer = buffer;
            (whisper as any).pcmDuration = 29;
            (whisper as any).pcmBufferStartTime = 0;
            (whisper as any).transcribedUpTo = 0;
            vi.spyOn((whisper as any).bridge, 'currentTrack', 'get').mockReturnValue(undefined);
            vi.spyOn(whisper as any, 'getWhisperSettings').mockReturnValue({
                chunkLengthS: 29, strideLengthS: 5, silenceThreshold: 0,
                maxPendingChunks: 6, pollIntervalMs: 100_000,
            });
            const send = vi.spyOn(whisper as any, 'sendChunk').mockImplementation(() => {});

            (whisper as any).startProcessingLoop();
            try {
                // No fake timers advanced, no seek() called — the synchronous kick alone must send.
                expect(send).toHaveBeenCalledTimes(1);
            } finally {
                (whisper as any).stopProcessingLoop();
            }
        });
    });
});
