/**
 * InfiniteScrollManager - Reusable infinite scroll system
 *
 * A site-wide infinite scroll system that:
 * - Uses IntersectionObserver to detect when user scrolls near bottom
 * - Fetches next page data via API and appends to existing grid
 * - Works on works listing pages (recommendations, search results, etc.)
 * - Respects the `enableInfiniteScroll` setting toggle
 */

import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { AppStore } from '../store/AppStore';
import { Logger } from '../core/Utils';
import { EventBus } from '../core/EventBus';
import type { KikoeruApp } from '../types';
import { buildInfiniteScrollApiUrl } from './infiniteScrollApiUtils';

/** Element with Vue 2 __vue__ internal property */
interface VueElement extends HTMLElement {
    __vue__?: KikoeruApp;
}

/**
 * Loose work record shape from varying API responses.
 * Used for DOM card creation where the exact response shape is not guaranteed.
 */
interface WorkRecord {
    id?: number | string;
    source_id?: string;
    title?: string;
    name?: string;
    circle?: { name?: string };
    maker?: { name?: string };
    mainCoverUrl?: string;
    release?: string;
    rate_average_2dp?: number;
    rating?: number;
    rate_count_detail?: { total?: number } & Record<string, unknown>;
    rate_count?: number;
    review_count?: number;
    price?: number;
    dl_count?: number;
    sales?: number;
    duration?: number;
    age_category_string?: string;
    nsfw?: boolean;
    [key: string]: unknown;
}

declare const unsafeWindow: Window & typeof globalThis;

const globalWindow = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) as Window & {
    __ASMR_INFINITE_SCROLL_MANAGER__?: InfiniteScrollManager;
};

export class InfiniteScrollManager {
    private static instance: InfiniteScrollManager;
    private bridge: KikoeruBridge;
    private observer: IntersectionObserver | null = null;
    private sentinel: HTMLElement | null = null;
    private isLoading = false;
    private isEnabled = false;
    private routeUnwatch: (() => void) | null = null;
    private currentPath: string = '';
    private debounceTimer: number | null = null;
    private readonly DEBOUNCE_MS = 300;
    private currentPage = 1;
    private totalPages = 1;
    private pageSize = 20;
    private paginationUnknown = false;
    private reachedEnd = false;

    // Exponential backoff state for 429 handling
    private retryCount = 0;
    private retryDelay = 0;
    private retryTimer: number | null = null;
    private readonly MAX_RETRIES = 5;
    private readonly INITIAL_BACKOFF_MS = 1000;
    private readonly BACKOFF_MULTIPLIER = 2;

    private constructor() {
        this.bridge = KikoeruBridge.getInstance();
    }

    static getInstance(): InfiniteScrollManager {
        if (globalWindow.__ASMR_INFINITE_SCROLL_MANAGER__) {
            return globalWindow.__ASMR_INFINITE_SCROLL_MANAGER__;
        }
        if (!InfiniteScrollManager.instance) {
            InfiniteScrollManager.instance = new InfiniteScrollManager();
            globalWindow.__ASMR_INFINITE_SCROLL_MANAGER__ = InfiniteScrollManager.instance;
        }
        return InfiniteScrollManager.instance;
    }

    initialize(): void {
        Logger.debug('[InfiniteScrollManager] Initializing');

        // Watch for config changes
        EventBus.on('config:change', ({ key, value }) => {
            if (key === 'enableInfiniteScroll') {
                if (value) {
                    this.enable();
                } else {
                    this.disable();
                }
            }
        });

        // Check initial state
        if (AppStore.getConfig('enableInfiniteScroll')) {
            this.enable();
        }
    }

    public enable(): void {
        if (this.isEnabled) return;
        this.isEnabled = true;
        Logger.debug('[InfiniteScrollManager] Enabled');

        this.setupRouteWatcher();
        this.attachToCurrentPage();
    }

    public disable(): void {
        if (!this.isEnabled) return;
        this.isEnabled = false;
        Logger.debug('[InfiniteScrollManager] Disabled');

        this.cleanup();

        if (this.routeUnwatch) {
            this.routeUnwatch();
            this.routeUnwatch = null;
        }
    }

    private setupRouteWatcher(): void {
        const app = this.bridge.app;
        if (!app?.$watch) {
            Logger.warn('[InfiniteScrollManager] Vue $watch not available');
            return;
        }

        // Watch for route changes
        this.routeUnwatch = app.$watch(
            () => this.bridge.route.path,
            (newPath: string) => {
                this.currentPath = newPath;
                // Debounce to let the page render
                if (this.debounceTimer) {
                    clearTimeout(this.debounceTimer);
                }
                this.debounceTimer = window.setTimeout(() => {
                    this.attachToCurrentPage();
                }, 500);
            }
        );

        this.currentPath = this.bridge.route.path;
    }

    private attachToCurrentPage(): void {
        if (!this.isEnabled) return;

        // Clean up previous observer
        this.cleanup();

        const path = this.currentPath;
        this.reachedEnd = false;
        this.paginationUnknown = false;

        // Skip pages that already have their own infinite scroll (like playlist discovery)
        if (path === '/playlists') {
            Logger.debug('[InfiniteScrollManager] Skipping /playlists - has own infinite scroll');
            return;
        }

        // Playlist detail page may use a non-standard pagination component
        const query = this.bridge.route.query || {};
        const isPlaylistPage = path === '/playlist' && !!query.id;

        // Check for pagination components
        const pagination = this.findPaginationComponent();
        if (!pagination && !isPlaylistPage) {
            Logger.debug('[InfiniteScrollManager] No pagination found on', path);
            return;
        }

        // Parse initial pagination state
        if (pagination) {
            this.parsePaginationState();
        } else {
            this.paginationUnknown = true;
        }

        Logger.debug(`[InfiniteScrollManager] Attaching to ${path} (page ${this.currentPage}/${this.totalPages})`);

        // Hide the pagination component since we're doing infinite scroll
        this.hidePagination();

        this.createSentinel();
        this.setupObserver();
    }

    private findPaginationComponent(): HTMLElement | null {
        // Look for Ant Design pagination (most common on this site)
        const antPagination = document.querySelector('.ant-pagination');
        if (antPagination) return antPagination as HTMLElement;

        // Look for Quasar pagination
        const qPagination = document.querySelector('.q-pagination');
        if (qPagination) return qPagination as HTMLElement;

        return null;
    }

    private parsePaginationState(): void {
        this.reachedEnd = false;
        // Try Ant Design pagination
        const antPagination = document.querySelector('.ant-pagination');
        if (antPagination) {
            // Get current page from active item
            const active = antPagination.querySelector('.ant-pagination-item-active');
            if (active) {
                this.currentPage = parseInt(active.textContent || '1', 10);
            }

            // Get total pages from last page item
            const items = antPagination.querySelectorAll('.ant-pagination-item');
            let maxPage = 1;
            items.forEach(item => {
                const num = parseInt(item.textContent || '0', 10);
                if (!isNaN(num) && num > maxPage) maxPage = num;
            });
            this.totalPages = maxPage;

            // Try to get page size from select
            const sizeSelect = antPagination.querySelector('.ant-select-selection-selected-value');
            if (sizeSelect) {
                const match = sizeSelect.textContent?.match(/(\d+)/);
                if (match) this.pageSize = parseInt(match[1], 10);
            }

            Logger.debug(`[InfiniteScrollManager] Ant pagination: page ${this.currentPage}/${this.totalPages}, pageSize ${this.pageSize}`);
            this.paginationUnknown = this.totalPages <= 1;
            return;
        }

        // Try Quasar pagination
        const qPagination = document.querySelector('.q-pagination');
        if (qPagination) {
            const buttons = qPagination.querySelectorAll('.q-btn');
            const active = qPagination.querySelector('.q-btn--flat.text-primary, [aria-current="true"]');
            if (active) {
                this.currentPage = parseInt(active.textContent || '1', 10);
            }
            let maxPage = 1;
            buttons.forEach(btn => {
                const num = parseInt(btn.textContent || '0', 10);
                if (!isNaN(num) && num > maxPage) maxPage = num;
            });
            this.totalPages = maxPage;
            Logger.debug(`[InfiniteScrollManager] Q pagination: page ${this.currentPage}/${this.totalPages}`);
            this.paginationUnknown = this.totalPages <= 1;
            return;
        }

        this.paginationUnknown = true;
    }

    private hidePagination(): void {
        // Hide ant-pagination but keep it in DOM for state reference
        const antPagination = document.querySelector('.ant-pagination') as HTMLElement;
        if (antPagination) {
            antPagination.style.display = 'none';
        }

        const qPagination = document.querySelector('.q-pagination') as HTMLElement;
        if (qPagination) {
            qPagination.style.display = 'none';
        }
    }

    private hasMorePages(): boolean {
        if (this.reachedEnd) return false;
        if (this.paginationUnknown) return true;
        return this.currentPage < this.totalPages;
    }

    private async triggerNextPage(): Promise<void> {
        if (this.isLoading) return;
        if (!this.hasMorePages()) {
            Logger.debug('[InfiniteScrollManager] No more pages');
            this.showEndMessage();
            return;
        }

        this.isLoading = true;
        this.currentPage++;
        Logger.debug(`[InfiniteScrollManager] Loading page ${this.currentPage}/${this.totalPages}`);

        this.showLoadingIndicator();

        try {
            // Build API URL based on current route
            const apiUrl = this.buildApiUrl();
            if (!apiUrl) {
                Logger.warn('[InfiniteScrollManager] Could not determine API URL');
                this.isLoading = false;
                return;
            }

            const response = await this.bridge.axios.get<{ pagination?: Record<string, unknown>; works?: unknown[] }>(apiUrl);
            const pagination = response.data?.pagination;
            if (pagination) {
                const totalCount = pagination.totalCount ?? pagination.total_count;
                const pageSize = pagination.pageSize ?? pagination.page_size ?? this.pageSize;
                const currentPage = pagination.currentPage ?? pagination.page ?? pagination.current_page;
                if (typeof pageSize === 'number' && pageSize > 0) {
                    this.pageSize = pageSize;
                }
                if (typeof totalCount === 'number' && totalCount >= 0 && this.pageSize > 0) {
                    const totalPages = Math.ceil(totalCount / this.pageSize);
                    if (totalPages > 0) {
                        this.totalPages = Math.max(this.totalPages, totalPages);
                        this.paginationUnknown = false;
                    }
                }
                if (typeof currentPage === 'number' && currentPage > 0) {
                    this.currentPage = Math.max(this.currentPage, currentPage);
                }
            }

            const works = response.data?.works || response.data?.pagination?.works || response.data;

            if (Array.isArray(works) && works.length > 0) {
                const addedWorkIds = this.appendWorksToGrid(works);
                Logger.debug(`[InfiniteScrollManager] Appended ${works.length} works`);
                this.resetBackoff(); // Success - reset any backoff state
                if (!this.paginationUnknown && this.currentPage >= this.totalPages) {
                    this.reachedEnd = true;
                }

                // Wait for images to load before unlocking scroll
                if (addedWorkIds.length > 0) {
                    this.showLoadingImagesIndicator(addedWorkIds.length);
                    await this.waitForImagesToLoad(addedWorkIds);
                }
            } else {
                Logger.debug('[InfiniteScrollManager] No more works returned');
                this.totalPages = this.currentPage; // Stop further attempts
                this.paginationUnknown = false;
                this.reachedEnd = true;
            }
        } catch (error) {
            const status = (error as { response?: { status?: number }; status?: number })?.response?.status || (error as { status?: number })?.status;
            if (status === 429) {
                this.currentPage--; // Revert page so retry fetches same page
                this.handleRateLimit();
                return;
            }
            Logger.error('[InfiniteScrollManager] Failed to load next page:', error);
            this.currentPage--; // Revert on error
            this.resetBackoff();
        } finally {
            // Don't reset isLoading if a rate-limit retry timer is pending —
            // otherwise the IntersectionObserver can trigger duplicate requests.
            if (this.retryTimer === null) {
                this.isLoading = false;
            }
            this.hideLoadingIndicator();
        }
    }

    private handleRateLimit(): void {
        if (this.retryCount >= this.MAX_RETRIES) {
            Logger.error('[InfiniteScrollManager] Max retries exceeded for rate limit');
            this.showRateLimitMessage();
            this.resetBackoff();
            return;
        }

        this.retryDelay = this.retryCount === 0
            ? this.INITIAL_BACKOFF_MS
            : this.retryDelay * this.BACKOFF_MULTIPLIER;
        this.retryCount++;

        Logger.warn(`[InfiniteScrollManager] Rate limited (429), retry ${this.retryCount}/${this.MAX_RETRIES} in ${this.retryDelay}ms`);
        this.showRateLimitIndicator(this.retryDelay);

        this.retryTimer = window.setTimeout(() => {
            this.retryTimer = null;
            this.isLoading = false;
            this.hideLoadingIndicator();
            void this.triggerNextPage();
        }, this.retryDelay);
    }

    private resetBackoff(): void {
        this.retryCount = 0;
        this.retryDelay = 0;
        if (this.retryTimer !== null) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
    }

    private showRateLimitIndicator(delayMs: number): void {
        if (!this.sentinel) return;
        const seconds = Math.ceil(delayMs / 1000);
        this.sentinel.innerHTML = `
            <div class="text-center q-pa-md text-warning">
                <i class="q-icon notranslate material-icons" style="font-size: 24px;">hourglass_empty</i>
                <div>Rate limited. Retrying in ${seconds}s...</div>
            </div>
        `;
        this.sentinel.style.height = 'auto';
    }

    private showRateLimitMessage(): void {
        if (!this.sentinel) return;
        this.sentinel.innerHTML = `
            <div class="text-center q-pa-md text-negative">
                <i class="q-icon notranslate material-icons" style="font-size: 24px;">error_outline</i>
                <div>Rate limited. Please wait a moment before scrolling.</div>
            </div>
        `;
        this.sentinel.style.height = 'auto';
    }

    private showLoadingImagesIndicator(count: number): void {
        if (!this.sentinel) return;
        this.sentinel.innerHTML = `
            <div class="text-center q-pa-md">
                <svg focusable="false" fill="currentColor" width="40px" height="40px" viewBox="0 0 120 30" xmlns="http://www.w3.org/2000/svg" class="q-spinner text-primary">
                    <circle cx="15" cy="15" r="15"><animate attributeName="r" from="15" to="15" begin="0s" dur="0.8s" values="15;9;15" calcMode="linear" repeatCount="indefinite"></animate></circle>
                    <circle cx="60" cy="15" r="9" fill-opacity=".3"><animate attributeName="r" from="9" to="9" begin="0s" dur="0.8s" values="9;15;9" calcMode="linear" repeatCount="indefinite"></animate></circle>
                    <circle cx="105" cy="15" r="15"><animate attributeName="r" from="15" to="15" begin="0s" dur="0.8s" values="15;9;15" calcMode="linear" repeatCount="indefinite"></animate></circle>
                </svg>
                <div class="text-grey">Loading ${count} images...</div>
            </div>
        `;
        this.sentinel.style.height = 'auto';
    }

    /**
     * Wait for cover images of newly added works to load.
     * Retries failed images with exponential backoff.
     */
    private async waitForImagesToLoad(workIds: string[]): Promise<void> {
        // Wait a tick for Vue/DOM to render
        await new Promise(resolve => setTimeout(resolve, 100));

        const images: HTMLImageElement[] = [];
        for (const workId of workIds) {
            // Find images by work ID - they're inside cards with id="RJxxxxxx"
            const card = document.getElementById(workId);
            if (card) {
                const img = card.querySelector('img[src*="cover"], img[src*="/api/cover"]') as HTMLImageElement;
                if (img) images.push(img);
            }
        }

        if (images.length === 0) {
            Logger.debug('[InfiniteScrollManager] No images found to wait for');
            return;
        }

        Logger.debug(`[InfiniteScrollManager] Waiting for ${images.length} images to load`);

        // Wait for all images with retry on failure
        const results = await Promise.allSettled(
            images.map(img => this.loadImageWithRetry(img))
        );

        const failed = results.filter(r => r.status === 'rejected').length;
        if (failed > 0) {
            Logger.warn(`[InfiniteScrollManager] ${failed}/${images.length} images failed to load after retries`);
        } else {
            Logger.debug(`[InfiniteScrollManager] All ${images.length} images loaded`);
        }
    }

    /**
     * Load a single image with exponential backoff retry.
     */
    private loadImageWithRetry(img: HTMLImageElement, attempt = 0): Promise<void> {
        return new Promise((resolve, reject) => {
            // If already loaded, resolve immediately
            if (img.complete && img.naturalWidth > 0) {
                resolve();
                return;
            }

            const originalSrc = img.src;
            let timeoutId: number | null = null;

            const cleanup = () => {
                img.onload = null;
                img.onerror = null;
                if (timeoutId) clearTimeout(timeoutId);
            };

            img.onload = () => {
                cleanup();
                resolve();
            };

            img.onerror = () => {
                cleanup();

                if (attempt >= this.MAX_RETRIES) {
                    Logger.warn(`[InfiniteScrollManager] Image failed after ${attempt} retries: ${originalSrc}`);
                    reject(new Error('Max retries exceeded'));
                    return;
                }

                const delay = this.INITIAL_BACKOFF_MS * Math.pow(this.BACKOFF_MULTIPLIER, attempt);
                Logger.debug(`[InfiniteScrollManager] Image load failed, retry ${attempt + 1} in ${delay}ms`);

                timeoutId = window.setTimeout(() => {
                    // Force reload by appending cache-bust param
                    const separator = originalSrc.includes('?') ? '&' : '?';
                    img.src = `${originalSrc}${separator}_retry=${Date.now()}`;
                    this.loadImageWithRetry(img, attempt + 1).then(resolve).catch(reject);
                }, delay);
            };

            // Timeout fallback - don't wait forever
            timeoutId = window.setTimeout(() => {
                if (!img.complete) {
                    cleanup();
                    Logger.debug('[InfiniteScrollManager] Image load timeout, continuing');
                    resolve(); // Don't block on slow images
                }
            }, 15000);

            // Trigger load if src already set but not loading
            if (img.src && !img.complete) {
                // Already loading, just wait
            } else if (!img.src) {
                cleanup();
                resolve(); // No src, nothing to wait for
            }
        });
    }

    private buildApiUrl(): string | null {
        return buildInfiniteScrollApiUrl({
            path: this.currentPath,
            query: this.bridge.route.query || {},
            page: this.currentPage,
            pageSize: this.pageSize,
        });
    }

    private appendWorksToGrid(works: unknown[]): string[] {
        const addedWorkIds: string[] = [];

        // Extract work IDs for tracking
        const workIdList = (works as WorkRecord[]).map(work => {
            const id = work.id || work.source_id;
            return id ? (String(id).startsWith('RJ') ? String(id) : `RJ${id}`) : null;
        }).filter((id): id is string => id !== null);

        // Try Vue store integration first
        if (this.appendWorksViaVue(works)) {
            // Vue handles rendering, but we still need to track which works were added
            return workIdList;
        }

        // Fallback: Find the works grid container and append DOM elements
        const grid = document.querySelector('.row.q-col-gutter-x-sm.q-col-gutter-y-lg')
            || document.querySelector('[class*="q-col-gutter"]');

        if (!grid) {
            Logger.warn('[InfiniteScrollManager] Could not find works grid');
            return [];
        }

        (works as WorkRecord[]).forEach((work) => {
            const workId = work.id || work.source_id;
            if (!workId) return;

            const rjCode = String(workId).startsWith('RJ') ? String(workId) : `RJ${workId}`;

            // Check if this work already exists in the grid
            const existingCard = document.getElementById(rjCode);
            if (existingCard) return;

            // Create work card HTML (simplified version matching site structure)
            const card = this.createWorkCard(work);
            grid.appendChild(card);
            addedWorkIds.push(rjCode);
        });

        return addedWorkIds;
    }

    /**
     * Attempt to append works via Vue store integration
     * Returns true if successful, false if fallback to DOM is needed
     */
    private appendWorksViaVue(works: unknown[]): boolean {
        try {
            const store = this.bridge.store;
            const state = store.state;

            // Try to find and update the works list in Vue state
            // The site uses different state paths depending on the page type
            const worksArray = state.Works?.list || state.View?.works;

            if (worksArray && Array.isArray(worksArray)) {
                // Get existing work IDs to avoid duplicates
                const storeWorks = worksArray as unknown as WorkRecord[];
                const existingIds = new Set(storeWorks.map((w) => String(w.id || w.source_id)));

                // Filter and add new works
                const newWorks = (works as WorkRecord[]).filter(work => {
                    const workId = String(work.id || work.source_id);
                    return !existingIds.has(workId);
                });

                if (newWorks.length > 0) {
                    // Push directly to the reactive array - Vue 2 will detect this
                    storeWorks.push(...newWorks);
                    Logger.debug(`[InfiniteScrollManager] Added ${newWorks.length} works via Vue store`);
                    return true;
                }
                return true; // No new works but still successful
            }

            // Alternative: Try to find the grid component's Vue instance
            const gridComponent = this.findGridVueComponent();
            if (gridComponent) {
                const componentWorks = (gridComponent.works || gridComponent.$data?.works || gridComponent.list || gridComponent.$data?.list) as WorkRecord[] | undefined;
                if (componentWorks && Array.isArray(componentWorks)) {
                    const existingIds = new Set(componentWorks.map((w) => String(w.id || w.source_id)));
                    const newWorks = (works as WorkRecord[]).filter(work => {
                        const workId = String(work.id || work.source_id);
                        return !existingIds.has(workId);
                    });

                    if (newWorks.length > 0) {
                        componentWorks.push(...newWorks);
                        Logger.debug(`[InfiniteScrollManager] Added ${newWorks.length} works via Vue component`);
                        return true;
                    }
                    return true;
                }
            }

            return false;
        } catch (error) {
            Logger.warn('[InfiniteScrollManager] Vue integration failed, using DOM fallback:', error);
            return false;
        }
    }

    /**
     * Find the Vue component instance managing the works grid
     */
    private findGridVueComponent(): KikoeruApp | null {
        const grid = document.querySelector('.row.q-col-gutter-x-sm.q-col-gutter-y-lg')
            || document.querySelector('[class*="q-col-gutter"]');

        if (!grid) return null;

        // Walk up the DOM tree to find a Vue instance with works data
        let el: HTMLElement | null = grid as HTMLElement;
        while (el) {
            const vue = (el as VueElement).__vue__;
            if (vue) {
                // Check if this component has works data
                if (vue.works || vue.$data?.works || vue.list || vue.$data?.list) {
                    return vue;
                }
                // Check parent components
                let parent = vue.$parent;
                while (parent) {
                    if (parent.works || parent.$data?.works || parent.list || parent.$data?.list) {
                        return parent;
                    }
                    parent = parent.$parent;
                }
            }
            el = el.parentElement;
        }

        return null;
    }

    private createWorkCard(work: WorkRecord): HTMLElement {
        const workId = work.id || work.source_id;
        const rjCode = `RJ${workId}`;
        const title = work.title || work.name || rjCode;
        const circle = work.circle?.name || work.maker?.name || '';
        const coverUrl = work.mainCoverUrl || `/api/cover/${workId}.jpg?type=main`;
        const releaseDate = work.release ? new Date(work.release).toISOString().split('T')[0] : '';
        const rating = work.rate_average_2dp || work.rating || 0;
        const ratingCount = work.rate_count_detail?.total || work.rate_count || 0;
        const reviewCount = work.review_count || 0;
        const price = work.price || 0;
        const sales = work.dl_count || work.sales || 0;
        const duration = work.duration ? this.formatDuration(work.duration) : '';
        const isAllAges = work.age_category_string === 'all-ages' || work.nsfw === false;

        const col = document.createElement('div');
        col.className = 'col-xs-12 col-sm-4 col-md-3 col-lg-2 col-xl-2';
        col.id = rjCode;

        col.innerHTML = `
            <div class="q-intersection fit work-card-intersection" style="min-height: 200px;">
                <div>
                    <div class="fit q-card q-card--dark q-dark">
                        <a href="/work/${rjCode}" class="">
                            <div role="img" aria-label="Cover of ${this.escapeHtml(title)}" class="q-img overflow-hidden q-img--menu" style="max-width: 560px;">
                                <div style="padding-bottom: 75%;"></div>
                                <div class="q-img__image absolute-full" style="background-size: cover; background-position: 50% 50%; background-image: url('${coverUrl}');">
                                    <img src="${coverUrl}" aria-hidden="true" class="absolute-full fit">
                                </div>
                                <div class="q-img__content absolute-full">
                                    <div class="absolute-top-left transparent" style="padding: 0px;">
                                        <div class="q-chip row inline no-wrap items-center q-ma-sm bg-brown text-white q-chip--colored q-chip--dense q-chip--square q-chip--dark q-dark">
                                            <div class="q-chip__content col row no-wrap items-center q-anchor--skip">${rjCode}</div>
                                        </div>
                                    </div>
                                    <div class="absolute-bottom-right" style="padding: 5px;">${releaseDate}</div>
                                </div>
                            </div>
                        </a>
                        <hr class="q-separator q-separator--horizontal q-separator--dark">
                        <div>
                            <div class="q-mx-sm text-h6 text-weight-regular ellipsis-2-lines">
                                <a href="/work/${rjCode}" style="color: inherit;" title="${this.escapeHtml(title)}">${this.escapeHtml(title)}</a>
                            </div>
                            <div class="q-ml-sm q-mb-xs text-subtitle1 text-weight-regular">
                                <div class="text-grey ellipsis">${this.escapeHtml(circle)}</div>
                            </div>
                            <div class="row items-center">
                                <div class="col-auto q-ml-sm">
                                    ${this.createStarRating(rating)}
                                </div>
                                <div class="col-auto">
                                    <span class="text-weight-medium text-body1 text-red">${rating.toFixed(2)}</span>
                                    <span class="text-grey">(${ratingCount})</span>
                                </div>
                                <div class="col-auto q-ml-xs">
                                    <i class="q-icon notranslate material-icons" style="font-size: 18px;">chat</i>
                                    <span class="text-grey">(${reviewCount})</span>
                                </div>
                                ${duration ? `
                                <div class="col-auto q-ml-xs">
                                    <i class="q-icon text-white notranslate material-icons" style="font-size: 18px;">schedule</i>
                                    <span class="text-white">(${duration})</span>
                                </div>` : ''}
                                <div class="col-auto q-ml-xs">
                                    <i class="q-icon notranslate material-icons" style="font-size: 18px;">launch</i>
                                    <a href="https://www.dlsite.com/maniax/work/=/product_id/${rjCode}.html" rel="noreferrer noopener" target="_blank" class="text-blue">DLsite</a>
                                </div>
                            </div>
                            <div>
                                <span class="q-mx-sm text-weight-medium text-h6 text-red">${price} JPY</span>
                                <span>Sales: ${sales}</span>
                                ${isAllAges ? '<div class="q-chip row inline no-wrap items-center q-py-sm q-chip--dense q-chip--outline q-chip--square q-chip--dark q-dark text-green" style="font-size: 10px; margin-top: 0px;"><div class="q-chip__content col row no-wrap items-center q-anchor--skip">All-ages</div></div>' : ''}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        return col;
    }

    private createStarRating(rating: number): string {
        const fullStars = Math.floor(rating);
        const hasHalf = rating - fullStars >= 0.5;
        const color = rating >= 4.5 ? 'text-amber' : 'text-blue';
        let html = `<div class="q-rating row inline items-center" style="font-size: 24px;">`;
        for (let i = 1; i <= 5; i++) {
            const icon = i <= fullStars ? 'star' : (i === fullStars + 1 && hasHalf ? 'star_half' : 'star_border');
            html += `<div class="q-rating__icon-container flex flex-center"><i class="q-icon notranslate material-icons q-rating__icon ${color}">${icon}</i></div>`;
        }
        html += '</div>';
        return html;
    }

    private formatDuration(seconds: number): string {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        if (hours > 0) {
            return `${hours}.${Math.round(minutes / 6)}h`;
        }
        return `${minutes}m`;
    }

    private escapeHtml(str: string): string {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    private showLoadingIndicator(): void {
        if (!this.sentinel) return;
        this.sentinel.innerHTML = `
            <div class="text-center q-pa-md">
                <svg focusable="false" fill="currentColor" width="40px" height="40px" viewBox="0 0 120 30" xmlns="http://www.w3.org/2000/svg" class="q-spinner text-primary">
                    <circle cx="15" cy="15" r="15"><animate attributeName="r" from="15" to="15" begin="0s" dur="0.8s" values="15;9;15" calcMode="linear" repeatCount="indefinite"></animate></circle>
                    <circle cx="60" cy="15" r="9" fill-opacity=".3"><animate attributeName="r" from="9" to="9" begin="0s" dur="0.8s" values="9;15;9" calcMode="linear" repeatCount="indefinite"></animate></circle>
                    <circle cx="105" cy="15" r="15"><animate attributeName="r" from="15" to="15" begin="0s" dur="0.8s" values="15;9;15" calcMode="linear" repeatCount="indefinite"></animate></circle>
                </svg>
            </div>
        `;
        this.sentinel.style.height = 'auto';
    }

    private hideLoadingIndicator(): void {
        if (!this.sentinel) return;
        this.sentinel.innerHTML = '';
        this.sentinel.style.height = '1px';
    }

    private showEndMessage(): void {
        if (!this.sentinel) return;
        this.sentinel.innerHTML = `<div class="text-center text-grey q-pa-md">End of results</div>`;
        this.sentinel.style.height = 'auto';
    }

    private createSentinel(): void {
        // Find the main content area - insert sentinel after the works grid
        const grid = document.querySelector('.row.q-col-gutter-x-sm.q-col-gutter-y-lg')
            || document.querySelector('[class*="q-col-gutter"]');

        const contentArea = grid?.parentElement
            || document.querySelector('.q-page-container .q-page')
            || document.querySelector('.q-page-container')
            || document.querySelector('main');

        if (!contentArea) {
            Logger.warn('[InfiniteScrollManager] Could not find content area for sentinel');
            return;
        }

        this.sentinel = document.createElement('div');
        this.sentinel.id = 'infinite-scroll-sentinel';
        this.sentinel.style.cssText = 'height: 1px; width: 100%; pointer-events: none;';

        // Insert after the grid, not at the very end
        if (grid && grid.parentElement === contentArea) {
            grid.after(this.sentinel);
        } else {
            contentArea.appendChild(this.sentinel);
        }
    }

    private setupObserver(): void {
        if (!this.sentinel || typeof IntersectionObserver === 'undefined') return;

        this.observer = new IntersectionObserver(
            (entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting && !this.isLoading) {
                        void this.triggerNextPage();
                    }
                });
            },
            {
                rootMargin: '600px', // Trigger early before reaching bottom
                threshold: 0.1
            }
        );

        this.observer.observe(this.sentinel);
    }

    private cleanup(): void {
        // Restore pagination visibility
        const antPagination = document.querySelector('.ant-pagination') as HTMLElement;
        if (antPagination) {
            antPagination.style.display = '';
        }
        const qPagination = document.querySelector('.q-pagination') as HTMLElement;
        if (qPagination) {
            qPagination.style.display = '';
        }

        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }

        if (this.sentinel) {
            this.sentinel.remove();
            this.sentinel = null;
        }

        this.isLoading = false;
        this.currentPage = 1;
        this.totalPages = 1;

        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }

        this.resetBackoff();
    }

    destroy(): void {
        this.disable();
    }
}
