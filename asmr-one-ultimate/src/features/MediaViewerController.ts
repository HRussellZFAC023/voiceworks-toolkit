/**
 * MediaViewerController - Orchestrates the MediaViewer feature
 *
 * This controller manages:
 * 1. Mounting the MediaLightbox.vue SFC (via Teleport to body)
 * 2. Imperative DOM operations that cannot be Vue-ified:
 *    - Thumbnail injection into existing work tree items
 *    - Delegated click interception on work tree / flat panel
 *    - WorkTree Vue 2 component patching
 *    - CentralObserver registration for DOM mutation watching
 *    - Route cleanup (removing thumbnails before Vue re-renders)
 *    - Player state synchronization
 *
 * The lightbox modal itself is entirely Vue-managed. The imperative
 * "glue" code lives here in the controller.
 */

import { type Component, markRaw } from 'vue';
import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { CentralObserver } from '../core/CentralObserver';
import { mountApp, type MountedApp } from '../core/MountApp';
import { Logger } from '../core/Utils';
import { WorkService } from '../services/WorkService';
import { ThumbnailManager } from './media/ThumbnailManager';
import type { MediaFile, WorkTreeComponent } from './media/types';
import type { KikoeruApp } from '../types/store';
import type { TrackFolder, TrackItem } from '../types/api';
import MediaLightboxVue from './components/MediaLightbox.vue';

/** Shape of the methods exposed by MediaLightbox.vue via defineExpose */
interface MediaLightboxExposed {
    showMedia(item: MediaFile, type: 'image' | 'video' | 'pdf' | 'text', mediaList: MediaFile[], startIndex: number): Promise<void>;
    showExternalImages(urls: string[], startIndex?: number): void;
    updateMediaList(list: MediaFile[], index: number): void;
    renderResolvedItem(item: MediaFile, type: 'image' | 'video' | 'pdf' | 'text'): void;
    showResolutionError(): void;
    startSlideshowAfterPopulation(): void;
    hideModal(): void;
    getIsActive(): boolean;
}

// File extensions (duplicated from lightbox for click interception)
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'];
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v'];
const PDF_EXTENSIONS = ['.pdf'];
const TEXT_EXTENSIONS = ['.txt', '.md', '.log', '.nfo', '.csv', '.json', '.srt', '.ass', '.vtt', '.lrc'];

declare const unsafeWindow: Window & typeof globalThis;

const globalWindow = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) as Window & {
    __ASMR_MEDIA_VIEWER__?: MediaViewerController;
};

export class MediaViewerController {
    private static _instance: MediaViewerController | null = null;

    private bridge: KikoeruBridge;
    private mounted: MountedApp | null = null;
    private lightboxRef: MediaLightboxExposed | null = null;

    // Imperative state
    private workTreeHooked = false;
    private folderWatcherSetup = false;
    private activeRequestId = 0;
    private delegatedClickInstalled = false;
    private thumbnailCache = new Map<string, string>();
    private thumbnailManager: ThumbnailManager;

    // Bound event handlers
    private boundDelegatedClick: (e: MouseEvent) => void;

    // Cleanup handles
    private playerWatcher: (() => void) | undefined;
    private routeCleanupUnsubscribe: (() => void) | undefined;

    private constructor() {
        this.bridge = KikoeruBridge.getInstance();
        this.boundDelegatedClick = this.handleDelegatedClick.bind(this);
        this.thumbnailManager = new ThumbnailManager({
            getModal: () => document.getElementById('asmr-media-viewer-modal'),
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

    public static getInstance(): MediaViewerController {
        if (!MediaViewerController._instance) {
            MediaViewerController._instance = new MediaViewerController();
        }
        MediaViewerController._instance.bridge = KikoeruBridge.getInstance();
        return MediaViewerController._instance;
    }

    // =========================================================================
    // Public API (used by other features like FlatView, WorkMetadata, PlayerGallery)
    // =========================================================================

    /**
     * Open the lightbox with external image URLs (e.g. DLsite sample images).
     */
    public showExternalImages(urls: string[], startIndex = 0): void {
        this.ensureMounted();
        this.lightboxRef?.showExternalImages(urls, startIndex);
    }

    // =========================================================================
    // Lifecycle
    // =========================================================================

    public enable(): void {
        Logger.log('[MediaViewerController] Enabling...');

        this.ensureMounted();
        this.installDelegatedClick();
        this.hookWorkTree();
        this.setupObserver();
        this.setupPlayerWatcher();
        this.setupRouteCleanup();

        Logger.log('[MediaViewerController] Enabled');
    }

    public disable(): void {
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

        this.unmount();
        this.workTreeHooked = false;
        this.folderWatcherSetup = false;
        this.thumbnailCache.clear();
    }

    // =========================================================================
    // Vue SFC Mounting
    // =========================================================================

    private ensureMounted(): void {
        if (this.mounted && this.lightboxRef) return;

        // Create a hidden container for the Vue app (the actual modal uses Teleport to body)
        let container = document.getElementById('asmr-media-viewer-root');
        if (!container) {
            container = document.createElement('div');
            container.id = 'asmr-media-viewer-root';
            container.style.display = 'none';
            document.body.appendChild(container);
        }

        try {
            this.mounted = mountApp(
                markRaw(MediaLightboxVue as Component),
                {
                    visible: false,
                },
                container
            );

            // Get the component instance to call exposed methods.
            // Vue 3's createApp()._instance.exposed holds the defineExpose() API.
            const appAny = this.mounted.app as any;
            const exposed = appAny._instance?.exposed;
            if (exposed) {
                this.lightboxRef = exposed as MediaLightboxExposed;
            } else {
                // Fallback: try the proxy (component instance itself)
                const proxy = appAny._instance?.proxy;
                if (proxy) {
                    this.lightboxRef = proxy as unknown as MediaLightboxExposed;
                }
            }

            Logger.debug('[MediaViewerController] Vue lightbox mounted, ref:', !!this.lightboxRef);
        } catch (err) {
            Logger.error('[MediaViewerController] Failed to mount lightbox:', err);
        }
    }

    private unmount(): void {
        if (this.mounted) {
            try {
                this.mounted.unmount();
            } catch (err) {
                Logger.error('[MediaViewerController] Failed to unmount:', err);
            }
            this.mounted = null;
            this.lightboxRef = null;

            const container = document.getElementById('asmr-media-viewer-root');
            container?.remove();
        }
    }

    // =========================================================================
    // Delegated Click (immediate interception, no Vue patching needed)
    // =========================================================================

    private installDelegatedClick(): void {
        if (this.delegatedClickInstalled) return;
        document.addEventListener('click', this.boundDelegatedClick, true);
        this.delegatedClickInstalled = true;
        Logger.debug('[MediaViewerController] Delegated click handler installed');
    }

    private handleDelegatedClick(e: MouseEvent): void {
        const target = e.target as HTMLElement;
        if (!target) return;

        const workTreeEl = this.findWorkTreeElement();
        const flatPanelEl = document.querySelector('.asmr-flat-panel');
        const inWorkTree = workTreeEl?.contains(target);
        const inFlatPanel = flatPanelEl?.contains(target);
        if (!inWorkTree && !inFlatPanel) return;

        const qItem = target.closest('.q-item') as HTMLElement | null;
        if (!qItem) return;

        const labelEl = qItem.querySelector('.q-item__label');
        if (!labelEl) return;

        let title = labelEl.textContent?.trim() || '';
        const translationMatch = title.match(/^(.+?)\s*\([^)]+\)$/);
        if (translationMatch) title = translationMatch[1].trim();
        if (!title) return;

        const ext = this.getFileExtension(title);
        const isImg = this.isImage(ext);
        const isVid = this.isVideo(ext);
        const isPdf = this.isPdf(ext);
        const isTxt = this.isText(ext);
        if (!isImg && !isVid && !isPdf && !isTxt) return;

        e.stopPropagation();
        e.preventDefault();

        let hash = '';
        let itemData: MediaFile | null = null;

        // Check for stashed hash
        if (!itemData) {
            hash = qItem.dataset.asmrHash || qItem.dataset.asmrFlatHash || '';
            if (hash) {
                itemData = { hash, title, type: isImg ? 'image' : isVid ? 'video' : isPdf ? 'pdf' : 'text' };
            }
        }

        // Try thumbnail as fallback
        if (!itemData) {
            const thumbImg = qItem.querySelector('.media-thumb') as HTMLImageElement;
            if (thumbImg?.src && thumbImg.classList.contains('loaded')) {
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

        // Fallback: try WorkTree component's fatherFolder
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

        const mediaType: 'image' | 'video' | 'pdf' | 'text' = isImg ? 'image' : isVid ? 'video' : isPdf ? 'pdf' : 'text';
        Logger.debug(`[MediaViewerController] Delegated click: ${title} (${mediaType}), hash=${itemData.hash}`);

        const workTreeContext = this.findWorkTreeComponent() || undefined;
        this.showMedia(itemData, mediaType, workTreeContext).catch(err => {
            Logger.error('[MediaViewerController] Delegated showMedia failed:', err);
        });
    }

    // =========================================================================
    // WorkTree Hook
    // =========================================================================

    private hookWorkTree(): void {
        if (this.workTreeHooked) return;

        const workTree = this.findWorkTreeComponent();
        if (workTree) {
            Logger.debug('[MediaViewerController] Found WorkTree component, patching...');
            this.patchWorkTree(workTree);
        }
    }

    private findWorkTreeComponent(): WorkTreeComponent | null {
        return this.bridge.findComponent(
            (vm: KikoeruApp) => vm.$options?.name === 'WorkTree'
        ) as WorkTreeComponent | null;
    }

    private findWorkTreeElement(): HTMLElement | null {
        return document.getElementById('work-tree')
            || (this.findWorkTreeComponent() as any)?.$el as HTMLElement
            || null;
    }

    private patchWorkTree(workTree: WorkTreeComponent): void {
        const self = this;
        const original = workTree.onClickItem;
        const workTreeRef = workTree;

        if (!original) {
            Logger.warn('[MediaViewerController] WorkTree.onClickItem not found');
            return;
        }

        if ((workTree as any).__mediaViewerPatched) return;
        (workTree as any).__mediaViewerPatched = true;

        workTree.onClickItem = function (this: WorkTreeComponent, item: MediaFile) {
            const ext = self.getFileExtension(item.title);

            if (self.isImage(ext) || item.type === 'image') {
                self.showMedia(item, 'image', workTreeRef);
                return;
            }
            if (self.isVideo(ext)) {
                self.showMedia(item, 'video', workTreeRef);
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
        Logger.debug('[MediaViewerController] WorkTree patched successfully');
    }

    // =========================================================================
    // Observer & Watchers
    // =========================================================================

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

    private setupRouteCleanup(): void {
        if (this.routeCleanupUnsubscribe) return;
        const router = this.bridge.router;
        if (!router?.beforeEach) return;

        this.routeCleanupUnsubscribe = router.beforeEach((_to: unknown, _from: unknown, next: () => void) => {
            this.thumbnailManager.clearStaleThumbnails();
            this.workTreeHooked = false;
            this.folderWatcherSetup = false;
            next();
        });
    }

    private setupPlayerWatcher(): void {
        if (this.playerWatcher) return;

        this.playerWatcher = this.bridge.watch(
            (state) => ({
                hide: state.AudioPlayer?.hide,
                playing: state.AudioPlayer?.playing,
                currentTime: state.AudioPlayer?.currentTime,
                src: state.AudioPlayer?.currentTrack?.src || state.AudioPlayer?.currentPlayingFile?.src
            }),
            (val, oldVal) => {
                if (val.hide === false && oldVal?.hide === true) {
                    if (this.lightboxRef?.getIsActive() && !document.body.classList.contains('asmr-fullscreen-active')) {
                        Logger.debug('[MediaViewerController] Player expanded, closing lightbox');
                        this.lightboxRef.hideModal();
                    }
                }

                // Sync video playback state
                if (this.lightboxRef?.getIsActive()) {
                    const modal = document.getElementById('asmr-media-viewer-modal');
                    const video = modal?.querySelector('video');
                    if (video) {
                        if (val.playing && video.paused) {
                            video.play().catch(() => {});
                        } else if (!val.playing && !video.paused) {
                            video.pause();
                        }
                        if (typeof val.currentTime === 'number' && Math.abs(video.currentTime - val.currentTime) > 2) {
                            video.currentTime = val.currentTime;
                        }
                    }
                }
            }
        );
    }

    // =========================================================================
    // Show Media (orchestrates lightbox + async data fetching)
    // =========================================================================

    private async showMedia(item: MediaFile, type: 'image' | 'video' | 'pdf' | 'text', workTreeContext?: WorkTreeComponent): Promise<void> {
        this.ensureMounted();
        if (!this.lightboxRef) return;

        // Clean up thumbnails before any store action
        this.thumbnailManager.clearStaleThumbnails();

        const initialHash = item.hash;
        const hasFakeHash = !initialHash || initialHash.startsWith('__delegated_');

        // Show modal immediately with the single item
        await this.lightboxRef.showMedia(item, type, [item], 0);

        // For videos, load the track into the native AudioPlayer so the mini player bar appears
        if (type === 'video') {
            this.playVideoInNativePlayer(item, workTreeContext);
        }

        // Fetch full media list in the background
        const requestId = ++this.activeRequestId;
        const mediaList = await this.populateMediaList(item, type, requestId, workTreeContext);

        if (requestId !== this.activeRequestId) return;

        if (mediaList && mediaList.length > 0) {
            const matchedItem = this.findMatchingMediaItem(item, mediaList);
            const matchedIndex = matchedItem ? mediaList.indexOf(matchedItem) : 0;
            this.lightboxRef.updateMediaList(mediaList, Math.max(0, matchedIndex));

            if (hasFakeHash) {
                if (matchedItem && matchedItem.hash && !matchedItem.hash.startsWith('__delegated_')) {
                    Logger.debug(`[MediaViewerController] Rendering with resolved hash: ${matchedItem.hash}`);
                    this.lightboxRef.renderResolvedItem(matchedItem, type);
                } else {
                    Logger.warn(`[MediaViewerController] Could not resolve real hash for "${item.title}"`);
                    this.lightboxRef.showResolutionError();
                }
            } else {
                // Check if enriched item has a better stream URL
                const currentItem = mediaList[Math.max(0, matchedIndex)];
                const initialHadStream = !!(item.mediaStreamUrl || item.media_stream_url);
                const currentHasStream = !!(currentItem?.mediaStreamUrl || currentItem?.media_stream_url);

                if (currentHasStream && !initialHadStream && currentItem) {
                    Logger.debug(`[MediaViewerController] Re-rendering enriched item: ${currentItem.title}`);
                    this.lightboxRef.renderResolvedItem(currentItem, type);
                }
            }
        }

        this.lightboxRef.startSlideshowAfterPopulation();

        // Re-inject thumbnails after close
        // (handled by the 'closed' event from the lightbox, but also:)
        // Thumbnails are re-injected via the CentralObserver
    }

    /**
     * Load the video file into the native AudioPlayer so the mini player bar appears.
     * The native <audio> element can play the audio track from .mp4 files.
     * We build a queue that includes both audio and video files from the current folder.
     */
    private playVideoInNativePlayer(item: MediaFile, workTreeContext?: WorkTreeComponent): void {
        const store = this.bridge.store;
        if (!store.commit) return;

        let allItems: MediaFile[] = [];
        if (workTreeContext) {
            const ctx = workTreeContext as any;
            allItems = ctx.fatherFolder || ctx.$data?.fatherFolder || [];
        }
        if (allItems.length === 0) {
            const wt = this.findWorkTreeComponent() as any;
            if (wt) {
                allItems = wt.fatherFolder || wt.$data?.fatherFolder || [];
            }
        }

        const queue = allItems.filter((f: MediaFile) => {
            if ((f as any).type === 'audio') return true;
            const fExt = this.getFileExtension(f.title);
            return this.isVideo(fExt);
        }).map(f => ({ ...f, type: 'audio' as const }));

        const index = queue.findIndex(f => f.hash === item.hash);
        if (index < 0) {
            // Fallback: single-item queue
            store.commit('AudioPlayer/SET_QUEUE', {
                queue: [{ ...item, type: 'audio' }],
                index: 0,
            });
        } else {
            store.commit('AudioPlayer/SET_QUEUE', { queue, index });
        }
        Logger.debug(`[MediaViewerController] Playing video in native player: ${item.title} (${index + 1}/${queue.length})`);
    }

    private async populateMediaList(
        item: MediaFile,
        type: 'image' | 'video' | 'pdf' | 'text',
        requestId: number,
        workTreeContext?: WorkTreeComponent
    ): Promise<MediaFile[]> {
        let fatherFolder: MediaFile[] = [];

        // Synchronous sources first
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

        // Async: WorkService API
        if (fatherFolder.length === 0) {
            const workId = this.getWorkIdFromUrl();
            if (workId) {
                try {
                    const tracks = await WorkService.getTracks(workId);
                    if (requestId !== this.activeRequestId) return [];
                    if (Array.isArray(tracks)) {
                        fatherFolder = this.flattenTracksResponse(tracks);
                    }
                } catch (err) {
                    Logger.warn('[MediaViewerController] Failed to fetch tracks:', err);
                }
            }
        }

        if (fatherFolder.length === 0) {
            const tree = this.getWorkTreeTree();
            if (tree?.length) {
                fatherFolder = this.flattenTracksResponse(tree);
            }
        }

        // DOM scan fallback
        if (fatherFolder.length === 0) {
            fatherFolder = this.scanDomForMediaItems(type);
        }

        if (fatherFolder.length === 0 || requestId !== this.activeRequestId) return [];

        // Filter to requested media type
        const mediaList = fatherFolder.filter((f: MediaFile) => {
            const ext = this.getFileExtension(f.title);
            if (type === 'image') return this.isImage(ext) || f.type === 'image';
            if (type === 'video') return this.isVideo(ext);
            if (type === 'pdf') return this.isPdf(ext);
            return this.isText(ext);
        });

        return mediaList;
    }

    // =========================================================================
    // DOM scanning fallback
    // =========================================================================

    private scanDomForMediaItems(type: 'image' | 'video' | 'pdf' | 'text'): MediaFile[] {
        const workTreeEl = this.findWorkTreeElement();
        if (!workTreeEl) return [];

        const items: MediaFile[] = [];
        const qItems = workTreeEl.querySelectorAll('.q-item');

        qItems.forEach((qItem) => {
            const labelEl = qItem.querySelector('.q-item__label') || qItem.querySelector('.q-item__section--main');
            if (!labelEl) return;

            let title = labelEl.textContent?.trim() || '';
            const translationMatch = title.match(/^(.+?)\s*\([^)]+\)$/);
            if (translationMatch) title = translationMatch[1].trim();
            if (!title) return;

            const ext = this.getFileExtension(title);
            let isMedia = false;
            if (type === 'image') isMedia = this.isImage(ext);
            else if (type === 'video') isMedia = this.isVideo(ext);
            else if (type === 'pdf') isMedia = this.isPdf(ext);
            else isMedia = this.isText(ext);
            if (!isMedia) return;

            const vueEl = qItem as any;
            let hash = '';

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

            if (!hash) {
                const dataHash = qItem.getAttribute('data-hash');
                if (dataHash) hash = dataHash;
                else if ((vueEl as any).__vue__?.id) hash = (vueEl as any).__vue__.id;
            }

            if (!hash) {
                const workTree = this.findWorkTreeComponent();
                const folder = (workTree as any)?.fatherFolder ||
                    (workTree as any)?.$data?.fatherFolder || [];
                if (folder.length > 0) {
                    const match = this.findMatchingMediaItem({ hash: '', title }, folder);
                    if (match?.hash) hash = match.hash;
                }
            }

            if (hash && !items.find(i => i.hash === hash)) {
                items.push({ hash, title, type });
            }
        });

        return items;
    }

    // =========================================================================
    // Matching / Utility Methods
    // =========================================================================

    private findMatchingMediaItem(target: MediaFile, list: MediaFile[]): MediaFile | undefined {
        // 1. Hash match
        if (target.hash && !target.hash.startsWith('__delegated_')) {
            const match = list.find(f => f.hash === target.hash);
            if (match) return match;
        }

        // 2. Normalized title match
        const normTarget = this.normalizeMatchString(target.title);
        let match = list.find(f => this.normalizeMatchString(f.title) === normTarget);
        if (match) return match;

        // 3. Exact title
        match = list.find(f => f.title === target.title);
        if (match) return match;

        // 4. Containment
        match = list.find(f => {
            const normF = this.normalizeMatchString(f.title);
            return (normF.length > 3 && normTarget.length > 3) &&
                (normF.includes(normTarget) || normTarget.includes(normF));
        });

        return match;
    }

    private normalizeMatchString(t: string): string {
        if (!t) return '';
        let s = t.normalize('NFC').toLowerCase();
        s = s.replace(/\s*\([^)]+\)\s*$/, '');
        s = s.replace(/(\.[a-z0-9]{2,5})+$/, '');
        s = s.replace(/[\s\-_.]+/g, ' ');
        return s.trim();
    }

    private getFileExtension(filename: string): string {
        const match = filename.match(/\.[^.]+$/);
        return match ? match[0].toLowerCase() : '';
    }

    private isImage(ext: string): boolean { return IMAGE_EXTENSIONS.includes(ext); }
    private isVideo(ext: string): boolean { return VIDEO_EXTENSIONS.includes(ext); }
    private isPdf(ext: string): boolean { return PDF_EXTENSIONS.includes(ext); }
    private isText(ext: string): boolean { return TEXT_EXTENSIONS.includes(ext); }

    private getMediaUrl(hash: string, item?: MediaFile): string {
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

    private getWorkIdFromUrl(): string | null {
        const hashMatch = window.location.hash.match(/work\/([a-zA-Z0-9]+)/);
        if (hashMatch) return hashMatch[1];
        const pathMatch = window.location.pathname.match(/work\/([a-zA-Z0-9]+)/);
        if (pathMatch) return pathMatch[1];
        return null;
    }

    private flattenTracksResponse(nodes: (TrackFolder | TrackItem)[]): MediaFile[] {
        const result: MediaFile[] = [];
        if (!Array.isArray(nodes)) return result;

        const traverse = (items: (TrackFolder | TrackItem)[]) => {
            if (!Array.isArray(items)) return;
            for (const item of items) {
                if (item.type === 'folder') {
                    if (item.children) traverse(item.children);
                } else {
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

    private getWorkTreeTree(): Array<TrackFolder | TrackItem> | null {
        const workTree = this.findWorkTreeComponent() as any;
        const tree = workTree?.tree || workTree?.$data?.tree;
        return Array.isArray(tree) ? tree : null;
    }
}
