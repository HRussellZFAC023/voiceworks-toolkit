import { SharedCache, CacheKeys } from '../core/Cache';
import { I18n } from '../core/Config';
import { Logger } from '../core/Utils';
import { EventBus } from '../core/EventBus';
import { GpuScheduler, Priority, type WorkerName } from '../core/GpuScheduler';
import { createEmbeddingWorker } from '../features/EmbeddingWorkerLoader';
import { DeviceCapabilities } from '../core/DeviceCapabilities';
import { CACHE_TTL } from '../core/Constants';
import { MLCrashGuard } from '../core/MLCrashGuard';

// ============================================================================
// Constants
// ============================================================================

const EMBEDDING_MODEL = 'Xenova/multilingual-e5-small';
const CACHE_TTL_MS = CACHE_TTL.THIRTY_DAYS_MS;
const IDLE_UNLOAD_MS = 15 * 60 * 1000; // 15 minutes
const SINGLE_TIMEOUT_MS = 30_000;
const BATCH_TIMEOUT_BASE_MS = 30_000;
const BATCH_TIMEOUT_PER_ITEM_MS = 200;
const EMBED_MAX_CHARS_FULL = 900;
const EMBED_MAX_CHARS_LIMITED = 640;
const EMBED_BATCH_MAX_ITEMS_FULL = 16;
const EMBED_BATCH_MAX_ITEMS_LIMITED = 8;
const EMBED_BATCH_MAX_CHARS_FULL = 6000;
const EMBED_BATCH_MAX_CHARS_LIMITED = 2400;

// Circuit breaker: kill & recreate worker after consecutive GPU errors
const CIRCUIT_BREAKER_THRESHOLD = 3;
const GPU_ERROR_PATTERN = /createBuffer|RangeError|out of memory|OOM|allocation|device lost|GPUDevice|mapAsync|mapping webgpu buffer|invalid buffer|Instance reference/i;
const EXPLICIT_DEVICE_LOSS_PATTERN = /device lost|Instance reference|release session|invalid session/i;

// ============================================================================
// Worker State
// ============================================================================

interface PendingRequest {
    resolve: (val: number[] | number[][]) => void;
    reject: (err: unknown) => void;
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

// No cross-service webgpu:failed propagation for dtype failures — each service independently
// tries WebGPU. But true GPU device loss (process crash) affects ALL workers.
EventBus.on('gpu:device-lost-broadcast', ({ source }) => {
    if (source === 'embedding') return; // Already handled by our own error path
    if (webgpuFailed) return; // Already on WASM
    Logger.warn(`[EmbeddingService] GPU device lost in ${source} worker — switching to WASM`);
    webgpuFailed = true;
    if (worker) {
        worker.postMessage({ type: 'skip-webgpu' });
    }
});

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
        Logger.warn('[EmbeddingService] GPU memory pressure at trip:', GpuScheduler.getMemoryPressure());
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
        const reason = String(msg.data?.message || '');
        Logger.warn('[EmbeddingService] GPU device-lost signal:', reason || '(no message)');
        if (EXPLICIT_DEVICE_LOSS_PATTERN.test(reason)) {
            EventBus.emit('gpu:device-lost', { worker: 'embedding' as const });
        } else {
            Logger.debug('[EmbeddingService] Ignoring non-fatal device-lost signal from worker');
        }
        return;
    }

    if (msg.status === 'gpu-fallback') {
        // Worker downgraded to WASM after a recoverable GPU error (e.g. createBuffer).
        // Do not cascade this as global device loss.
        const reason = String(msg.data?.message || '');
        Logger.warn('[EmbeddingService] GPU fallback to WASM:', reason || '(no message)');
        webgpuFailed = true;
        EventBus.emit('webgpu:failed', { source: 'embedding' });
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
        if (webgpuFailed && isGpuError(err)) {
            // Ignore stale GPU errors that arrive after we've already switched to WASM.
            Logger.debug('[EmbeddingService] Ignoring stale GPU error after WebGPU fallback:', err);
            return;
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
        GpuScheduler.onGpuSuccess('embedding');
    }
}

function initWorker(): Promise<void> {
    if (workerReady) return Promise.resolve();
    if (initPromise) return initPromise;

    MLCrashGuard.initStarted('vectorSearch');

    // Acquire a load lease from GpuScheduler to prevent concurrent model loading.
    // Only one worker loads a model at a time (requestAdapter + requestDevice + ONNX compile).
    initPromise = GpuScheduler.acquireLoadLease('embedding').then(releaseLease => {
        return new Promise<void>((resolve, reject) => {
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
                        MLCrashGuard.initComplete('vectorSearch');
                        handleMessage(e);
                        releaseLease();
                        resolve();
                    } else if (e.data.status === 'error' && !workerReady) {
                        MLCrashGuard.initFailed('vectorSearch');
                        handleMessage(e);
                        releaseLease();
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
                releaseLease();
                terminateWorker();
                reject(err);
            }
        });
    });

    return initPromise;
}

function sendToWorker(type: 'embed', payload: string, timeoutMs: number): Promise<number[]>;
function sendToWorker(type: 'embed-batch', payload: string[], timeoutMs: number): Promise<number[][]>;
function sendToWorker(type: 'embed' | 'embed-batch', payload: string | string[], timeoutMs: number): Promise<number[] | number[][]> {
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

function normalizeEmbedInput(text: string): string {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    const tier = DeviceCapabilities.profile.tier;
    const maxChars = tier === 'full' ? EMBED_MAX_CHARS_FULL : EMBED_MAX_CHARS_LIMITED;
    if (normalized.length <= maxChars) return normalized;
    return normalized.slice(0, maxChars);
}

function getEmbedBatchLimits(): { maxItems: number; maxChars: number } {
    const tier = DeviceCapabilities.profile.tier;
    const pressure = GpuScheduler.getMemoryPressure();

    let maxItems = tier === 'full' ? EMBED_BATCH_MAX_ITEMS_FULL : EMBED_BATCH_MAX_ITEMS_LIMITED;
    let maxChars = tier === 'full' ? EMBED_BATCH_MAX_CHARS_FULL : EMBED_BATCH_MAX_CHARS_LIMITED;

    if (pressure === 'medium') {
        maxItems = Math.max(4, Math.floor(maxItems * 0.75));
        maxChars = Math.max(1200, Math.floor(maxChars * 0.7));
    } else if (pressure === 'high') {
        maxItems = Math.max(2, Math.floor(maxItems * 0.5));
        maxChars = Math.max(900, Math.floor(maxChars * 0.45));
    }

    return { maxItems, maxChars };
}

function splitBatchByBudget(texts: string[]): string[][] {
    const { maxItems, maxChars } = getEmbedBatchLimits();
    const chunks: string[][] = [];
    let current: string[] = [];
    let chars = 0;

    for (const text of texts) {
        const nextChars = chars + text.length;
        const shouldSplit = current.length > 0 && (current.length >= maxItems || nextChars > maxChars);
        if (shouldSplit) {
            chunks.push(current);
            current = [];
            chars = 0;
        }
        current.push(text);
        chars += text.length;
    }

    if (current.length > 0) chunks.push(current);
    return chunks;
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
        const normalized = normalizeEmbedInput(text);
        const prefixed = task === 'query' ? `query: ${normalized}` : `passage: ${normalized}`;

        // In-flight dedup
        const flightKey = `${task}:${normalized}`;
        const existing = embedInFlight.get(flightKey);
        if (existing) return existing;

        const promise: Promise<number[]> = (async () => {
            await initWorker();
            return GpuScheduler.enqueue<number[]>({
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

        const prefixed = texts.map((t) => {
            const normalized = normalizeEmbedInput(t);
            return task === 'query' ? `query: ${normalized}` : `passage: ${normalized}`;
        });

        await initWorker();
        const chunks = splitBatchByBudget(prefixed);
        if (chunks.length > 1) {
            Logger.debug('[EmbeddingService] Chunked embedBatch for throughput/stability:', {
                items: prefixed.length,
                chunks: chunks.length,
                limits: getEmbedBatchLimits(),
                pressure: GpuScheduler.getMemoryPressure(),
            });
        }

        const all: number[][] = [];
        for (const chunk of chunks) {
            const timeoutMs = BATCH_TIMEOUT_BASE_MS + chunk.length * BATCH_TIMEOUT_PER_ITEM_MS;
            const vectors = await GpuScheduler.enqueue<number[][]>({
                priority: Priority.LOW,
                worker: 'embedding',
                execute: () => sendToWorker('embed-batch', chunk, timeoutMs),
                cancellable: true,
            });
            all.push(...vectors);
        }
        return all;
    },

    isReady(): boolean {
        return workerReady;
    },

    isDead(): boolean {
        return serviceDead;
    },

    isSuspended(): boolean {
        return false;
    },

    terminate(): void {
        terminateWorker();
    },
};
