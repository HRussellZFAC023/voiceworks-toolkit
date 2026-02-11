/**
 * GpuScheduler — Main-thread GPU work coordinator
 *
 * Uses **per-worker queues and leases** so that different workers (Embedding,
 * Whisper) can run inference concurrently — they own separate GPU
 * devices and don't contend.  Within a single worker, tasks are serialized to
 * prevent queue flooding and GPU buffer exhaustion (e.g. fast-scrolling pages
 * that generate hundreds of translation requests).
 *
 * Model **loading** is still globally serialized via load leases — only one
 * worker can call requestAdapter + requestDevice + ONNX compile at a time.
 *
 * Priority levels:
 *   REALTIME (0) — current subtitle line, live whisper segment
 *   HIGH (1)     — near-playhead whisper
 *   NORMAL (2)   — interactive embedding tasks
 *   LOW (3)      — embedding indexing, background prefetch
 */

import { Logger } from './Utils';
import { EventBus } from './EventBus';
import { DeviceCapabilities } from './DeviceCapabilities';

// Backpressure: reject LOW tasks when queue is too deep
const MAX_QUEUE_DEPTH_PER_WORKER = 64;
const MAX_QUEUE_DEPTH_LOW_PRIORITY = 16;

// ============================================================================
// Types
// ============================================================================

export const enum Priority {
    REALTIME = 0,
    HIGH = 1,
    NORMAL = 2,
    LOW = 3,
}

export type WorkerName = 'embedding' | 'whisper';

export interface SchedulerTask<T = unknown> {
    priority: Priority;
    worker: WorkerName;
    execute: () => Promise<T>;
    /** Estimated duration in ms — used for scheduling hints */
    estimatedMs?: number;
    /** If true, task can be dropped when a higher-priority task arrives */
    cancellable?: boolean;
    /** Optional key used to drop stale cancellable tasks for the same UI scope */
    cancellableKey?: string;
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

interface QueueEntry {
    task: SchedulerTask<unknown>;
    resolve: (value: unknown) => void;
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

    /**
     * Drop cancellable tasks and reject their promises.
     * If `cancellableKey` is provided, only tasks with that key are dropped.
     */
    dropCancellable(cancellableKey?: string): number {
        const before = this.heap.length;
        const kept: QueueEntry[] = [];
        for (const entry of this.heap) {
            const matchesKey = !cancellableKey || entry.task.cancellableKey === cancellableKey;
            if (entry.task.cancellable && matchesKey) {
                entry.reject(new Error(`Task dropped: ${entry.task.worker} unavailable`));
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
    /** Current cooldown in ms — grows with each failure (graduated backoff) */
    lastCooldownMs: number;
}

const CIRCUIT_BREAKER_THRESHOLD = 3;
const RECOVERY_COOLDOWN_BASE_MS = 5000;
const RECOVERY_COOLDOWN_MAX_MS = 30_000;
const RECOVERY_BACKOFF_FACTOR = 2;
const RECOVERY_PROBE_INTERVAL_MS = 60 * 1000; // 1 min

function createHealthState(): HealthState {
    return {
        gpuHealthy: true,
        consecutiveFailures: 0,
        lastFailureTime: 0,
        recoveryTimer: null,
        lastCooldownMs: RECOVERY_COOLDOWN_BASE_MS,
    };
}

// ============================================================================
// Scheduler Singleton
// ============================================================================

class GpuSchedulerImpl {
    // Per-worker priority queues — workers can run concurrently
    private workerQueues = new Map<WorkerName, PriorityQueue>();
    private activeLeases = new Set<WorkerName>();

    private healthByWorker = new Map<WorkerName, HealthState>([
        ['embedding', createHealthState()],
        ['whisper', createHealthState()],
    ]);

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
    private statsTimer: ReturnType<typeof setInterval> | null = null;
    private totalWaitMs = 0;

    initialize(): void {
        // Listen for GPU device-lost events from any worker
        EventBus.on('gpu:device-lost', ({ worker }: { worker: WorkerName }) => {
            this.onGpuFailure(worker, 'device-lost-event');
        });

        // Periodic stats emission for debugging (only when queue is non-empty)
        this.statsTimer = setInterval(() => {
            let totalDepth = 0;
            for (const q of this.workerQueues.values()) totalDepth += q.size;
            if (totalDepth > 0) {
                Logger.debug('[GpuScheduler] Stats:', JSON.stringify(this.getStats()));
            }
        }, 10_000);

        Logger.debug('[GpuScheduler] Initialized (per-worker queues)');
    }

    /**
     * Acquire a model-load lease. Only one worker can hold a load lease at a time.
     * Load leases also block non-REALTIME inference — batch/background work waits
     * until loading finishes to avoid GPU memory pressure.
     *
     * Returns a release function that MUST be called when model loading is complete
     * (whether it succeeded or failed).
     */
    acquireLoadLease(worker: WorkerName): Promise<() => void> {
        const release = () => {
            if (this.activeLoadLease === worker) {
                Logger.debug(`[GpuScheduler] Load lease released: ${worker}`);
                this.activeLoadLease = null;
                this._processLoadQueue();
                // Resume all worker queues after load completes
                queueMicrotask(() => this._processAll());
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

    /** Whether a model is currently being loaded (blocks non-REALTIME inference) */
    get isLoading(): boolean {
        return this.activeLoadLease !== null;
    }

    /**
     * Enqueue a GPU task. Returns a promise that resolves when the task completes.
     * REALTIME tasks bypass the queue when the target worker has no active lease.
     * Different workers can execute concurrently.
     */
    /**
     * Lightweight memory pressure heuristic.
     * Downstream services use this to dynamically shrink batch sizes.
     */
    getMemoryPressure(): 'low' | 'medium' | 'high' {
        const activeWorkers = this.activeLeases.size;
        const loading = this.activeLoadLease !== null;
        const failedWorkers = [...this.healthByWorker.values()]
            .filter(h => h.consecutiveFailures > 0).length;

        if (loading && activeWorkers > 0) return 'high';
        if (failedWorkers > 0 || activeWorkers >= 2) return 'medium';
        return 'low';
    }

    enqueue<T>(task: SchedulerTask<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const entry: QueueEntry = {
                task: task as SchedulerTask<unknown>,
                resolve: resolve as (value: unknown) => void,
                reject,
                enqueuedAt: performance.now(),
            };

            // REALTIME fast-path: execute immediately if this worker has no active lease
            if (task.priority === Priority.REALTIME && !this.activeLeases.has(task.worker)) {
                this._executeEntry(entry);
                return;
            }

            // Backpressure: prevent queue flooding from fast-scrolling
            const q = this._getQueue(task.worker);
            if (q.size >= MAX_QUEUE_DEPTH_PER_WORKER && task.priority >= Priority.NORMAL) {
                // Try to make room by dropping cancellable tasks
                const dropped = q.dropCancellable(task.cancellableKey);
                this.totalDropped += dropped;
                if (dropped > 0) Logger.debug(`[GpuScheduler] Backpressure: dropped ${dropped} stale tasks for ${task.worker}`);
            }
            if (q.size >= MAX_QUEUE_DEPTH_LOW_PRIORITY && task.priority === Priority.LOW) {
                reject(new Error(`Queue full for ${task.worker} (backpressure)`));
                return;
            }

            q.enqueue(entry);
            this._processWorker(task.worker);
        });
    }

    /** Report GPU failure for a worker */
    onGpuFailure(worker: WorkerName, reason?: string): void {
        const health = this._getHealth(worker);
        health.consecutiveFailures++;
        health.lastFailureTime = Date.now();

        const reasonText = String(reason || '');
        const explicitDeviceLoss = /device lost|instance reference|release session|invalid session/i.test(reasonText);
        const shouldBroadcast = explicitDeviceLoss;
        if (shouldBroadcast) {
            // Broadcast only on explicit device-loss signals to avoid cascading a
            // single-worker failure into global WebGPU disable.
            EventBus.emit('gpu:device-lost-broadcast', { source: worker });
        }

        if (health.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
            health.gpuHealthy = false;
            Logger.warn(`[GpuScheduler] GPU circuit breaker tripped after ${CIRCUIT_BREAKER_THRESHOLD} failures`);
            EventBus.emit('webgpu:failed', { source: worker });

            // Drop cancellable tasks for the failed worker
            const q = this.workerQueues.get(worker);
            if (q) {
                const dropped = q.dropCancellable();
                this.totalDropped += dropped;
                if (dropped > 0) Logger.debug(`[GpuScheduler] Dropped ${dropped} cancellable tasks for ${worker}`);
            }

            // Schedule recovery probe
            this._scheduleRecoveryProbe(worker);
        } else {
            // Graduated cooldown: each consecutive failure uses a longer wait
            const cooldown = Math.min(health.lastCooldownMs, RECOVERY_COOLDOWN_MAX_MS);
            health.lastCooldownMs = Math.min(cooldown * RECOVERY_BACKOFF_FACTOR, RECOVERY_COOLDOWN_MAX_MS);
            Logger.debug(`[GpuScheduler] GPU failure ${health.consecutiveFailures}/${CIRCUIT_BREAKER_THRESHOLD} — ${cooldown}ms cooldown`);
            setTimeout(() => this._processWorker(worker), cooldown);
        }
    }

    /** Reset failure state on successful GPU operation */
    onGpuSuccess(worker?: WorkerName): void {
        if (worker) {
            const health = this._getHealth(worker);
            if (health.consecutiveFailures > 0) {
                health.consecutiveFailures = 0;
                health.lastCooldownMs = RECOVERY_COOLDOWN_BASE_MS; // Reset backoff
            }
            if (!health.gpuHealthy) {
                health.gpuHealthy = true;
                if (health.recoveryTimer) {
                    clearTimeout(health.recoveryTimer);
                    health.recoveryTimer = null;
                }
            }
            return;
        }

        for (const health of this.healthByWorker.values()) {
            if (health.consecutiveFailures > 0) {
                health.consecutiveFailures = 0;
                health.lastCooldownMs = RECOVERY_COOLDOWN_BASE_MS; // Reset backoff
            }
            if (!health.gpuHealthy) {
                health.gpuHealthy = true;
                if (health.recoveryTimer) {
                    clearTimeout(health.recoveryTimer);
                    health.recoveryTimer = null;
                }
            }
        }
    }

    /**
     * Drop all cancellable tasks for a given worker.
     * Used to clear background indexing tasks when a user-initiated search needs the worker.
     * Returns the number of dropped tasks.
     */
    clearCancellable(worker: WorkerName, cancellableKey?: string): number {
        const q = this.workerQueues.get(worker);
        if (!q) return 0;
        const dropped = q.dropCancellable(cancellableKey);
        this.totalDropped += dropped;
        if (dropped > 0) {
            if (cancellableKey) {
                Logger.debug(`[GpuScheduler] Cleared ${dropped} cancellable ${worker} tasks [key=${cancellableKey}]`);
            } else {
                Logger.debug(`[GpuScheduler] Cleared ${dropped} cancellable ${worker} tasks`);
            }
        }
        return dropped;
    }

    /**
     * Check if there are REALTIME-priority tasks waiting for a specific worker.
     * Used by batch translation to dynamically shrink chunk sizes when real-time
     * subtitle translation needs the GPU.
     */
    hasRealtimeQueued(worker: WorkerName): boolean {
        const q = this.workerQueues.get(worker);
        if (!q || q.size === 0) return false;
        const top = q.peek();
        return !!top && top.task.priority === Priority.REALTIME;
    }

    getStats(): SchedulerStats {
        let totalQueueDepth = 0;
        for (const q of this.workerQueues.values()) totalQueueDepth += q.size;
        const gpuHealthy = [...this.healthByWorker.values()].every((h) => h.gpuHealthy);
        return {
            queueDepth: totalQueueDepth,
            activeLease: this.activeLeases.size > 0 ? [...this.activeLeases][0] : null,
            activeLoadLease: this.activeLoadLease,
            loadQueueDepth: this.loadQueue.length,
            gpuHealthy,
            totalProcessed: this.totalProcessed,
            totalDropped: this.totalDropped,
            averageWaitMs: this.totalProcessed > 0 ? this.totalWaitMs / this.totalProcessed : 0,
        };
    }

    // ========================================================================
    // Internal
    // ========================================================================

    private _getQueue(worker: WorkerName): PriorityQueue {
        let q = this.workerQueues.get(worker);
        if (!q) { q = new PriorityQueue(); this.workerQueues.set(worker, q); }
        return q;
    }

    private _getHealth(worker: WorkerName): HealthState {
        let health = this.healthByWorker.get(worker);
        if (!health) {
            health = createHealthState();
            this.healthByWorker.set(worker, health);
        }
        return health;
    }

    /** Try to start the next task for a specific worker */
    private _processWorker(worker: WorkerName): void {
        if (this.activeLeases.has(worker)) return;
        const health = this._getHealth(worker);
        if (!health.gpuHealthy) return;
        // During model loading, only allow REALTIME tasks (live subtitle translation)
        // to proceed — batch/background work waits to avoid GPU memory pressure.
        if (this.activeLoadLease) {
            const q = this.workerQueues.get(worker);
            const peek = q?.peek();
            if (!peek) return;
            // Full-tier desktop GPUs can safely keep HIGH-priority interactive tasks
            // running during model load, improving parallel throughput.
            const maxAllowed = DeviceCapabilities.profile.tier === 'full'
                ? Priority.HIGH
                : Priority.REALTIME;
            if (peek.task.priority > maxAllowed) return;
        }
        const q = this.workerQueues.get(worker);
        const entry = q?.dequeue();
        if (!entry) return;
        this._executeEntry(entry);
    }

    /** Try to start tasks for all workers (used after load lease release / recovery) */
    private _processAll(): void {
        for (const worker of this.workerQueues.keys()) {
            this._processWorker(worker);
        }
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
                queueMicrotask(() => this._processAll());
            }
        });
    }

    private async _executeEntry(entry: QueueEntry): Promise<void> {
        const worker = entry.task.worker;
        this.activeLeases.add(worker);
        const waitMs = performance.now() - entry.enqueuedAt;
        this.totalWaitMs += waitMs;

        try {
            const result = await entry.task.execute();
            this.totalProcessed++;
            this.onGpuSuccess(worker);
            entry.resolve(result);
        } catch (err) {
            entry.reject(err);
            // Check if this is a GPU-related error
            const msg = String((err as Error)?.message || err || '');
            if (/device lost|OOM|out of memory|createBuffer|GPUDevice|WebGPU/i.test(msg)) {
                this.onGpuFailure(worker, msg);
            }
        } finally {
            this.activeLeases.delete(worker);
            // Process next task for this worker (microtask to avoid stack overflow on long queues)
            queueMicrotask(() => this._processWorker(worker));
        }
    }

    private _scheduleRecoveryProbe(worker: WorkerName): void {
        const health = this._getHealth(worker);
        if (health.recoveryTimer) return;
        health.recoveryTimer = setTimeout(() => {
            health.recoveryTimer = null;
            if (!health.gpuHealthy) {
                Logger.log(`[GpuScheduler] Attempting GPU recovery probe for ${worker}`);
                health.gpuHealthy = true; // tentatively allow GPU
                health.consecutiveFailures = 0;
                // The next enqueued task will test if GPU actually works.
                // If it fails, this worker's circuit breaker will trip again.
                queueMicrotask(() => this._processWorker(worker));
            }
        }, RECOVERY_PROBE_INTERVAL_MS);
    }
}

export const GpuScheduler = new GpuSchedulerImpl();
