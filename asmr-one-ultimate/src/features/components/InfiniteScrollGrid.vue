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

const works = ref<WorkItem[]>([]);
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

// Template refs
const sentinelRef = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | null = null;

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
    const workId = work.id || work.source_id;
    return String(workId).startsWith('RJ') ? String(workId) : `RJ${workId}`;
}

function getTitle(work: WorkItem): string {
    return work.title || work.name || getRjCode(work);
}

function getCircleName(work: WorkItem): string {
    return work.circle?.name || work.maker?.name || '';
}

function getCoverUrl(work: WorkItem): string {
    const workId = work.id || work.source_id;
    return work.mainCoverUrl || `/api/cover/${workId}.jpg?type=main`;
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
    return work.rate_average_2dp || work.rating || 0;
}

function getRatingCount(work: WorkItem): number {
    const detail = work.rate_count_detail;
    if (detail && !Array.isArray(detail) && typeof detail === 'object' && 'total' in detail) {
        return (detail as { total?: number }).total || 0;
    }
    return work.rate_count || 0;
}

function formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
        return `${hours}.${Math.round(minutes / 6)}h`;
    }
    return `${minutes}m`;
}

function getStars(rating: number): Array<{ icon: string; color: string }> {
    const fullStars = Math.floor(rating);
    const hasHalf = rating - fullStars >= 0.5;
    const color = rating >= 4.5 ? 'text-amber' : 'text-blue';
    const result: Array<{ icon: string; color: string }> = [];
    for (let i = 1; i <= 5; i++) {
        let icon: string;
        if (i <= fullStars) {
            icon = 'star';
        } else if (i === fullStars + 1 && hasHalf) {
            icon = 'star_half';
        } else {
            icon = 'star_border';
        }
        result.push({ icon, color });
    }
    return result;
}

function isAllAges(work: WorkItem): boolean {
    return work.age_category_string === 'all-ages' || work.nsfw === false;
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

function buildApiUrl(): string | null {
    const path = route.value.path;
    const query = route.value.query || {};

    if (path === '/' || path === '/works' || path.startsWith('/works')) {
        const params = new URLSearchParams();
        params.set('page', String(currentPage.value));
        params.set('order', query.order || 'release');
        params.set('sort', query.sort || 'desc');
        params.set('subtitle', query.subtitle || '0');
        if (query.keyword) params.set('keyword', query.keyword);
        if (query.seed) params.set('seed', query.seed);
        Object.entries(query).forEach(([key, value]) => {
            if (!params.has(key) && value) {
                params.set(key, String(value));
            }
        });
        return `/api/works?${params.toString()}`;
    }

    if (path === '/search') {
        const params = new URLSearchParams();
        params.set('page', String(currentPage.value));
        Object.entries(query).forEach(([key, value]) => {
            if (key !== 'page' && value) {
                params.set(key, String(value));
            }
        });
        return `/api/search?${params.toString()}`;
    }

    if (path.startsWith('/circle/')) {
        const circleId = path.split('/')[2];
        const params = new URLSearchParams();
        params.set('page', String(currentPage.value));
        return `/api/circles/${circleId}/works?${params.toString()}`;
    }

    if (path.startsWith('/tag/')) {
        const tagId = path.split('/')[2];
        const params = new URLSearchParams();
        params.set('page', String(currentPage.value));
        return `/api/tags/${tagId}/works?${params.toString()}`;
    }

    if (path.startsWith('/va/')) {
        const vaId = path.split('/')[2];
        const params = new URLSearchParams();
        params.set('page', String(currentPage.value));
        return `/api/vas/${vaId}/works?${params.toString()}`;
    }

    return null;
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
            const existingIds = new Set(worksArray.map((w: any) => String(w.id || w.source_id)));
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
                const vue = (el as any).__vue__;
                if (vue) {
                    const componentWorks = vue.works || vue.$data?.works || vue.list || vue.$data?.list;
                    if (componentWorks && Array.isArray(componentWorks)) {
                        const existingIds = new Set(componentWorks.map((w: any) => String(w.id || w.source_id)));
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
                            const existingIds = new Set(pWorks.map((w: any) => String(w.id || w.source_id)));
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

function loadImageWithRetry(img: HTMLImageElement, attempt = 0): Promise<void> {
    return new Promise((resolve, reject) => {
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
            if (attempt >= MAX_RETRIES) {
                Logger.warn(`[InfiniteScrollGrid] Image failed after ${attempt} retries: ${originalSrc}`);
                reject(new Error('Max retries exceeded'));
                return;
            }
            const delay = INITIAL_BACKOFF_MS * Math.pow(BACKOFF_MULTIPLIER, attempt);
            Logger.debug(`[InfiniteScrollGrid] Image load failed, retry ${attempt + 1} in ${delay}ms`);
            timeoutId = window.setTimeout(() => {
                const separator = originalSrc.includes('?') ? '&' : '?';
                img.src = `${originalSrc}${separator}_retry=${Date.now()}`;
                loadImageWithRetry(img, attempt + 1).then(resolve).catch(reject);
            }, delay);
        };

        timeoutId = window.setTimeout(() => {
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

async function waitForImagesToLoad(workIds: string[]): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 100));

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

    const results = await Promise.allSettled(images.map(img => loadImageWithRetry(img)));
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

function handleRateLimit(): void {
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
        retryTimer = null;
        isLoading.value = false;
        sentinelState.value = 'idle';
        void triggerNextPage();
    }, retryDelay);
}

// ============================================================================
// Core: Fetch Next Page
// ============================================================================

async function triggerNextPage(): Promise<void> {
    if (isLoading.value) return;
    if (!hasMorePages.value) {
        Logger.debug('[InfiniteScrollGrid] No more pages');
        sentinelState.value = 'end';
        return;
    }

    isLoading.value = true;
    currentPage.value++;
    sentinelState.value = 'loading';
    Logger.debug(`[InfiniteScrollGrid] Loading page ${currentPage.value}/${totalPages.value}`);

    try {
        const apiUrl = buildApiUrl();
        if (!apiUrl) {
            Logger.warn('[InfiniteScrollGrid] Could not determine API URL');
            isLoading.value = false;
            sentinelState.value = 'idle';
            return;
        }

        const response = await bridge.axios.get<{ pagination?: PaginationData; works?: WorkItem[] }>(apiUrl);
        const pagination = response.data?.pagination;
        if (pagination) {
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

        const rawWorks = response.data?.works || response.data?.pagination?.works || response.data;

        if (Array.isArray(rawWorks) && rawWorks.length > 0) {
            const typedWorks = rawWorks as WorkItem[];

            // Extract work IDs
            const workIdList = typedWorks.map(work => {
                const id = work.id || work.source_id;
                return id ? (String(id).startsWith('RJ') ? String(id) : `RJ${id}`) : null;
            }).filter(Boolean) as string[];

            // Try Vue store integration first
            const vueHandled = appendWorksViaVue(typedWorks);

            if (!vueHandled) {
                // DOM fallback: add to our own reactive works list
                const existingIds = new Set(works.value.map(w => String(w.id || w.source_id)));
                const newWorks = typedWorks.filter(w => {
                    const wid = String(w.id || w.source_id);
                    return !existingIds.has(wid);
                });
                works.value.push(...newWorks);
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
                await waitForImagesToLoad(workIdList);
            }
        } else {
            Logger.debug('[InfiniteScrollGrid] No more works returned');
            totalPages.value = currentPage.value;
            paginationUnknown.value = false;
            reachedEnd.value = true;
        }
    } catch (error) {
        const status = (error as any)?.response?.status || (error as any)?.status;
        if (status === 429) {
            currentPage.value--;
            handleRateLimit();
            return;
        }
        Logger.error('[InfiniteScrollGrid] Failed to load next page:', error);
        currentPage.value--;
        resetBackoff();
    } finally {
        if (retryTimer === null) {
            isLoading.value = false;
        }
        if (sentinelState.value === 'loading' || sentinelState.value === 'loading-images') {
            sentinelState.value = reachedEnd.value ? 'end' : 'idle';
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
    works.value = [];

    // Skip pages with their own infinite scroll
    if (path === '/playlists') {
        Logger.debug('[InfiniteScrollGrid] Skipping /playlists - has own infinite scroll');
        return;
    }

    const pagination = findPaginationComponent();
    if (!pagination) {
        Logger.debug('[InfiniteScrollGrid] No pagination found on', path);
        return;
    }

    parsePaginationState();
    Logger.debug(`[InfiniteScrollGrid] Attaching to ${path} (page ${currentPage.value}/${totalPages.value})`);
    hidePagination();
    setupObserver();
}

// ============================================================================
// IntersectionObserver
// ============================================================================

function setupObserver(): void {
    // Wait for sentinel to be in DOM after nextTick
    nextTick(() => {
        if (!sentinelRef.value || typeof IntersectionObserver === 'undefined') return;

        observer = new IntersectionObserver(
            (entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting && !isLoading.value) {
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
    });
}

function cleanup(): void {
    restorePagination();

    if (observer) {
        observer.disconnect();
        observer = null;
    }

    isLoading.value = false;
    currentPage.value = 1;
    totalPages.value = 1;
    sentinelState.value = 'idle';

    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }

    resetBackoff();
}

// ============================================================================
// Lifecycle
// ============================================================================

// Watch route changes
watch(() => route.value.path, () => {
    if (!enabled.value) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
        attachToCurrentPage();
    }, 500);
});

// Watch config toggle
watch(enabled, (val) => {
    if (val) {
        attachToCurrentPage();
    } else {
        cleanup();
    }
});

onMounted(() => {
    if (enabled.value) {
        attachToCurrentPage();
    }
});

onUnmounted(() => {
    cleanup();
});
</script>

<template>
    <!-- DOM-fallback work cards (only rendered when Vue store integration fails) -->
    <div
        v-if="works.length > 0"
        class="row q-col-gutter-x-sm q-col-gutter-y-lg infinite-scroll-fallback-grid"
    >
        <div
            v-for="work in works"
            :key="getRjCode(work)"
            :id="getRjCode(work)"
            class="col-xs-12 col-sm-4 col-md-3 col-lg-2 col-xl-2"
        >
            <div class="q-intersection fit work-card-intersection" style="min-height: 200px;">
                <div>
                    <div class="fit q-card q-card--dark q-dark">
                        <a :href="`/work/${getRjCode(work)}`">
                            <div
                                role="img"
                                :aria-label="`Cover of ${getTitle(work)}`"
                                class="q-img overflow-hidden q-img--menu"
                                style="max-width: 560px;"
                            >
                                <div style="padding-bottom: 75%;"></div>
                                <div
                                    class="q-img__image absolute-full"
                                    :style="{
                                        backgroundSize: 'cover',
                                        backgroundPosition: '50% 50%',
                                        backgroundImage: `url('${getCoverUrl(work)}')`
                                    }"
                                >
                                    <img
                                        :src="getCoverUrl(work)"
                                        aria-hidden="true"
                                        class="absolute-full fit"
                                    >
                                </div>
                                <div class="q-img__content absolute-full">
                                    <div class="absolute-top-left transparent" style="padding: 0px;">
                                        <div class="q-chip row inline no-wrap items-center q-ma-sm bg-brown text-white q-chip--colored q-chip--dense q-chip--square q-chip--dark q-dark">
                                            <div class="q-chip__content col row no-wrap items-center q-anchor--skip">
                                                {{ getRjCode(work) }}
                                            </div>
                                        </div>
                                    </div>
                                    <div class="absolute-bottom-right" style="padding: 5px;">
                                        {{ getReleaseDate(work) }}
                                    </div>
                                </div>
                            </div>
                        </a>

                        <hr class="q-separator q-separator--horizontal q-separator--dark">

                        <div>
                            <div class="q-mx-sm text-h6 text-weight-regular ellipsis-2-lines">
                                <a
                                    :href="`/work/${getRjCode(work)}`"
                                    style="color: inherit;"
                                    :title="getTitle(work)"
                                >
                                    {{ getTitle(work) }}
                                </a>
                            </div>

                            <div class="q-ml-sm q-mb-xs text-subtitle1 text-weight-regular">
                                <div class="text-grey ellipsis">{{ getCircleName(work) }}</div>
                            </div>

                            <!-- Rating row -->
                            <div class="row items-center">
                                <div class="col-auto q-ml-sm">
                                    <div class="q-rating row inline items-center" style="font-size: 24px;">
                                        <div
                                            v-for="(star, idx) in getStars(getRating(work))"
                                            :key="idx"
                                            class="q-rating__icon-container flex flex-center"
                                        >
                                            <i :class="['q-icon notranslate material-icons q-rating__icon', star.color]">
                                                {{ star.icon }}
                                            </i>
                                        </div>
                                    </div>
                                </div>
                                <div class="col-auto">
                                    <span class="text-weight-medium text-body1 text-red">
                                        {{ getRating(work).toFixed(2) }}
                                    </span>
                                    <span class="text-grey">({{ getRatingCount(work) }})</span>
                                </div>
                                <div class="col-auto q-ml-xs">
                                    <i class="q-icon notranslate material-icons" style="font-size: 18px;">chat</i>
                                    <span class="text-grey">({{ work.review_count || 0 }})</span>
                                </div>
                                <div v-if="work.duration" class="col-auto q-ml-xs">
                                    <i class="q-icon text-white notranslate material-icons" style="font-size: 18px;">schedule</i>
                                    <span class="text-white">({{ formatDuration(work.duration) }})</span>
                                </div>
                                <div class="col-auto q-ml-xs">
                                    <i class="q-icon notranslate material-icons" style="font-size: 18px;">launch</i>
                                    <a
                                        :href="`https://www.dlsite.com/maniax/work/=/product_id/${getRjCode(work)}.html`"
                                        rel="noreferrer noopener"
                                        target="_blank"
                                        class="text-blue"
                                    >DLsite</a>
                                </div>
                            </div>

                            <!-- Price / Sales -->
                            <div>
                                <span class="q-mx-sm text-weight-medium text-h6 text-red">
                                    {{ work.price || 0 }} JPY
                                </span>
                                <span>{{ format('infScrollSales', { count: work.dl_count || work.sales || 0 }) }}</span>
                                <div
                                    v-if="isAllAges(work)"
                                    class="q-chip row inline no-wrap items-center q-py-sm q-chip--dense q-chip--outline q-chip--square q-chip--dark q-dark text-green"
                                    style="font-size: 10px; margin-top: 0px;"
                                >
                                    <div class="q-chip__content col row no-wrap items-center q-anchor--skip">
                                        {{ t('infScrollAllAges') }}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>

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
        <div v-if="sentinelState === 'rate-limit'" class="text-center q-pa-md text-warning">
            <i class="q-icon notranslate material-icons" style="font-size: 24px;">hourglass_empty</i>
            <div>{{ format('infScrollRateLimitRetry', { seconds: retryCountdownSeconds }) }}</div>
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

.infinite-scroll-fallback-grid {
    width: 100%;
}
</style>
