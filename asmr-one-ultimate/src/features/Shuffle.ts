import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { Config, Logger } from '../core/Utils';
import type { KikoeruStoreState, AudioPlayerState, PlayerTrack, PlayMode, PlayModeObject } from '../types';

export class ShuffleFeature {
    private bridge: KikoeruBridge;
    private _unwatch: (() => void) | null = null;
    private enabled = false;
    private toggleHandler: (() => Promise<void>) | null = null;

    constructor() {
        this.bridge = KikoeruBridge.getInstance();
    }

    public enable(): void {
        if (this.enabled) return;
        this.enabled = true;
        const w = window as Window & { ASMRUlt?: Record<string, unknown> };
        const api = w.ASMRUlt || (w.ASMRUlt = {});
        this.toggleHandler = () => this.enabled ? this.toggle() : Promise.resolve();
        api.toggleShuffle = this.toggleHandler;

        const store = this.bridge.store;
        if (store.watch) {
            this._unwatch = store.watch(
                (state: KikoeruStoreState) => state.AudioPlayer?.playMode,
                (mode) => {
                    const isShuffle = this.getMode(mode) === 'shuffle';
                    Config.set('shuffle', isShuffle);
                }
            );
        }

        Logger.log('[ShuffleFeature] Enabled.');
    }

    public disable(): void {
        if (!this.enabled) return;
        this.enabled = false;
        this._unwatch?.();
        this._unwatch = null;
        const api = (window as Window & { ASMRUlt?: Record<string, unknown> }).ASMRUlt;
        if (api && api.toggleShuffle === this.toggleHandler) delete api.toggleShuffle;
        this.toggleHandler = null;
    }

    public async toggle(): Promise<void> {
        const store = this.bridge.store;
        const currentMode = this.getMode(store.state.AudioPlayer?.playMode);
        const nextMode = currentMode === 'shuffle' ? 'order' : 'shuffle';

        const applied = await this.setMode(nextMode);
        if (!applied) {
            Logger.warn('[ShuffleFeature] Host does not expose a supported play-mode contract.');
            return;
        }
        Logger.debug('[ShuffleFeature] Native shuffle toggled to:', nextMode);

        if (nextMode === 'shuffle') {
            this.applyHardShuffle();
        }
    }

    private getMode(mode: PlayMode | PlayModeObject | undefined): string {
        if (!mode) return 'order';
        if (typeof mode === 'string') return mode;
        if (typeof mode.name === 'string') return mode.name;
        if (typeof mode.id === 'number') return mode.id === 3 ? 'shuffle' : 'order';
        return 'order';
    }

    private async setMode(mode: 'shuffle' | 'order'): Promise<boolean> {
        const store = this.bridge.store;
        const commit = store.commit?.bind(store);
        const dispatch = store.dispatch?.bind(store);
        const contract = 'AudioPlayer/CHANGE_PLAY_MODE';
        const canCommit = !!commit && (store._mutations?.[contract] !== undefined || !store._mutations);
        const canDispatch = !!dispatch && store._actions?.[contract] !== undefined;

        if (!canCommit && !canDispatch) return false;

        for (let i = 0; i < 4; i++) {
            const current = this.getMode(store.state.AudioPlayer?.playMode);
            if (current === mode) return true;
            try {
                if (canCommit) {
                    commit!(contract);
                } else {
                    await dispatch!(contract);
                }
            } catch (error) {
                Logger.warn('[ShuffleFeature] Failed to change native play mode:', error);
                return false;
            }
        }
        return this.getMode(store.state.AudioPlayer?.playMode) === mode;
    }

    private applyHardShuffle(): void {
        const store = this.bridge.store;
        const playlist = this.getPlaylist(store.state.AudioPlayer);
        if (playlist.length < 2) return;

        const shuffled = [...playlist];
        this.shuffleArray(shuffled);

        const current = this.getCurrentTrack(store.state.AudioPlayer);
        if (current) {
            const idx = shuffled.findIndex(t => t.src === current.src || t.hash === current.hash);
            if (idx > -1) {
                shuffled.splice(idx, 1);
                shuffled.unshift(current);
            }
        }

        this.setPlaylist(shuffled);
        Logger.debug('[ShuffleFeature] Hard shuffle applied to', shuffled.length, 'tracks.');
    }

    private getPlaylist(player: AudioPlayerState): PlayerTrack[] {
        if (Array.isArray(player.queue)) return player.queue;
        if (Array.isArray(player.playlist)) return player.playlist;
        return [];
    }

    private getCurrentTrack(player: AudioPlayerState): PlayerTrack | null {
        if (player.currentTrack) return player.currentTrack;
        if (player.currentPlayingFile) return player.currentPlayingFile;
        return null;
    }

    private setPlaylist(tracks: PlayerTrack[]): void {
        const store = this.bridge.store;
        if (store.dispatch && store._actions?.['AudioPlayer/setPlaylist']) {
            store.dispatch('AudioPlayer/setPlaylist', tracks);
            return;
        }
        if (store.commit) {
            // Ensure every track has `subtitles` — the deployed host's AudioPlayer
            // watcher accesses track.subtitles.length and crashes on undefined.
            const queue = tracks.map(t => ({ ...t, subtitles: (t as any).subtitles || [] }));
            store.commit('AudioPlayer/SET_QUEUE', { queue, index: 0 });
        }
    }

    private shuffleArray<T>(array: T[]): void {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
    }
}
