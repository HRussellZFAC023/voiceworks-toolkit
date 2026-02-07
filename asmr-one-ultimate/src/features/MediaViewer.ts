/**
 * MediaViewer 2.1 - Enhanced image/video preview for work tree
 *
 * Features:
 * - Thumbnail grid in work tree with lazy loading
 * - Modern lightbox with smooth transitions
 * - Keyboard navigation (arrows, escape)
 * - Touch swipe support for mobile
 * - Image preloading for fast navigation
 * - Counter showing current position (X / Y)
 * - Enhanced zoom with drag/pan and zoom levels
 * - Mouse wheel zoom support
 */

import { KikoeruApp } from '../types/store';
import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { Logger, Config } from '../core/Utils';
import { I18n } from '../core/Config';
import { CentralObserver } from '../core/CentralObserver';
import { WorkService } from '../services/WorkService';
import { TrackItem, TrackFolder } from '../types/api';
import { gmRequest, retryWithBackoff } from '../infrastructure/HttpClient';
import { TranslationService } from '../services/TranslationService';
import { MediaLightbox } from './media/MediaLightbox';
import { ThumbnailManager } from './media/ThumbnailManager';
import type { DragState, MediaFile, TouchState, WorkTreeComponent } from './media/types';

declare const unsafeWindow: Window & typeof globalThis;

const globalWindow = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) as Window & {
    __ASMR_MEDIA_VIEWER__?: MediaViewer;
};

// File extensions
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'];
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v'];
const PDF_EXTENSIONS = ['.pdf'];
const TEXT_EXTENSIONS = ['.txt', '.md', '.log', '.nfo', '.csv', '.json', '.srt', '.ass', '.vtt', '.lrc'];

// Zoom constraints
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 5;
const ZOOM_STEP = 0.05; // 5% increments as requested

// Translation batching
const TRANSLATE_BATCH_MAX_CHARS = 0; // 0 = no per-batch limit
const TRANSLATE_TOTAL_MAX_CHARS = 0; // 0 = no total cap
const PDF_TEXT_MAX_PAGES = Infinity; // Infinity = no page limit
const PDFJS_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.js';
const PDFJS_WORKER_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.js';

export class MediaViewer {
    private static _instance: MediaViewer | null = null;
    private bridge: KikoeruBridge;
    private modal: HTMLElement | null = null;
    private workTreeHooked = false;
    private folderWatcherSetup = false;
    private activeRequestId = 0;
    private titleTranslationToken = 0;
    private lightbox: MediaLightbox;
    private thumbnailManager: ThumbnailManager;

    // Lightbox state
    private currentMediaIndex = 0;
    private currentMediaList: MediaFile[] = [];
    private currentMediaType: 'image' | 'video' | 'pdf' | 'text' = 'image';
    private touchState: TouchState | null = null;
    private recoveryTimeout: number | undefined;

    // Auto-slideshow state
    private slideshowTimer: ReturnType<typeof setInterval> | null = null;
    private slideshowPaused = false;

    // Zoom state
    private zoomLevel = 1;
    private dragState: DragState = {
        isDragging: false,
        didDrag: false,
        startX: 0,
        startY: 0,
        scrollLeft: 0,
        scrollTop: 0
    };

    // Preloading
    private preloadedImages: Map<string, HTMLImageElement> = new Map();
    private thumbnailCache: Map<string, string> = new Map();
    private pdfjsLoadPromise: Promise<unknown> | null = null;

    // Bound event handlers (for cleanup)
    private boundHandleKeydown: (e: KeyboardEvent) => void;
    private boundHandleWheel: (e: WheelEvent) => void;
    private boundHandleMouseDown: (e: MouseEvent) => void;
    private boundHandleMouseMove: (e: MouseEvent) => void;
    private boundHandleMouseUp: (e: MouseEvent) => void;
    private boundDelegatedClick: (e: MouseEvent) => void;
    private delegatedClickInstalled = false;
    private playerWatcher: (() => void) | undefined;
    private routeCleanupUnsubscribe: (() => void) | undefined;

    private constructor() {
        this.bridge = KikoeruBridge.getInstance();
        this.boundHandleKeydown = this.handleKeydown.bind(this);
        this.boundHandleWheel = this.handleWheel.bind(this);
        this.boundHandleMouseDown = this.handleMouseDown.bind(this);
        this.boundHandleMouseMove = this.handleMouseMove.bind(this);
        this.boundHandleMouseUp = this.handleMouseUp.bind(this);
        this.boundDelegatedClick = this.handleDelegatedClick.bind(this);
        this.lightbox = new MediaLightbox({
            getModal: () => this.modal,
            setModal: (modal) => { this.modal = modal; },
            hideModal: () => this.hideModal(),
            navigateMedia: (direction) => this.navigateMedia(direction),
            zoomIn: () => this.zoomIn(),
            zoomOut: () => this.zoomOut(),
            resetZoom: () => this.resetZoom(),
            setZoom: (level) => this.setZoom(level),
            toggleFullscreen: () => this.toggleFullscreen(),
            downloadCurrentMedia: () => this.downloadCurrentMedia(),
            openRawMedia: () => this.openRawMedia(),
            handleTouchStart: (e) => this.handleTouchStart(e),
            handleTouchMove: (e) => this.handleTouchMove(e),
            handleTouchEnd: (e) => this.handleTouchEnd(e),
            getBoundHandleKeydown: () => this.boundHandleKeydown,
            getBoundHandleWheel: () => this.boundHandleWheel,
            getBoundHandleMouseDown: () => this.boundHandleMouseDown,
            getBoundHandleMouseMove: () => this.boundHandleMouseMove,
            getBoundHandleMouseUp: () => this.boundHandleMouseUp,
        });
        this.thumbnailManager = new ThumbnailManager({
            getModal: () => this.modal,
            findWorkTreeElement: () => this.findWorkTreeElement(),
            findWorkTreeComponent: () => this.findWorkTreeComponent(),
            getWorkIdFromUrl: () => this.getWorkIdFromUrl(),
            flattenTracksResponse: (tracks) => this.flattenTracksResponse(tracks),
            getWorkTreeTree: () => this.getWorkTreeTree(),
            getFileExtension: (fileName) => this.getFileExtension(fileName),
            isImage: (ext) => this.isImage(ext),
            isVideo: (ext) => this.isVideo(ext),
            getMediaUrl: (hash, fileData) => this.getMediaUrl(hash, fileData),
            thumbnailCache: this.thumbnailCache,
        });
    }

    public static getInstance(): MediaViewer {
        if (!MediaViewer._instance) {
            MediaViewer._instance = new MediaViewer();
        }
        MediaViewer._instance.bridge = KikoeruBridge.getInstance();
        return MediaViewer._instance;
    }

    /**
     * Open the lightbox with external image URLs (e.g. DLsite sample images).
     */
    public showExternalImages(urls: string[], startIndex = 0): void {
        if (!urls.length) return;
        this.lightbox.ensureModal();

        // Increment ID to cancel any pending showMedia/populateMediaList results
        this.activeRequestId++;

        this.currentMediaList = urls.map((url, i) => ({
            hash: `__external_${i}`,
            title: url.split('/').pop() || `image_${i + 1}`,
            type: 'image',
            mediaStreamUrl: url
        }));
        this.currentMediaIndex = Math.min(startIndex, urls.length - 1);
        this.currentMediaType = 'image';
        this.zoomLevel = 1;

        const item = this.currentMediaList[this.currentMediaIndex];
        this.renderMedia(item, 'image');
        this.updateCounter();
        this.updateNavButtons();
        this.updateZoomControls();
        this.renderThumbnailStrip();
        this.preloadAdjacentImages();

        this.modal!.classList.add('active');
        document.body.classList.add('media-viewer-open');
        document.body.style.overflow = 'hidden';

        this.minimizePlayer();

        // Start auto-slideshow for image galleries
        this.slideshowPaused = false;
        this.startSlideshow();
    }

    enable(): void {
        Logger.log('[MediaViewer] Enabling v2.1...');

        this.lightbox.ensureModal();
        this.installDelegatedClick();
        this.hookWorkTree();
        this.setupObserver();
        this.setupPlayerWatcher();
        this.setupRouteCleanup();
        Logger.log('[MediaViewer] Enabled');
    }

    disable(): void {
        CentralObserver.unregister('MediaViewer');
        if (this.delegatedClickInstalled) {
            document.removeEventListener('click', this.boundDelegatedClick, true);
            this.delegatedClickInstalled = false;
        }
        if (this.playerWatcher) {
            this.playerWatcher();
            this.playerWatcher = undefined;
        }
        if (this.routeCleanupUnsubscribe) {
            this.routeCleanupUnsubscribe();
            this.routeCleanupUnsubscribe = undefined;
        }
        this.modal?.remove();
        this.modal = null;
        this.workTreeHooked = false;
        this.folderWatcherSetup = false;
        this.preloadedImages.clear();
        this.thumbnailCache.clear();
    }

    // =========================================================================
    // Delegated Click (immediate interception, no Vue patching needed)
    // =========================================================================

    private installDelegatedClick(): void {
        if (this.delegatedClickInstalled) return;
        document.addEventListener('click', this.boundDelegatedClick, true);
        this.delegatedClickInstalled = true;
        Logger.debug('[MediaViewer] Delegated click handler installed');
    }

    private handleDelegatedClick(e: MouseEvent): void {
        // Intercept clicks inside #work-tree or .asmr-flat-panel
        const target = e.target as HTMLElement;
        if (!target) return;

        const workTreeEl = this.findWorkTreeElement();
        const flatPanelEl = document.querySelector('.asmr-flat-panel');
        const inWorkTree = workTreeEl?.contains(target);
        const inFlatPanel = flatPanelEl?.contains(target);
        if (!inWorkTree && !inFlatPanel) return;

        // Find the closest .q-item ancestor (the clickable row)
        const qItem = target.closest('.q-item') as HTMLElement | null;
        if (!qItem) return;

        // Extract filename from .q-item__label
        const labelEl = qItem.querySelector('.q-item__label');
        if (!labelEl) return;

        let title = labelEl.textContent?.trim() || '';
        // Strip translation suffix like "file.jpg (Translation)"
        const translationMatch = title.match(/^(.+?)\s*\([^)]+\)$/);
        if (translationMatch) title = translationMatch[1].trim();
        if (!title) return;

        const ext = this.getFileExtension(title);
        const isImg = this.isImage(ext);
        const isVid = this.isVideo(ext);
        const isPdf = this.isPdf(ext);
        const isText = this.isText(ext);
        if (!isImg && !isVid && !isPdf && !isText) return;

        // This is a media file click — intercept it
        e.stopPropagation();
        e.preventDefault();

        let hash = '';
        let itemData: MediaFile | null = null;

        // Check for stashed hash (most reliable, set by injectThumbnails or FlatPanel)
        if (!itemData) {
            hash = qItem.dataset.asmrHash || qItem.dataset.asmrFlatHash || '';
            if (hash) {
                // If we have a hash, we can build a minimal MediaFile
                itemData = { hash, title, type: isImg ? 'image' : isVid ? 'video' : isPdf ? 'pdf' : 'text' };
            }
        }

        // Try extracting media stream URL from thumbnail as another fallback
        if (!itemData) {
            const thumbImg = qItem.querySelector('.media-thumb') as HTMLImageElement;
            if (thumbImg?.src && thumbImg.classList.contains('loaded')) {
                // If it's a loaded thumbnail, its SRC is a valid stream URL!
                itemData = {
                    hash: `__delegated_stream_${Date.now()}`,
                    title,
                    mediaStreamUrl: thumbImg.src,
                    type: isImg ? 'image' : isVid ? 'video' : 'text'
                };
            }
        }

        // For native tree items, try Vue component data
        if (!itemData) {
            const vueEl = qItem as any;
            if (vueEl.__vue__) {
                // Check multiple common locations for item data
                const candidates = [
                    vueEl.__vue__.$attrs?.item,
                    vueEl.__vue__.item,
                    vueEl.__vue__.$props?.item,
                    vueEl.__vue__.file,
                    vueEl.__vue__.$props?.file,
                    vueEl.__vue__.node,
                    vueEl.__vue__.$props?.node
                ];

                for (const candidate of candidates) {
                    if (candidate && candidate.hash) {
                        itemData = candidate;
                        hash = candidate.hash;
                        break;
                    }
                }
            }
        }

        // Fallback: try to find item from WorkTree component's fatherFolder using robust matching
        if (!itemData) {
            const workTree = this.findWorkTreeComponent();
            const folder = (workTree as any)?.fatherFolder ||
                (workTree as any)?.$data?.fatherFolder || [];

            if (folder.length > 0) {
                const match = this.findMatchingMediaItem({ hash: '', title }, folder);
                if (match) {
                    itemData = match;
                    hash = match.hash || '';
                }
            }
        }

        if (!itemData) {
            itemData = { hash: hash || `__delegated_${Date.now()}`, title };
        }

        const mediaType = isImg ? 'image' : isVid ? 'video' : isPdf ? 'pdf' : 'text';
        Logger.debug(`[MediaViewer] Delegated click intercepted: ${title} (${mediaType}), hash=${itemData.hash}, source=${inFlatPanel ? 'flat-panel' : 'work-tree'}`);
        const workTreeContext = this.findWorkTreeComponent() || undefined;
        this.showMedia(itemData, mediaType, workTreeContext).catch(err => {
            Logger.error('[MediaViewer] Delegated showMedia failed:', err);
        });
    }

    // =========================================================================
    // WorkTree Hook
    // =========================================================================

    private hookWorkTree(): void {
        if (this.workTreeHooked) return;

        const workTree = this.findWorkTreeComponent();
        if (workTree) {
            Logger.debug('[MediaViewer] Found WorkTree component, patching...');
            this.patchWorkTree(workTree);
        } else {
            Logger.debug('[MediaViewer] WorkTree component not found yet');
        }
    }

    private findWorkTreeComponent(): WorkTreeComponent | null {
        return this.bridge.findComponent(
            (vm: KikoeruApp) => vm.$options?.name === 'WorkTree'
        ) as WorkTreeComponent | null;
    }

    /**
     * Find the work-tree DOM element, trying multiple strategies:
     * 1. By ID (fast path — works when the site assigns id="work-tree")
     * 2. Via the WorkTree Vue component's root $el (fallback)
     */
    private findWorkTreeElement(): HTMLElement | null {
        return document.getElementById('work-tree')
            || (this.findWorkTreeComponent() as any)?.$el as HTMLElement
            || null;
    }

    private patchWorkTree(workTree: WorkTreeComponent): void {
        const self = this;
        const original = workTree.onClickItem;
        // Keep reference to the WorkTree component
        const workTreeRef = workTree;

        if (!original) {
            Logger.warn('[MediaViewer] WorkTree.onClickItem not found');
            return;
        }

        // Mark as hooked to prevent double-patching
        if ((workTree as any).__mediaViewerPatched) {
            return;
        }
        (workTree as any).__mediaViewerPatched = true;

        workTree.onClickItem = function (this: WorkTreeComponent, item: MediaFile) {
            const ext = self.getFileExtension(item.title);

            // Log available properties for debugging
            Logger.debug(`[MediaViewer] WorkTree ref fatherFolder: ${workTreeRef.fatherFolder?.length || 0} items`);

            if (self.isImage(ext) || item.type === 'image') {
                // Pass the workTreeRef instead of 'this' for more reliable access
                self.showMedia(item, 'image', workTreeRef);
                return;
            }

            if (self.isVideo(ext)) {
                // Lightbox shows muted video; native player handles audio
                self.showMedia(item, 'video', workTreeRef);
                self.playVideoInNativePlayer(item, workTreeRef);
                return;
            }

            if (self.isPdf(ext)) {
                self.showMedia(item, 'pdf', workTreeRef);
                return;
            }

            if (self.isText(ext)) {
                self.showMedia(item, 'text', workTreeRef);
                return;
            }

            return original.call(this, item);
        };

        this.workTreeHooked = true;
        Logger.debug('[MediaViewer] WorkTree patched successfully');
    }

    /**
     * Load a video file into the native audio player by dispatching to the store.
     * The native <audio> element can play the audio track from .mp4 files.
     * We build a queue that includes both audio and video files from the current folder.
     */
    private playVideoInNativePlayer(item: MediaFile, workTreeRef: WorkTreeComponent): void {
        const store = this.bridge.store;
        if (!store.commit) return;

        const allItems = workTreeRef.fatherFolder || [];
        // Build queue: include audio items + video items (promoted to type 'audio')
        const queue = allItems.filter(f => {
            if ((f as any).type === 'audio') return true;
            const fExt = this.getFileExtension(f.title);
            return this.isVideo(fExt);
        }).map(f => ({ ...f, type: 'audio' as const }));

        const index = queue.findIndex(f => f.hash === item.hash);
        if (index < 0) return;

        store.commit('AudioPlayer/SET_QUEUE', { queue, index });
        store.commit('AudioPlayer/PLAY');
        Logger.debug(`[MediaViewer] Playing video in native player: ${item.title} (${index + 1}/${queue.length})`);
    }

    private setupObserver(): void {
        CentralObserver.register('MediaViewer', () => {
            if (!this.findWorkTreeElement()) return;
            setTimeout(() => {
                this.hookWorkTree();
                this.thumbnailManager.injectThumbnails();
                this.watchFolderNavigation();
            }, 100);
        }, 500);
    }

    private watchFolderNavigation(): void {
        if (this.folderWatcherSetup) return;

        const workTree = this.findWorkTreeComponent();
        if (!workTree) return;

        if (workTree.$watch) {
            workTree.$watch('path', () => {
                // Use Vue's nextTick to wait for DOM update, then inject
                const doInject = () => this.thumbnailManager.injectThumbnails();
                if (typeof workTree.$nextTick === 'function') {
                    workTree.$nextTick(() => setTimeout(doInject, 50));
                } else {
                    setTimeout(doInject, 200);
                }
            }, { deep: true });
            this.folderWatcherSetup = true;
        }
    }

    /**
     * Clean up DOM modifications before Vue processes route changes.
     * Prevents "insertBefore" errors caused by Vue's vDOM encountering
     * unexpected nodes injected by the userscript.
     */
    private setupRouteCleanup(): void {
        if (this.routeCleanupUnsubscribe) return;
        const router = this.bridge.router;
        if (!router?.beforeEach) return;

        this.routeCleanupUnsubscribe = router.beforeEach((_to, _from, next) => {
            this.thumbnailManager.clearStaleThumbnails();
            // Reset patching state so WorkTree gets re-patched on the next work page
            this.workTreeHooked = false;
            this.folderWatcherSetup = false;
            next();
        });
    }

    private setupPlayerWatcher(): void {
        if (this.playerWatcher) return;

        // Watch for player expansion (hide going from true -> false)
        this.playerWatcher = this.bridge.watch(
            (state) => ({
                hide: state.AudioPlayer?.hide,
                playing: state.AudioPlayer?.playing,
                currentTime: state.AudioPlayer?.currentTime,
                src: state.AudioPlayer?.currentTrack?.src || state.AudioPlayer?.currentPlayingFile?.src
            }),
            (val, oldVal) => {
                // 1. If player is now expanded (hide: true -> false) AND it was previously minimized
                if (val.hide === false && oldVal?.hide === true) {
                    // Check if lightbox is open (modal has active class)
                    if (this.modal?.classList.contains('active')) {
                        Logger.debug('[MediaViewer] Player expanded, closing lightbox');
                        this.hideModal();
                    }
                }

                // 2. Sync video playback state if lightbox is open
                if (this.modal?.classList.contains('active') && this.currentMediaType === 'video') {
                    const video = this.modal.querySelector('video');
                    if (video) {
                        // Sync playing state
                        if (val.playing && video.paused) {
                            video.play().catch(() => { });
                        } else if (!val.playing && !video.paused) {
                            video.pause();
                        }

                        // Sync current time (if significantly out of sync, e.g. > 2s)
                        if (typeof val.currentTime === 'number' && Math.abs(video.currentTime - val.currentTime) > 2) {
                            video.currentTime = val.currentTime;
                        }
                    }
                }
            }
        );
    }

    // =========================================================================
    // Touch Handling (Swipe)
    // =========================================================================

    private handleTouchStart(e: TouchEvent): void {
        if (this.zoomLevel > 1 || e.touches.length !== 1) return;

        this.touchState = {
            startX: e.touches[0].clientX,
            startY: e.touches[0].clientY,
            startTime: Date.now()
        };
    }

    private handleTouchMove(e: TouchEvent): void {
        if (!this.touchState || this.zoomLevel > 1) return;

        const deltaX = e.touches[0].clientX - this.touchState.startX;
        const deltaY = e.touches[0].clientY - this.touchState.startY;

        // If horizontal movement is greater than vertical, prevent scroll
        if (Math.abs(deltaX) > Math.abs(deltaY)) {
            e.preventDefault();
        }
    }

    private handleTouchEnd(e: TouchEvent): void {
        if (!this.touchState || this.zoomLevel > 1) return;

        const touch = e.changedTouches[0];
        const deltaX = touch.clientX - this.touchState.startX;
        const deltaY = touch.clientY - this.touchState.startY;
        const deltaTime = Date.now() - this.touchState.startTime;

        // Swipe detection: horizontal movement > 50px, within 300ms, and more horizontal than vertical
        if (Math.abs(deltaX) > 50 && deltaTime < 300 && Math.abs(deltaX) > Math.abs(deltaY)) {
            if (deltaX > 0) {
                this.navigateMedia(-1); // Swipe right = previous
            } else {
                this.navigateMedia(1); // Swipe left = next
            }
        }

        this.touchState = null;
    }

    // =========================================================================
    // Mouse Drag for Pan (when zoomed)
    // =========================================================================

    private handleMouseDown(e: MouseEvent): void {
        if (this.zoomLevel <= 1) return;

        const wrapper = this.modal?.querySelector('.media-viewer-media-wrapper') as HTMLElement;
        if (!wrapper) return;

        this.dragState = {
            isDragging: true,
            didDrag: false,
            startX: e.clientX,
            startY: e.clientY,
            scrollLeft: wrapper.scrollLeft,
            scrollTop: wrapper.scrollTop
        };

        wrapper.style.cursor = 'grabbing';
        e.preventDefault();
    }

    private handleMouseMove(e: MouseEvent): void {
        if (!this.dragState.isDragging) return;

        const wrapper = this.modal?.querySelector('.media-viewer-media-wrapper') as HTMLElement;
        if (!wrapper) return;

        const deltaX = e.clientX - this.dragState.startX;
        const deltaY = e.clientY - this.dragState.startY;

        // Mark as actually dragged if moved more than 5px (prevents click-to-zoom on drag)
        if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) {
            this.dragState.didDrag = true;
        }

        wrapper.scrollLeft = this.dragState.scrollLeft - deltaX;
        wrapper.scrollTop = this.dragState.scrollTop - deltaY;
    }

    private handleMouseUp(): void {
        if (!this.dragState.isDragging) return;

        const wrapper = this.modal?.querySelector('.media-viewer-media-wrapper') as HTMLElement;
        if (wrapper) {
            wrapper.style.cursor = this.zoomLevel > 1 ? 'grab' : 'default';
        }

        this.dragState.isDragging = false;
        // Reset didDrag after a short delay to prevent click handler from firing
        setTimeout(() => {
            this.dragState.didDrag = false;
        }, 50);
    }

    // =========================================================================
    // Mouse Wheel Zoom (Cursor Relative)
    // =========================================================================

    private handleWheel(e: WheelEvent): void {
        if (!this.modal?.classList.contains('active')) return;
        if (this.currentMediaType !== 'image') return;

        // When zoomed in, allow normal scrolling unless Ctrl is held
        // Ctrl+wheel = zoom, plain wheel when zoomed = scroll
        const isZoomed = this.zoomLevel !== 1;
        if (isZoomed && !e.ctrlKey) {
            // Let the browser handle native scrolling within the zoomed wrapper
            return;
        }

        e.preventDefault();

        // Calculate cursor position relative to the image
        const wrapper = this.modal?.querySelector('.media-viewer-media-wrapper') as HTMLElement;
        const img = wrapper?.querySelector('.media-viewer-image') as HTMLImageElement;

        if (!wrapper || !img) return;

        // Get mouse position relative to wrapper view
        const rect = wrapper.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // Current scroll offset
        const scrollLeft = wrapper.scrollLeft;
        const scrollTop = wrapper.scrollTop;

        // Mouse position in full scale coordinates
        const contentX = scrollLeft + mouseX;
        const contentY = scrollTop + mouseY;

        // Current zoom
        const startZoom = this.zoomLevel;

        // Determine new zoom
        // Use 5% increments, but respect min/max
        let newZoom = startZoom + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
        newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newZoom));
        newZoom = Math.round(newZoom * 100) / 100;

        if (newZoom === startZoom) return;

        // Calculate scale ratio
        const scale = newZoom / startZoom;

        // Update zoom level
        this.setZoom(newZoom, false); // Pass false to skip centering logic in setZoom

        // Adjust scroll to keep mouse on same content point
        // New content coords = old content coords * scale
        // New scroll = new content coords - mouse viewing position
        requestAnimationFrame(() => {
            const newScrollLeft = (contentX * scale) - mouseX;
            const newScrollTop = (contentY * scale) - mouseY;

            wrapper.scrollLeft = newScrollLeft;
            wrapper.scrollTop = newScrollTop;
        });
    }

    // =========================================================================
    // Zoom Controls
    // =========================================================================

    private zoomIn(): void {
        if (this.currentMediaType !== 'image') return;
        this.setZoom(Math.min(ZOOM_MAX, this.zoomLevel + ZOOM_STEP));
    }

    private zoomOut(): void {
        if (this.currentMediaType !== 'image') return;
        this.setZoom(Math.max(ZOOM_MIN, this.zoomLevel - ZOOM_STEP));
    }

    private resetZoom(): void {
        this.setZoom(1);
    }

    private setZoom(level: number, autoCenter: boolean = true): void {
        // Round to 2 decimals to avoid floats like 1.05000000001
        this.zoomLevel = Math.round(level * 100) / 100;
        this.zoomLevel = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.zoomLevel));

        const wrapper = this.modal?.querySelector('.media-viewer-media-wrapper') as HTMLElement;
        const img = wrapper?.querySelector('.media-viewer-image') as HTMLImageElement;
        const indicator = this.modal?.querySelector('.media-viewer-zoom-indicator');
        const slider = this.modal?.querySelector('.media-viewer-zoom-slider') as HTMLInputElement;

        if (img && wrapper) {
            const isZoomed = this.zoomLevel !== 1; // Any zoom level other than 1 is "zoomed" logic
            const wasZoomed = wrapper.classList.contains('zoomed');

            // Store current scroll position as percentage (for center zoom)
            let scrollXPercent = 0.5;
            let scrollYPercent = 0.5;
            if (autoCenter && wasZoomed && wrapper.scrollWidth > wrapper.clientWidth) {
                scrollXPercent = (wrapper.scrollLeft + wrapper.clientWidth / 2) / wrapper.scrollWidth;
            }
            if (autoCenter && wasZoomed && wrapper.scrollHeight > wrapper.clientHeight) {
                scrollYPercent = (wrapper.scrollTop + wrapper.clientHeight / 2) / wrapper.scrollHeight;
            }

            // Use width/height for zoom
            // Calculate the "fitted" size (what CSS would display at zoom=1) as the base,
            // then multiply by zoomLevel. This prevents the jump from CSS-fitted size
            // to naturalWidth * zoomLevel which are very different for large images.
            if (img.naturalWidth && img.naturalHeight) {
                if (this.zoomLevel === 1) {
                    img.style.width = '';
                    img.style.height = '';
                    img.style.maxWidth = '100%';
                    img.style.maxHeight = '100%';
                    wrapper.classList.remove('zoomed');
                } else {
                    // Calculate the "fit to container" base size
                    // This is what the image would be at zoom=1 with object-fit: contain
                    const containerWidth = wrapper.clientWidth;
                    const containerHeight = wrapper.clientHeight;
                    const aspectRatio = img.naturalWidth / img.naturalHeight;
                    let fittedWidth: number;
                    let fittedHeight: number;

                    if (containerWidth / containerHeight > aspectRatio) {
                        // Container is wider than image - height is the constraint
                        fittedHeight = containerHeight;
                        fittedWidth = containerHeight * aspectRatio;
                    } else {
                        // Container is taller than image - width is the constraint
                        fittedWidth = containerWidth;
                        fittedHeight = containerWidth / aspectRatio;
                    }

                    const scaledWidth = fittedWidth * this.zoomLevel;
                    const scaledHeight = fittedHeight * this.zoomLevel;

                    img.style.width = `${scaledWidth}px`;
                    img.style.height = `${scaledHeight}px`;
                    img.style.maxWidth = 'none';
                    img.style.maxHeight = 'none';
                    wrapper.classList.add('zoomed');
                }
            }

            img.style.cursor = isZoomed ? 'grab' : 'default';

            if (autoCenter) {
                if (this.zoomLevel === 1) {
                    // Reset scroll position when returning to 1x
                    wrapper.scrollLeft = 0;
                    wrapper.scrollTop = 0;
                } else {
                    // Center the image in the viewport
                    requestAnimationFrame(() => {
                        const newScrollX = (scrollXPercent * wrapper.scrollWidth) - (wrapper.clientWidth / 2);
                        const newScrollY = (scrollYPercent * wrapper.scrollHeight) - (wrapper.clientHeight / 2);
                        wrapper.scrollLeft = Math.max(0, newScrollX);
                        wrapper.scrollTop = Math.max(0, newScrollY);
                    });
                }
            }
        }

        if (indicator) {
            indicator.textContent = `${Math.round(this.zoomLevel * 100)}%`;
        }

        if (slider) {
            slider.value = String(Math.round(this.zoomLevel * 100));
        }

        // Update button states
        const zoomOutBtn = this.modal?.querySelector('.media-viewer-zoom-out') as HTMLElement;
        const zoomInBtn = this.modal?.querySelector('.media-viewer-zoom-in') as HTMLElement;
        zoomOutBtn?.classList.toggle('disabled', this.zoomLevel <= ZOOM_MIN);
        zoomInBtn?.classList.toggle('disabled', this.zoomLevel >= ZOOM_MAX);
    }

    // =========================================================================
    // Fullscreen
    // =========================================================================

    private toggleFullscreen(): void {
        if (!this.modal) return;

        const fullscreenBtn = this.modal.querySelector('.media-viewer-fullscreen .material-icons');
        const isFullscreen = this.modal.classList.contains('fullscreen-mode');

        if (!isFullscreen) {
            this.modal.classList.add('fullscreen-mode');
            if (fullscreenBtn) fullscreenBtn.textContent = 'fullscreen_exit';
        } else {
            this.modal.classList.remove('fullscreen-mode');
            if (fullscreenBtn) fullscreenBtn.textContent = 'fullscreen';
        }
    }

    // =========================================================================
    // Media Display
    // =========================================================================

    private async showMedia(item: MediaFile, type: 'image' | 'video' | 'pdf' | 'text', workTreeContext?: WorkTreeComponent): Promise<void> {
        // Ensure modal exists (fixes race condition where click fires before enable() completes)
        this.lightbox.ensureModal();
        if (!this.modal) return;

        // Show the modal IMMEDIATELY with the clicked item (don't block on async data)
        this.currentMediaList = [item];
        this.currentMediaIndex = 0;
        this.currentMediaType = type;
        this.zoomLevel = 1;

        // CRITICAL: Clean up ANY DOM modifications in WorkTree before triggering a store action
        // minimizing the player will cause a layout change and WorkTree re-render.
        // If we leave our thumbnails in, Vue's virtual DOM patching will fail with NotFoundError.
        this.thumbnailManager.clearStaleThumbnails();

        // Track the initial hash to detect if populateMediaList resolves a better one
        const initialHash = item.hash;
        const hasFakeHash = !initialHash || initialHash.startsWith('__delegated_');

        if (hasFakeHash) {
            // Don't render with a fake hash — it will 404.
            // Show the modal with loader only; render after resolution.
            Logger.debug(`[MediaViewer] Deferring render for fake hash: ${initialHash}`);
            const loader = this.modal.querySelector('.media-viewer-loader');
            loader?.classList.add('visible');
            const wrapper = this.modal.querySelector('.media-viewer-media-wrapper') as HTMLElement;
            if (wrapper) wrapper.innerHTML = '';
            const titleEl = this.modal.querySelector('.media-viewer-title');
            if (titleEl) this.updateTitle(titleEl as HTMLElement, item.title);
        } else {
            this.renderMedia(item, type);
        }
        this.updateCounter();
        this.updateNavButtons();
        this.updateZoomControls();
        this.renderThumbnailStrip();

        this.modal.classList.add('active');
        document.body.classList.add('media-viewer-open');
        document.body.style.overflow = 'hidden';

        // Only minimize player for images; for videos we want both active
        if (type !== 'video') {
            this.minimizePlayer();
        }

        // Now fetch the full media list in the background for navigation
        // If we had a fake hash, render once we have the real data
        const requestId = ++this.activeRequestId;
        await this.populateMediaList(item, type, requestId, workTreeContext);

        if (requestId !== this.activeRequestId) {
            Logger.debug(`[MediaViewer] Aborting showMedia for request ${requestId} (current is ${this.activeRequestId})`);
            return;
        }

        if (hasFakeHash) {
            // Find resolved item using the enhanced matching logic
            const resolvedItem = this.findMatchingMediaItem(item, this.currentMediaList);

            if (resolvedItem && resolvedItem.hash && !resolvedItem.hash.startsWith('__delegated_')) {
                // Update index to point to the resolved item
                const resolvedIndex = this.currentMediaList.indexOf(resolvedItem);
                if (resolvedIndex >= 0) this.currentMediaIndex = resolvedIndex;
                Logger.debug(`[MediaViewer] Rendering with resolved hash: ${resolvedItem.hash} (was ${initialHash})`);
                this.renderMedia(resolvedItem, type);
                this.updateCounter();
                this.updateNavButtons();
                this.renderThumbnailStrip();
                this.preloadAdjacentImages();
            } else {
                // Resolution failed — log what we have for debugging
                Logger.warn(`[MediaViewer] Could not resolve real hash for "${item.title}"`);
                const normalizedItemTitle = this.normalizeMatchString(item.title);
                Logger.debug(`[MediaViewer] Normalized title: "${normalizedItemTitle}"`);
                Logger.debug(`[MediaViewer] Available titles (first 10):`, this.currentMediaList.slice(0, 10).map(f => f.title));
                const loader = this.modal?.querySelector('.media-viewer-loader');
                loader?.classList.remove('visible');
                const wrapper = this.modal?.querySelector('.media-viewer-media-wrapper') as HTMLElement;
                if (wrapper) {
                    wrapper.innerHTML = `<div class="media-viewer-error">
                        <span class="material-icons">broken_image</span>
                        <span>Failed to resolve media URL</span>
                    </div>`;
                }
            }
        } else {
            // Even if hash wasn't fake, check if we found a "better" version of the item (e.g. with mediaStreamUrl)
            // populateMediaList updates this.currentMediaIndex to point to the matched item in the new list
            const currentItem = this.currentMediaList[this.currentMediaIndex];

            // If the new item has a direct stream URL but the initial one didn't, we should re-render
            const initialHadStream = !!(item.mediaStreamUrl || item.media_stream_url);
            const currentHasStream = !!(currentItem.mediaStreamUrl || currentItem.media_stream_url);

            if (currentHasStream && !initialHadStream) {
                Logger.debug(`[MediaViewer] Re-rendering enriched item with stream URL: ${currentItem.title}`);
                this.renderMedia(currentItem, type);
                // Also update other UI elements since the object reference changed
                this.renderThumbnailStrip();
                this.preloadAdjacentImages();
            }
        }

        // Start auto-slideshow now that the full media list is populated
        this.slideshowPaused = false;
        this.startSlideshow();
    }

    private async populateMediaList(item: MediaFile, type: 'image' | 'video' | 'pdf' | 'text', requestId: number, workTreeContext?: WorkTreeComponent): Promise<void> {
        let fatherFolder: MediaFile[] = [];

        // Try multiple ways to access the folder contents (synchronous sources first)
        if (workTreeContext) {
            const ctx = workTreeContext as any;
            if (Array.isArray(ctx.fatherFolder) && ctx.fatherFolder.length > 0) {
                fatherFolder = ctx.fatherFolder;
            } else if (ctx.$data?.fatherFolder && Array.isArray(ctx.$data.fatherFolder)) {
                fatherFolder = ctx.$data.fatherFolder;
            } else if (ctx._data?.fatherFolder && Array.isArray(ctx._data.fatherFolder)) {
                fatherFolder = ctx._data.fatherFolder;
            }
            if (fatherFolder.length === 0 && Array.isArray(ctx.tree)) {
                fatherFolder = this.flattenTracksResponse(ctx.tree);
            } else if (fatherFolder.length === 0 && Array.isArray(ctx.$data?.tree)) {
                fatherFolder = this.flattenTracksResponse(ctx.$data.tree);
            }
        }

        if (fatherFolder.length === 0) {
            const workTree = this.findWorkTreeComponent();
            if (workTree) {
                const wt = workTree as any;
                fatherFolder = wt.fatherFolder || wt.$data?.fatherFolder || wt._data?.fatherFolder || [];
                if (fatherFolder.length === 0 && Array.isArray(wt.tree)) {
                    fatherFolder = this.flattenTracksResponse(wt.tree);
                } else if (fatherFolder.length === 0 && Array.isArray(wt.$data?.tree)) {
                    fatherFolder = this.flattenTracksResponse(wt.$data.tree);
                }
            }
        }

        // Async fallback: Fetch from WorkService
        if (fatherFolder.length === 0) {
            const workId = this.getWorkIdFromUrl();
            if (workId) {
                try {
                    Logger.debug(`[MediaViewer] Fetching tracks for work ${workId} from WorkService...`);
                    const tracks = await WorkService.getTracks(workId);

                    // Check if request is still active after async call
                    if (requestId !== this.activeRequestId) {
                        Logger.debug(`[MediaViewer] Aborting populateMediaList tracks fetch for request ${requestId}`);
                        return;
                    }

                    if (Array.isArray(tracks)) {
                        fatherFolder = this.flattenTracksResponse(tracks);
                        Logger.debug(`[MediaViewer] Fetched ${fatherFolder.length} tracks from API`);
                    } else {
                        Logger.warn('[MediaViewer] Tracks is not an array:', typeof tracks);
                    }
                } catch (err) {
                    Logger.warn('[MediaViewer] Failed to fetch tracks from API:', err);
                }
            }
        }

        if (fatherFolder.length === 0) {
            const tree = this.getWorkTreeTree();
            if (tree?.length) {
                fatherFolder = this.flattenTracksResponse(tree);
                Logger.debug(`[MediaViewer] Fallback tree flatten -> ${fatherFolder.length} tracks`);
            }
        }

        // Final fallback: scan DOM for media items
        if (fatherFolder.length === 0) {
            fatherFolder = this.scanDomForMediaItems(type);
            Logger.debug(`[MediaViewer] DOM scan found ${fatherFolder.length} items`);
        }

        if (fatherFolder.length === 0 || requestId !== this.activeRequestId) return; // Nothing more to add or clobbered

        Logger.debug(`[MediaViewer] fatherFolder has ${fatherFolder.length} items`);

        // Filter to only media of the requested type
        const mediaList = fatherFolder.filter((f: MediaFile) => {
            const ext = this.getFileExtension(f.title);
            if (type === 'image') {
                return this.isImage(ext) || f.type === 'image';
            }
            if (type === 'video') {
                return this.isVideo(ext);
            }
            if (type === 'pdf') {
                return this.isPdf(ext);
            }
            return this.isText(ext);
        });

        if (mediaList.length === 0) return;

        // Update the list and find current item position
        this.currentMediaList = mediaList;

        // Find matching item using unified helper
        const matchedItem = this.findMatchingMediaItem(item, mediaList);

        if (matchedItem) {
            this.currentMediaIndex = mediaList.indexOf(matchedItem);
        } else {
            // Only insert the original item if it has a real hash
            if (item.hash && !item.hash.startsWith('__delegated_')) {
                this.currentMediaList.unshift(item);
            }
            this.currentMediaIndex = 0;
        }

        Logger.debug(`[MediaViewer] Updated list: index ${this.currentMediaIndex} of ${this.currentMediaList.length}`);

        // Update UI with full list info
        this.updateCounter();
        this.updateNavButtons();
        this.renderThumbnailStrip();
        this.preloadAdjacentImages();
    }

    private renderMedia(item: MediaFile, type: 'image' | 'video' | 'pdf' | 'text'): void {
        const wrapper = this.modal?.querySelector('.media-viewer-media-wrapper') as HTMLElement;
        const titleEl = this.modal?.querySelector('.media-viewer-title');
        const loader = this.modal?.querySelector('.media-viewer-loader');

        if (!wrapper) return;

        this.stopRecovery();

        wrapper.innerHTML = '';
        wrapper.classList.remove('zoomed');
        loader?.classList.add('visible');

        const url = this.getMediaUrl(item.hash, item);

        if (type === 'image') {
            const img = document.createElement('img');
            img.alt = item.title;
            img.className = 'media-viewer-image';
            img.draggable = false;
            img.style.cursor = 'default';
            // Reset any inline styles from previous zoom
            img.style.width = '';
            img.style.height = '';
            img.style.height = '';
            img.style.maxWidth = '100%';
            img.style.maxHeight = '100%';

            // Check if we have preloaded this image
            const preloaded = this.preloadedImages.get(item.hash);
            if (preloaded && preloaded.complete) {
                img.src = preloaded.src;
                loader?.classList.remove('visible');
            } else {
                img.onload = () => loader?.classList.remove('visible');

                let retryCount = 0;
                const maxRetries = 3;
                img.onerror = () => {
                    retryCount++;
                    if (retryCount <= maxRetries) {
                        const delay = Math.pow(2, retryCount - 1) * 1000; // 1s, 2s, 4s backoff
                        Logger.debug(`[MediaViewer] Image retry ${retryCount}/${maxRetries} for ${item.title} in ${delay}ms`);
                        setTimeout(() => {
                            if (img.isConnected) {
                                const separator = url.includes('?') ? '&' : '?';
                                img.src = `${url}${separator}_r=${retryCount}`;
                            }
                        }, delay);
                    } else {
                        loader?.classList.remove('visible');
                        wrapper.innerHTML = `<div class="media-viewer-error">
                            <span class="material-icons">broken_image</span>
                            <span>Failed to load image</span>
                            <div class="media-viewer-error-sub">Retrying...</div>
                        </div>`;
                        this.startAutoRecovery(item, wrapper);
                    }
                };

                img.src = url;
            }

            // Click to toggle zoom - Removed as requested, using drag only
            img.addEventListener('click', (e) => {
                e.stopPropagation();
            });

            wrapper.appendChild(img);
        } else if (type === 'video') {
            const video = document.createElement('video');
            video.src = url;
            video.controls = true;
            video.autoplay = true;
            video.muted = true; // Audio comes from native player
            video.className = 'media-viewer-video';
            video.onloadeddata = () => loader?.classList.remove('visible');

            // Sync lightbox video with native audio player
            video.onplay = () => {
                const audio = document.querySelector('audio');
                if (audio?.paused) audio.play().catch(() => {});
            };
            video.onpause = () => {
                const audio = document.querySelector('audio');
                if (audio && !audio.paused) audio.pause();
            };
            video.onseeked = () => {
                const audio = document.querySelector('audio');
                if (audio) audio.currentTime = video.currentTime;
            };
            // Keep lightbox video in sync with native audio time
            const syncInterval = setInterval(() => {
                const audio = document.querySelector('audio');
                if (!audio || !video.isConnected) { clearInterval(syncInterval); return; }
                if (Math.abs(video.currentTime - audio.currentTime) > 0.5) {
                    video.currentTime = audio.currentTime;
                }
            }, 500);

            let retryCount = 0;
            const maxRetries = 3;
            video.onerror = () => {
                // Ignore if error is during source clearing for modal hide
                if (video.src === '' || video.src === window.location.href) return;

                retryCount++;
                if (retryCount <= maxRetries) {
                    const delay = Math.pow(2, retryCount - 1) * 1000;
                    Logger.debug(`[MediaViewer] Video retry ${retryCount}/${maxRetries} for ${item.title} in ${delay}ms`);
                    setTimeout(() => {
                        if (video.isConnected) {
                            const separator = url.includes('?') ? '&' : '?';
                            video.src = `${url}${separator}_r=${retryCount}`;
                            video.load();
                            video.play().catch(() => { });
                        }
                    }, delay);
                } else {
                    loader?.classList.remove('visible');
                    wrapper.innerHTML = `<div class="media-viewer-error">
                        <span class="material-icons">videocam_off</span>
                        <span>Failed to load video</span>
                    </div>`;
                }
            };
            video.addEventListener('click', (e) => e.stopPropagation());

            // Apply persisted playback rate
            const savedRate = Number(Config.get('playbackRate')) || 1.0;
            if (savedRate !== 1.0) {
                video.playbackRate = savedRate;
            }

            wrapper.appendChild(video);
        } else if (type === 'pdf') {
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
                iframe.onload = () => loader?.classList.remove('visible');
                iframe.onerror = () => {
                    loader?.classList.remove('visible');
                    wrapper.innerHTML = `<div class="media-viewer-error">
                        <span class="material-icons">picture_as_pdf</span>
                        <span>${I18n.t('mediaViewerPdfLoadFailed')}</span>
                    </div>`;
                };
                pdfContainer.appendChild(iframe);
            };

            this.extractPdfText(url).then((text) => {
                if (!text) {
                    renderPdfFallback();
                    return;
                }

                const originalPre = document.createElement('pre');
                originalPre.className = 'media-viewer-text';
                originalPre.textContent = text;

                if (Config.get('translateMode')) {
                    const targetLang = I18n.lang === 'zh' ? 'zh-CN' : I18n.lang;
                    const { grid, translatedCells } = this.buildTranslationGrid(text);
                    pdfContainer.innerHTML = '';
                    pdfContainer.appendChild(grid);
                    loader?.classList.remove('visible');

                    const fastOptions = text.length > 20000 ? { fastDeadlineMs: 900, maxLines: 80 } : undefined;
                    this.translateGridCells(text, translatedCells, targetLang, fastOptions).then((ok) => {
                        if (!ok) {
                            pdfContainer.innerHTML = '';
                            pdfContainer.appendChild(originalPre);
                        }
                    }).catch(() => renderPdfFallback());
                } else {
                    pdfContainer.innerHTML = '';
                    pdfContainer.appendChild(originalPre);
                    loader?.classList.remove('visible');
                }
            }).catch(() => renderPdfFallback());
        } else {
            const originalPre = document.createElement('pre');
            originalPre.className = 'media-viewer-text';
            originalPre.textContent = '';

            const loadText = async () => {
                try {
                    const res = await retryWithBackoff(
                        () => gmRequest({ url, responseType: 'text' }),
                        { attempts: 2, backoffMs: 500 }
                    );
                    const rawText = String(res.response || '');
                    const maxChars = 400000;
                    const text = rawText.length > maxChars ? rawText.slice(0, maxChars) : rawText;
                    originalPre.textContent = text;

                    let note: HTMLDivElement | null = null;
                    if (rawText.length > maxChars) {
                        note = document.createElement('div');
                        note.className = 'media-viewer-text-note';
                        note.textContent = I18n.format('mediaViewerTextTruncated', { count: Math.round(maxChars / 1000) });
                    }

                    if (Config.get('translateMode')) {
                        const targetLang = I18n.lang === 'zh' ? 'zh-CN' : I18n.lang;
                        const { grid, translatedCells } = this.buildTranslationGrid(text);

                        wrapper.innerHTML = '';
                        wrapper.appendChild(grid);
                        if (note) wrapper.appendChild(note);

                        const fastOptions = text.length > 20000 ? { fastDeadlineMs: 900, maxLines: 80 } : undefined;
                        const ok = await this.translateGridCells(text, translatedCells, targetLang, fastOptions);
                        if (!ok) {
                            wrapper.innerHTML = '';
                            wrapper.appendChild(originalPre);
                            if (note) wrapper.appendChild(note);
                        }
                    }

                    if (note && !note.isConnected) {
                        wrapper.appendChild(note);
                    }

                    loader?.classList.remove('visible');
                } catch (err) {
                    Logger.warn('[MediaViewer] Text load failed:', err);
                    loader?.classList.remove('visible');
                    wrapper.innerHTML = `<div class="media-viewer-error">
                        <span class="material-icons">description</span>
                        <span>${I18n.t('mediaViewerTextLoadFailed')}</span>
                    </div>`;
                }
            };

            wrapper.appendChild(originalPre);
            loadText().catch(() => { });
        }

        if (titleEl) {
            this.updateTitle(titleEl as HTMLElement, item.title);
        }
    }

    private updateCounter(): void {
        const currentEl = this.modal?.querySelector('.media-viewer-current');
        const totalEl = this.modal?.querySelector('.media-viewer-total');

        if (currentEl) currentEl.textContent = String(this.currentMediaIndex + 1);
        if (totalEl) totalEl.textContent = String(this.currentMediaList.length);
    }

    private updateNavButtons(): void {
        const prevBtn = this.modal?.querySelector('.media-viewer-prev') as HTMLElement;
        const nextBtn = this.modal?.querySelector('.media-viewer-next') as HTMLElement;
        const hasMultiple = this.currentMediaList.length > 1;

        if (prevBtn) {
            prevBtn.classList.toggle('hidden', !hasMultiple);
            prevBtn.classList.toggle('disabled', this.currentMediaIndex <= 0);
        }
        if (nextBtn) {
            nextBtn.classList.toggle('hidden', !hasMultiple);
            nextBtn.classList.toggle('disabled', this.currentMediaIndex >= this.currentMediaList.length - 1);
        }
    }

    private updateZoomControls(): void {
        const zoomControlsContainer = this.modal?.querySelector('.media-viewer-zoom-controls') as HTMLElement;
        const isImage = this.currentMediaType === 'image';

        if (zoomControlsContainer) {
            zoomControlsContainer.style.display = isImage ? '' : 'none';
        }

        if (isImage) {
            const indicator = this.modal?.querySelector('.media-viewer-zoom-indicator');
            const slider = this.modal?.querySelector('.media-viewer-zoom-slider') as HTMLInputElement;
            if (indicator) {
                indicator.textContent = '100%';
            }
            if (slider) {
                slider.value = '100';
            }
        }
    }

    private renderThumbnailStrip(): void {
        const strip = this.modal?.querySelector('.media-viewer-thumbnails');
        if (!strip || this.currentMediaList.length <= 1) {
            if (strip) strip.classList.add('hidden');
            return;
        }

        strip.classList.remove('hidden');
        strip.innerHTML = '';

        this.currentMediaList.forEach((item, index) => {
            const thumb = document.createElement('button');
            thumb.className = 'media-viewer-thumb-item';
            if (index === this.currentMediaIndex) {
                thumb.classList.add('active');
            }
            thumb.setAttribute('aria-label', item.title);
            thumb.title = item.title;

            if (this.currentMediaType === 'image') {
                const img = document.createElement('img');
                img.src = this.getMediaUrl(item.hash, item);
                img.alt = item.title;
                img.loading = 'lazy';
                thumb.appendChild(img);
            } else {
                const icon = this.currentMediaType === 'video'
                    ? 'videocam'
                    : this.currentMediaType === 'pdf'
                        ? 'picture_as_pdf'
                        : 'description';
                thumb.innerHTML = `<span class="material-icons">${icon}</span>`;
            }

            thumb.addEventListener('click', (e) => {
                e.stopPropagation();
                this.currentMediaIndex = index;
                this.resetZoom();
                this.renderMedia(item, this.currentMediaType);
                this.updateCounter();
                this.updateNavButtons();
                this.updateThumbnailStripSelection();
                this.preloadAdjacentImages();
            });

            strip.appendChild(thumb);
        });

        // Scroll active thumbnail into view
        this.scrollThumbnailIntoView();
    }

    private updateThumbnailStripSelection(): void {
        const strip = this.modal?.querySelector('.media-viewer-thumbnails');
        if (!strip) return;

        strip.querySelectorAll('.media-viewer-thumb-item').forEach((thumb, index) => {
            thumb.classList.toggle('active', index === this.currentMediaIndex);
        });

        this.scrollThumbnailIntoView();
    }

    private scrollThumbnailIntoView(): void {
        const strip = this.modal?.querySelector('.media-viewer-thumbnails');
        const activeThumb = strip?.querySelector('.media-viewer-thumb-item.active') as HTMLElement;
        if (activeThumb) {
            activeThumb.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }
    }

    private preloadAdjacentImages(): void {
        if (this.currentMediaType !== 'image') return;

        // Eagerly preload: 3 ahead, 2 behind current for fast navigation
        const indicesToPreload: number[] = [];
        for (let delta = -2; delta <= 3; delta++) {
            if (delta === 0) continue;
            const idx = this.currentMediaIndex + delta;
            if (idx >= 0 && idx < this.currentMediaList.length) {
                indicesToPreload.push(idx);
            }
        }

        indicesToPreload.forEach(index => {
            const item = this.currentMediaList[index];
            if (!this.preloadedImages.has(item.hash)) {
                const img = new Image();
                img.src = this.getMediaUrl(item.hash, item);
                this.preloadedImages.set(item.hash, img);
            }
        });

        // Background-preload remaining images in the list (low priority)
        if (this.currentMediaList.length <= 20) {
            setTimeout(() => {
                this.currentMediaList.forEach((item) => {
                    if (!this.preloadedImages.has(item.hash)) {
                        const img = new Image();
                        img.src = this.getMediaUrl(item.hash, item);
                        this.preloadedImages.set(item.hash, img);
                    }
                });
            }, 500);
        }
    }

    // ------------------------------------------------------------------
    // Auto-slideshow (lightbox mode)
    // ------------------------------------------------------------------

    private startSlideshow(): void {
        this.stopSlideshow();
        if (this.slideshowPaused) return;
        if (this.currentMediaList.length < 2) return;
        if (this.currentMediaType !== 'image') return;
        if (!Config.get('galleryAutoSlideshow')) return;

        const interval = Math.max(2, Number(Config.get('galleryAutoSlideshowInterval')) || 6);
        this.slideshowTimer = setInterval(() => {
            if (this.currentMediaList.length < 2) {
                this.stopSlideshow();
                return;
            }
            // Wrap around to first image
            const nextIndex = (this.currentMediaIndex + 1) % this.currentMediaList.length;
            if (nextIndex === this.currentMediaIndex) return;
            this.currentMediaIndex = nextIndex;
            const item = this.currentMediaList[nextIndex];
            this.resetZoom();
            this.renderMedia(item, this.currentMediaType);
            this.updateCounter();
            this.updateNavButtons();
            this.updateThumbnailStripSelection();
            this.preloadAdjacentImages();
        }, interval * 1000);
        Logger.debug('[MediaViewer] Slideshow started, interval=', interval, 's');
    }

    private stopSlideshow(): void {
        if (this.slideshowTimer !== null) {
            clearInterval(this.slideshowTimer);
            this.slideshowTimer = null;
        }
    }

    private pauseSlideshow(): void {
        if (!this.slideshowPaused) {
            this.slideshowPaused = true;
            this.stopSlideshow();
            Logger.debug('[MediaViewer] Slideshow paused by user navigation');
        }
    }

    private navigateMedia(delta: number): void {
        // Manual navigation pauses auto-slideshow
        this.pauseSlideshow();

        const newIndex = this.currentMediaIndex + delta;
        if (newIndex < 0 || newIndex >= this.currentMediaList.length) return;

        this.stopRecovery();
        this.currentMediaIndex = newIndex;
        const item = this.currentMediaList[newIndex];
        Logger.debug(`[MediaViewer] Navigate ${delta > 0 ? 'next' : 'prev'}: ${item.title} (${newIndex + 1}/${this.currentMediaList.length})`);

        // Reset zoom when navigating
        this.resetZoom();

        this.renderMedia(item, this.currentMediaType);
        this.updateCounter();
        this.updateNavButtons();
        this.updateThumbnailStripSelection();
        this.preloadAdjacentImages();
    }

    private async downloadCurrentMedia(): Promise<void> {
        const item = this.currentMediaList[this.currentMediaIndex];
        if (!item) return;

        const url = this.getMediaUrl(item.hash, item);

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
            // Fallback to fetch, then open in new tab
            try {
                const response = await fetch(url, { credentials: 'include' });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                triggerDownload(await response.blob());
            } catch (err) {
                Logger.warn('[MediaViewer] Download failed:', err);
                window.open(url, '_blank');
            }
        }
    }

    private openRawMedia(): void {
        const item = this.currentMediaList[this.currentMediaIndex];
        if (!item) return;

        const url = this.getMediaUrl(item.hash, item);
        window.open(url, '_blank');
    }

    private hideModal(): void {
        if (!this.modal) return;

        // Stop slideshow
        this.stopSlideshow();

        // Stop any playing video
        const video = this.modal.querySelector('video');
        if (video) {
            video.pause();
            video.src = '';
        }

        // Cancel any pending background population requests
        this.activeRequestId++;

        this.stopRecovery();
        this.modal.classList.remove('active');
        document.body.classList.remove('media-viewer-open');
        this.resetZoom();
        document.body.style.overflow = '';

        // Restore thumbnails in the list (delayed slightly to allow Vue to settle if it re-renders)
        setTimeout(() => this.thumbnailManager.injectThumbnails(), 200);
    }

    private handleKeydown(e: KeyboardEvent): void {
        if (!this.modal?.classList.contains('active')) return;

        switch (e.key) {
            case 'Escape':
                this.hideModal();
                e.preventDefault();
                break;
            case 'ArrowLeft':
            case 'a':
            case 'A':
            case 'ArrowUp':
            case 'w':
            case 'W':
                this.navigateMedia(-1);
                e.preventDefault();
                e.stopPropagation();
                break;
            case 'ArrowRight':
            case 'd':
            case 'D':
            case 'ArrowDown':
            case 's':
            case 'S':
                this.navigateMedia(1);
                e.preventDefault();
                e.stopPropagation();
                break;
            case '+':
            case '=':
                this.zoomIn();
                e.preventDefault();
                e.stopPropagation();
                break;
            case '-':
            case '_':
                this.zoomOut();
                e.preventDefault();
                e.stopPropagation();
                break;
            case '0':
                this.resetZoom();
                e.preventDefault();
                e.stopPropagation();
                break;
            case 'f':
            case 'F':
                this.toggleFullscreen();
                e.preventDefault();
                e.stopPropagation();
                break;
            case 'Home':
                if (this.currentMediaIndex !== 0) {
                    this.currentMediaIndex = 0;
                    this.resetZoom();
                    this.renderMedia(this.currentMediaList[0], this.currentMediaType);
                    this.updateCounter();
                    this.updateNavButtons();
                    this.updateThumbnailStripSelection();
                }
                e.preventDefault();
                e.stopPropagation();
                break;
            case 'End':
                if (this.currentMediaIndex !== this.currentMediaList.length - 1) {
                    this.currentMediaIndex = this.currentMediaList.length - 1;
                    this.resetZoom();
                    this.renderMedia(this.currentMediaList[this.currentMediaIndex], this.currentMediaType);
                    this.updateCounter();
                    this.updateNavButtons();
                    this.updateThumbnailStripSelection();
                }
                e.preventDefault();
                e.stopPropagation();
                break;
        }
    }

    private stopRecovery(): void {
        if (this.recoveryTimeout) {
            clearTimeout(this.recoveryTimeout);
            this.recoveryTimeout = undefined;
        }
    }

    private startAutoRecovery(item: MediaFile, wrapper: HTMLElement): void {
        this.stopRecovery();

        Logger.debug(`[MediaViewer] Starting auto-recovery for ${item.title}`);

        const url = this.getMediaUrl(item.hash, item);
        const RETRY_DELAY = 5000;

        this.recoveryTimeout = window.setTimeout(() => {
            if (!this.modal?.classList.contains('active')) return;
            // Verify we are still looking at the same item
            const currentItem = this.currentMediaList[this.currentMediaIndex];
            if (currentItem.hash !== item.hash) return;

            Logger.debug(`[MediaViewer] Auto-recovery attempt for ${item.title}`);

            const img = new Image();

            img.onload = () => {
                Logger.debug(`[MediaViewer] Auto-recovery successful for ${item.title}`);
                if (this.currentMediaList[this.currentMediaIndex].hash === item.hash) {
                    this.renderMedia(item, 'image');
                }
            };

            img.onerror = () => {
                Logger.debug(`[MediaViewer] Auto-recovery failed for ${item.title}, scheduling next attempt`);
                if (this.currentMediaList[this.currentMediaIndex].hash === item.hash) {
                    this.startAutoRecovery(item, wrapper);
                }
            };

            img.src = `${url}${url.includes('?') ? '&' : '?'}_recover=${Date.now()}`;
        }, RETRY_DELAY);
    }

    // =========================================================================
    // Utility Methods
    // =========================================================================

    /**
     * Scan the DOM work-tree to find all media items when Vue state isn't accessible.
     * This is a fallback for when fatherFolder isn't available.
     * Improved fallback to search effectively.
     */
    private scanDomForMediaItems(type: 'image' | 'video' | 'pdf' | 'text'): MediaFile[] {
        const workTreeEl = this.findWorkTreeElement();
        if (!workTreeEl) return [];

        const items: MediaFile[] = [];
        // Use a broader selector to catch items
        const qItems = workTreeEl.querySelectorAll('.q-item');

        qItems.forEach((qItem) => {
            // Check for title in multiple potential locations
            // .q-item__label is standard, but sometimes it's inside main section directly
            const labelEl = qItem.querySelector('.q-item__label') || qItem.querySelector('.q-item__section--main');

            if (!labelEl) return;

            let title = labelEl.textContent?.trim() || '';

            // Clean up title (remove translations like "file.jpg (Translation)")
            const translationMatch = title.match(/^(.+?)\s*\([^)]+\)$/);
            if (translationMatch) {
                title = translationMatch[1].trim();
            }

            if (!title) return;

            const ext = this.getFileExtension(title);
            let isMedia = false;
            if (type === 'image') isMedia = this.isImage(ext);
            else if (type === 'video') isMedia = this.isVideo(ext);
            else if (type === 'pdf') isMedia = this.isPdf(ext);
            else isMedia = this.isText(ext);
            if (!isMedia) return;

            // Try to get the Vue component data from the DOM element
            const vueEl = qItem as any;
            let hash = '';

            // Try to extract hash from Vue component
            if (vueEl.__vue__) {
                const candidates = [
                    vueEl.__vue__.$attrs?.item,
                    vueEl.__vue__.item,
                    vueEl.__vue__.$props?.item,
                    vueEl.__vue__.file,
                    vueEl.__vue__.$props?.file,
                    vueEl.__vue__.node,
                    vueEl.__vue__.$props?.node
                ];

                for (const candidate of candidates) {
                    if (candidate && candidate.hash) {
                        hash = candidate.hash;
                        break;
                    }
                }
            }

            // If no hash from Vue, try to generate one from the title (less reliable)
            if (!hash) {
                // Look for any data attributes that might contain the hash
                const dataHash = qItem.getAttribute('data-hash');
                if (dataHash) {
                    hash = dataHash;
                } else if ((vueEl as any).__vue__?.id) {
                    // Sometimes ID is the hash
                    hash = (vueEl as any).__vue__.id;
                }
            }

            // If we still don't have a hash, we need to get it from the WorkTree component
            // by matching the title using robust fuzzy logic
            if (!hash) {
                const workTree = this.findWorkTreeComponent();
                const folder = (workTree as any)?.fatherFolder ||
                    (workTree as any)?.$data?.fatherFolder || [];

                if (folder.length > 0) {
                    const match = this.findMatchingMediaItem({ hash: '', title }, folder);
                    if (match?.hash) {
                        hash = match.hash;
                    }
                }
            }

            if (hash) {
                // Deduplicate
                if (!items.find(i => i.hash === hash)) {
                    items.push({ hash, title, type });
                }
            }
        });

        return items;
    }

    private getFileExtension(filename: string): string {
        const match = filename.match(/\.[^.]+$/);
        return match ? match[0].toLowerCase() : '';
    }

    private isImage(ext: string): boolean {
        return IMAGE_EXTENSIONS.includes(ext);
    }

    private isVideo(ext: string): boolean {
        return VIDEO_EXTENSIONS.includes(ext);
    }

    private isPdf(ext: string): boolean {
        return PDF_EXTENSIONS.includes(ext);
    }

    private isText(ext: string): boolean {
        return TEXT_EXTENSIONS.includes(ext);
    }

    private getMediaUrl(hash: string, item?: MediaFile): string {
        const token = localStorage.getItem('jwt-token') || '';

        const appendToken = (url: string) => {
            // External URLs or already absolute URLs should not have a token appended by us
            if (url.startsWith('http') || url.startsWith('//')) return url;

            // Only append token to internal API routes that we know require it
            if (url.startsWith('/api/')) {
                const separator = url.includes('?') ? '&' : '?';
                return `${url}${separator}token=${token}`;
            }

            return url;
        };

        // If we have a direct stream URL from the item, use it
        if (item?.mediaStreamUrl) {
            return appendToken(item.mediaStreamUrl);
        }
        if (item?.media_stream_url) {
            return appendToken(item.media_stream_url);
        }

        // Fallback: use hash. 
        // If hash looks like a path (contains /), it might be a direct media path
        if (hash.includes('/')) {
            // If it starts with media/stream, it's likely a direct stream that doesn't want /api prefix
            if (hash.startsWith('media/stream/') || hash.startsWith('/media/stream/')) {
                const path = hash.startsWith('/') ? hash : `/${hash}`;
                return appendToken(path);
            }
            // Otherwise, it might be a workId/trackId style hash for the API
            return appendToken(`/api/media/stream/${hash}`);
        }

        // Standard hash ID
        return appendToken(`/api/media/stream/${hash}`);
    }


    // =========================================================================
    // Player Control
    // =========================================================================

    private minimizePlayer(): void {
        // Use Vuex store to collapse expanded player to bar form
        const store = this.bridge.store;
        if (!store?.state?.AudioPlayer) return;

        if (!store.state.AudioPlayer.hide) {
            Logger.debug('[MediaViewer] Auto-minimizing audio player via store');
            store.commit?.('AudioPlayer/TOGGLE_HIDE');
        }
    }

    private getWorkIdFromUrl(): string | null {
        // Handle HashRouter: #/work/RJ123456
        const hashMatch = window.location.hash.match(/work\/([a-zA-Z0-9]+)/);
        if (hashMatch) return hashMatch[1];

        // Handle path: /work/RJ123456
        const pathMatch = window.location.pathname.match(/work\/([a-zA-Z0-9]+)/);
        if (pathMatch) return pathMatch[1];

        return null;
    }

    private flattenTracksResponse(nodes: (TrackFolder | TrackItem)[]): MediaFile[] {
        const result: MediaFile[] = [];

        // Early exit if nodes is not an array
        if (!Array.isArray(nodes)) {
            Logger.warn('[MediaViewer] flattenTracksResponse received non-array:', typeof nodes);
            return result;
        }

        const traverse = (items: (TrackFolder | TrackItem)[]) => {
            // Defensive check: ensure items is an array
            if (!Array.isArray(items)) {
                Logger.warn('[MediaViewer] traverse received non-array:', typeof items);
                return;
            }
            for (const item of items) {
                if (item.type === 'folder') {
                    if (item.children) traverse(item.children);
                } else {
                    // Map TrackItem to MediaFile
                    result.push({
                        hash: item.hash,
                        title: item.title,
                        type: item.type,
                        mediaStreamUrl: item.mediaStreamUrl || (item as any).media_stream_url,
                        media_stream_url: (item as any).media_stream_url
                    });
                }
            }
        };

        traverse(nodes);
        return result;
    }

    /**
     * Find a media item in the list that matches the target.
     * Uses robust fuzzy matching strategies.
     */
    private findMatchingMediaItem(target: MediaFile, list: MediaFile[]): MediaFile | undefined {
        // 1. Try Hash (if not fake)
        if (target.hash && !target.hash.startsWith('__delegated_')) {
            const match = list.find(f => f.hash === target.hash);
            if (match) return match;
        }

        // 2. Strict normalized comparison (extensions stripped, punc -> space)
        const normTarget = this.normalizeMatchString(target.title);
        let match = list.find(f => this.normalizeMatchString(f.title) === normTarget);
        if (match) return match;

        // 3. Original title exact match (fallback)
        match = list.find(f => f.title === target.title);
        if (match) return match;

        // 4. Containment (one includes the other)
        match = list.find(f => {
            const normF = this.normalizeMatchString(f.title);
            return (normF.length > 3 && normTarget.length > 3) &&
                (normF.includes(normTarget) || normTarget.includes(normF));
        });

        return match;
    }

    private getWorkTreeTree(): Array<TrackFolder | TrackItem> | null {
        const workTree = this.findWorkTreeComponent() as any;
        const tree = workTree?.tree || workTree?.$data?.tree;
        return Array.isArray(tree) ? tree : null;
    }

    private updateTitle(titleEl: HTMLElement, title: string): void {
        this.titleTranslationToken += 1;
        const token = this.titleTranslationToken;

        titleEl.classList.remove('asmr-translation-pair');
        titleEl.textContent = title;
        titleEl.dataset.asmrTitleSource = title;
        titleEl.dataset.asmrTitleTranslated = '';

        if (!Config.get('translateMode')) return;
        if (!/[\u3040-\u30ff\u4e00-\u9faf]/.test(title)) return;

        const targetLang = I18n.lang === 'zh' ? 'zh-CN' : I18n.lang;
        TranslationService.translate(title, targetLang).then(translated => {
            if (!translated || translated === title) return;
            if (token !== this.titleTranslationToken) return;
            if (titleEl.dataset.asmrTitleSource !== title) return;

            titleEl.classList.add('asmr-translation-pair');
            titleEl.textContent = '';

            const originalSpan = document.createElement('span');
            originalSpan.className = 'asmr-translation-original';
            originalSpan.textContent = title;

            const separator = document.createElement('span');
            separator.className = 'asmr-translation-sep';
            separator.textContent = ' · ';

            const translatedSpan = document.createElement('span');
            translatedSpan.className = 'asmr-translation-translated';
            translatedSpan.textContent = translated;

            titleEl.appendChild(originalSpan);
            titleEl.appendChild(separator);
            titleEl.appendChild(translatedSpan);
            titleEl.dataset.asmrTitleTranslated = translated;
        }).catch(() => { });
    }

    private async translateTextInBatches(text: string, targetLang: string): Promise<string> {
        const trimmed = text.trim();
        if (!trimmed) return text;

        const capped = TRANSLATE_TOTAL_MAX_CHARS > 0 ? trimmed.slice(0, TRANSLATE_TOTAL_MAX_CHARS) : trimmed;
        const chunks = TRANSLATE_BATCH_MAX_CHARS > 0
            ? this.splitTextByLength(capped, TRANSLATE_BATCH_MAX_CHARS)
            : this.splitTextIntoSentences(capped);
        if (chunks.length === 0) return text;

        const results = await TranslationService.translateBatch(chunks, targetLang);
        return results.join('\n');
    }

    /**
     * Build a two-column aligned grid: original lines left, translated right.
     * Single scrollbar, rows auto-size to the taller cell for alignment.
     */
    private buildTranslationGrid(text: string): { grid: HTMLElement; translatedCells: HTMLElement[] } {
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

    /**
     * Translate line-by-line, updating individual grid cells as translations arrive.
     * Returns true if at least one line was translated.
     */
    private async translateGridCells(
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

    private splitTextByLength(text: string, maxChars: number): string[] {
        const lines = text.split(/\r?\n/);
        const chunks: string[] = [];
        let current = '';

        for (const line of lines) {
            const candidate = current ? `${current}\n${line}` : line;
            if (candidate.length <= maxChars) {
                current = candidate;
                continue;
            }

            if (current) {
                chunks.push(current);
                current = '';
            }

            if (line.length > maxChars) {
                for (let i = 0; i < line.length; i += maxChars) {
                    chunks.push(line.slice(i, i + maxChars));
                }
            } else {
                current = line;
            }
        }

        if (current) chunks.push(current);
        return chunks;
    }

    private splitTextIntoSentences(text: string): string[] {
        const normalized = text.replace(/\r\n/g, '\n');
        const lines = normalized.split('\n');
        const chunks: string[] = [];

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
                chunks.push('');
                continue;
            }

            const sentences = trimmed.match(/[^.!?。！？]+[.!?。！？]?/g) || [trimmed];
            sentences.forEach(sentence => chunks.push(sentence.trim()));
        }

        return chunks;
    }

    private async ensurePdfJs(): Promise<unknown> {
        const anyWindow = globalThis as any;
        if (anyWindow.pdfjsLib) return anyWindow.pdfjsLib;

        if (!this.pdfjsLoadPromise) {
            this.pdfjsLoadPromise = new Promise((resolve) => {
                const script = document.createElement('script');
                script.src = PDFJS_CDN;
                script.async = true;
                script.onload = () => resolve((globalThis as any).pdfjsLib || null);
                script.onerror = () => resolve(null);
                document.head.appendChild(script);
            });
        }

        const lib = await this.pdfjsLoadPromise;
        if (!lib) return null;

        try {
            (lib as any).GlobalWorkerOptions.workerSrc = PDFJS_WORKER_CDN;
        } catch {
            // ignore
        }

        return lib;
    }

    private async extractPdfText(url: string): Promise<string | null> {
        const pdfjs = await this.ensurePdfJs() as Record<string, any> | null;
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
                const strings = (content.items || [])
                    .map((item: { str: string }) => item.str)
                    .filter((s: string) => s && s.trim().length > 0);
                if (strings.length) {
                    pages.push(strings.join(' '));
                }
            }

            return pages.join('\n\n');
        } catch (err) {
            Logger.warn('[MediaViewer] PDF text extraction failed:', err);
            return null;
        }
    }

    private normalizeMatchString(t: string): string {
        if (!t) return '';
        let s = t.normalize('NFC').toLowerCase();
        // Strip translation suffix like "(Translation)" or "(English)"
        s = s.replace(/\s*\([^)]+\)\s*$/, '');

        // Aggressively remove file extensions (2-5 alphanumerics, multiple segments)
        s = s.replace(/(\.[a-z0-9]{2,5})+$/, '');

        // Replace all punctuation AND underscores with spaces
        s = s.replace(/[\s\-_.]+/g, ' ');

        return s.trim();
    }
}
