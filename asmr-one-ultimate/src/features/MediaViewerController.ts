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
import {
    findMatchingMediaItem,
    getFileExtension,
    isImageExtension,
    isPdfExtension,
    isTextExtension,
    isVideoExtension,
} from './media/mediaFileUtils';
import { buildMediaStreamUrl } from './media/mediaStreamUrlUtils';
import {
    applyMediaViewerWorkTreePatch,
    restoreMediaViewerWorkTreePatch,
    type WorkTreeClickHandler,
} from './media/mediaViewerWorkTreePatchUtils';
import {
    type ViewerMediaType,
    type Vue2MediaElement,
    getMediaTitleFromListItem,
    matchesRequestedMediaType,
    readMediaHashFromElement,
    readMediaItemFromVueElement,
    resolveMediaTypeForCandidate,
    shouldIgnoreDelegatedClickTarget,
} from './media/mediaViewerDomUtils';

/** Extended WorkTree with imperative patching marker and Vue 2 internals */
interface PatchableWorkTree extends WorkTreeComponent {
    __mediaViewerPatched?: boolean;
    __mediaViewerOriginalOnClickItem?: WorkTreeClickHandler<MediaFile>;
    $el?: HTMLElement;
    $data?: Record<string, unknown>;
    _data?: Record<string, unknown>;
    tree?: Array<TrackFolder | TrackItem>;
}

/** Vue 3 App internals for accessing exposed methods */
interface Vue3AppInternal {
    _instance?: {
        exposed?: Record<string, unknown>;
        proxy?: Record<string, unknown>;
    };
}

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
    private patchedWorkTree: PatchableWorkTree | null = null;

    // Bound event handlers
    private boundDelegatedClick: (e: MouseEvent) => void;

    // Cleanup handles
    private playerWatcher: (() => void) | undefined;
    private routeCleanupUnsubscribe: (() => void) | undefined;
    private folderPathWatcherCleanup: (() => void) | undefined;

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
            getFileExtension,
            isImage: isImageExtension,
            isVideo: isVideoExtension,
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

        this.cleanupFolderWatcher();
        this.cleanupWorkTreePatch();
        this.unmount();
        this.workTreeHooked = false;
        this.folderWatcherSetup = false;
        this.activeRequestId++;
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
            const appInternal = this.mounted.app as unknown as Vue3AppInternal;
            const exposed = appInternal._instance?.exposed;
            if (exposed) {
                this.lightboxRef = exposed as unknown as MediaLightboxExposed;
            } else {
                // Fallback: try the proxy (component instance itself)
                const proxy = appInternal._instance?.proxy;
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
        if (shouldIgnoreDelegatedClickTarget(target, qItem)) return;

        const title = getMediaTitleFromListItem(qItem);
        if (!title) return;

        const vueItem = readMediaItemFromVueElement(qItem as Vue2MediaElement);
        const mediaType = resolveMediaTypeForCandidate(title, vueItem?.type);
        if (!mediaType) return;

        e.stopPropagation();
        e.preventDefault();

        let hash = readMediaHashFromElement(qItem as Vue2MediaElement);
        let itemData: MediaFile | null = null;

        if (hash) {
            itemData = { hash, title, type: mediaType };
        }

        // Try thumbnail as fallback
        if (!itemData) {
            const thumbImg = qItem.querySelector('.media-thumb') as HTMLImageElement;
            if (thumbImg?.src && thumbImg.classList.contains('loaded')) {
                itemData = {
                    hash: `__delegated_stream_${Date.now()}`,
                    title,
                    mediaStreamUrl: thumbImg.src,
                    type: mediaType,
                };
            }
        }

        // For native tree items, try Vue component data
        if (!itemData && vueItem) {
            itemData = vueItem;
            hash = vueItem.hash;
        }

        // Fallback: try WorkTree component's fatherFolder
        if (!itemData) {
            const workTree = this.findWorkTreeComponent() as PatchableWorkTree | null;
            const folder = (workTree?.fatherFolder ??
                workTree?.$data?.fatherFolder ?? []) as MediaFile[];
            if (folder.length > 0) {
                const match = findMatchingMediaItem({ hash: '', title }, folder);
                if (match) {
                    itemData = match;
                    hash = match.hash || '';
                }
            }
        }

        if (!itemData) {
            itemData = { hash: hash || `__delegated_${Date.now()}`, title };
        }

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
            || (this.findWorkTreeComponent() as PatchableWorkTree | null)?.$el
            || null;
    }

    private patchWorkTree(workTree: WorkTreeComponent): void {
        const self = this;
        const workTreeRef = workTree;
        const patchable = workTree as PatchableWorkTree;

        if (typeof patchable.onClickItem !== 'function') {
            Logger.warn('[MediaViewerController] WorkTree.onClickItem not found');
            return;
        }

        const patched = applyMediaViewerWorkTreePatch<MediaFile>(
            patchable as unknown as {
                onClickItem?: WorkTreeClickHandler<MediaFile>;
                __mediaViewerPatched?: boolean;
                __mediaViewerOriginalOnClickItem?: WorkTreeClickHandler<MediaFile>;
            },
            (original: WorkTreeClickHandler<MediaFile>) => function (this: WorkTreeComponent, item: MediaFile) {
                if (matchesRequestedMediaType(item, 'image')) {
                    self.showMedia(item, 'image', workTreeRef);
                    return;
                }
                if (matchesRequestedMediaType(item, 'video')) {
                    self.showMedia(item, 'video', workTreeRef);
                    return;
                }
                if (matchesRequestedMediaType(item, 'pdf')) {
                    self.showMedia(item, 'pdf', workTreeRef);
                    return;
                }
                if (matchesRequestedMediaType(item, 'text')) {
                    self.showMedia(item, 'text', workTreeRef);
                    return;
                }

                return original.call(this, item);
            }
        );
        if (!patched) return;

        this.patchedWorkTree = patchable;
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
        if (this.folderWatcherSetup || this.folderPathWatcherCleanup) return;

        const workTree = this.findWorkTreeComponent();
        if (!workTree) return;

        if (workTree.$watch) {
            const unwatch = workTree.$watch('path', () => {
                const doInject = () => this.thumbnailManager.injectThumbnails();
                if (typeof workTree.$nextTick === 'function') {
                    workTree.$nextTick(() => setTimeout(doInject, 50));
                } else {
                    setTimeout(doInject, 200);
                }
            }, { deep: true });

            this.folderPathWatcherCleanup = unwatch || undefined;
            this.folderWatcherSetup = true;
        }
    }

    private setupRouteCleanup(): void {
        if (this.routeCleanupUnsubscribe) return;
        const router = this.bridge.router;
        if (!router?.beforeEach) return;

        this.routeCleanupUnsubscribe = router.beforeEach((_to: unknown, _from: unknown, next: () => void) => {
            this.thumbnailManager.clearStaleThumbnails();
            this.cleanupFolderWatcher();
            this.cleanupWorkTreePatch();
            next();
        });
    }

    private cleanupFolderWatcher(): void {
        if (this.folderPathWatcherCleanup) {
            this.folderPathWatcherCleanup();
            this.folderPathWatcherCleanup = undefined;
        }
        this.folderWatcherSetup = false;
    }

    private cleanupWorkTreePatch(): void {
        if (this.patchedWorkTree) {
            restoreMediaViewerWorkTreePatch(
                this.patchedWorkTree as unknown as {
                    onClickItem?: WorkTreeClickHandler<MediaFile>;
                    __mediaViewerPatched?: boolean;
                    __mediaViewerOriginalOnClickItem?: WorkTreeClickHandler<MediaFile>;
                }
            );
            this.patchedWorkTree = null;
        }
        this.workTreeHooked = false;
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

        if (requestId !== this.activeRequestId || !this.lightboxRef) return;

        if (mediaList && mediaList.length > 0) {
            const matchedItem = findMatchingMediaItem(item, mediaList);
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
            const ctx = workTreeContext as PatchableWorkTree;
            allItems = (ctx.fatherFolder ?? ctx.$data?.fatherFolder ?? []) as MediaFile[];
        }
        if (allItems.length === 0) {
            const wt = this.findWorkTreeComponent() as PatchableWorkTree | null;
            if (wt) {
                allItems = (wt.fatherFolder ?? wt.$data?.fatherFolder ?? []) as MediaFile[];
            }
        }

        const queue = allItems.filter((f: MediaFile) => {
            if (f.type === 'audio') return true;
            const fExt = getFileExtension(f.title);
            return isVideoExtension(fExt);
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
            const ctx = workTreeContext as PatchableWorkTree;
            const ctxFolder = ctx.fatherFolder ?? ctx.$data?.fatherFolder ?? ctx._data?.fatherFolder;
            if (Array.isArray(ctxFolder) && ctxFolder.length > 0) {
                fatherFolder = ctxFolder as MediaFile[];
            }
            if (fatherFolder.length === 0 && Array.isArray(ctx.tree)) {
                fatherFolder = this.flattenTracksResponse(ctx.tree as Array<TrackFolder | TrackItem>);
            } else if (fatherFolder.length === 0) {
                const ctxDataTree = ctx.$data?.tree;
                if (Array.isArray(ctxDataTree)) {
                    fatherFolder = this.flattenTracksResponse(ctxDataTree as Array<TrackFolder | TrackItem>);
                }
            }
        }

        if (fatherFolder.length === 0) {
            const workTree = this.findWorkTreeComponent() as PatchableWorkTree | null;
            if (workTree) {
                const wtFolder = workTree.fatherFolder ?? workTree.$data?.fatherFolder ?? workTree._data?.fatherFolder;
                if (Array.isArray(wtFolder) && wtFolder.length > 0) {
                    fatherFolder = wtFolder as MediaFile[];
                }
                if (fatherFolder.length === 0 && Array.isArray(workTree.tree)) {
                    fatherFolder = this.flattenTracksResponse(workTree.tree as Array<TrackFolder | TrackItem>);
                } else if (fatherFolder.length === 0) {
                    const wtDataTree = workTree.$data?.tree;
                    if (Array.isArray(wtDataTree)) {
                        fatherFolder = this.flattenTracksResponse(wtDataTree as Array<TrackFolder | TrackItem>);
                    }
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
        const mediaList = fatherFolder.filter((f: MediaFile) => matchesRequestedMediaType(f, type));

        return mediaList;
    }

    // =========================================================================
    // DOM scanning fallback
    // =========================================================================

    private scanDomForMediaItems(type: ViewerMediaType): MediaFile[] {
        const workTreeEl = this.findWorkTreeElement();
        if (!workTreeEl) return [];

        const items: MediaFile[] = [];
        const seenHashes = new Set<string>();
        const qItems = workTreeEl.querySelectorAll('.q-item');

        qItems.forEach((qItem) => {
            const title = getMediaTitleFromListItem(qItem);
            if (!title) return;

            const vueEl = qItem as Vue2MediaElement;
            const fromVue = readMediaItemFromVueElement(vueEl);
            const candidateType = resolveMediaTypeForCandidate(title, fromVue?.type);
            if (candidateType !== type) return;

            let hash = readMediaHashFromElement(vueEl);

            if (!hash && fromVue?.hash) hash = fromVue.hash;

            if (!hash) {
                const workTree = this.findWorkTreeComponent() as PatchableWorkTree | null;
                const folder = (workTree?.fatherFolder ??
                    workTree?.$data?.fatherFolder ?? []) as MediaFile[];
                if (folder.length > 0) {
                    const match = findMatchingMediaItem({ hash: '', title }, folder);
                    if (match?.hash) hash = match.hash;
                }
            }

            if (hash && !seenHashes.has(hash)) {
                seenHashes.add(hash);
                items.push({ hash, title, type: candidateType });
            }
        });

        return items;
    }

    // =========================================================================
    // Utility Methods
    // =========================================================================

    private getMediaUrl(hash: string, item?: MediaFile): string {
        const token = localStorage.getItem('jwt-token') || '';
        return buildMediaStreamUrl(hash, item, token);
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
                    const trackWithAlt = item as TrackItem & { media_stream_url?: string };
                    result.push({
                        hash: item.hash,
                        title: item.title,
                        type: item.type,
                        mediaStreamUrl: item.mediaStreamUrl || trackWithAlt.media_stream_url,
                        media_stream_url: trackWithAlt.media_stream_url
                    });
                }
            }
        };

        traverse(nodes);
        return result;
    }

    private getWorkTreeTree(): Array<TrackFolder | TrackItem> | null {
        const workTree = this.findWorkTreeComponent() as PatchableWorkTree | null;
        const tree = workTree?.tree ?? workTree?.$data?.tree;
        return Array.isArray(tree) ? tree as Array<TrackFolder | TrackItem> : null;
    }
}
