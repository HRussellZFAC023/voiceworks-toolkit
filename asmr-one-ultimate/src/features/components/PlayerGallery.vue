<script setup lang="ts">
/**
 * PlayerGallery.vue - Image slideshow for the audio player.
 *
 * In normal mode: shows prev/next arrows on albumart hover when 2+ images.
 * In fullscreen mode: shows full gallery with large image, nav arrows, counter.
 * Auto-slideshow: cycles images every N seconds in fullscreen (configurable).
 *
 * Image sources (priority):
 *   1. Cover art from the existing q-img background-image (always available)
 *   2. DLsite sample images from WorkMetadata gallery
 *   3. Work tree images from the tracks API
 */

import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { useBridge } from '../../composables/useBridge';
import { useI18n } from '../../composables/useI18n';
import { useEventBus } from '../../composables/useEventBus';
import { useConfig } from '../../composables/useConfig';
import { AppStore } from '../../store/AppStore';
import { WorkService } from '../../services/WorkService';
import { MediaViewerController } from '../MediaViewerController';
import { Logger } from '../../core/Utils';
import type { AudioTrack, TrackFolder, TrackItem } from '../../types/api';
import { normalizeWorkId, parseWorkIdFromCoverUrl } from '../playerGalleryUtils';

const IMG_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg']);

// -- Composables --
const bridge = useBridge();
const { t } = useI18n();
const { on } = useEventBus();
const galleryAutoSlideshow = useConfig('galleryAutoSlideshow');
const galleryAutoSlideshowInterval = useConfig('galleryAutoSlideshowInterval');

// -- Reactive state --
const images = ref<string[]>([]);
const currentIndex = ref(0);
const isFullscreen = ref(false);
const touchStartX = ref(0);
const loadedWorkId = ref<string | null>(null);
const loadSeq = ref(0);
const slideshowPaused = ref(false);
const imageLoaded = ref(true);
const imageSeen = ref(new Set<string>());
const excludedUrls = ref(new Set<string>());

// Slideshow timer (non-reactive, just a handle)
let slideshowTimer: ReturnType<typeof setInterval> | null = null;
// MutationObserver for late-arriving DLsite gallery images
let galleryObserver: MutationObserver | null = null;
// Timers used to re-check gallery state across async host renders
let refreshRetryTimers: Array<ReturnType<typeof setTimeout>> = [];

// -- Computed --
const imageCount = computed(() => images.value.length);
const hasMultipleImages = computed(() => imageCount.value >= 2);
const showNav = computed(() => hasMultipleImages.value);
const showCounter = computed(() => hasMultipleImages.value);
const counterText = computed(() =>
    hasMultipleImages.value ? `${currentIndex.value + 1} / ${imageCount.value}` : ''
);
const currentImageUrl = computed(() => images.value[currentIndex.value] || '');
const showImage = computed(() => currentImageUrl.value !== '');

// -- Image load state --

watch(currentImageUrl, () => {
    imageLoaded.value = false;
});

function onImageLoad(): void {
    imageLoaded.value = true;
}

// -- Slideshow --

function startSlideshow(): void {
    stopSlideshow();
    if (!isFullscreen.value) return;
    if (slideshowPaused.value) return;
    if (images.value.length < 2) return;
    if (!galleryAutoSlideshow.value) return;

    const interval = Math.max(2, Number(galleryAutoSlideshowInterval.value) || 6);
    slideshowTimer = setInterval(() => {
        if (!isFullscreen.value || images.value.length < 2) {
            stopSlideshow();
            return;
        }
        currentIndex.value = (currentIndex.value + 1) % images.value.length;
        syncCoverUrl();
    }, interval * 1000);
    Logger.debug('[PlayerGallery] Slideshow started, interval=', interval, 's');
}

function stopSlideshow(): void {
    if (slideshowTimer !== null) {
        clearInterval(slideshowTimer);
        slideshowTimer = null;
        Logger.debug('[PlayerGallery] Slideshow stopped');
    }
}

function syncSlideshow(): void {
    if (isFullscreen.value && !slideshowPaused.value && images.value.length >= 2) {
        startSlideshow();
    } else {
        stopSlideshow();
    }
}

function pauseSlideshow(): void {
    if (slideshowTimer !== null || !slideshowPaused.value) {
        slideshowPaused.value = true;
        stopSlideshow();
        Logger.debug('[PlayerGallery] Slideshow paused by user navigation');
    }
}

// -- Slideshow toggle --

const showSlideshowToggle = computed(() =>
    isFullscreen.value && hasMultipleImages.value && galleryAutoSlideshow.value
);
const slideshowIcon = computed(() => slideshowPaused.value ? 'play_arrow' : 'pause');
const slideshowToggleLabel = computed(() =>
    t(slideshowPaused.value ? 'gallerySlideshowResume' : 'gallerySlideshowPause')
);

function toggleSlideshow(e: Event): void {
    e.preventDefault();
    e.stopPropagation();
    if (slideshowPaused.value) {
        slideshowPaused.value = false;
        startSlideshow();
    } else {
        pauseSlideshow();
    }
}

// -- Exclude --

const showExclude = computed(() => hasMultipleImages.value);

function excludeCurrentImage(): void {
    if (images.value.length < 2) return;
    const url = images.value[currentIndex.value];
    if (!url) return;

    excludedUrls.value.add(url);
    images.value.splice(currentIndex.value, 1);

    // Wrap index if we removed the last item
    if (currentIndex.value >= images.value.length) {
        currentIndex.value = 0;
    }

    syncCoverUrl();
    syncAlbumart();

    // Stop slideshow if <2 images remain
    if (images.value.length < 2) {
        stopSlideshow();
    }

    Logger.debug('[PlayerGallery] Excluded image, remaining:', images.value.length);
}

function onExclude(e: Event): void {
    e.preventDefault();
    e.stopPropagation();
    excludeCurrentImage();
}

// -- Navigation --

function navigate(dir: number): void {
    if (images.value.length < 2) return;
    pauseSlideshow();
    currentIndex.value = (currentIndex.value + dir + images.value.length) % images.value.length;
    syncCoverUrl();
}

function onPrev(e: Event): void {
    e.preventDefault();
    e.stopPropagation();
    navigate(-1);
}

function onNext(e: Event): void {
    e.preventDefault();
    e.stopPropagation();
    navigate(1);
}

// -- Keyboard --

/** Handle gallery navigation from KeyboardManager via EventBus */
function onGalleryNav(payload: { direction: -1 | 1 }): void {
    if (!isFullscreen.value || images.value.length < 2) return;
    navigate(payload.direction);
}

/** Handle gallery exclude from KeyboardManager via EventBus */
function onGalleryExclude(): void {
    if (!isFullscreen.value) return;
    excludeCurrentImage();
}

// -- Touch swipe --

function onTouchStart(e: TouchEvent): void {
    if (!isFullscreen.value || e.touches.length !== 1) return;
    touchStartX.value = e.touches[0].clientX;
}

function onTouchEnd(e: TouchEvent): void {
    if (!isFullscreen.value || !e.changedTouches.length) return;
    const dx = e.changedTouches[0].clientX - touchStartX.value;
    if (Math.abs(dx) > 50) navigate(dx < 0 ? 1 : -1);
}

// -- Lightbox --

function onAlbumartClick(e: MouseEvent): void {
    if (!isFullscreen.value || !images.value.length) return;
    if ((e.target as HTMLElement).closest('.asmr-gallery-nav')) return;
    openLightbox();
}

function openLightbox(): void {
    pauseSlideshow();
    try {
        MediaViewerController.getInstance().showExternalImages(images.value, currentIndex.value);
    } catch {
        window.open(images.value[currentIndex.value], '_blank');
    }
}

// -- Cover URL sync (update blurred backdrop on host) --

function syncCoverUrl(): void {
    const url = currentImageUrl.value;
    if (!url) return;
    const player = document.querySelector('.audio-player') as HTMLElement;
    if (player) player.style.setProperty('--cover-url', `url("${url}")`);
}

// -- Sync albumart data attribute for CSS hiding rules --

function syncAlbumart(): void {
    const albumart = document.querySelector('.audio-player .albumart') as HTMLElement;
    if (albumart) {
        albumart.setAttribute('data-gallery-count', String(images.value.length));
        // Ensure positioning context for absolutely positioned children
        if (getComputedStyle(albumart).position === 'static') {
            albumart.style.position = 'relative';
        }
    }
}

// -- URL detection helpers --

function scrapeCoverUrl(): string {
    // 1. q-img background-image (always rendered by Kikoeru)
    const qimg = document.querySelector('.audio-player .albumart .q-img__image') as HTMLElement;
    if (qimg) {
        const bg = qimg.style.backgroundImage;
        const m = bg.match(/url\(["']?([^"')]+)["']?\)/);
        if (m?.[1]) return m[1];
    }

    // 2. --cover-url CSS variable on .audio-player
    const player = document.querySelector('.audio-player') as HTMLElement;
    if (player) {
        const style = player.getAttribute('style') || '';
        const m = style.match(/--cover-url:\s*url\(["']?([^"')]+)["']?\)/);
        if (m?.[1]) return m[1];
    }

    // 3. AppStore
    try {
        const work = AppStore.currentWork;
        if (work?.mainCoverUrl) return work.mainCoverUrl;
    } catch { /* host store may not be ready */ }

    return '';
}

function detectWorkId(): string | null {
    // 1. Vuex store
    try {
        const id = AppStore.currentWork?.id;
        const normalized = normalizeWorkId(id);
        if (normalized) return normalized;
    } catch { /* host store may not be ready */ }

    // 2. Cover URL (supports numeric and RJ-prefixed IDs)
    const cover = scrapeCoverUrl();
    const fromCover = parseWorkIdFromCoverUrl(cover);
    if (fromCover) return fromCover;

    // 3. URL path
    const pathMatch = location.pathname.match(/\/work\/(?:RJ)?(\d+)/i);
    if (pathMatch) return normalizeWorkId(pathMatch[1]);

    return null;
}

// -- DLsite gallery scraping --

function scrapeDlsiteGallery(add: (url: string) => void): void {
    const imgs = document.querySelectorAll('.asmr-meta-gallery img');
    for (const el of imgs) {
        const src = (el as HTMLImageElement).src;
        if (src) add(src);
    }
}

function observeDlsiteGallery(): void {
    disconnectGalleryObserver();
    const gallery = document.querySelector('.asmr-meta-gallery');
    if (!gallery) {
        // Gallery element doesn't exist yet -- watch for it to appear
        const bodyObs = new MutationObserver(() => {
            const g = document.querySelector('.asmr-meta-gallery');
            if (g) {
                bodyObs.disconnect();
                attachGalleryObserver(g);
            }
        });
        bodyObs.observe(document.body, { childList: true, subtree: true });
        galleryObserver = bodyObs;
        return;
    }
    attachGalleryObserver(gallery);
}

function attachGalleryObserver(gallery: Element): void {
    disconnectGalleryObserver();
    const obs = new MutationObserver(() => {
        let added = false;
        const imgs = gallery.querySelectorAll('img');
        for (const el of imgs) {
            const src = (el as HTMLImageElement).src;
            if (src && !imageSeen.value.has(src) && !excludedUrls.value.has(src)) {
                imageSeen.value.add(src);
                images.value.push(src);
                added = true;
            }
        }
        if (added) {
            syncAlbumart();
            // If slideshow wasn't started because <2 images, try again
            if (isFullscreen.value && !slideshowPaused.value && slideshowTimer === null && images.value.length >= 2) {
                startSlideshow();
            }
            Logger.debug('[PlayerGallery] DLsite gallery updated, total images:', images.value.length);
        }
    });
    obs.observe(gallery, { childList: true, subtree: true });
    galleryObserver = obs;
}

function disconnectGalleryObserver(): void {
    if (galleryObserver) {
        galleryObserver.disconnect();
        galleryObserver = null;
    }
}

// -- Image collection --

function isImageItem(item: TrackItem | AudioTrack): boolean {
    if (item.type === 'image') return true;
    if (item.title) {
        const name = item.title.replace(/\s*\(.*?\)\s*$/, '');
        const dot = name.lastIndexOf('.');
        return dot >= 0 && IMG_EXTS.has(name.slice(dot).toLowerCase());
    }
    return false;
}

function buildUrl(item: TrackItem | AudioTrack, token: string): string {
    const withToken = (url: string): string => {
        if (url.startsWith('http') || url.startsWith('//')) return url;
        if (url.startsWith('/api/') && token) {
            return `${url}${url.includes('?') ? '&' : '?'}token=${token}`;
        }
        return url;
    };
    if (item.mediaStreamUrl) return withToken(item.mediaStreamUrl);
    if ('media_stream_url' in item && item.media_stream_url) return withToken(item.media_stream_url);
    if (item.hash) return withToken(`/api/media/stream/${item.hash}`);
    return '';
}

function flattenTracks(nodes: (TrackFolder | TrackItem)[]): TrackItem[] {
    const out: TrackItem[] = [];
    const walk = (items: (TrackFolder | TrackItem)[]) => {
        if (!Array.isArray(items)) return;
        for (const n of items) {
            if (n.type === 'folder') walk((n as TrackFolder).children || []);
            else out.push(n as TrackItem);
        }
    };
    walk(nodes);
    return out;
}

function extractImageUrls(items: (TrackItem | TrackFolder)[], add: (url: string) => void): void {
    const token = localStorage.getItem('jwt-token') || '';
    for (const item of items) {
        if (item.type === 'folder') continue;
        if (!isImageItem(item)) continue;
        const url = buildUrl(item, token);
        if (url) add(url);
    }
}

async function loadImages(workId: string): Promise<void> {
    const normalizedWorkId = normalizeWorkId(workId);
    if (!normalizedWorkId) return;
    const seq = ++loadSeq.value;
    loadedWorkId.value = normalizedWorkId;

    // Clear previous work's images
    images.value = [];
    currentIndex.value = 0;
    imageSeen.value.clear();

    // Clear stale cover backdrop immediately (DOM still shows previous work's cover)
    const playerEl = document.querySelector('.audio-player') as HTMLElement;
    if (playerEl) playerEl.style.removeProperty('--cover-url');

    const add = (url: string) => {
        if (!url || imageSeen.value.has(url) || excludedUrls.value.has(url)) return;
        imageSeen.value.add(url);
        images.value.push(url);
    };

    // Scrape cover from DOM, but validate it belongs to this work
    // (the host q-img may still show the previous work's cover during transitions)
    const cover = scrapeCoverUrl();
    if (cover) {
        const coverWorkId = parseWorkIdFromCoverUrl(cover);
        if (!coverWorkId || coverWorkId === normalizedWorkId) {
            add(cover);
        }
    }

    // Show cover immediately if in fullscreen (don't wait for async)
    if (isFullscreen.value && images.value.length > 0) {
        syncCoverUrl();
        syncAlbumart();
    }

    // Scrape DLsite sample images from WorkMetadata gallery
    scrapeDlsiteGallery(add);

    // Start observing for late-arriving DLsite gallery images
    observeDlsiteGallery();

    // Try Vue work tree component
    try {
        if (seq !== loadSeq.value) return;
        const wt = bridge.findWorkTreeComponent();
        if (wt) {
            const folder = wt.fatherFolder || wt.$data?.fatherFolder || [];
            if (Array.isArray(folder)) extractImageUrls(folder, add);
            const tree = wt.tree || wt.$data?.tree;
            if (Array.isArray(tree)) extractImageUrls(flattenTracks(tree), add);
        }
    } catch { /* ignore */ }

    // Fetch tracks API
    try {
        const tracks = await WorkService.getTracks(normalizedWorkId);
        if (seq !== loadSeq.value) return;
        if (Array.isArray(tracks)) {
            extractImageUrls(flattenTracks(tracks), add);
            Logger.debug('[PlayerGallery] Tracks loaded, total images:', images.value.length);
        }
    } catch (err) {
        Logger.debug('[PlayerGallery] Tracks fetch failed:', err);
    }

    if (seq !== loadSeq.value) return;
    syncAlbumart();
}

// -- Fullscreen events --

async function onEnterFullscreen(): Promise<void> {
    isFullscreen.value = true;
    Logger.debug('[PlayerGallery] fullscreen:enter');

    // Step 1: Immediately show the cover image (scraped from DOM)
    const coverUrl = scrapeCoverUrl();
    if (coverUrl && images.value.length === 0) {
        // Validate it belongs to the current work (DOM may still show previous work)
        const currentWork = detectWorkId();
        const coverWork = parseWorkIdFromCoverUrl(coverUrl);
        if (!coverWork || !currentWork || coverWork === currentWork) {
            images.value = [coverUrl];
            imageSeen.value.add(coverUrl);
            currentIndex.value = 0;
        }
    }
    if (images.value.length > 0) {
        syncCoverUrl();
    }

    // Step 2: Load more images from the tracks API
    const workId = detectWorkId();
    Logger.debug('[PlayerGallery] workId=', workId, 'cached=', loadedWorkId.value, 'images=', images.value.length);

    if (workId && workId !== loadedWorkId.value) {
        await loadImages(workId);
        if (isFullscreen.value) {
            syncCoverUrl();
        }
    } else {
        // Catch-up: DLsite gallery may have rendered after preload()
        scrapeDlsiteGallery((url) => {
            if (!url || imageSeen.value.has(url)) return;
            imageSeen.value.add(url);
            images.value.push(url);
        });
    }

    syncAlbumart();
    // Reset pause state on re-entering fullscreen
    slideshowPaused.value = false;
    startSlideshow();
}

function onExitFullscreen(): void {
    isFullscreen.value = false;
    stopSlideshow();
}

function onWorkChange(workId: string): void {
    // Reset slideshow state for the new work
    stopSlideshow();
    slideshowPaused.value = false;
    excludedUrls.value.clear();
    disconnectGalleryObserver();
    clearRefreshRetryTimers();

    const normalized = normalizeWorkId(workId);
    if (normalized && normalized !== loadedWorkId.value) {
        loadImages(normalized).then(() => {
            // After loading, start slideshow if in fullscreen
            if (isFullscreen.value && images.value.length >= 2) {
                startSlideshow();
            }
        });
        scheduleRefreshRetries(normalized);
    }
}

function clearRefreshRetryTimers(): void {
    for (const timer of refreshRetryTimers) {
        clearTimeout(timer);
    }
    refreshRetryTimers = [];
}

function scheduleRefreshRetries(workIdFromEvent?: string): void {
    clearRefreshRetryTimers();
    // Host player/work panels re-render asynchronously; retry a few times.
    for (const delay of [80, 220, 500]) {
        refreshRetryTimers.push(
            setTimeout(() => refreshGalleryForTrackChange(workIdFromEvent), delay)
        );
    }
}

function promoteCoverToFront(cover: string): void {
    const existingIndex = images.value.indexOf(cover);
    if (existingIndex > 0) {
        images.value.splice(existingIndex, 1);
    }

    if (existingIndex !== 0) {
        images.value.unshift(cover);
        imageSeen.value.add(cover);
        currentIndex.value = 0;
        syncCoverUrl();
        syncAlbumart();
    }
}

function refreshGalleryForTrackChange(workIdFromEvent?: string): void {
    const normalizedEventWorkId = normalizeWorkId(workIdFromEvent);
    const detectedWorkId = normalizedEventWorkId || detectWorkId();

    if (detectedWorkId && detectedWorkId !== loadedWorkId.value) {
        void loadImages(detectedWorkId);
        return;
    }

    const cover = scrapeCoverUrl();
    if (!cover) return;
    if (excludedUrls.value.has(cover)) return;

    // Validate cover belongs to the loaded work (DOM may lag behind store on work change)
    const coverWorkId = parseWorkIdFromCoverUrl(cover);
    if (coverWorkId && loadedWorkId.value && coverWorkId !== loadedWorkId.value) return;

    // Fallback for states where work ID isn't available yet (playlist/miniplayer transitions):
    // keep the full gallery but ensure the live cover is shown first.
    promoteCoverToFront(cover);
}

// -- Watchers --

// Re-evaluate slideshow when config changes
watch([galleryAutoSlideshow, galleryAutoSlideshowInterval], () => {
    syncSlideshow();
});

// Toggle class on albumart when gallery overlay is active (hides original q-img)
watch(showImage, (show) => {
    const albumart = document.querySelector('.audio-player .albumart') as HTMLElement;
    if (albumart) albumart.classList.toggle('asmr-gallery-active', show);
}, { immediate: true });

// -- Lifecycle --

// Reference to the parent albumart element for click/touch handlers
let albumartEl: HTMLElement | null = null;

onMounted(() => {
    // Gallery keyboard shortcuts are handled by KeyboardManager via EventBus
    on('gallery:nav', onGalleryNav);
    on('gallery:exclude', onGalleryExclude);

    // Register click/touch handlers on the parent albumart element
    albumartEl = document.querySelector('.audio-player .albumart') as HTMLElement;
    if (albumartEl) {
        albumartEl.addEventListener('click', onAlbumartClick);
        albumartEl.addEventListener('touchstart', onTouchStart, { passive: true });
        albumartEl.addEventListener('touchend', onTouchEnd, { passive: true });
    }

    // Subscribe to EventBus events
    on('fullscreen:enter', () => onEnterFullscreen());
    on('fullscreen:exit', () => onExitFullscreen());
    on('work:change', (p) => onWorkChange(p.workId));
    on('track:change', (p) => {
        // Let host UI/store settle across multiple ticks, then refresh.
        scheduleRefreshRetries(p.workId);
    });

    // Sync albumart on mount
    nextTick(() => syncAlbumart());

    // Detect currently playing work (we may have missed the work:change event
    // if the host app rendered .albumart before CentralObserver mounted us)
    const currentWorkId = detectWorkId();
    if (currentWorkId && currentWorkId !== loadedWorkId.value) {
        loadImages(currentWorkId);
    }

    Logger.log('[PlayerGallery] Mounted');
});

onUnmounted(() => {
    // Clean up albumart event listeners
    if (albumartEl) {
        albumartEl.removeEventListener('click', onAlbumartClick);
        albumartEl.removeEventListener('touchstart', onTouchStart);
        albumartEl.removeEventListener('touchend', onTouchEnd);
        albumartEl = null;
    }

    // Clean up gallery-active class to prevent stale state on remount
    const albumart = document.querySelector('.audio-player .albumart') as HTMLElement;
    if (albumart) albumart.classList.remove('asmr-gallery-active');

    stopSlideshow();
    clearRefreshRetryTimers();
    disconnectGalleryObserver();
    Logger.log('[PlayerGallery] Unmounted');
});
</script>

<template>
    <img
        v-show="showImage"
        class="asmr-gallery-img"
        :class="{ 'asmr-gallery-img--loaded': imageLoaded }"
        :src="currentImageUrl"
        draggable="false"
        referrerpolicy="no-referrer"
        alt=""
        @load="onImageLoad"
    />

    <button
        v-show="showNav"
        class="asmr-gallery-nav asmr-gallery-prev"
        :aria-label="t('galleryPrev')"
        :title="t('galleryPrev')"
        @click="onPrev"
    >
        <i class="material-icons" aria-hidden="true">chevron_left</i>
    </button>

    <button
        v-show="showNav"
        class="asmr-gallery-nav asmr-gallery-next"
        :aria-label="t('galleryNext')"
        :title="t('galleryNext')"
        @click="onNext"
    >
        <i class="material-icons" aria-hidden="true">chevron_right</i>
    </button>

    <span
        v-show="showCounter"
        class="asmr-gallery-counter"
    >
        {{ counterText }}
    </span>

    <button
        v-show="showSlideshowToggle"
        class="asmr-gallery-nav asmr-gallery-slideshow-toggle"
        :aria-label="slideshowToggleLabel"
        :title="slideshowToggleLabel"
        @click="toggleSlideshow"
    >
        <i class="material-icons" aria-hidden="true">{{ slideshowIcon }}</i>
    </button>

    <button
        v-show="showExclude"
        class="asmr-gallery-nav asmr-gallery-exclude"
        :aria-label="t('galleryExclude')"
        :title="t('galleryExclude')"
        @click="onExclude"
    >
        <i class="material-icons" aria-hidden="true">visibility_off</i>
    </button>
</template>

<style scoped>
/* Gallery image overlay (hidden by default, shown when navigating) */
.asmr-gallery-img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    z-index: 5;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.3s ease-in-out;
}

.asmr-gallery-img--loaded {
    opacity: 1;
}

/* Navigation arrows */
.asmr-gallery-nav {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    background: rgba(0, 0, 0, 0.2);
    backdrop-filter: blur(8px);
    border: 1px solid rgba(255, 255, 255, 0.1);
    color: #fff;
    cursor: pointer;
    padding: 0;
    opacity: 0;
    border-radius: 50%;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.asmr-gallery-prev {
    left: 8px;
}

.asmr-gallery-next {
    right: 8px;
}

.asmr-gallery-nav:hover {
    opacity: 1 !important;
    background: rgba(0, 0, 0, 0.4);
    transform: translateY(-50%) scale(1.1);
}

.asmr-gallery-nav:active {
    transform: translateY(-50%) scale(0.95);
}

.asmr-gallery-nav :deep(.material-icons) {
    font-size: 24px;
    color: #fff;
}

/* Slideshow pause/play toggle — top-right, next to exclude */
.asmr-gallery-slideshow-toggle {
    top: 8px !important;
    right: 74px;
    transform: none !important;
    width: 26px;
    height: 26px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.08);
    opacity: 0;
}

.asmr-gallery-slideshow-toggle :deep(.material-icons) {
    font-size: 16px;
    opacity: 0.5;
}

.asmr-gallery-slideshow-toggle:hover {
    background: rgba(255, 255, 255, 0.15);
    opacity: 1 !important;
    transform: scale(1.05) !important;
}

.asmr-gallery-slideshow-toggle:hover :deep(.material-icons) {
    opacity: 1;
}

.asmr-gallery-slideshow-toggle:active {
    transform: scale(0.95) !important;
}

/* Exclude (hide) button — subtle, top-right near fullscreen exit */
.asmr-gallery-exclude {
    top: 8px !important;
    right: 40px;
    transform: none !important;
    width: 26px;
    height: 26px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.08);
    opacity: 0;
}

.asmr-gallery-exclude :deep(.material-icons) {
    font-size: 16px;
    opacity: 0.5;
}

.asmr-gallery-exclude:hover {
    background: rgba(255, 255, 255, 0.15);
    opacity: 1 !important;
    transform: scale(1.05) !important;
}

.asmr-gallery-exclude:hover :deep(.material-icons) {
    opacity: 1;
}

.asmr-gallery-exclude:active {
    transform: scale(0.95) !important;
}

/* Image counter badge */
.asmr-gallery-counter {
    position: absolute;
    bottom: 8px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 10;
    font-size: 11px;
    font-weight: 500;
    color: rgba(255, 255, 255, 0.9);
    background: rgba(0, 0, 0, 0.3);
    backdrop-filter: blur(4px);
    padding: 2px 8px;
    border-radius: 10px;
    font-variant-numeric: tabular-nums;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.2s;
}

/* Parent hover: reveal nav arrows and counter when .albumart is hovered.
   Uses :global() for the parent selector since .albumart is outside this SFC. */
:global(.albumart):hover .asmr-gallery-nav {
    opacity: 0.8;
}

:global(.albumart):hover .asmr-gallery-counter {
    opacity: 1;
}

/* Mobile: always visible and slightly larger touch targets */
@media (max-width: 800px) {
    .asmr-gallery-nav {
        opacity: 0.7;
        width: 44px;
        height: 44px;
        background: rgba(0, 0, 0, 0.4);
    }

    .asmr-gallery-prev {
        left: 4px;
    }

    .asmr-gallery-next {
        right: 4px;
    }

    .asmr-gallery-counter {
        opacity: 0.8;
    }
}
</style>
