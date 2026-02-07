import { inject, onUnmounted } from 'vue';
import { INJECT_KEYS } from '../core/MountApp';
import { EventBus as EventBusSingleton } from '../core/EventBus';
import type { AppEventName, AppEventPayload } from '../types';

type EventBusType = typeof EventBusSingleton;

export function useEventBus() {
    const eventBus = inject<EventBusType>(INJECT_KEYS.eventBus) ?? EventBusSingleton;
    const cleanups: (() => void)[] = [];

    function on<E extends AppEventName>(
        event: E,
        handler: (payload: AppEventPayload<E>) => void
    ): void {
        cleanups.push(eventBus.on(event, handler));
    }

    function emit<E extends AppEventName>(
        event: E,
        payload: AppEventPayload<E>
    ): void {
        eventBus.emit(event, payload);
    }

    function once<E extends AppEventName>(
        event: E,
        handler: (payload: AppEventPayload<E>) => void
    ): void {
        cleanups.push(eventBus.once(event, handler));
    }

    onUnmounted(() => {
        cleanups.forEach(fn => fn());
        cleanups.length = 0;
    });

    return { on, emit, once };
}
