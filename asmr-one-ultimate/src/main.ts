/**
 * ASMR.one Ultimate - Main Entry Point
 *
 * Initializes the plugin and orchestrates all features.
 */

import './styles/variables.css';
import './styles/fixes.css';
import './styles/ui.css';
import './styles/components/_learner.css';
import './styles/components/_playlist.css';
import './styles/components/_settings.css';
import './styles/components/_advanced-search.css';
import './styles/components/_metadata.css';
import './styles/components/_media_viewer.css';
import './styles/components/_comments.css';
import './styles/components/_flat_view.css';
import './styles/components/_sfw_mode.css';
import './styles/components/_player_fullscreen.css';
import './styles/components/_joi_tool.css';
import './styles/components/_visualizer.css';
import './styles/components/_visit_counter.css';

import { KikoeruBridge } from './infrastructure/KikoeruBridge';
import { getAudioElement, hasPlayerBar } from './core/DomUtils';
import { AudioCache } from './infrastructure/AudioCache';
import { StorageManager } from './infrastructure/StorageManager';
import { WorkTreeCopy } from './features/WorkTreeCopy';
import { CorsFixer } from './features/CorsFixer';
import { TagDatabase } from './infrastructure/TagDatabase';
import { AppStore } from './store/AppStore';
import { initReactiveConfig } from './store/ReactiveConfig';
import { DialogStyles, Logger, I18n, Config } from './core/Utils';
import { TranslationService } from './services/TranslationService';
import { EmbeddingService } from './services/EmbeddingService';
import { CentralObserver } from './core/CentralObserver';

// Features
import { RadioMode } from './features/radio';
import { PlaylistMode } from './features/playlist';
import { LearnerModeController } from './features/LearnerModeController';
import { SettingsController, API } from './features/settings/SettingsController';
import { AutoProgress } from './features/AutoProgress';
import { ShuffleFeature } from './features/Shuffle';
import { AdvancedSearchController } from './features/AdvancedSearchController';
import { WorkMetadataController } from './features/WorkMetadataController';
import { PlayerTranslator } from './features/PlayerTranslator';
import { SupportButton } from './features/SupportButton';
import { WorkTreeManager } from './features/WorkTreeManager';
import { TagFilters } from './features/TagFilters';
import { TranslatedTags } from './features/TranslatedTags';
import { VectorSearchController } from './features/VectorSearchController';
import { Whisper } from './features/Whisper';
import { TranscriptFileInjector } from './features/TranscriptFileInjector';
import { MediaViewerController } from './features/MediaViewerController';
import { StoreBackup } from './features/StoreBackup';
import { HVDBLinkController } from './features/HVDBLinkController';
import { CommentSectionController } from './features/CommentSectionController';
import { InterfaceTranslator } from './features/InterfaceTranslator';
import { PageTitleManager } from './features/PageTitleManager';
import { SidebarMenuController } from './ui/SidebarMenuController';
import { KeyboardManager } from './features/KeyboardManager';
import { RouteStateSync } from './features/RouteStateSync';
import { PlaylistDiscoveryController } from './features/PlaylistDiscoveryController';
import { InfiniteScrollController } from './features/InfiniteScrollController';
import { PlayerFullscreenController } from './features/PlayerFullscreenController';
import { PlayerGalleryController } from './features/PlayerGalleryController';
import { JoiTool } from './features/JoiTool';
import { VisualizerController } from './features/VisualizerController';
import { VisitCounter } from './features/VisitCounter';
import { ContinueListeningController } from './features/ContinueListeningController';


declare const unsafeWindow: Window & typeof globalThis;

// ============================================================================
// Prevent duplicate initialization on SPA navigation
// ============================================================================

const globalWindow = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) as Window & {
    __ASMR_ULTIMATE_INITIALIZED__?: boolean;
    __ASMR_ULTIMATE_CLEANUP__?: () => void;
    ASMRUlt?: ASMRUltAPI;
};

// Track if already initialized to prevent duplicate initialization
const wasAlreadyInitialized = globalWindow.__ASMR_ULTIMATE_INITIALIZED__ === true;
globalWindow.__ASMR_ULTIMATE_INITIALIZED__ = true;

// ============================================================================
// Global API
// ============================================================================

interface ASMRUltAPI {
    log: typeof Logger.log;
    toggleRadio: () => void;
    skipRadio: () => void;
    toggleShuffle: () => void;
    isRadioActive: () => boolean;
    updateRadioStatus: (on: boolean) => void;
    search: (term: string) => void;
    // Playlist API
    playlistNext: () => void;
    playlistPrev: () => void;
    isPlaylistActive: () => boolean;
    getPlaylistProgress: () => { current: number; total: number; workId: string | null };
    activatePlaylist: (workIds: string[], playlistId?: string) => void;
    deactivatePlaylist: () => void;
    [key: string]: unknown;
}

const notReady = () => { Logger.warn('[API] Plugin not yet initialized'); };
const apiRef: ASMRUltAPI = {
    ...API,
    log: Logger.log,
    toggleRadio: notReady,
    skipRadio: notReady,
    toggleShuffle: notReady,
    isRadioActive: () => false,
    updateRadioStatus: notReady,
    search: notReady,
    playlistNext: notReady,
    playlistPrev: notReady,
    isPlaylistActive: () => false,
    getPlaylistProgress: () => ({ current: 0, total: 0, workId: null }),
    activatePlaylist: notReady,
    deactivatePlaylist: notReady,
};

globalWindow.ASMRUlt = apiRef;

// ============================================================================
// Initialization
// ============================================================================

async function initialize(): Promise<void> {
    const bridge = KikoeruBridge.getInstance();

    try {
        // Migrate tag translations from IndexedDB to GM_* (one-time)
        await TagDatabase.migrateFromIndexedDB();

        await bridge.initialize();
        Logger.log('Bridge initialized!');
        Logger.log('Running on origin:', window.location.origin);

        // Initialize reactive config (must be after bridge init)
        initReactiveConfig();

        // Start the central observer for all DOM watchers
        CentralObserver.start();

        DialogStyles.injectSizing();

        // Startup diagnostics
        logStartupStatus(bridge);

        // Sync i18n from host app
        I18n.syncFromHost();
        Logger.debug('[Settings] I18n lang:', I18n.lang);
        Logger.debug('[Settings] navigator.language:', navigator.language);

        // Populate config cache (first getAllConfig() seeds the L1 in-memory cache)
        const allConfig = AppStore.getAllConfig();
        if (Config.get('debug')) {
            Logger.debug('[Settings] Config:', JSON.stringify(allConfig, null, 2));
        }

        // Initialize core systems
        Logger.debug('[Init] Initializing RadioMode...');
        const radioMode = RadioMode.getInstance();
        radioMode.initialize();
        Logger.debug('[Init] RadioMode initialized');

        Logger.debug('[Init] Initializing PlaylistMode...');
        const playlistMode = PlaylistMode.getInstance();
        playlistMode.initialize();
        Logger.debug('[Init] PlaylistMode initialized');

        Logger.debug('[Init] Initializing PlaylistDiscoveryController...');
        const playlistDiscovery = new PlaylistDiscoveryController();
        playlistDiscovery.enable();
        Logger.debug('[Init] PlaylistDiscoveryController enabled');

        Logger.debug('[Init] Initializing InfiniteScrollController...');
        const infiniteScrollController = InfiniteScrollController.getInstance();
        infiniteScrollController.enable();
        Logger.debug('[Init] InfiniteScrollController enabled');

        Logger.debug('[Init] Initializing LearnerModeController...');
        const learnerModeController = new LearnerModeController();
        learnerModeController.enable();
        Logger.debug('[Init] LearnerModeController enabled');

        Logger.debug('[Init] Initializing SettingsController...');
        const settingsController = new SettingsController();
        settingsController.enable();
        Logger.debug('[Init] SettingsController initialized');

        // Setup sidebar menu with radio toggle (Vue 3 SFC via FeatureController)
        const toggleRadio = async () => {
            await radioMode.toggle();
            // Radio status is now updated reactively via EventBus in the SFC
        };

        const sidebarMenu = new SidebarMenuController(toggleRadio);
        sidebarMenu.enable();
        // Initial radio status is read reactively from RadioMode.isActive in the SFC

        // Track playlist mode
        setupPlaylistModeTracking(bridge);

        // Quality of life features
        initializeQOLFeatures();

        // Eagerly warm up translation models so first work page load is instant
        if (Config.get('preferLocalTranslation') !== false &&
            (Config.get('enablePlayerTranslator') || Config.get('enableLearnerMode'))) {
            TranslationService.ensureLocalModelReady(); // fire-and-forget
        }

        // Eagerly warm up embedding model so first search is instant
        if (Config.get('enableVectorSearch')) {
            EmbeddingService.ensureReady().catch(() => { /* non-critical */ });
        }

        // AI features
        await initializeAIFeatures();

        // Infrastructure
        initializeInfrastructure(bridge);

        // Update global API
        updateGlobalAPI(radioMode, bridge);

        // Setup audio recovery
        setupAudioRecovery();

        Logger.log('All systems operational.');
    } catch (error) {
        Logger.error('Fatal Startup Error:', error);
    }
}

function logStartupStatus(bridge: KikoeruBridge): void {
    const check = (label: string, ok: boolean): void => {
        Logger.debug(`[Startup] ${label}: ${ok ? 'ready' : 'missing'}`);
    };

    check('store', !!bridge.store);
    check('router', !!bridge.router);
    check('axios', typeof bridge.axios?.get === 'function');
    check('audio-player', !!document.querySelector('.audio-player'));
    check('player-bar', hasPlayerBar());
    check('header-actions', !!document.querySelector('.q-header .q-toolbar'));
    check('sidebar', !!document.querySelector('.q-drawer--left .q-list, .q-drawer .q-list'));

    const currentTrack = bridge.currentTrack;
    if (currentTrack?.title) {
        Logger.debug('Current track:', currentTrack.title);
    }
}

function setupPlaylistModeTracking(bridge: KikoeruBridge): void {
    let playlistActive = false;

    const updatePlaylistStatus = (route: { path?: string }): void => {
        const path = route?.path || '';
        if (path.startsWith('/playlist')) {
            playlistActive = true;
        } else if (!path.startsWith('/work/')) {
            playlistActive = false;
        }
        // Playlist status is now handled reactively in the SidebarMenu SFC via EventBus
        AppStore.setRadioState({ playlistMode: playlistActive });
    };

    bridge.$watch?.('$route', (to: { path?: string }) => updatePlaylistStatus(to));
    updatePlaylistStatus(bridge.route);
}

function initializeQOLFeatures(): void {
    Logger.debug('[Init] Initializing QOL features...');
    // All features now use CentralObserver instead of individual observers

    if (Config.get('enableSupportButton')) {
        const supportButton = new SupportButton();
        supportButton.enable();
        Logger.debug('[Init] SupportButton enabled');
    }

    if (Config.get('enableTagFilters')) {
        const tagFilters = new TagFilters();
        tagFilters.enable();
        Logger.debug('[Init] TagFilters enabled');
    }

    const shuffleFeature = new ShuffleFeature();
    shuffleFeature.enable();
    Logger.debug('[Init] ShuffleFeature enabled');

    const autoProgress = new AutoProgress();
    autoProgress.enable();
    Logger.debug('[Init] AutoProgress enabled');

    if (Config.get('enableWorkTreeManager')) {
        // Work Tree Manager (coordinates Flat View + Folder Diving)
        const treeManager = WorkTreeManager.getInstance();
        treeManager.enable();
        Logger.debug('[Init] WorkTreeManager enabled');
    }

    if (Config.get('enableAdvancedSearch')) {
        const advancedSearch = new AdvancedSearchController();
        advancedSearch.enable();
        Logger.debug('[Init] AdvancedSearch enabled');
    }

    if (Config.get('enableWorkTreeCopy')) {
        const workTreeCopy = new WorkTreeCopy();
        workTreeCopy.enable();
        Logger.debug('[Init] WorkTreeCopy enabled');
    }

    if (Config.get('enableWorkMetadata')) {
        const workMetadata = new WorkMetadataController();
        workMetadata.enable();
        Logger.debug('[Init] WorkMetadata enabled');
    }

    if (Config.get('enableCommentSection')) {
        const commentSection = new CommentSectionController();
        commentSection.enable();
        Logger.debug('[Init] CommentSection enabled');
    }

    if (Config.get('enablePlayerTranslator')) {
        const playerTranslator = new PlayerTranslator();
        playerTranslator.enable();
        Logger.debug('[Init] PlayerTranslator enabled');
    }

    // TranslatedTags - now uses CentralObserver
    const translatedTags = TranslatedTags.getInstance();
    translatedTags.enable();
    Logger.debug('[Init] TranslatedTags enabled');

    if (Config.get('enableMediaViewer')) {
        // MediaViewer - inline preview for images and videos
        const mediaViewer = MediaViewerController.getInstance();
        mediaViewer.enable();
        Logger.debug('[Init] MediaViewer enabled');
    }

    if (Config.get('enablePlayerFullscreen')) {
        const playerFullscreen = PlayerFullscreenController.getInstance();
        playerFullscreen.enable();
        Logger.debug('[Init] PlayerFullscreen enabled');
    }

    if (Config.get('enablePlayerGallery')) {
        const playerGallery = new PlayerGalleryController();
        playerGallery.enable();
        Logger.debug('[Init] PlayerGallery enabled');
    }

    if (Config.get('enableJoiTool')) {
        const joiTool = JoiTool.getInstance();
        joiTool.enable();
        Logger.debug('[Init] JoiTool enabled');
    }

    if (Config.get('enableVisualizer')) {
        const visualizer = new VisualizerController();
        visualizer.enable();
        Logger.debug('[Init] Visualizer enabled');
    }

    if (Config.get('enableVisitCounter')) {
        const visitCounter = new VisitCounter();
        visitCounter.enable();
        Logger.debug('[Init] VisitCounter enabled');
    }

    if (Config.get('enableContinueListening')) {
        const continueListening = new ContinueListeningController();
        continueListening.enable();
        Logger.debug('[Init] ContinueListening enabled');
    }

    if (Config.get('enableHVDBLink')) {
        // HVDBLink - link to HVDB next to DLsite link
        const hvdbLink = new HVDBLinkController();
        hvdbLink.enable();
        Logger.debug('[Init] HVDBLink enabled');
    }

    if (Config.get('enableInterfaceTranslator')) {
        // InterfaceTranslator - localizes interface elements
        const interfaceTranslator = InterfaceTranslator.getInstance();
        interfaceTranslator.enable();
        Logger.debug('[Init] InterfaceTranslator enabled');
    }

    if (Config.get('enablePageTitleManager')) {
        // PageTitleManager - fixes "undefined" in tab bar
        const titleManager = new PageTitleManager();
        titleManager.enable();
        Logger.debug('[Init] PageTitleManager enabled');
    }

    if (Config.get('enableRouteStateSync')) {
        // RouteStateSync - syncs store state with URL
        const routeStateSync = new RouteStateSync();
        routeStateSync.enable();
        Logger.debug('[Init] RouteStateSync enabled');
    }

    if (Config.get('enableKeyboardManager')) {
        // KeyboardManager - global shortcuts
        const keyboardManager = KeyboardManager.getInstance();
        keyboardManager.enable();
        Logger.debug('[Init] KeyboardManager enabled');
    }

    Logger.debug('[Init] All QOL features initialized');
}

async function initializeAIFeatures(): Promise<void> {
    Logger.debug('[Init] Initializing AI features...');
    // All features now use CentralObserver instead of individual observers

    if (Config.get('enableVectorSearch')) {
        const vectorSearch = new VectorSearchController();
        vectorSearch.enable();
        Logger.debug('[Init] VectorSearch enabled');
    }

    if (Config.get('enableWhisper')) {
        const whisper = Whisper.getInstance();
        whisper.enable();
        Logger.debug('[Init] Whisper enabled');

        const transcriptFiles = new TranscriptFileInjector();
        transcriptFiles.enable();
        Logger.debug('[Init] TranscriptFileInjector enabled');
    }

    // Parallel dynamic imports — each is independent
    await Promise.all([
        Config.get('enableFavicon') && import('./features/FaviconNowPlaying').then(({ FaviconNowPlaying }) => {
            const faviconManager = new FaviconNowPlaying();
            faviconManager.enable();
            Logger.debug('[Init] FaviconNowPlaying enabled');
            if (globalWindow.ASMRUlt) {
                globalWindow.ASMRUlt.testFavicon = (color?: string) => faviconManager.testWithColor(color);
                globalWindow.ASMRUlt.forceFavicon = () => faviconManager.forceUpdate();
            }
        }),
        Config.get('enableMediaSession') && import('./features/MediaSessionManager').then(({ MediaSessionManager }) => {
            new MediaSessionManager().enable();
            Logger.debug('[Init] MediaSessionManager enabled');
        }),
        Config.get('enableMenuIconFixer') && import('./features/MenuIconFixer').then(({ MenuIconFixer }) => {
            new MenuIconFixer().enable();
            Logger.debug('[Init] MenuIconFixer enabled');
        }),
    ].filter(Boolean));

    Logger.debug('[Init] All AI features initialized');
}

function initializeInfrastructure(bridge: KikoeruBridge): void {
    Logger.debug('[Init] Initializing infrastructure...');
    CorsFixer.enable();
    const audioCache = new AudioCache();
    const storageManager = new StorageManager();
    storageManager.enable();
    Logger.debug('[Init] StorageManager enabled');

    if (Config.get('enableStoreBackup')) {
        const storeBackup = new StoreBackup();
        storeBackup.enable();
        Logger.debug('[Init] StoreBackup enabled');
    }

    // Enable audio caching (sets up Vuex watcher for track changes)
    audioCache.enable();
    Logger.debug('[Init] AudioCache enabled');

    // Intercept playTrack for caching
    if (bridge.store.dispatch) {
        const originalDispatch = bridge.store.dispatch.bind(bridge.store);
        bridge.store.dispatch = async (typeOrAction: string | { type: string;[key: string]: unknown }, payload?: unknown, options?: unknown) => {
            const actionType = typeof typeOrAction === 'string' ? typeOrAction : typeOrAction?.type;
            const actionPayload = typeof typeOrAction === 'string' ? payload : typeOrAction;
            Logger.debug(`[Dispatch] ${actionType}`, actionPayload);
            if (actionType === 'AudioPlayer/playTrack') {
                await audioCache.interceptPlay(actionPayload);
            }
            return originalDispatch(typeOrAction as string, payload, options);
        };
        Logger.debug('[Init] Store dispatch intercepted for audio caching');
    }
    Logger.debug('[Init] Infrastructure initialized');
}

function updateGlobalAPI(
    radioMode: RadioMode,
    bridge: KikoeruBridge
): void {
    const playlistMode = PlaylistMode.getInstance();

    const updates: Partial<ASMRUltAPI> = {
        toggleRadio: () => {
            radioMode.toggle();
            // Radio status is now updated reactively via EventBus in the SFC
        },
        skipRadio: () => radioMode.skipToNext(),
        isRadioActive: () => radioMode.isActive,
        updateRadioStatus: () => {
            // No-op: radio status is now managed reactively via EventBus in the SFC
        },
        search: (term: string) => bridge.dispatch('Works/search', { keywords: term }),
        // Playlist API
        playlistNext: () => playlistMode.next(),
        playlistPrev: () => playlistMode.previous(),
        isPlaylistActive: () => playlistMode.isActive,
        getPlaylistProgress: () => playlistMode.getProgress(),
        activatePlaylist: (workIds: string[], playlistId?: string) => playlistMode.activate(workIds, playlistId),
        deactivatePlaylist: () => playlistMode.deactivate(),
    };

    Object.assign(apiRef, updates);
    Object.assign(globalWindow.ASMRUlt!, updates);
}

function isValidAudioSrc(src: string): boolean {
    if (!src) return false;
    try {
        const url = new URL(src);
        // Just a bare origin (e.g. "https://asmr.one/") is not a real audio file
        return url.pathname.length > 1;
    } catch {
        return false;
    }
}

function setupAudioRecovery(): void {
    const audio = getAudioElement();
    if (!audio) {
        Logger.warn('[AudioRecovery] No <audio> element found, skipping recovery setup');
        return;
    }
    Logger.debug('[AudioRecovery] Setting up audio recovery listeners');

    let audioRecoveryAttempts = 0;
    const MAX_RECOVERY_ATTEMPTS = 3;
    const RECOVERY_COOLDOWN = 30000; // 30 seconds
    let lastRecoveryTime = 0;
    let lastKnownGoodSrc = '';
    let waitingTimer: ReturnType<typeof setTimeout> | null = null;

    // Reset recovery state when the source genuinely changes to a valid URL
    const srcObserver = new MutationObserver(() => {
        const src = audio.getAttribute('src') || audio.src;
        if (isValidAudioSrc(src) && src !== lastKnownGoodSrc) {
            lastKnownGoodSrc = src;
            audioRecoveryAttempts = 0;
            if (waitingTimer !== null) {
                clearTimeout(waitingTimer);
                waitingTimer = null;
            }
        }
    });
    srcObserver.observe(audio, { attributes: true, attributeFilter: ['src'] });

    audio.addEventListener('stalled', () => {
        if (!isValidAudioSrc(audio.src)) return; // Don't retry invalid src
        Logger.warn('[AudioRecovery] Audio stalled, retrying playback...', { src: audio.src, readyState: audio.readyState, currentTime: audio.currentTime });
        audio.play().catch(err => Logger.debug('[AudioRecovery] Stalled retry failed:', err));
    });

    audio.addEventListener('waiting', () => {
        Logger.debug('[AudioRecovery] Audio waiting', { src: audio.src, readyState: audio.readyState, paused: audio.paused });
        if (waitingTimer !== null) clearTimeout(waitingTimer);
        waitingTimer = setTimeout(() => {
            waitingTimer = null;
            if (audio.readyState < 3 && !audio.paused && isValidAudioSrc(audio.src)) {
                const now = Date.now();

                // Reset counter after cooldown period
                if (now - lastRecoveryTime > RECOVERY_COOLDOWN) {
                    audioRecoveryAttempts = 0;
                }

                if (audioRecoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
                    Logger.warn('[AudioRecovery] Max recovery attempts reached, skipping reload');
                    return;
                }

                audioRecoveryAttempts++;
                lastRecoveryTime = now;

                Logger.warn('[AudioRecovery] Audio stuck in waiting. Reloading source...', { src: audio.src, readyState: audio.readyState, attempt: audioRecoveryAttempts });
                const current = audio.src;
                const savedTime = audio.currentTime;
                audio.src = '';
                audio.src = current;
                audio.currentTime = savedTime;
                audio.play().catch(err => Logger.debug('[AudioRecovery] Reload retry failed:', err));
            }
        }, 5000);
    });

    audio.addEventListener('error', () => {
        Logger.error('[AudioRecovery] Audio error event', { src: audio.src, error: audio.error });

        // If the src is invalid (e.g. bare origin after rapid skipping), try to
        // restore the last known good source so playback isn't permanently broken.
        if (!isValidAudioSrc(audio.src) && lastKnownGoodSrc) {
            Logger.warn('[AudioRecovery] Invalid src after error, restoring last good source', { lastKnownGoodSrc });
            audio.src = lastKnownGoodSrc;
            audio.play().catch(err => Logger.debug('[AudioRecovery] Restore retry failed:', err));
        }
    });

    audio.addEventListener('play', () => {
        Logger.debug('[AudioRecovery] Audio play', { src: audio.src, currentTime: audio.currentTime });
    });

    audio.addEventListener('pause', () => {
        Logger.debug('[AudioRecovery] Audio pause', { src: audio.src, currentTime: audio.currentTime });
    });
}

// Start initialization (only if not already initialized)
if (wasAlreadyInitialized) {
    Logger.log('Already initialized, skipping re-initialization (SPA navigation detected)');
} else {
    initialize();
}
