import { describe, it, expect, beforeEach } from 'vitest';
import { Whisper, resolveWhisperLanguage, resolveWhisperModelPreset } from '../../src/features/Whisper';
import { DeviceCapabilities, __setWebGpuComputeProfileForTests } from '../../src/core/DeviceCapabilities';
import { GpuScheduler, Priority } from '../../src/core/GpuScheduler';
import { Config, I18n, Logger } from '../../src/core/Utils';
import { EventBus } from '../../src/core/EventBus';
import { TranslationService } from '../../src/services/TranslationService';
import { MLCrashGuard } from '../../src/core/MLCrashGuard';
import { SharedCache } from '../../src/core/Cache';
import { AppStore } from '../../src/store/AppStore';
import {
    getWhisperInferenceTimeoutMs,
    WHISPER_STALL_WATCHDOG_MARGIN_MS,
} from '../../src/features/whisperInferencePolicy';
import { __getWhisperWorkerCodeForTests } from '../../src/features/WhisperWorkerLoader';

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
        SharedCache.clear();
        trustedCorsSpy.mockReset();
        trustedCorsSpy.mockReturnValue(false);
    });

    function findWhisperUpdate(emit: any, source: string): any {
        return emit.mock.calls
            .find(([event, payload]: any[]) => (
                event === 'whisper:update' && payload.source === source
            ))?.[1];
    }

    function stubTranscriptionRuntime(
        whisper: Whisper,
        settings: Record<string, unknown>,
        liveCapture?: boolean,
    ): void {
        vi.spyOn(whisper as any, 'getWhisperSettings').mockReturnValue(settings);
        vi.spyOn(whisper as any, 'initWorker').mockImplementation(() => {});
        vi.spyOn(whisper as any, 'startProcessingLoop').mockImplementation(() => {});
        vi.spyOn(whisper as any, 'scheduleIdleUnload').mockImplementation(() => {});
        vi.spyOn(whisper as any, 'persistCache').mockImplementation(() => {});
        if (typeof liveCapture === 'boolean') {
            vi.spyOn(whisper as any, 'startLiveAudioCapture').mockReturnValue(liveCapture);
        }
        (whisper as any).enabled = true;
    }

    function createMockWhisperWorker() {
        return {
            postMessage: vi.fn(),
            terminate: vi.fn(),
            onmessage: null,
            onerror: null,
        };
    }

    function createCompatibilityWhisperSettings(overrides: Record<string, unknown> = {}) {
        return {
            model: 'onnx-community/whisper-tiny_timestamped',
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
            ...overrides,
        };
    }

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
            const settings = createCompatibilityWhisperSettings();
            stubTranscriptionRuntime(whisper, settings, true);
            const fetchAudio = vi.spyOn(whisper as any, 'fetchAndDecodeAudio');

            await (whisper as any).startTranscription();

            expect((whisper as any).startLiveAudioCapture).toHaveBeenCalled();
            expect(fetchAudio).not.toHaveBeenCalled();
            expect((whisper as any).transcribing).toBe(true);
            (whisper as any).stopTranscription('test');
        });

        it('prefers bounded low-quality decode over live capture without touching the oversized full source', async () => {
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
            const settings = createCompatibilityWhisperSettings();
            stubTranscriptionRuntime(whisper, settings, true);
            const stopLiveCapture = vi.spyOn(whisper as any, 'stopLiveAudioCapture');
            const fetchAudio = vi.spyOn(whisper as any, 'fetchAndDecodeAudio')
                .mockResolvedValue(new Float32Array(6 * 16_000));

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
            expect((whisper as any).startLiveAudioCapture).toHaveBeenCalledTimes(1);
            expect(stopLiveCapture).toHaveBeenCalled();
            (whisper as any).stopTranscription('test');
        });

        it('continues from standby live PCM when bounded low-quality decode fails', async () => {
            const whisper = new Whisper();
            const audio = document.createElement('audio');
            document.body.appendChild(audio);
            const lowUrl = 'https://raw.kiko-play-niptan.one/low/fallback-track.m4a';
            vi.spyOn((whisper as any).bridge, 'currentTrack', 'get').mockReturnValue({
                type: 'audio',
                hash: 'fallback-track',
                title: 'Fallback Track',
                streamLowQualityUrl: lowUrl,
                mediaStreamUrl: 'https://raw.kiko-play-niptan.one/full/fallback-track.flac',
                size: 80 * 1024 * 1024,
            });
            vi.spyOn((whisper as any).bridge, 'currentWorkId', 'get').mockReturnValue('RJ000003');
            const settings = createCompatibilityWhisperSettings();
            stubTranscriptionRuntime(whisper, settings, true);
            vi.mocked((whisper as any).startLiveAudioCapture).mockImplementation(() => {
                (whisper as any).liveCaptureActive = true;
                (whisper as any).pcmBuffer = new Float32Array(12 * 16_000);
                (whisper as any).pcmSampleLength = 12 * 16_000;
                (whisper as any).pcmDuration = 12;
                return true;
            });
            vi.spyOn(whisper as any, 'fetchAndDecodeAudio')
                .mockRejectedValue(new Error('bounded source unavailable'));
            const startLoop = vi.mocked((whisper as any).startProcessingLoop);

            await (whisper as any).startTranscription();

            expect(startLoop).toHaveBeenCalledTimes(1);
            expect((whisper as any).transcribing).toBe(true);
            expect((whisper as any).liveCaptureActive).toBe(true);
            (whisper as any).stopTranscription('test');
        });

        it('resumes a partial cache contiguously instead of skipping to playback backfill', async () => {
            const whisper = new Whisper();
            const audio = document.createElement('audio');
            const trackUrl = `${window.location.origin}/api/media/stream/partial-track`;
            audio.src = trackUrl;
            Object.defineProperty(audio, 'currentTime', { value: 100, writable: true });
            Object.defineProperty(audio, 'duration', { value: 120, configurable: true });
            document.body.appendChild(audio);
            const track = {
                type: 'audio',
                hash: 'partial-track',
                title: 'Partial Track',
                mediaStreamUrl: trackUrl,
                size: 8 * 1024 * 1024,
            };
            const settings = createCompatibilityWhisperSettings({
                backend: 'wasm',
                cacheTranscripts: true,
            });
            vi.spyOn((whisper as any).bridge, 'currentTrack', 'get').mockReturnValue(track);
            vi.spyOn((whisper as any).bridge, 'currentWorkId', 'get').mockReturnValue('RJ000002');
            stubTranscriptionRuntime(whisper, settings, false);
            vi.spyOn(whisper as any, 'fetchAndDecodeAudio')
                .mockResolvedValue(new Float32Array(120 * 16_000));

            const identity = (whisper as any).buildCacheIdentity(trackUrl, settings);
            const key = (whisper as any).buildCacheKey(trackUrl, settings);
            SharedCache.set(key, {
                text: '保存済み',
                segments: [{ start: 0, end: 20, text: '保存済み' }],
                model: settings.model,
                subtask: settings.subtask,
                language: settings.language,
                createdAt: Date.now(),
                complete: false,
                timingQuality: 'segment',
                processedRanges: [{ start: 0, end: 20 }],
                unavailableRanges: [],
                coverageOrigin: 0,
                sourceIdentity: identity,
            }, 60_000);

            await (whisper as any).startTranscription();

            expect((whisper as any).transcribedUpTo).toBe(18);
            expect((whisper as any).processedRanges).toEqual([{ start: 0, end: 20 }]);
            expect((whisper as any).fetchAndDecodeAudio).toHaveBeenCalled();
            (whisper as any).stopTranscription('test');
        });

        it('records an explicit unavailable gap when contiguous decode cannot resume', () => {
            const whisper = new Whisper();
            const audio = { currentTime: 100 } as HTMLAudioElement;
            vi.spyOn(whisper as any, 'canUseLiveAudioCapture').mockReturnValue(true);
            vi.spyOn(whisper as any, 'startLiveAudioCapture').mockReturnValue(true);
            const lag = vi.spyOn(whisper as any, 'reportLiveLag').mockImplementation(() => {});

            expect((whisper as any).resumeLiveCaptureWithExplicitGap(audio, 1, 20)).toBe(true);
            expect((whisper as any).unavailableRanges).toEqual([{ start: 20, end: 100 }]);
            expect((whisper as any).droppedBufferSeconds).toBe(80);
            expect(lag).toHaveBeenCalledWith('capture-buffer-trim', 80);
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

        it('suppresses the legacy cover status when the Vue learner surface is mounted', () => {
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
            const legacyStatus = document.querySelector('.whisper-status') as HTMLElement;
            expect(legacyStatus).not.toBeNull();

            const learnerRoot = document.createElement('div');
            learnerRoot.id = 'asmr-learner-subs-root';
            player.appendChild(learnerRoot);
            (whisper as any).showStatus('<span>encoder_model.onnx · WEBGPU · 45%</span>');

            expect(legacyStatus.style.display).toBe('none');
            expect(legacyStatus.style.visibility).toBe('hidden');
            expect(legacyStatus.textContent).toBe('');

            whisper.disable();
        });

        it('hides the legacy cover status while the player is fullscreen', () => {
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
            const legacyStatus = document.querySelector('.whisper-status') as HTMLElement;
            (whisper as any).showStatus('<span>Listening for speech…</span>');
            expect(legacyStatus.style.visibility).toBe('visible');

            player.classList.add('asmr-player-fullscreen');
            EventBus.emit('fullscreen:enter', undefined);
            (whisper as any).showStatus('<span>Listening for speech…</span>');

            expect(legacyStatus.style.display).toBe('none');
            expect(legacyStatus.style.visibility).toBe('hidden');
            expect(legacyStatus.textContent).toBe('');

            whisper.disable();
        });

        it('coalesces trailing transcript checkpoints into one delayed write', () => {
            vi.useFakeTimers();
            try {
                vi.setSystemTime(100_000);
                const whisper = new Whisper();
                const persist = vi.spyOn(whisper as any, 'persistCache').mockImplementation(() => {});
                (whisper as any).currentCacheKey = 'checkpoint-track';
                (whisper as any).segments = [{ start: 0, end: 5, text: '保存対象' }];
                (whisper as any).processedRanges = [{ start: 0, end: 5 }];
                (whisper as any).lastPersistAt = 95_000;

                (whisper as any).queueCacheCheckpoint();
                (whisper as any).queueCacheCheckpoint();
                vi.advanceTimersByTime(4_999);
                expect(persist).not.toHaveBeenCalled();

                vi.advanceTimersByTime(1);
                expect(persist).toHaveBeenCalledTimes(1);
                expect((whisper as any).cacheCheckpointTimer).toBeNull();
            } finally {
                vi.useRealTimers();
            }
        });

        it('persists coverage-only progress for silent audio without creating a transcript badge', () => {
            const whisper = new Whisper();
            const settings = createCompatibilityWhisperSettings({ cacheTranscripts: true });
            const cacheKey = 'whisper:coverage-only';
            const updateIndex = vi.spyOn(whisper as any, 'updateTranscriptIndex');
            const translate = vi.spyOn(whisper as any, 'ensureTranslatedTranscript');
            (whisper as any).currentCacheKey = cacheKey;
            (whisper as any).currentCacheIdentity = 'silent-track';
            (whisper as any).activeRunSettings = Object.freeze(settings);
            (whisper as any).processedRanges = [{ start: 0, end: 10 }];
            (whisper as any).coverageOrigin = 0;
            (whisper as any).pcmDuration = 10;
            (whisper as any).timingQuality = 'segment';

            (whisper as any).persistCache(true, true);

            expect(SharedCache.get(cacheKey)).toMatchObject({
                text: '',
                segments: [],
                complete: true,
                processedRanges: [{ start: 0, end: 10 }],
            });
            expect(updateIndex).not.toHaveBeenCalled();
            expect(translate).not.toHaveBeenCalled();
        });

        it('replaces an unusable legacy complete entry with resumable silent coverage', () => {
            const whisper = new Whisper();
            const settings = createCompatibilityWhisperSettings({ cacheTranscripts: true });
            const cacheKey = 'whisper:invalid-legacy-complete';
            SharedCache.set(cacheKey, {
                text: '<|0.00|><|10.00|>',
                segments: [{ start: 0, end: 10, text: '<|0.00|><|10.00|>' }],
                model: settings.model,
                subtask: settings.subtask,
                language: settings.language,
                createdAt: Date.now() - 1_000,
                complete: true,
            }, 60_000);
            (whisper as any).currentCacheKey = cacheKey;
            (whisper as any).currentCacheIdentity = 'silent-track';
            (whisper as any).activeRunSettings = Object.freeze(settings);
            (whisper as any).processedRanges = [{ start: 0, end: 5 }];
            (whisper as any).coverageOrigin = 0;
            (whisper as any).pcmDuration = 10;

            (whisper as any).persistCache(false, true);

            expect(SharedCache.get(cacheKey)).toMatchObject({
                text: '',
                segments: [],
                complete: false,
                processedRanges: [{ start: 0, end: 5 }],
                sourceIdentity: 'silent-track',
            });
        });

        it('rewinds unfinished audio before bfcache WebGPU reclamation and resumes the exact plan', () => {
            const whisper = new Whisper();
            const flush = vi.spyOn(whisper as any, 'flushCacheCheckpoint').mockImplementation(() => {});
            const initWorker = vi.spyOn(whisper as any, 'initWorker').mockImplementation(() => {});
            const worker = createMockWhisperWorker();
            const settings = createCompatibilityWhisperSettings({
                model: 'onnx-community/whisper-base',
                backend: 'webgpu',
            });
            vi.spyOn(whisper as any, 'getExecutionSettings').mockReturnValue(settings);
            (whisper as any).enabled = true;
            (whisper as any).transcribing = true;
            (whisper as any).worker = worker;
            (whisper as any).loadedPlan = Object.freeze({
                model: settings.model,
                backend: 'webgpu',
                multilingual: settings.multilingual,
            });
            (whisper as any).pcmDuration = 60;
            (whisper as any).transcribedUpTo = 40;
            (whisper as any).pendingChunks = 2;
            (whisper as any).chunkOffsets.set(10, 18);
            (whisper as any).chunkOffsets.set(11, 24);
            (whisper as any).setupEventListeners();

            try {
                window.dispatchEvent(new Event('pagehide'));
                expect(flush).toHaveBeenCalledWith(false);
                expect(worker.terminate).toHaveBeenCalledTimes(1);
                expect(worker.postMessage).not.toHaveBeenCalledWith({ type: 'reset' });
                expect((whisper as any).worker).toBeNull();
                expect((whisper as any).transcribedUpTo).toBe(18);
                expect((whisper as any).chunkOffsets.size).toBe(0);

                const pageShow = new Event('pageshow');
                Object.defineProperty(pageShow, 'persisted', { value: true });
                window.dispatchEvent(pageShow);
                expect(initWorker).toHaveBeenCalledWith(settings);
                expect((whisper as any).transcribedUpTo).toBe(18);
            } finally {
                (whisper as any).eventCleanups.splice(0).forEach((cleanup: () => void) => cleanup());
            }
        });
    });

    describe('transcription restart races', () => {
        const settings = {
            preset: 'small',
            model: 'onnx-community/whisper-small_timestamped',
            backend: 'webgpu',
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
            stubTranscriptionRuntime(whisper, settings);

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
        it('does not overlap replacement Firefox WebGPU sessions after terminating the old owner', () => {
            vi.useFakeTimers();
            vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:153.0) Gecko/20100101 Firefox/153.0',
            );
            try {
                const whisper = new Whisper();
                const worker = createMockWhisperWorker();
                const settings = createCompatibilityWhisperSettings({
                    model: 'onnx-community/whisper-base',
                    backend: 'webgpu',
                });
                (whisper as any).enabled = true;
                (whisper as any).worker = worker;
                (whisper as any).loadedPlan = Object.freeze({
                    model: settings.model,
                    backend: 'webgpu',
                    multilingual: settings.multilingual,
                });

                (whisper as any).resetWorker('model-change');
                const ensureWorker = vi.spyOn(whisper as any, 'ensureWorker').mockImplementation(() => {});
                (whisper as any).initWorker(settings);

                expect(worker.terminate).toHaveBeenCalledTimes(1);
                expect(worker.postMessage).not.toHaveBeenCalledWith({ type: 'reset' });
                expect(ensureWorker).not.toHaveBeenCalled();

                vi.advanceTimersByTime(1_499);
                expect(ensureWorker).not.toHaveBeenCalled();
                vi.advanceTimersByTime(1);
                expect(ensureWorker).toHaveBeenCalledTimes(1);
            } finally {
                vi.clearAllTimers();
                vi.useRealTimers();
            }
        });

        it('cancels a deferred Firefox WebGPU restart when transcription is stopped', () => {
            vi.useFakeTimers();
            vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:153.0) Gecko/20100101 Firefox/153.0',
            );
            try {
                const whisper = new Whisper();
                const worker = createMockWhisperWorker();
                const settings = createCompatibilityWhisperSettings({
                    model: 'onnx-community/whisper-base',
                    backend: 'webgpu',
                    forceWasm: false,
                });
                const ensureWorker = vi.spyOn(whisper as any, 'ensureWorker').mockImplementation(() => {});
                vi.spyOn(whisper as any, 'scheduleIdleUnload').mockImplementation(() => {});
                (whisper as any).enabled = true;
                (whisper as any).transcribing = true;
                (whisper as any).activeRunSettings = settings;
                (whisper as any).worker = worker;
                (whisper as any).loadedPlan = Object.freeze({
                    model: settings.model,
                    backend: 'webgpu',
                    multilingual: settings.multilingual,
                });

                (whisper as any).resetWorker('inference-runtime-error', true);
                (whisper as any).initWorker(settings);

                expect((whisper as any).workerRestartTimer).not.toBeNull();
                expect((whisper as any).deferredWorkerSettings).toBe(settings);

                (whisper as any).stopTranscription('toggle');
                vi.advanceTimersByTime(1_500);

                expect(ensureWorker).not.toHaveBeenCalled();
                expect((whisper as any).workerRestartTimer).toBeNull();
                expect((whisper as any).deferredWorkerSettings).toBeNull();
            } finally {
                vi.clearAllTimers();
                vi.useRealTimers();
            }
        });

        it('gates a direct different-plan Firefox WebGPU replacement without changing the selected plan', async () => {
            vi.useFakeTimers();
            vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:153.0) Gecko/20100101 Firefox/153.0',
            );
            const whisper = new Whisper();
            const oldWorker = createMockWhisperWorker();
            const replacementWorker = createMockWhisperWorker();
            const settings = createCompatibilityWhisperSettings({
                model: 'onnx-community/whisper-small_timestamped',
                backend: 'webgpu',
                forceWasm: false,
            });
            const releaseLease = vi.fn();
            vi.spyOn(GpuScheduler, 'acquireLoadLease').mockResolvedValue(releaseLease);
            vi.spyOn(whisper as any, 'getExecutionSettings').mockReturnValue(settings);
            const ensureWorker = vi.spyOn(whisper as any, 'ensureWorker').mockImplementation(() => {
                (whisper as any).worker = replacementWorker;
            });
            (whisper as any).enabled = true;
            (whisper as any).transcribing = true;
            (whisper as any).worker = oldWorker;
            (whisper as any).inferenceDurationEwmaMs = 100_000;
            (whisper as any).loadedPlan = Object.freeze({
                model: 'onnx-community/whisper-base',
                backend: 'webgpu',
                multilingual: true,
            });

            try {
                (whisper as any).initWorker(settings);

                expect(oldWorker.terminate).toHaveBeenCalledTimes(1);
                expect(ensureWorker).not.toHaveBeenCalled();
                expect((whisper as any).deferredWorkerSettings).toBe(settings);

                await vi.advanceTimersByTimeAsync(1_499);
                expect(ensureWorker).not.toHaveBeenCalled();
                expect(replacementWorker.postMessage).not.toHaveBeenCalled();

                await vi.advanceTimersByTimeAsync(1);
                await Promise.resolve();

                expect(ensureWorker).toHaveBeenCalledTimes(1);
                expect(replacementWorker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
                    type: 'init',
                    model: settings.model,
                    backend: 'webgpu',
                    multilingual: settings.multilingual,
                    recentInferenceDurationMs: null,
                }));
                expect((whisper as any).loadedPlan).toEqual({
                    model: settings.model,
                    backend: 'webgpu',
                    multilingual: settings.multilingual,
                });
            } finally {
                (whisper as any).resetWorker('test-cleanup', true);
                vi.clearAllTimers();
                vi.useRealTimers();
            }
        });

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

        it('stops on a selected-model load failure without changing model or backend', async () => {
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
                (whisper as any).loadedPlan = Object.freeze({
                    model: 'onnx-community/whisper-small_timestamped',
                    backend: 'webgpu',
                    multilingual: true,
                });

                oldWorker.onmessage!({
                    data: {
                        status: 'load-failed',
                        backend: 'webgpu',
                        model: 'onnx-community/whisper-small_timestamped',
                        dtype: '{"encoder_model":"fp32","decoder_model_merged":"q4"}',
                        data: {
                            message: 'invalid session while disposing the failed model',
                            sessionPoisoned: true,
                        },
                    },
                } as MessageEvent);
                await Promise.resolve();
                await Promise.resolve();

                expect(workers).toHaveLength(1);
                expect(oldWorker.terminate).toHaveBeenCalledTimes(1);
                expect((whisper as any).worker).toBeNull();
                expect((whisper as any).transcribing).toBe(false);
                expect(stopSpy).toHaveBeenCalledWith('webgpu-model-load-failed');
                expect((whisper as any).consecutiveInferenceTimeouts).toBe(1);
                expect(oldWorker.postMessage).not.toHaveBeenCalledWith({ type: 'skip-webgpu' });
            } finally {
                if (whisper) (whisper as any).resetWorker('test-cleanup', true);
                vi.clearAllTimers();
                vi.unstubAllGlobals();
                vi.useRealTimers();
            }
        });

        it('treats a WASM load failure as terminal without consuming inference retries', () => {
            const whisper = new Whisper();
            const worker = createMockWhisperWorker();
            const initSpy = vi.spyOn(whisper as any, 'initWorker').mockImplementation(() => {});
            const stopSpy = vi.spyOn(whisper as any, 'stopTranscription').mockImplementation(() => {
                (whisper as any).transcribing = false;
            });
            vi.spyOn(whisper as any, 'showStatus').mockImplementation(() => {});
            (whisper as any).worker = worker;
            (whisper as any).loadedPlan = Object.freeze({
                model: 'onnx-community/whisper-tiny_timestamped',
                backend: 'wasm',
                multilingual: true,
            });
            (whisper as any).transcribing = true;
            (whisper as any).consecutiveInferenceTimeouts = 1;

            (whisper as any).handleWorkerMessage({
                data: {
                    status: 'load-failed',
                    backend: 'wasm',
                    model: 'onnx-community/whisper-tiny_timestamped',
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
            const worker = createMockWhisperWorker();
            const release = vi.fn();
            let resolveLease!: (release: () => void) => void;
            const lease = new Promise<() => void>(resolve => { resolveLease = resolve; });
            const acquireSpy = vi.spyOn(GpuScheduler, 'acquireLoadLease').mockReturnValue(lease);
            const settings = {
                preset: 'small',
                model: 'onnx-community/whisper-small_timestamped',
                backend: 'webgpu',
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
            (whisper as any).inferenceDurationEwmaMs = 100_000;
            vi.spyOn(whisper as any, 'ensureWorker').mockImplementation(() => {
                if (!(whisper as any).worker) (whisper as any).worker = worker;
            });
            vi.spyOn(whisper as any, 'getWhisperSettings').mockReturnValue(settings);

            (whisper as any).initWorker(settings);
            (whisper as any).initWorker(settings);
            expect(acquireSpy).toHaveBeenCalledTimes(1);

            resolveLease(release);
            await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(1));
            expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
                type: 'init',
                recentInferenceDurationMs: 100_000,
            }));

            (whisper as any).handleWorkerMessage({
                data: {
                    status: 'ready',
                    model: settings.model,
                    backend: settings.backend,
                    dtype: '{"encoder_model":"fp32","decoder_model_merged":"q4"}',
                },
            });
            (whisper as any).initWorker(settings);
            expect(acquireSpy).toHaveBeenCalledTimes(1);
            expect(release).toHaveBeenCalledTimes(1);
        });

        it('recreates a ready worker when model, backend, or multilingual identity changes', async () => {
            const oldWorker = createMockWhisperWorker();
            const replacementWorker = createMockWhisperWorker();
            vi.spyOn(GpuScheduler, 'acquireLoadLease').mockResolvedValue(vi.fn());
            const whisper = new Whisper();
            (whisper as any).enabled = true;
            (whisper as any).worker = oldWorker;
            (whisper as any).modelReady = true;
            (whisper as any).loadedPlan = Object.freeze({
                model: 'onnx-community/whisper-tiny_timestamped',
                backend: 'webgpu',
                multilingual: true,
            });
            vi.spyOn(whisper as any, 'ensureWorker').mockImplementation(() => {
                if (!(whisper as any).worker) (whisper as any).worker = replacementWorker;
            });
            const changedSettings = {
                preset: 'tiny',
                model: 'onnx-community/whisper-tiny_timestamped',
                backend: 'wasm',
                multilingual: true,
                subtask: 'transcribe',
                language: 'japanese',
                chunkLengthS: 29,
                strideLengthS: 5,
                cacheTranscripts: true,
                autoWarmup: false,
                maxPendingChunks: 2,
                pollIntervalMs: 250,
                workerUpdateIntervalMs: 200,
                idleUnloadMs: 600_000,
                forceWasm: true,
                preferLowPowerAdapter: false,
                minWebgpuBufferBytes: 256 * 1024 * 1024,
            };

            (whisper as any).initWorker(changedSettings);
            await vi.waitFor(() => expect(replacementWorker.postMessage).toHaveBeenCalled());

            expect(oldWorker.terminate).toHaveBeenCalledTimes(1);
            expect((whisper as any).worker).toBe(replacementWorker);
            expect((whisper as any).loadedPlan).toEqual({
                model: changedSettings.model,
                backend: 'wasm',
                multilingual: true,
            });
            expect(replacementWorker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
                type: 'init',
                model: 'onnx-community/whisper-tiny_timestamped',
                backend: 'wasm',
            }));
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

            const capacity = Math.max(29, validSeconds) * 16_000;
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
            const { whisper, send } = setupLiveBuffer(100, 29);

            (whisper as any).maybeProcessNextChunk();

            // The first window after a fresh buffer is the short bootstrap
            // window, so a caption appears without waiting a full 29s.
            expect(send).toHaveBeenCalledTimes(1);
            const chunk = send.mock.calls[0][0] as Float32Array;
            expect(send.mock.calls[0][1]).toBe(100);
            expect(chunk.length).toBe(8 * 16_000);
            expect(chunk[0]).toBe(0.5);
            expect(chunk[chunk.length - 1]).toBe(0.5);
        });

        it('uses the full context window immediately after the bootstrap window', () => {
            // Needs enough buffered audio for a full window after the bootstrap
            // advance, otherwise the scheduler correctly waits for more.
            const { whisper, send } = setupLiveBuffer(100, 60);

            (whisper as any).maybeProcessNextChunk();
            (whisper as any).pendingChunks = 0;
            (whisper as any).maybeProcessNextChunk();

            expect(send).toHaveBeenCalledTimes(2);
            // Bootstrap advanced 8s with no overlap; the next window is full length.
            expect(send.mock.calls[1][1]).toBe(108);
            expect((send.mock.calls[1][0] as Float32Array).length).toBe(29 * 16_000);
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
            expect(chunk.length).toBe(29 * 16_000);
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

        it('starts the M1 Firefox Auto profile on timestamped Base with bounded WebGPU scheduling', () => {
            vi.spyOn(Config, 'get').mockImplementation((key) => {
                const map: Record<string, string | number | boolean> = {
                    whisperModel: 'onnx-community/whisper-small_timestamped',
                    whisperLanguage: 'auto',
                    whisperTask: 'transcribe',
                    whisperAutoWarmup: true,
                    whisperCacheTranscripts: true,
                    forceWhisperWasm: false,
                    whisperAdaptiveWindow: true,
                    whisperLiveChunkSec: 29,
                    whisperLiveOverlapSec: 5,
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

            expect(settings.model).toBe('onnx-community/whisper-base_timestamped');
            expect(settings.forceWasm).toBe(false);
            expect(settings.preferLowPowerAdapter).toBe(false);
            expect(settings.maxPendingChunks).toBe(2);
            expect(settings.chunkLengthS).toBe(29);
            expect(settings.strideLengthS).toBe(5);
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
            expect(settings.minWebgpuBufferBytes).toBe(256 * 1024 * 1024);
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

            expect(settings.model).toBe('onnx-community/whisper-tiny_timestamped');
            expect(settings.maxPendingChunks).toBe(2);
            expect(settings.autoWarmup).toBe(false);
        });

        it('prefers a high-performance adapter on Intel-mac limited profiles', () => {
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

            expect(settings.preferLowPowerAdapter).toBe(false);
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
            (whisper as any).activeRunSettings = { backend: 'webgpu' };
            const isGpuError = (whisper as any).isGpuErrorMessage('Mapping WebGPU buffer failed: Invalid buffer');
            expect(isGpuError).toBe(true);
        });

        it('does not mislabel a WASM OrtRun failure as a GPU crash', () => {
            const whisper = new Whisper();
            (whisper as any).activeRunSettings = { backend: 'wasm' };

            expect((whisper as any).isGpuErrorMessage('OrtRun failed during inference')).toBe(false);
        });
    });

    describe('exact execution plan', () => {
        it('keeps an explicit WebGPU model/backend unchanged after a prior crash', () => {
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
            (whisper as any).gpuCrashed = true;
            (whisper as any).activeRunSettings = Object.freeze({
                ...(whisper as any).getWhisperSettings(),
                preset: 'small',
                model: 'onnx-community/whisper-small_timestamped',
                backend: 'webgpu',
            });

            const result = (whisper as any).getExecutionSettings();

            expect(result.model).toBe('onnx-community/whisper-small_timestamped');
            expect(result.backend).toBe('webgpu');
            expect((whisper as any).gpuCrashed).toBe(true);
        });
    });

    describe('worker timeout handling', () => {
        const pinnedSmallWebGpuPlan = Object.freeze({
            model: 'onnx-community/whisper-small_timestamped',
            backend: 'webgpu',
            multilingual: true,
        });

        function stubWorkerReset(whisper: Whisper) {
            const resetWorker = vi.spyOn(whisper as any, 'resetWorker').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'clearModelLoadTimer').mockImplementation(() => {});
            return resetWorker;
        }

        function signalPoisonedWorker(
            whisper: Whisper,
            details: Record<string, unknown> = {},
        ): void {
            (whisper as any).handleWorkerMessage({
                data: {
                    status: 'worker-poisoned',
                    data: {
                        reason: 'inference-timeout',
                        gpuFailure: false,
                        ...details,
                    },
                },
            } as any);
        }

        function stubPoisonRecovery(whisper: Whisper) {
            return {
                resetWorkerSpy: vi.spyOn(whisper as any, 'resetWorker').mockImplementation(() => {}),
                initSpy: vi.spyOn(whisper as any, 'initWorker').mockImplementation(() => {}),
            };
        }

        function setupTerminalPoisonRecovery() {
            const whisper = new Whisper();
            const recovery = stubPoisonRecovery(whisper);
            const stopSpy = vi.spyOn(whisper as any, 'stopTranscription').mockImplementation(() => {
                (whisper as any).transcribing = false;
            });
            vi.spyOn(whisper as any, 'dispatchProgress').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'showStatus').mockImplementation(() => {});
            (whisper as any).transcribing = true;
            (whisper as any).worker = { postMessage: vi.fn() };
            return { whisper, stopSpy, ...recovery };
        }

        it('terminates an inference error without silently changing the execution plan', () => {
            const whisper = new Whisper();
            const resetWorkerSpy = stubWorkerReset(whisper);

            (whisper as any).transcribing = false;
            (whisper as any).pendingChunks = 1;
            (whisper as any).chunkSendTimes.set(42, performance.now());
            (whisper as any).chunkGenerations.set(42, (whisper as any).transcriptionGeneration);
            (whisper as any).chunkOffsets.set(42, 0);
            (whisper as any).chunkLastActivity.set(42, performance.now());

            (whisper as any).handleWorkerMessage({
                data: {
                    status: 'error',
                    data: { message: 'WebGPU inference timed out after 120s' },
                    chunkId: 42,
                },
            } as any);

            expect((whisper as any).pendingChunks).toBe(0);
            expect((whisper as any).chunkSendTimes.has(42)).toBe(false);
            expect((whisper as any).chunkGenerations.has(42)).toBe(false);
            expect((whisper as any).chunkOffsets.has(42)).toBe(false);
            expect((whisper as any).chunkLastActivity.has(42)).toBe(false);
            expect(resetWorkerSpy).toHaveBeenCalledWith('worker-message-error', true);
        });

        it('treats an explicitly signalled WebGPU timeout as terminal without substitution', () => {
            const whisper = new Whisper();
            const resetWorkerSpy = stubWorkerReset(whisper);
            (whisper as any).loadedPlan = pinnedSmallWebGpuPlan;
            (whisper as any).transcribing = false;
            (whisper as any).pendingChunks = 1;
            (whisper as any).chunkSendTimes.set(9, performance.now());
            (whisper as any).chunkGenerations.set(9, (whisper as any).transcriptionGeneration);

            (whisper as any).handleWorkerMessage({
                data: {
                    status: 'error',
                    data: { message: 'WebGPU inference timed out after 120s', gpuFailure: false },
                    chunkId: 9,
                },
            } as any);

            expect(resetWorkerSpy).toHaveBeenCalledWith('worker-message-error', true);
            expect((whisper as any).loadedPlan.model).toBe('onnx-community/whisper-small_timestamped');
            expect((whisper as any).loadedPlan.backend).toBe('webgpu');
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
                    data: { message: 'WebGPU inference timed out after 120s', gpuFailure: false },
                    chunkId: 99,
                },
            } as any);

            expect(resetWorkerSpy).not.toHaveBeenCalled();
            expect(stopSpy).not.toHaveBeenCalled();
            expect((whisper as any).transcribing).toBe(true);

            // The worker separately reports that it is poisoned. Preserve the
            // live run, replace the worker, and resume the post-seek range.
            (whisper as any).chunkOffsets.set(100, 42);
            signalPoisonedWorker(whisper);
            expect(resetWorkerSpy).toHaveBeenCalledWith('inference-timeout', true);
            expect(initSpy).toHaveBeenCalled();
            expect(stopSpy).not.toHaveBeenCalled();
            expect((whisper as any).transcribedUpTo).toBe(42);
        });

        it('surfaces audio that expired before a poisoned worker can retry it', () => {
            const whisper = new Whisper();
            const { resetWorkerSpy, initSpy } = stubPoisonRecovery(whisper);
            const progressSpy = vi.spyOn(whisper as any, 'dispatchProgress').mockImplementation(() => {});
            const lagSpy = vi.spyOn(whisper as any, 'reportLiveLag').mockImplementation(() => {});
            (whisper as any).transcribing = true;
            (whisper as any).worker = { postMessage: vi.fn() };
            (whisper as any).pcmBufferStartTime = 50;
            (whisper as any).chunkOffsets.set(100, 42);

            signalPoisonedWorker(whisper);

            expect(resetWorkerSpy).toHaveBeenCalledWith('inference-timeout', true);
            expect(initSpy).toHaveBeenCalled();
            expect((whisper as any).transcribedUpTo).toBe(50);
            expect((whisper as any).droppedBufferSeconds).toBe(8);
            expect(lagSpy).toHaveBeenCalledWith('capture-buffer-trim', 8);
            expect(progressSpy).not.toHaveBeenCalled();
        });

        it('logs timeout diagnostics and resumes the exact plan without changing seek generation', () => {
            const whisper = new Whisper();
            const { resetWorkerSpy, initSpy } = stubPoisonRecovery(whisper);
            const warning = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
            const exactSettings = Object.freeze({
                model: 'onnx-community/whisper-base_timestamped',
                backend: 'webgpu',
                multilingual: true,
            });
            (whisper as any).activeRunSettings = exactSettings;
            (whisper as any).transcribing = true;
            (whisper as any).worker = { postMessage: vi.fn() };
            (whisper as any).transcriptionGeneration = 11;
            (whisper as any).transcribedUpTo = 70;
            (whisper as any).chunkOffsets.set(41, 36);

            signalPoisonedWorker(whisper, {
                chunkId: 41,
                chunkLengthS: 8,
                elapsedMs: 150_004,
                budgetMs: 150_000,
                kind: 'warm',
                backend: 'webgpu',
                model: exactSettings.model,
                observedInferenceMs: 100_000,
            });

            expect(warning).toHaveBeenCalledWith(
                '[Whisper] Replacing poisoned inference worker without stopping the live run',
                expect.objectContaining({
                    reason: 'inference-timeout',
                    chunkId: 41,
                    chunkLengthS: 8,
                    elapsedMs: 150_004,
                    budgetMs: 150_000,
                    kind: 'warm',
                    backend: 'webgpu',
                    model: exactSettings.model,
                    observedInferenceMs: 100_000,
                    resumeFrom: 36,
                }),
            );
            expect(resetWorkerSpy).toHaveBeenCalledWith('inference-timeout', true);
            expect(initSpy).toHaveBeenCalledWith(exactSettings);
            expect((whisper as any).activeRunSettings).toBe(exactSettings);
            expect((whisper as any).transcriptionGeneration).toBe(11);
            expect((whisper as any).transcribedUpTo).toBe(36);
        });

        it('resumes Firefox Buffer unmapped from the earliest unfinished cursor on the exact plan', () => {
            const whisper = new Whisper();
            const { resetWorkerSpy, initSpy } = stubPoisonRecovery(whisper);
            const stopSpy = vi.spyOn(whisper as any, 'stopTranscription').mockImplementation(() => {});
            const persistSpy = vi.spyOn(whisper as any, 'persistCache').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'dispatchProgress').mockImplementation(() => {});
            (whisper as any).activeRunSettings = Object.freeze({
                model: 'onnx-community/whisper-small_timestamped',
                backend: 'webgpu',
                multilingual: true,
            });
            (whisper as any).transcribing = true;
            (whisper as any).worker = { postMessage: vi.fn() };
            (whisper as any).segments = [{ start: 0, end: 28, text: '完成済み' }];
            (whisper as any).lastSegmentEnd = 28;
            (whisper as any).transcribedUpTo = 59;
            (whisper as any).pcmBufferStartTime = 0;
            (whisper as any).chunkOffsets.set(9, 30);

            (whisper as any).handleWorkerMessage({
                data: {
                    status: 'worker-poisoned',
                    data: {
                        reason: 'inference-runtime-error',
                        message: 'Failed to download data from buffer: Buffer unmapped',
                        gpuFailure: true,
                    },
                },
            } as any);

            expect(resetWorkerSpy).toHaveBeenCalledWith('inference-runtime-error', true);
            expect(initSpy).toHaveBeenCalledWith(expect.objectContaining({
                model: 'onnx-community/whisper-small_timestamped',
                backend: 'webgpu',
            }));
            expect((whisper as any).transcribedUpTo).toBe(30);
            expect((whisper as any).segments).toEqual([{ start: 0, end: 28, text: '完成済み' }]);
            expect(persistSpy).toHaveBeenCalledWith(false, true);
            expect(stopSpy).not.toHaveBeenCalled();
        });

        it('bounds transient Firefox Buffer unmapped recovery without changing the exact plan', () => {
            const { whisper, resetWorkerSpy, initSpy, stopSpy } = setupTerminalPoisonRecovery();
            const exactSettings = Object.freeze({
                model: 'onnx-community/whisper-base',
                backend: 'webgpu',
                multilingual: true,
            });
            vi.spyOn(whisper as any, 'flushCacheCheckpoint').mockImplementation(() => {});
            (whisper as any).activeRunSettings = exactSettings;

            const loseReadback = () => (whisper as any).handleWorkerMessage({
                data: {
                    status: 'worker-poisoned',
                    data: {
                        reason: 'inference-runtime-error',
                        message: 'Failed to download data from buffer: Buffer unmapped',
                        gpuFailure: true,
                    },
                },
            } as any);

            loseReadback();
            loseReadback();
            loseReadback();

            expect(initSpy).toHaveBeenCalledTimes(3);
            expect(initSpy).toHaveBeenLastCalledWith(exactSettings);
            expect(stopSpy).not.toHaveBeenCalled();
            expect((whisper as any).activeRunSettings).toBe(exactSettings);

            loseReadback();

            expect(resetWorkerSpy).toHaveBeenLastCalledWith(
                'inference-runtime-error-terminal',
                true,
            );
            expect(stopSpy).toHaveBeenCalledWith('inference-runtime-error-terminal');
            expect(initSpy).toHaveBeenCalledTimes(3);
        });

        it('retries a transient replacement-adapter miss on the exact WebGPU plan', () => {
            const { whisper, resetWorkerSpy, initSpy, stopSpy } = setupTerminalPoisonRecovery();
            const exactSettings = Object.freeze({
                model: 'onnx-community/whisper-base',
                backend: 'webgpu',
                multilingual: true,
            });
            const failPinnedSelection = vi.spyOn(
                whisper as any,
                'failPinnedSelection',
            ).mockImplementation(() => {});
            vi.spyOn(whisper as any, 'flushCacheCheckpoint').mockImplementation(() => {});
            (whisper as any).activeRunSettings = exactSettings;
            (whisper as any).loadedPlan = exactSettings;
            (whisper as any).consecutiveInferenceTimeouts = 1;

            (whisper as any).handleWorkerMessage({
                data: {
                    status: 'load-failed',
                    model: exactSettings.model,
                    backend: exactSettings.backend,
                    data: {
                        model: exactSettings.model,
                        backend: exactSettings.backend,
                        message: 'Requested WebGPU backend is unavailable: requestAdapter returned no usable adapter',
                        sessionPoisoned: true,
                    },
                },
            } as any);

            expect(resetWorkerSpy).toHaveBeenCalledWith('webgpu-adapter-unavailable', true);
            expect(initSpy).toHaveBeenCalledWith(exactSettings);
            expect(failPinnedSelection).not.toHaveBeenCalled();
            expect(stopSpy).not.toHaveBeenCalled();
            expect((whisper as any).activeRunSettings).toBe(exactSettings);
        });

        it('terminates a poisoned session before checkpointing and reinitializing the exact plan', () => {
            const whisper = new Whisper();
            const exactSettings = Object.freeze({
                preset: 'small',
                model: 'onnx-community/whisper-small_timestamped',
                backend: 'webgpu',
                subtask: 'transcribe',
                language: 'japanese',
                multilingual: true,
                chunkLengthS: 29,
                strideLengthS: 5,
                cacheTranscripts: true,
                autoWarmup: false,
                maxPendingChunks: 2,
                pollIntervalMs: 250,
                workerUpdateIntervalMs: 200,
                idleUnloadMs: 600_000,
                forceWasm: false,
                preferLowPowerAdapter: false,
                minWebgpuBufferBytes: 256 * 1024 * 1024,
            });
            const worker = createMockWhisperWorker();
            const { terminate } = worker;
            const cacheSet = vi.spyOn(SharedCache, 'set');
            const init = vi.spyOn(whisper as any, 'initWorker').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'updateTranscriptIndex').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'ensureTranslatedTranscript').mockResolvedValue(undefined);
            vi.spyOn(whisper as any, 'showStatus').mockImplementation(() => {});

            (whisper as any).activeRunSettings = exactSettings;
            (whisper as any).transcribing = true;
            (whisper as any).worker = worker;
            (whisper as any).audio = { duration: 60, currentTime: 30 };
            (whisper as any).pcmDuration = 60;
            (whisper as any).segments = [{ start: 0, end: 28, text: '完成済み' }];
            (whisper as any).processedRanges = [{ start: 0, end: 28 }];
            (whisper as any).currentCacheKey = 'poison-ordering';
            (whisper as any).currentCacheIdentity = 'exact-webgpu-plan';
            (whisper as any).chunkOffsets.set(9, 30);

            signalPoisonedWorker(whisper);

            const terminateOrder = terminate.mock.invocationCallOrder[0];
            const checkpointOrder = cacheSet.mock.invocationCallOrder[0];
            const reinitOrder = init.mock.invocationCallOrder[0];
            expect(terminateOrder).toBeLessThan(checkpointOrder);
            expect(checkpointOrder).toBeLessThan(reinitOrder);
            expect(init).toHaveBeenCalledWith(exactSettings);
            expect(AppStore.state.whisper.stage).toBe('recovering');
            expect(SharedCache.get('poison-ordering')).toMatchObject({
                text: '完成済み',
                complete: false,
                sourceIdentity: 'exact-webgpu-plan',
            });
        });

        it('retries one explicit GPU device loss on the pinned plan, then stops visibly', () => {
            const { whisper, resetWorkerSpy, initSpy, stopSpy } = setupTerminalPoisonRecovery();
            vi.spyOn(whisper as any, 'persistCache').mockImplementation(() => {});
            (whisper as any).activeRunSettings = Object.freeze({
                model: 'onnx-community/whisper-tiny_timestamped',
                backend: 'webgpu',
                multilingual: true,
            });

            const loseDevice = () => (whisper as any).handleWorkerMessage({
                data: {
                    status: 'gpu-device-lost',
                    data: { message: 'GPU device lost during OrtRun' },
                },
            } as any);

            loseDevice();
            expect(initSpy).toHaveBeenCalledWith(expect.objectContaining({
                model: 'onnx-community/whisper-tiny_timestamped',
                backend: 'webgpu',
            }));
            expect(stopSpy).not.toHaveBeenCalled();

            (whisper as any).worker = { postMessage: vi.fn() };
            loseDevice();

            expect(resetWorkerSpy).toHaveBeenLastCalledWith('gpu-device-lost-terminal', true);
            expect(stopSpy).toHaveBeenCalledWith('gpu-device-lost-terminal');
            expect(initSpy).toHaveBeenCalledTimes(1);
        });

        it('stops after repeated bounded-backend inference timeouts', () => {
            const { whisper, resetWorkerSpy, initSpy, stopSpy } = setupTerminalPoisonRecovery();

            signalPoisonedWorker(whisper);
            expect(initSpy).toHaveBeenCalledTimes(1);
            expect(stopSpy).not.toHaveBeenCalled();

            // Simulate the replacement worker timing out too. A "started"
            // heartbeat must not erase consecutive timeout accounting.
            (whisper as any).worker = { postMessage: vi.fn() };
            (whisper as any).markChunkActivity();
            signalPoisonedWorker(whisper);

            expect(resetWorkerSpy).toHaveBeenLastCalledWith('inference-timeout-terminal', true);
            expect(stopSpy).toHaveBeenCalledWith('inference-timeout-terminal');
            expect(initSpy).toHaveBeenCalledTimes(1);
            expect((whisper as any).transcribing).toBe(false);
            expect(AppStore.state.whisper.stage).toBe('error');
        });

        it('ignores a stale chunk-scoped ready lifecycle after a seek flush', () => {
            const whisper = new Whisper();
            (whisper as any).transcribing = true;
            (whisper as any).modelReady = false;

            (whisper as any).handleWorkerMessage({
                data: {
                    status: 'ready',
                    model: 'onnx-community/whisper-tiny_timestamped',
                    backend: 'wasm',
                    dtype: 'q8',
                    chunkId: 77,
                },
            } as any);

            expect((whisper as any).loadedPlan).toBeNull();
            expect((whisper as any).modelReady).toBe(false);
        });

        it('rejects an unknown backend label during worker initiation', () => {
            const whisper = new Whisper();
            const failSpy = vi.spyOn(whisper as any, 'failPinnedSelection').mockImplementation(() => {});
            (whisper as any).loadedPlan = Object.freeze({
                model: 'onnx-community/whisper-tiny_timestamped',
                backend: 'webgpu',
                multilingual: true,
            });

            (whisper as any).handleWorkerMessage({
                data: {
                    status: 'initiate',
                    model: 'onnx-community/whisper-tiny_timestamped',
                    backend: 'cuda',
                },
            } as any);

            expect(failSpy).toHaveBeenCalledWith(
                expect.stringContaining('cuda backend'),
                'worker-init-selection-mismatch',
            );
            expect((whisper as any).loadedPlan.backend).toBe('webgpu');
        });

        it('rejects a ready event for a model or backend other than the pinned plan', () => {
            const whisper = new Whisper();
            const failSpy = vi.spyOn(whisper as any, 'failPinnedSelection').mockImplementation(() => {});
            (whisper as any).loadedPlan = Object.freeze({
                model: 'onnx-community/whisper-base_timestamped',
                backend: 'webgpu',
                multilingual: true,
            });

            (whisper as any).handleWorkerMessage({
                data: {
                    status: 'ready',
                    model: 'onnx-community/whisper-tiny_timestamped',
                    backend: 'wasm',
                    dtype: 'q8',
                },
            } as any);

            expect(failSpy).toHaveBeenCalledWith(
                expect.stringContaining('onnx-community/whisper-tiny_timestamped / wasm'),
                'worker-ready-selection-mismatch',
            );
            expect((whisper as any).modelReady).toBe(false);
        });

        it('surfaces a non-timeout GPU error without changing the pinned plan', () => {
            const whisper = new Whisper();
            const resetSpy = stubWorkerReset(whisper);
            (whisper as any).loadedPlan = pinnedSmallWebGpuPlan;

            (whisper as any).transcribing = false;
            (whisper as any).pendingChunks = 1;
            (whisper as any).chunkSendTimes.set(7, performance.now());
            (whisper as any).chunkGenerations.set(7, (whisper as any).transcriptionGeneration);
            (whisper as any).chunkOffsets.set(7, 24);
            (whisper as any).chunkLastActivity.set(7, performance.now());

            (whisper as any).handleWorkerMessage({
                data: {
                    status: 'error',
                    data: { message: 'createBuffer failed', gpuFailure: true },
                    chunkId: 7,
                },
            } as any);

            expect(resetSpy).toHaveBeenCalledWith('worker-message-error', true);
            expect((whisper as any).loadedPlan.model).toBe('onnx-community/whisper-small_timestamped');
            expect((whisper as any).loadedPlan.backend).toBe('webgpu');
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

        function setupProgressiveWhisper(pcmDuration: number) {
            const whisper = new Whisper();
            vi.spyOn(whisper as any, 'getWhisperSettings').mockReturnValue({ language: 'japanese' });
            vi.spyOn(whisper as any, 'updateTranscribingProgress').mockImplementation(() => {});
            const emit = vi.spyOn(EventBus, 'emit');
            (whisper as any).pcmDuration = pcmDuration;
            return { whisper, emit };
        }

        function completeChunk(chunkId: number, data: Record<string, unknown>) {
            return {
                data: {
                    status: 'complete',
                    chunkId,
                    data,
                },
            };
        }

        function stubFinalChunkPipeline(whisper: Whisper) {
            vi.spyOn(whisper as any, 'logNewTranscriptSegments').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'translateAhead').mockResolvedValue(undefined);
            vi.spyOn(whisper as any, 'maybeFinalizeTranscript').mockImplementation(() => {});
            return vi.spyOn(whisper as any, 'queueCacheCheckpoint').mockImplementation(() => {});
        }

        function setupRuntimeProgress(input: {
            duration: number;
            playback: number;
            pcmDuration: number;
            processedRanges: Array<{ start: number; end: number }>;
            progressOrigin?: number;
            pendingChunks?: number;
            timingQuality?: 'word' | 'segment';
            throughputRatio?: number;
        }): Whisper {
            const whisper = new Whisper();
            (whisper as any).transcribing = true;
            (whisper as any).audio = {
                duration: input.duration,
                currentTime: input.playback,
            };
            (whisper as any).pcmDuration = input.pcmDuration;
            (whisper as any).processedRanges = input.processedRanges;
            (whisper as any).coverageOrigin = 0;
            (whisper as any).runtimeProgressOrigin = input.progressOrigin || 0;
            (whisper as any).pendingChunks = input.pendingChunks || 0;
            (whisper as any).timingQuality = input.timingQuality || null;
            (whisper as any).throughputRatio = input.throughputRatio ?? null;
            (whisper as any).activeRunSettings = Object.freeze({
                model: 'onnx-community/whisper-tiny_timestamped',
                backend: 'webgpu',
                chunkLengthS: 6,
            });
            vi.spyOn(whisper as any, 'showStatus').mockImplementation(() => {});
            return whisper;
        }

        it('refreshes visible progress for started and empty decoding heartbeats', () => {
            const whisper = new Whisper();
            let now = 1_000;
            vi.spyOn(Date, 'now').mockImplementation(() => now);
            vi.spyOn(whisper as any, 'showStatus').mockImplementation(() => {});
            const emit = vi.spyOn(EventBus, 'emit');
            (whisper as any).audio = { duration: 60, currentTime: 12 };
            (whisper as any).processedRanges = [{ start: 0, end: 6 }];
            (whisper as any).pcmDuration = 12;
            (whisper as any).activeRunSettings = Object.freeze({
                model: 'onnx-community/whisper-tiny_timestamped',
                backend: 'webgpu',
                chunkLengthS: 6,
            });
            ownChunk(whisper, 3, 0, 6);

            (whisper as any).handleWorkerMessage({
                data: { status: 'started', chunkId: 3, data: { queueDepth: 0 } },
            });
            expect(AppStore.state.whisper.playbackSeconds).toBe(12);

            now = 1_500;
            (whisper as any).audio.currentTime = 18;
            (whisper as any).handleWorkerMessage({
                data: {
                    status: 'heartbeat',
                    chunkId: 3,
                    data: { phase: 'decoding', partialText: '' },
                },
            });

            expect(AppStore.state.whisper).toMatchObject({
                stage: 'behind',
                playbackSeconds: 18,
                processedSeconds: 6,
                backlogSeconds: 12,
                pendingChunks: 1,
            });
            expect(emit).toHaveBeenCalledWith(
                'whisper:progress',
                expect.objectContaining({ playbackSeconds: 18, processedSeconds: 6 }),
            );
        });

        it('measures effective per-chunk throughput from active inference time', () => {
            const whisper = new Whisper();
            vi.spyOn(performance, 'now').mockReturnValue(11_000);

            (whisper as any).recordChunkThroughput(1_000, 6);

            expect((whisper as any).throughputRatio).toBeCloseTo(0.6);
        });

        it('reports processed timeline, playback backlog, queue, model, and backend truthfully', () => {
            const whisper = setupRuntimeProgress({
                duration: 100,
                playback: 50,
                pcmDuration: 55,
                processedRanges: [{ start: 0, end: 20 }],
                pendingChunks: 1,
                timingQuality: 'segment',
            });

            (whisper as any).updateTranscribingProgress();

            expect(AppStore.state.whisper).toMatchObject({
                stage: 'behind',
                model: 'whisper-tiny_timestamped',
                backend: 'webgpu',
                processedSeconds: 20,
                totalSeconds: 100,
                playbackSeconds: 50,
                backlogSeconds: 30,
                pendingChunks: 1,
                timingQuality: 'segment',
                progress: 20,
            });
            expect(AppStore.state.whisper.progressMessage).toContain('whisper-tiny_timestamped');
            expect(AppStore.state.whisper.progressMessage).toContain('WEBGPU');
            expect(AppStore.state.whisper.progressMessage).toMatch(/^30s behind/);
        });

        it('counts discontiguous analyzed ranges without presenting the furthest cursor as work done', () => {
            const whisper = setupRuntimeProgress({
                duration: 100,
                playback: 100,
                pcmDuration: 100,
                processedRanges: [
                    { start: 0, end: 20 },
                    { start: 70, end: 80 },
                ],
            });

            (whisper as any).updateTranscribingProgress();

            expect(AppStore.state.whisper).toMatchObject({
                processedSeconds: 30,
                processedThroughSeconds: 80,
                backlogSeconds: 80,
                progress: 30,
            });
            expect(AppStore.state.whisper.progressMessage).toContain('30s analyzed');
            expect(AppStore.state.whisper.progressMessage).toContain('playhead 100/100s');
        });

        it('measures random-seek lag from the current playhead window without changing durable coverage', () => {
            const whisper = setupRuntimeProgress({
                duration: 400,
                playback: 378,
                pcmDuration: 400,
                progressOrigin: 363,
                processedRanges: [
                    { start: 0, end: 48 },
                    { start: 363, end: 371 },
                ],
                pendingChunks: 1,
                throughputRatio: 0.72,
            });

            (whisper as any).updateTranscribingProgress();

            expect(AppStore.state.whisper).toMatchObject({
                processedSeconds: 56,
                processedThroughSeconds: 371,
                playbackSeconds: 378,
                backlogSeconds: 7,
                pendingChunks: 1,
            });
            expect(AppStore.state.whisper.progressMessage).toMatch(/^7s behind/);
            expect(AppStore.state.whisper.progressMessage).toContain('0.7× realtime now');
            expect(AppStore.state.whisper.progressMessage).toContain('playhead 378/400s');
            // The playhead-only anchor is not durable: whole-track continuation
            // must still resume at the untouched 48-second prefix boundary.
            expect((whisper as any).coverageOrigin).toBe(0);
        });

        it('publishes natural completion exactly once and leaves no active processing loop', () => {
            const whisper = new Whisper();
            const emit = vi.spyOn(EventBus, 'emit');
            vi.spyOn(whisper as any, 'flushCacheCheckpoint').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'logNewTranscriptSegments').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'showStatus').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'scheduleIdleUnload').mockImplementation(() => {});
            (whisper as any).transcribing = true;
            (whisper as any).finalizeOnIdle = true;
            (whisper as any).pendingChunks = 0;
            const audio = document.createElement('audio');
            Object.defineProperty(audio, 'duration', { value: 10, configurable: true });
            audio.currentTime = 10;
            (whisper as any).audio = audio;
            (whisper as any).pcmDuration = 10;
            (whisper as any).segments = [{ start: 0, end: 10, text: '完了' }];
            (whisper as any).processedRanges = [{ start: 0, end: 10 }];
            (whisper as any).processingLoopId = window.setInterval(() => {}, 1_000);

            (whisper as any).maybeFinalizeTranscript();
            (whisper as any).maybeFinalizeTranscript();

            expect(emit.mock.calls.filter(([event]) => event === 'whisper:complete')).toHaveLength(1);
            expect((whisper as any).processingLoopId).toBeNull();
            expect((whisper as any).transcribing).toBe(false);
            expect(AppStore.state.whisper.stage).toBe('complete');
        });

        it('finishes an incomplete mid-track run as partial without emitting completion', () => {
            const whisper = new Whisper();
            const emit = vi.spyOn(EventBus, 'emit');
            const flush = vi.spyOn(whisper as any, 'flushCacheCheckpoint').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'logNewTranscriptSegments').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'showStatus').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'scheduleIdleUnload').mockImplementation(() => {});
            (whisper as any).transcribing = true;
            (whisper as any).finalizeOnIdle = true;
            (whisper as any).pendingChunks = 0;
            const audio = document.createElement('audio');
            Object.defineProperty(audio, 'duration', { value: 130, configurable: true });
            audio.currentTime = 130;
            (whisper as any).audio = audio;
            (whisper as any).pcmDuration = 130;
            (whisper as any).segments = [{ start: 120, end: 130, text: '途中から' }];
            (whisper as any).processedRanges = [{ start: 120, end: 130 }];
            (whisper as any).coverageOrigin = 120;

            (whisper as any).maybeFinalizeTranscript();

            expect(emit.mock.calls.filter(([event]) => event === 'whisper:complete')).toHaveLength(0);
            expect(flush).toHaveBeenCalledWith(false);
            expect(AppStore.state.whisper).toMatchObject({
                stage: 'partial',
                processedSeconds: 10,
                processedThroughSeconds: 130,
                totalSeconds: 130,
                backlogSeconds: 120,
            });
            expect(AppStore.state.whisper.progress).toBeLessThan(100);
        });

        it('emits finalized history plus a safe non-persisted provisional segment', () => {
            const { whisper, emit } = setupProgressiveWhisper(25);
            (whisper as any).segments = [{ start: 0, end: 12, text: '確定済み' }];
            (whisper as any).lastSegmentEnd = 12;
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
            const { whisper, emit } = setupProgressiveWhisper(20);
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
            const { whisper, emit } = setupProgressiveWhisper(20);
            const persist = stubFinalChunkPipeline(whisper);
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

            (whisper as any).handleWorkerMessage(completeChunk(6, {
                text: '確定テキスト',
                rawChunks: [{ text: '確定テキスト', timestamp: [10, 14] }],
                inputRms: 0.01,
            }));

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

        it('does not emit or cache the exact Firefox silence hallucination on completion', () => {
            const { whisper, emit } = setupProgressiveWhisper(2);
            const persist = stubFinalChunkPipeline(whisper);
            ownChunk(whisper, 7, 0, 2);

            (whisper as any).handleWorkerMessage(completeChunk(7, {
                text: 'ご視聴ありがとうございました',
                rawChunks: [{ text: 'ご視聴ありがとうございました', timestamp: [0, 2] }],
                inputRms: 0,
            }));

            const update = findWhisperUpdate(emit, 'complete');
            expect(update).toMatchObject({ text: '', segments: [], source: 'complete' });
            expect((whisper as any).segments).toEqual([]);
            expect((whisper as any).processedRanges).toEqual([{ start: 0, end: 2 }]);
            expect(persist).toHaveBeenCalledOnce();
        });

        it('retries a speech-level filtered window with wider neighbouring context', () => {
            const { whisper } = setupProgressiveWhisper(24);
            stubFinalChunkPipeline(whisper);
            ownChunk(whisper, 70, 0, 24);
            (whisper as any).transcribedUpTo = 24;

            (whisper as any).handleWorkerMessage(completeChunk(70, {
                text: 'ご視聴ありがとうございました',
                rawChunks: [{ text: 'ご視聴ありがとうございました', timestamp: [0, 24] }],
                // ~-45 dBFS: a quiet ASMR whisper, well above room tone.
                inputRms: 0.006,
            }));

            expect((whisper as any).segments).toEqual([]);
            expect((whisper as any).processedRanges).toEqual([{ start: 0, end: 12 }]);
            expect((whisper as any).transcribedUpTo).toBe(12);
        });

        it('does not re-examine an ambience-level window, which would halve throughput', () => {
            const { whisper } = setupProgressiveWhisper(24);
            stubFinalChunkPipeline(whisper);
            ownChunk(whisper, 71, 0, 24);
            (whisper as any).transcribedUpTo = 24;

            (whisper as any).handleWorkerMessage(completeChunk(71, {
                text: 'ご視聴ありがとうございました',
                rawChunks: [{ text: 'ご視聴ありがとうございました', timestamp: [0, 24] }],
                // ~-86 dBFS: below any plausible speech, so the window is final.
                inputRms: 0.00005,
            }));

            expect((whisper as any).processedRanges).toEqual([{ start: 0, end: 24 }]);
            expect((whisper as any).transcribedUpTo).toBe(24);
        });

        it('retries a quiet region at most once so it cannot loop', () => {
            const { whisper } = setupProgressiveWhisper(24);
            stubFinalChunkPipeline(whisper);
            ownChunk(whisper, 72, 0, 24);
            (whisper as any).transcribedUpTo = 24;

            const quiet = () => completeChunk(72, {
                text: 'ご視聴ありがとうございました',
                rawChunks: [{ text: 'ご視聴ありがとうございました', timestamp: [0, 24] }],
                inputRms: 0.006,
            });

            (whisper as any).handleWorkerMessage(quiet());
            expect((whisper as any).transcribedUpTo).toBe(12);

            ownChunk(whisper, 72, 0, 24);
            (whisper as any).transcribedUpTo = 24;
            (whisper as any).handleWorkerMessage(quiet());

            // Second pass over the same offset is credited in full.
            expect((whisper as any).transcribedUpTo).toBe(24);
        });

        it('does not re-examine a quiet window while already behind the playhead', () => {
            const { whisper } = setupProgressiveWhisper(24);
            stubFinalChunkPipeline(whisper);
            ownChunk(whisper, 73, 0, 24);
            (whisper as any).transcribedUpTo = 24;
            (whisper as any).lastBacklogSeconds = 45;

            (whisper as any).handleWorkerMessage(completeChunk(73, {
                text: 'ご視聴ありがとうございました',
                rawChunks: [{ text: 'ご視聴ありがとうございました', timestamp: [0, 24] }],
                inputRms: 0.006,
            }));

            expect((whisper as any).transcribedUpTo).toBe(24);
        });

        it('strips complete and split timestamp tokens from provisional heartbeat text', () => {
            const { whisper, emit } = setupProgressiveWhisper(10);
            ownChunk(whisper, 81, 0, 5);

            (whisper as any).handleWorkerMessage({
                data: {
                    status: 'heartbeat',
                    chunkId: 81,
                    data: { phase: 'decoding', partialText: '<|0.00|>ちょっとだけ<|2.00|>' },
                },
            });
            (whisper as any).handleWorkerMessage({
                data: {
                    status: 'heartbeat',
                    chunkId: 81,
                    data: { phase: 'decoding', partialText: '00|>そうだが当' },
                },
            });
            (whisper as any).handleWorkerMessage({
                data: {
                    status: 'heartbeat',
                    chunkId: 81,
                    data: { phase: 'decoding', partialText: '<|4.00|>' },
                },
            });

            const updates = emit.mock.calls
                .filter(([event]) => event === 'whisper:update')
                .map(([, payload]) => payload as any);
            expect(updates.map(payload => payload.text)).toEqual([
                'ちょっとだけ',
                'そうだが当',
            ]);
            expect(updates.flatMap(payload => payload.segments).every(
                (segment: { text: string }) => !segment.text.includes('|>'),
            )).toBe(true);
        });

        it('retains a valid full-text fallback when the worker returns no timestamp chunks', () => {
            const { whisper, emit } = setupProgressiveWhisper(2);
            vi.spyOn(whisper as any, 'logNewTranscriptSegments').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'maybeFinalizeTranscript').mockImplementation(() => {});
            ownChunk(whisper, 8, 0, 2);

            (whisper as any).handleWorkerMessage(completeChunk(8, {
                text: '<|0.00|>聞こえています<|2.00|>',
                rawChunks: [],
                inputRms: 0.01,
            }));

            const update = findWhisperUpdate(emit, 'complete');
            expect(update).toMatchObject({ text: '聞こえています', segments: [], source: 'complete' });
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

        it('rewinds into a real processed-coverage gap instead of trusting subtitle bounds', () => {
            vi.useFakeTimers();
            try {
                const whisper = new Whisper();
                const audio = document.createElement('audio');
                audio.currentTime = 35;
                const worker = { postMessage: vi.fn() };
                (whisper as any).audio = audio;
                (whisper as any).worker = worker;
                (whisper as any).transcribing = true;
                (whisper as any).transcribedUpTo = 80;
                (whisper as any).processedRanges = [
                    { start: 0, end: 20 },
                    { start: 70, end: 80 },
                ];
                (whisper as any).segments = [
                    { start: 2, end: 18, text: '前半' },
                    { start: 72, end: 78, text: '後半' },
                ];
                (whisper as any).lastSegmentEnd = 78;
                vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
                vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
                vi.spyOn(whisper as any, 'maybeProcessNextChunk').mockImplementation(() => {});

                (whisper as any).handleSeek();
                vi.advanceTimersByTime(101);

                expect((whisper as any).transcribedUpTo).toBe(20);
                expect(worker.postMessage).toHaveBeenCalledWith({ type: 'flush-queue' });
            } finally {
                vi.useRealTimers();
            }
        });

        it('coalesces random scrubbing onto the final destination without changing the pinned plan', () => {
            vi.useFakeTimers();
            try {
                const whisper = new Whisper();
                const audio = document.createElement('audio');
                const worker = { postMessage: vi.fn() };
                const settings = createCompatibilityWhisperSettings({
                    model: 'onnx-community/whisper-base',
                    backend: 'webgpu',
                    forceWasm: false,
                });
                const loadedPlan = Object.freeze({
                    model: settings.model,
                    backend: 'webgpu' as const,
                    multilingual: settings.multilingual,
                });
                (whisper as any).audio = audio;
                (whisper as any).worker = worker;
                (whisper as any).transcribing = true;
                (whisper as any).modelReady = true;
                (whisper as any).activeRunSettings = Object.freeze(settings);
                (whisper as any).loadedPlan = loadedPlan;
                (whisper as any).pcmBuffer = new Float32Array(1);
                (whisper as any).pcmDuration = 300;
                (whisper as any).transcribedUpTo = 140;
                (whisper as any).processedRanges = [{ start: 0, end: 120 }];
                (whisper as any).pendingChunks = 2;
                (whisper as any).chunkSendTimes.set(70, performance.now());
                (whisper as any).chunkSendTimes.set(71, performance.now());
                (whisper as any).chunkGenerations.set(70, (whisper as any).transcriptionGeneration);
                (whisper as any).chunkGenerations.set(71, (whisper as any).transcriptionGeneration);
                (whisper as any).chunkOffsets.set(70, 120);
                (whisper as any).chunkOffsets.set(71, 126);
                const processSpy = vi.spyOn(whisper as any, 'maybeProcessNextChunk').mockImplementation(() => {});
                const mergeSpy = vi.spyOn(whisper as any, 'mergeSegments');
                vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
                vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

                audio.currentTime = 210;
                (whisper as any).handleSeek();
                expect((whisper as any).seekInProgress).toBe(true);
                expect((whisper as any).pendingChunks).toBe(0);
                expect(worker.postMessage).toHaveBeenCalledTimes(1);
                expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'flush-queue' });

                // The old active inference cannot be cancelled in ORT, but its
                // late completion no longer belongs to controller state.
                (whisper as any).handleWorkerMessage({
                    data: {
                        status: 'complete',
                        chunkId: 70,
                        data: {
                            text: '古い再生位置',
                            rawChunks: [{ text: '古い再生位置', timestamp: [120, 122] }],
                        },
                    },
                });
                expect(mergeSpy).not.toHaveBeenCalled();

                vi.advanceTimersByTime(30);
                audio.currentTime = 40;
                (whisper as any).handleSeek();
                vi.advanceTimersByTime(30);
                audio.currentTime = 240;
                (whisper as any).handleSeek();

                // Repeated intermediate positions neither flush repeatedly nor
                // admit work until the final debounce settles.
                expect(worker.postMessage).toHaveBeenCalledTimes(1);
                vi.advanceTimersByTime(99);
                expect(processSpy).not.toHaveBeenCalled();

                vi.advanceTimersByTime(1);
                expect((whisper as any).seekInProgress).toBe(false);
                expect((whisper as any).transcribedUpTo).toBe(225);
                expect((whisper as any).runtimeProgressOrigin).toBe(225);
                expect(processSpy).toHaveBeenCalledTimes(1);
                expect((whisper as any).loadedPlan).toBe(loadedPlan);
                expect((whisper as any).activeRunSettings.model).toBe(settings.model);
                expect((whisper as any).activeRunSettings.backend).toBe('webgpu');
            } finally {
                vi.useRealTimers();
            }
        });

        it('does not present a previous cue as current after scrubbing into a timeline gap', () => {
            const whisper = new Whisper();
            const audio = document.createElement('audio');
            audio.currentTime = 90;
            (whisper as any).audio = audio;
            (whisper as any).transcribing = true;
            (whisper as any).segments = [
                { start: 10, end: 14, text: '前の位置の字幕' },
            ];
            const emit = vi.spyOn(EventBus, 'emit');

            (whisper as any).emitWhisperSnapshot('seek');

            expect(findWhisperUpdate(emit, 'seek')).toMatchObject({
                text: '',
                segments: [{ start: 10, end: 14, text: '前の位置の字幕' }],
            });
        });

        it('commits the final scrub position before a bfcache freeze and resumes the exact plan', () => {
            vi.useFakeTimers();
            const whisper = new Whisper();
            const worker = createMockWhisperWorker();
            const audio = document.createElement('audio');
            const settings = createCompatibilityWhisperSettings({
                model: 'onnx-community/whisper-base',
                backend: 'webgpu',
                forceWasm: false,
            });
            vi.spyOn(whisper as any, 'getExecutionSettings').mockReturnValue(settings);
            const initWorker = vi.spyOn(whisper as any, 'initWorker').mockImplementation(() => {});
            vi.spyOn(whisper as any, 'flushCacheCheckpoint').mockImplementation(() => {});
            vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
            vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
            (whisper as any).enabled = true;
            (whisper as any).transcribing = true;
            (whisper as any).audio = audio;
            (whisper as any).worker = worker;
            (whisper as any).loadedPlan = Object.freeze({
                model: settings.model,
                backend: 'webgpu' as const,
                multilingual: settings.multilingual,
            });
            (whisper as any).pcmBuffer = new Float32Array(1);
            (whisper as any).pcmDuration = 180;
            (whisper as any).processedRanges = [{ start: 0, end: 30 }];
            (whisper as any).transcribedUpTo = 60;
            (whisper as any).setupEventListeners();

            try {
                audio.currentTime = 90;
                (whisper as any).handleSeek();
                window.dispatchEvent(new Event('pagehide'));

                expect((whisper as any).seekInProgress).toBe(false);
                expect((whisper as any).transcribedUpTo).toBe(75);
                expect(worker.terminate).toHaveBeenCalledTimes(1);

                const pageShow = new Event('pageshow');
                Object.defineProperty(pageShow, 'persisted', { value: true });
                window.dispatchEvent(pageShow);
                expect(initWorker).toHaveBeenCalledWith(settings);
                expect((whisper as any).transcribedUpTo).toBe(75);
            } finally {
                (whisper as any).eventCleanups.splice(0).forEach((cleanup: () => void) => cleanup());
                vi.useRealTimers();
            }
        });
    });

    describe('chunk stall watchdog', () => {
        const settings = {
            preset: 'small',
            model: 'onnx-community/whisper-small_timestamped',
            backend: 'webgpu',
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

        function setupReadyChunkPipeline(pendingChunks: number) {
            const whisper = new Whisper();
            const sendChunk = vi.spyOn(whisper as any, 'sendChunk').mockImplementation(() => {});
            vi.spyOn((whisper as any).bridge, 'currentTrack', 'get').mockReturnValue(null);

            const audio = document.createElement('audio');
            audio.currentTime = 0;
            (whisper as any).audio = audio;
            (whisper as any).transcribing = true;
            (whisper as any).modelReady = true;
            (whisper as any).hasWorkerChunkActivity = false;
            (whisper as any).pendingChunks = pendingChunks;
            (whisper as any).pcmBuffer = new Float32Array(16_000 * 120);
            (whisper as any).pcmDuration = 120;
            (whisper as any).transcribedUpTo = 0;

            return { whisper, sendChunk };
        }

        it.each([
            ['webgpu', 'onnx-community/whisper-medium_timestamped'],
            ['webgpu', 'onnx-community/whisper-large-v3-turbo_timestamped'],
            ['wasm', 'onnx-community/whisper-medium_timestamped'],
            ['wasm', 'onnx-community/whisper-large-v3-turbo_timestamped'],
        ] as const)('waits beyond the exact 29s %s worker timeout for pinned %s', (backend, model) => {
            const whisper = new Whisper();
            const pinnedSettings = { ...settings, backend, model };
            const workerTimeout = getWhisperInferenceTimeoutMs(
                backend,
                29,
                backend === 'webgpu',
                model,
            );
            const watchdogTimeout = (whisper as any).getChunkStallTimeoutMs(pinnedSettings);

            expect(watchdogTimeout).toBe(workerTimeout + WHISPER_STALL_WATCHDOG_MARGIN_MS);
            expect(watchdogTimeout).toBeGreaterThan(workerTimeout);
        });

        it('uses the cold WebGPU watchdog only until the first inference completes', () => {
            const whisper = new Whisper();
            const coldTimeout = (whisper as any).getChunkStallTimeoutMs(settings);

            expect(coldTimeout).toBe(
                getWhisperInferenceTimeoutMs('webgpu', 29, true, settings.model)
                + WHISPER_STALL_WATCHDOG_MARGIN_MS,
            );

            (whisper as any).workerHasCompletedInference = true;
            const warmTimeout = (whisper as any).getChunkStallTimeoutMs(settings);

            expect(warmTimeout).toBe(
                getWhisperInferenceTimeoutMs('webgpu', 29, false, settings.model)
                + WHISPER_STALL_WATCHDOG_MARGIN_MS,
            );
            expect(warmTimeout).toBeLessThan(coldTimeout);
        });

        it('lengthens the controller watchdog from completed direct inference', () => {
            const whisper = new Whisper();
            const baseSettings = {
                ...settings,
                model: 'onnx-community/whisper-base_timestamped',
                chunkLengthS: 8,
                strideLengthS: 2,
            };
            (whisper as any).workerHasCompletedInference = true;
            const baseTimeout = (whisper as any).getChunkStallTimeoutMs(baseSettings);

            (whisper as any).recordInferenceDuration(100_000);
            const observedTimeout = (whisper as any).getChunkStallTimeoutMs(baseSettings);

            expect(baseTimeout).toBe(120_000 + WHISPER_STALL_WATCHDOG_MARGIN_MS);
            expect(observedTimeout).toBe(150_000 + WHISPER_STALL_WATCHDOG_MARGIN_MS);
        });

        it('uses each adaptive in-flight window length instead of the foreground timeout', () => {
            const whisper = new Whisper();
            const recoverSpy = vi.spyOn(whisper as any, 'recoverFromStalledChunks').mockImplementation(() => {});
            let now = 150_000;
            vi.spyOn(performance, 'now').mockImplementation(() => now);

            (whisper as any).transcribing = true;
            (whisper as any).pendingChunks = 1;
            (whisper as any).workerHasCompletedInference = true;
            (whisper as any).chunkStartedAt.set(12, 0);
            (whisper as any).chunkLastActivity.set(12, 0);
            (whisper as any).chunkWindowLengths.set(12, 29);
            const foregroundSettings = { ...settings, chunkLengthS: 8 };

            expect((whisper as any).getChunkStallTimeoutMs(foregroundSettings, 12)).toBe(
                getWhisperInferenceTimeoutMs('webgpu', 29, false, settings.model)
                + WHISPER_STALL_WATCHDOG_MARGIN_MS,
            );
            (whisper as any).checkForStalledChunks(foregroundSettings);
            expect(recoverSpy).not.toHaveBeenCalled();

            now = 197_000;
            (whisper as any).checkForStalledChunks(foregroundSettings);
            expect(recoverSpy).toHaveBeenCalledWith(foregroundSettings, 12, 197_000);
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
            (whisper as any).workerQueueSaturated = true;
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
            expect((whisper as any).workerQueueSaturated).toBe(false);
        });

        it('rewinds a queue-full range but waits for a worker capacity signal', () => {
            const whisper = new Whisper();
            vi.spyOn(whisper as any, 'reportLiveLag').mockImplementation(() => {});
            const processNext = vi.spyOn(whisper as any, 'maybeProcessNextChunk').mockImplementation(() => {});
            (whisper as any).transcribing = true;
            (whisper as any).pendingChunks = 1;
            (whisper as any).transcribedUpTo = 40;
            (whisper as any).lastSegmentEnd = 78;
            (whisper as any).processedRanges = [
                { start: 0, end: 20 },
                { start: 70, end: 80 },
            ];
            (whisper as any).chunkSendTimes.set(10, performance.now());
            (whisper as any).chunkGenerations.set(10, (whisper as any).transcriptionGeneration);
            (whisper as any).chunkOffsets.set(10, 18);
            (whisper as any).chunkAdvances.set(10, 15);

            (whisper as any).handleWorkerMessage({
                data: { status: 'dropped', chunkId: 10, data: { reason: 'queue-full' } },
            });

            expect((whisper as any).pendingChunks).toBe(0);
            expect((whisper as any).transcribedUpTo).toBe(18);
            expect((whisper as any).chunkSendTimes.has(10)).toBe(false);
            expect((whisper as any).workerQueueSaturated).toBe(true);
            expect(processNext).not.toHaveBeenCalled();
        });

        it('rewinds an intentionally superseded range without marking it unavailable', () => {
            const whisper = new Whisper();
            const lagSpy = vi.spyOn(whisper as any, 'reportLiveLag').mockImplementation(() => {});
            const processNext = vi.spyOn(whisper as any, 'maybeProcessNextChunk').mockImplementation(() => {});
            (whisper as any).transcribing = true;
            (whisper as any).pendingChunks = 2;
            (whisper as any).pcmDuration = 100;
            (whisper as any).transcribedUpTo = 40;
            (whisper as any).chunkSendTimes.set(10, performance.now());
            (whisper as any).chunkGenerations.set(10, (whisper as any).transcriptionGeneration);
            (whisper as any).chunkOffsets.set(10, 18);
            (whisper as any).chunkAdvances.set(10, 15);

            (whisper as any).handleWorkerMessage({
                data: { status: 'dropped', chunkId: 10, data: { reason: 'queue-replaced' } },
            });

            expect((whisper as any).transcribedUpTo).toBe(18);
            expect((whisper as any).unavailableRanges).toEqual([]);
            expect((whisper as any).droppedBufferSeconds).toBe(0);
            expect((whisper as any).pendingChunks).toBe(1);
            expect((whisper as any).workerQueueSaturated).toBe(true);
            expect(lagSpy).toHaveBeenCalledWith('queue-replaced');
            expect(processNext).not.toHaveBeenCalled();
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
                data: { status: 'dropped', chunkId: 10, data: { reason: 'queue-full' } },
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
            (whisper as any).lastSegmentEnd = 110;
            (whisper as any).processedRanges = [
                { start: 0, end: 70 },
                { start: 100, end: 110 },
            ];
            (whisper as any).modelReady = true;
            (whisper as any).lastChunkStallRecoveryAt = -1_000_000;

            (whisper as any).recoverFromStalledChunks(settings, 1, 150_000);

            expect(resetSpy).toHaveBeenCalledWith('chunk-stall-timeout', true);
            expect(initSpy).toHaveBeenCalledWith(settings);
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
            const { whisper, sendChunk } = setupReadyChunkPipeline(1);

            (whisper as any).maybeProcessNextChunk();

            expect(sendChunk).not.toHaveBeenCalled();
        });

        it('uses the configured authoritative context before first worker activity', () => {
            const { whisper, sendChunk } = setupReadyChunkPipeline(0);

            (whisper as any).maybeProcessNextChunk();

            expect(sendChunk).toHaveBeenCalledTimes(1);
            expect(sendChunk.mock.calls[0]?.[4]).toBe(29);
        });

        it('preserves every oldest missing live window across repeated slow worker cycles', async () => {
            vi.useFakeTimers();
            try {
                const whisper = new Whisper();
                const settings = createCompatibilityWhisperSettings({
                    backend: 'webgpu',
                    forceWasm: false,
                    chunkLengthS: 8,
                    strideLengthS: 2,
                    // Deliberately higher than the worker's actual active + queued
                    // capacity. The controller must still never admit a third.
                    maxPendingChunks: 3,
                });
                vi.spyOn(whisper as any, 'getExecutionSettings').mockReturnValue(settings);
                vi.spyOn((whisper as any).bridge, 'currentTrack', 'get').mockReturnValue(null);

                let receiveWorkerMessage: ((event: { data: any }) => void) | null = null;
                const hostEvents: any[] = [];
                const workerEvents: any[] = [];
                const workerSelf: any = {
                    addEventListener: (type: string, handler: (event: { data: any }) => void) => {
                        if (type === 'message') receiveWorkerMessage = handler;
                    },
                    postMessage: (message: any) => {
                        workerEvents.push(message);
                        hostEvents.push(message);
                    },
                };
                const activeInferences: Array<{
                    message: any;
                    resolve: (value: any) => void;
                }> = [];
                workerSelf.__whisperTestTranscribe = vi.fn((message: any) => {
                    workerSelf.postMessage({ status: 'started', chunkId: message.chunkId });
                    return new Promise<any>((resolve) => {
                        activeInferences.push({ message, resolve });
                    });
                });
                new Function('self', __getWhisperWorkerCodeForTests(true))(workerSelf);

                const hostPosts: any[] = [];
                (whisper as any).worker = {
                    postMessage: (message: any) => {
                        hostPosts.push(message);
                        receiveWorkerMessage!({ data: message });
                    },
                };
                const audio = document.createElement('audio');
                audio.currentTime = 60;
                (whisper as any).audio = audio;
                (whisper as any).transcribing = true;
                (whisper as any).modelReady = true;
                (whisper as any).liveCaptureActive = true;
                (whisper as any).pcmBuffer = new Float32Array(60 * 16_000);
                (whisper as any).pcmDuration = 60;
                (whisper as any).pcmSampleLength = 60 * 16_000;
                (whisper as any).transcribedUpTo = 0;

                const flushHostEvents = () => {
                    while (hostEvents.length > 0) {
                        (whisper as any).handleWorkerMessage({ data: hostEvents.shift() });
                    }
                };
                const pollRepeatedly = async () => {
                    for (let poll = 0; poll < 4; poll += 1) {
                        await vi.advanceTimersByTimeAsync(250);
                        (whisper as any).maybeProcessNextChunk();
                        flushHostEvents();
                    }
                };
                const completeActiveInference = async () => {
                    const active = activeInferences.shift();
                    expect(active).toBeDefined();
                    active!.resolve({
                        text: '',
                        rawChunks: [],
                        inputRms: 0,
                        wordTimestamps: false,
                    });
                    await Promise.resolve();
                    await Promise.resolve();
                    flushHostEvents();
                    await pollRepeatedly();
                };

                (whisper as any).maybeProcessNextChunk();
                flushHostEvents();
                await pollRepeatedly();
                expect(hostPosts.filter(message => message.type === 'transcribe').map(message => message.timeOffset))
                    .toEqual([0, 6]);

                for (let cycle = 0; cycle < 6; cycle += 1) {
                    await completeActiveInference();
                }

                const transcribePosts = hostPosts.filter(message => message.type === 'transcribe');
                const completedIds = workerEvents
                    .filter(message => message.status === 'complete')
                    .map(message => message.chunkId);
                const offsetsById = new Map(
                    transcribePosts.map(message => [message.chunkId, message.timeOffset]),
                );
                expect(completedIds.map(chunkId => offsetsById.get(chunkId)))
                    .toEqual([0, 6, 12, 18, 24, 30]);
                expect(transcribePosts.map(message => message.timeOffset))
                    .toEqual([0, 6, 12, 18, 24, 30, 36, 42]);
                expect(workerEvents.filter(message => message.status === 'dropped')).toEqual([]);
                expect((whisper as any).processedRanges).toEqual([{ start: 0, end: 36 }]);
                expect((whisper as any).pendingChunks).toBe(2);
                expect((whisper as any).unavailableRanges).toEqual([]);
            } finally {
                vi.useRealTimers();
            }
        });

        it('queues every missing window between discontiguous analyzed ranges', () => {
            const { whisper, sendChunk } = setupReadyChunkPipeline(0);
            (whisper as any).transcribedUpTo = 20;
            (whisper as any).processedRanges = [
                { start: 0, end: 20 },
                { start: 70, end: 80 },
            ];

            for (let index = 0; index < 10; index++) {
                (whisper as any).maybeProcessNextChunk();
            }

            expect(sendChunk.mock.calls.map(call => call[1])).toEqual([
                20, 44, 68, 92, 116,
            ]);
        });

        it('uses the same authoritative context on WebGPU', () => {
            const { whisper, sendChunk } = setupReadyChunkPipeline(0);

            (whisper as any).maybeProcessNextChunk();

            expect(sendChunk).toHaveBeenCalledTimes(1);
            expect(sendChunk.mock.calls[0]?.[4]).toBe(29);
        });

        it('transfers a compact PCM copy without detaching the live ring', () => {
            const whisper = new Whisper();
            const liveRing = new Float32Array([0, 0.25, 0.5, 0.75, 1]);
            const window = liveRing.subarray(1, 4);
            let delivered: Float32Array | undefined;
            const postMessage = vi.fn((message: { audio: Float32Array }, transfer: Transferable[]) => {
                delivered = structuredClone(message.audio, { transfer }) as Float32Array;
            });
            (whisper as any).worker = { postMessage };

            (whisper as any).sendChunk(window, 0, settings);

            const sentMessage = postMessage.mock.calls[0]?.[0] as { audio: Float32Array };
            const transfer = postMessage.mock.calls[0]?.[1] as Transferable[];
            expect(sentMessage.audio.buffer).not.toBe(liveRing.buffer);
            expect(transfer).toEqual([sentMessage.audio.buffer]);
            expect(Array.from(delivered ?? [])).toEqual([0.25, 0.5, 0.75]);
            expect(liveRing.buffer.byteLength).toBe(5 * Float32Array.BYTES_PER_ELEMENT);
            expect(liveRing).toEqual(new Float32Array([0, 0.25, 0.5, 0.75, 1]));
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

    describe('timestamp granularity', () => {
        it('does not synthesize word timings from segment-only output', () => {
            const whisper = new Whisper();
            const segments = (whisper as any).parseSegments([{
                text: 'hello world',
                timestamp: [0, 2],
                words: [
                    { text: 'hello', start: 0, end: 1 },
                    { text: 'world', start: 1, end: 2 },
                ],
            }], 'segment');

            expect(segments).toEqual([{ start: 0, end: 2, text: 'hello world', words: undefined }]);
        });

        it('preserves worker-provided words only when capability is exact', () => {
            const whisper = new Whisper();
            const segments = (whisper as any).parseSegments([{
                text: 'お邪魔します',
                timestamp: [0, 2],
                words: [
                    { text: 'お邪魔', start: 0, end: 1 },
                    { text: 'します', start: 1, end: 2 },
                ],
            }], 'word');

            expect(segments[0].words).toEqual([
                { text: 'お邪魔', start: 0, end: 1 },
                { text: 'します', start: 1, end: 2 },
            ]);
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

        it('caps a repeated decoder phrase only after it accumulates across completed windows', () => {
            const whisper = new Whisper();
            const repeated = Array.from({ length: 14 }, (_, index) => ({
                start: index * 8,
                end: index * 8 + 1,
                text: 'う',
            }));

            (whisper as any).mergeSegments(repeated.slice(0, 7), { preferNew: true });
            expect((whisper as any).segments).toHaveLength(7);

            (whisper as any).mergeSegments(repeated.slice(7), { preferNew: true });
            expect((whisper as any).segments.map((segment: { start: number }) => segment.start))
                .toEqual([0, 8, 16, 88, 96, 104]);
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

        it('drops a recombined past-tense viewing hallucination while preserving surrounding speech', () => {
            const whisper = new Whisper();
            (whisper as any).segments = [];
            (whisper as any).lastSegmentEnd = 0;

            (whisper as any).mergeSegments([
                { start: 0, end: 1.5, text: 'ご視聴ありがとうございました' },
                { start: 2, end: 4, text: 'また明日ね' },
            ], { preferNew: true });

            expect((whisper as any).segments).toEqual([
                { start: 2, end: 4, text: 'また明日ね' },
            ]);
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
            expect((whisper as any).isNoiseOnly('ご視聴ありがとうございました。')).toBe(true);
        });

        it('returns false for normal text', () => {
            const whisper = new Whisper();
            expect((whisper as any).isNoiseOnly('こんにちは')).toBe(false);
            expect((whisper as any).isNoiseOnly('Hello world')).toBe(false);
            expect((whisper as any).isNoiseOnly('最後までご視聴ありがとうございました。また明日ね')).toBe(false);
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

    describe('cached hallucination sanitation', () => {
        const cachedSettings = {
            preset: 'tiny',
            model: 'onnx-community/whisper-tiny_timestamped',
            backend: 'webgpu',
            subtask: 'transcribe',
            language: 'japanese',
            multilingual: true,
            chunkLengthS: 29,
            strideLengthS: 5,
            cacheTranscripts: true,
        };

        function storeCachedSnapshot(
            whisper: Whisper,
            source: string,
            snapshot: {
                text: string;
                segments: Array<Record<string, unknown>>;
                timingQuality?: 'word' | 'segment';
            },
        ): void {
            const key = (whisper as any).buildCacheKey(source, cachedSettings);
            SharedCache.set(key, {
                ...snapshot,
                model: cachedSettings.model,
                subtask: cachedSettings.subtask,
                language: cachedSettings.language,
                createdAt: Date.now(),
                complete: true,
            }, 60_000);
        }

        function emitCachedSnapshot(whisper: Whisper, source: string) {
            const emit = vi.spyOn(EventBus, 'emit');
            (whisper as any).emitCachedSnapshotIfAvailable(source);
            return emit;
        }

        function expectNoCachedSnapshot(whisper: Whisper, source: string): void {
            const emit = emitCachedSnapshot(whisper, source);
            expect(emit.mock.calls.some(
                ([event, payload]) => event === 'whisper:update' && (payload as any).source === 'cache',
            )).toBe(false);
            expect((whisper as any).segments).toEqual([]);
        }

        it('removes an old silence hallucination before a cached snapshot reaches the UI', () => {
            const whisper = new Whisper();
            vi.spyOn(whisper as any, 'getWhisperSettings').mockReturnValue(cachedSettings);
            const source = 'https://example.test/cached-hallucination.mp3';
            storeCachedSnapshot(whisper, source, {
                text: '聞こえています ご視聴ありがとうございました',
                segments: [
                    { start: 0, end: 2, text: '聞こえています' },
                    { start: 2, end: 4, text: 'ご視聴ありがとうございました' },
                ],
            });
            const emit = emitCachedSnapshot(whisper, source);

            const update = findWhisperUpdate(emit, 'cache');
            expect(update).toMatchObject({
                text: '聞こえています',
                segments: [{ start: 0, end: 2, text: '聞こえています' }],
                source: 'cache',
            });
            expect((whisper as any).segments).toEqual([
                { start: 0, end: 2, text: '聞こえています' },
            ]);
        });

        it('does not emit a cached snapshot made entirely from the silence hallucination', () => {
            const whisper = new Whisper();
            vi.spyOn(whisper as any, 'getWhisperSettings').mockReturnValue(cachedSettings);
            const source = 'https://example.test/cached-silence-only.mp3';
            storeCachedSnapshot(whisper, source, {
                text: 'ご視聴ありがとうございました',
                segments: [{ start: 0, end: 2, text: 'ご視聴ありがとうございました' }],
            });

            expectNoCachedSnapshot(whisper, source);
        });

        it('heals timestamp tokens in old cached segment and word text before display', () => {
            const whisper = new Whisper();
            vi.spyOn(whisper as any, 'getWhisperSettings').mockReturnValue(cachedSettings);
            const source = 'https://example.test/cached-timestamp-token.mp3';
            storeCachedSnapshot(whisper, source, {
                text: '<|0.00|>お邪魔します<|2.00|>',
                timingQuality: 'word',
                segments: [{
                    start: 0,
                    end: 2,
                    text: '<|0.00|>お邪魔します<|2.00|>',
                    words: [
                        { start: 0, end: 1, text: '<|0.00|>お邪魔' },
                        { start: 1, end: 2, text: 'します<|2.00|>' },
                    ],
                }],
            });
            const emit = emitCachedSnapshot(whisper, source);

            const update = findWhisperUpdate(emit, 'cache');
            expect(update.segments).toEqual([{
                start: 0,
                end: 2,
                text: 'お邪魔します',
                words: [
                    { start: 0, end: 1, text: 'お邪魔' },
                    { start: 1, end: 2, text: 'します' },
                ],
            }]);
        });

        it('rejects an old complete cache entry made only of timestamp tokens', () => {
            const whisper = new Whisper();
            vi.spyOn(whisper as any, 'getWhisperSettings').mockReturnValue(cachedSettings);
            const source = 'https://example.test/cached-token-only.mp3';
            storeCachedSnapshot(whisper, source, {
                text: '<|0.00|><|2.00|>',
                segments: [{
                    start: 0,
                    end: 2,
                    text: '<|0.00|><|2.00|>',
                    words: [{ start: 0, end: 2, text: '<|0.00|>' }],
                }],
            });

            expectNoCachedSnapshot(whisper, source);
        });

        it('migrates a legacy partial cache to durable whole-track resume', () => {
            const whisper = new Whisper();
            const cached = (whisper as any).sanitizeCachedTranscript({
                text: '保存済み',
                segments: [{ start: 10, end: 20, text: '保存済み' }],
                model: cachedSettings.model,
                subtask: cachedSettings.subtask,
                language: cachedSettings.language,
                createdAt: Date.now(),
                complete: false,
            });

            expect(cached).toMatchObject({
                coverageOrigin: 0,
                processedRanges: [],
                unavailableRanges: [],
                complete: false,
            });
        });

        it('hydrates a coverage-only checkpoint without emitting a subtitle row', () => {
            const whisper = new Whisper();
            vi.spyOn(whisper as any, 'getWhisperSettings').mockReturnValue(cachedSettings);
            const source = 'https://example.test/cached-silence-coverage.mp3';
            const key = (whisper as any).buildCacheKey(source, cachedSettings);
            SharedCache.set(key, {
                text: '',
                segments: [],
                model: cachedSettings.model,
                subtask: cachedSettings.subtask,
                language: cachedSettings.language,
                createdAt: Date.now(),
                complete: false,
                timingQuality: 'segment',
                processedRanges: [{ start: 0, end: 20 }],
                unavailableRanges: [],
                coverageOrigin: 0,
            }, 60_000);
            const emit = vi.spyOn(EventBus, 'emit');

            (whisper as any).emitCachedSnapshotIfAvailable(source);

            expect((whisper as any).processedRanges).toEqual([{ start: 0, end: 20 }]);
            expect(emit.mock.calls.some(([event]) => event === 'whisper:update')).toBe(false);
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
                .toBe('onnx-community/whisper-tiny_timestamped');
            expect(resolveWhisperModelPreset('base', 'ignored'))
                .toBe('onnx-community/whisper-base_timestamped');
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
            expect(resolveWhisperModelPreset('auto', 'onnx-community/whisper-tiny_timestamped'))
                .toBe('onnx-community/whisper-tiny_timestamped');
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
                whisperAdaptiveWindow: true,
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
            const settings = (new Whisper() as any).getWhisperSettings();
            expect(settings.model).toBe('onnx-community/whisper-medium_timestamped');
            expect(settings.minWebgpuBufferBytes).toBe(256 * 1024 * 1024);
        });

        it('honors an explicit higher preset on unknown-memory Apple Silicon (no silent tiny downgrade)', () => {
            mockConfig({ whisperModelPreset: 'large-v3-turbo' });
            mockDevice({
                tier: 'full', hasGpu: true, memory: -1, cores: 10,
                isTouch: false, isMobile: false, screenWidth: 1728,
                gpuVendor: 'mozilla apple m1, or similar', reason: 'full, GPU, 10 cores',
            });
            // Auto chooses timestamped Base here; an explicit preset must not be changed.
            expect((new Whisper() as any).getWhisperSettings().model)
                .toBe('onnx-community/whisper-large-v3-turbo_timestamped');
        });

        it('uses timestamped Base and full context for Auto on the M1 profile', () => {
            mockConfig({ whisperModelPreset: 'auto' });
            mockDevice({
                tier: 'full', hasGpu: true, memory: -1, cores: 10,
                isTouch: false, isMobile: false, screenWidth: 1728,
                gpuVendor: 'mozilla apple m1, or similar', reason: 'full, GPU, 10 cores',
            });
            const settings = (new Whisper() as any).getWhisperSettings();
            expect(settings.model).toBe('onnx-community/whisper-base_timestamped');
            expect(settings.chunkLengthS).toBe(29);
            expect(settings.strideLengthS).toBe(5);
            expect(settings.catchUpChunkLengthS).toBe(29);
            expect(settings.catchUpStrideLengthS).toBe(5);
            expect(settings.adaptiveCatchUp).toBe(false);
            expect(settings.maxPendingChunks).toBe(2);

            mockConfig({ whisperModelPreset: 'base' });
            const manualSettings = (new Whisper() as any).getWhisperSettings();
            expect(manualSettings.model).toBe('onnx-community/whisper-base_timestamped');
            expect(manualSettings.chunkLengthS).toBe(29);
            expect(manualSettings.strideLengthS).toBe(5);
            expect(manualSettings.adaptiveCatchUp).toBe(false);
        });

        it('pins the configured Firefox/M1 window when adaptive mode is disabled', () => {
            mockConfig({
                whisperModelPreset: 'auto',
                whisperAdaptiveWindow: false,
                whisperLiveChunkSec: 29,
                whisperLiveOverlapSec: 5,
            });
            mockDevice({
                tier: 'full', hasGpu: true, memory: -1, cores: 10,
                isTouch: false, isMobile: false, screenWidth: 1728,
                gpuVendor: 'mozilla apple m1, or similar', reason: 'full, GPU, 10 cores',
            });
            const settings = (new Whisper() as any).getWhisperSettings();
            expect(settings.model).toBe('onnx-community/whisper-base_timestamped');
            expect(settings.chunkLengthS).toBe(29);
            expect(settings.strideLengthS).toBe(5);
            expect(settings.maxPendingChunks).toBe(2);
        });

        it('keeps an unknown-renderer limited Firefox Mac on Tiny instead of assigning M1 Base', () => {
            mockConfig({ whisperModelPreset: 'auto' });
            vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:153.0) Gecko/20100101 Firefox/153.0',
            );
            vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
            mockDevice({
                tier: 'limited', hasGpu: true, memory: -1, cores: 4,
                isTouch: false, isMobile: false, screenWidth: 1440,
                gpuVendor: '', reason: 'limited, GPU, intel-mac',
            });
            const settings = (new Whisper() as any).getWhisperSettings();
            expect(settings.model).toBe('onnx-community/whisper-tiny_timestamped');
            expect(settings.backend).toBe('webgpu');
        });

        it('does not downgrade a GPU that exposes subgroups, even on Firefox/mac', () => {
            // Chromium-class compute must not be held back because another
            // browser lacks the feature. Measured: subgroups => 3.6-5.5x
            // realtime; without => 0.15-0.22x on the same M1.
            mockConfig({ whisperModelPreset: 'auto' });
            vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:153.0) Gecko/20100101 Firefox/153.0',
            );
            vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
            __setWebGpuComputeProfileForTests({
                subgroups: true, subgroupMatrix: true, shaderF16: true, maxBufferBytes: 4 * 1024 ** 3,
                readbackLatencyMs: 0.4, slowReadback: false,
            });
            mockDevice(fullProfile);

            const settings = (new Whisper() as any).getWhisperSettings();
            expect(settings.model).toBe('onnx-community/whisper-small_timestamped');
            expect(settings.backend).toBe('webgpu');
        });

        it('uses the conservative tier when the adapter is measured to lack subgroups', () => {
            mockConfig({ whisperModelPreset: 'auto' });
            __setWebGpuComputeProfileForTests({
                subgroups: false, subgroupMatrix: false, shaderF16: true, maxBufferBytes: 1024 ** 3,
                readbackLatencyMs: 103, slowReadback: true,
            });
            mockDevice(fullProfile);

            const settings = (new Whisper() as any).getWhisperSettings();
            expect(settings.model).toBe('onnx-community/whisper-base_timestamped');
        });

        it('keeps an explicit preset pinned regardless of measured GPU capability', () => {
            mockConfig({ whisperModelPreset: 'small' });
            __setWebGpuComputeProfileForTests({
                subgroups: false, subgroupMatrix: false, shaderF16: false, maxBufferBytes: 1024 ** 3,
                readbackLatencyMs: 103, slowReadback: true,
            });
            mockDevice(fullProfile);

            const settings = (new Whisper() as any).getWhisperSettings();
            expect(settings.model).toBe('onnx-community/whisper-small_timestamped');
        });

        it('force-WASM keeps an explicit model exact and changes only the selected backend', () => {
            mockConfig({ whisperModelPreset: 'large-v3-turbo', forceWhisperWasm: true });
            mockDevice(fullProfile);
            const settings = (new Whisper() as any).getWhisperSettings();
            expect(settings.model).toBe('onnx-community/whisper-large-v3-turbo_timestamped');
            expect(settings.backend).toBe('wasm');
        });

        it('no-GPU device keeps an explicit model exact on the resolved WASM backend', () => {
            mockConfig({ whisperModelPreset: 'medium' });
            mockDevice({
                tier: 'limited', hasGpu: false, memory: -1, cores: 8,
                isTouch: false, isMobile: false, screenWidth: 1440, gpuVendor: '', reason: 'no-GPU',
            });
            const settings = (new Whisper() as any).getWhisperSettings();
            expect(settings.model).toBe('onnx-community/whisper-medium_timestamped');
            expect(settings.backend).toBe('wasm');
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

        it('cancels an in-flight automatic warmup and its deferred restart on opt-out', () => {
            vi.useFakeTimers();
            const config = mockConfig({ whisperAutoWarmup: true });
            mockDevice(fullProfile, true);
            const whisper = new Whisper();
            const settings = (whisper as any).getWhisperSettings();
            const worker = createMockWhisperWorker();
            (whisper as any).worker = worker;
            (whisper as any).loadedPlan = {
                model: settings.model,
                backend: settings.backend,
                multilingual: settings.multilingual,
            };
            (whisper as any).workerInitPending = {
                worker,
                generation: 1,
                plan: (whisper as any).loadedPlan,
            };
            (whisper as any).autoWarmupStarted = true;
            (whisper as any).deferredWorkerSettings = settings;
            (whisper as any).workerRestartTimer = window.setTimeout(() => {
                (whisper as any).initWorker(settings);
            }, 5_000);
            (whisper as any).setupEventListeners();

            try {
                config.whisperAutoWarmup = false;
                EventBus.emit('config:change', {
                    key: 'whisperAutoWarmup',
                    value: false,
                    oldValue: true,
                });

                expect(worker.terminate).toHaveBeenCalledTimes(1);
                expect((whisper as any).worker).toBeNull();
                expect((whisper as any).workerRestartTimer).toBeNull();
                expect((whisper as any).deferredWorkerSettings).toBeNull();
                expect((whisper as any).autoWarmupStarted).toBe(false);

                vi.advanceTimersByTime(5_000);
                expect((whisper as any).worker).toBeNull();
            } finally {
                (whisper as any).eventCleanups.splice(0).forEach((cleanup: () => void) => cleanup());
                vi.clearAllTimers();
                vi.useRealTimers();
            }
        });

        it('reports why a requested background warmup is capability-suppressed', () => {
            mockConfig({ whisperAutoWarmup: true });
            mockDevice({
                tier: 'limited', hasGpu: true, memory: 8, cores: 4,
                isTouch: false, isMobile: false, screenWidth: 1440,
                gpuVendor: '', reason: 'limited',
            }, false);

            expect(new Whisper().getAutoWarmupSuppressionReason())
                .toBe('device-capability');

            vi.restoreAllMocks();
            mockConfig({ whisperAutoWarmup: true, forceWhisperWasm: true });
            mockDevice(fullProfile, true);
            expect(new Whisper().getAutoWarmupSuppressionReason())
                .toBe('force-wasm');

            vi.restoreAllMocks();
            mockConfig({ whisperAutoWarmup: true, whisperModelPreset: 'medium' });
            mockDevice(fullProfile, true);
            expect(new Whisper().getAutoWarmupSuppressionReason())
                .toBe('manual-model-preparation');
        });

        it('clears stale ready UI without auto-loading a newly selected experimental model', () => {
            const config = mockConfig({
                whisperAutoWarmup: true,
                whisperModelPreset: 'small',
            });
            mockDevice(fullProfile, true);
            const whisper = new Whisper();
            const worker = createMockWhisperWorker();
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
                expect(initSpy).not.toHaveBeenCalled();
                expect((whisper as any).getWhisperSettings()).toEqual(expect.objectContaining({
                    model: 'onnx-community/whisper-medium_timestamped',
                    autoWarmup: false,
                }));
            } finally {
                (whisper as any).eventCleanups.splice(0).forEach((cleanup: () => void) => cleanup());
            }
        });

        it('reports the one exact loaded worker identity without re-key semantics', () => {
            mockConfig({ whisperModelPreset: 'small' });
            mockDevice(fullProfile);
            const whisper = new Whisper();
            (whisper as any).loadedPlan = Object.freeze({
                model: 'onnx-community/whisper-small_timestamped',
                backend: 'webgpu',
                multilingual: true,
            });

            expect(whisper.getEffectiveModelId()).toBe('onnx-community/whisper-small_timestamped');
            expect(whisper.getEffectiveBackend()).toBe('webgpu');
        });

        it('does not consume a WebGPU transcript cache for explicit WASM or a different live context', () => {
            mockConfig({ whisperModelPreset: 'small' });
            mockDevice(fullProfile);
            const source = 'https://example.test/exact-policy-cache.mp3';
            const webGpuWhisper = new Whisper();
            const webGpuSettings = (webGpuWhisper as any).getWhisperSettings();
            const sourceIdentity = (webGpuWhisper as any).buildCacheIdentity(source, webGpuSettings);
            const webGpuKey = (webGpuWhisper as any).buildCacheKey(source, webGpuSettings);
            SharedCache.set(webGpuKey, {
                text: 'webgpu transcript',
                segments: [{ start: 0, end: 29, text: 'webgpu transcript' }],
                model: webGpuSettings.model,
                subtask: webGpuSettings.subtask,
                language: webGpuSettings.language,
                createdAt: Date.now(),
                complete: true,
                sourceIdentity,
            }, 60_000);
            const emit = vi.spyOn(EventBus, 'emit');

            const wasmWhisper = new Whisper();
            (wasmWhisper as any).activeRunSettings = Object.freeze({
                ...webGpuSettings,
                backend: 'wasm',
                forceWasm: true,
            });
            (wasmWhisper as any).emitCachedSnapshotIfAvailable(source);

            const differentContextWhisper = new Whisper();
            (differentContextWhisper as any).activeRunSettings = Object.freeze({
                ...webGpuSettings,
                chunkLengthS: 20,
                strideLengthS: 4,
            });
            (differentContextWhisper as any).emitCachedSnapshotIfAvailable(source);

            expect(emit.mock.calls.some(
                ([event, payload]) => event === 'whisper:update' && (payload as any).source === 'cache',
            )).toBe(false);
            expect((wasmWhisper as any).segments).toEqual([]);
            expect((differentContextWhisper as any).segments).toEqual([]);
            expect((wasmWhisper as any).buildCacheKey(source, (wasmWhisper as any).activeRunSettings))
                .not.toBe(webGpuKey);
            expect((differentContextWhisper as any).buildCacheKey(
                source,
                (differentContextWhisper as any).activeRunSettings,
            )).not.toBe(webGpuKey);
        });
    });

    describe('adaptive current-run scheduling', () => {
        function setupScheduler(playback: number, throughputRatio: number): {
            whisper: Whisper;
            send: ReturnType<typeof vi.spyOn>;
            settings: ReturnType<typeof createCompatibilityWhisperSettings> & {
                adaptiveCatchUp: boolean;
                catchUpChunkLengthS: number;
                catchUpStrideLengthS: number;
            };
        } {
            const whisper = new Whisper();
            const audio = document.createElement('audio');
            audio.currentTime = playback;
            const settings = {
                ...createCompatibilityWhisperSettings({
                    model: 'onnx-community/whisper-base',
                    backend: 'webgpu',
                    chunkLengthS: 8,
                    strideLengthS: 2,
                    maxPendingChunks: 3,
                }),
                adaptiveCatchUp: true,
                catchUpChunkLengthS: 29,
                catchUpStrideLengthS: 5,
            };
            (whisper as any).audio = audio;
            (whisper as any).transcribing = true;
            (whisper as any).modelReady = true;
            (whisper as any).hasWorkerChunkActivity = true;
            (whisper as any).activeRunSettings = Object.freeze(settings);
            (whisper as any).pcmBuffer = new Float32Array(90 * 16_000);
            (whisper as any).pcmDuration = 90;
            (whisper as any).pcmBufferStartTime = 0;
            (whisper as any).transcribedUpTo = 0;
            (whisper as any).runtimeProgressOrigin = 0;
            (whisper as any).throughputRatio = throughputRatio;
            vi.spyOn((whisper as any).bridge, 'currentTrack', 'get').mockReturnValue(undefined);
            const send = vi.spyOn(whisper as any, 'sendChunk').mockImplementation(() => {});
            return { whisper, send, settings };
        }

        it('widens context under measured contention without changing the selected model/backend', () => {
            const { whisper, send, settings } = setupScheduler(30, 0.7);

            (whisper as any).maybeProcessNextChunk();

            expect(send).toHaveBeenCalledOnce();
            expect(send.mock.calls[0][4]).toBe(29);
            expect(send.mock.calls[0][5]).toBe(5);
            expect((whisper as any).activeRunSettings.model).toBe(settings.model);
            expect((whisper as any).activeRunSettings.backend).toBe('webgpu');
        });

        it('keeps the low-latency window for a 15-second random-seek backfill', () => {
            const { whisper, send } = setupScheduler(378, 0.5);
            (whisper as any).transcribedUpTo = 363;
            (whisper as any).runtimeProgressOrigin = 363;
            (whisper as any).pcmBufferStartTime = 363;
            (whisper as any).pcmDuration = 392;
            (whisper as any).pcmBuffer = new Float32Array(29 * 16_000);

            (whisper as any).maybeProcessNextChunk();

            expect(send).toHaveBeenCalledOnce();
            expect(send.mock.calls[0][4]).toBe(8);
            expect(send.mock.calls[0][5]).toBe(2);
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
