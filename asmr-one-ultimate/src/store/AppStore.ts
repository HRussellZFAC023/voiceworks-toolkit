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
import type {
    PluginConfig,
    ConfigKey,
    AppState,
    RadioModeState,
    LearnerModeState,
    WhisperState,
    AudioPlayerState,
    KikoeruStore,
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
    loopPlaylist: false,
    autoFilterFolders: true,
    radioUseFlatTracks: false,
    // Playlist Mode (split from Radio settings)
    playlistPlayAllInFolder: false,
    playlistShuffle: false,
    playlistLoopPlaylist: false,
    playlistAutoFilterFolders: true,
    playlistUseFlatTracks: false,
    playlistAutoProgress: false,
    playlistSePref: true,
    playlistBgmPref: true,

    // Learner Mode
    showJP: true,
    subtitleLang: 'en',
    primarySubtitleLang: 'ja',
    karaokeMode: true,
    segmentMode: true,

    // AI Features
    whisperModel: 'onnx-community/kotoba-whisper-v2.2-ONNX',
    whisperTask: 'transcribe',
    whisperQuantized: false,
    whisperOverrideSubs: true,
    whisperLiveChunkSec: 15,
    whisperLiveOverlapSec: 0,
    whisperCacheTranscripts: true,
    whisperAutoWarmup: true,
    alwaysTranscribe: false,
    forceWhisperWasm: false,
    vectorSearchApiKey: '',
    vectorIndexCursor: 1,
    vectorIndexLatestWorkId: '',
    vectorIndexVersion: 0,
    vectorSearchModel: '',
    vectorSearchApiKeyHash: '',
    vectorRateLimitBackoff: 1,
    vectorRateLimitCooldownUntil: 0,

    // Cache
    cacheLimitGB: 5,

    // Transcript Sync
    transcriptSyncEnabled: false,
    transcriptSyncProjectId: '',
    transcriptSyncApiKey: '',
    transcriptSyncCollection: 'transcripts',

    // Translation
    translateCnToJp: false,

    // Folder Selection
    sePref: true,
    bgmPref: true,

    // UI
    autoProgress: false,
    dynamicFavicon: true,
    flatView: false,
    playbackRate: 1.0,
    learnerBlur: false,
    sfwMode: false,
    translateMode: true,

    // Auto Progress (enhanced)
    autoProgressMarked: false,
    autoProgressListening: false,
    autoProgressListened: false,
    autoProgressReplay: false,
    autoProgressPostponed: false,
    autoProgressReplayThreshold: 2,
    autoProgressRadioSkipThreshold: 3,

    // Radio Runtime (persisted for refresh survival)
    radioManuallyPaused: false,

    // JPDB Integration
    enableJpdb: false,
    jpdbApiToken: '',
    jpdbShowFurigana: true,
    jpdbShowPitchAccent: false,
    jpdbPitchStyle: 'underline',
    jpdbSubtitleFurigana: true,
    jpdbSiteFurigana: true,
    jpdbMiningDeck: '',
    jpdbAddToForq: false,
    jpdbDisableReviews: false,
    jpdbUseTwoGrades: false,
    jpdbNeverForgetDeck: 'never-forget',
    jpdbBlacklistDeck: 'blacklist',
    hotkeyJpdbPopover: 'Shift+D',

    // Feature Toggles
    enableAdvancedSearch: true,
    enableCommentSection: true,
    enableContinueListening: true,
    enableFavicon: true,
    enableHVDBLink: true,
    enableInfiniteScroll: true,
    enableInterfaceTranslator: true,
    enableJoiTool: true,
    enableKeyboardManager: true,
    enableLearnerMode: true,
    enableMediaSession: true,
    enableMediaViewer: true,
    enableMenuIconFixer: true,
    enablePageTitleManager: true,
    enablePlayerFullscreen: true,
    enablePlayerGallery: true,
    enablePlayerTranslator: true,
    enablePlaylistDiscovery: true,
    enableRouteStateSync: true,
    enableStoreBackup: true,
    enableSupportButton: true,
    enableTagFilters: true,
    enableVectorSearch: true,
    enableVisitCounter: true,
    enableVisualizer: true,
    enableWhisper: true,
    enableWorkMetadata: true,
    enableWorkTreeCopy: true,
    enableWorkTreeManager: true,

    // Feature Options
    alwaysShowJoi: false,
    alwaysShowVisualizer: false,
    galleryAutoSlideshow: false,
    galleryAutoSlideshowInterval: 6,

    // Keyboard Shortcuts
    hotkeyPlayPause: 'Space',
    hotkeyMute: 'm',
    hotkeyFullscreen: 'f',
    hotkeySeekBack: 'ArrowLeft',
    hotkeySeekForward: 'ArrowRight',
    hotkeySeekBackLong: 'j',
    hotkeySeekForwardLong: 'l',
    hotkeyVolumeUp: 'ArrowUp',
    hotkeyVolumeDown: 'ArrowDown',
    hotkeyPrevLine: 'a',
    hotkeyNextLine: 'd',
    hotkeyPrevTrack: 'p',
    hotkeyNextTrack: 'n',
    hotkeySpeedUp: '>',
    hotkeySpeedDown: '<',
    hotkeySpeedReset: '=',
    hotkeyToggleBlur: 'b',
    hotkeyToggleJP: 'J',
    hotkeyGalleryPrev: '',
    hotkeyGalleryNext: '',
    hotkeyGalleryExclude: '',

    // Debug
    debug: false,
    enableLogging: false,
    dlsiteProxyUrl: '',
};

// ============================================================================
// State Defaults
// ============================================================================

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

    constructor() {
        this.migrateSplitModeSettings();
    }

    // =========================================================================
    // Configuration Management
    // =========================================================================

    /**
     * Get a config value
     */
    getConfig<K extends ConfigKey>(key: K): PluginConfig[K] {
        return GM_getValue(key, CONFIG_DEFAULTS[key]) as PluginConfig[K];
    }

    /**
     * Set a config value
     */
    setConfig<K extends ConfigKey>(key: K, value: PluginConfig[K]): void {
        const oldValue = this.getConfig(key);
        GM_setValue(key, value);
        EventBus.emit('config:change', { key, value, oldValue });
    }

    /**
     * Get all config values
     */
    getAllConfig(): PluginConfig {
        const config = {} as PluginConfig;
        for (const key of Object.keys(CONFIG_DEFAULTS) as ConfigKey[]) {
            (config as unknown as Record<string, unknown>)[key] = this.getConfig(key);
        }
        return config;
    }

    /**
     * Get default value for a config key
     */
    getConfigDefault<K extends ConfigKey>(key: K): PluginConfig[K] {
        return CONFIG_DEFAULTS[key];
    }

    /**
     * One-time migration: initialize new playlist-specific settings from legacy shared keys.
     */
    private migrateSplitModeSettings(): void {
        if (typeof GM_getValue !== 'function' || typeof GM_setValue !== 'function') return;
        const gt = globalThis as typeof globalThis & { GM_getValue?: typeof GM_getValue; GM_setValue?: typeof GM_setValue };
        if (typeof gt.GM_getValue !== 'function' || typeof gt.GM_setValue !== 'function') return;

        const MIGRATION_KEY = '__asmr_mode_settings_split_v1__';
        let alreadyMigrated = false;
        try {
            alreadyMigrated = GM_getValue(MIGRATION_KEY, false) as boolean;
        } catch {
            return;
        }
        if (alreadyMigrated) return;

        const mirrorPairs: Array<{ next: keyof PluginConfig; legacy: keyof PluginConfig }> = [
            { next: 'playlistPlayAllInFolder', legacy: 'playAllInFolder' },
            { next: 'playlistShuffle', legacy: 'shuffle' },
            { next: 'playlistLoopPlaylist', legacy: 'loopPlaylist' },
            { next: 'playlistAutoFilterFolders', legacy: 'autoFilterFolders' },
            { next: 'playlistUseFlatTracks', legacy: 'radioUseFlatTracks' },
            { next: 'playlistAutoProgress', legacy: 'autoProgress' },
            { next: 'playlistSePref', legacy: 'sePref' },
            { next: 'playlistBgmPref', legacy: 'bgmPref' },
        ];

        for (const { next, legacy } of mirrorPairs) {
            const existing = GM_getValue(next, undefined as unknown as PluginConfig[typeof next]);
            if (typeof existing === 'undefined') {
                const fallback = GM_getValue(legacy, CONFIG_DEFAULTS[legacy]) as PluginConfig[typeof next];
                GM_setValue(next, fallback);
            }
        }

        GM_setValue(MIGRATION_KEY, true);
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

        if ('state' in updates || 'currentWorkId' in updates || 'recentWorkIds' in updates) {
            EventBus.emit('radio:state', {
                state: this._state.radio.state,
                currentWorkId: this._state.radio.currentWorkId,
                recentWorkIds: [...this._state.radio.recentWorkIds],
            });
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
     * Get audio player state from host
     */
    get player(): AudioPlayerState {
        return this.host.state.AudioPlayer || {} as AudioPlayerState;
    }

    /**
     * Get current track from host
     */
    get currentTrack(): PlayerTrack | undefined {
        const player = this.player;
        return player.currentTrack || player.currentPlayingFile;
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

    // =========================================================================
    // Private Methods
    // =========================================================================

    private notifyStateListeners(): void {
        for (const listener of this._stateListeners) {
            try {
                listener(this._state);
            } catch (error) {
                console.error('[AppStore] Error in state listener:', error);
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
