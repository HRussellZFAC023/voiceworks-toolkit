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
import { useI18n } from '../../composables/useI18n';
import { Logger, Config } from '../../core/Utils';
import { I18n } from '../../core/Config';
import { gmRequest, retryWithBackoff } from '../../infrastructure/HttpClient';
import { TranslationService } from '../../services/TranslationService';
import { isChinese } from '../../core/DomUtils';
import type { MediaFile, TouchState, DragState } from '../media/types';

// ── Constants ────────────────────────────────────────────────────────────────

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'];
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v'];
const PDF_EXTENSIONS = ['.pdf'];
const TEXT_EXTENSIONS = ['.txt', '.md', '.log', '.nfo', '.csv', '.json', '.srt', '.ass', '.vtt', '.lrc'];

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 5;
const ZOOM_STEP = 0.05;

const TRANSLATE_BATCH_MAX_CHARS = 0;
const TRANSLATE_TOTAL_MAX_CHARS = 0;
const PDF_TEXT_MAX_PAGES = Infinity;
const PDFJS_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.js';
const PDFJS_WORKER_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.js';

// ── Props & Emits ────────────────────────────────────────────────────────────

const props = defineProps<{
    /** Whether the lightbox is visible */
    visible: boolean;
}>();

const emit = defineEmits<{
    (e: 'update:visible', value: boolean): void;
    (e: 'closed'): void;
}>();

// ── Composables ──────────────────────────────────────────────────────────────

const bridge = useBridge();
const { t, format } = useI18n();
const translateMode = useConfig('translateMode');
const cnToJp = useConfig('translateCnToJp');
const galleryAutoSlideshow = useConfig('galleryAutoSlideshow');
const galleryAutoSlideshowInterval = useConfig('galleryAutoSlideshowInterval');

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
let preloadedImages = new Map<string, HTMLImageElement>();
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
const currentPosition = computed(() => currentMediaIndex.value + 1);
const totalCount = computed(() => currentMediaList.value.length);
const hasTitleTranslation = computed(() => !!translatedTitle.value && translatedTitle.value !== mediaTitle.value);
const currentItem = computed(() => currentMediaList.value[currentMediaIndex.value] || null);

// ── File type utilities ──────────────────────────────────────────────────────

function getFileExtension(filename: string): string {
    const match = filename.match(/\.[^.]+$/);
    return match ? match[0].toLowerCase() : '';
}

function isImage(ext: string): boolean {
    return IMAGE_EXTENSIONS.includes(ext);
}

function isVideo(ext: string): boolean {
    return VIDEO_EXTENSIONS.includes(ext);
}

function isPdf(ext: string): boolean {
    return PDF_EXTENSIONS.includes(ext);
}

function isText(ext: string): boolean {
    return TEXT_EXTENSIONS.includes(ext);
}

// ── URL utility ──────────────────────────────────────────────────────────────

function getMediaUrl(hash: string, item?: MediaFile): string {
    const token = localStorage.getItem('jwt-token') || '';

    const appendToken = (url: string) => {
        if (url.startsWith('http') || url.startsWith('//')) return url;
        if (url.startsWith('/api/')) {
            const separator = url.includes('?') ? '&' : '?';
            return `${url}${separator}token=${token}`;
        }
        return url;
    };

    if (item?.mediaStreamUrl) return appendToken(item.mediaStreamUrl);
    if (item?.media_stream_url) return appendToken(item.media_stream_url);

    if (hash.includes('/')) {
        if (hash.startsWith('media/stream/') || hash.startsWith('/media/stream/')) {
            const path = hash.startsWith('/') ? hash : `/${hash}`;
            return appendToken(path);
        }
        return appendToken(`/api/media/stream/${hash}`);
    }

    return appendToken(`/api/media/stream/${hash}`);
}

function getThumbnailUrl(item: MediaFile): string {
    return getMediaUrl(item.hash, item);
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

    // Stop any playing video
    const video = mediaWrapperRef.value?.querySelector('video');
    if (video) {
        video.pause();
        video.src = '';
    }

    // Cancel pending background requests
    activeRequestId++;
    stopRecovery();

    isActive.value = false;
    isFullscreen.value = false;
    resetZoom();
    document.body.classList.remove('media-viewer-open');
    document.body.style.overflow = '';

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

    const url = getMediaUrl(item.hash, item);

    updateTitle(item.title);

    if (type === 'image') {
        renderImage(wrapper, item, url);
    } else if (type === 'video') {
        renderVideo(wrapper, item, url);
    } else if (type === 'pdf') {
        renderPdf(wrapper, item, url);
    } else {
        renderText(wrapper, item, url);
    }
}

function renderImage(wrapper: HTMLElement, item: MediaFile, url: string): void {
    const img = document.createElement('img');
    img.alt = item.title;
    img.className = 'media-viewer-image';
    img.draggable = false;
    img.referrerPolicy = 'no-referrer';
    img.style.cursor = 'default';
    img.style.width = '';
    img.style.height = '';
    img.style.maxWidth = '100%';
    img.style.maxHeight = '100%';

    const preloaded = preloadedImages.get(item.hash);
    if (preloaded && preloaded.complete) {
        img.src = preloaded.src;
        isLoading.value = false;
    } else {
        img.onload = () => { isLoading.value = false; };

        let retryCount = 0;
        const maxRetries = 3;
        img.onerror = () => {
            retryCount++;
            if (retryCount <= maxRetries) {
                const delay = Math.pow(2, retryCount - 1) * 1000;
                Logger.debug(`[MediaLightbox] Image retry ${retryCount}/${maxRetries} for ${item.title} in ${delay}ms`);
                setTimeout(() => {
                    if (img.isConnected) {
                        const separator = url.includes('?') ? '&' : '?';
                        img.src = `${url}${separator}_r=${retryCount}`;
                    }
                }, delay);
            } else {
                isLoading.value = false;
                errorMessage.value = 'Failed to load image';
                errorIcon.value = 'broken_image';
                wrapper.innerHTML = '';
                startAutoRecovery(item, wrapper);
            }
        };

        img.src = url;
    }

    img.addEventListener('click', (e) => e.stopPropagation());
    wrapper.appendChild(img);
}

function renderVideo(wrapper: HTMLElement, item: MediaFile, url: string): void {
    const video = document.createElement('video');
    video.src = url;
    video.controls = true;
    video.autoplay = true;
    video.muted = true;
    video.className = 'media-viewer-video';
    video.onloadeddata = () => { isLoading.value = false; };

    video.onplay = () => {
        const store = bridge.store;
        if (store.state.AudioPlayer && !store.state.AudioPlayer.playing) {
            store.dispatch?.('AudioPlayer/play');
        }
    };
    video.onpause = () => {
        const store = bridge.store;
        if (store.state.AudioPlayer && store.state.AudioPlayer.playing) {
            store.dispatch?.('AudioPlayer/pause');
        }
    };
    video.onseeking = () => {
        const audio = document.querySelector('audio');
        if (audio) audio.currentTime = video.currentTime;
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
                    video.play().catch(() => {});
                }
            }, delay);
        } else {
            isLoading.value = false;
            errorMessage.value = 'Failed to load video';
            errorIcon.value = 'videocam_off';
        }
    };
    video.addEventListener('click', (e) => e.stopPropagation());

    const savedRate = Number(Config.get('playbackRate')) || 1.0;
    if (savedRate !== 1.0) video.playbackRate = savedRate;

    wrapper.appendChild(video);
}

function renderPdf(wrapper: HTMLElement, item: MediaFile, url: string): void {
    const pdfContainer = document.createElement('div');
    pdfContainer.className = 'media-viewer-pdf-container';
    wrapper.appendChild(pdfContainer);

    const renderPdfFallback = () => {
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
        if (!text) { renderPdfFallback(); return; }

        if (translateMode.value) {
            const targetLang = I18n.lang === 'zh' ? 'zh-CN' : I18n.lang;
            const { grid, translatedCells } = buildTranslationGrid(text);
            pdfContainer.innerHTML = '';
            pdfContainer.appendChild(grid);
            isLoading.value = false;

            const fastOptions = text.length > 20000 ? { fastDeadlineMs: 30000, maxLines: 80 } : undefined;
            translateGridCells(text, translatedCells, targetLang, fastOptions).then((ok) => {
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
        const lineEl = document.createElement('pre');
        lineEl.className = 'media-viewer-text-line';
        lineEl.textContent = line || '\u00A0';
        container.appendChild(lineEl);
    }
    return container;
}

function renderText(wrapper: HTMLElement, item: MediaFile, url: string): void {
    const loadText = async () => {
        try {
            const res = await retryWithBackoff(
                () => gmRequest({ url, responseType: 'text' }),
                { attempts: 2, backoffMs: 500 }
            );
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
                const targetLang = I18n.lang === 'zh' ? 'zh-CN' : I18n.lang;
                const { grid, translatedCells } = buildTranslationGrid(text);
                wrapper.innerHTML = '';
                wrapper.appendChild(grid);
                if (note) wrapper.appendChild(note);

                const fastOptions = text.length > 20000 ? { fastDeadlineMs: 30000, maxLines: 80 } : undefined;
                const ok = await translateGridCells(text, translatedCells, targetLang, fastOptions);
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
        TranslationService.translate(title, 'ja').then(result => {
            if (!result || result === title) return;
            if (token !== titleTranslationToken.value) return;
            mediaTitle.value = result; // Replace title directly
        }).catch(() => {});
        return;
    }

    if (!translateMode.value) return;

    const targetLang = I18n.lang === 'zh' ? 'zh-CN' : I18n.lang;
    TranslationService.translate(title, targetLang).then(result => {
        if (!result || result === title) return;
        if (token !== titleTranslationToken.value) return;
        translatedTitle.value = result;
    }).catch(() => {});
}

// ── Preloading ───────────────────────────────────────────────────────────────

function preloadAdjacentImages(): void {
    if (currentMediaType.value !== 'image') return;

    for (let delta = -2; delta <= 3; delta++) {
        if (delta === 0) continue;
        const idx = currentMediaIndex.value + delta;
        if (idx >= 0 && idx < currentMediaList.value.length) {
            const item = currentMediaList.value[idx];
            if (!preloadedImages.has(item.hash)) {
                const img = new Image();
                img.referrerPolicy = 'no-referrer';
                img.src = getMediaUrl(item.hash, item);
                preloadedImages.set(item.hash, img);
            }
        }
    }

    // Background-preload rest if small gallery
    if (currentMediaList.value.length <= 20) {
        setTimeout(() => {
            currentMediaList.value.forEach((item) => {
                if (!preloadedImages.has(item.hash)) {
                    const img = new Image();
                    img.referrerPolicy = 'no-referrer';
                    img.src = getMediaUrl(item.hash, item);
                    preloadedImages.set(item.hash, img);
                }
            });
        }, 500);
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

function startAutoRecovery(item: MediaFile, wrapper: HTMLElement): void {
    stopRecovery();
    const url = getMediaUrl(item.hash, item);
    const RETRY_DELAY = 5000;

    recoveryTimeout = window.setTimeout(() => {
        if (!isActive.value) return;
        const curItem = currentMediaList.value[currentMediaIndex.value];
        if (curItem.hash !== item.hash) return;

        const img = new Image();
        img.referrerPolicy = 'no-referrer';
        img.onload = () => {
            if (currentMediaList.value[currentMediaIndex.value].hash === item.hash) {
                renderMedia(item, 'image');
            }
        };
        img.onerror = () => {
            if (currentMediaList.value[currentMediaIndex.value].hash === item.hash) {
                startAutoRecovery(item, wrapper);
            }
        };
        img.src = `${url}${url.includes('?') ? '&' : '?'}_recover=${Date.now()}`;
    }, RETRY_DELAY);
}

// ── Thumbnail strip ──────────────────────────────────────────────────────────

function scrollThumbnailIntoView(): void {
    nextTick(() => {
        const strip = thumbnailStripRef.value;
        const activeThumb = strip?.querySelector('.media-viewer-thumb-item.active') as HTMLElement;
        if (activeThumb) {
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
            window.open(url, '_blank');
        }
    }
}

function openRawMedia(): void {
    const item = currentMediaList.value[currentMediaIndex.value];
    if (!item) return;
    window.open(getMediaUrl(item.hash, item), '_blank');
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
        const origCell = document.createElement('pre');
        origCell.className = 'media-viewer-text-line';
        origCell.textContent = line || '\u00A0';

        const transCell = document.createElement('pre');
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
    const concurrency = TranslationService.hasLocalTranslator() ? 4 : 2;

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

async function ensurePdfJs(): Promise<unknown> {
    const anyWindow = globalThis as any;
    if (anyWindow.pdfjsLib) return anyWindow.pdfjsLib;

    if (!pdfjsLoadPromise) {
        pdfjsLoadPromise = new Promise((resolve) => {
            const script = document.createElement('script');
            script.src = PDFJS_CDN;
            script.async = true;
            script.onload = () => resolve((globalThis as any).pdfjsLib || null);
            script.onerror = () => resolve(null);
            document.head.appendChild(script);
        });
    }

    const lib = await pdfjsLoadPromise;
    if (!lib) return null;

    try {
        (lib as any).GlobalWorkerOptions.workerSrc = PDFJS_WORKER_CDN;
    } catch { /* ignore */ }

    return lib;
}

async function extractPdfText(url: string): Promise<string | null> {
    const pdfjs = await ensurePdfJs() as Record<string, any> | null;
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

            for (const item of (content.items || []) as Array<{ str?: string; hasEOL?: boolean }>) {
                if (item.str) currentLine += item.str;
                if (item.hasEOL) {
                    if (currentLine.trim()) lines.push(currentLine.trim());
                    currentLine = '';
                }
            }
            if (currentLine.trim()) lines.push(currentLine.trim());

            // Split any remaining long lines at sentence boundaries (CJK: 。！？)
            // so each grid cell stays within translation model limits
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

    if (type !== 'video' && !document.body.classList.contains('asmr-fullscreen-active')) minimizePlayer();

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

    const list: MediaFile[] = urls.map((url, i) => ({
        hash: `__external_${i}`,
        title: url.split('/').pop() || `image_${i + 1}`,
        type: 'image',
        mediaStreamUrl: url,
    }));

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
    errorMessage.value = 'Failed to resolve media URL';
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

onUnmounted(() => {
    document.removeEventListener('keydown', handleKeydown);
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
    stopSlideshow();
    stopRecovery();
    preloadedImages.clear();

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
                                aria-label="Zoom out"
                                title="Zoom out (-)"
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
                                title="Zoom level"
                                @input.stop="onZoomSlider"
                            >
                            <button
                                class="media-viewer-action media-viewer-zoom-in"
                                :class="{ disabled: isZoomInDisabled }"
                                aria-label="Zoom in"
                                title="Zoom in (+)"
                                @click.stop="zoomIn"
                            >
                                <span class="material-icons">add</span>
                            </button>
                            <div class="media-viewer-zoom-indicator">{{ zoomPercent }}</div>
                            <button
                                class="media-viewer-action media-viewer-zoom-reset"
                                aria-label="Reset zoom"
                                title="Reset zoom (0)"
                                @click.stop="resetZoom"
                            >
                                <span class="material-icons">fit_screen</span>
                            </button>
                        </div>

                        <button
                            class="media-viewer-action media-viewer-fullscreen"
                            aria-label="Toggle fullscreen"
                            title="Fullscreen (F)"
                            @click.stop="toggleFullscreen"
                        >
                            <span class="material-icons">{{ isFullscreen ? 'fullscreen_exit' : 'fullscreen' }}</span>
                        </button>
                        <button
                            class="media-viewer-action media-viewer-download"
                            aria-label="Download"
                            title="Download"
                            @click.stop="downloadCurrentMedia"
                        >
                            <span class="material-icons">download</span>
                        </button>
                        <button
                            class="media-viewer-action media-viewer-raw"
                            aria-label="Open raw"
                            title="Open raw image in new tab"
                            @click.stop="openRawMedia"
                        >
                            <span class="material-icons">open_in_new</span>
                        </button>
                        <button
                            class="media-viewer-action media-viewer-close"
                            aria-label="Close"
                            title="Close (Esc)"
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
                            aria-label="Previous"
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
                            <div class="media-viewer-error-sub">Retrying...</div>
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
                            aria-label="Next"
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
                            v-if="currentMediaType === 'image'"
                            :src="getThumbnailUrl(item)"
                            :alt="item.title"
                            loading="lazy"
                            referrerpolicy="no-referrer"
                        >
                        <span v-else class="material-icons">{{ getThumbnailIcon(currentMediaType) }}</span>
                    </button>
                </div>
            </div>
        </div>
    </Teleport>
</template>
