/**
 * Store & State Types
 */

import type { PlayerTrack, PlayMode, PlayModeObject, WorkDetail, WorkSummary, TrackFolder, TrackItem } from './api';

// ============================================================================
// Kikoeru Store Types (Host Application State)
// ============================================================================

/**
 * AudioPlayer Vuex module state.
 *
 * IMPORTANT: The current track is stored at queue[queueIndex], NOT at
 * currentTrack or currentPlayingFile. Those properties are legacy/unused.
 *
 * To get the current track:
 *   const track = state.AudioPlayer.queue?.[state.AudioPlayer.queueIndex];
 *
 * The track includes availableLyrics[] array with VTT subtitle files.
 */
export interface AudioPlayerState {
    /** Whether the player UI is hidden */
    hide?: boolean;
    /** Whether audio is currently playing */
    playing?: boolean;
    /** Current playback position in seconds */
    currentTime: number;
    /** Total duration of current track in seconds */
    duration: number;
    /**
     * The playback queue - array of tracks.
     * CURRENT TRACK is at queue[queueIndex].
     */
    queue?: PlayerTrack[];
    /**
     * Index of the currently playing track in the queue.
     * Use queue[queueIndex] to get the current track.
     */
    queueIndex?: number;
    /** Playback mode (order, repeat, shuffle, etc.) */
    playMode?: PlayMode | PlayModeObject;
    /** Whether audio is muted */
    muted?: boolean;
    /** Volume level 0-1 */
    volume?: number;
    /** Current lyric line text (if LRC loaded) */
    currentLyric?: string;
    /** Sleep timer target time (timestamp or null) */
    sleepTime?: number | null;
    /** Whether sleep mode is active */
    sleepMode?: boolean;
    /** Rewind seek time in seconds */
    rewindSeekTime?: number;
    /** Forward seek time in seconds */
    forwardSeekTime?: number;
    /** Whether rewind seek mode is active */
    rewindSeekMode?: boolean;
    /** Whether forward seek mode is active */
    forwardSeekMode?: boolean;
    /**
     * @deprecated Not used - use queue[queueIndex] instead
     */
    currentTrack?: PlayerTrack;
    /**
     * @deprecated Not used - use queue[queueIndex] instead
     */
    currentPlayingFile?: PlayerTrack;
    /**
     * @deprecated Legacy alias for queue
     */
    playlist?: PlayerTrack[];
    /** Currently loaded work details */
    work?: WorkDetail;
    /** Parsed LRC lines (if LRC loaded via API) */
    lrcLines?: Array<{ time: number; text: string }>;
    /** Current audio source URL */
    src?: string;
    /** Alternative current source URL field */
    currentSrc?: string;
    /** Source URL (alternative field name) */
    source?: string;
}

export interface UserState {
    auth?: boolean;
    name?: string;
    group?: string;
    marks?: Record<string, number>;
}

export interface WorksState {
    searchParams?: Record<string, unknown>;
    list?: WorkSummary[];
}

export interface ViewState {
    works?: WorkSummary[];
}

export interface PlaylistState {
    works?: WorkSummary[];
}

export interface KikoeruStoreState {
    AudioPlayer: AudioPlayerState;
    User: UserState;
    Works?: WorksState;
    View?: ViewState;
    Playlist?: PlaylistState;
}

export interface KikoeruStore {
    state: KikoeruStoreState;
    dispatch?: <T = unknown>(type: string, payload?: unknown, options?: unknown) => Promise<T>;
    commit?: (type: string, payload?: unknown, options?: unknown) => void;
    watch?: <T>(getter: (state: KikoeruStoreState) => T, callback: (value: T, oldValue: T) => void, options?: { immediate?: boolean }) => () => void;
    _actions?: Record<string, unknown>;
}

// ============================================================================
// Vue App Types
// ============================================================================

export interface VueRouter {
    push(location: string | { path?: string; query?: Record<string, string> }): Promise<void>;
    replace(location: string | { path?: string; query?: Record<string, string> }): Promise<void>;
    go(n: number): void;
    back(): void;
    forward(): void;
    beforeEach(guard: (to: VueRoute, from: VueRoute, next: () => void) => void): () => void;
    currentRoute: VueRoute;
}

export interface VueRoute {
    path: string;
    params: Record<string, string>;
    query: Record<string, string>;
    hash: string;
    fullPath: string;
    matched: unknown[];
    name?: string;
    meta?: Record<string, unknown>;
}

export interface AxiosRequestConfig {
    params?: Record<string, unknown>;
    responseType?: 'arraybuffer' | 'blob' | 'document' | 'json' | 'text' | 'stream';
    headers?: Record<string, string>;
    timeout?: number;
    data?: unknown;
    onDownloadProgress?: (event: { loaded?: number; total?: number; lengthComputable?: boolean }) => void;
}

export interface AxiosInstance {
    defaults: {
        baseURL?: string;
    };
    get<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<{ data: T; status: number }>;
    post<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<{ data: T; status: number }>;
    put<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<{ data: T; status: number }>;
    delete<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<{ data: T; status: number }>;
}

export interface KikoeruApp {
    $store: KikoeruStore;
    $router: VueRouter;
    $route: VueRoute;
    $axios: AxiosInstance;
    $watch: <T>(
        expression: string | (() => T),
        callback: (newValue: T, oldValue: T) => void,
        options?: { immediate?: boolean; deep?: boolean }
    ) => () => void;
    $children?: KikoeruApp[];
    $options?: Record<string, unknown>;
    $q?: {
        notify: (options: {
            message: string;
            type: string;
            timeout?: number;
            position?: string;
            actions?: Array<{ icon: string; color: string }>;
        }) => void;
    };
    $root?: KikoeruApp;
    $parent?: KikoeruApp;
    [key: string]: unknown;
}

export interface WorkTreeComponent extends KikoeruApp {
    tree: Array<TrackFolder | TrackItem>;
    path: string[];
    fatherFolder: Array<TrackFolder | TrackItem>;
    onClickItem: (item: TrackItem | TrackFolder) => void;
    // Vue internals
    $data?: {
        tree: Array<TrackFolder | TrackItem>;
        fatherFolder: Array<TrackFolder | TrackItem>;
    };
}

// ============================================================================
// Plugin Config Types
// ============================================================================

export interface PluginConfig {
    // Radio Mode
    playAllInFolder: boolean;
    shuffle: boolean;
    autoFilterFolders: boolean;

    // Learner Mode
    showJP: boolean;
    subtitleLang: string;
    primarySubtitleLang: string;

    // AI Features
    vectorSearchApiKey: string;
    vectorSearchApiKeyHash: string;
    vectorSearchModel: string;
    vectorIndexVersion: number;
    vectorIndexCursor: number;
    vectorIndexLatestWorkId: string;
    vectorRateLimitCooldownUntil: number;
    vectorRateLimitBackoff: number;

    // Cache
    cacheLimitGB: number;

    // Transcript Sync
    transcriptSyncEnabled: boolean;
    transcriptSyncProjectId: string;
    transcriptSyncApiKey: string;
    transcriptSyncCollection: string;

    // UI
    autoProgress: boolean;
    flatView: boolean;
    playbackRate: number;
    learnerBlur: boolean;
    sfwMode: boolean;
    translateMode: boolean;
    preferLocalTranslation: boolean;
    distributedTranslation: boolean;

    // Auto Progress (enhanced)
    autoProgressMarked: boolean;
    autoProgressListening: boolean;
    autoProgressListened: boolean;
    autoProgressReplay: boolean;
    autoProgressPostponed: boolean;
    autoProgressReplayThreshold: number;
    autoProgressRadioGuard: boolean;
    autoProgressRadioSkipThreshold: number;

    // Radio Runtime (persisted for refresh survival)
    radioManuallyPaused: boolean;
    radioUseFlatTracks: boolean;

    // Debug
    debug: boolean;
    enableLogging: boolean;

    // DLsite Proxy
    dlsiteProxyUrl: string;

    // Feature Toggles (Global)
    enablePlaylistDiscovery: boolean;
    enableLearnerMode: boolean;
    enableAdvancedSearch: boolean;
    enableWorkMetadata: boolean;
    enablePlayerTranslator: boolean;
    enableSupportButton: boolean;
    enableWorkTreeManager: boolean;
    enableTagFilters: boolean;
    enableVectorSearch: boolean;
    enableWhisper: boolean;
    alwaysTranscribe: boolean;
    enableFavicon: boolean;
    enableMediaSession: boolean;
    enableMenuIconFixer: boolean;
    enableStoreBackup: boolean;
    enableHVDBLink: boolean;
    enableInterfaceTranslator: boolean;
    enablePageTitleManager: boolean;
    enableKeyboardManager: boolean;
    enableRouteStateSync: boolean;

    enableMediaViewer: boolean;
    enablePlayerFullscreen: boolean;
    enablePlayerGallery: boolean;
    enableWorkTreeCopy: boolean;
    enableCommentSection: boolean;
    enableInfiniteScroll: boolean;
    enableJoiTool: boolean;
    enableVisualizer: boolean;

    // Gallery
    galleryAutoSlideshow: boolean;
    galleryAutoSlideshowInterval: number;

    // Note: apiServerUrl is no longer used - we read from host app's "Select server" setting
}

export type ConfigKey = keyof PluginConfig;

// ============================================================================
// Application State Types
// ============================================================================

export type RadioState = 'idle' | 'playing' | 'skipping' | 'loading';

export interface RadioModeState {
    isActive: boolean;
    state: RadioState;
    currentWorkId: string | null;
    recentWorkIds: string[];
    playlistMode: boolean;
    lastTrackSrc: string | null;
}

export interface LearnerModeState {
    isActive: boolean;
    currentSegment: { jp: string; translated: string } | null;
    showJapanese: boolean;
    segments: Array<{ start: number; end: number; text: string; translated?: string }>;
}

export interface WhisperState {
    isTranscribing: boolean;
    isLoadingModel: boolean;
    progress: number;
    progressMessage: string;
    currentTrackSrc: string | null;
}

export interface PlaylistModeState {
    isActive: boolean;
    workIds: string[];       // Array of RJ codes in playlist order
    currentWorkIndex: number;
    playlistId: string | null;
    playlistName: string | null;
}

export interface SearchState {
    pendingOrder?: string;
    pendingSort?: 'asc' | 'desc';
}

export interface AppState {
    radio: RadioModeState;
    learner: LearnerModeState;
    whisper: WhisperState;
    playlist: PlaylistModeState;
    search: SearchState;
    isInitialized: boolean;
}

// ============================================================================
// Event Types
// ============================================================================

export interface AppEvents {
    'track:change': { track: PlayerTrack; workId: string };
    'track:end': { track: PlayerTrack; workId: string };
    'work:change': { workId: string; work: WorkDetail };
    'radio:toggle': { isActive: boolean };
    'radio:skip': { fromWorkId: string; toWorkId: string };
    'whisper:start': { trackSrc: string };
    'whisper:toggle': void;
    'whisper:progress': { percent: number; message: string; stage: string };
    'whisper:update': {
        text: string;
        segments: Array<{ start: number; end: number; text: string; words?: Array<{ start: number; end: number; text: string }> }>;
        final: boolean;
        chunkIndex?: number;
        fromCache?: boolean;
        leadSec?: number;
        live?: boolean;
        lagSec?: number;
        source?: 'update' | 'complete' | 'cache' | 'seek';
    };
    'whisper:complete': { text: string };
    'whisper:error': { message: string; isHlsWarning?: boolean };
    'whisper:hls-warning': { message: string };
    'whisper:clear': void;
    'whisper:cache-updated': { trackKey: string; cacheKey: string };
    'whisper:segment-translated': { count: number };
    'whisper:fallback': { originalModel: string; fallbackModel: string; reason?: string };
    'translation:progress': { percent: number; message: string; stage?: string; model?: string };
    'cache:evicted': { count: number; freedBytes: number };
    'cache:cleared': { count: number; freedBytes: number };
    'cache:added': { url: string; size: number };
    'config:change': { key: ConfigKey; value: unknown; oldValue: unknown };
    'playlist:active': { isActive: boolean; workIds?: string[]; playlistId?: string };
    'playlist:navigate': { direction: 'next' | 'previous'; workId: string; index: number };
    'playlist:progress': { current: number; total: number; workId: string };
    'playlist:shuffled': { workIds: string[]; currentWorkIndex: number };
    'title:update': { title: string };
    'player:rate-change': { rate: number };
    'player:nav-prev': {};
    'player:nav-next': {};
    'progress:update': { workId: string; progress: string; oldProgress: string | null };
    'flatview:toggle': { active: boolean };
    'lang:change': { lang: string };
    'worktree:path-change': { path: string[] };
    'fullscreen:enter': void;
    'fullscreen:exit': void;
    'joi:toggle': void;
    'joi:trigger': { state: string; keyword: string; source: 'jp' | 'en' };
    'viz:toggle': void;

}

export type AppEventName = keyof AppEvents;
export type AppEventPayload<E extends AppEventName> = AppEvents[E];

export type WhisperUpdatePayload = AppEventPayload<'whisper:update'>;
