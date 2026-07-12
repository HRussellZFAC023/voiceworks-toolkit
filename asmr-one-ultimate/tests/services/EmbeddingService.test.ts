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
