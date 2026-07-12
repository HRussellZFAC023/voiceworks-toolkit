<script setup lang="ts">
/**
 * InfiniteScrollGrid - Vue 3 SFC for infinite scroll work grid
 *
 * Replaces/augments the default paginated work grid with infinite scroll.
 * Uses IntersectionObserver to detect when the user scrolls near the bottom,
 * fetches the next page via the API, and appends work cards to the grid.
 */

import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { useBridge } from '../../composables/useBridge';
import { useConfig } from '../../composables/useConfig';
import { useRoute } from '../../composables/useRoute';
import { useI18n } from '../../composables/useI18n';
import { Logger } from '../../core/Utils';
import { escapeHtml } from '../../core/DomUtils';
import { buildInfiniteScrollApiUrl } from '../infiniteScrollApiUtils';
import {
    finiteWorkMetric,
    normalizeInfiniteScrollRjCode,
    resolveInfiniteScrollCoverUrl,
} from '../infiniteScrollCardUtils';

// ============================================================================
// Types
// ============================================================================

interface WorkItem {
    id: number | string;
    source_id?: string;
    sourceId?: string | number;
    title?: string;
    name?: string;
    circle?: { name?: string };
    maker?: { name?: string };
    mainCoverUrl?: string;
    release?: string;
    rate_average_2dp?: number;
    rating?: number;
    rate_count_detail?: { total?: number } | Array<{ count: number }>;
    rate_count?: number;
    review_count?: number;
    price?: number;
    dl_count?: number;
    sales?: number;
    duration?: number;
    age_category_string?: string;
    nsfw?: boolean;
}

interface PaginationData {
    totalCount?: number;
    total_count?: number;
    pageSize?: number;
    page_size?: number;
    currentPage?: number;
    page?: number;
    current_page?: number;
    works?: unknown[];
}

/** Loosely-typed Vue 2 instance for __vue__ DOM access */
interface Vue2Instance {
    works?: unknown[];
    list?: unknown[];
    $data?: Record<string, unknown>;
    $parent?: Vue2Instance;
    [key: string]: unknown;
}

type SentinelState = 'idle' | 'loading' | 'loading-images' | 'rate-limit' | 'rate-limit-error' | 'end';

// ============================================================================
// Constants
// ============================================================================

const DEBOUNCE_MS = 300;
const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 1000;
const BACKOFF_MULTIPLIER = 2;

// ============================================================================
// Composables
// ============================================================================

const bridge = useBridge();
const enabled = useConfig('enableInfiniteScroll');
const route = useRoute();
const { t, format } = useI18n();

// ============================================================================
// Reactive State
// ============================================================================

const sentinelState = ref<SentinelState>('idle');
const isLoading = ref(false);
const currentPage = ref(1);
const totalPages = ref(1);
const pageSize = ref(20);
const paginationUnknown = ref(false);
const reachedEnd = ref(false);
const retryCountdownSeconds = ref(0);
const loadingImageCount = ref(0);

// Backoff state
let retryCount = 0;
let retryDelay = 0;
let retryTimer: number | null = null;
let debounceTimer: number | null = null;

// Track DOM-injected card IDs for dedup
const injectedCardIds = new Set<string>();

// Prefetch state
interface PrefetchResult {
    page: number;
    works: WorkItem[];
    pagination?: PaginationData;
}
let prefetchedResult: PrefetchResult | null = null;
let prefetching = false;
let componentMounted = false;
let lifecycleGeneration = 0;

// Template refs
const sentinelRef = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | null = null;

function isLifecycleCurrent(generation: number): boolean {
    return componentMounted && enabled.value && generation === lifecycleGeneration;
}

// ============================================================================
// Computed
// ============================================================================

const hasMorePages = computed(() => {
    if (reachedEnd.value) return false;
    if (paginationUnknown.value) return true;
    return currentPage.value < totalPages.value;
});

// ============================================================================
// Work Card Helpers
// ============================================================================

function getRjCode(work: WorkItem): string {
    return normalizeInfiniteScrollRjCode(work.id, work.source_id, work.sourceId);
}

function getTitle(work: WorkItem): string {
    return work.title || work.name || getRjCode(work);
}

function getCircleName(work: WorkItem): string {
    return work.circle?.name || work.maker?.name || '';
}

function getCoverUrl(work: WorkItem, rjCode: string): string {
    return resolveInfiniteScrollCoverUrl(work.mainCoverUrl, rjCode);
}

function getReleaseDate(work: WorkItem): string {
    if (!work.release) return '';
    try {
        return new Date(work.release).toISOString().split('T')[0];
    } catch {
        return '';
    }
}

function getRating(work: WorkItem): number {
    return finiteWorkMetric(work.rate_average_2dp || work.rating);
}

function getRatingCount(work: WorkItem): number {
    const detail = work.rate_count_detail;
    if (detail && !Array.isArray(detail) && typeof detail === 'object' && 'total' in detail) {
        return finiteWorkMetric((detail as { total?: number }).total);
    }
    return finiteWorkMetric(work.rate_count);
}

function formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
        return `${hours}.${Math.round(minutes / 6)}h`;
    }
    return `${minutes}m`;
}

function createStarRatingHTML(rating: number): string {
    const fullStars = Math.floor(rating);
    const hasHalf = rating - fullStars >= 0.5;
    const color = rating >= 4.5 ? 'text-amber' : 'text-blue';
    let html = '<div class="q-rating row inline items-center" style="font-size: 24px;">';
    for (let i = 1; i <= 5; i++) {
        const icon = i <= fullStars ? 'star' : (i === fullStars + 1 && hasHalf ? 'star_half' : 'star_border');
        html += `<div class="q-rating__icon-container flex flex-center"><i class="q-icon notranslate material-icons q-rating__icon ${color}">${icon}</i></div>`;
    }
    html += '</div>';
    return html;
}

/**
 * Find the host app's works grid, excluding our own component.
 * Uses multiple strategies since the grid's CSS classes vary across versions.
 */
function findHostGrid(): HTMLElement | null {
    const ownRoot = document.getElementById('asmr-infinite-scroll-root');

    // Strategy 1: q-col-gutter elements excluding horizontal carousels
    const candidates = document.querySelectorAll('[class*="q-col-gutter"]');
    let fallback: HTMLElement | null = null;
    for (const el of candidates) {
        if (ownRoot?.contains(el)) continue;
        if (el.classList.contains('no-wrap')) continue;
        if (el.className.includes('q-col-gutter-y-')) return el as HTMLElement;
        if (!fallback) fallback = el as HTMLElement;
    }
    if (fallback) return fallback;

    // Strategy 2: Find grid as previous sibling of pagination container
    const pagination = document.querySelector('.q-pagination') || document.querySelector('.ant-pagination');
    if (pagination) {
        const paginationWrapper = pagination.closest('.row.justify-center') || pagination.parentElement;
        if (paginationWrapper) {
            let prev = paginationWrapper.previousElementSibling as HTMLElement | null;
            while (prev) {
                if (prev.classList.contains('row') && prev.querySelectorAll('.q-card').length > 0) {
                    return prev;
                }
                prev = prev.previousElementSibling as HTMLElement | null;
            }
        }
    }

    // Strategy 3: Find parent of work cards (cards wrapped in col-* divs)
    const cards = document.querySelectorAll('.q-card');
    for (const card of cards) {
        if (ownRoot?.contains(card)) continue;
        // Card → col wrapper → grid row
        const colWrapper = card.closest('[class*="col-xs-"], [class*="col-sm-"], [class*="col-md-"]');
        if (colWrapper?.parentElement) {
            const grid = colWrapper.parentElement as HTMLElement;
            // Ensure it's a real grid (has multiple card children) and not a carousel
            if (grid.children.length > 1 && !grid.classList.contains('no-wrap')) {
                return grid;
            }
        }
    }

    return null;
}

/**
 * DOM fallback: append work cards directly into the host grid.
 * Used when Vue store integration fails.
 */
function appendWorksToHostGrid(newWorks: WorkItem[]): string[] {
    const grid = findHostGrid();
    if (!grid) {
        Logger.warn('[InfiniteScrollGrid] Could not find host grid for DOM fallback');
        return [];
    }

    const addedIds: string[] = [];
    for (const work of newWorks) {
        const rjCode = getRjCode(work);
        if (!rjCode) {
            Logger.warn('[InfiniteScrollGrid] Skipping work with invalid identifier');
            continue;
        }
        if (document.getElementById(rjCode) || injectedCardIds.has(rjCode)) continue;

        const title = getTitle(work);
        const circle = getCircleName(work);
        const coverUrl = getCoverUrl(work, rjCode);
        const releaseDate = getReleaseDate(work);
        const rating = getRating(work);
        const ratingCount = getRatingCount(work);
        const reviewCount = finiteWorkMetric(work.review_count);
        const price = finiteWorkMetric(work.price);
        const sales = finiteWorkMetric(work.dl_count || work.sales);
        const durationSeconds = finiteWorkMetric(work.duration);
        const duration = durationSeconds > 0 ? formatDuration(durationSeconds) : '';
        const allAges = work.age_category_string === 'all-ages' || work.nsfw === false;

        const col = document.createElement('div');
        col.className = 'col-xs-12 col-sm-4 col-md-3 col-lg-2 col-xl-2';
        col.id = rjCode;
        col.dataset.asmrInfiniteFallback = 'true';
        col.innerHTML = `
            <div class="fit work-card-intersection" style="min-height: 200px;">
                <div>
                    <div class="fit q-card asmr-infinite-fallback-card">
                        <a href="/work/${rjCode}">
                            <div role="img" aria-label="Cover of ${escapeHtml(title)}" class="q-img overflow-hidden q-img--menu" style="max-width: 560px;">
                                <div style="padding-bottom: 75%;"></div>
                                <div class="q-img__image absolute-full asmr-infinite-cover" style="background-size: cover; background-position: 50% 50%;">
                                    <img aria-hidden="true" class="absolute-full fit asmr-infinite-cover-img">
                                </div>
                                <div class="q-img__content absolute-full">
                                    <div class="absolute-top-left transparent" style="padding: 0px;">
                                        <div class="q-chip row inline no-wrap items-center q-ma-sm bg-brown q-chip--colored q-chip--dense q-chip--square asmr-infinite-rj-chip">
                                            <div class="q-chip__content col row no-wrap items-center q-anchor--skip">${rjCode}</div>
                                        </div>
                                    </div>
                                    <div class="absolute-bottom-right" style="padding: 5px;">${releaseDate}</div>
                                </div>
                            </div>
                        </a>
                        <hr class="q-separator q-separator--horizontal asmr-infinite-fallback-separator">
                        <div>
                            <div class="q-mx-sm text-h6 text-weight-regular ellipsis-2-lines">${escapeHtml(title)}</div>
                            <div class="q-ml-sm q-mb-xs text-subtitle1 text-weight-regular">
                                <div class="text-grey ellipsis">${escapeHtml(circle)}</div>
                            </div>
                            <div class="row items-center">
                                <div class="col-auto q-ml-sm">${createStarRatingHTML(rating)}</div>
                                <div class="col-auto">
                                    <span class="text-weight-medium text-body1 text-red">${rating.toFixed(2)}</span>
                                    <span class="text-grey">(${ratingCount})</span>
                                </div>
                                <div class="col-auto q-ml-xs">
                                    <i class="q-icon notranslate material-icons" style="font-size: 18px;">chat</i>
                                    <span class="text-grey">(${reviewCount})</span>
                                </div>
                                ${duration ? `<div class="col-auto q-ml-xs">
                                    <i class="q-icon notranslate material-icons asmr-infinite-duration" style="font-size: 18px;">schedule</i>
                                    <span class="asmr-infinite-duration">(${duration})</span>
                                </div>` : ''}
                                <div class="col-auto q-ml-xs">
                                    <i class="q-icon notranslate material-icons" style="font-size: 18px;">launch</i>
                                    <a href="https://www.dlsite.com/maniax/work/=/product_id/${rjCode}.html" rel="noreferrer noopener" target="_blank" class="text-blue">DLsite</a>
                                </div>
                            </div>
                            <div>
                                <span class="q-mx-sm text-weight-medium text-h6 text-red">${price} JPY </span>
                                <span>Sales: ${sales}</span>
                                ${allAges ? '<div class="q-chip row inline no-wrap items-center q-py-sm q-chip--dense q-chip--outline q-chip--square text-green" style="font-size: 10px; margin-top: 0px;"><div class="q-chip__content col row no-wrap items-center q-anchor--skip">All-ages</div></div>' : ''}
                            </div>
                        </div>
                    </div>
                </div>
            </div>`;

        // Set remote URLs through DOM/CSS properties so API strings never enter
        // the HTML parser. resolveInfiniteScrollCoverUrl has already restricted
        // the protocol to HTTP(S).
        const coverLayer = col.querySelector<HTMLElement>('.asmr-infinite-cover');
        const coverImage = col.querySelector<HTMLImageElement>('.asmr-infinite-cover-img');
        if (coverLayer) coverLayer.style.backgroundImage = `url(${JSON.stringify(coverUrl)})`;
        if (coverImage) coverImage.src = coverUrl;

        grid.appendChild(col);
        injectedCardIds.add(rjCode);
        addedIds.push(rjCode);
    }

    if (addedIds.length > 0) {
        Logger.info(`[InfiniteScrollGrid] Appended ${addedIds.length} cards to host grid`);
    }
    return addedIds;
}

// ============================================================================
// Pagination Detection
// ============================================================================

function findPaginationComponent(): HTMLElement | null {
    const antPagination = document.querySelector('.ant-pagination');
    if (antPagination) return antPagination as HTMLElement;
    const qPagination = document.querySelector('.q-pagination');
    if (qPagination) return qPagination as HTMLElement;
    return null;
}

function parsePaginationState(): void {
    reachedEnd.value = false;

    const antPagination = document.querySelector('.ant-pagination');
    if (antPagination) {
        const active = antPagination.querySelector('.ant-pagination-item-active');
        if (active) {
            currentPage.value = parseInt(active.textContent || '1', 10);
        }
        const items = antPagination.querySelectorAll('.ant-pagination-item');
        let maxPage = 1;
        items.forEach(item => {
            const num = parseInt(item.textContent || '0', 10);
            if (!isNaN(num) && num > maxPage) maxPage = num;
        });
        totalPages.value = maxPage;

        const sizeSelect = antPagination.querySelector('.ant-select-selection-selected-value');
        if (sizeSelect) {
            const match = sizeSelect.textContent?.match(/(\d+)/);
            if (match) pageSize.value = parseInt(match[1], 10);
        }

        Logger.debug(`[InfiniteScrollGrid] Ant pagination: page ${currentPage.value}/${totalPages.value}, pageSize ${pageSize.value}`);
        paginationUnknown.value = totalPages.value <= 1;
        return;
    }

    const qPagination = document.querySelector('.q-pagination');
    if (qPagination) {
        const buttons = qPagination.querySelectorAll('.q-btn');
        const active = qPagination.querySelector('.q-btn--flat.text-primary, [aria-current="true"]');
        if (active) {
            currentPage.value = parseInt(active.textContent || '1', 10);
        }
        let maxPage = 1;
        buttons.forEach(btn => {
            const num = parseInt(btn.textContent || '0', 10);
            if (!isNaN(num) && num > maxPage) maxPage = num;
        });
        totalPages.value = maxPage;
        Logger.debug(`[InfiniteScrollGrid] Q pagination: page ${currentPage.value}/${totalPages.value}`);
        paginationUnknown.value = totalPages.value <= 1;
        return;
    }

    paginationUnknown.value = true;
}

function hidePagination(): void {
    const antPagination = document.querySelector('.ant-pagination') as HTMLElement;
    if (antPagination) antPagination.style.display = 'none';
    const qPagination = document.querySelector('.q-pagination') as HTMLElement;
    if (qPagination) qPagination.style.display = 'none';
}

function restorePagination(): void {
    const antPagination = document.querySelector('.ant-pagination') as HTMLElement;
    if (antPagination) antPagination.style.display = '';
    const qPagination = document.querySelector('.q-pagination') as HTMLElement;
    if (qPagination) qPagination.style.display = '';
}

// ============================================================================
// API URL Building
// ============================================================================

function buildApiUrl(pageOverride?: number): string | null {
    return buildInfiniteScrollApiUrl({
        path: route.value.path,
        query: route.value.query,
        page: pageOverride ?? currentPage.value,
        pageSize: pageSize.value,
    });
}

// ============================================================================
// Vue Store Integration
// ============================================================================

function appendWorksViaVue(newWorks: WorkItem[]): boolean {
    try {
        const store = bridge.store;
        const state = store.state;
        const worksArray = state.Works?.list || state.View?.works;

        if (worksArray && Array.isArray(worksArray)) {
            const existingIds = new Set(worksArray.map((w: { id?: string | number; source_id?: string }) => String(w.id || w.source_id)));
            const filtered = newWorks.filter(work => {
                const workId = String(work.id || work.source_id);
                return !existingIds.has(workId);
            });
            if (filtered.length > 0) {
                worksArray.push(...filtered);
                Logger.debug(`[InfiniteScrollGrid] Added ${filtered.length} works via Vue store`);
            }
            return true;
        }

        // Walk DOM to find Vue component with works data
        const grid = document.querySelector('.row.q-col-gutter-x-sm.q-col-gutter-y-lg')
            || document.querySelector('[class*="q-col-gutter"]');
        if (grid) {
            let el: HTMLElement | null = grid as HTMLElement;
            while (el) {
                const vue = (el as HTMLElement & { __vue__?: Vue2Instance }).__vue__;
                if (vue) {
                    const componentWorks = vue.works || vue.$data?.works || vue.list || vue.$data?.list;
                    if (componentWorks && Array.isArray(componentWorks)) {
                        const existingIds = new Set(componentWorks.map((w: { id?: string | number; source_id?: string }) => String(w.id || w.source_id)));
                        const filtered = newWorks.filter(work => {
                            const workId = String(work.id || work.source_id);
                            return !existingIds.has(workId);
                        });
                        if (filtered.length > 0) {
                            componentWorks.push(...filtered);
                            Logger.debug(`[InfiniteScrollGrid] Added ${filtered.length} works via Vue component`);
                        }
                        return true;
                    }
                    let parent = vue.$parent;
                    while (parent) {
                        const pWorks = parent.works || parent.$data?.works || parent.list || parent.$data?.list;
                        if (pWorks && Array.isArray(pWorks)) {
                            const existingIds = new Set(pWorks.map((w: { id?: string | number; source_id?: string }) => String(w.id || w.source_id)));
                            const filtered = newWorks.filter(work => {
                                const workId = String(work.id || work.source_id);
                                return !existingIds.has(workId);
                            });
                            if (filtered.length > 0) {
                                pWorks.push(...filtered);
                                Logger.debug(`[InfiniteScrollGrid] Added ${filtered.length} works via Vue parent`);
                            }
                            return true;
                        }
                        parent = parent.$parent;
                    }
                }
                el = el.parentElement;
            }
        }

        return false;
    } catch (error) {
        Logger.warn('[InfiniteScrollGrid] Vue integration failed, using DOM fallback:', error);
        return false;
    }
}

// ============================================================================
// Image Loading
// ============================================================================

function loadImageWithRetry(img: HTMLImageElement, attempt = 0, generation = lifecycleGeneration): Promise<void> {
    return new Promise((resolve, reject) => {
        if (!isLifecycleCurrent(generation)) {
            resolve();
            return;
        }
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

        img.onload = () => { cleanup(); resolve(); };

        img.onerror = () => {
            cleanup();
            if (!isLifecycleCurrent(generation)) {
                resolve();
                return;
            }
            if (attempt >= MAX_RETRIES) {
                Logger.warn(`[InfiniteScrollGrid] Image failed after ${attempt} retries: ${originalSrc}`);
                reject(new Error('Max retries exceeded'));
                return;
            }
            const delay = INITIAL_BACKOFF_MS * Math.pow(BACKOFF_MULTIPLIER, attempt);
            Logger.debug(`[InfiniteScrollGrid] Image load failed, retry ${attempt + 1} in ${delay}ms`);
            timeoutId = window.setTimeout(() => {
                if (!isLifecycleCurrent(generation)) {
                    resolve();
                    return;
                }
                const separator = originalSrc.includes('?') ? '&' : '?';
                img.src = `${originalSrc}${separator}_retry=${Date.now()}`;
                loadImageWithRetry(img, attempt + 1, generation).then(resolve).catch(reject);
            }, delay);
        };

        timeoutId = window.setTimeout(() => {
            if (!isLifecycleCurrent(generation)) {
                cleanup();
                resolve();
                return;
            }
            if (!img.complete) {
                cleanup();
                Logger.debug('[InfiniteScrollGrid] Image load timeout, continuing');
                resolve();
            }
        }, 15000);

        if (!img.src) {
            cleanup();
            resolve();
        }
    });
}

async function waitForImagesToLoad(workIds: string[], generation: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (!isLifecycleCurrent(generation)) return;

    const images: HTMLImageElement[] = [];
    for (const workId of workIds) {
        const card = document.getElementById(workId);
        if (card) {
            const img = card.querySelector('img[src*="cover"], img[src*="/api/cover"]') as HTMLImageElement;
            if (img) images.push(img);
        }
    }

    if (images.length === 0) {
        Logger.debug('[InfiniteScrollGrid] No images found to wait for');
        return;
    }

    Logger.debug(`[InfiniteScrollGrid] Waiting for ${images.length} images to load`);

    const results = await Promise.allSettled(images.map(img => loadImageWithRetry(img, 0, generation)));
    if (!isLifecycleCurrent(generation)) return;
    const failed = results.filter(r => r.status === 'rejected').length;
    if (failed > 0) {
        Logger.warn(`[InfiniteScrollGrid] ${failed}/${images.length} images failed to load after retries`);
    } else {
        Logger.debug(`[InfiniteScrollGrid] All ${images.length} images loaded`);
    }
}

// ============================================================================
// Backoff Helpers
// ============================================================================

function resetBackoff(): void {
    retryCount = 0;
    retryDelay = 0;
    if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
    }
}

function handleRateLimit(generation: number): void {
    if (!isLifecycleCurrent(generation)) return;
    if (retryCount >= MAX_RETRIES) {
        Logger.error('[InfiniteScrollGrid] Max retries exceeded for rate limit');
        sentinelState.value = 'rate-limit-error';
        resetBackoff();
        return;
    }

    retryDelay = retryCount === 0 ? INITIAL_BACKOFF_MS : retryDelay * BACKOFF_MULTIPLIER;
    retryCount++;

    Logger.warn(`[InfiniteScrollGrid] Rate limited (429), retry ${retryCount}/${MAX_RETRIES} in ${retryDelay}ms`);
    retryCountdownSeconds.value = Math.ceil(retryDelay / 1000);
    sentinelState.value = 'rate-limit';

    retryTimer = window.setTimeout(() => {
        if (!isLifecycleCurrent(generation)) return;
        retryTimer = null;
        isLoading.value = false;
        sentinelState.value = 'idle';
        void triggerNextPage();
    }, retryDelay);
}

// ============================================================================
// Prefetch
// ============================================================================

/**
 * Prefetch the next page in the background so it's ready instantly
 * when the observer triggers.
 */
async function prefetchNext(): Promise<void> {
    const generation = lifecycleGeneration;
    if (!isLifecycleCurrent(generation)) return;
    if (prefetching || reachedEnd.value) return;
    if (!paginationUnknown.value && currentPage.value >= totalPages.value) return;

    const targetPage = currentPage.value + 1;
    if (prefetchedResult?.page === targetPage) return; // Already have it

    prefetching = true;
    const apiUrl = buildApiUrl(targetPage);
    if (!apiUrl) { prefetching = false; return; }

    try {
        const response = await bridge.axios.get<{ pagination?: PaginationData; works?: WorkItem[] }>(apiUrl);
        if (!isLifecycleCurrent(generation)) return;
        const rawWorks = response.data?.works || response.data?.pagination?.works || response.data;
        prefetchedResult = {
            page: targetPage,
            works: Array.isArray(rawWorks) ? rawWorks as WorkItem[] : [],
            pagination: response.data?.pagination,
        };
        Logger.debug(`[InfiniteScrollGrid] Prefetched page ${targetPage} (${prefetchedResult.works.length} works)`);
    } catch (error) {
        if (!isLifecycleCurrent(generation)) return;
        const status = (error as { response?: { status?: number } })?.response?.status;
        if (status === 429) {
            Logger.debug('[InfiniteScrollGrid] Prefetch rate limited, skipping');
        }
        prefetchedResult = null;
    } finally {
        if (generation === lifecycleGeneration) prefetching = false;
    }
}

// ============================================================================
// Core: Fetch Next Page
// ============================================================================

/**
 * Process pagination metadata from API response.
 */
function processPagination(pagination: PaginationData): void {
    const totalCount = pagination.totalCount ?? pagination.total_count;
    const ps = pagination.pageSize ?? pagination.page_size ?? pageSize.value;
    const cp = pagination.currentPage ?? pagination.page ?? pagination.current_page;
    if (typeof ps === 'number' && ps > 0) pageSize.value = ps;
    if (typeof totalCount === 'number' && totalCount >= 0 && pageSize.value > 0) {
        const tp = Math.ceil(totalCount / pageSize.value);
        if (tp > 0) {
            totalPages.value = Math.max(totalPages.value, tp);
            paginationUnknown.value = false;
        }
    }
    if (typeof cp === 'number' && cp > 0) {
        currentPage.value = Math.max(currentPage.value, cp);
    }
}

/**
 * Append works to the grid (Vue store or DOM fallback) and wait for images.
 */
async function appendAndWait(typedWorks: WorkItem[], generation: number): Promise<boolean> {
    if (!isLifecycleCurrent(generation)) return false;
    const workIdList = typedWorks.map(work => {
        const id = work.id || work.source_id;
        return id ? (String(id).startsWith('RJ') ? String(id) : `RJ${id}`) : null;
    }).filter(Boolean) as string[];

    // Try Vue store integration first
    const vueHandled = appendWorksViaVue(typedWorks);
    if (!vueHandled) {
        appendWorksToHostGrid(typedWorks);
    }

    Logger.debug(`[InfiniteScrollGrid] Appended ${typedWorks.length} works`);
    resetBackoff();

    if (!paginationUnknown.value && currentPage.value >= totalPages.value) {
        reachedEnd.value = true;
    }

    // Wait for images to load
    if (workIdList.length > 0) {
        loadingImageCount.value = workIdList.length;
        sentinelState.value = 'loading-images';
        await waitForImagesToLoad(workIdList, generation);
    }
    return isLifecycleCurrent(generation);
}

async function triggerNextPage(): Promise<void> {
    const generation = lifecycleGeneration;
    if (!isLifecycleCurrent(generation)) return;
    if (isLoading.value) return;
    if (!hasMorePages.value) {
        Logger.info('[InfiniteScrollGrid] No more pages');
        sentinelState.value = 'end';
        return;
    }

    isLoading.value = true;
    currentPage.value++;

    try {
        let rawWorks: unknown[];
        let pagination: PaginationData | undefined;

        // Use prefetched data if available for this page
        if (prefetchedResult?.page === currentPage.value) {
            rawWorks = prefetchedResult.works;
            pagination = prefetchedResult.pagination;
            prefetchedResult = null;
            Logger.info(`[InfiniteScrollGrid] Using prefetched page ${currentPage.value}`);
        } else {
            // Fresh fetch — show loading spinner
            sentinelState.value = 'loading';
            Logger.info(`[InfiniteScrollGrid] Fetching page ${currentPage.value}/${totalPages.value}`);

            const apiUrl = buildApiUrl();
            if (!apiUrl) {
                Logger.warn('[InfiniteScrollGrid] Could not determine API URL');
                isLoading.value = false;
                sentinelState.value = 'idle';
                return;
            }

            const response = await bridge.axios.get<{ pagination?: PaginationData; works?: WorkItem[] }>(apiUrl);
            if (!isLifecycleCurrent(generation)) return;
            rawWorks = response.data?.works || response.data?.pagination?.works || response.data;
            pagination = response.data?.pagination;
        }

        if (!isLifecycleCurrent(generation)) return;
        if (pagination) processPagination(pagination);

        if (Array.isArray(rawWorks) && rawWorks.length > 0) {
            const appended = await appendAndWait(rawWorks as WorkItem[], generation);
            if (!appended || !isLifecycleCurrent(generation)) return;
            // Start prefetching the next page
            void prefetchNext();
        } else {
            Logger.debug('[InfiniteScrollGrid] No more works returned');
            totalPages.value = currentPage.value;
            paginationUnknown.value = false;
            reachedEnd.value = true;
        }
    } catch (error) {
        if (!isLifecycleCurrent(generation)) return;
        const status = (error as { response?: { status?: number }; status?: number })?.response?.status || (error as { status?: number })?.status;
        if (status === 429) {
            currentPage.value--;
            handleRateLimit(generation);
            return;
        }
        Logger.error('[InfiniteScrollGrid] Failed to load next page:', error);
        currentPage.value--;
        // Retry with backoff for ANY error (server, CORS, network).
        // The IntersectionObserver won't re-fire on its own because the
        // sentinel hasn't changed visibility state after an error.
        if (retryCount < MAX_RETRIES) {
            retryCount++;
            const delay = INITIAL_BACKOFF_MS * Math.pow(BACKOFF_MULTIPLIER, retryCount - 1);
            Logger.warn(`[InfiniteScrollGrid] Error ${status || 'network'}, retry ${retryCount}/${MAX_RETRIES} in ${delay}ms`);
            sentinelState.value = 'loading';
            retryTimer = window.setTimeout(() => {
                if (!isLifecycleCurrent(generation)) return;
                retryTimer = null;
                isLoading.value = false;
                sentinelState.value = 'idle';
                void triggerNextPage();
            }, delay);
        } else {
            Logger.error('[InfiniteScrollGrid] Max retries exceeded');
            sentinelState.value = 'rate-limit-error';
            resetBackoff();
        }
    } finally {
        // Only reset loading state if no retry timer is pending.
        // When a retry is scheduled, keep isLoading=true and sentinelState
        // as-is (loading spinner or rate-limit indicator) until the retry fires.
        if (isLifecycleCurrent(generation) && retryTimer === null) {
            isLoading.value = false;
            if (sentinelState.value === 'loading' || sentinelState.value === 'loading-images') {
                sentinelState.value = reachedEnd.value ? 'end' : 'idle';
            }
        }
    }
}

// ============================================================================
// Page Attachment
// ============================================================================

function attachToCurrentPage(): void {
    if (!enabled.value) return;

    cleanup();

    const path = route.value.path;
    reachedEnd.value = false;
    paginationUnknown.value = false;
    injectedCardIds.clear();

    // Skip pages with their own infinite scroll
    if (path === '/playlists') {
        Logger.debug('[InfiniteScrollGrid] Skipping /playlists - has own infinite scroll');
        return;
    }

    // Playlist detail page may use a non-standard pagination component
    const isPlaylistPage = path === '/playlist' && route.value.query?.id;

    const pagination = findPaginationComponent();
    if (!pagination && !isPlaylistPage) {
        Logger.info('[InfiniteScrollGrid] No pagination found on', path);
        return;
    }

    if (pagination) {
        parsePaginationState();
    } else {
        // Playlist page without standard pagination — use unknown mode
        // so we keep fetching until the API returns empty results.
        paginationUnknown.value = true;
        // Match host app's playlist pageSize (100) to avoid duplicate fetches.
        // With the default 20, pages 2-5 would all return works already shown.
        pageSize.value = 100;
        // Detect works already loaded by host and start from the next page
        const grid = findHostGrid();
        if (grid) {
            const existingCount = grid.children.length;
            if (existingCount > 0) {
                currentPage.value = Math.ceil(existingCount / pageSize.value);
                Logger.info(`[InfiniteScrollGrid] Playlist: ${existingCount} existing works, starting from page ${currentPage.value + 1}`);
            }
        }
    }

    Logger.info(`[InfiniteScrollGrid] Attaching to ${path} (page ${currentPage.value}/${totalPages.value})`);
    hidePagination();
    setupObserver();

    // Start prefetching page 2 immediately so it's ready when the user scrolls
    void prefetchNext();
}

// ============================================================================
// IntersectionObserver
// ============================================================================

function setupObserver(): void {
    const generation = lifecycleGeneration;
    // Wait for sentinel to be in DOM after nextTick
    nextTick(() => {
        if (!isLifecycleCurrent(generation)) return;
        if (!sentinelRef.value || typeof IntersectionObserver === 'undefined') return;

        observer = new IntersectionObserver(
            (entries) => {
                entries.forEach(entry => {
                    if (isLifecycleCurrent(generation) && entry.isIntersecting && !isLoading.value) {
                        void triggerNextPage();
                    }
                });
            },
            {
                rootMargin: '600px',
                threshold: 0.1
            }
        );

        observer.observe(sentinelRef.value);

        // If sentinel is already near viewport (short page), trigger immediately.
        // IntersectionObserver fires async so this covers the race condition.
        const rect = sentinelRef.value.getBoundingClientRect();
        if (rect.top < window.innerHeight + 600) {
            void triggerNextPage();
        }
    });
}

function cleanup(): void {
    lifecycleGeneration++;
    restorePagination();
    document.querySelectorAll<HTMLElement>('[data-asmr-infinite-fallback="true"]')
        .forEach((card) => card.remove());
    injectedCardIds.clear();

    if (observer) {
        observer.disconnect();
        observer = null;
    }

    isLoading.value = false;
    currentPage.value = 1;
    totalPages.value = 1;
    sentinelState.value = 'idle';
    prefetchedResult = null;
    prefetching = false;

    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }

    resetBackoff();
}

// ============================================================================
// Lifecycle
// ============================================================================

// Watch route changes (path OR query — filter/sort toggles only change query)
watch(
    [() => route.value.path, () => JSON.stringify(route.value.query)],
    () => {
        if (!enabled.value) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = window.setTimeout(() => {
            attachToCurrentPage();
        }, 500);
    }
);

// Watch config toggle
watch(enabled, (val) => {
    if (val) {
        attachToCurrentPage();
    } else {
        cleanup();
    }
});

onMounted(() => {
    componentMounted = true;
    if (enabled.value) {
        attachToCurrentPage();
    }
});

onUnmounted(() => {
    componentMounted = false;
    cleanup();
});
</script>

<template>
    <!-- Sentinel / Loading States -->
    <div
        ref="sentinelRef"
        id="infinite-scroll-sentinel"
        class="infinite-scroll-sentinel"
        :style="{ height: sentinelState === 'idle' ? '1px' : 'auto', width: '100%', pointerEvents: 'none' }"
    >
        <!-- Loading spinner -->
        <div v-if="sentinelState === 'loading'" class="text-center q-pa-md">
            <svg focusable="false" fill="currentColor" width="40px" height="40px" viewBox="0 0 120 30" xmlns="http://www.w3.org/2000/svg" class="q-spinner text-primary">
                <circle cx="15" cy="15" r="15"><animate attributeName="r" from="15" to="15" begin="0s" dur="0.8s" values="15;9;15" calcMode="linear" repeatCount="indefinite" /></circle>
                <circle cx="60" cy="15" r="9" fill-opacity=".3"><animate attributeName="r" from="9" to="9" begin="0s" dur="0.8s" values="9;15;9" calcMode="linear" repeatCount="indefinite" /></circle>
                <circle cx="105" cy="15" r="15"><animate attributeName="r" from="15" to="15" begin="0s" dur="0.8s" values="15;9;15" calcMode="linear" repeatCount="indefinite" /></circle>
            </svg>
        </div>

        <!-- Loading images -->
        <div v-if="sentinelState === 'loading-images'" class="text-center q-pa-md">
            <svg focusable="false" fill="currentColor" width="40px" height="40px" viewBox="0 0 120 30" xmlns="http://www.w3.org/2000/svg" class="q-spinner text-primary">
                <circle cx="15" cy="15" r="15"><animate attributeName="r" from="15" to="15" begin="0s" dur="0.8s" values="15;9;15" calcMode="linear" repeatCount="indefinite" /></circle>
                <circle cx="60" cy="15" r="9" fill-opacity=".3"><animate attributeName="r" from="9" to="9" begin="0s" dur="0.8s" values="9;15;9" calcMode="linear" repeatCount="indefinite" /></circle>
                <circle cx="105" cy="15" r="15"><animate attributeName="r" from="15" to="15" begin="0s" dur="0.8s" values="15;9;15" calcMode="linear" repeatCount="indefinite" /></circle>
            </svg>
            <div class="text-grey">{{ format('infScrollLoadingImages', { count: loadingImageCount }) }}</div>
        </div>

        <!-- Rate limit retry -->
        <div v-if="sentinelState === 'rate-limit'" class="text-center q-pa-md">
            <svg focusable="false" fill="currentColor" width="40px" height="40px" viewBox="0 0 120 30" xmlns="http://www.w3.org/2000/svg" class="q-spinner text-primary">
                <circle cx="15" cy="15" r="15"><animate attributeName="r" from="15" to="15" begin="0s" dur="0.8s" values="15;9;15" calcMode="linear" repeatCount="indefinite" /></circle>
                <circle cx="60" cy="15" r="9" fill-opacity=".3"><animate attributeName="r" from="9" to="9" begin="0s" dur="0.8s" values="9;15;9" calcMode="linear" repeatCount="indefinite" /></circle>
                <circle cx="105" cy="15" r="15"><animate attributeName="r" from="15" to="15" begin="0s" dur="0.8s" values="15;9;15" calcMode="linear" repeatCount="indefinite" /></circle>
            </svg>
            <div class="text-grey">{{ format('infScrollRateLimitRetry', { seconds: retryCountdownSeconds }) }}</div>
        </div>

        <!-- Rate limit error -->
        <div v-if="sentinelState === 'rate-limit-error'" class="text-center q-pa-md text-negative">
            <i class="q-icon notranslate material-icons" style="font-size: 24px;">error_outline</i>
            <div>{{ t('infScrollRateLimitError') }}</div>
        </div>

        <!-- End of results -->
        <div v-if="sentinelState === 'end'" class="text-center text-grey q-pa-md">
            {{ t('infScrollEndOfResults') }}
        </div>
    </div>
</template>

<style scoped>
.infinite-scroll-sentinel {
    pointer-events: none;
}
</style>
