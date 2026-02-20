import { describe, it, expect, beforeEach } from 'vitest';
import { Whisper } from '../../src/features/Whisper';
import { DeviceCapabilities } from '../../src/core/DeviceCapabilities';
import { GpuScheduler } from '../../src/core/GpuScheduler';
import { Config } from '../../src/core/Utils';

const { gmSpy } = vi.hoisted(() => ({
    gmSpy: vi.fn(),
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

            expect(settings.maxPendingChunks).toBe(6);
            expect(settings.pollIntervalMs).toBe(250);
            expect(settings.workerUpdateIntervalMs).toBe(200);
            expect(settings.preferLowPowerAdapter).toBe(false);
            expect(settings.autoWarmup).toBe(true);
            expect(settings.idleUnloadMs).toBe(10 * 60 * 1000);
        });

        it('reduces pressure on limited-tier machines and skips eager warmup', () => {
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

            expect(settings.maxPendingChunks).toBe(3);
            expect(settings.pollIntervalMs).toBe(325);
            expect(settings.workerUpdateIntervalMs).toBe(260);
            expect(settings.preferLowPowerAdapter).toBe(true);
            expect(settings.autoWarmup).toBe(false);
            expect(settings.idleUnloadMs).toBe(5 * 60 * 1000);
            expect(settings.minWebgpuBufferBytes).toBe(384 * 1024 * 1024);
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
            expect(settings.maxPendingChunks).toBe(3);
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
        it('re-enables WebGPU once the cooldown has elapsed', () => {
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
            (Whisper as any).webgpuRetryNotBefore = Date.now() - 1;
            (whisper as any).gpuCrashed = true;

            (whisper as any).maybeReenableWebgpu('test');

            expect((Whisper as any).webgpuFailed).toBe(false);
            expect((Whisper as any).webgpuRetryNotBefore).toBe(0);
            expect((whisper as any).gpuCrashed).toBe(false);
        });

        it('keeps WebGPU disabled while cooldown is still active', () => {
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
            (Whisper as any).webgpuRetryNotBefore = Date.now() + 30_000;

            (whisper as any).maybeReenableWebgpu('test');

            expect((Whisper as any).webgpuFailed).toBe(true);
        });
    });

    describe('parseSegments', () => {
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
        it('detects noise patterns', () => {
            const whisper = new Whisper();
            expect((whisper as any).isNoiseOnly('[音楽]')).toBe(true);
            expect((whisper as any).isNoiseOnly('（笑）')).toBe(true);
            expect((whisper as any).isNoiseOnly('[laughter]')).toBe(true);
            expect((whisper as any).isNoiseOnly('[silence]')).toBe(true);
        });

        it('returns false for normal text', () => {
            const whisper = new Whisper();
            expect((whisper as any).isNoiseOnly('こんにちは')).toBe(false);
            expect((whisper as any).isNoiseOnly('Hello world')).toBe(false);
        });

        it('returns true for empty/whitespace text', () => {
            const whisper = new Whisper();
            expect((whisper as any).isNoiseOnly('')).toBe(true);
            expect((whisper as any).isNoiseOnly('   ')).toBe(true);
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
});
