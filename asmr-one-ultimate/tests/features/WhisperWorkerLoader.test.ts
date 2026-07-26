import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __getWhisperWorkerCodeForTests, createWhisperWorker } from '../../src/features/WhisperWorkerLoader';

const TIMESTAMPED_TINY_MODEL = 'onnx-community/whisper-tiny_timestamped';

function createTestWorker(postMessage: (message: any) => void = vi.fn()): any {
    const listeners: Record<string, (event: any) => void> = {};
    const workerSelf = {
        addEventListener: vi.fn((event: string, listener: (payload: any) => void) => {
            listeners[event] = listener;
        }),
        postMessage,
        __whisperTestListeners: listeners,
    };
    new Function('self', __getWhisperWorkerCodeForTests(true))(workerSelf);
    return workerSelf;
}

function setupPipelineLoader(pipeline: any) {
    const testEnv: Record<string, unknown> = {};
    const workerSelf = createTestWorker();
    workerSelf.__whisperTestSetTransformers(pipeline, testEnv);
    return { workerSelf, testEnv };
}

function loadTimestampedTinyOnWasm(workerSelf: any): Promise<unknown> {
    return workerSelf.__whisperTestLoadPipelineForModel({
        model: TIMESTAMPED_TINY_MODEL,
        multilingual: true,
        backend: 'wasm',
    }, vi.fn());
}

function createSuccessfulTimestampPipe(timestampModes: unknown[]): any {
    const pipe: any = vi.fn(async (_audio: Float32Array, options: any) => {
        timestampModes.push(options.return_timestamps);
        return {
            text: 'お邪魔します',
            chunks: [{ text: 'お邪魔します', timestamp: [0, 2] }],
        };
    });
    pipe.tokenizer = {};
    return pipe;
}

function transcribeTestChunk(
    workerSelf: any,
    chunkId: number,
    overrides: Record<string, unknown> = {},
): Promise<unknown> {
    return workerSelf.__whisperTestTranscribeDirect({
        audio: new Float32Array(32_000),
        model: TIMESTAMPED_TINY_MODEL,
        multilingual: true,
        backend: 'webgpu',
        subtask: 'transcribe',
        language: 'japanese',
        chunkLengthS: 2,
        strideLengthS: 0,
        chunkId,
        ...overrides,
    });
}

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

    it('does not misclassify a generic WASM OrtRun rejection as a GPU failure', () => {
        const emitted: any[] = [];
        const pipe: any = vi.fn();
        pipe.tokenizer = {};
        const workerSelf = createTestWorker(message => emitted.push(message));
        workerSelf.__whisperTestSetPipeline(pipe, {
            model: TIMESTAMPED_TINY_MODEL,
            backend: 'wasm',
        });
        const event = {
            reason: new Error('OrtRun failed while executing the selected WASM model'),
            preventDefault: vi.fn(),
        };

        workerSelf.__whisperTestListeners.unhandledrejection(event);

        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(emitted).toContainEqual({
            status: 'error',
            data: { message: 'OrtRun failed while executing the selected WASM model' },
        });
    });

    it('poisons GPU inference failures without changing the selected backend', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain('poisonInferenceWorker(chunkId, retryMsg, true)');
        expect(code).toContain('poisonInferenceWorker(chunkId, initialMsg, true)');
        expect(code).toContain('failed to download data from buffer|buffer unmapped');
        expect(code).not.toContain('GPU inference failed, falling back to WASM');
        expect(code).not.toContain("status: 'gpu-degraded'");
    });

    it('poisons Firefox ORT Buffer unmapped before reporting the failed chunk', async () => {
        const emitted: any[] = [];
        const pipe: any = vi.fn(async () => {
            throw new Error(
                'OrtRun failed: MapAsyncStatus::Success was false. '
                + 'Failed to download data from buffer: Buffer unmapped',
            );
        });
        pipe.tokenizer = {};
        const workerSelf = createTestWorker(message => emitted.push(message));
        workerSelf.__whisperTestSetPipeline(pipe, {
            model: TIMESTAMPED_TINY_MODEL,
            backend: 'webgpu',
        });

        await transcribeTestChunk(workerSelf, 7);

        const poisonedIndex = emitted.findIndex(message => message.status === 'worker-poisoned');
        const errorIndex = emitted.findIndex(message => message.status === 'error');
        expect(poisonedIndex).toBeGreaterThanOrEqual(0);
        expect(errorIndex).toBeGreaterThan(poisonedIndex);
        expect(emitted[poisonedIndex]).toMatchObject({
            status: 'worker-poisoned',
            data: {
                reason: 'inference-runtime-error',
                gpuFailure: true,
            },
        });
        expect(emitted[errorIndex]).toMatchObject({
            status: 'error',
            chunkId: 7,
            data: { gpuFailure: true },
        });
    });

    it('uses q4 decoder as primary WebGPU dtype (per HF official example)', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain("encoder_model: 'fp32'");
        expect(code).toContain("decoder_model_merged: 'q4'");
    });

    it('uses proportional inference timeout scaled to chunk length', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain('"minimumMs":120000');
        expect(code).toContain('"coldStartMinimumMs":180000');
        expect(code).toContain('"maximumMs":300000');
        expect(code).toContain('"medium":1.75');
        expect(code).toContain('"large":2.25');
        expect(code).toContain('"observedDurationHeadroom":1.5');
        expect(code).toContain('"minimumMs":90000');
        expect(code).toContain('"maximumMs":180000');
        expect(code).toContain('calculateWhisperInferenceTimeoutMs');
        expect(code).toContain("' inference timed out after ' + (budgetMs / 1000)");
        expect(code).not.toContain('const INFERENCE_TIMEOUT_MS');
        expect(code).not.toContain('FAST_BOOTSTRAP_TIMEOUT_MS');
    });

    it('uses the cold WebGPU budget only until the first inference completes', async () => {
        const timestampModes: unknown[] = [];
        const pipe = createSuccessfulTimestampPipe(timestampModes);
        const workerSelf = createTestWorker();
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        workerSelf.__whisperTestSetPipeline(pipe, {
            model: TIMESTAMPED_TINY_MODEL,
            backend: 'webgpu',
        });

        await transcribeTestChunk(workerSelf, 1);
        await transcribeTestChunk(workerSelf, 2);

        const messages = log.mock.calls.map(args => args.join(' '));
        expect(messages).toContain(
            '[Whisper Worker] Starting cold-start inference on webgpu (timeout=180s)',
        );
        expect(messages).toContain(
            '[Whisper Worker] Starting inference on webgpu (timeout=120s)',
        );
        expect(messages.filter(message => message.includes('cold-start inference'))).toHaveLength(1);
        expect(pipe).toHaveBeenCalledTimes(2);
    });

    it('reports a hard-ceiling timeout as unresponsive before poisoning the worker', async () => {
        vi.useFakeTimers();
        try {
            const model = 'onnx-community/whisper-large-v3-turbo_timestamped';
            const emitted: any[] = [];
            const pipe: any = vi.fn(() => new Promise<any>(() => {}));
            pipe.tokenizer = {};
            const postMessage = vi.fn((message: any) => emitted.push(message));
            const workerSelf = createTestWorker(postMessage);
            const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
            workerSelf.__whisperTestSetPipeline(pipe, {
                model,
                backend: 'webgpu',
            });

            const pending = transcribeTestChunk(workerSelf, 17, {
                model,
                chunkLengthS: 8,
            });
            await Promise.resolve();
            await Promise.resolve();
            await vi.advanceTimersByTimeAsync(300_000);
            await pending;

            expect(errorLog).toHaveBeenCalledWith(
                '[Whisper Worker] Inference hard ceiling exceeded',
                expect.objectContaining({
                    chunkId: 17,
                    chunkLengthS: 8,
                    elapsedMs: 300_000,
                    budgetMs: 300_000,
                    kind: 'cold-start',
                    backend: 'webgpu',
                    model,
                }),
            );
            const poisonedIndex = emitted.findIndex(message => message.status === 'worker-poisoned');
            const poisonedCallIndex = postMessage.mock.calls.findIndex(
                ([message]) => message.status === 'worker-poisoned',
            );
            expect(poisonedIndex).toBeGreaterThanOrEqual(0);
            expect(errorLog.mock.invocationCallOrder[0]).toBeLessThan(
                postMessage.mock.invocationCallOrder[poisonedCallIndex],
            );
            expect(emitted[poisonedIndex]).toMatchObject({
                status: 'worker-poisoned',
                chunkId: 17,
                data: {
                    reason: 'inference-timeout',
                    gpuFailure: false,
                    chunkId: 17,
                    chunkLengthS: 8,
                    elapsedMs: 300_000,
                    budgetMs: 300_000,
                    kind: 'cold-start',
                    backend: 'webgpu',
                    model,
                },
            });
            expect(emitted.findIndex(message => (
                message.status === 'error' && message.chunkId === 17
            ))).toBeGreaterThan(poisonedIndex);
        } finally {
            vi.useRealTimers();
        }
    });

    it('lengthens a warm budget from recent completed direct inference', async () => {
        vi.useFakeTimers();
        try {
            const model = 'onnx-community/whisper-base_timestamped';
            const emitted: any[] = [];
            let invocation = 0;
            const pipe: any = vi.fn(() => {
                invocation++;
                if (invocation === 1) {
                    return new Promise(resolve => {
                        setTimeout(() => resolve({
                            text: '完了',
                            chunks: [{ text: '完了', timestamp: [0, 2] }],
                        }), 100_000);
                    });
                }
                return new Promise<any>(() => {});
            });
            pipe.tokenizer = {};
            const workerSelf = createTestWorker(message => emitted.push(message));
            vi.spyOn(console, 'error').mockImplementation(() => {});
            workerSelf.__whisperTestSetPipeline(pipe, {
                model,
                backend: 'webgpu',
            });

            const first = transcribeTestChunk(workerSelf, 21, {
                model,
                chunkLengthS: 8,
            });
            await Promise.resolve();
            await Promise.resolve();
            await vi.advanceTimersByTimeAsync(100_000);
            await expect(first).resolves.toMatchObject({ inferenceElapsedMs: 100_000 });

            const second = transcribeTestChunk(workerSelf, 22, {
                model,
                chunkLengthS: 8,
            });
            await Promise.resolve();
            await Promise.resolve();
            await vi.advanceTimersByTimeAsync(149_999);
            expect(emitted).not.toContainEqual(expect.objectContaining({
                status: 'worker-poisoned',
                chunkId: 22,
            }));
            await vi.advanceTimersByTimeAsync(1);
            await second;

            expect(emitted).toContainEqual(expect.objectContaining({
                status: 'worker-poisoned',
                chunkId: 22,
                data: expect.objectContaining({
                    reason: 'inference-timeout',
                    gpuFailure: false,
                    model,
                    chunkLengthS: 8,
                    elapsedMs: 150_000,
                    budgetMs: 150_000,
                    kind: 'warm',
                    observedInferenceMs: 100_000,
                }),
            }));
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not retry on a pipeline whose uncancellable inference timed out', () => {
        const code = __getWhisperWorkerCodeForTests();
        const timeoutGuard = code.indexOf('if (initialTimeout)');
        const wordRetry = code.indexOf('const isWordTimestampCapabilityError');

        expect(timeoutGuard).toBeGreaterThan(0);
        expect(wordRetry).toBeGreaterThan(timeoutGuard);
        expect(code.slice(timeoutGuard, wordRetry)).toContain(
            'haltTimedOutWorker(chunkId, initialMsg, initialTimeout)',
        );
        expect(code.slice(timeoutGuard, wordRetry)).toContain('return null');
        expect(code).toContain('workerPoisoned = true');
        expect(code).toContain("postDropped(queued, 'worker-poisoned')");
        expect(code).toContain('if (!workerPoisoned) processNextJob()');
        expect(code).not.toContain('index out of bounds|timed out|reading');
    });

    it('loads the requested multilingual model unchanged on WASM', () => {
        const code = __getWhisperWorkerCodeForTests();
        expect(code).toContain('const requestedBackend = settings.backend;');
        expect(code).toContain("requestedBackend !== 'webgpu' && requestedBackend !== 'wasm'");
        expect(code).toContain("pipeline('automatic-speech-recognition', modelName, wasmOpts)");
        expect(code).not.toContain("status: 'fallback'");
        expect(code).not.toContain('FALLBACK_MODEL');
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

    it('retries only transport, auth, and transient hub responses on the mirror', async () => {
        const workerSelf = createTestWorker();
        const retryable = workerSelf.__whisperTestIsRetryableHubLoadError;

        expect(retryable(new TypeError('Failed to fetch decoder_model_merged.onnx'))).toBe(true);
        expect(retryable(Object.assign(new Error('Service unavailable'), { status: 503 }))).toBe(true);
        expect(retryable(new Error('Unauthorized access to file: generation_config.json'))).toBe(true);
        expect(retryable(Object.assign(new Error('Missing model'), { status: 404 }))).toBe(false);
        expect(retryable(new Error('WebGPU Context Provider: GPUDevice lost'))).toBe(false);
        expect(retryable(new Error('RangeError while creating ORT session'))).toBe(false);
        expect(retryable(new Error('requestAdapter timed out'))).toBe(false);
        expect(retryable(new Error('tensor dimension 503 is invalid'))).toBe(false);
        expect(retryable(new Error('Load failed'))).toBe(false);
        expect(retryable(new TypeError('Load failed'))).toBe(true);
    });

    it('retries the exact WASM model on a network failure without changing its backend', async () => {
        const loadedPipe = { dispose: vi.fn() };
        const pipeline = vi.fn()
            .mockRejectedValueOnce(new TypeError('Failed to fetch decoder_model_merged.onnx'))
            .mockResolvedValueOnce(loadedPipe);
        const { workerSelf, testEnv } = setupPipelineLoader(pipeline);

        await expect(loadTimestampedTinyOnWasm(workerSelf)).resolves.toBe(loadedPipe);

        expect(pipeline).toHaveBeenCalledTimes(2);
        expect(pipeline.mock.calls.map(([, model, options]) => ({
            model,
            device: options.device,
        }))).toEqual([
            { model: TIMESTAMPED_TINY_MODEL, device: 'wasm' },
            { model: TIMESTAMPED_TINY_MODEL, device: 'wasm' },
        ]);
        expect(testEnv.remoteHost).toBe('https://hf-mirror.com');
    });

    it('never retries a poisoned ORT load on another hub', async () => {
        const pipeline = vi.fn()
            .mockRejectedValue(new Error('WebGPU Context Provider failed while creating ORT session'));
        const { workerSelf, testEnv } = setupPipelineLoader(pipeline);

        await expect(loadTimestampedTinyOnWasm(workerSelf)).rejects.toMatchObject({
            whisperLoadFailure: expect.objectContaining({
                model: TIMESTAMPED_TINY_MODEL,
                backend: 'wasm',
            }),
        });

        expect(pipeline).toHaveBeenCalledTimes(1);
        expect(testEnv.remoteHost).toBe('https://huggingface.co');
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
        expect(code).toContain('WhisperTextStreamer = mod.WhisperTextStreamer');
        expect(code).toContain('const Streamer = WhisperTextStreamer || TextStreamer');
        expect(code).toContain('new Streamer(');
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

    it('enables word timestamps only for timestamped exports with an evidence-based capability cache', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain("wordTimestampsEnabled = /_timestamped$/i.test");
        expect(code).toContain('const useWordTimestamps = wordTimestampsEnabled && wordTimestampsSupported !== false');
        expect(code).toContain("wordTimestampsSupported = null");
    });

    it('remembers a missing cross-attention export and skips later word-timestamp retries', async () => {
        const emitted: any[] = [];
        const timestampModes: unknown[] = [];
        let invocation = 0;
        const pipe: any = vi.fn(async (_audio: Float32Array, options: any) => {
            timestampModes.push(options.return_timestamps);
            invocation += 1;
            if (invocation === 1) {
                throw new Error('Model outputs must contain cross attentions to extract timestamps');
            }
            return {
                text: 'お邪魔します',
                chunks: [{ text: 'お邪魔します', timestamp: [0, 2] }],
            };
        });
        pipe.tokenizer = {};
        const workerSelf = createTestWorker(message => emitted.push(message));
        workerSelf.__whisperTestSetPipeline(pipe, {
            model: 'custom/whisper-unknown-attention-export_timestamped',
            backend: 'webgpu',
            WhisperTextStreamer: class {
                constructor() {}
            },
        });

        await transcribeTestChunk(workerSelf, 1, {
            model: 'custom/whisper-unknown-attention-export_timestamped',
        });
        await transcribeTestChunk(workerSelf, 2, {
            model: 'custom/whisper-unknown-attention-export_timestamped',
        });

        expect(timestampModes).toEqual(['word', true, true]);
        expect(workerSelf.__whisperTestGetTimestampCapability()).toEqual({
            enabled: true,
            supported: false,
        });
        expect(emitted.filter(message => message.status === 'error')).toEqual([]);
    });

    it('keeps word timestamps enabled after a successful timestamped-model probe', async () => {
        const timestampModes: unknown[] = [];
        const pipe = createSuccessfulTimestampPipe(timestampModes);
        const workerSelf = createTestWorker();
        workerSelf.__whisperTestSetPipeline(pipe, {
            model: TIMESTAMPED_TINY_MODEL,
            backend: 'wasm',
        });

        for (const chunkId of [1, 2]) {
            await transcribeTestChunk(workerSelf, chunkId, {
                backend: 'wasm',
            });
        }

        expect(timestampModes).toEqual(['word', 'word']);
        expect(workerSelf.__whisperTestGetTimestampCapability()).toEqual({
            enabled: true,
            supported: true,
        });
    });

    it('uses segment timestamps directly for a non-timestamped export', async () => {
        const timestampModes: unknown[] = [];
        const pipe = createSuccessfulTimestampPipe(timestampModes);
        const workerSelf = createTestWorker();
        workerSelf.__whisperTestSetPipeline(pipe, {
            model: 'custom/whisper-no-alignment-export',
            backend: 'webgpu',
        });

        await transcribeTestChunk(workerSelf, 1, {
            model: 'custom/whisper-no-alignment-export',
        });

        expect(timestampModes).toEqual([true]);
        expect(workerSelf.__whisperTestGetTimestampCapability()).toEqual({
            enabled: false,
            supported: null,
        });
    });

    it('does not retry or poison the timestamp capability cache for unrelated inference failures', async () => {
        const pipe: any = vi.fn().mockRejectedValue(new Error('decoder input shape is invalid'));
        pipe.tokenizer = {};
        const emitted: any[] = [];
        const workerSelf = createTestWorker(message => emitted.push(message));
        workerSelf.__whisperTestSetPipeline(pipe, {
            model: TIMESTAMPED_TINY_MODEL,
            backend: 'webgpu',
        });

        await transcribeTestChunk(workerSelf, 1);

        expect(pipe).toHaveBeenCalledTimes(1);
        expect(workerSelf.__whisperTestGetTimestampCapability()).toEqual({
            enabled: true,
            supported: null,
        });
        expect(emitted).toContainEqual(expect.objectContaining({
            status: 'error',
            data: { message: 'decoder input shape is invalid' },
        }));
    });

    it('detects WebGPU adapter with power preference', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain('navigator.gpu.requestAdapter(');
        expect(code).toContain('powerPreference');
        expect(code).toContain("{ options: {}, label: 'browser-default' }");
        // Scoring removed — simplified to preferred + fallback
        expect(code).not.toContain('scoreAdapter');
    });

    it('accepts a portable 256 MiB adapter and retries without power preference for Firefox', async () => {
        const adapter = {
            get info() {
                throw new Error('adapter info hidden');
            },
            limits: { maxBufferSize: 256 * 1024 * 1024 },
        };
        const requestAdapter = vi.fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(adapter);
        vi.stubGlobal('navigator', { gpu: { requestAdapter } });
        const workerSelf = createTestWorker();
        workerSelf.__whisperTestConfigureBackend({
            minWebgpuBufferBytes: 256 * 1024 * 1024,
        });

        const backend = await workerSelf.__whisperTestDetectBackend();

        expect(requestAdapter).toHaveBeenNthCalledWith(1, { powerPreference: 'high-performance' });
        expect(requestAdapter).toHaveBeenNthCalledWith(2, {});
        expect(backend.device).toBe('webgpu');
        expect(backend.maxBuf).toBe(256 * 1024 * 1024);
        expect(backend.adapter).toBe(adapter);
    });

    it('reports a selected-model capacity miss without substituting a model or backend', async () => {
        const requestAdapter = vi.fn().mockResolvedValue({
            info: { vendor: 'Mozilla Apple M1, or Similar' },
            limits: { maxBufferSize: 256 * 1024 * 1024 },
        });
        vi.stubGlobal('navigator', { gpu: { requestAdapter } });
        const workerSelf = createTestWorker();
        workerSelf.__whisperTestConfigureBackend({
            minWebgpuBufferBytes: 512 * 1024 * 1024,
        });

        const backend = await workerSelf.__whisperTestDetectBackend();

        expect(backend.device).toBeNull();
        expect(backend.reason).toContain('below model requirement');

        const portableBackend = await workerSelf.__whisperTestDetectBackend(256 * 1024 * 1024);
        expect(portableBackend.device).toBe('webgpu');
        expect(portableBackend.maxBuf).toBe(256 * 1024 * 1024);
        expect(__getWhisperWorkerCodeForTests()).not.toContain('FALLBACK_MODEL');
        expect(__getWhisperWorkerCodeForTests()).not.toContain("status: 'fallback'");
    });

    it('rejects a hidden-info fallback adapter and accepts the browser-default hardware adapter', async () => {
        const fallbackAdapter = {
            isFallbackAdapter: true,
            get info() {
                throw new Error('adapter info hidden');
            },
            limits: { maxBufferSize: 256 * 1024 * 1024 },
        };
        const hardwareAdapter = {
            isFallbackAdapter: false,
            info: { vendor: 'Apple' },
            limits: { maxBufferSize: 1024 * 1024 * 1024 },
        };
        const requestAdapter = vi.fn()
            .mockResolvedValueOnce(fallbackAdapter)
            .mockResolvedValueOnce(hardwareAdapter);
        vi.stubGlobal('navigator', { gpu: { requestAdapter } });
        const workerSelf = createTestWorker();
        workerSelf.__whisperTestConfigureBackend({
            gpuVendorHint: 'apple m1',
        });

        const backend = await workerSelf.__whisperTestDetectBackend();

        expect(requestAdapter).toHaveBeenNthCalledWith(1, { powerPreference: 'high-performance' });
        expect(requestAdapter).toHaveBeenNthCalledWith(2, {});
        expect(backend.device).toBe('webgpu');
        expect(backend.adapter).toBe(hardwareAdapter);
    });

    it('reports unavailable WebGPU after both adapter candidates are fallback devices', async () => {
        const fallbackAdapter = {
            isFallbackAdapter: true,
            info: { vendor: 'Hidden' },
            limits: { maxBufferSize: 256 * 1024 * 1024 },
        };
        const requestAdapter = vi.fn().mockResolvedValue(fallbackAdapter);
        vi.stubGlobal('navigator', { gpu: { requestAdapter } });
        const workerSelf = createTestWorker();

        const backend = await workerSelf.__whisperTestDetectBackend();

        expect(requestAdapter).toHaveBeenCalledTimes(2);
        expect(backend).toMatchObject({
            device: null,
            reason: 'software/fallback WebGPU adapter rejected',
        });
    });

    it('bounds a hung adapter probe and reports WebGPU unavailable', async () => {
        vi.useFakeTimers();
        try {
            const requestAdapter = vi.fn(() => new Promise(() => {}));
            vi.stubGlobal('navigator', { gpu: { requestAdapter } });
            const workerSelf = createTestWorker();
            workerSelf.__whisperTestConfigureBackend({ adapterProbeTimeoutMs: 5 });

            const pending = workerSelf.__whisperTestDetectBackend();
            await vi.advanceTimersByTimeAsync(5);
            const backend = await pending;

            expect(requestAdapter).toHaveBeenCalledTimes(1);
            expect(backend).toMatchObject({
                device: null,
                reason: 'requestAdapter timed out for high-performance',
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('applies the validated adapter and power policy to the actual ORT runtime', () => {
        vi.stubGlobal('navigator', {});
        const workerSelf = createTestWorker();
        workerSelf.__whisperTestConfigureBackend({ preferLowPowerAdapter: true });
        const adapter = { limits: { maxBufferSize: 256 * 1024 * 1024 } };
        const testEnv = { backends: { onnx: { webgpu: {} as Record<string, unknown> } } };

        expect(workerSelf.__whisperTestConfigureWebGpuRuntime(testEnv, adapter)).toBe(true);
        expect(testEnv.backends.onnx.webgpu).toEqual({
            powerPreference: 'low-power',
            forceFallbackAdapter: false,
            adapter,
        });
    });

    it('rejects software WebGPU adapters without changing the requested model', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain('swiftshader|llvmpipe|software|softpipe');
        expect(code).toContain('Rejected software/fallback WebGPU adapter');
        expect(code).not.toContain('FALLBACK_MODEL');
        expect(code).not.toContain("status: 'fallback'");
    });

    it('reuses existing pipeline when model matches', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain('pipelinePromise');
        expect(code).toContain('currentModel === modelName');
        expect(code).toContain('currentBackend === requestedBackend');
        expect(code).toContain('pipelineLoadPromise && pipelineLoadKey === loadingKey');
        expect(code).toContain("const loadingKey = settings.model + '|' + String(settings.multilingual)");
        expect(code).toContain('String(settings.backend)');
    });

    it('rejects a missing or invalid backend instead of defaulting to WebGPU', async () => {
        let messageHandler: ((event: MessageEvent) => Promise<void>) | null = null;
        const workerSelf: any = {
            addEventListener: vi.fn((type: string, handler: (event: MessageEvent) => Promise<void>) => {
                if (type === 'message') messageHandler = handler;
            }),
            postMessage: vi.fn(),
        };
        new Function('self', __getWhisperWorkerCodeForTests(true))(workerSelf);

        expect(messageHandler).not.toBeNull();
        await messageHandler!({
            data: {
                type: 'init',
                model: 'onnx-community/whisper-tiny',
                multilingual: true,
                backend: 'cuda',
            },
        } as MessageEvent);

        expect(workerSelf.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            status: 'load-failed',
            backend: 'cuda',
            model: 'onnx-community/whisper-tiny',
            data: expect.objectContaining({
                message: expect.stringContaining('must be explicitly selected'),
            }),
        }));
        expect(__getWhisperWorkerCodeForTests()).not.toContain(
            "settings.backend === 'wasm' ? 'wasm' : 'webgpu'",
        );
    });

    it('supports host control messages for backend/queue lifecycle', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).not.toContain("if (msg.type === 'skip-webgpu')");
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

    it('replaces an equal-distance live window with the newer time range', () => {
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

        send({
            type: 'transcribe', chunkId: 1, priority: 0,
            playheadDistance: 8, timeOffset: 0, chunkLengthS: 6,
        });
        send({
            type: 'transcribe', chunkId: 2, priority: 0,
            playheadDistance: 8, timeOffset: 6, chunkLengthS: 8,
        });
        send({
            type: 'transcribe', chunkId: 3, priority: 0,
            playheadDistance: 8, timeOffset: 12, chunkLengthS: 8,
        });

        expect(emitted).toContainEqual(expect.objectContaining({
            status: 'dropped',
            chunkId: 2,
            data: expect.objectContaining({ reason: 'queue-replaced', replacedByChunkId: 3 }),
        }));
        expect(emitted).not.toContainEqual(expect.objectContaining({
            status: 'dropped',
            chunkId: 3,
            data: expect.objectContaining({ reason: 'queue-full' }),
        }));
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
        workerSelf.__whisperTestHalt(1, 'webgpu inference timed out after 120s', {
            chunkId: 1,
            elapsedMs: 120_000,
            budgetMs: 120_000,
            kind: 'warm',
            backend: 'webgpu',
        });
        send({ type: 'transcribe', chunkId: 3, priority: 0 });

        expect(transcribe).toHaveBeenCalledTimes(1);
        expect(emitted).toContainEqual(expect.objectContaining({
            status: 'worker-poisoned',
            data: expect.objectContaining({
                reason: 'inference-timeout',
                gpuFailure: false,
                kind: 'warm',
            }),
        }));
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

describe('split-device session options', () => {
    it('applies basic graph optimization when the decoder is split onto WASM', () => {
        const workerSelf = createTestWorker();
        const device = workerSelf.__whisperTestResolveDeviceForModules(true);

        // Firefox's timer-polled readback always selects the split layout.
        expect(device).toEqual({ encoder_model: 'webgpu', decoder_model_merged: 'wasm' });
        // Without this, ORT's extended optimizer fails session creation with
        // `qdq_actions.cc TransposeDQWeightsForMatMulNBits` on the q8 decoder.
        expect(workerSelf.__whisperTestGetSessionOptionsForDevice(device)).toEqual({
            graphOptimizationLevel: 'basic',
        });
    });

    it('leaves an all-WebGPU layout on the extended optimizer', () => {
        const workerSelf = createTestWorker();
        const device = workerSelf.__whisperTestResolveDeviceForModules(false);

        expect(device).toBe('webgpu');
        expect(workerSelf.__whisperTestGetSessionOptionsForDevice(device)).toBeNull();
    });

    it('wires the split session options into the WebGPU pipeline call', () => {
        const code = __getWhisperWorkerCodeForTests(true);
        expect(code).toContain('const splitSessionOptions = getSessionOptionsForDevice(resolvedDevice);');
        expect(code).toContain('...(splitSessionOptions ? { session_options: splitSessionOptions } : {})');
    });
});
