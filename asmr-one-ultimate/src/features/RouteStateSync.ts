import { GM_getValue, GM_setValue } from '$';
import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { Logger, I18n } from '../core/Utils';
import { WorkOrder, SortOrder } from '../types/api';
import { AppStore } from '../store/AppStore';
import type { KikoeruApp, AxiosInstance } from '../types/store';

/** Minimal axios request config shape for interceptor typing */
interface AxiosRequestConfig {
    url?: string;
    params?: Record<string, unknown>;
    [key: string]: unknown;
}

interface SortOptionItem {
    label: string;
    order: string;
    sort: string;
}

const SORT_OPTIONS_CACHE_KEY = 'asmrSortOptions';
const getSortOptionsCacheKey = () => `${SORT_OPTIONS_CACHE_KEY}:${I18n.lang}`;

const FALLBACK_SORT_OPTIONS: Record<string, string> = {
    insert_time: 'sortNewest',
    create_date: 'sortNewest',
    release: 'sortRelease',
    id: 'sortRJCode',
    nsfw: 'sortNSFW',
    rate_average_2dp: 'sortDlsiteRating',
    dl_count: 'sortDownloads',
    rating: 'sortRating',
    review_count: 'sortReviews',
    price: 'sortPrice',
    random: 'sortRandom',
};

/**
 * RouteStateSync - Synchronizes host application state with URL parameters
 *
 * Two-pronged approach to defeat the race condition between our script and
 * the host Works.vue component lifecycle:
 *
 * 1. **Axios Interceptor** (data correctness): Intercepts the host's API
 *    requests and injects the correct `order`/`sort` params before they
 *    hit the server. This ensures the *first* fetch returns correctly
 *    sorted results, eliminating the need to re-fetch.
 *
 * 2. **Component Sync** (UI correctness): Finds the Works component and
 *    updates its `sortOption` dropdown so the UI matches the actual sort.
 */
export class RouteStateSync {
    private static instance: RouteStateSync | null = null;
    private bridge: KikoeruBridge;
    private lastSyncKey: string = '';
    private interceptorInstalled = false;
    private _enabled = false;
    private routeUnwatch: (() => void) | null = null;
    private lifecycleGeneration = 0;
    private applyRetryTimers = new Set<ReturnType<typeof setTimeout>>();

    /**
     * Cache of the last consumed pending sort values.
     * The axios interceptor may clear AppStore.search before syncFromRoute
     * gets to read it, so we preserve a copy here for UI sync.
     */
    private consumedSort: { order?: WorkOrder; sort?: SortOrder } | null = null;

    constructor() {
        this.bridge = KikoeruBridge.getInstance();
        RouteStateSync.instance = this;
    }

    public static getInstance(): RouteStateSync {
        if (!RouteStateSync.instance) {
            RouteStateSync.instance = new RouteStateSync();
        }
        return RouteStateSync.instance;
    }

    public enable(): void {
        if (this._enabled) return;
        this._enabled = true;
        this.lifecycleGeneration++;
        Logger.info('[RouteStateSync] System enabled');

        this.installAxiosInterceptor();

        this.routeUnwatch = this.bridge.$watch(
            () => this.bridge.route.fullPath,
            () => {
                if (this._enabled) this.syncFromRoute();
            }
        ) || null;

        // Initial sync
        this.syncFromRoute();
    }

    public disable(): void {
        this._enabled = false;
        this.lifecycleGeneration++;
        this.routeUnwatch?.();
        this.routeUnwatch = null;
        this.clearApplyRetries();
        this.lastSyncKey = '';
    }

    // =========================================================================
    // Axios Interceptor — ensures the host's first API fetch uses correct sort
    // =========================================================================

    private getLocationQueryParams(): { path: string; params: URLSearchParams } {
        let path = window.location.pathname || '';
        let params = new URLSearchParams(window.location.search);

        if (!window.location.search && window.location.hash.includes('?')) {
            const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
            const [hashPath, hashQuery] = hash.split('?');
            if (hashPath?.startsWith('/')) {
                path = hashPath;
            }
            params = new URLSearchParams(hashQuery || '');
        }

        return { path, params };
    }

    private installAxiosInterceptor(): void {
        if (this.interceptorInstalled) return;

        try {
            const axios = this.bridge.axios as AxiosInstance & {
                interceptors?: { request?: { use: (fn: (config: AxiosRequestConfig) => AxiosRequestConfig) => void } };
            };
            if (!axios?.interceptors?.request?.use) {
                Logger.warn('[RouteStateSync] Axios interceptors not available, falling back to component-only sync');
                return;
            }

            axios.interceptors.request.use((config: AxiosRequestConfig) => {
                if (!this._enabled) return config;
                let order = AppStore.state.search.pendingOrder as WorkOrder | undefined;
                let sort = AppStore.state.search.pendingSort as SortOrder | undefined;

                // Fallback: If no pending state (e.g. page refresh, bookmark), try route/query params
                if (!order && !sort) {
                    const route = this.bridge?.route;
                    if (route?.query) {
                        order = (route.query.order || undefined) as WorkOrder | undefined;
                        sort = (route.query.sort || undefined) as SortOrder | undefined;
                    }

                    const { path, params } = this.getLocationQueryParams();

                    // Only apply fallback on relevant pages
                    const isRelevantPage =
                        path === '/works' ||
                        path.startsWith('/vas/') ||
                        path.startsWith('/circles/') ||
                        path.startsWith('/tags/');

                    if (isRelevantPage) {
                        order = (params.get('order') || undefined) as WorkOrder | undefined;
                        sort = (params.get('sort') || undefined) as SortOrder | undefined;
                    }
                }

                if (!order && !sort) return config;

                const url = (config.url || '').toLowerCase();
                // Match /api/works, api/works, works, /api/search/..., search/..., etc.
                // This handles cases where axios has a baseURL set (e.g. /api/) and requests are relative.
                const isWorksRequest =
                    /(?:^|\/)(?:api\/)?works($|\?)/.test(url) ||
                    /(?:^|\/)(?:api\/)?search\//.test(url) ||
                    /(?:^|\/)(?:api\/)?vas\/\d+\/works/.test(url) ||
                    /(?:^|\/)(?:api\/)?circles\/\d+\/works/.test(url) ||
                    /(?:^|\/)(?:api\/)?tags\/\d+\/works/.test(url);

                if (!isWorksRequest) return config;

                // Inject sort params into the request
                if (!config.params) config.params = {};

                // Only overwrite if we have a value to enforce
                if (order) {
                    config.params.order = order;
                    // Also replace in URL string if present (host might construct URL manually)
                    if (config.url && config.url.includes('order=')) {
                        config.url = config.url.replace(/([?&])order=[^&]*/, `$1order=${order}`);
                    }
                }
                if (sort) {
                    config.params.sort = sort;
                    // Also replace in URL string if present
                    if (config.url && config.url.includes('sort=')) {
                        config.url = config.url.replace(/([?&])sort=[^&]*/, `$1sort=${sort}`);
                    }
                }

                Logger.debug('[RouteStateSync] Injected sort into API request:', {
                    url,
                    order,
                    sort,
                    source: AppStore.state.search.pendingOrder ? 'store' : 'url'
                });

                // Cache for UI sync
                this.consumedSort = { order, sort };

                // Do NOT clear store state here.
                // Works page often fires multiple requests (e.g. refreshPageTitle then requestWorksQueue).
                // If we clear it after the first one (often the title check), the actual works fetch
                // will miss the sort parameters. The state is ephemeral enough or updated by navigation.

                return config;
            });

            this.interceptorInstalled = true;
            Logger.info('[RouteStateSync] Axios interceptor installed');
        } catch (e) {
            Logger.warn('[RouteStateSync] Failed to install axios interceptor:', e);
        }
    }

    // =========================================================================
    // Route watcher — updates the Works component UI dropdown
    // =========================================================================

    private syncFromRoute(): void {
        if (!this._enabled) return;
        const route = this.bridge.route;
        if (route.path !== '/works') {
            // Reset sync key when leaving /works so re-entering always syncs
            this.lastSyncKey = '';
            return;
        }

        // Priority 1: Pending sort from AppStore (not yet consumed by interceptor)
        const pending = AppStore.state.search;
        let order = pending.pendingOrder as WorkOrder | undefined;
        let sort = pending.pendingSort as SortOrder | undefined;

        if (order || sort) {
            // Cache for UI sync in case interceptor fires before we find the component
            this.consumedSort = { order, sort };
        } else if (this.consumedSort) {
            // Priority 2: Interceptor already consumed the pending state
            order = this.consumedSort.order;
            sort = this.consumedSort.sort;
        } else {
            // Priority 3: URL query parameters (direct links/bookmarks)
            order = route.query.order as WorkOrder | undefined;
            sort = route.query.sort as SortOrder | undefined;
            if (!order && !sort) {
                const { path, params } = this.getLocationQueryParams();
                const isRelevantPage =
                    path === '/works' ||
                    path.startsWith('/vas/') ||
                    path.startsWith('/circles/') ||
                    path.startsWith('/tags/');
                if (isRelevantPage) {
                    order = (params.get('order') || undefined) as WorkOrder | undefined;
                    sort = (params.get('sort') || undefined) as SortOrder | undefined;
                }
            }
        }

        if (!order && !sort) return;

        // Deduplicate using the full route path (not just sort values) so that
        // navigating to the same sort with different filters still triggers sync.
        const syncKey = `${route.fullPath}|${order || ''}:${sort || ''}`;
        if (this.lastSyncKey === syncKey) return;
        this.lastSyncKey = syncKey;

        this.applySortToComponent(order, sort);
    }

    /**
     * Get a localized label for a sort order and direction.
     * Tries to find matching label from host options first, then fallbacks.
     */
    public getSortLabel(order: string, sort?: string): string {
        const options = this.getCachedSortOptions();
        const matched = sort
            ? options.find(o => o.order === order && o.sort === sort)
            : options.find(o => o.order === order);

        if (matched) {
            return this.translateLabel(matched.label);
        }

        const labelKey = FALLBACK_SORT_OPTIONS[order];
        let label = labelKey ? I18n.t(labelKey) : order;
        if (sort) {
            const dirLabel = sort === 'desc' ? I18n.t('advDesc') : I18n.t('advAsc');
            label = `${label} (${dirLabel})`;
        }
        return label;
    }

    private translateLabel(label: string): string {
        if (!label) return label;
        try {
            const app = this.bridge.app as KikoeruApp & { $t?: (key: string) => string };
            const translated = app?.$t?.(label);
            if (translated && translated !== label) return translated;
        } catch {
            // Ignore host translation failures
        }
        return I18n.t(label);
    }

    /**
     * Update the host's Visual sort display (the text shown in the dropdown).
     * This ensures the UI reflects changes even before a full component refresh.
     */
    public syncDisplayToHost(label: string): void {
        // Strategy 1: Find the span within the native field display
        const fieldNatives = document.querySelectorAll('.q-field__native');
        for (const native of Array.from(fieldNatives)) {
            const span = native.querySelector('span');
            if (!span) continue;

            const text = span.textContent?.trim();
            // Check if this looks like a sort label by checking against known labels
            const knownLabels = [
                ...Object.values(FALLBACK_SORT_OPTIONS).map(k => I18n.t(k)),
                ...this.getCachedSortOptions().map(o => this.translateLabel(o.label))
            ];

            const isSortDisplay = knownLabels.some(l => text?.includes(l)) ||
                (text && (text.includes('(') && text.includes(')')));

            if (isSortDisplay) {
                span.textContent = label;
                Logger.debug('[RouteStateSync] Updated host display label:', label);
                return;
            }
        }
    }

    private getCachedSortOptions(): SortOptionItem[] {
        try {
            const cached = GM_getValue(getSortOptionsCacheKey());
            const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    private applySortToComponent(order?: WorkOrder, sort?: SortOrder): void {
        if (!this._enabled) return;
        this.clearApplyRetries();
        const generation = this.lifecycleGeneration;
        const routeKey = this.bridge.route.fullPath;
        let attempts = 0;
        const maxAttempts = 50;

        const tryApply = () => {
            if (!this._enabled
                || generation !== this.lifecycleGeneration
                || this.bridge.route.fullPath !== routeKey) return;
            attempts++;
            const vm = this.findWorksComponent();
            if (vm) {
                Logger.debug('[RouteStateSync] Works component found after', attempts, 'attempts');
                this.setSortOption(vm, order, sort);
                this.consumedSort = null;
                return;
            }
            if (attempts < maxAttempts) {
                // Decay: fast at first (50ms), then slower
                const delay = Math.min(200, 50 + attempts * 5);
                const timer = setTimeout(() => {
                    this.applyRetryTimers.delete(timer);
                    tryApply();
                }, delay);
                this.applyRetryTimers.add(timer);
            } else {
                Logger.warn('[RouteStateSync] Works component not found after', maxAttempts, 'attempts');
                this.consumedSort = null;
            }
        };

        tryApply();
    }

    private clearApplyRetries(): void {
        for (const timer of this.applyRetryTimers) clearTimeout(timer);
        this.applyRetryTimers.clear();
    }

    private setSortOption(vm: KikoeruApp, order?: WorkOrder, sort?: SortOrder): void {
        if (!this._enabled) return;
        const current = vm.sortOption as SortOptionItem | undefined;
        const options = this.getVmSortOptions(vm);

        if (!current || !options.length) {
            Logger.warn('[RouteStateSync] Works component missing sortOption/options');
            return;
        }
        this.cacheSortOptions(options);

        const targetOrder = order || current.order;
        const targetSort = sort || current.sort;

        // Nothing to change
        if (current.order === targetOrder && current.sort === targetSort) return;

        // Find matching option from the component's own options array
        const matched = options.find(o => o.order === targetOrder && o.sort === targetSort)
            || options.find(o => o.order === targetOrder);

        const newOption: SortOptionItem = matched
            ? matched
            : { label: targetOrder, order: targetOrder, sort: targetSort };

        if (!matched && options.length) {
            options.push(newOption);
        }

        Logger.debug('[RouteStateSync] Setting sortOption:', newOption);

        // Directly set the component data property.
        // Vue reactivity picks this up, triggering the sortOption watcher
        // which persists to localStorage and calls reset().
        vm.sortOption = newOption;

        // Immediately update visual display for better feedback
        this.syncDisplayToHost(this.getSortLabel(newOption.order, newOption.sort));
    }

    private cacheSortOptions(options: SortOptionItem[]): void {
        try {
            const sanitized = options
                .filter(opt => opt && typeof opt.order === 'string' && typeof opt.label === 'string')
                .map(opt => ({ label: opt.label, order: opt.order, sort: opt.sort }));
            if (sanitized.length) {
                GM_setValue(getSortOptionsCacheKey(), sanitized);
            }
        } catch {
            // Ignore storage issues
        }
    }

    private getVmSortOptions(vm: KikoeruApp): SortOptionItem[] {
        const anyVm = vm as unknown as { sortOptions?: SortOptionItem[]; options?: SortOptionItem[] };
        if (Array.isArray(anyVm.sortOptions)) return anyVm.sortOptions;
        if (Array.isArray(anyVm.options)) return anyVm.options;
        return [];
    }

    private findWorksComponent(): KikoeruApp | null {
        return this.findViaDom() || this.findViaTree();
    }

    /**
     * DOM strategy: find the sort dropdown via input or label, walk up via __vue__.
     */
    private findViaDom(): KikoeruApp | null {
        // Strategy A: Input role
        const inputs = Array.from(document.querySelectorAll('input[role="combobox"]'));

        // Strategy B: field labels (fallback)
        const labels = Array.from(document.querySelectorAll('.q-field__label'));
        const candidates = [...inputs, ...labels];

        for (const el of candidates) {
            let current: HTMLElement | null = el as HTMLElement;
            // Walk up 20 levels max to find the component
            for (let i = 0; i < 20 && current; i++) {
                let vue = (current as HTMLElement & { __vue__?: KikoeruApp }).__vue__;

                // Also walk up the Vue tree from this element's instance
                for (let v = 0; v < 5 && vue; v++) {
                    if (this.isWorksVm(vue)) {
                        Logger.debug('[RouteStateSync] Found Works VM via DOM+Vue walk');
                        return vue;
                    }
                    vue = vue.$parent as KikoeruApp | undefined;
                }

                current = current.parentElement;
            }
        }
        return null;
    }

    /**
     * Tree strategy: BFS over Vue component tree.
     */
    private findViaTree(): KikoeruApp | null {
        const vm = this.bridge.findComponent((c: KikoeruApp) => this.isWorksVm(c));
        if (vm) Logger.debug('[RouteStateSync] Found Works VM via tree');
        return vm;
    }

    private isWorksVm(vm: KikoeruApp): boolean {
        // Check for sortOption with order property
        if (!vm.sortOption || typeof (vm.sortOption as SortOptionItem).order !== 'string') return false;
        // Check for options array (don't require it to be populated yet)
        if (!this.getVmSortOptions(vm).length) return false;
        // Removed strict pagination check as it might be null/undefined during loading
        return true;
    }
}
