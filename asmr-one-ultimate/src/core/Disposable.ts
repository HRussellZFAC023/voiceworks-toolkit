/**
 * Disposable - Base class for features that need deterministic cleanup.
 *
 * Tracks event listeners, EventBus subscriptions, timers, and arbitrary
 * teardown callbacks so they can all be released in one `dispose()` call.
 */

import { EventBus } from './EventBus';
import type { AppEventName, AppEventPayload } from '../types';

export class Disposable {
    private cleanups: (() => void)[] = [];

    /** Register an arbitrary teardown callback. */
    protected onCleanup(fn: () => void): void {
        this.cleanups.push(fn);
    }

    /** Add a DOM event listener that is automatically removed on dispose. */
    protected addDomListener<K extends keyof HTMLElementEventMap>(
        target: EventTarget,
        event: K | string,
        handler: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
    ): void {
        target.addEventListener(event, handler, options);
        this.onCleanup(() => target.removeEventListener(event, handler, options));
    }

    /** Subscribe to an EventBus event; automatically unsubscribed on dispose. */
    protected addBusListener<E extends AppEventName>(
        event: E,
        handler: (payload: AppEventPayload<E>) => void,
    ): void {
        this.onCleanup(EventBus.on(event, handler));
    }

    /** Start an interval that is automatically cleared on dispose. */
    protected addInterval(handler: () => void, ms: number): void {
        const id = setInterval(handler, ms);
        this.onCleanup(() => clearInterval(id));
    }

    /** Start a timeout that is automatically cleared on dispose. */
    protected addTimeout(handler: () => void, ms: number): ReturnType<typeof setTimeout> {
        const id = setTimeout(handler, ms);
        this.onCleanup(() => clearTimeout(id));
        return id;
    }

    /** Release all tracked resources. Safe to call multiple times. */
    dispose(): void {
        for (const fn of this.cleanups) {
            try { fn(); } catch { /* ensure remaining cleanups still run */ }
        }
        this.cleanups = [];
    }
}
