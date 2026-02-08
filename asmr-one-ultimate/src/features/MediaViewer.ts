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

import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { Logger, Config } from '../core/Utils';
import { CentralObserver } from '../core/CentralObserver';
import type { KikoeruApp } from '../types';
import { WorkService } from '../services/WorkService';
import { TrackItem, TrackFolder } from '../types/api';
import { gmRequest, retryWithBackoff } from '../infrastructure/HttpClient';

declare const unsafeWindow: Window & typeof globalThis;

const globalWindow = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) as Window & {
    __ASMR_MEDIA_VIEWER__?: MediaViewer;
};

// File extensions
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'];
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v'];

// Zoom constraints
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 5;
const ZOOM_STEP = 0.05; // 5% increments as requested

interface MediaFile {
    hash: string;
    title: string;
    type?: string;
    mediaStreamUrl?: string;
    media_stream_url?: string;
}

interface TouchState {
    startX: number;
    startY: number;
    startTime: number;
}

interface DragState {
    isDragging: boolean;
    didDrag: boolean; // Track if actual dragging occurred (to prevent click)
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
}

interface WorkTreeComponent extends KikoeruApp {
    onClickItem: (item: any) => void;
    fatherFolder?: any[];
    path?: any[];
    $nextTick?: (callback: () => void) => void;
}

export class MediaViewer {
    private static _instance: MediaViewer | null = null;
    private bridge: KikoeruBridge;
    private modal: HTMLElement | null = null;
    private workTreeHooked = false;
    private folderWatcherSetup = false;
    private activeRequestId = 0;

    // Lightbox state
    private currentMediaIndex = 0;
    private currentMediaList: MediaFile[] = [];
    private currentMediaType: 'image' | 'video' = 'image';
    private touchState: TouchState | null = null;
    private recoveryTimeout: number | undefined;

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
    }

    static getInstance(): MediaViewer {
        if (globalWindow.__ASMR_MEDIA_VIEWER__) {
            MediaViewer._instance = globalWindow.__ASMR_MEDIA_VIEWER__;
            MediaViewer._instance.bridge = KikoeruBridge.getInstance();
            return MediaViewer._instance;
        }

        if (!MediaViewer._instance) {
            MediaViewer._instance = new MediaViewer();
            globalWindow.__ASMR_MEDIA_VIEWER__ = MediaViewer._instance;
        }
        return MediaViewer._instance;
    }

    /**
     * Open the lightbox with external image URLs (e.g. DLsite sample images).
     * These bypass the hash-based media stream and load directly from the URL.
     */
    public showExternalImages(urls: string[], startIndex = 0): void {
        if (!urls.length) return;
        if (!this.modal) this.createModal();

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
    }

    enable(): void {
        Logger.log('[MediaViewer] Enabling v2.1...');

        this.createModal();
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
        Logger.log('[MediaViewer] Delegated click handler installed');
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
        if (!isImg && !isVid) return;

        // This is a media file click — intercept it
        e.stopPropagation();
        e.preventDefault();

        let hash = '';
        let itemData: MediaFile | null = null;

        // For flat panel items, read hash from data attribute
        if (inFlatPanel) {
            hash = qItem.dataset.asmrFlatHash || '';
            if (hash) {
                itemData = { hash, title, type: isImg ? 'image' : 'video' };
            }
        }

        // For native tree items, try Vue component data
        if (!itemData) {
            const vueEl = qItem as any;
            if (vueEl.__vue__) {
                const vueItem = vueEl.__vue__.$attrs?.item || vueEl.__vue__?.item;
                if (vueItem) {
                    itemData = vueItem;
                    hash = vueItem.hash || '';
                }
            }
        }

        // Fallback: try to find item from WorkTree component's fatherFolder
        if (!hash) {
            const workTree = this.findWorkTreeComponent();
            if (workTree) {
                const folder = (workTree as any).fatherFolder ||
                    (workTree as any).$data?.fatherFolder || [];
                const match = folder.find((f: MediaFile) =>
                    f.title === title || f.title?.includes(title)
                );
                if (match) {
                    itemData = match;
                    hash = match.hash || '';
                }
            }
        }

        if (!itemData) {
            itemData = { hash: hash || `__delegated_${Date.now()}`, title };
        }

        Logger.log(`[MediaViewer] Delegated click intercepted: ${title} (${isImg ? 'image' : 'video'}), hash=${itemData.hash}, source=${inFlatPanel ? 'flat-panel' : 'work-tree'}`);
        const workTreeContext = this.findWorkTreeComponent() || undefined;
        this.showMedia(itemData, isImg ? 'image' : 'video', workTreeContext).catch(err => {
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
            Logger.log(`[MediaViewer] WorkTree ref fatherFolder: ${workTreeRef.fatherFolder?.length || 0} items`);

            if (self.isImage(ext) || item.type === 'image') {
                // Pass the workTreeRef instead of 'this' for more reliable access
                self.showMedia(item, 'image', workTreeRef);
                return;
            }

            if (self.isVideo(ext)) {
                self.showMedia(item, 'video', workTreeRef);
                return;
            }

            return original.call(this, item);
        };

        this.workTreeHooked = true;
        Logger.log('[MediaViewer] WorkTree patched successfully');
    }

    private setupObserver(): void {
        CentralObserver.register('MediaViewer', () => {
            if (!this.findWorkTreeElement()) return;
            setTimeout(() => {
                this.hookWorkTree();
                this.injectThumbnails();
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
                const doInject = () => this.injectThumbnails();
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
            this.clearStaleThumbnails();
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
            (state) => state.AudioPlayer?.hide,
            (isHidden, wasHidden) => {
                // If player is now expanded (isHidden === false) AND it was previously minimized (wasHidden === true)
                // Note: on initial watch, wasHidden might be undefined, so we strictly check for transition
                if (isHidden === false && wasHidden === true) {
                    // Check if lightbox is open (modal has active class)
                    if (this.modal?.classList.contains('active')) {
                        Logger.log('[MediaViewer] Player expanded, closing lightbox');
                        this.hideModal();
                    }
                }
            }
        );
    }

    // =========================================================================
    // Thumbnail Injection
    // =========================================================================

    private clearStaleThumbnails(): void {
        const workTreeEl = this.findWorkTreeElement();
        if (!workTreeEl) return;

        const thumbContainers = workTreeEl.querySelectorAll('.media-thumb-container');
        thumbContainers.forEach(container => {
            const iconSection = container.parentElement;
            container.remove();
            // Restore the original icon
            const hiddenIcon = iconSection?.querySelector('.q-icon.hidden');
            if (hiddenIcon) {
                hiddenIcon.classList.remove('hidden');
            }
        });
    }

    private async injectThumbnails(): Promise<void> {
        const workTreeEl = this.findWorkTreeElement();
        if (!workTreeEl) return;

        // Prevent injection if lightbox is open (fixes race condition with player minimize/expand)
        if (this.modal?.classList.contains('active')) return;

        // Clear stale thumbnails from previous folder before re-injecting
        this.clearStaleThumbnails();

        const workTree = this.findWorkTreeComponent();
        let fatherFolder = workTree?.fatherFolder || [];

        // Fallback: fetch from API if fatherFolder is empty
        if (fatherFolder.length === 0) {
            const workId = this.getWorkIdFromUrl();
            if (workId) {
                try {
                    const tracks = await WorkService.getTracks(workId);
                    if (Array.isArray(tracks)) {
                        fatherFolder = this.flattenTracksResponse(tracks);
                        Logger.debug(`[MediaViewer] Thumbnails: fetched ${fatherFolder.length} tracks from API`);
                    } else {
                        Logger.warn('[MediaViewer] Thumbnails: tracks is not an array:', typeof tracks);
                    }
                } catch (err) {
                    Logger.warn('[MediaViewer] Thumbnails: failed to fetch tracks', err);
                }
            }
        }

        // Create a map of titles to file data for faster lookup
        const fileMap = new Map<string, MediaFile>();
        fatherFolder.forEach(f => {
            fileMap.set(f.title, f);
            // Also map without extension for flexibility
            const baseName = f.title.replace(/\.[^.]+$/, '');
            fileMap.set(baseName, f);
        });

        Logger.debug(`[MediaViewer] Thumbnails: fileMap has ${fileMap.size} entries from ${fatherFolder.length} items`);

        const items = workTreeEl.querySelectorAll('.q-item');
        items.forEach((item) => {
            const labelEl = item.querySelector('.q-item__section--main');
            const iconSection = item.querySelector('.q-item__section--avatar');
            if (!labelEl || !iconSection) return;

            // Skip if already has thumbnail
            if (iconSection.querySelector('.media-thumb-container')) return;

            // Get the raw title text - prefer .q-item__label if present (folders have nested labels)
            const labelDirect = item.querySelector('.q-item__label');
            let title = (labelDirect || labelEl).textContent?.trim() || '';

            // Collapse internal whitespace (from HTML formatting)
            title = title.replace(/\s+/g, ' ');

            // Strip English translation suffix if present: "file.jpg (Translation)"
            const translationMatch = title.match(/^(.+?)\s*\([^)]+\)$/);
            if (translationMatch) {
                title = translationMatch[1].trim();
            }

            const ext = this.getFileExtension(title);
            if (!this.isImage(ext) && !this.isVideo(ext)) return;

            // Look up file data
            let fileData = fileMap.get(title);
            if (!fileData) {
                // Try partial matching
                for (const [key, value] of fileMap.entries()) {
                    if (title.includes(key) || key.includes(title)) {
                        fileData = value;
                        break;
                    }
                }
            }

            if (!fileData?.hash) {
                Logger.debug(`[MediaViewer] Thumbnails: no hash for "${title}"`);
                return;
            }

            if (this.isImage(ext)) {
                const thumbUrl = this.getMediaUrl(fileData.hash, fileData);
                this.createThumbnail(iconSection as HTMLElement, thumbUrl, fileData.hash);
            } else if (this.isVideo(ext)) {
                // For videos, replace icon with a video-themed thumbnail
                this.createVideoThumbnail(iconSection as HTMLElement);
            }
        });
    }

    private createThumbnail(iconSection: HTMLElement, url: string, hash: string): void {
        // Hide existing icon
        const existingIcon = iconSection.querySelector('.q-icon');
        if (existingIcon) {
            existingIcon.classList.add('hidden');
        }

        // Create thumbnail container
        const thumbContainer = document.createElement('div');
        thumbContainer.className = 'media-thumb-container';

        // Create loading placeholder
        const placeholder = document.createElement('div');
        placeholder.className = 'media-thumb-loading';
        placeholder.innerHTML = '<span class="material-icons">hourglass_empty</span>';
        thumbContainer.appendChild(placeholder);

        // Create image
        const thumb = document.createElement('img');
        thumb.className = 'media-thumb';
        thumb.alt = 'Thumbnail';
        thumb.loading = 'lazy';

        // Use cached thumbnail or load new one
        if (this.thumbnailCache.has(hash)) {
            thumb.src = this.thumbnailCache.get(hash)!;
            placeholder.remove();
        } else {
            thumb.src = url;
        }

        thumb.onload = () => {
            placeholder.remove();
            thumb.classList.add('loaded');
            // Cache the URL for this hash
            this.thumbnailCache.set(hash, url);
        };

        let retryCount = 0;
        const maxRetries = 3;
        thumb.onerror = () => {
            retryCount++;
            if (retryCount <= maxRetries) {
                const delay = retryCount * 1000; // 1s, 2s, 3s backoff
                Logger.debug(`[MediaViewer] Thumbnail retry ${retryCount}/${maxRetries} for ${hash} in ${delay}ms`);
                setTimeout(() => {
                    // Append cache-bust param to force re-fetch
                    const separator = url.includes('?') ? '&' : '?';
                    thumb.src = `${url}${separator}_r=${retryCount}`;
                }, delay);
            } else {
                Logger.debug(`[MediaViewer] Thumbnail failed after ${maxRetries} retries: ${hash}`);
                thumbContainer.remove();
                if (existingIcon) {
                    existingIcon.classList.remove('hidden');
                }
            }
        };

        thumbContainer.appendChild(thumb);
        iconSection.appendChild(thumbContainer);
    }

    private createVideoThumbnail(iconSection: HTMLElement): void {
        // Hide existing icon
        const existingIcon = iconSection.querySelector('.q-icon');
        if (existingIcon) {
            existingIcon.classList.add('hidden');
        }

        // Create thumbnail container with a video icon overlay
        const thumbContainer = document.createElement('div');
        thumbContainer.className = 'media-thumb-container media-thumb-video';
        thumbContainer.innerHTML = '<span class="material-icons" style="font-size:24px;color:rgba(255,255,255,0.9);">play_circle_filled</span>';

        iconSection.appendChild(thumbContainer);
    }

    // =========================================================================
    // Modal Creation
    // =========================================================================

    private createModal(): void {
        if (this.modal) return;

        this.modal = document.createElement('div');
        this.modal.id = 'asmr-media-viewer-modal';
        this.modal.className = 'media-viewer-modal';
        this.modal.innerHTML = `
            <div class="media-viewer-backdrop"></div>
            <div class="media-viewer-container">
                <div class="media-viewer-header">
                    <div class="media-viewer-counter">
                        <span class="media-viewer-current">1</span>
                        <span class="media-viewer-separator">/</span>
                        <span class="media-viewer-total">1</span>
                    </div>
                    <div class="media-viewer-title"></div>
                    <div class="media-viewer-actions">
                        <div class="media-viewer-zoom-controls">
                            <button class="media-viewer-action media-viewer-zoom-out" aria-label="Zoom out" title="Zoom out (-)">
                                <span class="material-icons">remove</span>
                            </button>
                            <input type="range" class="media-viewer-zoom-slider" min="50" max="400" value="100" step="10" title="Zoom level">
                            <button class="media-viewer-action media-viewer-zoom-in" aria-label="Zoom in" title="Zoom in (+)">
                                <span class="material-icons">add</span>
                            </button>
                            <div class="media-viewer-zoom-indicator">100%</div>
                            <button class="media-viewer-action media-viewer-zoom-reset" aria-label="Reset zoom" title="Reset zoom (0)">
                                <span class="material-icons">fit_screen</span>
                            </button>
                        </div>
                        <button class="media-viewer-action media-viewer-fullscreen" aria-label="Toggle fullscreen" title="Fullscreen (F)">
                            <span class="material-icons">fullscreen</span>
                        </button>
                        <button class="media-viewer-action media-viewer-download" aria-label="Download" title="Download">
                            <span class="material-icons">download</span>
                        </button>
                        <button class="media-viewer-action media-viewer-raw" aria-label="Open raw" title="Open raw image in new tab">
                            <span class="material-icons">open_in_new</span>
                        </button>
                        <button class="media-viewer-action media-viewer-close" aria-label="Close" title="Close (Esc)">
                            <span class="material-icons">close</span>
                        </button>
                    </div>
                </div>
                <div class="media-viewer-body">
                    <button class="media-viewer-nav media-viewer-prev" aria-label="Previous (←)">
                        <span class="material-icons">chevron_left</span>
                    </button>
                    <div class="media-viewer-content">
                        <div class="media-viewer-loader">
                            <span class="material-icons spinning">refresh</span>
                        </div>
                        <div class="media-viewer-media-wrapper"></div>
                    </div>
                    <button class="media-viewer-nav media-viewer-next" aria-label="Next (→)">
                        <span class="material-icons">chevron_right</span>
                    </button>
                </div>
                <div class="media-viewer-thumbnails"></div>
            </div>
        `;
        document.body.appendChild(this.modal);

        this.setupModalEvents();
    }

    private setupModalEvents(): void {
        if (!this.modal) return;

        const backdrop = this.modal.querySelector('.media-viewer-backdrop');
        const body = this.modal.querySelector('.media-viewer-body');
        const closeBtn = this.modal.querySelector('.media-viewer-close');
        const prevBtn = this.modal.querySelector('.media-viewer-prev');
        const nextBtn = this.modal.querySelector('.media-viewer-next');
        const zoomInBtn = this.modal.querySelector('.media-viewer-zoom-in');
        const zoomOutBtn = this.modal.querySelector('.media-viewer-zoom-out');
        const zoomResetBtn = this.modal.querySelector('.media-viewer-zoom-reset');
        const zoomSlider = this.modal.querySelector('.media-viewer-zoom-slider') as HTMLInputElement;
        const fullscreenBtn = this.modal.querySelector('.media-viewer-fullscreen');
        const downloadBtn = this.modal.querySelector('.media-viewer-download');
        const content = this.modal.querySelector('.media-viewer-content');
        const mediaWrapper = this.modal.querySelector('.media-viewer-media-wrapper') as HTMLElement;

        // Close on backdrop click
        backdrop?.addEventListener('click', () => this.hideModal());

        // Close on body click (outside the image)
        body?.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;
            // Only close if clicking directly on body, not on nav buttons or content
            if (target === body || target.classList.contains('media-viewer-content')) {
                this.hideModal();
            }
        });

        closeBtn?.addEventListener('click', () => this.hideModal());
        prevBtn?.addEventListener('click', (e) => { e.stopPropagation(); this.navigateMedia(-1); });
        nextBtn?.addEventListener('click', (e) => { e.stopPropagation(); this.navigateMedia(1); });
        zoomInBtn?.addEventListener('click', (e) => { e.stopPropagation(); this.zoomIn(); });
        zoomOutBtn?.addEventListener('click', (e) => { e.stopPropagation(); this.zoomOut(); });
        zoomResetBtn?.addEventListener('click', (e) => { e.stopPropagation(); this.resetZoom(); });
        zoomSlider?.addEventListener('input', (e) => {
            e.stopPropagation();
            this.setZoom(parseInt((e.target as HTMLInputElement).value) / 100);
        });
        fullscreenBtn?.addEventListener('click', (e) => { e.stopPropagation(); this.toggleFullscreen(); });
        downloadBtn?.addEventListener('click', (e) => { e.stopPropagation(); this.downloadCurrentMedia(); });
        const rawBtn = this.modal.querySelector('.media-viewer-raw');
        rawBtn?.addEventListener('click', (e) => { e.stopPropagation(); this.openRawMedia(); });

        // Touch events for swipe
        content?.addEventListener('touchstart', (e) => this.handleTouchStart(e as TouchEvent), { passive: true });
        content?.addEventListener('touchmove', (e) => this.handleTouchMove(e as TouchEvent), { passive: false });
        content?.addEventListener('touchend', (e) => this.handleTouchEnd(e as TouchEvent));

        // Keyboard navigation
        document.addEventListener('keydown', this.boundHandleKeydown);

        // Mouse wheel zoom
        if (mediaWrapper) {
            mediaWrapper.addEventListener('wheel', this.boundHandleWheel as EventListener, { passive: false });
            mediaWrapper.addEventListener('mousedown', this.boundHandleMouseDown as EventListener);
            mediaWrapper.addEventListener('dragstart', (e) => e.preventDefault());
        }

        // Drag to pan when zoomed (document-level for smooth dragging)
        document.addEventListener('mousemove', this.boundHandleMouseMove);
        document.addEventListener('mouseup', this.boundHandleMouseUp);
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

        if (!document.fullscreenElement) {
            this.modal.requestFullscreen().then(() => {
                if (fullscreenBtn) fullscreenBtn.textContent = 'fullscreen_exit';
            }).catch(() => {
                // Fullscreen not supported or denied
            });
        } else {
            document.exitFullscreen().then(() => {
                if (fullscreenBtn) fullscreenBtn.textContent = 'fullscreen';
            }).catch(() => { });
        }
    }

    // =========================================================================
    // Media Display
    // =========================================================================

    private async showMedia(item: MediaFile, type: 'image' | 'video', workTreeContext?: any): Promise<void> {
        // Ensure modal exists (fixes race condition where click fires before enable() completes)
        if (!this.modal) this.createModal();
        if (!this.modal) return;

        // Show the modal IMMEDIATELY with the clicked item (don't block on async data)
        this.currentMediaList = [item];
        this.currentMediaIndex = 0;
        this.currentMediaType = type;
        this.zoomLevel = 1;

        // CRITICAL: Clean up ANY DOM modifications in WorkTree before triggering a store action
        // minimizing the player will cause a layout change and WorkTree re-render.
        // If we leave our thumbnails in, Vue's virtual DOM patching will fail with NotFoundError.
        this.clearStaleThumbnails();

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
            if (titleEl) titleEl.textContent = item.title;
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

        this.minimizePlayer();

        // Now fetch the full media list in the background for navigation
        // If we had a fake hash, render once we have the real data
        const requestId = ++this.activeRequestId;
        await this.populateMediaList(item, type, requestId, workTreeContext);

        if (requestId !== this.activeRequestId) {
            Logger.debug(`[MediaViewer] Aborting showMedia for request ${requestId} (current is ${this.activeRequestId})`);
            return;
        }

        if (hasFakeHash) {
            // Find the resolved item by title match (hash will differ from the fake one)
            const resolvedItem = this.currentMediaList.find(f =>
                f.title === item.title || f.title?.includes(item.title) || item.title?.includes(f.title)
            );
            if (resolvedItem && resolvedItem.hash && !resolvedItem.hash.startsWith('__delegated_')) {
                // Update index to point to the resolved item
                const resolvedIndex = this.currentMediaList.indexOf(resolvedItem);
                if (resolvedIndex >= 0) this.currentMediaIndex = resolvedIndex;
                Logger.log(`[MediaViewer] Rendering with resolved hash: ${resolvedItem.hash} (was ${initialHash})`);
                this.renderMedia(resolvedItem, type);
                this.updateCounter();
                this.updateNavButtons();
                this.renderThumbnailStrip();
                this.preloadAdjacentImages();
            } else {
                // Resolution failed — show error instead of hammering a bad URL
                Logger.warn(`[MediaViewer] Could not resolve real hash for "${item.title}"`);
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
        }
    }

    private async populateMediaList(item: MediaFile, type: 'image' | 'video', requestId: number, workTreeContext?: any): Promise<void> {
        let fatherFolder: MediaFile[] = [];

        // Try multiple ways to access the folder contents (synchronous sources first)
        if (workTreeContext) {
            if (Array.isArray(workTreeContext.fatherFolder) && workTreeContext.fatherFolder.length > 0) {
                fatherFolder = workTreeContext.fatherFolder;
            } else if (workTreeContext.$data?.fatherFolder && Array.isArray(workTreeContext.$data.fatherFolder)) {
                fatherFolder = workTreeContext.$data.fatherFolder;
            } else if (workTreeContext._data?.fatherFolder && Array.isArray(workTreeContext._data.fatherFolder)) {
                fatherFolder = workTreeContext._data.fatherFolder;
            }
        }

        if (fatherFolder.length === 0) {
            const workTree = this.findWorkTreeComponent();
            if (workTree) {
                const wt = workTree as any;
                fatherFolder = wt.fatherFolder || wt.$data?.fatherFolder || wt._data?.fatherFolder || [];
            }
        }

        // Async fallback: Fetch from WorkService
        if (fatherFolder.length === 0) {
            const workId = this.getWorkIdFromUrl();
            if (workId) {
                try {
                    Logger.log(`[MediaViewer] Fetching tracks for work ${workId} from WorkService...`);
                    const tracks = await WorkService.getTracks(workId);

                    // Check if request is still active after async call
                    if (requestId !== this.activeRequestId) {
                        Logger.debug(`[MediaViewer] Aborting populateMediaList tracks fetch for request ${requestId}`);
                        return;
                    }

                    if (Array.isArray(tracks)) {
                        fatherFolder = this.flattenTracksResponse(tracks);
                        Logger.log(`[MediaViewer] Fetched ${fatherFolder.length} tracks from API`);
                    } else {
                        Logger.warn('[MediaViewer] Tracks is not an array:', typeof tracks);
                    }
                } catch (err) {
                    Logger.warn('[MediaViewer] Failed to fetch tracks from API:', err);
                }
            }
        }

        // Final fallback: scan DOM for media items
        if (fatherFolder.length === 0) {
            fatherFolder = this.scanDomForMediaItems(type);
            Logger.log(`[MediaViewer] DOM scan found ${fatherFolder.length} items`);
        }

        if (fatherFolder.length === 0 || requestId !== this.activeRequestId) return; // Nothing more to add or clobbered

        Logger.log(`[MediaViewer] fatherFolder has ${fatherFolder.length} items`);

        // Filter to only media of the requested type
        const mediaList = fatherFolder.filter((f: MediaFile) => {
            const ext = this.getFileExtension(f.title);
            return type === 'image'
                ? (this.isImage(ext) || f.type === 'image')
                : this.isVideo(ext);
        });

        if (mediaList.length <= 1) return; // No additional items

        // Update the list and find current item position
        this.currentMediaList = mediaList;
        let itemIndex = mediaList.findIndex(f =>
            f.hash === item.hash || f.title === item.title
        );
        // Fuzzy fallback: partial title match (handles whitespace/translation differences)
        if (itemIndex < 0) {
            itemIndex = mediaList.findIndex(f =>
                f.title?.includes(item.title) || item.title?.includes(f.title)
            );
        }
        if (itemIndex < 0) {
            // Only insert the original item if it has a real hash
            if (item.hash && !item.hash.startsWith('__delegated_')) {
                this.currentMediaList.unshift(item);
            }
            this.currentMediaIndex = 0;
        } else {
            this.currentMediaIndex = itemIndex;
        }

        Logger.log(`[MediaViewer] Updated list: index ${this.currentMediaIndex} of ${this.currentMediaList.length}`);

        // Update UI with full list info
        this.updateCounter();
        this.updateNavButtons();
        this.renderThumbnailStrip();
        this.preloadAdjacentImages();
    }

    private renderMedia(item: MediaFile, type: 'image' | 'video'): void {
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
                img.src = url;
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
            }

            // Click to toggle zoom - Removed as requested, using drag only
            img.addEventListener('click', (e) => {
                e.stopPropagation();
            });

            wrapper.appendChild(img);
        } else {
            const video = document.createElement('video');
            video.src = url;
            video.controls = true;
            video.autoplay = true;
            video.className = 'media-viewer-video';
            video.onloadeddata = () => loader?.classList.remove('visible');

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
        }

        if (titleEl) {
            titleEl.textContent = item.title;
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
                thumb.innerHTML = '<span class="material-icons">videocam</span>';
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

    private navigateMedia(delta: number): void {
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
        setTimeout(() => this.injectThumbnails(), 200);
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
            img.src = `${url}${url.includes('?') ? '&' : '?'}_recover=${Date.now()}`;

            img.onload = () => {
                Logger.log(`[MediaViewer] Auto-recovery successful for ${item.title}`);
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
    private scanDomForMediaItems(type: 'image' | 'video'): MediaFile[] {
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
            const isMedia = type === 'image' ? this.isImage(ext) : this.isVideo(ext);
            if (!isMedia) return;

            // Try to get the Vue component data from the DOM element
            const vueEl = qItem as any;
            let hash = '';

            // Try to extract hash from Vue component
            if (vueEl.__vue__) {
                const itemData = vueEl.__vue__.$attrs?.item || vueEl.__vue__?.item;
                if (itemData?.hash) {
                    hash = itemData.hash;
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
            // by matching the title
            if (!hash) {
                const workTree = this.findWorkTreeComponent();
                if (workTree) {
                    const wt = workTree as any;
                    const folder = wt.fatherFolder || wt.$data?.fatherFolder || [];
                    const match = folder.find((f: MediaFile) => f.title === title || f.title.includes(title));
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

    private getMediaUrl(hash: string, item?: MediaFile): string {
        const token = localStorage.getItem('jwt-token') || '';

        if (item?.mediaStreamUrl) {
            // External URLs (e.g. DLsite images) don't need a token
            if (item.mediaStreamUrl.startsWith('http')) return item.mediaStreamUrl;
            return `${item.mediaStreamUrl}?token=${token}`;
        }
        if (item?.media_stream_url) {
            if (item.media_stream_url.startsWith('http')) return item.media_stream_url;
            return `${item.media_stream_url}?token=${token}`;
        }

        return `/api/media/stream/${hash}?token=${token}`;
    }


    // =========================================================================
    // Player Control
    // =========================================================================

    private minimizePlayer(): void {
        // Use Vuex store to collapse expanded player to bar form
        const store = this.bridge.store;
        if (!store?.state?.AudioPlayer) return;

        if (!store.state.AudioPlayer.hide) {
            Logger.log('[MediaViewer] Auto-minimizing audio player via store');
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
}
