import { inject } from 'vue';
import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { INJECT_KEYS } from '../core/MountApp';

export function useBridge(): KikoeruBridge {
    const bridge = inject<KikoeruBridge>(INJECT_KEYS.bridge);
    if (!bridge) throw new Error('useBridge: KikoeruBridge not provided. Was this component mounted via mountApp()?');
    return bridge;
}
