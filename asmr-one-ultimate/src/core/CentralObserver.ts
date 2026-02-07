/**
 * CentralObserver - Single MutationObserver for the entire app
 *
 * Instead of each feature creating its own observer on document.body,
 * features register callbacks here. This prevents:
 * 1. Multiple observers triggering cascade effects
 * 2. Infinite loops when observers modify DOM
 * 3. Performance issues from too many observers
 */

import { Logger } from './Utils';

type ObserverCallback = () => void;

interface RegisteredCallback {
    id: string;
    callback: ObserverCallback;
    debounceMs: number;
    lastRun: number;
    scheduled: boolean;
}

class CentralObserverClass {
    private static instance: CentralObserverClass | null = null;
    private observer: MutationObserver | null = null;
    private callbacks = new Map<string, RegisteredCallback>();
    /** True while processBatch() is running callbacks */
    private isBatchRunning = false;
    /** Depth counter for nested beginModification/endModification pairs */
    private modificationDepth = 0;
    private pendingCallbacks = new Set<string>();
    private batchTimeout: ReturnType<typeof setTimeout> | null = null;

    private constructor() { }

    public static getInstance(): CentralObserverClass {
        if (!CentralObserverClass.instance) {
            CentralObserverClass.instance = new CentralObserverClass();
        }
        return CentralObserverClass.instance;
    }

    /**
     * Start the central observer
     */
    public start(): void {
        if (this.observer) return;

        this.observer = new MutationObserver(() => {
            // Don't process if we're currently modifying DOM ourselves
            if (this.isBatchRunning || this.modificationDepth > 0) return;
            this.scheduleBatch();
        });

        this.observer.observe(document.body, {
            childList: true,
            subtree: true,
        });

        Logger.log('[CentralObserver] Started');
    }

    /**
     * Register a callback to be called on DOM mutations
     * @param id Unique identifier for this callback
     * @param callback Function to call
     * @param debounceMs Minimum time between calls (default 300ms)
     */
    public register(id: string, callback: ObserverCallback, debounceMs = 300): void {
        this.callbacks.set(id, {
            id,
            callback,
            debounceMs,
            lastRun: 0,
            scheduled: false,
        });
        Logger.debug(`[CentralObserver] Registered: ${id}`);
    }

    /**
     * Unregister a callback
     */
    public unregister(id: string): void {
        this.callbacks.delete(id);
        this.pendingCallbacks.delete(id);
        Logger.debug(`[CentralObserver] Unregistered: ${id}`);
    }

    /**
     * Call this before modifying DOM to prevent observer cascade.
     * Supports nesting — each begin must be paired with an end.
     */
    public beginModification(): void {
        this.modificationDepth++;
    }

    /**
     * Call this after modifying DOM (uses microtask to ensure observer sees flag).
     * Supports nesting — only clears when all nested modifications are done.
     */
    public endModification(): void {
        queueMicrotask(() => {
            if (this.modificationDepth > 0) this.modificationDepth--;
        });
    }

    /**
     * Wrap a function that modifies DOM
     */
    public withModification<T>(fn: () => T): T {
        this.beginModification();
        try {
            return fn();
        } finally {
            this.endModification();
        }
    }

    /**
     * Wrap an async function that modifies DOM
     */
    public async withModificationAsync<T>(fn: () => Promise<T>): Promise<T> {
        this.beginModification();
        try {
            return await fn();
        } finally {
            this.endModification();
        }
    }

    private scheduleBatch(): void {
        // Batch all pending callbacks into a single processing cycle
        if (this.batchTimeout) return;

        this.batchTimeout = setTimeout(() => {
            this.batchTimeout = null;
            this.processBatch();
        }, 50); // Short delay to batch rapid mutations
    }

    private processBatch(): void {
        if (this.isBatchRunning || this.modificationDepth > 0) return;
        this.isBatchRunning = true;

        try {
            const now = Date.now();

            for (const [id, entry] of this.callbacks) {
                if (now - entry.lastRun < entry.debounceMs) continue;

                entry.lastRun = now;
                try {
                    entry.callback();
                } catch (err) {
                    Logger.error(`[CentralObserver] Error in ${id}:`, err);
                }
            }
        } finally {
            this.isBatchRunning = false;
        }
    }

    /**
     * Stop the observer
     */
    public stop(): void {
        this.observer?.disconnect();
        this.observer = null;
        if (this.batchTimeout) {
            clearTimeout(this.batchTimeout);
            this.batchTimeout = null;
        }
    }
}

export const CentralObserver = CentralObserverClass.getInstance();
