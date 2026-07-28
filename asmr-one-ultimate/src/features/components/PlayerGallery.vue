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
import { DEFAULT_DLSITE_PROXY } from '../../core/Constants';
import { gmRequest, retryWithBackoff } from '../../infrastructure/HttpClient';
import type { AudioTrack, TrackFolder, TrackItem } from '../../types/api';
import { normalizeWorkId, parseWorkIdFromCoverUrl, resolveGalleryWorkId } from '../playerGalleryUtils';
import {
    fetchVerifiedImageBlob,
    isSafeRasterImageBlob,
    normalizeImageUrl,
} from '../media/externalImageUtils';
import { readHostAuthToken } from '../../core/hostAuthToken';
import {
    buildMediaStreamUrl,
    resolveMediaApiBaseUrl,
} from '../media/mediaStreamUrlUtils';

const IMG_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg']);

// -- Composables --
const bridge = useBridge();
const { t } = useI18n();
const { on } = useEventBus();
const galleryAutoSlideshow = useConfig('galleryAutoSlideshow');
const galleryAutoSlideshowInterval = useConfig('galleryAutoSlideshowInterval');
const dlsiteProxyUrl = useConfig('dlsiteProxyUrl');

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
const verifiedBlobUrls = new Map<string, string>();
const verifiedDisplayUrls = ref(new Map<string, string>());
const verifiedFetches = new Map<string, Promise<string | null>>();
const imageFetchControllers = new Set<AbortController>();
let imageFetchGeneration = 0;
let imageSelectionGeneration = 0;
let componentMounted = false;

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
const currentSourceUrl = computed(() => images.value[currentIndex.value] || '');
const currentImageUrl = computed(() => {
    const source = currentSourceUrl.value;
    if (!source) return '';
    return verifiedDisplayUrls.value.get(source) || '';
});
const showImage = computed(() => currentImageUrl.value !== '');

// -- Image load state --

watch(currentImageUrl, () => {
    imageLoaded.value = false;
});

function onImageLoad(): void {
    imageLoaded.value = true;
}

function getImageProxyBaseUrl(): string {
    let raw = String(dlsiteProxyUrl.value || '').trim().replace(/\/+$/, '');
    if (!raw) return DEFAULT_DLSITE_PROXY;
    if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
    try {
        const parsed = new URL(raw);
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return raw;
    } catch {
        // Fall through to the maintained relay.
    }
    return DEFAULT_DLSITE_PROXY;
}

function storeVerifiedDisplayUrl(sourceUrl: string, displayUrl: string, seq: number): boolean {
    if (!componentMounted || seq !== loadSeq.value || !sourceUrl || !displayUrl) return false;
    if (excludedUrls.value.has(sourceUrl) || excludedUrls.value.has(displayUrl)) return false;
    if (verifiedDisplayUrls.value.get(sourceUrl) === displayUrl) return false;

    verifiedDisplayUrls.value.set(sourceUrl, displayUrl);
    verifiedDisplayUrls.value = new Map(verifiedDisplayUrls.value);
    syncAlbumart();
    return true;
}

async function resolveVerifiedImage(sourceUrl: string, seq = loadSeq.value): Promise<string | null> {
    if (!componentMounted) return null;
    const normalized = normalizeImageUrl(sourceUrl);
    if (!normalized || excludedUrls.value.has(normalized)) return null;
    if (normalized.startsWith('data:')) return null;

    const cached = verifiedBlobUrls.get(normalized);
    if (cached) {
        storeVerifiedDisplayUrl(normalized, cached, seq);
        return cached;
    }

    const existing = verifiedFetches.get(normalized);
    if (existing) {
        const displayUrl = await existing;
        if (displayUrl) storeVerifiedDisplayUrl(normalized, displayUrl, seq);
        return displayUrl;
    }

    const generation = imageFetchGeneration;
    const controller = new AbortController();
    imageFetchControllers.add(controller);

    const task = (async (): Promise<string | null> => {
        let blob: Blob | null = null;
        if (normalized.startsWith('blob:')) {
            const response = await fetch(normalized, { signal: controller.signal });
            if (!response.ok) return null;
            const candidate = await response.blob();
            if (await isSafeRasterImageBlob(candidate)) blob = candidate;
        } else {
            const verified = await fetchVerifiedImageBlob(normalized, {
                proxyBaseUrl: getImageProxyBaseUrl(),
                signal: controller.signal,
                headers: {
                    Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
                },
                dlsiteHeaders: {
                    Referer: 'https://www.dlsite.com/',
                    Origin: 'https://www.dlsite.com',
                },
                request: (config) => retryWithBackoff(
                    () => gmRequest(config),
                    { attempts: 2, backoffMs: 500, multiplier: 2 },
                ),
            });
            blob = verified?.blob || null;
        }
        if (!blob || generation !== imageFetchGeneration || controller.signal.aborted) return null;

        const blobUrl = URL.createObjectURL(blob);
        if (generation !== imageFetchGeneration || controller.signal.aborted) {
            URL.revokeObjectURL(blobUrl);
            return null;
        }
        verifiedBlobUrls.set(normalized, blobUrl);
        return blobUrl;
    })();

    verifiedFetches.set(normalized, task);
    try {
        const displayUrl = await task;
        if (displayUrl) storeVerifiedDisplayUrl(normalized, displayUrl, seq);
        return displayUrl;
    } finally {
        imageFetchControllers.delete(controller);
        if (verifiedFetches.get(normalized) === task) verifiedFetches.delete(normalized);
    }
}

function clearVerifiedImages(): void {
    imageFetchGeneration++;
    imageSelectionGeneration++;
    for (const controller of imageFetchControllers) controller.abort();
    imageFetchControllers.clear();
    verifiedFetches.clear();
    verifiedBlobUrls.forEach((url) => {
        try { URL.revokeObjectURL(url); } catch { /* already revoked */ }
    });
    verifiedBlobUrls.clear();
    verifiedDisplayUrls.value = new Map();
}

function cancelPendingImageVerification(): void {
    imageFetchGeneration++;
    for (const controller of imageFetchControllers) controller.abort();
    imageFetchControllers.clear();
    verifiedFetches.clear();
}

function addImageSource(url: string): boolean {
    if (!componentMounted) return false;
    const normalized = normalizeImageUrl(url);
    if (!normalized || imageSeen.value.has(normalized) || excludedUrls.value.has(normalized)) return false;
    imageSeen.value.add(normalized);
    images.value.push(normalized);
    syncAlbumart();
    return true;
}

async function verifySelectedImage(cancelPending = true): Promise<void> {
    if (!componentMounted) return;
    const seq = loadSeq.value;
    const selection = ++imageSelectionGeneration;
    if (cancelPending) cancelPendingImageVerification();

    let attempts = 0;
    while (
        seq === loadSeq.value
        && componentMounted
        && selection === imageSelectionGeneration
        && images.value.length > 0
        && attempts < 2
    ) {
        attempts++;
        if (currentIndex.value >= images.value.length) currentIndex.value = 0;
        const source = images.value[currentIndex.value];
        const displayUrl = await resolveVerifiedImage(source, seq);
        if (seq !== loadSeq.value || selection !== imageSelectionGeneration) return;
        if (displayUrl) {
            syncCoverUrl();
            syncAlbumart();
            return;
        }

        // The URL resolved only to a restriction/invalid payload. Remove it
        // from the navigable inventory and try the next source lazily.
        images.value.splice(currentIndex.value, 1);
        excludedUrls.value.add(source);

        // Keep the player visually stable when an upstream host image is
        // restricted. Prefer a source already verified for this work (usually
        // the cover or a DLsite sample) instead of briefly exposing an empty or
        // placeholder slide while other unverified host items remain.
        const knownGoodIndex = images.value.findIndex(candidate =>
            verifiedDisplayUrls.value.has(candidate)
        );
        if (knownGoodIndex >= 0) {
            currentIndex.value = knownGoodIndex;
            syncCoverUrl();
            syncAlbumart();
            return;
        }
    }

    syncAlbumart();
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
        void verifySelectedImage();
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

    void verifySelectedImage();
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
    void verifySelectedImage();
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
    if (!images.value.length) return;
    pauseSlideshow();
    const sourceUrls = [...images.value];
    try {
        MediaViewerController.getInstance().showExternalImages(sourceUrls, currentIndex.value);
    } catch {
        const verifiedUrl = currentImageUrl.value;
        if (verifiedUrl) window.open(verifiedUrl, '_blank', 'noopener,noreferrer');
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
    if (!componentMounted) return;
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
    if (!componentMounted) return;
    disconnectGalleryObserver();
    const gallery = document.querySelector('.asmr-meta-gallery');
    if (!gallery) {
        // Gallery element doesn't exist yet -- watch for it to appear
        const bodyObs = new MutationObserver(() => {
            if (!componentMounted) return;
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
    if (!componentMounted) return;
    disconnectGalleryObserver();
    const obs = new MutationObserver(() => {
        if (!componentMounted) return;
        const wasEmpty = images.value.length === 0;
        let added = false;
        const imgs = gallery.querySelectorAll('img');
        for (const el of imgs) {
            added = addImageSource((el as HTMLImageElement).src) || added;
        }
        if (added) {
            if (wasEmpty) void verifySelectedImage();
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
    const apiBaseUrl = resolveMediaApiBaseUrl(bridge.axios?.defaults?.baseURL);
    return buildMediaStreamUrl(item.hash || '', item, token, apiBaseUrl);
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
    const token = readHostAuthToken();
    for (const item of items) {
        if (item.type === 'folder') continue;
        if (!isImageItem(item)) continue;
        const url = buildUrl(item, token);
        if (url) add(url);
    }
}

async function loadImages(workId: string): Promise<void> {
    if (!componentMounted) return;
    const normalizedWorkId = normalizeWorkId(workId);
    if (!normalizedWorkId) return;
    const seq = ++loadSeq.value;
    loadedWorkId.value = normalizedWorkId;
    clearVerifiedImages();

    // Clear previous work's images
    images.value = [];
    currentIndex.value = 0;
    imageSeen.value.clear();

    // Clear stale cover backdrop immediately (DOM still shows previous work's cover)
    const playerEl = document.querySelector('.audio-player') as HTMLElement;
    if (playerEl) playerEl.style.removeProperty('--cover-url');

    const add = (url: string) => {
        addImageSource(url);
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

    // Verify only the currently selected source. The remaining inventory is
    // kept as URLs and fetched lazily on navigation, avoiding a multi-megabyte
    // GET for every gallery item during initial player load.
    if (images.value.length > 0) void verifySelectedImage();

    // Try Vue work tree component
    try {
        if (!componentMounted || seq !== loadSeq.value) return;
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
        if (!componentMounted || seq !== loadSeq.value) return;
        if (Array.isArray(tracks)) {
            extractImageUrls(flattenTracks(tracks), add);
            Logger.debug('[PlayerGallery] Tracks loaded, total images:', images.value.length);
        }
    } catch (err) {
        Logger.debug('[PlayerGallery] Tracks fetch failed:', err);
    }

    if (!componentMounted || seq !== loadSeq.value) return;
    syncAlbumart();
    if (!currentImageUrl.value && verifiedFetches.size === 0) void verifySelectedImage();
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
            if (addImageSource(coverUrl)) {
                await verifySelectedImage();
                currentIndex.value = 0;
            }
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
            addImageSource(url);
        });
        if (!currentImageUrl.value && images.value.length > 0) {
            await verifySelectedImage();
        }
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
    if (!componentMounted) return;
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
    if (!componentMounted) return;
    clearRefreshRetryTimers();
    // Host player/work panels re-render asynchronously; retry a few times.
    for (const delay of [80, 220, 500]) {
        refreshRetryTimers.push(
            setTimeout(() => refreshGalleryForTrackChange(workIdFromEvent), delay)
        );
    }
}

function promoteCoverToFront(cover: string): void {
    const normalized = normalizeImageUrl(cover);
    if (!normalized || excludedUrls.value.has(normalized)) return;
    const existingIndex = images.value.indexOf(normalized);
    if (existingIndex > 0) {
        images.value.splice(existingIndex, 1);
    }

    if (existingIndex !== 0) {
        images.value.unshift(normalized);
        imageSeen.value.add(normalized);
        currentIndex.value = 0;
        void verifySelectedImage();
        syncAlbumart();
    }
}

function resetToCoverOnly(cover: string): void {
    const normalized = normalizeImageUrl(cover);
    if (!normalized) return;
    clearVerifiedImages();
    images.value = [];
    currentIndex.value = 0;
    imageSeen.value.clear();
    addImageSource(normalized);
    void verifySelectedImage();
}

function refreshGalleryForTrackChange(workIdFromEvent?: string): void {
    if (!componentMounted) return;
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

    // If we cannot resolve work ID but the live cover changed to an unseen URL,
    // assume a work transition and drop stale gallery images from the previous work.
    if (!detectedWorkId && !coverWorkId && loadedWorkId.value && !imageSeen.value.has(cover)) {
        Logger.debug('[PlayerGallery] Unknown work transition detected from cover update; resetting stale gallery');
        loadedWorkId.value = null;
        excludedUrls.value.clear();
        resetToCoverOnly(cover);
        return;
    }

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
    componentMounted = true;
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
        const resolvedWorkId = resolveGalleryWorkId(p.workId, p.track);
        // Let host UI/store settle across multiple ticks, then refresh.
        scheduleRefreshRetries(resolvedWorkId ?? undefined);
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
    componentMounted = false;
    loadSeq.value++;
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
    const player = document.querySelector('.audio-player') as HTMLElement | null;
    player?.style.removeProperty('--cover-url');

    stopSlideshow();
    clearRefreshRetryTimers();
    disconnectGalleryObserver();
    clearVerifiedImages();
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
        type="button"
        class="asmr-gallery-nav asmr-gallery-prev"
        :aria-label="t('galleryPrev')"
        :title="t('galleryPrev')"
        @click="onPrev"
    >
        <i class="material-icons" aria-hidden="true">chevron_left</i>
    </button>

    <button
        v-show="showNav"
        type="button"
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
        type="button"
        class="asmr-gallery-nav asmr-gallery-slideshow-toggle"
        :aria-label="slideshowToggleLabel"
        :title="slideshowToggleLabel"
        @click="toggleSlideshow"
    >
        <i class="material-icons" aria-hidden="true">{{ slideshowIcon }}</i>
    </button>

    <button
        v-show="showExclude"
        type="button"
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

/*
 * Keep artwork controls quiet until they are engaged. The button remains
 * transparent, while a low-contrast dark edge stays discoverable on pale
 * covers. Fade the glyph rather than the whole control so that edge survives.
 */
.asmr-gallery-nav {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    min-width: 44px;
    min-height: 44px;
    background: transparent;
    border: 1px solid rgba(17, 24, 39, 0.22);
    color: #fff;
    cursor: pointer;
    padding: 0;
    opacity: 1;
    border-radius: 50%;
    box-shadow: 0 1px 4px rgba(17, 24, 39, 0.3);
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
    background: rgba(17, 24, 39, 0.78);
    border-color: rgba(255, 255, 255, 0.72);
    transform: translateY(-50%) scale(1.1);
}

.asmr-gallery-nav:active {
    transform: translateY(-50%) scale(0.95);
}

.asmr-gallery-nav:focus-visible {
    opacity: 1 !important;
    background: rgba(17, 24, 39, 0.78);
    border-color: rgba(255, 255, 255, 0.72);
    outline: 3px solid #60a5fa;
    outline-offset: 2px;
    box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.85);
}

.asmr-gallery-nav :deep(.material-icons) {
    font-size: 24px;
    color: #fff;
    opacity: 0.46;
    -webkit-text-stroke: 0;
    filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.92));
    transition: opacity 0.2s ease;
}

.asmr-gallery-nav:hover :deep(.material-icons),
.asmr-gallery-nav:focus-visible :deep(.material-icons) {
    opacity: 1;
}

/* Slideshow pause/play toggle — top-right, next to exclude */
.asmr-gallery-slideshow-toggle {
    top: 8px !important;
    right: 108px;
    transform: none !important;
    width: 44px;
    height: 44px;
    min-width: 44px;
    min-height: 44px;
    background: transparent;
    border-color: rgba(17, 24, 39, 0.22);
}

.asmr-gallery-slideshow-toggle :deep(.material-icons) {
    font-size: 20px;
    opacity: 0.46;
}

.asmr-gallery-slideshow-toggle:hover,
.asmr-gallery-slideshow-toggle:focus-visible {
    /* Darker, not lighter: a translucent white hover state washed the white
       glyph out entirely over pale artwork. */
    background: rgba(17, 24, 39, 0.85);
    opacity: 1 !important;
    transform: scale(1.05) !important;
}

.asmr-gallery-slideshow-toggle:hover :deep(.material-icons),
.asmr-gallery-slideshow-toggle:focus-visible :deep(.material-icons) {
    opacity: 1;
}

.asmr-gallery-slideshow-toggle:active {
    transform: scale(0.95) !important;
}

/* Exclude (hide) button — subtle, top-right near fullscreen exit */
.asmr-gallery-exclude {
    top: 8px !important;
    right: 60px;
    transform: none !important;
    width: 44px;
    height: 44px;
    min-width: 44px;
    min-height: 44px;
    background: transparent;
    border-color: rgba(17, 24, 39, 0.22);
}

.asmr-gallery-exclude :deep(.material-icons) {
    font-size: 20px;
    opacity: 0.46;
}

.asmr-gallery-exclude:hover,
.asmr-gallery-exclude:focus-visible {
    background: rgba(17, 24, 39, 0.85);
    opacity: 1 !important;
    transform: scale(1.05) !important;
}

.asmr-gallery-exclude:hover :deep(.material-icons),
.asmr-gallery-exclude:focus-visible :deep(.material-icons) {
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
    background: rgba(17, 24, 39, 0.9);
    backdrop-filter: blur(4px);
    padding: 2px 8px;
    border-radius: 10px;
    font-variant-numeric: tabular-nums;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.2s;
}

/* Touch devices cannot hover, so retain a subdued but discoverable surface. */
@media (hover: none), (pointer: coarse) {
    .asmr-gallery-nav {
        opacity: 1;
        width: 44px;
        height: 44px;
        background: rgba(17, 24, 39, 0.12);
    }

    .asmr-gallery-nav :deep(.material-icons) {
        opacity: 0.68;
    }

    .asmr-gallery-prev {
        left: 4px;
    }

    .asmr-gallery-next {
        right: 4px;
    }

    .asmr-gallery-counter {
        opacity: 1;
    }
}
</style>
