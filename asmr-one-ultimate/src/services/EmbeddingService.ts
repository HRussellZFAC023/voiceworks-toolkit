import { SharedCache } from '../core/Cache';
import { I18n } from '../core/Config';
import { Logger } from '../core/Utils';
import { EventBus } from '../core/EventBus';
import { createEmbeddingWorker } from '../features/EmbeddingWorkerLoader';

// ============================================================================
// Constants
// ============================================================================

const EMBEDDING_MODEL = 'Xenova/multilingual-e5-small';
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const IDLE_UNLOAD_MS = 15 * 60 * 1000; // 15 minutes
const SINGLE_TIMEOUT_MS = 30_000;
const BATCH_TIMEOUT_BASE_MS = 30_000;
const BATCH_TIMEOUT_PER_ITEM_MS = 200;

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
let rememberedDtype = SharedCache.get<string>('asmr-ult:embed:preferred-dtype') || '';
const pending = new Map<number, PendingRequest>();
let nextId = 0;

// In-flight dedup
const embedInFlight = new Map<string, Promise<number[]>>();

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
        try { worker.terminate(); } catch { /* ignore */ }
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

function handleMessage(e: MessageEvent): void {
    const msg = e.data;

    if (msg.status === 'initiate') {
        return;
    }

    if (msg.status === 'ready') {
        workerReady = true;
        if (msg.dtype) {
            rememberedDtype = msg.dtype;
            SharedCache.set('asmr-ult:embed:preferred-dtype', msg.dtype, CACHE_TTL_MS);
        }
        if (msg.backend === 'wasm') {
            webgpuFailed = true;
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
        return;
    }

    if (msg.status === 'complete') {
        if (msg.id && pending.has(msg.id)) {
            const req = pending.get(msg.id)!;
            clearTimeout(req.timer);
            req.resolve(msg.data);
            pending.delete(msg.id);
        }
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
            if (rememberedDtype) {
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
        await initWorker();
        resetIdleTimer();
    },

    /**
     * Embed a single text. Prepends E5 task prefix automatically.
     * @param text - Raw text to embed
     * @param task - 'query' or 'passage'
     * @returns Normalized 384-dim float32 vector
     */
    async embed(text: string, task: 'query' | 'passage' = 'query'): Promise<number[]> {
        resetIdleTimer();
        const prefixed = task === 'query' ? `query: ${text}` : `passage: ${text}`;

        // In-flight dedup
        const flightKey = `${task}:${text}`;
        const existing = embedInFlight.get(flightKey);
        if (existing) return existing;

        const promise = (async () => {
            await initWorker();
            return sendToWorker('embed', prefixed, SINGLE_TIMEOUT_MS);
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
        if (texts.length === 0) return [];
        resetIdleTimer();

        const prefixed = texts.map(t =>
            task === 'query' ? `query: ${t}` : `passage: ${t}`
        );

        await initWorker();
        const timeoutMs = BATCH_TIMEOUT_BASE_MS + texts.length * BATCH_TIMEOUT_PER_ITEM_MS;
        return sendToWorker('embed-batch', prefixed, timeoutMs);
    },

    isReady(): boolean {
        return workerReady;
    },

    terminate(): void {
        terminateWorker();
    },
};
