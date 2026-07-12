import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __getWhisperWorkerCodeForTests, createWhisperWorker } from '../../src/features/WhisperWorkerLoader';

describe('WhisperWorkerLoader', () => {
    let capturedBlob: Blob | null = null;
    let workerCtor: any;
    let originalCreateObjectURL: any;
    let originalRevokeObjectURL: any;

    beforeEach(() => {
        capturedBlob = null;
        workerCtor = vi.fn(() => ({ terminate: vi.fn(), postMessage: vi.fn() }));
        vi.stubGlobal('Worker', workerCtor as any);
        originalCreateObjectURL = (URL as any).createObjectURL;
        originalRevokeObjectURL = (URL as any).revokeObjectURL;

        (URL as any).createObjectURL = vi.fn((blob: Blob | MediaSource) => {
            capturedBlob = blob as Blob;
            return 'blob:test-worker';
        });
        (URL as any).revokeObjectURL = vi.fn(() => { });
    });

    afterEach(() => {
        (URL as any).createObjectURL = originalCreateObjectURL;
        (URL as any).revokeObjectURL = originalRevokeObjectURL;
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('creates module worker from inline blob and revokes URL', async () => {
        const worker = createWhisperWorker();

        expect(worker).toBeDefined();
        expect(workerCtor).toHaveBeenCalledWith('blob:test-worker', { type: 'module' });
        expect((URL as any).revokeObjectURL).toHaveBeenCalledWith('blob:test-worker');
        expect(capturedBlob).toBeInstanceOf(Blob);
        expect((capturedBlob as Blob).size).toBeGreaterThan(1000);
    });

    it('uses Transformers.js V4 CDN URLs', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain('transformers@4.0.0-next.4');
        // V3 fallback removed — all workers now use V4 only
        expect(code).not.toContain('transformers@3.8.1');
    });

    it('uses env.remoteHost for hub URL configuration (not env.hub)', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain('env.remoteHost');
        expect(code).not.toContain('env.hub');
    });

    it('adds CDN import timeout to prevent indefinite hang', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain('Promise.race');
        expect(code).toContain('CDN import timeout');
    });

    it('has unhandledrejection handler that suppresses stale GPU errors', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain("self.addEventListener('unhandledrejection'");
        expect(code).toContain('GPU_ERROR_RE');
        expect(code).toContain('gpuDeviceLost');
        expect(code).toContain("status: 'gpu-device-lost'");
    });

    it('pins worker to WASM after GPU inference failure to avoid backend thrash', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain('skipWebgpu = true;');
        expect(code).toContain('GPU inference failed, falling back to WASM');
        expect(code).toContain("status: 'gpu-degraded'");
    });

    it('uses q4 decoder as primary WebGPU dtype (per HF official example)', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain("encoder_model: 'fp32'");
        expect(code).toContain("decoder_model_merged: 'q4'");
    });

    it('uses proportional inference timeout scaled to chunk length', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain('const INFERENCE_TIMEOUT_MS = 45_000;');
        expect(code).toContain("backendName + ' inference timed out after '");
        expect(code).toContain('chunkS * 5 * 1000');
        expect(code).toContain("Math.min(180_000, Math.max(90_000, chunkS * 4 * 1000))");
    });

    it('does not retry on a pipeline whose uncancellable inference timed out', () => {
        const code = __getWhisperWorkerCodeForTests();
        const timeoutGuard = code.indexOf("if (/inference timed out/i.test(initialMsg))");
        const wordRetry = code.indexOf('const canRetryWithoutWords');

        expect(timeoutGuard).toBeGreaterThan(0);
        expect(wordRetry).toBeGreaterThan(timeoutGuard);
        expect(code.slice(timeoutGuard, wordRetry)).toContain("postChunkError(chunkId, initialMsg, currentBackend !== 'wasm')");
        expect(code.slice(timeoutGuard, wordRetry)).toContain('return null');
    });

    it('falls back to a bounded tiny multilingual model when model loading fails', () => {
        const code = __getWhisperWorkerCodeForTests();
        expect(code).toContain("const FALLBACK_MODEL = 'onnx-community/whisper-tiny'");
        expect(code).toContain("status: 'fallback'");
        expect(code).toContain('loadPipelineForModel({ ...settings, model: FALLBACK_MODEL }');
    });

    it('produces syntactically valid worker JavaScript', () => {
        const code = __getWhisperWorkerCodeForTests();
        expect(() => new Function(code)).not.toThrow();
    });

    it('accepts gpuVendorHint from host for Firefox hidden adapter.info', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain("let gpuVendorHint = ''");
        expect(code).toContain('msg.gpuVendorHint');
        expect(code).toContain('Using host GPU vendor hint');
    });

    it('uses chunked streaming mode for web transcription', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain('chunk_length_s: msg.chunkLengthS');
        expect(code).toContain('stride_length_s: msg.strideLengthS');
    });

    it('delegates post-processing to host (no hallucination/grouping in worker)', () => {
        const code = __getWhisperWorkerCodeForTests();

        // Processing extracted to whisperProcessing.ts — worker sends raw chunks
        expect(code).not.toContain('HALLUCINATION_RE');
        expect(code).not.toContain('groupWordsToSegments');
        expect(code).toContain('rawChunks');
    });

    it('enables word timestamps on all backends with retry fallback', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain('const useWordTimestamps = true');
    });

    it('detects WebGPU adapter with power preference', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain('navigator.gpu.requestAdapter(');
        expect(code).toContain('powerPreference');
        // Scoring removed — simplified to preferred + fallback
        expect(code).not.toContain('scoreAdapter');
    });

    it('reuses existing pipeline when model matches', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain('pipelinePromise && currentModel === modelName');
    });

    it('supports host control messages for backend/queue lifecycle', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain("if (msg.type === 'skip-webgpu')");
        expect(code).toContain("if (msg.type === 'flush-queue')");
        expect(code).toContain("if (msg.type === 'reset')");
    });

    it('emits status lifecycle messages needed by Whisper controller', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain("status: 'initiate'");
        expect(code).toContain("status: 'ready'");
        expect(code).toContain("status: 'update'");
        expect(code).toContain("status: 'complete'");
        expect(code).toContain("status: 'error'");
    });
});
