/**
 * Store & State Types
 */

import type { PlayerTrack, PlayMode, PlayModeObject, WorkDetail, WorkSummary } from './api';

// ============================================================================
// Kikoeru Store Types (Host Application State)
// ============================================================================

export interface AudioPlayerState {
    hide?: boolean;
    playing?: boolean;
    currentTime: number;
    duration: number;
    queue?: PlayerTrack[];
    queueIndex?: number;
    playMode?: PlayMode | PlayModeObject;
    muted?: boolean;
    volume?: number;
    currentLyric?: string;
    sleepTime?: number | null;
    sleepMode?: boolean;
    rewindSeekTime?: number;
    forwardSeekTime?: number;
    rewindSeekMode?: boolean;
    forwardSeekMode?: boolean;
    currentTrack?: PlayerTrack;
    currentPlayingFile?: PlayerTrack;
    playlist?: PlayerTrack[];
    work?: WorkDetail;
    lrcLines?: Array<{ time: number; text: string }>;
    src?: string;
    source?: string;
    currentSrc?: string;
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
    subscribe?: (fn: (mutation: { type: string; payload?: unknown }, state: KikoeruStoreState) => void) => () => void;
    _actions?: Record<string, unknown>;
}

// ============================================================================
// Vue App Types
// ============================================================================

export interface VueRouter {
    push(location: string | { path?: string; query?: Record<string, string | string[] | undefined> }): Promise<void>;
    replace(location: string | { path?: string; query?: Record<string, string | string[] | undefined> }): Promise<void>;
    go(n: number): void;
    back(): void;
    forward(): void;
    beforeEach(guard: (to: VueRoute, from: VueRoute, next: () => void) => void): () => void;
    currentRoute: VueRoute;
}

export interface VueRoute {
    path: string;
    params: Record<string, string | undefined>;
    query: Record<string, string | string[] | undefined>;
    hash: string;
    fullPath: string;
    matched: unknown[];
    name?: string;
    meta?: Record<string, unknown>;
}

export interface AxiosInstance {
    defaults: {
        baseURL?: string;
    };
    get<T = unknown>(url: string, config?: {
        params?: Record<string, unknown>;
        responseType?: 'blob' | 'json' | 'text' | 'arraybuffer';
        headers?: Record<string, string>;
        [key: string]: unknown;
    }): Promise<{ data: T; status?: number }>;
    post<T = unknown>(url: string, data?: unknown, config?: Record<string, unknown>): Promise<{ data: T; status?: number }>;
    put<T = unknown>(url: string, data?: unknown, config?: Record<string, unknown>): Promise<{ data: T; status?: number }>;
    delete<T = unknown>(url: string, config?: Record<string, unknown>): Promise<{ data: T; status?: number }>;
}

export interface KikoeruApp {
    $store: KikoeruStore;
    $router: VueRouter;
    $route: VueRoute;
    $axios: AxiosInstance;
    $watch: <T>(
        expression: string | (() => T),
        callback: (newValue: T, oldValue: T) => void,
        options?: { immediate?: boolean; deep?: boolean; sync?: boolean }
    ) => () => void;
    $on?: (event: string, callback: (...args: unknown[]) => void) => void;
    $children?: KikoeruApp[];
    $options?: Record<string, unknown>;
    $data?: Record<string, unknown>;
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
    __proto__?: {
        constructor: new (...args: unknown[]) => unknown;
    };
    [key: string]: unknown;
}

/** Item in the WorkTree fatherFolder computed array */
export interface FatherFolderItem {
    title: string;
    type?: string;
    [key: string]: unknown;
}

export interface WorkTreeComponent extends KikoeruApp {
    path: string[];
    tree?: unknown[];
    fatherFolder?: FatherFolderItem[];
    _vnode?: unknown;
    _data?: Record<string, unknown>;
    _isDestroyed?: boolean;
    _isBeingDestroyed?: boolean;
    $set?: (target: unknown, key: string, value: unknown) => void;
    $forceUpdate?: () => void;
    $nextTick?: (callback: () => void) => void;
}

// ============================================================================
// Plugin Config Types
// ============================================================================

export interface PluginConfig {
    // Radio Mode
    playAllInFolder: boolean;
    shuffle: boolean;
    loopPlaylist: boolean;
    autoFilterFolders: boolean;
    radioUseFlatTracks: boolean;
    // Playlist Mode (separate from Radio settings)
    playlistPlayAllInFolder: boolean;
    playlistShuffle: boolean;
    playlistLoopPlaylist: boolean;
    playlistAutoFilterFolders: boolean;
    playlistUseFlatTracks: boolean;
    playlistAutoProgress: boolean;
    playlistSePref: boolean;
    playlistBgmPref: boolean;

    // Learner Mode
    showJP: boolean;
    subtitleLang: string;
    primarySubtitleLang: string;
    karaokeMode: boolean;
    segmentMode: boolean;

    // AI Features
    whisperModel: string;
    whisperTask: string;
    whisperQuantized: boolean;
    whisperOverrideSubs: boolean;
    whisperLiveChunkSec: number;
    whisperLiveOverlapSec: number;
    whisperCacheTranscripts: boolean;
    whisperAutoWarmup: boolean;
    alwaysTranscribe: boolean;
    forceWhisperWasm: boolean;
    whisperFirefoxWebgpu: boolean;
    vectorSearchApiKey: string;
    vectorIndexCursor: number;
    vectorIndexLatestWorkId: string;
    vectorIndexVersion: number;
    vectorSearchModel: string;
    vectorSearchApiKeyHash: string;
    vectorRateLimitBackoff: number;
    vectorRateLimitCooldownUntil: number;

    // Cache
    cacheLimitGB: number;

    // Transcript Sync
    transcriptSyncEnabled: boolean;
    transcriptSyncProjectId: string;
    transcriptSyncApiKey: string;
    transcriptSyncCollection: string;

    // Translation
    translateCnToJp: boolean;

    // Folder Selection
    sePref: boolean;
    bgmPref: boolean;

    // UI
    autoProgress: boolean;
    dynamicFavicon: boolean;
    flatView: boolean;
    playbackRate: number;
    learnerBlur: boolean;
    sfwMode: boolean;
    translateMode: boolean;

    // Auto Progress (enhanced)
    autoProgressMarked: boolean;
    autoProgressListening: boolean;
    autoProgressListened: boolean;
    autoProgressReplay: boolean;
    autoProgressPostponed: boolean;
    autoProgressReplayThreshold: number;
    autoProgressRadioSkipThreshold: number;

    // Radio Runtime (persisted for refresh survival)
    radioManuallyPaused: boolean;

    // JPDB Integration
    enableJpdb: boolean;
    jpdbApiToken: string;
    jpdbShowFurigana: boolean;
    jpdbShowPitchAccent: boolean;
    jpdbPitchStyle: string;
    jpdbSubtitleFurigana: boolean;
    jpdbSiteFurigana: boolean;
    jpdbMiningDeck: string;
    jpdbAddToForq: boolean;
    jpdbDisableReviews: boolean;
    jpdbUseTwoGrades: boolean;
    jpdbNeverForgetDeck: string;
    jpdbBlacklistDeck: string;
    hotkeyJpdbPopover: string;

    // Feature Toggles
    enableAdvancedSearch: boolean;
    enableCommentSection: boolean;
    enableContinueListening: boolean;
    enableFavicon: boolean;
    enableHVDBLink: boolean;
    enableInfiniteScroll: boolean;
    enableInterfaceTranslator: boolean;
    enableJoiTool: boolean;
    enableKeyboardManager: boolean;
    enableLearnerMode: boolean;
    enableMediaSession: boolean;
    enableMediaViewer: boolean;
    enableMenuIconFixer: boolean;
    enablePageTitleManager: boolean;
    enablePlayerFullscreen: boolean;
    enablePlayerGallery: boolean;
    enablePlayerTranslator: boolean;
    enablePlaylistDiscovery: boolean;
    enableRouteStateSync: boolean;
    enableStoreBackup: boolean;
    enableSupportButton: boolean;
    enableTagFilters: boolean;
    enableVectorSearch: boolean;
    enableVisitCounter: boolean;
    enableVisualizer: boolean;
    enableWhisper: boolean;
    enableWorkMetadata: boolean;
    enableWorkTreeCopy: boolean;
    enableWorkTreeManager: boolean;

    // Feature Options
    alwaysShowJoi: boolean;
    alwaysShowVisualizer: boolean;
    galleryAutoSlideshow: boolean;
    galleryAutoSlideshowInterval: number;

    // Keyboard Shortcuts
    hotkeyPlayPause: string;
    hotkeyMute: string;
    hotkeyFullscreen: string;
    hotkeySeekBack: string;
    hotkeySeekForward: string;
    hotkeySeekBackLong: string;
    hotkeySeekForwardLong: string;
    hotkeyVolumeUp: string;
    hotkeyVolumeDown: string;
    hotkeyPrevLine: string;
    hotkeyNextLine: string;
    hotkeyPrevTrack: string;
    hotkeyNextTrack: string;
    hotkeySpeedUp: string;
    hotkeySpeedDown: string;
    hotkeySpeedReset: string;
    hotkeyToggleBlur: string;
    hotkeyToggleJP: string;
    hotkeyGalleryPrev: string;
    hotkeyGalleryNext: string;
    hotkeyGalleryExclude: string;

    // Debug
    debug: boolean;
    enableLogging: boolean;

    // DLsite Proxy
    dlsiteProxyUrl: string;

    // ASMR API proxy (Cloudflare Worker fallback route; empty = built-in default)
    apiProxyUrl: string;
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
    player?: AudioPlayerState;
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
    'radio:state': { state: RadioState; currentWorkId: string | null; recentWorkIds: string[] };
    'radio:skip': { fromWorkId: string; toWorkId: string };
    'whisper:toggle': void;
    'whisper:progress': { percent: number; message: string; stage: string };
    'whisper:update': {
        text: string;
        segments: Array<{ start: number; end: number; text: string; words?: Array<{ start: number; end: number; text: string }> }>;
        final: boolean;
        chunkIndex?: number;
        fromCache?: boolean;
        live?: boolean;
        source?: string;
        leadSec?: number;
    };
    'whisper:complete': { text: string };
    'whisper:error': { message: string; isHlsWarning?: boolean };
    'whisper:clear': void;
    'cache:evicted': { count: number; freedBytes: number };
    'cache:cleared': { count: number; freedBytes: number };
    'cache:added': { url: string; size: number };
    'config:change': { key: ConfigKey; value: unknown; oldValue: unknown };
    'playlist:active': { isActive: boolean; workIds?: string[]; playlistId?: string };
    'playlist:navigate': { direction: 'next' | 'previous'; workId: string; index: number };
    'playlist:progress': { current: number; total: number; workId: string };
    'title:update': { title: string };
    'player:rate-change': { rate: number };
    'player:nav-prev': {};
    'player:nav-next': {};
    'progress:update': { workId: string; progress: string; oldProgress: string | null };
    'flatview:toggle': { active: boolean };
    'lang:change': { lang: 'en' | 'zh' | 'ja' | string };
    // Ephemeral blur toggle (playback only, does not persist to config)
    'blur:toggle': void;
    // Toggle events from overflow menu
    'joi:toggle': void;
    'joi:trigger': { state: string; keyword: string; source: string };
    'viz:toggle': void;
    // Whisper supplementary events
    'whisper:fallback': { originalModel: string; fallbackModel: string; reason?: string };
    'whisper:cache-updated': { trackKey: string; cacheKey: string };
    'whisper:segment-translated': { count: number };
    // Embedding progress
    'embedding:progress': { percent: number; message: string; stage: string };
    // Fullscreen events
    'fullscreen:enter': void;
    'fullscreen:exit': void;
    // Work tree navigation
    'worktree:path-change': { path: string[] };
    'worktree:enhanced': { workTree: HTMLElement };
    // Gallery navigation
    'gallery:nav': { direction: -1 | 1 };
    'gallery:exclude': {};
    // Playlist supplementary
    'playlist:shuffleToggled': { enabled: boolean };
    'playlist:loopToggled': { enabled: boolean };
    // GPU coordination
    'webgpu:failed': { source: string };
    'gpu:device-lost': { worker: 'embedding' | 'whisper' };
    'gpu:device-lost-broadcast': { source: 'embedding' | 'whisper' };
    'whisper:transcribing': { active: boolean };
    'embedding:dead': {};
    'embedding:gpu-failed': {};
}

export type AppEventName = keyof AppEvents;
export type AppEventPayload<E extends AppEventName> = AppEvents[E];

export type WhisperUpdatePayload = AppEventPayload<'whisper:update'>;
