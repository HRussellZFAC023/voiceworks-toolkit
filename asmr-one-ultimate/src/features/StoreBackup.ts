/**
 * StoreBackup - Persistent application state backup
 *
 * Responsibilities:
 * - Periodically save site state (Playlist, Works)
 * - Persist application state (learner mode status)
 * - Restore state on initialization to ensure continuity across refreshes
 * 
 * Note: Radio mode and playback state are NOT backed up to prevent cross-tab interference
 */

import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { AppStore } from '../store/AppStore';
import { Logger } from '../core/Utils';
import { GM_getValue, GM_setValue } from '$';
import type { PlaylistState, WorksState } from '../types/store';

const BACKUP_KEY = 'asmr-ult:store-backup';
const BACKUP_INTERVAL_MS = 5000;

interface SerializedState {
    timestamp: number;
    siteState: {
        Playlist?: PlaylistState;
        Works?: WorksState;
    };
    app: {
        learnerActive: boolean;
    };
}

export class StoreBackup {
    private bridge: KikoeruBridge;
    private timerId: number | null = null;
    private isRestoring = false;

    constructor() {
        this.bridge = KikoeruBridge.getInstance();
    }

    /**
     * Enable the backup system
     */
    public async enable(): Promise<void> {
        if (this.timerId !== null) return; // Already enabled
        Logger.info('[StoreBackup] System enabled');

        // Wait for bridge to be ready before starting backup/restore
        await this.bridge.initialize();

        // Attempt to restore state
        await this.restore();

        // Start periodic backup
        this.startTimer();
    }

    public disable(): void {
        if (this.timerId !== null) {
            clearInterval(this.timerId);
            this.timerId = null;
        }
    }

    /**
     * Start periodic backup timer
     */
    private startTimer(): void {
        if (this.timerId !== null) return;

        this.timerId = window.setInterval(() => {
            if (this.isRestoring) return;
            this.save();
        }, BACKUP_INTERVAL_MS);
    }

    /**
     * Capture and save current state
     */
    private save(): void {
        const appState = AppStore.state;

        const data: SerializedState = {
            timestamp: Date.now(),
            siteState: {
                Playlist: this.bridge.store.state.Playlist,
                Works: this.bridge.store.state.Works,
            },
            app: {
                learnerActive: appState.learner.isActive,
            }
        };

        try {
            GM_setValue(BACKUP_KEY, JSON.stringify(data));
        } catch (error) {
            Logger.debug('[StoreBackup] Failed to save state', error);
        }
    }

    /**
     * Restore state from backup
     */
    private async restore(): Promise<void> {
        const saved = GM_getValue(BACKUP_KEY, null);
        if (!saved) return;

        try {
            const data = JSON.parse(saved) as SerializedState;

            this.isRestoring = true;
            Logger.info('[StoreBackup] Restoring state...', data);

            // Restore Site State (Vuex modules only)
            if (data.siteState) {
                if (data.siteState.Playlist) {
                    this.bridge.commit('Playlist/SET_STATE', data.siteState.Playlist);
                }
                if (data.siteState.Works) {
                    this.bridge.commit('Works/SET_STATE', data.siteState.Works);
                }
            }

            this.isRestoring = false;
        } catch (error) {
            Logger.error('[StoreBackup] Restore failed', error);
            this.isRestoring = false;
        }
    }

}
