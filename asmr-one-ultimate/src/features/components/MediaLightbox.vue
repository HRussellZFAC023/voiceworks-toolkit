<script setup lang="ts">
/**
 * MediaLightbox.vue - Vue 3 SFC for the media lightbox/modal overlay.
 *
 * Handles:
 * - Image, video, PDF, and text viewing
 * - Keyboard navigation (arrows, escape, zoom keys)
 * - Mouse wheel zoom with cursor-relative positioning
 * - Drag-to-pan when zoomed
 * - Touch swipe for mobile navigation
 * - Thumbnail strip with active indicator
 * - Fullscreen mode toggle
 * - Auto-slideshow for image galleries
 * - Auto-recovery for failed image loads
 * - PDF.js text extraction + side-by-side translation
 * - Title translation for CJK filenames
 */

import {
    ref,
    computed,
    watch,
    onMounted,
    onUnmounted,
    nextTick,
    type Ref,
} from 'vue';
import { useBridge } from '../../composables/useBridge';
import { useConfig } from '../../composables/useConfig';
import { DEFAULT_DLSITE_PROXY } from '../../core/Constants';
import { useI18n } from '../../composables/useI18n';
import { Logger, Config } from '../../core/Utils';
import { gmRequest, retryWithBackoff } from '../../infrastructure/HttpClient';
import { TranslationService } from '../../services/TranslationService';
import { isChinese } from '../../core/DomUtils';
import type { MediaFile, TouchState, DragState } from '../media/types';
import {
    getFileExtension,
    isImageExtension as isImage,
    isPdfExtension as isPdf,
    isTextExtension as isText,
    isVideoExtension as isVideo,
} from '../media/mediaFileUtils';
import { buildMediaStreamUrl } from '../media/mediaStreamUrlUtils';
import {
    fetchVerifiedImageBlob,
    isSafeRasterImageBlob,
    normalizeImageUrl,
} from '../media/externalImageUtils';

declare const unsafeWindow: Window & typeof globalThis;

// ── Constants ────────────────────────────────────────────────────────────────

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 5;
const ZOOM_STEP = 0.05;

const TRANSLATE_BATCH_MAX_CHARS = 0;
const TRANSLATE_TOTAL_MAX_CHARS = 0;
const PDF_TEXT_MAX_PAGES = Infinity;
// v3.11.174 is the last release with UMD .js builds (v4+ only ships .mjs ESM)
const PDFJS_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
const PDFJS_WORKER_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

/** Minimal pdf.js library shape */
interface PdfjsLib {
    GlobalWorkerOptions: { workerSrc: string };
    getDocument(params: { data: ArrayBuffer }): { promise: Promise<PdfjsDocument> };
}

interface PdfjsDocument {
    numPages: number;
    getPage(num: number): Promise<PdfjsPage>;
}

interface PdfjsPage {
    getTextContent(): Promise<{ items: Array<{ str?: string; hasEOL?: boolean }> }>;
}

// ── Props & Emits ────────────────────────────────────────────────────────────

const props = defineProps<{
    /** Whether the lightbox is visible */
    visible: boolean;
    /** Optional callback so controller can sync native player when video changes in lightbox */
    onVideoSelected?: (item: MediaFile) => void;
}>();

const emit = defineEmits<{
    (e: 'update:visible', value: boolean): void;
    (e: 'closed'): void;
}>();

// ── Composables ──────────────────────────────────────────────────────────────

const bridge = useBridge();
const { t, format, lang } = useI18n();
const translateMode = useConfig('translateMode');
const cnToJp = useConfig('translateCnToJp');
const galleryAutoSlideshow = useConfig('galleryAutoSlideshow');
const galleryAutoSlideshowInterval = useConfig('galleryAutoSlideshowInterval');
const dlsiteProxyUrl = useConfig('dlsiteProxyUrl');

// ── Reactive state ───────────────────────────────────────────────────────────

const isActive = ref(false);
const isFullscreen = ref(false);
const isLoading = ref(false);
const currentMediaIndex = ref(0);
const currentMediaList: Ref<MediaFile[]> = ref([]);
const currentMediaType: Ref<'image' | 'video' | 'pdf' | 'text'> = ref('image');
const zoomLevel = ref(1);
const errorMessage = ref('');
const errorIcon = ref('broken_image');

// Title state
const mediaTitle = ref('');
const translatedTitle = ref('');
const titleTranslationToken = ref(0);
let mediaRenderGeneration = 0;

// Media wrapper ref
const mediaWrapperRef = ref<HTMLElement | null>(null);
const thumbnailStripRef = ref<HTMLElement | null>(null);

// Internal state (non-reactive, used by event handlers)
let touchState: TouchState | null = null;
let dragState: DragState = {
    isDragging: false,
    didDrag: false,
    startX: 0,
    startY: 0,
    scrollLeft: 0,
    scrollTop: 0,
};
let preloadedImages = new Map<string, string>();
let externalBlobUrlCache = new Map<string, string>();
let externalBlobFetchInFlight = new Map<string, Promise<string | null>>();
const thumbnailBlobUrls = ref(new Map<string, string>());
let imageFetchControllers = new Set<AbortController>();
let imageFetchGeneration = 0;
let slideshowTimer: ReturnType<typeof setInterval> | null = null;
let slideshowPaused = false;
let recoveryTimeout: number | undefined;
let pdfjsLoadPromise: Promise<unknown> | null = null;
let activeRequestId = 0;

// ── Computed ─────────────────────────────────────────────────────────────────

const hasMultipleMedia = computed(() => currentMediaList.value.length > 1);
const isPrevDisabled = computed(() => currentMediaIndex.value <= 0);
const isNextDisabled = computed(() => currentMediaIndex.value >= currentMediaList.value.length - 1);
const isZoomOutDisabled = computed(() => zoomLevel.value <= ZOOM_MIN);
const isZoomInDisabled = computed(() => zoomLevel.value >= ZOOM_MAX);
const showZoomControls = computed(() => currentMediaType.value === 'image');
const zoomPercent = computed(() => `${Math.round(zoomLevel.value * 100)}%`);
const zoomSliderValue = computed(() => Math.round(zoomLevel.value * 100));
const currentPosition = computed(() => currentMediaList.value.length > 0 ? currentMediaIndex.value + 1 : 0);
const totalCount = computed(() => currentMediaList.value.length);
const hasTitleTranslation = computed(() => !!translatedTitle.value && translatedTitle.value !== mediaTitle.value);
const currentItem = computed(() => currentMediaList.value[currentMediaIndex.value] || null);

// ── File type utilities ──────────────────────────────────────────────────────

// ── URL utility ──────────────────────────────────────────────────────────────

function getMediaUrl(hash: string, item?: MediaFile): string {
    const token = localStorage.getItem('jwt-token') || '';
    const url = buildMediaStreamUrl(hash, item, token);
    if (url.startsWith('http') || url.startsWith('//') || url.startsWith('blob:')) {
        return normalizeExternalUrl(url);
    }
    return url;
}

function normalizeExternalUrl(url: string): string {
    return normalizeImageUrl(url);
}

function getProxyBaseUrl(): string {
    let raw = String(dlsiteProxyUrl.value || '').trim().replace(/\/+$/, '');
    if (!raw) return DEFAULT_DLSITE_PROXY;
    if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
    try {
        const parsed = new URL(raw);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return DEFAULT_DLSITE_PROXY;
    } catch {
        return DEFAULT_DLSITE_PROXY;
    }
    return raw;
}

async function fetchExternalBlobUrl(url: string): Promise<string | null> {
    const normalized = normalizeExternalUrl(url);
    if (!normalized) return null;
    if (normalized.startsWith('data:')) return null;

    const cached = externalBlobUrlCache.get(normalized);
    if (cached) return cached;

    const inFlight = externalBlobFetchInFlight.get(normalized);
    if (inFlight) return inFlight;

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
                proxyBaseUrl: getProxyBaseUrl(),
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
                    { attempts: 2, backoffMs: 600, multiplier: 2 },
                ),
            });
            blob = verified?.blob || null;
        }
        if (!blob || controller.signal.aborted || generation !== imageFetchGeneration) return null;

        const blobUrl = URL.createObjectURL(blob);
        if (controller.signal.aborted || generation !== imageFetchGeneration) {
            URL.revokeObjectURL(blobUrl);
            return null;
        }

        const prev = externalBlobUrlCache.get(normalized);
        if (prev) {
            try { URL.revokeObjectURL(prev); } catch { /* ignore */ }
        }
        externalBlobUrlCache.set(normalized, blobUrl);
        return blobUrl;
    })();

    externalBlobFetchInFlight.set(normalized, task);
    try {
        return await task;
    } finally {
        imageFetchControllers.delete(controller);
        if (externalBlobFetchInFlight.get(normalized) === task) {
            externalBlobFetchInFlight.delete(normalized);
        }
    }
}

function getThumbnailUrl(item: MediaFile): string {
    return thumbnailBlobUrls.value.get(item.hash) || '';
}

function onThumbnailError(item: MediaFile, event: Event): void {
    const target = event.target as HTMLImageElement | null;
    if (!target) return;
    thumbnailBlobUrls.value.delete(item.hash);
    thumbnailBlobUrls.value = new Map(thumbnailBlobUrls.value);
    target.removeAttribute('src');
}

function clearExternalBlobCache(): void {
    imageFetchGeneration++;
    for (const controller of imageFetchControllers) controller.abort();
    imageFetchControllers.clear();
    externalBlobUrlCache.forEach((blobUrl) => {
        try {
            URL.revokeObjectURL(blobUrl);
        } catch {
            // Ignore invalid/revoked object URLs
        }
    });
    externalBlobUrlCache.clear();
    externalBlobFetchInFlight.clear();
    thumbnailBlobUrls.value = new Map();
    preloadedImages.clear();
}

async function fetchMediaImageBlobUrl(item: MediaFile, primaryUrl?: string): Promise<string | null> {
    const candidates = [
        primaryUrl || getMediaUrl(item.hash, item),
        item.mediaStreamUrl,
        item.media_stream_url,
        item.mediaDownloadUrl,
        item.media_download_url,
    ]
        .map((value) => normalizeExternalUrl(String(value || '')))
        .filter((value, index, all) => !!value && all.indexOf(value) === index);

    for (const candidate of candidates) {
        const resolved = await fetchExternalBlobUrl(candidate);
        if (resolved) return resolved;
    }
    return null;
}

function getThumbnailIcon(type: 'image' | 'video' | 'pdf' | 'text'): string {
    switch (type) {
        case 'video': return 'videocam';
        case 'pdf': return 'picture_as_pdf';
        case 'text': return 'description';
        default: return 'image';
    }
}

// ── Zoom ─────────────────────────────────────────────────────────────────────

function setZoom(level: number, autoCenter = true): void {
    zoomLevel.value = Math.round(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level)) * 100) / 100;

    const wrapper = mediaWrapperRef.value;
    const img = wrapper?.querySelector('.media-viewer-image') as HTMLImageElement;

    if (img && wrapper) {
        const isZoomed = zoomLevel.value !== 1;
        const wasZoomed = wrapper.classList.contains('zoomed');

        let scrollXPercent = 0.5;
        let scrollYPercent = 0.5;
        if (autoCenter && wasZoomed && wrapper.scrollWidth > wrapper.clientWidth) {
            scrollXPercent = (wrapper.scrollLeft + wrapper.clientWidth / 2) / wrapper.scrollWidth;
        }
        if (autoCenter && wasZoomed && wrapper.scrollHeight > wrapper.clientHeight) {
            scrollYPercent = (wrapper.scrollTop + wrapper.clientHeight / 2) / wrapper.scrollHeight;
        }

        if (img.naturalWidth && img.naturalHeight) {
            if (zoomLevel.value === 1) {
                img.style.width = '';
                img.style.height = '';
                img.style.maxWidth = '100%';
                img.style.maxHeight = '100%';
                wrapper.classList.remove('zoomed');
            } else {
                const containerWidth = wrapper.clientWidth;
                const containerHeight = wrapper.clientHeight;
                const aspectRatio = img.naturalWidth / img.naturalHeight;
                let fittedWidth: number;
                let fittedHeight: number;

                if (containerWidth / containerHeight > aspectRatio) {
                    fittedHeight = containerHeight;
                    fittedWidth = containerHeight * aspectRatio;
                } else {
                    fittedWidth = containerWidth;
                    fittedHeight = containerWidth / aspectRatio;
                }

                img.style.width = `${fittedWidth * zoomLevel.value}px`;
                img.style.height = `${fittedHeight * zoomLevel.value}px`;
                img.style.maxWidth = 'none';
                img.style.maxHeight = 'none';
                wrapper.classList.add('zoomed');
            }
        }

        img.style.cursor = isZoomed ? 'grab' : 'default';

        if (autoCenter) {
            if (zoomLevel.value === 1) {
                wrapper.scrollLeft = 0;
                wrapper.scrollTop = 0;
            } else {
                requestAnimationFrame(() => {
                    wrapper.scrollLeft = Math.max(0, (scrollXPercent * wrapper.scrollWidth) - (wrapper.clientWidth / 2));
                    wrapper.scrollTop = Math.max(0, (scrollYPercent * wrapper.scrollHeight) - (wrapper.clientHeight / 2));
                });
            }
        }
    }
}

function zoomIn(): void {
    if (currentMediaType.value !== 'image') return;
    setZoom(Math.min(ZOOM_MAX, zoomLevel.value + ZOOM_STEP));
}

function zoomOut(): void {
    if (currentMediaType.value !== 'image') return;
    setZoom(Math.max(ZOOM_MIN, zoomLevel.value - ZOOM_STEP));
}

function resetZoom(): void {
    setZoom(1);
}

function onZoomSlider(e: Event): void {
    const val = parseInt((e.target as HTMLInputElement).value, 10) / 100;
    setZoom(val);
}

// ── Fullscreen ───────────────────────────────────────────────────────────────

function toggleFullscreen(): void {
    isFullscreen.value = !isFullscreen.value;
}

// ── Navigation ───────────────────────────────────────────────────────────────

function navigateMedia(delta: number): void {
    pauseSlideshow();

    const newIndex = currentMediaIndex.value + delta;
    if (newIndex < 0 || newIndex >= currentMediaList.value.length) return;

    stopRecovery();
    currentMediaIndex.value = newIndex;
    const item = currentMediaList.value[newIndex];
    Logger.debug(`[MediaLightbox] Navigate ${delta > 0 ? 'next' : 'prev'}: ${item.title} (${newIndex + 1}/${currentMediaList.value.length})`);

    resetZoom();
    renderMedia(item, currentMediaType.value);
    preloadAdjacentImages();
    scrollThumbnailIntoView();
}

function goToIndex(index: number): void {
    if (index < 0 || index >= currentMediaList.value.length) return;
    pauseSlideshow();
    stopRecovery();
    currentMediaIndex.value = index;
    resetZoom();
    renderMedia(currentMediaList.value[index], currentMediaType.value);
    preloadAdjacentImages();
    scrollThumbnailIntoView();
}

function goToFirst(): void {
    if (currentMediaIndex.value !== 0) goToIndex(0);
}

function goToLast(): void {
    const lastIdx = currentMediaList.value.length - 1;
    if (currentMediaIndex.value !== lastIdx) goToIndex(lastIdx);
}

// ── Hide modal ───────────────────────────────────────────────────────────────

function hideModal(): void {
    stopSlideshow();

    // Stop any playing video — detach handlers FIRST so video.pause()
    // doesn't echo requestNativePause() to the native <audio>.
    const video = mediaWrapperRef.value?.querySelector('video');
    if (video) {
        video.onplay = null;
        video.onpause = null;
        video.onseeking = null;
        video.onseeked = null;
        video.onratechange = null;
        video.onended = null;
        video.pause();
        video.src = '';
    }

    // Cancel pending background requests
    activeRequestId++;
    mediaRenderGeneration++;
    stopRecovery();
    clearExternalBlobCache();

    isActive.value = false;
    isFullscreen.value = false;
    resetZoom();
    document.body.classList.remove('media-viewer-open');
    document.body.style.overflow = '';

    // Expand native player bar back (reverse of minimizePlayer)
    const store = bridge.store;
    if (store?.state?.AudioPlayer?.hide) {
        try { store.commit?.('AudioPlayer/TOGGLE_HIDE'); } catch { /* optional */ }
    }

    emit('update:visible', false);
    emit('closed');
}

// ── Keyboard handling ────────────────────────────────────────────────────────

function handleKeydown(e: KeyboardEvent): void {
    if (!isActive.value) return;

    switch (e.key) {
        case 'Escape':
            hideModal();
            e.preventDefault();
            break;
        case 'ArrowLeft': case 'a': case 'A': case 'ArrowUp': case 'w': case 'W':
            navigateMedia(-1);
            e.preventDefault();
            e.stopPropagation();
            break;
        case 'ArrowRight': case 'd': case 'D': case 'ArrowDown': case 's': case 'S':
            navigateMedia(1);
            e.preventDefault();
            e.stopPropagation();
            break;
        case '+': case '=':
            zoomIn();
            e.preventDefault();
            e.stopPropagation();
            break;
        case '-': case '_':
            zoomOut();
            e.preventDefault();
            e.stopPropagation();
            break;
        case '0':
            resetZoom();
            e.preventDefault();
            e.stopPropagation();
            break;
        case 'f': case 'F':
            toggleFullscreen();
            e.preventDefault();
            e.stopPropagation();
            break;
        case 'Home':
            goToFirst();
            e.preventDefault();
            e.stopPropagation();
            break;
        case 'End':
            goToLast();
            e.preventDefault();
            e.stopPropagation();
            break;
    }
}

// ── Mouse wheel zoom ─────────────────────────────────────────────────────────

function handleWheel(e: WheelEvent): void {
    if (!isActive.value || currentMediaType.value !== 'image') return;

    const isZoomed = zoomLevel.value !== 1;
    if (isZoomed && !e.ctrlKey) return;

    e.preventDefault();

    const wrapper = mediaWrapperRef.value;
    const img = wrapper?.querySelector('.media-viewer-image') as HTMLImageElement;
    if (!wrapper || !img) return;

    const rect = wrapper.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const scrollLeft = wrapper.scrollLeft;
    const scrollTop = wrapper.scrollTop;
    const contentX = scrollLeft + mouseX;
    const contentY = scrollTop + mouseY;

    const startZoom = zoomLevel.value;
    let newZoom = startZoom + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
    newZoom = Math.round(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newZoom)) * 100) / 100;

    if (newZoom === startZoom) return;

    const scale = newZoom / startZoom;
    setZoom(newZoom, false);

    requestAnimationFrame(() => {
        wrapper.scrollLeft = (contentX * scale) - mouseX;
        wrapper.scrollTop = (contentY * scale) - mouseY;
    });
}

// ── Mouse drag for pan ───────────────────────────────────────────────────────

function handleMouseDown(e: MouseEvent): void {
    if (zoomLevel.value <= 1) return;
    const wrapper = mediaWrapperRef.value;
    if (!wrapper) return;

    dragState = {
        isDragging: true,
        didDrag: false,
        startX: e.clientX,
        startY: e.clientY,
        scrollLeft: wrapper.scrollLeft,
        scrollTop: wrapper.scrollTop,
    };
    wrapper.style.cursor = 'grabbing';
    e.preventDefault();
}

function handleMouseMove(e: MouseEvent): void {
    if (!dragState.isDragging) return;
    const wrapper = mediaWrapperRef.value;
    if (!wrapper) return;

    const deltaX = e.clientX - dragState.startX;
    const deltaY = e.clientY - dragState.startY;

    if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) {
        dragState.didDrag = true;
    }

    wrapper.scrollLeft = dragState.scrollLeft - deltaX;
    wrapper.scrollTop = dragState.scrollTop - deltaY;
}

function handleMouseUp(): void {
    if (!dragState.isDragging) return;
    const wrapper = mediaWrapperRef.value;
    if (wrapper) {
        wrapper.style.cursor = zoomLevel.value > 1 ? 'grab' : 'default';
    }
    dragState.isDragging = false;
    setTimeout(() => { dragState.didDrag = false; }, 50);
}

// ── Touch handling ───────────────────────────────────────────────────────────

function handleTouchStart(e: TouchEvent): void {
    if (zoomLevel.value > 1 || e.touches.length !== 1) return;
    touchState = {
        startX: e.touches[0].clientX,
        startY: e.touches[0].clientY,
        startTime: Date.now(),
    };
}

function handleTouchMove(e: TouchEvent): void {
    if (!touchState || zoomLevel.value > 1) return;
    const deltaX = e.touches[0].clientX - touchState.startX;
    const deltaY = e.touches[0].clientY - touchState.startY;
    if (Math.abs(deltaX) > Math.abs(deltaY)) {
        e.preventDefault();
    }
}

function handleTouchEnd(e: TouchEvent): void {
    if (!touchState || zoomLevel.value > 1) return;
    const touch = e.changedTouches[0];
    const deltaX = touch.clientX - touchState.startX;
    const deltaY = touch.clientY - touchState.startY;
    const deltaTime = Date.now() - touchState.startTime;

    if (Math.abs(deltaX) > 50 && deltaTime < 300 && Math.abs(deltaX) > Math.abs(deltaY)) {
        navigateMedia(deltaX > 0 ? -1 : 1);
    }
    touchState = null;
}

// ── Backdrop/body click close ────────────────────────────────────────────────

function onBackdropClick(): void {
    hideModal();
}

function onBodyClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    if (target.classList.contains('media-viewer-body') || target.classList.contains('media-viewer-content')) {
        hideModal();
    }
}

// ── Media rendering (imperative DOM — images, video, pdf, text) ──────────────

function renderMedia(item: MediaFile, type: 'image' | 'video' | 'pdf' | 'text'): void {
    const wrapper = mediaWrapperRef.value;
    if (!wrapper) return;

    stopRecovery();
    wrapper.innerHTML = '';
    wrapper.classList.remove('zoomed');
    isLoading.value = true;
    errorMessage.value = '';
    const renderGeneration = ++mediaRenderGeneration;

    const url = getMediaUrl(item.hash, item);

    updateTitle(item.title);

    if (type === 'image') {
        void renderImage(wrapper, item, url, renderGeneration);
    } else if (type === 'video') {
        renderVideo(wrapper, item, url);
    } else if (type === 'pdf') {
        renderPdf(wrapper, item, url, renderGeneration);
    } else {
        renderText(wrapper, item, url, renderGeneration);
    }
}

async function renderImage(
    wrapper: HTMLElement,
    item: MediaFile,
    url: string,
    renderGeneration: number,
): Promise<void> {
    const baseUrl = normalizeExternalUrl(url);
    const img = document.createElement('img');
    img.alt = item.title;
    img.className = 'media-viewer-image';
    img.draggable = false;
    img.style.cursor = 'default';
    img.style.width = '';
    img.style.height = '';
    img.style.maxWidth = '100%';
    img.style.maxHeight = '100%';

    img.addEventListener('click', (e) => e.stopPropagation());
    wrapper.appendChild(img);

    const displayUrl = preloadedImages.get(item.hash)
        || await fetchMediaImageBlobUrl(item, baseUrl);

    if (renderGeneration !== mediaRenderGeneration || !img.isConnected) return;
    if (!displayUrl) {
        await handleUnavailableImage(item, renderGeneration);
        return;
    }

    preloadedImages.set(item.hash, displayUrl);
    thumbnailBlobUrls.value.set(item.hash, displayUrl);
    thumbnailBlobUrls.value = new Map(thumbnailBlobUrls.value);
    img.onload = () => {
        if (renderGeneration === mediaRenderGeneration) isLoading.value = false;
    };
    img.onerror = () => {
        if (renderGeneration !== mediaRenderGeneration) return;
        void handleUnavailableImage(item, renderGeneration);
    };
    img.src = displayUrl;
}

async function handleUnavailableImage(item: MediaFile, renderGeneration: number): Promise<void> {
    if (renderGeneration !== mediaRenderGeneration) return;

    const originalList = currentMediaList.value;
    const failedIndex = Math.max(0, originalList.findIndex((candidate) => candidate === item || candidate.hash === item.hash));
    const orderedAlternates = [
        ...originalList.slice(failedIndex + 1),
        ...originalList.slice(0, failedIndex),
    ].filter((candidate) => candidate !== item && candidate.hash !== item.hash);

    for (const candidate of orderedAlternates.slice(0, 2)) {
        const displayUrl = await fetchMediaImageBlobUrl(candidate);
        if (renderGeneration !== mediaRenderGeneration) return;
        if (!displayUrl) continue;

        const remaining = originalList.filter((entry) => entry !== item && entry.hash !== item.hash);
        const nextIndex = Math.max(0, remaining.findIndex((entry) => entry === candidate || entry.hash === candidate.hash));
        currentMediaList.value = remaining;
        currentMediaIndex.value = nextIndex;
        preloadedImages.set(candidate.hash, displayUrl);
        resetZoom();
        renderMedia(candidate, 'image');
        preloadAdjacentImages();
        scrollThumbnailIntoView();
        return;
    }

    if (renderGeneration !== mediaRenderGeneration) return;
    currentMediaList.value = originalList.filter((entry) => entry !== item && entry.hash !== item.hash);
    currentMediaIndex.value = 0;
    isLoading.value = false;
    errorMessage.value = t('mediaViewerImageUnavailable');
    errorIcon.value = 'block';
    mediaWrapperRef.value?.replaceChildren();
}

function renderVideo(wrapper: HTMLElement, item: MediaFile, url: string): void {
    props.onVideoSelected?.(item);

    const video = document.createElement('video');
    video.src = url;
    video.controls = true;
    video.autoplay = false;
    video.preload = 'metadata';
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.className = 'media-viewer-video';
    video.dataset.mediaHash = item.hash || '';
    video.dataset.mediaTitle = item.title || '';
    video.onloadeddata = () => { isLoading.value = false; };

    const store = bridge.store;
    let syncTimer: number | null = null;
    let lastUserAction = 0;
    // Counters track sync-loop-initiated play/pause. The sync loop
    // increments before calling video.play()/pause(). The corresponding
    // event handler decrements and skips when > 0 (sync echo).
    // This is deterministic — no timing races like timestamp approaches.
    let syncPlayPending = 0;
    let syncPausePending = 0;
    const USER_GRACE_MS = 300;

    const getAudio = (): HTMLAudioElement | null => {
        return document.querySelector('audio');
    };

    const syncFromNativeToVideo = (): void => {
        if (!video.isConnected) return;
        const audio = getAudio();
        const nativePlaying = !!store.state.AudioPlayer?.playing;
        const nativeRate = Number(audio?.playbackRate ?? Config.get('playbackRate') ?? 1);

        const audioReady = audio && audio.readyState >= 2;
        const nativeTime = audioReady
            ? Number(audio.currentTime)
            : Number(store.state.AudioPlayer?.currentTime ?? 0);

        const userActedRecently = (Date.now() - lastUserAction) < USER_GRACE_MS;

        // Time sync
        if (!userActedRecently && audioReady && Number.isFinite(nativeTime) && nativeTime >= 0 && Math.abs(video.currentTime - nativeTime) > 0.15) {
            video.currentTime = nativeTime;
        }
        // Rate sync (no echo risk)
        if (Number.isFinite(nativeRate) && nativeRate > 0 && Math.abs(video.playbackRate - nativeRate) > 0.01) {
            video.playbackRate = nativeRate;
        }
        // Play/pause sync with counter-based echo prevention
        if (!userActedRecently) {
            if (nativePlaying && video.paused) {
                syncPlayPending++;
                video.play().catch(() => { syncPlayPending = Math.max(0, syncPlayPending - 1); });
            } else if (!nativePlaying && !video.paused) {
                syncPausePending++;
                video.pause();
            }
        }
    };

    const syncVideoToNativeRate = (): void => {
        const audio = getAudio();
        if (audio && Math.abs(audio.playbackRate - video.playbackRate) > 0.01) {
            audio.playbackRate = video.playbackRate;
        }
        Config.set('playbackRate', video.playbackRate);
    };

    video.onloadedmetadata = () => {
        const store = bridge.store;
        const currentTime = Number(store.state.AudioPlayer?.currentTime || 0);
        if (Number.isFinite(currentTime) && currentTime > 0 && Math.abs(video.currentTime - currentTime) > 1.2) {
            video.currentTime = currentTime;
        }
        syncFromNativeToVideo();
        if (syncTimer !== null) {
            clearInterval(syncTimer);
        }
        syncTimer = window.setInterval(() => {
            if (!video.isConnected) {
                if (syncTimer !== null) {
                    clearInterval(syncTimer);
                    syncTimer = null;
                }
                return;
            }
            syncFromNativeToVideo();
        }, 120);
    };

    // CRITICAL: Event handlers ONLY commit Vuex mutations. They must NEVER
    // call audio.play()/pause() directly — the host's AudioElement has an
    // isLocked mutex that creates an infinite onPlaying↔onPause loop when
    // play()/pause() is called externally while isLocked is true:
    //   audio.play() → onPlaying() → isLocked? → player.pause() → onPause()
    //   → isLocked? → returns (PAUSE not committed) → store still playing=true
    //   → watcher calls player.play() → LOOP
    // Committing mutations lets the host's own `playing` watcher handle
    // the audio element through the proper channel (respecting isLocked).

    video.onplay = () => {
        if (syncPlayPending > 0) { syncPlayPending--; return; }
        lastUserAction = Date.now();
        bridge.requestPlay();
    };

    video.onpause = () => {
        if (syncPausePending > 0) { syncPausePending--; return; }
        lastUserAction = Date.now();
        bridge.requestPause();
    };

    video.onseeking = () => {
        lastUserAction = Date.now();
        const audio = getAudio();
        if (audio && Math.abs(audio.currentTime - video.currentTime) > 0.5) {
            audio.currentTime = video.currentTime;
        }
    };

    video.onseeked = () => {
        // Seek propagation handled by onseeking
    };

    video.onratechange = () => {
        lastUserAction = Date.now();
        syncVideoToNativeRate();
    };

    video.onended = () => {
        try {
            store.commit?.('AudioPlayer/NEXT_TRACK');
        } catch {
            // Optional mutation across host versions
        }
    };

    let retryCount = 0;
    const maxRetries = 3;
    video.onerror = () => {
        if (video.src === '' || video.src === window.location.href) return;
        retryCount++;
        if (retryCount <= maxRetries) {
            const delay = Math.pow(2, retryCount - 1) * 1000;
            setTimeout(() => {
                if (video.isConnected) {
                    const separator = url.includes('?') ? '&' : '?';
                    video.src = `${url}${separator}_r=${retryCount}`;
                    video.load();
                    syncFromNativeToVideo();
                }
            }, delay);
        } else {
            isLoading.value = false;
            errorMessage.value = 'Failed to load video';
            errorIcon.value = 'videocam_off';
        }
    };
    video.addEventListener('click', (e) => e.stopPropagation());
    video.addEventListener('emptied', () => {
        if (syncTimer !== null) {
            clearInterval(syncTimer);
            syncTimer = null;
        }
    });

    const savedRate = Number(Config.get('playbackRate')) || 1.0;
    if (savedRate !== 1.0) video.playbackRate = savedRate;

    wrapper.appendChild(video);
}

function renderPdf(wrapper: HTMLElement, item: MediaFile, url: string, renderGeneration: number): void {
    const pdfContainer = document.createElement('div');
    pdfContainer.className = 'media-viewer-pdf-container';
    wrapper.appendChild(pdfContainer);

    const renderPdfFallback = () => {
        if (renderGeneration !== mediaRenderGeneration) return;
        pdfContainer.innerHTML = '';
        const iframe = document.createElement('iframe');
        iframe.className = 'media-viewer-pdf';
        iframe.src = `${url}#toolbar=0&navpanes=0&scrollbar=1`;
        iframe.loading = 'lazy';
        iframe.referrerPolicy = 'no-referrer';
        iframe.onload = () => { isLoading.value = false; };
        iframe.onerror = () => {
            isLoading.value = false;
            errorMessage.value = t('mediaViewerPdfLoadFailed');
            errorIcon.value = 'picture_as_pdf';
        };
        pdfContainer.appendChild(iframe);
    };

    extractPdfText(url).then((text) => {
        if (renderGeneration !== mediaRenderGeneration) return;
        if (!text) { renderPdfFallback(); return; }

        if (translateMode.value) {
            const targetLang = TranslationService.getUiTargetLang();
            const { grid, translatedCells } = buildTranslationGrid(text);
            pdfContainer.innerHTML = '';
            pdfContainer.appendChild(grid);
            isLoading.value = false;

            const fastOptions = text.length > 20000 ? { fastDeadlineMs: 30000, maxLines: 80 } : undefined;
            translateGridCells(text, translatedCells, targetLang, fastOptions).then((ok) => {
                if (renderGeneration !== mediaRenderGeneration) return;
                if (!ok) {
                    pdfContainer.innerHTML = '';
                    pdfContainer.appendChild(buildTextLines(text));
                }
            }).catch(() => renderPdfFallback());
        } else {
            pdfContainer.innerHTML = '';
            pdfContainer.appendChild(buildTextLines(text));
            isLoading.value = false;
        }
    }).catch(() => renderPdfFallback());
}

function buildTextLines(text: string): HTMLElement {
    const container = document.createElement('div');
    container.className = 'media-viewer-text';
    for (const line of text.split(/\r?\n/)) {
        const lineEl = document.createElement('div');
        lineEl.className = 'media-viewer-text-line';
        lineEl.textContent = line || '\u00A0';
        container.appendChild(lineEl);
    }
    return container;
}

function renderText(wrapper: HTMLElement, item: MediaFile, url: string, renderGeneration: number): void {
    const loadText = async () => {
        try {
            const res = await retryWithBackoff(
                () => gmRequest({ url, responseType: 'text' }),
                { attempts: 2, backoffMs: 500 }
            );
            if (renderGeneration !== mediaRenderGeneration) return;
            const rawText = String(res.response || '');
            const maxChars = 400000;
            const text = rawText.length > maxChars ? rawText.slice(0, maxChars) : rawText;

            let note: HTMLDivElement | null = null;
            if (rawText.length > maxChars) {
                note = document.createElement('div');
                note.className = 'media-viewer-text-note';
                note.textContent = format('mediaViewerTextTruncated', { count: Math.round(maxChars / 1000) });
            }

            if (translateMode.value) {
                const targetLang = TranslationService.getUiTargetLang();
                const { grid, translatedCells } = buildTranslationGrid(text);
                wrapper.innerHTML = '';
                wrapper.appendChild(grid);
                if (note) wrapper.appendChild(note);

                const fastOptions = text.length > 20000 ? { fastDeadlineMs: 30000, maxLines: 80 } : undefined;
                const ok = await translateGridCells(text, translatedCells, targetLang, fastOptions);
                if (renderGeneration !== mediaRenderGeneration) return;
                if (!ok) {
                    wrapper.innerHTML = '';
                    wrapper.appendChild(buildTextLines(text));
                    if (note) wrapper.appendChild(note);
                }
            } else {
                wrapper.innerHTML = '';
                wrapper.appendChild(buildTextLines(text));
            }

            if (note && !note.isConnected) wrapper.appendChild(note);
            isLoading.value = false;
        } catch (err) {
            Logger.warn('[MediaLightbox] Text load failed:', err);
            isLoading.value = false;
            errorMessage.value = t('mediaViewerTextLoadFailed');
            errorIcon.value = 'description';
        }
    };

    loadText().catch(() => {});
}

// ── Title translation ────────────────────────────────────────────────────────

function updateTitle(title: string): void {
    titleTranslationToken.value += 1;
    const token = titleTranslationToken.value;
    mediaTitle.value = title;
    translatedTitle.value = '';

    if (!/[\u3040-\u30ff\u4e00-\u9faf]/.test(title)) return;

    // CN→JP mode: silently replace Chinese title with Japanese (shown as main title)
    const cnOnlyMode = !translateMode.value && cnToJp.value;
    if (cnOnlyMode) {
        if (!isChinese(title)) return;
        TranslationService.translate(title, 'ja', { sourceLanguageHint: 'zh' }).then(result => {
            if (!result || result === title) return;
            if (token !== titleTranslationToken.value) return;
            mediaTitle.value = result; // Replace title directly
        }).catch(() => {});
        return;
    }

    if (!translateMode.value) return;

    const targetLang = TranslationService.getUiTargetLang();
    TranslationService.translate(title, targetLang, { sourceLanguageHint: 'auto' }).then(result => {
        if (!result || result === title) return;
        if (token !== titleTranslationToken.value) return;
        translatedTitle.value = result;
    }).catch(() => {});
}

// ── Preloading ───────────────────────────────────────────────────────────────

function preloadAdjacentImages(): void {
    if (currentMediaType.value !== 'image') return;
    const preloadGeneration = imageFetchGeneration;

    const preload = (item: MediaFile): void => {
        if (preloadedImages.has(item.hash)) return;
        void fetchMediaImageBlobUrl(item).then((blobUrl) => {
            if (!blobUrl || preloadGeneration !== imageFetchGeneration) return;
            preloadedImages.set(item.hash, blobUrl);
            thumbnailBlobUrls.value.set(item.hash, blobUrl);
            thumbnailBlobUrls.value = new Map(thumbnailBlobUrls.value);
        });
    };

    // Only the immediate neighbours are warmed. Each warmup is a full image
    // blob GET, so broader/background preloading would download an entire
    // multi-megabyte gallery without user intent.
    for (const delta of [-1, 1]) {
        const idx = currentMediaIndex.value + delta;
        if (idx >= 0 && idx < currentMediaList.value.length) {
            const item = currentMediaList.value[idx];
            preload(item);
        }
    }
}

// ── Auto-slideshow ───────────────────────────────────────────────────────────

function startSlideshow(): void {
    stopSlideshow();
    if (slideshowPaused) return;
    if (currentMediaList.value.length < 2) return;
    if (currentMediaType.value !== 'image') return;
    if (!galleryAutoSlideshow.value) return;

    const interval = Math.max(2, Number(galleryAutoSlideshowInterval.value) || 6);
    slideshowTimer = setInterval(() => {
        if (currentMediaList.value.length < 2) { stopSlideshow(); return; }
        const nextIndex = (currentMediaIndex.value + 1) % currentMediaList.value.length;
        if (nextIndex === currentMediaIndex.value) return;
        currentMediaIndex.value = nextIndex;
        resetZoom();
        renderMedia(currentMediaList.value[nextIndex], currentMediaType.value);
        preloadAdjacentImages();
        scrollThumbnailIntoView();
    }, interval * 1000);
    Logger.debug('[MediaLightbox] Slideshow started, interval=', interval, 's');
}

function stopSlideshow(): void {
    if (slideshowTimer !== null) {
        clearInterval(slideshowTimer);
        slideshowTimer = null;
    }
}

function pauseSlideshow(): void {
    if (!slideshowPaused) {
        slideshowPaused = true;
        stopSlideshow();
    }
}

// ── Auto-recovery ────────────────────────────────────────────────────────────

function stopRecovery(): void {
    if (recoveryTimeout) {
        clearTimeout(recoveryTimeout);
        recoveryTimeout = undefined;
    }
}

// ── Thumbnail strip ──────────────────────────────────────────────────────────

function scrollThumbnailIntoView(): void {
    nextTick(() => {
        const strip = thumbnailStripRef.value;
        const activeThumb = strip?.querySelector('.media-viewer-thumb-item.active') as HTMLElement;
        if (activeThumb?.scrollIntoView) {
            activeThumb.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }
    });
}

// ── Download / Raw ───────────────────────────────────────────────────────────

async function downloadCurrentMedia(): Promise<void> {
    const item = currentMediaList.value[currentMediaIndex.value];
    if (!item) return;

    const url = getMediaUrl(item.hash, item);

    const triggerDownload = (blob: Blob) => {
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = item.title;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    };

    if (currentMediaType.value === 'image') {
        const verifiedUrl = preloadedImages.get(item.hash) || await fetchMediaImageBlobUrl(item, url);
        if (!verifiedUrl) {
            errorMessage.value = t('mediaViewerImageUnavailable');
            errorIcon.value = 'block';
            return;
        }
        try {
            const response = await fetch(verifiedUrl);
            triggerDownload(await response.blob());
            return;
        } catch (err) {
            Logger.warn('[MediaLightbox] Verified image download failed:', err);
            errorMessage.value = t('mediaViewerImageUnavailable');
            errorIcon.value = 'block';
            return;
        }
    }

    try {
        const res = await retryWithBackoff(
            () => gmRequest({ url, responseType: 'blob' }),
            { attempts: 2, backoffMs: 500 },
        );
        triggerDownload(res.response as Blob);
    } catch {
        try {
            const response = await fetch(url, { credentials: 'include' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            triggerDownload(await response.blob());
        } catch (err) {
            Logger.warn('[MediaLightbox] Download failed:', err);
            window.open(url, '_blank', 'noopener,noreferrer');
        }
    }
}

async function openRawMedia(): Promise<void> {
    const item = currentMediaList.value[currentMediaIndex.value];
    if (!item) return;
    if (currentMediaType.value === 'image') {
        const verifiedUrl = preloadedImages.get(item.hash) || await fetchMediaImageBlobUrl(item);
        if (!verifiedUrl) {
            errorMessage.value = t('mediaViewerImageUnavailable');
            errorIcon.value = 'block';
            return;
        }
        window.open(verifiedUrl, '_blank', 'noopener,noreferrer');
        return;
    }
    window.open(getMediaUrl(item.hash, item), '_blank', 'noopener,noreferrer');
}

// ── Player control ───────────────────────────────────────────────────────────

function minimizePlayer(): void {
    const store = bridge.store;
    if (!store?.state?.AudioPlayer) return;
    if (!store.state.AudioPlayer.hide) {
        Logger.debug('[MediaLightbox] Auto-minimizing audio player via store');
        store.commit?.('AudioPlayer/TOGGLE_HIDE');
    }
}

// ── Translation helpers (for PDF/text) ───────────────────────────────────────

function buildTranslationGrid(text: string): { grid: HTMLElement; translatedCells: HTMLElement[] } {
    const lines = text.split(/\r?\n/);
    const grid = document.createElement('div');
    grid.className = 'media-viewer-text-grid asmr-translation-pair';

    const translatedCells: HTMLElement[] = [];
    for (const line of lines) {
        const origCell = document.createElement('div');
        origCell.className = 'media-viewer-text-line';
        origCell.textContent = line || '\u00A0';

        const transCell = document.createElement('div');
        transCell.className = 'media-viewer-text-line media-viewer-text-line--translated';
        transCell.textContent = line || '\u00A0';
        translatedCells.push(transCell);

        grid.appendChild(origCell);
        grid.appendChild(transCell);
    }

    return { grid, translatedCells };
}

async function translateGridCells(
    text: string,
    translatedCells: HTMLElement[],
    targetLang: string,
    options?: { fastDeadlineMs?: number; maxLines?: number }
): Promise<boolean> {
    const lines = text.split(/\r?\n/);
    const indices: number[] = [];
    const toTranslate: string[] = [];

    lines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (!trimmed || !/\p{L}/u.test(trimmed)) return;
        indices.push(idx);
        toTranslate.push(trimmed);
    });

    if (toTranslate.length === 0) return false;

    const maxLines = options?.maxLines
        ? Math.min(options.maxLines, toTranslate.length)
        : toTranslate.length;
    const concurrency = 4;

    let timedOut = false;
    if (options?.fastDeadlineMs && options.fastDeadlineMs > 0) {
        window.setTimeout(() => { timedOut = true; }, options.fastDeadlineMs);
    }

    let anyTranslated = false;
    let nextIndex = 0;

    const run = async () => {
        while (true) {
            const idx = nextIndex++;
            if (idx >= maxLines || timedOut) break;
            try {
                const result = await TranslationService.translate(toTranslate[idx], targetLang);
                if (result && result !== toTranslate[idx]) {
                    translatedCells[indices[idx]].textContent = result;
                    anyTranslated = true;
                }
            } catch { /* ignore per-line errors */ }
        }
    };

    const workerCount = Math.min(concurrency, maxLines);
    await Promise.all(Array.from({ length: workerCount }, () => run()));
    return anyTranslated;
}

async function ensurePdfJs(): Promise<PdfjsLib | null> {
    type PdfjsWindow = typeof globalThis & { pdfjsLib?: PdfjsLib };
    if ((globalThis as PdfjsWindow).pdfjsLib) return (globalThis as PdfjsWindow).pdfjsLib!;

    if (!pdfjsLoadPromise) {
        pdfjsLoadPromise = (async (): Promise<PdfjsLib | null> => {
            // Primary: fetch via GM_xmlhttpRequest (bypasses CORS & page CSP)
            // and evaluate in userscript sandbox where pdfjsLib lands on our globalThis
            try {
                const res = await gmRequest({ url: PDFJS_CDN, responseType: 'text' });
                const scriptText = res.response as string;
                if (scriptText) {
                    new Function(scriptText)();
                    const lib = (globalThis as PdfjsWindow).pdfjsLib;
                    if (lib) {
                        // Fetch worker source and create blob URL (avoids CSP for Worker too)
                        try {
                            const wRes = await gmRequest({ url: PDFJS_WORKER_CDN, responseType: 'text' });
                            const wText = wRes.response as string;
                            if (wText) {
                                const blob = new Blob([wText], { type: 'application/javascript' });
                                lib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
                            }
                        } catch {
                            try { lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_CDN; } catch { /* ignore */ }
                        }
                        return lib;
                    }
                }
            } catch {
                Logger.debug('[MediaLightbox] PDF.js fetch+eval failed, trying script tag');
            }

            // Fallback: script tag (works when CSP allows cdn.jsdelivr.net)
            // Script executes in page context → check unsafeWindow for pdfjsLib
            return new Promise<PdfjsLib | null>((resolve) => {
                const script = document.createElement('script');
                script.src = PDFJS_CDN;
                script.async = true;
                script.onload = () => {
                    const pageWin = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) as PdfjsWindow;
                    const lib = pageWin.pdfjsLib || null;
                    if (lib) {
                        try { lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_CDN; } catch { /* ignore */ }
                    }
                    resolve(lib);
                };
                script.onerror = () => resolve(null);
                document.head.appendChild(script);
            });
        })();
    }

    return pdfjsLoadPromise as Promise<PdfjsLib | null>;
}

async function extractPdfText(url: string): Promise<string | null> {
    const pdfjs = await ensurePdfJs();
    if (!pdfjs) return null;

    try {
        const res = await retryWithBackoff(
            () => gmRequest({ url, responseType: 'arraybuffer' }),
            { attempts: 2, backoffMs: 500 }
        );
        const data = res.response as ArrayBuffer;
        const doc = await pdfjs.getDocument({ data }).promise;
        const maxPages = Math.min(doc.numPages, PDF_TEXT_MAX_PAGES);
        const pages: string[] = [];

        for (let i = 1; i <= maxPages; i++) {
            const page = await doc.getPage(i);
            const content = await page.getTextContent();
            const lines: string[] = [];
            let currentLine = '';

            for (const item of (content.items || [])) {
                if (item.str) currentLine += item.str;
                if (item.hasEOL) {
                    if (currentLine.trim()) lines.push(currentLine.trim());
                    currentLine = '';
                }
            }
            if (currentLine.trim()) lines.push(currentLine.trim());

            // Split any remaining long lines at sentence boundaries (CJK: 。！？)
            // so each grid cell stays within translation request limits
            const splitLines: string[] = [];
            for (const line of lines) {
                if (line.length <= 300) {
                    splitLines.push(line);
                } else {
                    const parts = line.split(/(?<=[。！？\.\!\?])\s*/);
                    let buf = '';
                    for (const part of parts) {
                        if (buf && buf.length + part.length > 300) {
                            splitLines.push(buf);
                            buf = part;
                        } else {
                            buf += part;
                        }
                    }
                    if (buf) splitLines.push(buf);
                }
            }

            if (splitLines.length) pages.push(splitLines.join('\n'));
        }

        return pages.join('\n\n');
    } catch (err) {
        Logger.warn('[MediaLightbox] PDF text extraction failed:', err);
        return null;
    }
}

// ── Public API (exposed for controller) ──────────────────────────────────────

/**
 * Open the lightbox with a list of media files.
 * Called by the controller when a media file is clicked.
 */
async function showMedia(
    item: MediaFile,
    type: 'image' | 'video' | 'pdf' | 'text',
    mediaList: MediaFile[],
    startIndex: number
): Promise<void> {
    clearExternalBlobCache();
    currentMediaList.value = mediaList;
    currentMediaIndex.value = startIndex;
    currentMediaType.value = type;
    zoomLevel.value = 1;
    isFullscreen.value = false;
    errorMessage.value = '';

    const hasFakeHash = !item.hash || item.hash.startsWith('__delegated_');

    if (hasFakeHash) {
        isLoading.value = true;
        updateTitle(item.title);
    } else {
        renderMedia(item, type);
    }

    isActive.value = true;
    document.body.classList.add('media-viewer-open');
    document.body.style.overflow = 'hidden';

    // For video, the controller calls minimizeNativePlayerIfExpanded() —
    // calling minimizePlayer() here too would double-toggle TOGGLE_HIDE.
    if (!document.body.classList.contains('asmr-fullscreen-active') && type !== 'video') {
        minimizePlayer();
    }

    // Wait for DOM to be ready before scrolling thumbnails
    await nextTick();
    scrollThumbnailIntoView();
    preloadAdjacentImages();
}

/**
 * Open the lightbox with external image URLs (e.g. DLsite sample images).
 */
function showExternalImages(urls: string[], startIndex = 0): void {
    if (!urls.length) return;

    activeRequestId++;
    clearExternalBlobCache();
    // External galleries can change order/length across works; clear stale preloads
    // keyed by prior synthetic hashes to avoid slot-to-image mismatches.
    preloadedImages.clear();

    const list: MediaFile[] = urls.map((url, i) => {
        const normalizedUrl = normalizeExternalUrl(url);
        let title = `image_${i + 1}`;
        try {
            const parsed = new URL(normalizedUrl);
            const filename = parsed.pathname.split('/').pop();
            title = decodeURIComponent(filename || title);
        } catch {
            title = normalizedUrl.split('/').pop() || title;
        }

        return {
            hash: `__external_${encodeURIComponent(normalizedUrl)}_${i}`,
            title,
            type: 'image',
            mediaStreamUrl: normalizedUrl,
        };
    });

    currentMediaList.value = list;
    currentMediaIndex.value = Math.min(startIndex, urls.length - 1);
    currentMediaType.value = 'image';
    zoomLevel.value = 1;
    isFullscreen.value = false;
    errorMessage.value = '';

    const item = list[currentMediaIndex.value];
    renderMedia(item, 'image');

    isActive.value = true;
    document.body.classList.add('media-viewer-open');
    document.body.style.overflow = 'hidden';

    if (!document.body.classList.contains('asmr-fullscreen-active')) minimizePlayer();

    slideshowPaused = false;
    startSlideshow();

    nextTick(() => {
        scrollThumbnailIntoView();
        preloadAdjacentImages();
    });
}

/**
 * Update the media list and current index (called after async data resolution).
 */
function updateMediaList(list: MediaFile[], index: number): void {
    currentMediaList.value = list;
    currentMediaIndex.value = index;
    scrollThumbnailIntoView();
    preloadAdjacentImages();
}

/**
 * Render a specific item (called after async hash resolution).
 */
function renderResolvedItem(item: MediaFile, type: 'image' | 'video' | 'pdf' | 'text'): void {
    renderMedia(item, type);
}

/**
 * Show an error state (called when hash resolution fails).
 */
function showResolutionError(): void {
    isLoading.value = false;
    errorMessage.value = t('mediaViewerResolutionFailed');
    errorIcon.value = 'broken_image';
}

/**
 * Start the slideshow after population.
 */
function startSlideshowAfterPopulation(): void {
    slideshowPaused = false;
    startSlideshow();
}

/** Whether the lightbox is currently active */
function getIsActive(): boolean {
    return isActive.value;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

onMounted(() => {
    document.addEventListener('keydown', handleKeydown);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
});

watch([lang, translateMode, cnToJp], () => {
    titleTranslationToken.value += 1;
    translatedTitle.value = '';
    const item = currentItem.value;
    if (!isActive.value || !item) return;
    if (currentMediaType.value === 'pdf' || currentMediaType.value === 'text') {
        renderMedia(item, currentMediaType.value);
    } else {
        updateTitle(item.title);
    }
});

onUnmounted(() => {
    mediaRenderGeneration++;
    document.removeEventListener('keydown', handleKeydown);
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
    stopSlideshow();
    stopRecovery();
    preloadedImages.clear();
    clearExternalBlobCache();

    if (isActive.value) {
        document.body.classList.remove('media-viewer-open');
        document.body.style.overflow = '';
    }
});

// ── Expose API ───────────────────────────────────────────────────────────────

defineExpose({
    showMedia,
    showExternalImages,
    updateMediaList,
    renderResolvedItem,
    showResolutionError,
    startSlideshowAfterPopulation,
    hideModal,
    getIsActive,
});
</script>

<template>
    <Teleport to="body">
        <div
            id="asmr-media-viewer-modal"
            class="media-viewer-modal"
            :class="{ active: isActive, 'fullscreen-mode': isFullscreen }"
            role="dialog"
            aria-modal="true"
        >
            <!-- Backdrop -->
            <div class="media-viewer-backdrop" @click="onBackdropClick" />

            <!-- Container -->
            <div class="media-viewer-container">
                <!-- Header -->
                <div class="media-viewer-header">
                    <div class="media-viewer-counter">
                        <span class="media-viewer-current">{{ currentPosition }}</span>
                        <span class="media-viewer-separator">/</span>
                        <span class="media-viewer-total">{{ totalCount }}</span>
                    </div>

                    <div class="media-viewer-title">
                        <template v-if="hasTitleTranslation">
                            <span class="asmr-translation-original">{{ mediaTitle }}</span>
                            <span class="asmr-translation-sep"> &middot; </span>
                            <span class="asmr-translation-translated">{{ translatedTitle }}</span>
                        </template>
                        <template v-else>{{ mediaTitle }}</template>
                    </div>

                    <div class="media-viewer-actions">
                        <div v-show="showZoomControls" class="media-viewer-zoom-controls">
                            <button
                                class="media-viewer-action media-viewer-zoom-out"
                                :class="{ disabled: isZoomOutDisabled }"
                                :aria-label="t('mediaViewerZoomOut')"
                                :title="`${t('mediaViewerZoomOut')} (-)`"
                                @click.stop="zoomOut"
                            >
                                <span class="material-icons">remove</span>
                            </button>
                            <input
                                type="range"
                                class="media-viewer-zoom-slider"
                                min="50"
                                max="400"
                                :value="zoomSliderValue"
                                step="10"
                                :aria-label="t('mediaViewerZoomLevel')"
                                :title="t('mediaViewerZoomLevel')"
                                @input.stop="onZoomSlider"
                            >
                            <button
                                class="media-viewer-action media-viewer-zoom-in"
                                :class="{ disabled: isZoomInDisabled }"
                                :aria-label="t('mediaViewerZoomIn')"
                                :title="`${t('mediaViewerZoomIn')} (+)`"
                                @click.stop="zoomIn"
                            >
                                <span class="material-icons">add</span>
                            </button>
                            <div class="media-viewer-zoom-indicator">{{ zoomPercent }}</div>
                            <button
                                class="media-viewer-action media-viewer-zoom-reset"
                                :aria-label="t('mediaViewerZoomReset')"
                                :title="`${t('mediaViewerZoomReset')} (0)`"
                                @click.stop="resetZoom"
                            >
                                <span class="material-icons">fit_screen</span>
                            </button>
                        </div>

                        <button
                            class="media-viewer-action media-viewer-fullscreen"
                            :aria-label="t(isFullscreen ? 'mediaViewerExitFullscreen' : 'mediaViewerFullscreen')"
                            :title="`${t(isFullscreen ? 'mediaViewerExitFullscreen' : 'mediaViewerFullscreen')} (F)`"
                            @click.stop="toggleFullscreen"
                        >
                            <span class="material-icons">{{ isFullscreen ? 'fullscreen_exit' : 'fullscreen' }}</span>
                        </button>
                        <button
                            class="media-viewer-action media-viewer-download"
                            :aria-label="t('mediaViewerDownload')"
                            :title="t('mediaViewerDownload')"
                            @click.stop="downloadCurrentMedia"
                        >
                            <span class="material-icons">download</span>
                        </button>
                        <button
                            class="media-viewer-action media-viewer-raw"
                            :aria-label="t('mediaViewerOpenRaw')"
                            :title="t('mediaViewerOpenRaw')"
                            @click.stop="openRawMedia"
                        >
                            <span class="material-icons">open_in_new</span>
                        </button>
                        <button
                            class="media-viewer-action media-viewer-close"
                            :aria-label="t('mediaViewerClose')"
                            :title="`${t('mediaViewerClose')} (Esc)`"
                            @click.stop="hideModal"
                        >
                            <span class="material-icons">close</span>
                        </button>
                    </div>
                </div>

                <!-- Body -->
                <div class="media-viewer-body" @click="onBodyClick">
                    <div
                        class="media-viewer-content"
                        @touchstart.passive="handleTouchStart"
                        @touchmove="handleTouchMove"
                        @touchend="handleTouchEnd"
                    >
                        <!-- Prev button -->
                        <button
                            v-show="hasMultipleMedia"
                            class="media-viewer-nav media-viewer-prev"
                            :class="{ disabled: isPrevDisabled }"
                            :aria-label="t('mediaViewerPrevious')"
                            :title="t('mediaViewerPrevious')"
                            @click.stop="navigateMedia(-1)"
                        >
                            <span class="material-icons">chevron_left</span>
                        </button>

                        <!-- Loader -->
                        <div class="media-viewer-loader" :class="{ visible: isLoading }">
                            <span class="material-icons spinning">refresh</span>
                        </div>

                        <!-- Error state -->
                        <div v-if="errorMessage && !isLoading" class="media-viewer-error">
                            <span class="material-icons">{{ errorIcon }}</span>
                            <span>{{ errorMessage }}</span>
                        </div>

                        <!-- Media wrapper (imperative DOM for image/video/pdf/text) -->
                        <div
                            ref="mediaWrapperRef"
                            class="media-viewer-media-wrapper"
                            @wheel="handleWheel"
                            @mousedown="handleMouseDown"
                            @dragstart.prevent
                        />

                        <!-- Next button -->
                        <button
                            v-show="hasMultipleMedia"
                            class="media-viewer-nav media-viewer-next"
                            :class="{ disabled: isNextDisabled }"
                            :aria-label="t('mediaViewerNext')"
                            :title="t('mediaViewerNext')"
                            @click.stop="navigateMedia(1)"
                        >
                            <span class="material-icons">chevron_right</span>
                        </button>
                    </div>
                </div>

                <!-- Thumbnail strip -->
                <div
                    ref="thumbnailStripRef"
                    class="media-viewer-thumbnails"
                    :class="{ hidden: !hasMultipleMedia }"
                >
                    <button
                        v-for="(item, index) in currentMediaList"
                        :key="item.hash + '_' + index"
                        class="media-viewer-thumb-item"
                        :class="{ active: index === currentMediaIndex }"
                        :aria-label="item.title"
                        :title="item.title"
                        @click.stop="goToIndex(index)"
                    >
                        <img
                            v-if="currentMediaType === 'image' && getThumbnailUrl(item)"
                            :src="getThumbnailUrl(item)"
                            :alt="item.title"
                            loading="lazy"
                            referrerpolicy="no-referrer"
                            @error="onThumbnailError(item, $event)"
                        >
                        <span v-else class="material-icons">{{ getThumbnailIcon(currentMediaType) }}</span>
                    </button>
                </div>
            </div>
        </div>
    </Teleport>
</template>
