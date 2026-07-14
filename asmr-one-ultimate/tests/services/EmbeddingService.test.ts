import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    releaseLease: vi.fn(),
    worker: {
        postMessage: vi.fn(),
        terminate: vi.fn(),
        onmessage: null as ((event: MessageEvent) => void) | null,
    },
    crashComplete: vi.fn(),
}));

vi.mock('../../src/core/Cache', () => ({
    SharedCache: { get: vi.fn(() => null), set: vi.fn() },
    CacheKeys: { embeddingPreferredDtype: () => 'embedding-dtype' },
}));

vi.mock('../../src/core/Config', () => ({
    I18n: { t: (key: string) => key, format: (key: string) => key },
}));

vi.mock('../../src/core/Utils', () => ({
    Logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/core/EventBus', () => ({
    EventBus: { on: vi.fn(), emit: vi.fn() },
}));

vi.mock('../../src/core/GpuScheduler', () => ({
    Priority: { REALTIME: 0, HIGH: 1, NORMAL: 2, LOW: 3 },
    GpuScheduler: {
        acquireLoadLease: vi.fn(async () => mocks.releaseLease),
        getMemoryPressure: vi.fn(() => 'low'),
        onGpuSuccess: vi.fn(),
        enqueue: vi.fn(),
    },
}));

vi.mock('../../src/features/EmbeddingWorkerLoader', () => ({
    createEmbeddingWorker: vi.fn(() => mocks.worker),
}));

vi.mock('../../src/core/DeviceCapabilities', () => ({
    DeviceCapabilities: {
        profile: { hasGpu: true, gpuVendor: 'test', tier: 'full' },
        budget: { embeddingEnabled: true },
    },
}));

vi.mock('../../src/core/MLCrashGuard', () => ({
    MLCrashGuard: {
        initStarted: vi.fn(),
        initComplete: mocks.crashComplete,
        initFailed: vi.fn(),
    },
}));

describe('EmbeddingService model loading', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    it('pins semantic embeddings to the required WASM q8 artifact before initialization', async () => {
        const { GpuScheduler } = await import('../../src/core/GpuScheduler');
        vi.mocked(GpuScheduler.enqueue).mockResolvedValue([1, 0]);
        const { EmbeddingService } = await import('../../src/services/EmbeddingService');
        const embedding = EmbeddingService.embed('needle', 'query', { semanticBaselineCompatible: true });

        await vi.waitFor(() => expect(mocks.worker.onmessage).toBeTypeOf('function'));
        const messagesBeforeInit = mocks.worker.postMessage.mock.calls.map(([message]) => message);
        expect(messagesBeforeInit).toEqual(expect.arrayContaining([
            { type: 'skip-webgpu' },
            { type: 'required-dtype', dtype: 'q8' },
        ]));
        const initIndex = messagesBeforeInit.findIndex((message) => message.type === 'init');
        expect(messagesBeforeInit.findIndex((message) => message.type === 'required-dtype')).toBeLessThan(initIndex);

        mocks.worker.onmessage?.({ data: { status: 'ready', backend: 'wasm', dtype: 'q8' } } as MessageEvent);
        await expect(embedding).resolves.toEqual([1, 0]);
        EmbeddingService.terminate();
    });

    it('releases the global load lease and terminates a hung worker', async () => {
        vi.useFakeTimers();
        const { EmbeddingService } = await import('../../src/services/EmbeddingService');
        const ready = EmbeddingService.ensureReady();
        const rejected = expect(ready).rejects.toThrow('Embedding model load timed out');

        await vi.advanceTimersByTimeAsync(120_001);
        await rejected;

        expect(mocks.releaseLease).toHaveBeenCalledTimes(1);
        expect(mocks.crashComplete).toHaveBeenCalledWith('vectorSearch');
        expect(mocks.worker.postMessage).toHaveBeenCalledWith({ type: 'cleanup' });

        await vi.advanceTimersByTimeAsync(300);
        expect(mocks.worker.terminate).toHaveBeenCalledTimes(1);
    });
});
