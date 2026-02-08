import { SharedCache, CacheKeys } from '../core/Cache';
import { I18n } from '../core/Config';
import { Logger } from '../core/Utils';
import { EventBus } from '../core/EventBus';
import { GpuScheduler, Priority, type WorkerName } from '../core/GpuScheduler';
import { createEmbeddingWorker } from '../features/EmbeddingWorkerLoader';
import { DeviceCapabilities } from '../core/DeviceCapabilities';

// ============================================================================
// Constants
// ============================================================================

const EMBEDDING_MODEL = 'Xenova/multilingual-e5-small';
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const IDLE_UNLOAD_MS = 15 * 60 * 1000; // 15 minutes
const SINGLE_TIMEOUT_MS = 30_000;
const BATCH_TIMEOUT_BASE_MS = 30_000;
const BATCH_TIMEOUT_PER_ITEM_MS = 200;

// Circuit breaker: kill & recreate worker after consecutive GPU errors
const CIRCUIT_BREAKER_THRESHOLD = 3;
const GPU_ERROR_PATTERN = /createBuffer|RangeError|out of memory|OOM|allocation|device lost|GPUDevice|mapAsync|Instance reference/i;

// ============================================================================
// Worker State
// ============================================================================

interface PendingRequest {
    resolve: (val: any) => void;
    reject: (err: any) => void;
    timer: ReturnType<typeof setTimeout>;
}

let worker: Worker | null = null;
let workerReady = false;
let initPromise: Promise<void> | null = null;
let webgpuFailed = false;
let rememberedDtype = SharedCache.get<string>(CacheKeys.embeddingPreferredDtype()) || '';
const pending = new Map<number, PendingRequest>();
let nextId = 0;

// In-flight dedup
const embedInFlight = new Map<string, Promise<number[]>>();

// Circuit breaker state
let consecutiveGpuErrors = 0;
let circuitRecoveryAttempted = false;
let serviceDead = false;

// No cross-service webgpu:failed propagation — each service independently tries WebGPU.
// Serialized warmup prevents device contention; fp32 dtype fix handles Intel GPUs.

// Idle unload
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function resetIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        if (worker && pending.size === 0) {
            Logger.log('[EmbeddingService] Idle timeout, unloading worker');
            terminateWorker();
        }
    }, IDLE_UNLOAD_MS);
}

function terminateWorker(): void {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (worker) {
        const dyingWorker = worker;
        dyingWorker.postMessage({ type: 'cleanup' });
        setTimeout(() => dyingWorker.terminate(), 300);
        for (const [, req] of pending) {
            clearTimeout(req.timer);
            req.reject(new Error('Worker terminated'));
        }
        pending.clear();
        worker = null;
        workerReady = false;
        initPromise = null;
    }
}

function isGpuError(msg: string): boolean {
    return GPU_ERROR_PATTERN.test(msg);
}

function handleCircuitBreaker(errorMsg: string): void {
    if (!isGpuError(errorMsg)) {
        // Non-GPU error — don't count toward circuit breaker
        return;
    }

    consecutiveGpuErrors++;
    Logger.warn(`[EmbeddingService] GPU error ${consecutiveGpuErrors}/${CIRCUIT_BREAKER_THRESHOLD}: ${errorMsg}`);

    if (consecutiveGpuErrors >= CIRCUIT_BREAKER_THRESHOLD) {
        if (circuitRecoveryAttempted) {
            // Already tried WASM recovery once — service is dead
            Logger.error('[EmbeddingService] WASM recovery also failed — service degraded');
            serviceDead = true;
            // Reject all pending requests immediately
            for (const [id, req] of pending) {
                clearTimeout(req.timer);
                req.reject(new Error('Embedding service unavailable (GPU and WASM failed)'));
                pending.delete(id);
            }
            EventBus.emit('embedding:dead', {});
            return;
        }

        // Circuit breaker tripped — kill worker and recreate on WASM
        Logger.warn('[EmbeddingService] Circuit breaker tripped — killing worker, will recreate on WASM');
        webgpuFailed = true;
        EventBus.emit('webgpu:failed', { source: 'embedding' });
        SharedCache.set(CacheKeys.embeddingPreferredDtype(), '', CACHE_TTL_MS); // Clear GPU dtype preference
        circuitRecoveryAttempted = true;
        consecutiveGpuErrors = 0;

        // Terminate kills worker and rejects all pending requests
        terminateWorker();

        // Emit event so other systems (Whisper, Translation) know GPU is dead
        EventBus.emit('embedding:gpu-failed', {});
    }
}

function handleMessage(e: MessageEvent): void {
    const msg = e.data;

    if (msg.status === 'initiate') {
        return;
    }

    if (msg.status === 'ready') {
        workerReady = true;
        if (msg.dtype) {
            rememberedDtype = msg.dtype;
            SharedCache.set(CacheKeys.embeddingPreferredDtype(), msg.dtype, CACHE_TTL_MS);
        }
        if (msg.backend === 'wasm' && !webgpuFailed) {
            webgpuFailed = true;
            EventBus.emit('webgpu:failed', { source: 'embedding' });
        }
        Logger.log(`[EmbeddingService] Model ready on ${msg.backend} [${msg.dtype}]`);
        EventBus.emit('embedding:progress', {
            percent: 100,
            message: I18n.t('embeddingModelReady'),
            stage: 'ready',
        });
        return;
    }

    if (msg.status === 'progress') {
        EventBus.emit('embedding:progress', {
            percent: Math.round(msg.progress || 0),
            message: msg.file ? I18n.format('embeddingLoadingFile', { file: msg.file }) : I18n.t('embeddingLoading'),
            stage: 'model',
        });
        return;
    }

    if (msg.status === 'gpu-device-lost') {
        // Transient GPU device loss — worker will recover with fresh device on next call.
        // Don't count toward circuit breaker, but notify scheduler.
        Logger.warn('[EmbeddingService] GPU device lost (transient):', msg.data?.message);
        EventBus.emit('gpu:device-lost', { worker: 'embedding' as const });
        return;
    }

    if (msg.status === 'error') {
        const err = msg.data?.message || 'Unknown worker error';
        if (msg.id && pending.has(msg.id)) {
            const req = pending.get(msg.id)!;
            clearTimeout(req.timer);
            req.reject(new Error(err));
            pending.delete(msg.id);
        } else {
            Logger.error('[EmbeddingService] Worker error:', err);
        }
        // Check circuit breaker for GPU errors
        handleCircuitBreaker(err);
        return;
    }

    if (msg.status === 'complete') {
        if (msg.id && pending.has(msg.id)) {
            const req = pending.get(msg.id)!;
            clearTimeout(req.timer);
            req.resolve(msg.data);
            pending.delete(msg.id);
        }
        // Success — reset GPU error counter
        consecutiveGpuErrors = 0;
        GpuScheduler.onGpuSuccess();
    }
}

function initWorker(): Promise<void> {
    if (workerReady) return Promise.resolve();
    if (initPromise) return initPromise;

    initPromise = new Promise<void>((resolve, reject) => {
        try {
            EventBus.emit('embedding:progress', {
                percent: 0,
                message: I18n.t('embeddingLoading'),
                stage: 'model',
            });

            worker = createEmbeddingWorker();

            if (webgpuFailed) {
                worker.postMessage({ type: 'skip-webgpu' });
            }
            // Only send cached dtype hint if it's relevant. WASM-only dtypes (q8/q4)
            // are useless when GPU is available — worker uses fp32 on WebGPU anyway,
            // and q8 is the default WASM fallback order.
            const isWasmOnlyDtype = ['q8', 'q4'].includes(rememberedDtype);
            if (rememberedDtype && !(isWasmOnlyDtype && DeviceCapabilities.profile.hasGpu && !webgpuFailed)) {
                worker.postMessage({ type: 'preferred-dtype', dtype: rememberedDtype });
            }

            const onReady = (e: MessageEvent) => {
                if (e.data.status === 'ready') {
                    handleMessage(e);
                    resolve();
                } else if (e.data.status === 'error' && !workerReady) {
                    handleMessage(e);
                    reject(new Error(e.data.data?.message || 'Worker init failed'));
                } else {
                    handleMessage(e);
                }
            };

            worker.onmessage = (e: MessageEvent) => {
                if (!workerReady && (e.data.status === 'ready' || (e.data.status === 'error' && !e.data.id))) {
                    onReady(e);
                    // Switch to normal handler after init
                    if (workerReady && worker) {
                        worker.onmessage = handleMessage;
                    }
                } else {
                    handleMessage(e);
                }
            };

            worker.postMessage({ type: 'init', model: EMBEDDING_MODEL });
        } catch (err) {
            terminateWorker();
            reject(err);
        }
    });

    return initPromise;
}

function sendToWorker(type: 'embed' | 'embed-batch', payload: string | string[], timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
        if (!worker || !workerReady) {
            reject(new Error('Worker not ready'));
            return;
        }

        const id = ++nextId;
        const timer = setTimeout(() => {
            if (pending.has(id)) {
                pending.delete(id);
                reject(new Error('Embedding timeout'));
            }
        }, timeoutMs);

        pending.set(id, { resolve, reject, timer });

        if (type === 'embed') {
            worker.postMessage({ type: 'embed', text: payload, id });
        } else {
            worker.postMessage({ type: 'embed-batch', texts: payload, id });
        }
    });
}

// ============================================================================
// Public API
// ============================================================================

export const EmbeddingService = {
    model: EMBEDDING_MODEL,

    async ensureReady(): Promise<void> {
        if (!DeviceCapabilities.budget.embeddingEnabled) {
            throw new Error('Embedding disabled on constrained device');
        }
        await initWorker();
        resetIdleTimer();
    },

    /**
     * Embed a single text. Prepends E5 task prefix automatically.
     * @param text - Raw text to embed
     * @param task - 'query' or 'passage'
     * @param options - priority (default LOW), cancellable (default false)
     * @returns Normalized 384-dim float32 vector
     */
    async embed(text: string, task: 'query' | 'passage' = 'query', options?: { priority?: Priority; cancellable?: boolean }): Promise<number[]> {
        if (serviceDead || !DeviceCapabilities.budget.embeddingEnabled) throw new Error('Embedding service unavailable');
        resetIdleTimer();
        const prefixed = task === 'query' ? `query: ${text}` : `passage: ${text}`;

        // In-flight dedup
        const flightKey = `${task}:${text}`;
        const existing = embedInFlight.get(flightKey);
        if (existing) return existing;

        const promise = (async () => {
            await initWorker();
            return GpuScheduler.enqueue({
                priority: options?.priority ?? Priority.LOW,
                worker: 'embedding',
                execute: () => sendToWorker('embed', prefixed, SINGLE_TIMEOUT_MS),
                cancellable: options?.cancellable,
            });
        })();

        embedInFlight.set(flightKey, promise);
        try {
            return await promise;
        } finally {
            embedInFlight.delete(flightKey);
        }
    },

    /**
     * Embed a batch of texts.
     * @param texts - Array of raw texts
     * @param task - 'query' or 'passage'
     * @returns Array of normalized 384-dim float32 vectors
     */
    async embedBatch(texts: string[], task: 'query' | 'passage' = 'passage'): Promise<number[][]> {
        if (serviceDead || !DeviceCapabilities.budget.embeddingEnabled) throw new Error('Embedding service unavailable');
        if (texts.length === 0) return [];
        resetIdleTimer();

        const prefixed = texts.map(t =>
            task === 'query' ? `query: ${t}` : `passage: ${t}`
        );

        await initWorker();
        const timeoutMs = BATCH_TIMEOUT_BASE_MS + texts.length * BATCH_TIMEOUT_PER_ITEM_MS;
        // Batch embedding is LOW priority and cancellable
        return GpuScheduler.enqueue({
            priority: Priority.LOW,
            worker: 'embedding',
            execute: () => sendToWorker('embed-batch', prefixed, timeoutMs),
            cancellable: true,
        });
    },

    isReady(): boolean {
        return workerReady;
    },

    isDead(): boolean {
        return serviceDead;
    },

    terminate(): void {
        terminateWorker();
    },
};
