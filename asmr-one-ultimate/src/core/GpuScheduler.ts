/**
 * GpuScheduler — Main-thread GPU work coordinator
 *
 * Serializes GPU-intensive tasks across Translation, Embedding, and Whisper workers.
 * Workers still own their own GPU devices (WebGPU can't share across worker boundaries),
 * but the scheduler controls WHEN workers receive work to prevent device contention.
 *
 * Priority levels:
 *   REALTIME (0) — current subtitle line, live whisper segment
 *   HIGH (1)     — near-playhead whisper, player bar translation
 *   NORMAL (2)   — batch preTranslateAll, page translations
 *   LOW (3)      — embedding indexing, background prefetch
 */

import { Logger } from './Utils';
import { EventBus } from './EventBus';

// ============================================================================
// Types
// ============================================================================

export const enum Priority {
    REALTIME = 0,
    HIGH = 1,
    NORMAL = 2,
    LOW = 3,
}

export type WorkerName = 'translation' | 'embedding' | 'whisper';

export interface SchedulerTask<T = unknown> {
    priority: Priority;
    worker: WorkerName;
    execute: () => Promise<T>;
    /** Estimated duration in ms — used for scheduling hints */
    estimatedMs?: number;
    /** If true, task can be dropped when a higher-priority task arrives */
    cancellable?: boolean;
}

export interface SchedulerStats {
    queueDepth: number;
    activeLease: WorkerName | null;
    activeLoadLease: WorkerName | null;
    loadQueueDepth: number;
    gpuHealthy: boolean;
    totalProcessed: number;
    totalDropped: number;
    averageWaitMs: number;
}

interface QueueEntry<T = unknown> {
    task: SchedulerTask<T>;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
    enqueuedAt: number;
}

// ============================================================================
// Min-Heap Priority Queue
// ============================================================================

class PriorityQueue {
    private heap: QueueEntry[] = [];

    get size(): number { return this.heap.length; }

    enqueue(entry: QueueEntry): void {
        this.heap.push(entry);
        this._bubbleUp(this.heap.length - 1);
    }

    dequeue(): QueueEntry | undefined {
        if (this.heap.length === 0) return undefined;
        const top = this.heap[0];
        const last = this.heap.pop()!;
        if (this.heap.length > 0) {
            this.heap[0] = last;
            this._sinkDown(0);
        }
        return top;
    }

    peek(): QueueEntry | undefined {
        return this.heap[0];
    }

    /** Drop all cancellable tasks for a given worker (used on worker failure) */
    dropCancellable(worker: WorkerName): number {
        const before = this.heap.length;
        const kept: QueueEntry[] = [];
        for (const entry of this.heap) {
            if (entry.task.worker === worker && entry.task.cancellable) {
                entry.reject(new Error(`Task dropped: ${worker} unavailable`));
            } else {
                kept.push(entry);
            }
        }
        this.heap = kept;
        this._rebuild();
        return before - this.heap.length;
    }

    private _compare(a: QueueEntry, b: QueueEntry): number {
        const pa = a.task.priority;
        const pb = b.task.priority;
        if (pa !== pb) return pa - pb; // lower priority number = higher priority
        return a.enqueuedAt - b.enqueuedAt; // FIFO within same priority
    }

    private _bubbleUp(i: number): void {
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this._compare(this.heap[i], this.heap[parent]) >= 0) break;
            [this.heap[i], this.heap[parent]] = [this.heap[parent], this.heap[i]];
            i = parent;
        }
    }

    private _sinkDown(i: number): void {
        const n = this.heap.length;
        while (true) {
            let smallest = i;
            const left = 2 * i + 1;
            const right = 2 * i + 2;
            if (left < n && this._compare(this.heap[left], this.heap[smallest]) < 0) smallest = left;
            if (right < n && this._compare(this.heap[right], this.heap[smallest]) < 0) smallest = right;
            if (smallest === i) break;
            [this.heap[i], this.heap[smallest]] = [this.heap[smallest], this.heap[i]];
            i = smallest;
        }
    }

    private _rebuild(): void {
        for (let i = (this.heap.length >> 1) - 1; i >= 0; i--) this._sinkDown(i);
    }
}

// ============================================================================
// GPU Health Monitor
// ============================================================================

interface HealthState {
    gpuHealthy: boolean;
    consecutiveFailures: number;
    lastFailureTime: number;
    recoveryTimer: ReturnType<typeof setTimeout> | null;
}

const CIRCUIT_BREAKER_THRESHOLD = 3;
const RECOVERY_COOLDOWN_MS = 3000;
const RECOVERY_PROBE_INTERVAL_MS = 10 * 60 * 1000; // 10 min

// ============================================================================
// Scheduler Singleton
// ============================================================================

class GpuSchedulerImpl {
    private queue = new PriorityQueue();
    private activeLease: WorkerName | null = null;
    private processing = false;
    private health: HealthState = {
        gpuHealthy: true,
        consecutiveFailures: 0,
        lastFailureTime: 0,
        recoveryTimer: null,
    };

    // Model load lease: serializes model loading across workers.
    // Only one worker can load a model at a time (requestAdapter + requestDevice + ONNX session).
    // Concurrent loading causes "Failed to create WebGPU Context Provider" or OOM tab crashes.
    private activeLoadLease: WorkerName | null = null;
    private loadQueue: Array<{
        worker: WorkerName;
        resolve: (release: () => void) => void;
    }> = [];

    // Stats
    private totalProcessed = 0;
    private totalDropped = 0;
    private totalWaitMs = 0;

    initialize(): void {
        // Listen for GPU device-lost events from any worker
        EventBus.on('gpu:device-lost', ({ worker }: { worker: WorkerName }) => {
            this.onGpuFailure(worker);
        });

        // Listen for GPU recovery signals
        EventBus.on('gpu:recovered', () => {
            this.health.gpuHealthy = true;
            this.health.consecutiveFailures = 0;
            Logger.log('[GpuScheduler] GPU recovered');
        });

        Logger.debug('[GpuScheduler] Initialized');
    }

    /**
     * Acquire a model-load lease. Only one worker can hold a load lease at a time.
     * Load leases also block inference leases — inference waits until loading finishes.
     *
     * Returns a release function that MUST be called when model loading is complete
     * (whether it succeeded or failed).
     *
     * Usage:
     *   const release = await GpuScheduler.acquireLoadLease('translation');
     *   try { await loadModel(); } finally { release(); }
     */
    acquireLoadLease(worker: WorkerName): Promise<() => void> {
        const release = () => {
            if (this.activeLoadLease === worker) {
                Logger.debug(`[GpuScheduler] Load lease released: ${worker}`);
                this.activeLoadLease = null;
                this._processLoadQueue();
                // Resume inference queue after load completes
                queueMicrotask(() => this._processNext());
            }
        };

        if (!this.activeLoadLease) {
            this.activeLoadLease = worker;
            Logger.debug(`[GpuScheduler] Load lease acquired: ${worker}`);
            return Promise.resolve(release);
        }

        Logger.debug(`[GpuScheduler] Load lease queued: ${worker} (waiting for ${this.activeLoadLease})`);
        return new Promise<() => void>(resolve => {
            this.loadQueue.push({ worker, resolve });
        });
    }

    /** Whether a model is currently being loaded (blocks inference scheduling) */
    get isLoading(): boolean {
        return this.activeLoadLease !== null;
    }

    /**
     * Enqueue a GPU task. Returns a promise that resolves when the task completes.
     * REALTIME tasks bypass the queue when no lease is held.
     */
    enqueue<T>(task: SchedulerTask<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const entry: QueueEntry<T> = {
                task,
                resolve: resolve as (value: unknown) => void,
                reject,
                enqueuedAt: performance.now(),
            };

            // REALTIME fast-path: execute immediately if no active lease
            if (task.priority === Priority.REALTIME && !this.activeLease) {
                this._executeEntry(entry);
                return;
            }

            this.queue.enqueue(entry as QueueEntry);
            this._processNext();
        });
    }

    /** Report GPU failure for a worker */
    onGpuFailure(worker: WorkerName): void {
        this.health.consecutiveFailures++;
        this.health.lastFailureTime = Date.now();

        // Broadcast device loss to all services so they can skip WebGPU.
        // A true GPU device loss (GPU process crash) affects ALL workers, not just one.
        // This is distinct from dtype-specific failures (e.g. fp16 on Intel) which are per-service.
        EventBus.emit('gpu:device-lost-broadcast', { source: worker });

        if (this.health.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
            this.health.gpuHealthy = false;
            Logger.warn(`[GpuScheduler] GPU circuit breaker tripped after ${CIRCUIT_BREAKER_THRESHOLD} failures`);
            EventBus.emit('webgpu:failed', { source: worker });

            // Drop cancellable tasks for the failed worker
            const dropped = this.queue.dropCancellable(worker);
            this.totalDropped += dropped;
            if (dropped > 0) Logger.debug(`[GpuScheduler] Dropped ${dropped} cancellable tasks for ${worker}`);

            // Schedule recovery probe
            this._scheduleRecoveryProbe();
        } else {
            // Brief cooldown before allowing more GPU tasks
            Logger.debug(`[GpuScheduler] GPU failure ${this.health.consecutiveFailures}/${CIRCUIT_BREAKER_THRESHOLD} — ${RECOVERY_COOLDOWN_MS}ms cooldown`);
            setTimeout(() => this._processNext(), RECOVERY_COOLDOWN_MS);
        }
    }

    /** Reset failure state on successful GPU operation */
    onGpuSuccess(): void {
        if (this.health.consecutiveFailures > 0) {
            this.health.consecutiveFailures = 0;
        }
    }

    /**
     * Drop all cancellable tasks for a given worker.
     * Used to clear background indexing tasks when a user-initiated search needs the worker.
     * Returns the number of dropped tasks.
     */
    clearCancellable(worker: WorkerName): number {
        const dropped = this.queue.dropCancellable(worker);
        this.totalDropped += dropped;
        if (dropped > 0) Logger.debug(`[GpuScheduler] Cleared ${dropped} cancellable ${worker} tasks`);
        return dropped;
    }

    getStats(): SchedulerStats {
        return {
            queueDepth: this.queue.size,
            activeLease: this.activeLease,
            activeLoadLease: this.activeLoadLease,
            loadQueueDepth: this.loadQueue.length,
            gpuHealthy: this.health.gpuHealthy,
            totalProcessed: this.totalProcessed,
            totalDropped: this.totalDropped,
            averageWaitMs: this.totalProcessed > 0 ? this.totalWaitMs / this.totalProcessed : 0,
        };
    }

    // ========================================================================
    // Internal
    // ========================================================================

    private _processNext(): void {
        if (this.processing || this.activeLease) return;
        // During model loading, only allow REALTIME tasks (live subtitle translation)
        // to proceed — batch/background work waits to avoid GPU memory pressure.
        // Blocking ALL inference was too aggressive and caused live translations to stall.
        if (this.activeLoadLease) {
            const peek = this.queue.peek();
            if (!peek || peek.task.priority !== Priority.REALTIME) return;
        }
        const entry = this.queue.dequeue();
        if (!entry) return;
        this._executeEntry(entry);
    }

    private _processLoadQueue(): void {
        if (this.activeLoadLease || this.loadQueue.length === 0) return;
        const next = this.loadQueue.shift()!;
        this.activeLoadLease = next.worker;
        Logger.debug(`[GpuScheduler] Load lease acquired (from queue): ${next.worker}`);
        next.resolve(() => {
            if (this.activeLoadLease === next.worker) {
                Logger.debug(`[GpuScheduler] Load lease released: ${next.worker}`);
                this.activeLoadLease = null;
                this._processLoadQueue();
                queueMicrotask(() => this._processNext());
            }
        });
    }

    private async _executeEntry(entry: QueueEntry): Promise<void> {
        this.activeLease = entry.task.worker;
        this.processing = true;
        const waitMs = performance.now() - entry.enqueuedAt;
        this.totalWaitMs += waitMs;

        try {
            const result = await entry.task.execute();
            this.totalProcessed++;
            this.onGpuSuccess();
            entry.resolve(result);
        } catch (err) {
            entry.reject(err);
            // Check if this is a GPU-related error
            const msg = String((err as Error)?.message || err || '');
            if (/device lost|OOM|out of memory|createBuffer|GPUDevice|WebGPU/i.test(msg)) {
                this.onGpuFailure(entry.task.worker);
            }
        } finally {
            this.activeLease = null;
            this.processing = false;
            // Process next in queue (microtask to avoid stack overflow on long queues)
            queueMicrotask(() => this._processNext());
        }
    }

    private _scheduleRecoveryProbe(): void {
        if (this.health.recoveryTimer) return;
        this.health.recoveryTimer = setTimeout(() => {
            this.health.recoveryTimer = null;
            if (!this.health.gpuHealthy) {
                Logger.log('[GpuScheduler] Attempting GPU recovery probe');
                this.health.gpuHealthy = true; // tentatively allow GPU
                this.health.consecutiveFailures = 0;
                // The next enqueued task will test if GPU actually works
                // If it fails, circuit breaker will trip again
            }
        }, RECOVERY_PROBE_INTERVAL_MS);
    }
}

export const GpuScheduler = new GpuSchedulerImpl();
