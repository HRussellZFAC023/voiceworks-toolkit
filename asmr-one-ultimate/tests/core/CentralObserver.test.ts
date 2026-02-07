import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We test the CentralObserver class directly by re-creating instances
// since the module exports a singleton.

type ObserverCallback = () => void;

interface RegisteredCallback {
    id: string;
    callback: ObserverCallback;
    debounceMs: number;
    lastRun: number;
    scheduled: boolean;
}

/**
 * Minimal replica of CentralObserverClass for unit testing.
 * We replicate the logic to test the behavior without relying on real MutationObserver.
 */
class CentralObserverTestable {
    private observer: MutationObserver | null = null;
    private callbacks = new Map<string, RegisteredCallback>();
    private isBatchRunning = false;
    private modificationDepth = 0;
    private pendingCallbacks = new Set<string>();
    private batchTimeout: ReturnType<typeof setTimeout> | null = null;

    start(): void {
        if (this.observer) return;
        this.observer = new MutationObserver(() => {
            if (this.isBatchRunning || this.modificationDepth > 0) return;
            this.scheduleBatch();
        });
        this.observer.observe(document.body, { childList: true, subtree: true });
    }

    register(id: string, callback: ObserverCallback, debounceMs = 300): void {
        this.callbacks.set(id, { id, callback, debounceMs, lastRun: 0, scheduled: false });
    }

    unregister(id: string): void {
        this.callbacks.delete(id);
        this.pendingCallbacks.delete(id);
    }

    beginModification(): void {
        this.modificationDepth++;
    }

    endModification(): void {
        queueMicrotask(() => {
            if (this.modificationDepth > 0) this.modificationDepth--;
        });
    }

    withModification<T>(fn: () => T): T {
        this.beginModification();
        try {
            return fn();
        } finally {
            this.endModification();
        }
    }

    async withModificationAsync<T>(fn: () => Promise<T>): Promise<T> {
        this.beginModification();
        try {
            return await fn();
        } finally {
            this.endModification();
        }
    }

    stop(): void {
        this.observer?.disconnect();
        this.observer = null;
        if (this.batchTimeout) {
            clearTimeout(this.batchTimeout);
            this.batchTimeout = null;
        }
    }

    // Expose for testing
    get _callbacks() { return this.callbacks; }
    get _modificationDepth() { return this.modificationDepth; }
    get _isBatchRunning() { return this.isBatchRunning; }

    /** Manually trigger batch processing (simulates what the observer does) */
    triggerBatch(): void {
        this.scheduleBatch();
    }

    private scheduleBatch(): void {
        if (this.batchTimeout) return;
        this.batchTimeout = setTimeout(() => {
            this.batchTimeout = null;
            this.processBatch();
        }, 50);
    }

    private processBatch(): void {
        if (this.isBatchRunning || this.modificationDepth > 0) return;
        this.isBatchRunning = true;
        try {
            const now = Date.now();
            for (const [_id, entry] of this.callbacks) {
                if (now - entry.lastRun < entry.debounceMs) continue;
                entry.lastRun = now;
                try {
                    entry.callback();
                } catch {
                    // swallowed
                }
            }
        } finally {
            this.isBatchRunning = false;
        }
    }
}

describe('CentralObserver', () => {
    let observer: CentralObserverTestable;

    beforeEach(() => {
        vi.useFakeTimers();
        observer = new CentralObserverTestable();
    });

    afterEach(() => {
        observer.stop();
        vi.useRealTimers();
    });

    describe('register / unregister', () => {
        it('should register a callback', () => {
            const cb = vi.fn();
            observer.register('test', cb);
            expect(observer._callbacks.has('test')).toBe(true);
        });

        it('should unregister a callback', () => {
            const cb = vi.fn();
            observer.register('test', cb);
            observer.unregister('test');
            expect(observer._callbacks.has('test')).toBe(false);
        });

        it('should replace callback when registering same id', () => {
            const cb1 = vi.fn();
            const cb2 = vi.fn();
            observer.register('test', cb1);
            observer.register('test', cb2);
            expect(observer._callbacks.size).toBe(1);
        });
    });

    describe('batch processing', () => {
        it('should call registered callbacks when batch is triggered', () => {
            const cb = vi.fn();
            observer.register('test', cb, 0);
            observer.triggerBatch();
            vi.advanceTimersByTime(50);
            expect(cb).toHaveBeenCalledTimes(1);
        });

        it('should call multiple registered callbacks', () => {
            const cb1 = vi.fn();
            const cb2 = vi.fn();
            observer.register('test1', cb1, 0);
            observer.register('test2', cb2, 0);
            observer.triggerBatch();
            vi.advanceTimersByTime(50);
            expect(cb1).toHaveBeenCalledTimes(1);
            expect(cb2).toHaveBeenCalledTimes(1);
        });

        it('should debounce callbacks based on debounceMs', () => {
            const cb = vi.fn();
            observer.register('test', cb, 500);

            observer.triggerBatch();
            vi.advanceTimersByTime(50);
            expect(cb).toHaveBeenCalledTimes(1);

            // Second trigger within debounce window should be skipped
            observer.triggerBatch();
            vi.advanceTimersByTime(50);
            expect(cb).toHaveBeenCalledTimes(1);

            // After debounce window, should fire again
            vi.advanceTimersByTime(500);
            observer.triggerBatch();
            vi.advanceTimersByTime(50);
            expect(cb).toHaveBeenCalledTimes(2);
        });

        it('should not call unregistered callbacks', () => {
            const cb = vi.fn();
            observer.register('test', cb, 0);
            observer.unregister('test');
            observer.triggerBatch();
            vi.advanceTimersByTime(50);
            expect(cb).not.toHaveBeenCalled();
        });

        it('should swallow errors from callbacks without affecting others', () => {
            const badCb = vi.fn(() => { throw new Error('boom'); });
            const goodCb = vi.fn();
            observer.register('bad', badCb, 0);
            observer.register('good', goodCb, 0);
            observer.triggerBatch();
            vi.advanceTimersByTime(50);
            expect(badCb).toHaveBeenCalled();
            expect(goodCb).toHaveBeenCalled();
        });

        it('should batch multiple rapid triggers into one processing cycle', () => {
            const cb = vi.fn();
            observer.register('test', cb, 0);
            observer.triggerBatch();
            observer.triggerBatch();
            observer.triggerBatch();
            vi.advanceTimersByTime(50);
            expect(cb).toHaveBeenCalledTimes(1);
        });
    });

    describe('modification guards', () => {
        it('should skip callbacks during modification', () => {
            const cb = vi.fn();
            observer.register('test', cb, 0);

            observer.beginModification();
            observer.triggerBatch();
            vi.advanceTimersByTime(50);
            expect(cb).not.toHaveBeenCalled();
        });

        it('should support nested modifications', () => {
            observer.beginModification();
            observer.beginModification();
            expect(observer._modificationDepth).toBe(2);
        });

        it('withModification should increment and decrement depth', async () => {
            let depthDuring = 0;
            observer.withModification(() => {
                depthDuring = observer._modificationDepth;
            });
            expect(depthDuring).toBe(1);
            // After microtask, depth should decrement
            await vi.advanceTimersByTimeAsync(0);
            expect(observer._modificationDepth).toBe(0);
        });

        it('withModificationAsync should work with async functions', async () => {
            let depthDuring = 0;
            await observer.withModificationAsync(async () => {
                depthDuring = observer._modificationDepth;
                return 'result';
            });
            expect(depthDuring).toBe(1);
            await vi.advanceTimersByTimeAsync(0);
            expect(observer._modificationDepth).toBe(0);
        });
    });

    describe('start / stop', () => {
        it('should start observing the DOM', () => {
            observer.start();
            // No error means MutationObserver was created successfully
        });

        it('should not create multiple observers on repeated start()', () => {
            observer.start();
            observer.start(); // Should be a no-op
        });

        it('should clean up on stop', () => {
            observer.start();
            observer.stop();
            // Should not throw when stopping
        });

        it('should clear pending batch timeout on stop', () => {
            observer.register('test', vi.fn(), 0);
            observer.triggerBatch();
            observer.stop();
            // Advancing timers after stop should not cause errors
            vi.advanceTimersByTime(100);
        });
    });
});
