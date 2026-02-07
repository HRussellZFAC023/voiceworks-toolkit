/**
 * Store Module Exports
 *
 * Re-exports AppStore and legacy Store for backward compatibility.
 */

// Export the new centralized store
export { AppStore, Config } from './AppStore';

// Legacy ConfigStore for backward compatibility
export { ConfigStore } from './modules/ConfigStore';

// Legacy Store class for backward compatibility
import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { ConfigStore } from './modules/ConfigStore';
import type { KikoeruStore } from '../types';

/**
 * @deprecated Use AppStore instead
 */
export class Store {
    private static instance: Store;
    public config: ConfigStore;

    private constructor() {
        this.config = ConfigStore.getInstance();
    }

    public static getInstance(): Store {
        if (!Store.instance) {
            Store.instance = new Store();
        }
        return Store.instance;
    }

    /**
     * Access the host application's Vuex store
     * @deprecated Use AppStore.host or KikoeruBridge.getInstance().store instead
     */
    public get host(): KikoeruStore {
        return KikoeruBridge.getInstance().store;
    }
}
