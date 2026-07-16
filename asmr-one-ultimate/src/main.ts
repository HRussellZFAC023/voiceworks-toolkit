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
import './styles/components/_jpdb.css';
import './styles/components/_cards.css';

import { KikoeruBridge } from './infrastructure/KikoeruBridge';
import { hasPlayerBar, startStackedBottomHeightWatch } from './core/DomUtils';
import { AudioCache } from './infrastructure/AudioCache';
import { StorageManager } from './infrastructure/StorageManager';
import { WorkTreeCopy } from './features/WorkTreeCopy';
import { CorsFixer } from './features/CorsFixer';
import { TagDatabase } from './infrastructure/TagDatabase';
import { AppStore } from './store/AppStore';
import { initReactiveConfig } from './store/ReactiveConfig';
import { DialogStyles, Logger, I18n, Config } from './core/Utils';
import { DeviceCapabilities } from './core/DeviceCapabilities';
import { GpuScheduler } from './core/GpuScheduler';
import { EmbeddingService } from './services/EmbeddingService';
import { CentralObserver } from './core/CentralObserver';
import { EventBus } from './core/EventBus';
import { MLCrashGuard } from './core/MLCrashGuard';
import type { ConfigKey } from './types';
import { LazyFeatureGate, type ToggleableFeature } from './core/LazyFeatureGate';
import { redactSensitiveConfig } from './core/configSecrets';
import { recoverRegionGateIfNeeded, waitForRegionGateOrDomReady } from './core/RegionGateRecovery';

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
import { ListSearchEnhancer } from './features/ListSearchEnhancer';
import { VectorSearchController } from './features/VectorSearchController';
import { DownloadCenterController } from './features/DownloadCenterController';
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
import { PlaylistDiscoverController } from './features/PlaylistDiscoverController';
import { InfiniteScrollController } from './features/InfiniteScrollController';
import { PlayerFullscreenController } from './features/PlayerFullscreenController';
import { PlayerGalleryController } from './features/PlayerGalleryController';
import { JoiTool } from './features/JoiTool';
import { VisualizerController } from './features/VisualizerController';
import { VisitCounter } from './features/VisitCounter';
import { ContinueListeningController } from './features/ContinueListeningController';
import { setupAudioRecovery } from './features/audioRecovery';
import { ProxyDonationBanner } from './features/ProxyDonationBanner';


declare const unsafeWindow: Window & typeof globalThis;

// ============================================================================
// Prevent duplicate initialization on SPA navigation
// ============================================================================

const globalWindow = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) as Window & {
    __ASMR_ULTIMATE_INITIALIZED__?: boolean;
    __ASMR_ULTIMATE_CLEANUP__?: () => void;
    ASMRUlt?: ASMRUltAPI;
};

// ============================================================================
// Global API
// ============================================================================

interface ASMRUltAPI {
    log: typeof Logger.log;
    toggleRadio: () => void;
    skipRadio: () => void;
    toggleShuffle: () => void;
    isRadioActive: () => boolean;
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

        // Keep page padding in sync with stacked bottom bars (viz, subs, JOI)
        startStackedBottomHeightWatch();

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
            Logger.debug('[Settings] Config:', JSON.stringify(
                redactSensitiveConfig(allConfig as unknown as Record<string, unknown>),
                null,
                2,
            ));
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

        // Establish device and GPU policy before registering any toggleable ML
        // feature: Whisper may auto-warm as soon as its feature is enabled.
        const device = DeviceCapabilities.detect();
        Logger.log(`[Device] ${device.reason}`);

        // iPhone: force-disable ML features — Safari memory limits are too strict.
        // This happens before feature registration, so no controller can start
        // and then miss the config event while the listener is not yet bound.
        if (DeviceCapabilities.isIPhone) {
            if (Config.get('enableWhisper')) {
                Config.set('enableWhisper', false);
                Logger.log('[Device] Whisper force-disabled on iPhone');
            }
            if (Config.get('enableVectorSearch')) {
                Config.set('enableVectorSearch', false);
                Logger.log('[Device] Vector search force-disabled on iPhone');
            }
        }

        // Crash policy and scheduler must be ready before a feature can create a
        // worker or acquire a model-load lease.
        MLCrashGuard.checkAndDisable();
        GpuScheduler.initialize();

        // Quality of life features
        initializeQOLFeatures();

        // Register AI feature gates before the optional embedding await. Whisper
        // auto-warmup, when configured, is serialized by the initialized scheduler.
        await initializeAIFeatures();

        // Listen for config changes to reactively enable/disable features
        setupFeatureToggleListener();

        // Core controls and recovery paths must not wait for an embedding download.
        initializeInfrastructure(bridge);
        updateGlobalAPI(radioMode, bridge);
        setupAudioRecovery();

        // Eagerly warm up remaining ML models — serialized via GpuScheduler load leases.
        // Translation is remote-only.
        const budget = DeviceCapabilities.budget;
        const warmEmbedding = Config.get('enableVectorSearch') && budget.embeddingEnabled;

        if (!budget.embeddingEnabled && Config.get('enableVectorSearch')) {
            Logger.log('[Device] Embedding disabled on constrained device — vector search unavailable');
        }

        if (DeviceCapabilities.shouldWarmup && warmEmbedding) {
            Logger.log('[Warmup] Starting ML warmup (Embedding)');
            Logger.log('[Warmup] Loading embedding model...');
            await EmbeddingService.ensureReady().catch((e) => {
                Logger.warn('[Warmup] Embedding warmup failed (non-critical):', e?.message || e);
            });
            Logger.log('[Warmup] Embedding warmup complete');
        } else if (!DeviceCapabilities.shouldWarmup && warmEmbedding) {
            Logger.log('[Device] Skipping eager ML warmup — models load on first use');
        } else {
            Logger.log('[Warmup] No ML features enabled for warmup');
        }

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

// ============================================================================
// Feature Registry — enables reactive enable/disable when settings change
// ============================================================================

const featureRegistry = new Map<string, ToggleableFeature>();

/** Lazily-imported feature modules (loaded on first enable) */
const lazyFeatures = new Map<string, { gate: LazyFeatureGate; extraGuard?: () => boolean }>();

function registerFeature(configKey: ConfigKey, feature: ToggleableFeature): void {
    featureRegistry.set(configKey, feature);
    if (Config.get(configKey)) {
        feature.enable();
        Logger.debug(`[Init] ${configKey} enabled`);
    }
}

function registerLazyFeature(
    configKey: ConfigKey,
    loader: () => Promise<ToggleableFeature>,
    extraGuard?: () => boolean,
): void {
    const gate = new LazyFeatureGate(loader, (error) => {
        Logger.error(`[Init] Failed to load ${configKey}`, error);
    });
    lazyFeatures.set(configKey, { gate, extraGuard });
    if (Config.get(configKey) && (!extraGuard || extraGuard())) {
        gate.enable();
        Logger.debug(`[Init] ${configKey} enabled (lazy)`);
    }
}

function setupFeatureToggleListener(): void {
    EventBus.on('config:change', ({ key, value }: { key: string; value: unknown }) => {
        // Reset crash guard when user manually re-enables an ML feature
        if (value && key === 'enableWhisper') MLCrashGuard.reset('whisper');
        if (value && key === 'enableVectorSearch') MLCrashGuard.reset('vectorSearch');

        // Eagerly-loaded features
        const feature = featureRegistry.get(key);
        if (feature) {
            if (value) {
                feature.enable();
                Logger.debug(`[Toggle] ${key} enabled`);
            } else {
                feature.disable();
                Logger.debug(`[Toggle] ${key} disabled`);
            }
            return;
        }
        // Lazily-loaded features
        const lazy = lazyFeatures.get(key);
        if (lazy) {
            if (value && (!lazy.extraGuard || lazy.extraGuard())) {
                lazy.gate.enable();
                Logger.debug(`[Toggle] ${key} enabled (lazy)`);
            } else {
                lazy.gate.disable();
                Logger.debug(`[Toggle] ${key} disabled (lazy)`);
            }
        }

        // When jpdbApiToken changes, re-evaluate JPDB feature state
        if (key === 'jpdbApiToken') {
            const jpdb = lazyFeatures.get('enableJpdb');
            if (!jpdb) return;
            const shouldEnable = !!Config.get('enableJpdb') && !!value;
            if (shouldEnable) {
                jpdb.gate.enable();
                Logger.debug('[Toggle] enableJpdb enabled (API key set)');
            } else {
                jpdb.gate.disable();
                Logger.debug('[Toggle] enableJpdb disabled (API key cleared)');
            }
        }
    });
}

function initializeQOLFeatures(): void {
    Logger.debug('[Init] Initializing QOL features...');

    // Always-on features (no toggle)
    const shuffleFeature = new ShuffleFeature();
    shuffleFeature.enable();
    Logger.debug('[Init] ShuffleFeature enabled');

    const autoProgress = new AutoProgress();
    autoProgress.enable();
    Logger.debug('[Init] AutoProgress enabled');

    const translatedTags = TranslatedTags.getInstance();
    translatedTags.enable();
    Logger.debug('[Init] TranslatedTags enabled');

    const listSearchEnhancer = new ListSearchEnhancer();
    listSearchEnhancer.enable();
    Logger.debug('[Init] ListSearchEnhancer enabled');

    // Toggleable features — all instances created upfront, enabled by config
    registerFeature('enableSupportButton', new SupportButton());
    registerFeature('enableTagFilters', new TagFilters());
    registerFeature('enableWorkTreeManager', WorkTreeManager.getInstance());
    registerFeature('enableAdvancedSearch', new AdvancedSearchController());
    registerFeature('enableWorkTreeCopy', new WorkTreeCopy());
    registerFeature('enableWorkMetadata', new WorkMetadataController());
    registerFeature('enableCommentSection', new CommentSectionController());
    registerFeature('enablePlayerTranslator', new PlayerTranslator());
    registerFeature('enableMediaViewer', MediaViewerController.getInstance());
    registerFeature('enablePlayerFullscreen', PlayerFullscreenController.getInstance());
    registerFeature('enablePlayerGallery', new PlayerGalleryController());
    registerFeature('enableJoiTool', JoiTool.getInstance());
    registerFeature('enableVisualizer', new VisualizerController());
    registerFeature('enableVisitCounter', new VisitCounter());
    registerFeature('enableContinueListening', new ContinueListeningController());
    registerFeature('enableLearnerMode', new LearnerModeController());
    registerFeature('enablePlaylistDiscovery', new PlaylistDiscoverController());
    registerFeature('enableInfiniteScroll', InfiniteScrollController.getInstance());
    registerFeature('enableHVDBLink', new HVDBLinkController());
    registerFeature('enableInterfaceTranslator', InterfaceTranslator.getInstance());
    registerFeature('enablePageTitleManager', new PageTitleManager());
    registerFeature('enableRouteStateSync', new RouteStateSync());
    registerFeature('enableKeyboardManager', KeyboardManager.getInstance());
    registerFeature('enableVectorSearch', new VectorSearchController());
    // Downloads are a core header action, adjacent to semantic search, and do
    // not require users to opt into the playlist-discovery feature.
    new DownloadCenterController().enable();

    Logger.debug('[Init] All QOL features initialized');
}

async function initializeAIFeatures(): Promise<void> {
    Logger.debug('[Init] Initializing AI features...');

    // Whisper + TranscriptFileInjector are paired — wrap as a single toggleable unit
    const whisperInstance = Whisper.getInstance();
    const transcriptInstance = new TranscriptFileInjector();
    registerFeature('enableWhisper', {
        enable() {
            whisperInstance.enable();
            transcriptInstance.enable();
        },
        disable() {
            whisperInstance.disable();
            transcriptInstance.disable();
        },
    });

    // Lazy-loaded features (dynamic imports)
    registerLazyFeature('enableFavicon', async () => {
        const { FaviconNowPlaying } = await import('./features/FaviconNowPlaying');
        const faviconManager = new FaviconNowPlaying();
        if (globalWindow.ASMRUlt) {
            globalWindow.ASMRUlt.testFavicon = (color?: string) => faviconManager.testWithColor(color);
            globalWindow.ASMRUlt.forceFavicon = () => faviconManager.forceUpdate();
        }
        return faviconManager;
    });
    registerLazyFeature('enableMediaSession', async () => {
        const { MediaSessionManager } = await import('./features/MediaSessionManager');
        return new MediaSessionManager();
    });
    registerLazyFeature('enableMenuIconFixer', async () => {
        const { MenuIconFixer } = await import('./features/MenuIconFixer');
        return new MenuIconFixer();
    });

    // JPDB Integration (furigana, vocabulary tracking, pitch accent)
    // Requires both the toggle AND an API key to be set
    registerLazyFeature('enableJpdb', async () => {
        const { JpdbController } = await import('./features/JpdbController');
        return new JpdbController();
    }, () => !!Config.get('jpdbApiToken'));

    Logger.debug('[Init] All AI features initialized');
}

function initializeInfrastructure(bridge: KikoeruBridge): void {
    Logger.debug('[Init] Initializing infrastructure...');
    CorsFixer.enable();
    const audioCache = new AudioCache();
    const storageManager = new StorageManager();
    storageManager.enable();
    Logger.debug('[Init] StorageManager enabled');

    registerFeature('enableStoreBackup', new StoreBackup());

    // Funding notice for users whose traffic needed the region-bypass proxy.
    new ProxyDonationBanner().enable();

    // Enable audio caching (sets up Vuex watcher for track changes)
    audioCache.enable();
    Logger.debug('[Init] AudioCache enabled');

    // Hook both the current host's mutation-based SET_QUEUE/SET_TRACK source
    // selection and the legacy playTrack action. Cache lookup is fail-open;
    // trusted CORS preparation remains synchronous before media loading begins.
    audioCache.installPlaybackInterceptors(bridge.store);
    Logger.debug('[Init] Store playback selection intercepted for audio caching/CORS');
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

async function start(): Promise<void> {
    // Resolve on the exact gate signature before first paint; normal pages
    // still wait for DOMContentLoaded before feature initialization.
    await waitForRegionGateOrDomReady();

    // The host can reject English-first browser navigation before its SPA is
    // available. Restore the trusted application shell first; normal bridge
    // initialization then proceeds against the real asmr.one origin.
    const regionRecovery = await recoverRegionGateIfNeeded();
    if (regionRecovery === 'failed') return;

    const wasAlreadyInitialized = globalWindow.__ASMR_ULTIMATE_INITIALIZED__ === true;
    globalWindow.__ASMR_ULTIMATE_INITIALIZED__ = true;
    if (wasAlreadyInitialized) {
        Logger.log('Already initialized, skipping re-initialization (SPA navigation detected)');
        return;
    }
    await initialize();
}

void start();
