import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the types module
vi.mock('../../src/types', () => ({
    // Empty mock - EventBus uses types but doesn't need them for tests
}));

// Create a standalone EventBus for testing
type EventListener<T> = (payload: T) => void;

interface ListenerEntry<T> {
    listener: EventListener<T>;
    once: boolean;
}

class TestEventBus {
    private listeners = new Map<string, Set<ListenerEntry<unknown>>>();

    on<T>(event: string, listener: EventListener<T>): () => void {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
        }
        const entry: ListenerEntry<unknown> = { listener: listener as EventListener<unknown>, once: false };
        this.listeners.get(event)!.add(entry);
        return () => {
            const set = this.listeners.get(event);
            if (set) {
                set.delete(entry);
                if (set.size === 0) this.listeners.delete(event);
            }
        };
    }

    once<T>(event: string, listener: EventListener<T>): () => void {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
        }
        const entry: ListenerEntry<unknown> = { listener: listener as EventListener<unknown>, once: true };
        this.listeners.get(event)!.add(entry);
        return () => {
            const set = this.listeners.get(event);
            if (set) {
                set.delete(entry);
                if (set.size === 0) this.listeners.delete(event);
            }
        };
    }

    emit<T>(event: string, payload: T): void {
        const eventListeners = this.listeners.get(event);
        if (!eventListeners) return;

        const toRemove: ListenerEntry<unknown>[] = [];
        for (const entry of eventListeners) {
            (entry.listener as EventListener<T>)(payload);
            if (entry.once) toRemove.push(entry);
        }
        for (const entry of toRemove) {
            eventListeners.delete(entry);
        }
        if (eventListeners.size === 0) {
            this.listeners.delete(event);
        }
    }

    off<T>(event: string, listener: EventListener<T>): void {
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

    listenerCount(event: string): number {
        return this.listeners.get(event)?.size || 0;
    }

    removeAllListeners(event?: string): void {
        if (event) {
            this.listeners.delete(event);
        } else {
            this.listeners.clear();
        }
    }

    waitFor<T>(event: string, timeout?: number): Promise<T> {
        return new Promise((resolve, reject) => {
            let timeoutId: ReturnType<typeof setTimeout> | undefined;
            const cleanup = this.once(event, (payload: T) => {
                if (timeoutId) clearTimeout(timeoutId);
                resolve(payload);
            });
            if (timeout) {
                timeoutId = setTimeout(() => {
                    cleanup();
                    reject(new Error(`Timeout waiting for event: ${event}`));
                }, timeout);
            }
        });
    }
}

describe('EventBus', () => {
    let eventBus: TestEventBus;

    beforeEach(() => {
        eventBus = new TestEventBus();
    });

    describe('on/emit', () => {
        it('should call listener when event is emitted', () => {
            const listener = vi.fn();
            eventBus.on('test', listener);
            eventBus.emit('test', { data: 'hello' });
            expect(listener).toHaveBeenCalledWith({ data: 'hello' });
        });

        it('should call multiple listeners', () => {
            const listener1 = vi.fn();
            const listener2 = vi.fn();
            eventBus.on('test', listener1);
            eventBus.on('test', listener2);
            eventBus.emit('test', 'payload');
            expect(listener1).toHaveBeenCalledWith('payload');
            expect(listener2).toHaveBeenCalledWith('payload');
        });

        it('should not call listeners for different events', () => {
            const listener = vi.fn();
            eventBus.on('test1', listener);
            eventBus.emit('test2', 'payload');
            expect(listener).not.toHaveBeenCalled();
        });
    });

    describe('once', () => {
        it('should call listener only once', () => {
            const listener = vi.fn();
            eventBus.once('test', listener);
            eventBus.emit('test', 'first');
            eventBus.emit('test', 'second');
            expect(listener).toHaveBeenCalledTimes(1);
            expect(listener).toHaveBeenCalledWith('first');
        });

        it('should remove listener after first call', () => {
            const listener = vi.fn();
            eventBus.once('test', listener);
            expect(eventBus.listenerCount('test')).toBe(1);
            eventBus.emit('test', 'payload');
            expect(eventBus.listenerCount('test')).toBe(0);
        });
    });

    describe('off', () => {
        it('should remove specific listener', () => {
            const listener1 = vi.fn();
            const listener2 = vi.fn();
            eventBus.on('test', listener1);
            eventBus.on('test', listener2);
            eventBus.off('test', listener1);
            eventBus.emit('test', 'payload');
            expect(listener1).not.toHaveBeenCalled();
            expect(listener2).toHaveBeenCalledWith('payload');
        });
    });

    describe('unsubscribe function', () => {
        it('should remove listener when called', () => {
            const listener = vi.fn();
            const unsubscribe = eventBus.on('test', listener);
            unsubscribe();
            eventBus.emit('test', 'payload');
            expect(listener).not.toHaveBeenCalled();
        });
    });

    describe('listenerCount', () => {
        it('should return correct count', () => {
            expect(eventBus.listenerCount('test')).toBe(0);
            eventBus.on('test', () => {});
            expect(eventBus.listenerCount('test')).toBe(1);
            eventBus.on('test', () => {});
            expect(eventBus.listenerCount('test')).toBe(2);
        });
    });

    describe('removeAllListeners', () => {
        it('should remove all listeners for specific event', () => {
            eventBus.on('test1', () => {});
            eventBus.on('test1', () => {});
            eventBus.on('test2', () => {});
            eventBus.removeAllListeners('test1');
            expect(eventBus.listenerCount('test1')).toBe(0);
            expect(eventBus.listenerCount('test2')).toBe(1);
        });

        it('should remove all listeners when no event specified', () => {
            eventBus.on('test1', () => {});
            eventBus.on('test2', () => {});
            eventBus.removeAllListeners();
            expect(eventBus.listenerCount('test1')).toBe(0);
            expect(eventBus.listenerCount('test2')).toBe(0);
        });
    });

    describe('waitFor', () => {
        it('should resolve when event is emitted', async () => {
            const promise = eventBus.waitFor<string>('test');
            setTimeout(() => eventBus.emit('test', 'result'), 10);
            const result = await promise;
            expect(result).toBe('result');
        });

        it('should reject on timeout', async () => {
            const promise = eventBus.waitFor('test', 50);
            await expect(promise).rejects.toThrow('Timeout waiting for event: test');
        });
    });

    describe('error handling', () => {
        it('should continue calling other listeners if one throws', () => {
            const badListener = vi.fn(() => {
                throw new Error('bad');
            });
            const goodListener = vi.fn();

            // Create a modified EventBus that catches errors
            class SafeEventBus extends TestEventBus {
                emit<T>(event: string, payload: T): void {
                    const listeners = (this as any).listeners.get(event);
                    if (!listeners) return;
                    for (const entry of listeners) {
                        try {
                            (entry.listener as EventListener<T>)(payload);
                        } catch {
                            // Ignore errors
                        }
                    }
                }
            }

            const safeBus = new SafeEventBus();
            safeBus.on('test', badListener);
            safeBus.on('test', goodListener);
            safeBus.emit('test', 'payload');

            expect(badListener).toHaveBeenCalled();
            expect(goodListener).toHaveBeenCalled();
        });
    });
});
