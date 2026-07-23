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

        expect(code).toContain('transformers@4.2.0');
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

    it('delegates GPU inference fallback to a fresh host-created worker', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain('postChunkError(chunkId, retryMsg, true)');
        expect(code).toContain('postChunkError(chunkId, initialMsg, true)');
        expect(code).not.toContain('GPU inference failed, falling back to WASM');
        expect(code).not.toContain("status: 'gpu-degraded'");
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
        expect(code.slice(timeoutGuard, wordRetry)).toContain("haltTimedOutWorker(chunkId, initialMsg, currentBackend !== 'wasm')");
        expect(code.slice(timeoutGuard, wordRetry)).toContain('return null');
        expect(code).toContain('workerPoisoned = true');
        expect(code).toContain("postDropped(queued, 'worker-poisoned')");
        expect(code).toContain('if (!workerPoisoned) processNextJob()');
    });

    it('selects a bounded tiny multilingual model before loading on WASM', () => {
        const code = __getWhisperWorkerCodeForTests();
        expect(code).toContain("const FALLBACK_MODEL = 'onnx-community/whisper-tiny'");
        expect(code).toContain("status: 'fallback'");
        expect(code).toContain('loadPipelineForModel({ ...settings, model: FALLBACK_MODEL }');
    });

    it('uses the compact q8 WASM model with safe basic graph optimization', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain("const WASM_DTYPE = 'q8'");
        expect(code).toContain("graphOptimizationLevel: 'basic'");
    });

    it('poisons failed model loaders and reports a typed load-failed event', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain('throw toLoadFailure(err, modelName');
        expect(code).toContain("status: 'load-failed'");
        expect(code).toContain('sessionPoisoned: true');
        expect(code).not.toContain('All WebGPU candidates failed, falling through to WASM');
    });

    it('normalizes third-party model callbacks so only postReady emits ready', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain('function postModelProgress(data, chunkId)');
        expect(code).toContain("status: 'progress'");
        expect(code).toContain('sourceStatus: payload.status');
        expect(code).toContain('postModelProgress(data, msg.chunkId)');
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
        expect(code).toContain('new TextStreamer(');
        expect(code).toContain("emitHeartbeat('decoding', partialText)");
        expect(code).toContain('const createAttemptOptions = (returnTimestamps, targetPipe = pipe)');
        expect(code).toContain('attempt !== activeAttempt || workerPoisoned');
        expect(code).not.toContain('function chunk_callback');
    });

    it('delegates post-processing to host (no hallucination/grouping in worker)', () => {
        const code = __getWhisperWorkerCodeForTests();

        // Processing extracted to whisperProcessing.ts — worker sends raw chunks
        expect(code).not.toContain('HALLUCINATION_RE');
        expect(code).not.toContain('groupWordsToSegments');
        expect(code).toContain('rawChunks');
        expect(code).toContain('inputRms: msg.inputRms');
    });

    it('avoids the guaranteed duplicate word-timestamp decode on WASM', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain("const useWordTimestamps = currentBackend !== 'wasm'");
    });

    it('detects WebGPU adapter with power preference', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain('navigator.gpu.requestAdapter(');
        expect(code).toContain('powerPreference');
        // Scoring removed — simplified to preferred + fallback
        expect(code).not.toContain('scoreAdapter');
    });

    it('rejects software WebGPU adapters and bounds WASM to tiny', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain('swiftshader|llvmpipe|software|softpipe');
        expect(code).toContain('Rejected software WebGPU adapter');
        expect(code).toContain("currentBackend === 'wasm' && settings.model !== FALLBACK_MODEL");
        expect(code).toContain('WASM backend requires the bounded tiny model');
    });

    it('reuses existing pipeline when model matches', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain('pipelinePromise && currentModel === modelName');
        expect(code).toContain('pipelineLoadPromise && pipelineLoadKey === loadingKey');
        expect(code).toContain("const loadingKey = effective.model + '|' + String(effective.multilingual)");
    });

    it('supports host control messages for backend/queue lifecycle', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain("if (msg.type === 'skip-webgpu')");
        expect(code).toContain("if (msg.type === 'flush-queue')");
        expect(code).toContain("if (msg.type === 'reset')");
        expect(code).toContain('const queued = jobQueue[0]');
        expect(code).toContain("postDropped(queued, 'queue-replaced'");
        expect(code).toContain("postDropped(msg, 'queue-full'");
    });

    it('emits status lifecycle messages needed by Whisper controller', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain("status: 'initiate'");
        expect(code).toContain("status: 'ready'");
        expect(code).toContain("status: 'queued'");
        expect(code).toContain("status: 'started'");
        expect(code).toContain("status: 'heartbeat'");
        expect(code).toContain("status: 'dropped'");
        expect(code).toContain("status: 'complete'");
        expect(code).toContain("status: 'error'");
        expect(code).toContain("status: 'load-failed'");
        expect(code).toContain('model: currentModel');
        expect(code).toContain('dtype: currentDtype');
    });

    it('executes at most one inference and replaces the sole queued job by priority', async () => {
        let onMessage: ((event: { data: any }) => void) | null = null;
        const emitted: any[] = [];
        let resolveFirst!: (value: any) => void;
        const first = new Promise<any>((resolve) => { resolveFirst = resolve; });
        const third = new Promise<any>(() => {});
        const transcribe = vi.fn((msg: any) => msg.chunkId === 1 ? first : third);
        const workerSelf: any = {
            __whisperTestTranscribe: transcribe,
            addEventListener: (type: string, handler: (event: { data: any }) => void) => {
                if (type === 'message') onMessage = handler;
            },
            postMessage: (message: any) => emitted.push(message),
        };
        new Function('self', __getWhisperWorkerCodeForTests(true))(workerSelf);
        const send = (data: any) => onMessage!({ data });

        send({ type: 'transcribe', chunkId: 1, priority: 1, playheadDistance: 100 });
        send({ type: 'transcribe', chunkId: 2, priority: 1, playheadDistance: 80 });
        send({ type: 'transcribe', chunkId: 3, priority: 0, playheadDistance: 2 });

        expect(transcribe).toHaveBeenCalledTimes(1);
        expect(emitted).toContainEqual(expect.objectContaining({
            status: 'dropped',
            chunkId: 2,
            data: expect.objectContaining({ reason: 'queue-replaced', replacedByChunkId: 3 }),
        }));
        resolveFirst({ text: 'first', rawChunks: [] });
        await Promise.resolve();
        await Promise.resolve();

        expect(transcribe.mock.calls.map(([msg]) => msg.chunkId)).toEqual([1, 3]);
    });

    it('poisons a timed-out worker and rejects every queued or later job', () => {
        let onMessage: ((event: { data: any }) => void) | null = null;
        const emitted: any[] = [];
        const transcribe = vi.fn(() => new Promise<any>(() => {}));
        const workerSelf: any = {
            __whisperTestTranscribe: transcribe,
            addEventListener: (type: string, handler: (event: { data: any }) => void) => {
                if (type === 'message') onMessage = handler;
            },
            postMessage: (message: any) => emitted.push(message),
        };
        new Function('self', __getWhisperWorkerCodeForTests(true))(workerSelf);
        const send = (data: any) => onMessage!({ data });

        send({ type: 'transcribe', chunkId: 1, priority: 0 });
        send({ type: 'transcribe', chunkId: 2, priority: 1 });
        workerSelf.__whisperTestHalt(1, 'webgpu inference timed out after 45s', true);
        send({ type: 'transcribe', chunkId: 3, priority: 0 });

        expect(transcribe).toHaveBeenCalledTimes(1);
        expect(emitted).toContainEqual(expect.objectContaining({ status: 'worker-poisoned' }));
        expect(emitted.findIndex((message) => message.status === 'worker-poisoned')).toBeLessThan(
            emitted.findIndex((message) => message.status === 'error' && message.chunkId === 1),
        );
        expect(emitted).toContainEqual(expect.objectContaining({
            status: 'dropped',
            chunkId: 2,
            data: expect.objectContaining({ reason: 'worker-poisoned' }),
        }));
        expect(emitted).toContainEqual(expect.objectContaining({
            status: 'dropped',
            chunkId: 3,
            data: expect.objectContaining({ reason: 'worker-poisoned' }),
        }));
    });
});
