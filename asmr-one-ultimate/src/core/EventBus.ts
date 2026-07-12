/**
 * EventBus - Centralized event system for cross-feature communication
 *
 * Replaces scattered window.dispatchEvent/addEventListener patterns with a
 * type-safe, centralized event bus that supports:
 * - Type-safe events with typed payloads
 * - One-time listeners
 * - Event namespacing
 * - Listener cleanup
 */

import type { AppEventName, AppEventPayload } from '../types';
import { Logger } from './Logger';

declare const unsafeWindow: Window & typeof globalThis;

// Store singleton on window to persist across script re-injections
const globalWindow = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) as Window & {
    __ASMR_EVENT_BUS__?: EventBusImpl;
};

type EventListener<T> = (payload: T) => void;

interface ListenerEntry<T> {
    listener: EventListener<T>;
    once: boolean;
}

class EventBusImpl {
    private listeners = new Map<string, Set<ListenerEntry<unknown>>>();

    /**
     * Subscribe to an event
     */
    on<E extends AppEventName>(
        event: E,
        listener: EventListener<AppEventPayload<E>>
    ): () => void {
        return this.addListener(event, listener, false);
    }

    /**
     * Subscribe to an event (fires once then auto-removes)
     */
    once<E extends AppEventName>(
        event: E,
        listener: EventListener<AppEventPayload<E>>
    ): () => void {
        return this.addListener(event, listener, true);
    }

    /**
     * Unsubscribe from an event
     */
    off<E extends AppEventName>(
        event: E,
        listener: EventListener<AppEventPayload<E>>
    ): void {
        const eventListeners = this.listeners.get(event);
        if (!eventListeners) return;

        for (const entry of eventListeners) {
            if (entry.listener === listener) {
                eventListeners.delete(entry);
                break;
            }
        }

        if (eventListeners.size === 0) {
            this.listeners.delete(event);
        }
    }

    /**
     * Emit an event to all subscribers
     */
    emit<E extends AppEventName>(event: E, payload: AppEventPayload<E>): void {
        const eventListeners = this.listeners.get(event);
        if (!eventListeners) return;

        // Snapshot to avoid issues when listeners call off()/on() during iteration
        const snapshot = [...eventListeners];

        for (const entry of snapshot) {
            // Entry may have been removed by a previous listener in this emit cycle
            if (!eventListeners.has(entry)) continue;

            try {
                (entry.listener as EventListener<AppEventPayload<E>>)(payload);
            } catch (error) {
                Logger.error(`[EventBus] Error in listener for ${event}:`, error);
            }

            if (entry.once) {
                eventListeners.delete(entry);
            }
        }

        if (eventListeners.size === 0) {
            this.listeners.delete(event);
        }
    }

    /**
     * Remove all listeners for an event (or all events if no event specified)
     */
    removeAllListeners(event?: AppEventName): void {
        if (event) {
            this.listeners.delete(event);
        } else {
            this.listeners.clear();
        }
    }

    /**
     * Get listener count for an event
     */
    listenerCount(event: AppEventName): number {
        return this.listeners.get(event)?.size || 0;
    }

    /**
     * Wait for an event to fire (Promise-based)
     */
    waitFor<E extends AppEventName>(
        event: E,
        timeout?: number
    ): Promise<AppEventPayload<E>> {
        return new Promise((resolve, reject) => {
            let timeoutId: number | undefined;

            const cleanup = this.once(event, (payload) => {
                if (timeoutId) clearTimeout(timeoutId);
                resolve(payload);
            });

            if (timeout) {
                timeoutId = window.setTimeout(() => {
                    cleanup();
                    reject(new Error(`Timeout waiting for event: ${event}`));
                }, timeout);
            }
        });
    }


    // =========================================================================
    // Private Methods
    // =========================================================================

    private addListener<E extends AppEventName>(
        event: E,
        listener: EventListener<AppEventPayload<E>>,
        once: boolean
    ): () => void {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
        }

        const entry: ListenerEntry<unknown> = {
            listener: listener as EventListener<unknown>,
            once,
        };

        this.listeners.get(event)!.add(entry);

        // Return unsubscribe function
        return () => {
            const eventListeners = this.listeners.get(event);
            if (eventListeners) {
                eventListeners.delete(entry);
                if (eventListeners.size === 0) {
                    this.listeners.delete(event);
                }
            }
        };
    }
}

// Export singleton instance (persisted across script re-injections)
function getEventBus(): EventBusImpl {
    if (globalWindow.__ASMR_EVENT_BUS__) {
        return globalWindow.__ASMR_EVENT_BUS__;
    }
    const instance = new EventBusImpl();
    globalWindow.__ASMR_EVENT_BUS__ = instance;
    return instance;
}

export const EventBus = getEventBus();

