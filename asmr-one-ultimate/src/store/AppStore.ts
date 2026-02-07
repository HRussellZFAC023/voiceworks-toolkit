/**
 * AppStore - Centralized state management for the plugin
 *
 * Single source of truth combining:
 * - Plugin configuration (persisted via GM_*)
 * - Application state (runtime state)
 * - Host store access (Kikoeru's Vuex store)
 */

import { GM_getValue, GM_setValue } from '$';
import { EventBus } from '../core/EventBus';
import { Logger } from '../core/Utils';
import { getAudioElement } from '../core/DomUtils';
import type {
    PluginConfig,
    ConfigKey,
    AppState,
    RadioModeState,
    LearnerModeState,
    WhisperState,
    AudioPlayerState,
    KikoeruStore,
    KikoeruStoreState,
    PlayerTrack,
    WorkDetail,
    SearchState,
} from '../types';

declare const unsafeWindow: Window & typeof globalThis;

// Store singleton on window to persist across script re-injections
const globalWindow = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) as Window & {
    __ASMR_APP_STORE__?: AppStoreImpl;
};

// ============================================================================
// Config Store
// ============================================================================

const CONFIG_DEFAULTS: PluginConfig = {
    // Radio Mode
    playAllInFolder: false,
    shuffle: false,
    autoFilterFolders: true,

    // Learner Mode
    showJP: true,
    subtitleLang: 'en',
    primarySubtitleLang: 'ja',

    // AI Features
    vectorSearchApiKey: '',
    vectorSearchApiKeyHash: '',
    vectorSearchModel: 'jina-embeddings-v3',
    vectorIndexVersion: 2,
    vectorIndexCursor: 1,
    vectorIndexLatestWorkId: '',
    vectorRateLimitCooldownUntil: 0,
    vectorRateLimitBackoff: 1000,

    // Cache
    cacheLimitGB: 5,

    // Transcript Sync
    transcriptSyncEnabled: false,
    transcriptSyncProjectId: '',
    transcriptSyncApiKey: '',
    transcriptSyncCollection: 'transcripts',

    // UI
    autoProgress: false,
    flatView: false,
    playbackRate: 1.0,
    learnerBlur: false,
    sfwMode: false,
    translateMode: true,
    preferLocalTranslation: true,
    distributedTranslation: true,

    // Auto Progress (enhanced)
    autoProgressMarked: false,
    autoProgressListening: false,
    autoProgressListened: false,
    autoProgressReplay: false,
    autoProgressPostponed: false,
    autoProgressReplayThreshold: 2,
    autoProgressRadioGuard: false,
    autoProgressRadioSkipThreshold: 3,

    // Radio Runtime (persisted for refresh survival)
    radioManuallyPaused: false,
    radioUseFlatTracks: false,

    debug: false,
    enableLogging: false,
    dlsiteProxyUrl: '',

    // Feature Toggles (Defaults)
    enablePlaylistDiscovery: true,
    enableLearnerMode: true,
    enableAdvancedSearch: true,
    enableWorkMetadata: true,
    enablePlayerTranslator: true,
    enableSupportButton: true,
    enableWorkTreeManager: true,
    enableTagFilters: true,
    enableVectorSearch: true,
    enableWhisper: true,
    enableFavicon: true,
    enableMediaSession: true,
    enableMenuIconFixer: true,
    enableStoreBackup: true,
    enableHVDBLink: true,
    enableInterfaceTranslator: true,
    enablePageTitleManager: true,
    enableKeyboardManager: true,
    enableRouteStateSync: true,

    enableMediaViewer: true,
    enablePlayerFullscreen: true,
    enablePlayerGallery: true,
    enableWorkTreeCopy: true,
    enableCommentSection: true,
    enableInfiniteScroll: false,
    enableJoiTool: true,
    enableVisualizer: true,

    // Gallery
    galleryAutoSlideshow: true,
    galleryAutoSlideshowInterval: 6,

    // Note: apiServerUrl is no longer needed - we read from the host app's "Select server" setting
};

// ============================================================================
// State Defaults
// ============================================================================

const DEFAULT_PLAYER_STATE: AudioPlayerState = {
    currentTime: 0,
    duration: 0,
};

const DEFAULT_RADIO_STATE: RadioModeState = {
    isActive: false,
    state: 'idle',
    currentWorkId: null,
    recentWorkIds: [],
    playlistMode: false,
    lastTrackSrc: null,
};

const DEFAULT_LEARNER_STATE: LearnerModeState = {
    isActive: false,
    currentSegment: null,
    showJapanese: true,
    segments: [],
};

const DEFAULT_WHISPER_STATE: WhisperState = {
    isTranscribing: false,
    isLoadingModel: false,
    progress: 0,
    progressMessage: '',
    currentTrackSrc: null,
};

const DEFAULT_SEARCH_STATE: SearchState = {
    pendingOrder: undefined,
    pendingSort: undefined,
};

const DEFAULT_APP_STATE: AppState = {
    radio: { ...DEFAULT_RADIO_STATE },
    learner: { ...DEFAULT_LEARNER_STATE },
    whisper: { ...DEFAULT_WHISPER_STATE },
    playlist: {
        isActive: false,
        workIds: [],
        currentWorkIndex: 0,
        playlistId: null,
        playlistName: null,
    },
    search: { ...DEFAULT_SEARCH_STATE },
    isInitialized: false,
};

// ============================================================================
// AppStore Implementation
// ============================================================================

class AppStoreImpl {
    private _state: AppState = { ...DEFAULT_APP_STATE };
    private _hostStore: KikoeruStore | null = null;
    private _stateListeners: Set<(state: AppState) => void> = new Set();
    private _configCache: PluginConfig | null = null;

    // =========================================================================
    // Configuration Management
    // =========================================================================

    /**
     * Get a config value. Reads from in-memory cache if available,
     * otherwise falls back to GM storage.
     */
    getConfig<K extends ConfigKey>(key: K): PluginConfig[K] {
        if (this._configCache) return this._configCache[key];
        return GM_getValue(key, CONFIG_DEFAULTS[key]) as PluginConfig[K];
    }

    /**
     * Set a config value. Updates both in-memory cache and GM storage.
     */
    setConfig<K extends ConfigKey>(key: K, value: PluginConfig[K]): void {
        const oldValue = this.getConfig(key);
        GM_setValue(key, value);
        if (this._configCache) {
            (this._configCache as unknown as Record<string, unknown>)[key] = value;
        }
        EventBus.emit('config:change', { key, value, oldValue });
    }

    /**
     * Get all config values. First call populates the in-memory cache;
     * subsequent getConfig() calls read from memory instead of GM storage.
     */
    getAllConfig(): PluginConfig {
        if (this._configCache) return { ...this._configCache };
        const config = {} as PluginConfig;
        for (const key of Object.keys(CONFIG_DEFAULTS) as ConfigKey[]) {
            (config as unknown as Record<string, unknown>)[key] = GM_getValue(key, CONFIG_DEFAULTS[key]);
        }
        this._configCache = { ...config } as PluginConfig;
        return config;
    }

    /**
     * Get default value for a config key
     */
    getConfigDefault<K extends ConfigKey>(key: K): PluginConfig[K] {
        return CONFIG_DEFAULTS[key];
    }

    // =========================================================================
    // Application State Management
    // =========================================================================

    /**
     * Get current application state (read-only)
     */
    get state(): Readonly<AppState> {
        return this._state;
    }

    /**
     * Update application state (partial update)
     */
    setState(updater: Partial<AppState> | ((state: AppState) => Partial<AppState>)): void {
        const updates = typeof updater === 'function' ? updater(this._state) : updater;
        this._state = { ...this._state, ...updates };
        this.notifyStateListeners();
    }

    /**
     * Update radio state
     */
    setRadioState(updates: Partial<RadioModeState>): void {
        this._state = {
            ...this._state,
            radio: { ...this._state.radio, ...updates },
        };
        this.notifyStateListeners();

        // Emit event if active state changed
        if ('isActive' in updates) {
            EventBus.emit('radio:toggle', { isActive: updates.isActive! });
        }
    }

    /**
     * Update learner state
     */
    setLearnerState(updates: Partial<LearnerModeState>): void {
        this._state = {
            ...this._state,
            learner: { ...this._state.learner, ...updates },
        };
        this.notifyStateListeners();
    }

    /**
     * Update whisper state
     */
    setWhisperState(updates: Partial<WhisperState>): void {
        this._state = {
            ...this._state,
            whisper: { ...this._state.whisper, ...updates },
        };
        this.notifyStateListeners();
    }

    /**
     * Update search state
     */
    setSearchState(updates: Partial<SearchState>): void {
        this._state = {
            ...this._state,
            search: { ...this._state.search, ...updates },
        };
        this.notifyStateListeners();
    }

    /**
     * Subscribe to state changes
     */
    subscribe(listener: (state: AppState) => void): () => void {
        this._stateListeners.add(listener);
        return () => this._stateListeners.delete(listener);
    }

    /**
     * Reset state to defaults
     */
    resetState(): void {
        this._state = { ...DEFAULT_APP_STATE };
        this.notifyStateListeners();
    }

    // =========================================================================
    // Host Store Access (Kikoeru's Vuex Store)
    // =========================================================================

    /**
     * Set the host store reference
     */
    setHostStore(store: KikoeruStore): void {
        this._hostStore = store;
    }

    /**
     * Get the host store (throws if not initialized)
     */
    get host(): KikoeruStore {
        if (!this._hostStore) {
            throw new Error('Host store not initialized');
        }
        return this._hostStore;
    }

    /**
     * Check if host store is available
     */
    get hasHost(): boolean {
        return this._hostStore !== null;
    }

    /**
     * Get audio player state from host.
     * Returns a safe default when the host store is not yet available.
     */
    get player(): AudioPlayerState {
        return this.host.state.AudioPlayer || DEFAULT_PLAYER_STATE;
    }

    /**
     * Get current track from host via queue[queueIndex].
     */
    get currentTrack(): PlayerTrack | undefined {
        const p = this.player;
        return p.queue?.[p.queueIndex ?? 0] ?? p.currentTrack ?? p.currentPlayingFile;
    }

    /**
     * Get current work from host
     */
    get currentWork(): WorkDetail | undefined {
        return this.player.work;
    }

    /**
     * Get queue from host
     */
    get queue(): PlayerTrack[] {
        const player = this.player;
        return player.queue || player.playlist || [];
    }

    /**
     * Get current queue index from host
     */
    get queueIndex(): number {
        return this.player.queueIndex || 0;
    }

    /**
     * Check if audio is playing
     */
    get isPlaying(): boolean {
        return this.player.playing || false;
    }

    /**
     * Dispatch to host store
     */
    dispatch(action: string, payload?: unknown): Promise<unknown> {
        if (!this._hostStore?.dispatch) {
            return Promise.reject(new Error('Host store dispatch not available'));
        }
        return this._hostStore.dispatch(action, payload);
    }

    /**
     * Commit to host store
     */
    commit(mutation: string, payload?: unknown): void {
        if (!this._hostStore?.commit) {
            throw new Error('Host store commit not available');
        }
        this._hostStore.commit(mutation, payload);
    }

    /**
     * Watch host store state
     */
    watch<T>(
        getter: (state: typeof this.host.state) => T,
        callback: (value: T, oldValue: T) => void,
        options?: { immediate?: boolean }
    ): (() => void) | undefined {
        return this._hostStore?.watch?.(getter as (state: KikoeruStoreState) => T, callback, options);
    }

    /**
     * Check if action exists in host store
     */
    hasAction(action: string): boolean {
        return !!this._hostStore?._actions?.[action];
    }

    // =========================================================================
    // Convenience Methods
    // =========================================================================

    /**
     * Play a track
     */
    async playTrack(track: PlayerTrack): Promise<void> {
        if (this.hasAction('AudioPlayer/playTrack')) {
            await this.dispatch('AudioPlayer/playTrack', track);
        } else {
            this.commit('AudioPlayer/SET_TRACK', 0);
        }
    }

    /**
     * Set queue and play
     */
    async setQueueAndPlay(tracks: PlayerTrack[], index = 0): Promise<void> {
        this.commit('AudioPlayer/SET_QUEUE', { queue: tracks, index });
        if (tracks[index]) {
            await this.playTrack(tracks[index]);
        }
    }

    /**
     * Pause playback
     */
    pause(): void {
        if (this.hasAction('AudioPlayer/pause')) {
            this.dispatch('AudioPlayer/pause');
        } else {
            const audio = getAudioElement();
            audio?.pause();
        }
    }

    /**
     * Resume playback
     */
    play(): void {
        if (this.hasAction('AudioPlayer/play')) {
            this.dispatch('AudioPlayer/play');
        } else {
            const audio = getAudioElement();
            audio?.play();
        }
    }

    // =========================================================================
    // Private Methods
    // =========================================================================

    private notifyStateListeners(): void {
        for (const listener of this._stateListeners) {
            try {
                listener(this._state);
            } catch (error) {
                Logger.error('[AppStore] Error in state listener:', error);
            }
        }
    }
}

// Export singleton instance (persisted across script re-injections)
function getAppStore(): AppStoreImpl {
    if (globalWindow.__ASMR_APP_STORE__) {
        return globalWindow.__ASMR_APP_STORE__;
    }
    const instance = new AppStoreImpl();
    globalWindow.__ASMR_APP_STORE__ = instance;
    return instance;
}

export const AppStore = getAppStore();

// Legacy compatibility - export Config getter
export const Config = {
    get: <K extends ConfigKey>(key: K) => AppStore.getConfig(key),
    set: <K extends ConfigKey>(key: K, value: PluginConfig[K]) => AppStore.setConfig(key, value),
    defaults: CONFIG_DEFAULTS,
};
