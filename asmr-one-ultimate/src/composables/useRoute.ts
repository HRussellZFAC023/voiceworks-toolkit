import { ref, onMounted, onUnmounted, type Ref } from 'vue';
import { useBridge } from './useBridge';
import type { VueRoute } from '../types';

/**
 * Reactive route ref that updates when the host Vue 2 router navigates.
 */
export function useRoute(): Ref<VueRoute> {
    const bridge = useBridge();
    const route = ref<VueRoute>({ ...bridge.route }) as Ref<VueRoute>;
    let unwatch: (() => void) | undefined;

    onMounted(() => {
        unwatch = bridge.$watch?.('$route', (newRoute: VueRoute) => {
            route.value = { ...newRoute };
        });
    });

    onUnmounted(() => unwatch?.());

    return route;
}
