/**
 * KikoeruBridge - Bridge to the host Kikoeru/ASMR.one Vue application
 *
 * Responsibilities:
 * - Discover and bind to the Vue app instance
 * - Provide typed access to store, router, and axios
 * - Maintain connection via heartbeat
 * - Initialize the AppStore with host references
 */

import type {
    KikoeruStore,
    KikoeruApp,
    VueRouter,
    VueRoute,
    AxiosInstance,
    AudioPlayerState,
    PlayerTrack,
    WorkDetail,
} from '../types';
import { AppStore } from '../store/AppStore';
import { KikoeruApiClient } from './HttpClient';
import { EventBus } from '../core/EventBus';
import { Logger } from '../core/Utils';

declare const unsafeWindow: Window & typeof globalThis;

// Store singleton on window to persist across script re-injections
const globalWindow = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) as Window & {
    __ASMR_KIKOERU_BRIDGE__?: KikoeruBridge;
};

// ============================================================================
// Bridge Implementation
// ============================================================================

export class KikoeruBridge {
    private static instance: KikoeruBridge;
    private _app: KikoeruApp | null = null;
    private _apiClient: KikoeruApiClient | null = null;
    private heartbeatId: number | null = null;
    private _ready: Promise<void> | null = null;
    private _lastTrackSrc: string | null = null;
    private _lastWorkId: string | null = null;

    private constructor() {
        Logger.debug('KikoeruBridge instance created');
    }

    public static getInstance(): KikoeruBridge {
        if (!KikoeruBridge.instance) {
            KikoeruBridge.instance = new KikoeruBridge();
        }
        return KikoeruBridge.instance;
    }

    // =========================================================================
    // Initialization
    // =========================================================================

    /**
     * Initialize the bridge and wait for the Vue app to be available
     */
    public async initialize(): Promise<void> {
        if (this._ready) return this._ready;

        Logger.info('Initializing KikoeruBridge...');
        const maxRetries = 60;
        let attempts = 0;

        this._ready = new Promise((resolve, reject) => {
            const interval = setInterval(() => {
                if (this.bindApp()) {
                    clearInterval(interval);
                    Logger.info('Vue app found and bound successfully.');
                    this.onAppBound();
                    resolve();
                    return;
                }

                attempts++;
                if (attempts % 10 === 0) {
                    Logger.debug(`Waiting for Vue app... attempt ${attempts}/${maxRetries}`);
                }

                if (attempts >= maxRetries) {
                    clearInterval(interval);
                    Logger.error('Failed to bind to Vue app after multiple retries.');
                    reject(new Error('Failed to hook into Kikoeru: root app not found'));
                }
            }, 200);
        });

        return this._ready;
    }

    /**
     * Called when the app is successfully bound
     */
    private onAppBound(): void {
        // Initialize AppStore with host store
        AppStore.setHostStore(this.store);
        Logger.debug('[KikoeruBridge] Host store set on AppStore', {
            stateKeys: Object.keys(this.store.state || {}),
            hasAudioPlayer: !!this.store.state?.AudioPlayer,
        });

        // Create API client
        this._apiClient = new KikoeruApiClient(this.axios);
        Logger.debug('[KikoeruBridge] API client created');

        // Start heartbeat
        this.startHeartbeat();

        // Setup watchers
        this.setupWatchers();

        // Mark as initialized
        AppStore.setState({ isInitialized: true });
        Logger.info('Bridge initialized with host store:', this.store);
    }

    /**
     * Setup store watchers for track/work changes
     */
    private setupWatchers(): void {
        const store = this.store;

        // Watch for track changes via queue[queueIndex]
        store.watch?.(
            (state) => {
                const ap = state.AudioPlayer;
                if (!ap?.queue || typeof ap.queueIndex !== 'number') return null;
                // Primary: get track from queue[queueIndex]
                const track = ap.queue[ap.queueIndex];
                return track?.hash || track?.mediaStreamUrl || null;
            },
            (newSrc) => {
                if (newSrc && newSrc !== this._lastTrackSrc) {
                    this._lastTrackSrc = newSrc;
                    const track = this.currentTrack;
                    const workId = this.currentWorkId;
                    if (track && workId) {
                        Logger.debug('Track changed:', { title: track.title, workId });
                        EventBus.emit('track:change', { track, workId });
                    }
                }
            }
        );

        // Watch for work changes
        store.watch?.(
            (state) => state.AudioPlayer?.work?.id,
            (newWorkId) => {
                const workIdStr = newWorkId ? String(newWorkId) : null;
                if (workIdStr && workIdStr !== this._lastWorkId) {
                    this._lastWorkId = workIdStr;
                    const work = this.currentWork;
                    if (work) {
                        Logger.debug('Work changed:', { title: work.title, id: work.id });
                        EventBus.emit('work:change', { workId: workIdStr, work });
                    }
                }
            }
        );
    }

    // =========================================================================
    // App Discovery
    // =========================================================================

    private bindApp(): boolean {
        const app = this.findApp();
        if (app) {
            this._app = app;
            Logger.debug('[KikoeruBridge] Successfully bound to Vue app');
            return true;
        }
        return false;
    }

    private findApp(): KikoeruApp | null {
        // Try #q-app root first (Quasar app container)
        const root = document.getElementById('q-app') as HTMLElement | null;
        const direct = this.extractApp(root);
        if (direct) {
            Logger.debug('[KikoeruBridge] Found app via #q-app');
            return direct;
        }

        // Scan all elements for Vue instance
        const scanRoot = root || document.body;
        if (!scanRoot) return null;

        const nodes = scanRoot.querySelectorAll?.('*') || [];
        for (const node of Array.from(nodes)) {
            const vm = this.extractApp(node as HTMLElement);
            if (vm) return vm;
        }

        return null;
    }

    private extractApp(node: HTMLElement | null): KikoeruApp | null {
        if (!node) return null;

        const nodeAny = node as HTMLElement & {
            __vue__?: KikoeruApp;
            __vueParentComponent?: { proxy: KikoeruApp };
            __vue_app__?: { config: { globalProperties: KikoeruApp } };
        };
        const candidates = [
            nodeAny.__vue__,
            nodeAny.__vueParentComponent?.proxy,
            nodeAny.__vue_app__?.config?.globalProperties,
        ];

        for (const candidate of candidates) {
            if (candidate?.$store && candidate?.$router) {
                Logger.debug('[KikoeruBridge] Extracted app from candidate', {
                    hasStore: !!candidate.$store,
                    hasRouter: !!candidate.$router,
                });
                return candidate as KikoeruApp;
            }
        }

        return null;
    }

    private startHeartbeat(): void {
        if (this.heartbeatId !== null) return;

        this.heartbeatId = window.setInterval(() => {
            // Skip expensive scan if we already have a valid app with store
            if (this._app?.$store) return;

            const app = this.findApp();
            if (app && app !== this._app) {
                this._app = app;
                AppStore.setHostStore(this.store);
            }
        }, 2000);
    }

    // =========================================================================
    // Core Accessors
    // =========================================================================

    /** Throw if the bridge has not been initialized yet. Returns the app for convenient chaining. */
    private assertInit(): KikoeruApp {
        if (!this._app) throw new Error('KikoeruBridge not initialized');
        return this._app;
    }

    /**
     * Get the Vuex store
     */
    public get store(): KikoeruStore {
        return this.assertInit().$store;
    }

    /**
     * Get the Vue router
     */
    public get router(): VueRouter {
        return this.assertInit().$router;
    }

    /**
     * Get current route
     */
    public get route(): VueRoute {
        return this.assertInit().$route;
    }

    /**
     * Get axios instance
     */
    public get axios(): AxiosInstance {
        return this.assertInit().$axios;
    }

    /**
     * Get the raw Vue app (for advanced use cases)
     */
    public get app(): KikoeruApp {
        return this.assertInit();
    }

    /**
     * Get the typed API client
     */
    public get api(): KikoeruApiClient {
        if (!this._apiClient) throw new Error('KikoeruBridge not initialized');
        return this._apiClient;
    }

    // =========================================================================
    // Player State Helpers
    // =========================================================================

    /**
     * Get audio player state
     */
    public get player(): AudioPlayerState {
        return this.store.state.AudioPlayer || {} as AudioPlayerState;
    }

    /**
     * Get current track from the queue at the current index.
     * The AudioPlayer stores tracks in `queue[]` and the current position in `queueIndex`.
     */
    public get currentTrack(): PlayerTrack | undefined {
        const player = this.player;
        // Primary source: queue[queueIndex] - this is where the actual track data lives
        if (player.queue && typeof player.queueIndex === 'number' && player.queue[player.queueIndex]) {
            return player.queue[player.queueIndex];
        }
        // Fallback for legacy/alternative state shapes
        return player.currentTrack || player.currentPlayingFile;
    }

    /**
     * Get current work
     */
    public get currentWork(): WorkDetail | undefined {
        return this.player.work;
    }

    /**
     * Get current work ID from route or player
     */
    public get currentWorkId(): string {
        return this.route.params.id || (this.currentWork?.id ? String(this.currentWork.id) : '');
    }

    /**
     * Check if audio is playing
     */
    public get isPlaying(): boolean {
        return this.player.playing || false;
    }

    /**
     * Get current playback time
     */
    public get currentTime(): number {
        return this.player.currentTime || 0;
    }

    /**
     * Get track duration
     */
    public get duration(): number {
        return this.player.duration || 0;
    }

    /**
     * Get playback queue
     */
    public get queue(): PlayerTrack[] {
        const player = this.player;
        return player.queue || player.playlist || [];
    }

    /**
     * Get current queue index
     */
    public get queueIndex(): number {
        return this.player.queueIndex || 0;
    }

    // =========================================================================
    // Navigation Helpers
    // =========================================================================

    /**
     * Navigate to a work page
     */
    public navigateToWork(workId: string | number): void {
        Logger.debug(`[KikoeruBridge] Navigating to work: ${workId}`);
        this.router.push(`/work/${workId}`);
    }

    /**
     * Navigate with path update (for folder diving)
     */
    public updatePath(pathSegments: string[]): void {
        const currentQuery = this.route.query;
        const nextPath = JSON.stringify(pathSegments);
        const currentPath = typeof currentQuery.path === 'string'
            ? currentQuery.path
            : JSON.stringify(this.getPathSegments());
        if (currentPath === nextPath) return;
        this.router.replace({
            query: {
                ...currentQuery,
                path: nextPath,
            },
        }).catch(() => { });
    }

    /**
     * Get current path segments from route query
     */
    public getPathSegments(): string[] {
        try {
            return JSON.parse(this.route.query.path || '[]');
        } catch {
            return [];
        }
    }

    // =========================================================================
    // Store Actions
    // =========================================================================

    /**
     * Dispatch a store action
     */
    public dispatch<T = unknown>(action: string, payload?: unknown): Promise<T> {
        if (!this.store.dispatch) {
            Logger.error('[KikoeruBridge] Store dispatch not available');
            return Promise.reject(new Error('Store dispatch not available'));
        }
        Logger.debug(`[KikoeruBridge] Dispatching: ${action}`, payload);
        return this.store.dispatch(action, payload) as Promise<T>;
    }

    /**
     * Commit a store mutation
     */
    public commit(mutation: string, payload?: unknown): void {
        if (!this.store.commit) {
            throw new Error('Store commit not available');
        }
        this.store.commit(mutation, payload);
    }

    /**
     * Check if an action exists
     */
    public hasAction(action: string): boolean {
        return !!this.store._actions?.[action];
    }

    /**
     * Watch store state
     */
    public watch<T>(
        getter: (state: typeof this.store.state) => T,
        callback: (value: T, oldValue: T) => void,
        options?: { immediate?: boolean }
    ): (() => void) | undefined {
        return this.store.watch?.(getter, callback, options);
    }

    // =========================================================================
    // Vue Component Helpers
    // =========================================================================

    /**
     * Watch a Vue expression on the app
     */
    public $watch<T>(
        expression: string | (() => T),
        callback: (newValue: T, oldValue: T) => void,
        options?: { immediate?: boolean; deep?: boolean }
    ): (() => void) | undefined {
        return this._app?.$watch?.(expression, callback, options);
    }

    /**
     * Find a Vue component by predicate
     */
    public findComponent(predicate: (vm: KikoeruApp) => boolean): KikoeruApp | null {
        if (!this._app) return null;

        const queue: KikoeruApp[] = [this._app];
        const visited = new Set<KikoeruApp>();

        while (queue.length) {
            const vm = queue.shift()!;
            if (visited.has(vm)) continue;
            visited.add(vm);

            if (predicate(vm)) return vm;

            if (vm.$children) {
                queue.push(...vm.$children);
            }
        }

        return null;
    }
    /**
     * Find the WorkTree Vue component in the host app.
     * The component has a `tree` array prop and a `path` data array.
     */
    public findWorkTreeComponent(): KikoeruApp | null {
        // Optimization: Try the #work-tree element directly first
        const el = document.getElementById('work-tree') as any;
        if (el?.__vue__) {
            let vm = el.__vue__;
            for (let i = 0; i < 5 && vm; i++) {
                const v = vm as unknown as { tree: unknown[]; path: unknown[]; fatherFolder: unknown };
                if (Array.isArray(v.tree) && Array.isArray(v.path) && typeof v.fatherFolder !== 'undefined') {
                    return vm as KikoeruApp;
                }
                vm = vm.$parent;
            }
        }

        // Fallback to BFS discovery
        return this.findComponent((vm: KikoeruApp) => {
            const v = vm as unknown as { tree: unknown[]; path: unknown[]; fatherFolder: unknown };
            return Array.isArray(v.tree) && Array.isArray(v.path) && typeof v.fatherFolder !== 'undefined';
        });
    }

    /**
     * Show a notification (toast) using Quasar's $q.notify
     */
    public notify(message: string, type: 'positive' | 'negative' | 'warning' | 'info' = 'info', timeout = 3000): void {
        const app = this._app;
        const q = app?.$q || (window as unknown as { Quasar?: { notify?: (...args: unknown[]) => void } }).Quasar;

        if (q?.notify) {
            q.notify({
                message,
                type,
                timeout,
                position: 'top',
                actions: [{ icon: 'close', color: 'white' }]
            });
        } else {
            Logger.info(`[Notification] ${type.toUpperCase()}: ${message}`);
        }
    }
}
