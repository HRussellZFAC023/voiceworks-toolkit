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
import type { TrackFolder, TrackItem, PlayerTrack } from '../types/api';
import MediaLightboxVue from './components/MediaLightbox.vue';
import {
    findMatchingMediaItem,
    getFileExtension,
    isImageExtension,
    isPdfExtension,
    isTextExtension,
    isVideoExtension,
} from './media/mediaFileUtils';
import {
    buildMediaStreamUrl,
    resolveMediaApiBaseUrl,
} from './media/mediaStreamUrlUtils';
import { replaceHostPlaybackQueue } from './audioPlayerQueueUtils';
import {
    applyMediaViewerWorkTreePatch,
    restoreMediaViewerWorkTreePatch,
    type WorkTreeClickHandler,
} from './media/mediaViewerWorkTreePatchUtils';
import { readHostAuthToken } from '../core/hostAuthToken';
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
    private enabled = false;
    private delegatedClickInstalled = false;
    private thumbnailCache = new Map<string, string>();
    private thumbnailManager: ThumbnailManager;
    private patchedWorkTree: PatchableWorkTree | null = null;
    private activeVideoMediaList: MediaFile[] = [];

    // Bound event handlers
    private boundDelegatedClick: (e: MouseEvent) => void;

    // Cleanup handles
    private playerWatcher: (() => void) | undefined;
    private routeCleanupUnsubscribe: (() => void) | undefined;
    private folderPathWatcherCleanup: (() => void) | undefined;
    private delayedTasks = new Set<number>();

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
        if (this.enabled) return;
        this.enabled = true;
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
        this.enabled = false;
        CentralObserver.unregister('MediaViewer');
        for (const timer of this.delayedTasks) window.clearTimeout(timer);
        this.delayedTasks.clear();

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
        this.activeVideoMediaList = [];
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
                    onVideoSelected: (item: MediaFile) => {
                        void this.handleLightboxVideoSelected(item);
                    },
                },
                container
            );

            // Use the proxy returned by app.mount() — works in both dev and prod builds.
            // (app._instance is only set in dev/devtools builds, so never use it.)
            this.lightboxRef = this.mounted.proxy as unknown as MediaLightboxExposed;

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

        let hash = readMediaHashFromElement(qItem as Vue2MediaElement);
        let itemData: MediaFile | null = null;
        const workTree = this.findWorkTreeComponent() as PatchableWorkTree | null;
        const folder = (workTree?.fatherFolder ??
            workTree?.$data?.fatherFolder ?? []) as MediaFile[];
        const canonicalItem = folder.length > 0
            ? findMatchingMediaItem({ hash, title }, folder)
            : undefined;

        if (canonicalItem) {
            hash = canonicalItem.hash || hash;
            itemData = {
                ...canonicalItem,
                hash,
                type: mediaType,
            };
        } else if (hash) {
            // Preserve stream/download URLs and expected size from the host
            // item. They let the lightbox validate the real upstream image
            // instead of falling back to an opaque synthetic stream URL.
            itemData = vueItem
                ? { ...vueItem, hash, title, type: mediaType }
                : { hash, title, type: mediaType };
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
            if (folder.length > 0) {
                const match = findMatchingMediaItem({ hash: '', title }, folder);
                if (match) {
                    itemData = match;
                    hash = match.hash || '';
                }
            }
        }

        // If neither the host data nor DOM exposes a usable source, leave the
        // click alone so the native viewer can handle it.
        if (!itemData) return;

        e.stopPropagation();
        e.preventDefault();

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
        return (
            this.bridge.findWorkTreeComponent?.()
            || this.bridge.findComponent(
                (vm: KikoeruApp) => vm.$options?.name === 'WorkTree'
            )
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
            if (!this.enabled || !this.findWorkTreeElement()) return;
            this.scheduleTask(() => {
                this.hookWorkTree();
                this.thumbnailManager.injectThumbnails();
                this.watchFolderNavigation();
            }, 100);
        }, 500);
    }

    private scheduleTask(callback: () => void, delayMs: number): void {
        if (!this.enabled) return;
        const timer = window.setTimeout(() => {
            this.delayedTasks.delete(timer);
            if (this.enabled) callback();
        }, delayMs);
        this.delayedTasks.add(timer);
    }

    private watchFolderNavigation(): void {
        if (this.folderWatcherSetup || this.folderPathWatcherCleanup) return;

        const workTree = this.findWorkTreeComponent();
        if (!workTree) return;

        if (workTree.$watch) {
            const unwatch = workTree.$watch('path', () => {
                const doInject = () => this.thumbnailManager.injectThumbnails();
                if (typeof workTree.$nextTick === 'function') {
                    workTree.$nextTick(() => this.scheduleTask(doInject, 50));
                } else {
                    this.scheduleTask(doInject, 200);
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
                trackHash: state.AudioPlayer?.currentTrack?.hash || state.AudioPlayer?.currentPlayingFile?.hash || '',
                trackTitle: state.AudioPlayer?.currentTrack?.title || state.AudioPlayer?.currentPlayingFile?.title || '',
                trackSrc: this.resolvePlayerTrackSource(state.AudioPlayer?.currentTrack as PlayerTrack | undefined)
                    || this.resolvePlayerTrackSource(state.AudioPlayer?.currentPlayingFile as PlayerTrack | undefined)
                    || state.AudioPlayer?.source
                    || state.AudioPlayer?.src
                    || state.AudioPlayer?.currentSrc
                    || '',
            }),
            (val, oldVal) => {
                if (val.hide === false && oldVal?.hide === true) {
                    if (this.lightboxRef?.getIsActive() && !document.body.classList.contains('asmr-fullscreen-active')) {
                        const modal = document.getElementById('asmr-media-viewer-modal');
                        const isVideoModal = !!modal?.querySelector('video.media-viewer-video');
                        if (!isVideoModal) {
                            Logger.debug('[MediaViewerController] Player expanded, closing lightbox');
                            this.lightboxRef.hideModal();
                        }
                    }
                }

                // Sync video playback state
                if (this.lightboxRef?.getIsActive()) {
                    const modal = document.getElementById('asmr-media-viewer-modal');
                    const video = modal?.querySelector('video.media-viewer-video') as HTMLVideoElement | null;
                    if (video) {
                        const trackChanged = val.trackHash !== oldVal?.trackHash
                            || this.normalizeComparableUrl(val.trackSrc) !== this.normalizeComparableUrl(oldVal?.trackSrc);
                        if (trackChanged) {
                            this.syncLightboxVideoTrack(val.trackHash, val.trackSrc, val.trackTitle);
                        }

                        const isPlayerBoundVideo = this.isDisplayedVideoMatchingPlayer(video, val.trackHash, val.trackSrc, val.trackTitle);
                        if (!isPlayerBoundVideo) {
                            return;
                        }

                        if (val.playing && video.paused) {
                            video.play().catch(() => { });
                        } else if (!val.playing && !video.paused) {
                            video.pause();
                        }
                        if (typeof val.currentTime === 'number' && Math.abs(video.currentTime - val.currentTime) > 1.2) {
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
        this.activeVideoMediaList = type === 'video' ? [item] : [];

        const initialHash = item.hash;
        const hasFakeHash = !initialHash || initialHash.startsWith('__delegated_');

        // Show modal immediately with the single item
        await this.lightboxRef.showMedia(item, type, [item], 0);

        // For videos, load the track into the native AudioPlayer so the mini player bar appears
        if (type === 'video' && !hasFakeHash) {
            await this.playVideoInNativePlayer(item, workTreeContext);
        }

        // Fetch full media list in the background
        const requestId = ++this.activeRequestId;
        const mediaList = await this.populateMediaList(item, type, requestId, workTreeContext);

        if (requestId !== this.activeRequestId || !this.lightboxRef) return;

        let matchedItem: MediaFile | null = null;
        let matchedIndex = 0;
        if (mediaList && mediaList.length > 0) {
            matchedItem = findMatchingMediaItem(item, mediaList) || null;
            matchedIndex = matchedItem ? mediaList.indexOf(matchedItem) : 0;
            this.lightboxRef.updateMediaList(mediaList, Math.max(0, matchedIndex));
            if (type === 'video') {
                this.activeVideoMediaList = mediaList;
            }

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

        // Always rebuild the queue once the full media list is available, even
        // if the current track matches — the initial call only had [item] so the
        // queue had 1 entry. This gives next/prev track navigation.
        if (type === 'video' && mediaList && mediaList.length > 0) {
            const target = matchedItem || item;
            await this.playVideoInNativePlayer(target, workTreeContext, mediaList);
        }

        this.lightboxRef.startSlideshowAfterPopulation();

        // Re-inject thumbnails after close
        // (handled by the 'closed' event from the lightbox, but also:)
        // Thumbnails are re-injected via the CentralObserver
    }

    /**
     * Load the video file into the native AudioPlayer so the mini player bar appears.
     * Uses a video-only queue from the current folder so lightbox navigation and player
     * track changes stay synchronized.
     */
    private async playVideoInNativePlayer(
        item: MediaFile,
        workTreeContext?: WorkTreeComponent,
        resolvedMediaList?: MediaFile[]
    ): Promise<void> {
        const store = this.bridge.store;
        if (!store.commit) return;

        // Prefer resolvedMediaList (explicitly fetched) over work tree context
        // (which may be stale or return items that don't filter to videos).
        let allItems: MediaFile[] = [];
        if (Array.isArray(resolvedMediaList) && resolvedMediaList.length > 0) {
            allItems = resolvedMediaList;
        }
        if (allItems.length === 0 && workTreeContext) {
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
            if (String(f.type || '').toLowerCase() === 'video') return true;
            const fExt = getFileExtension(f.title);
            return isVideoExtension(fExt);
        }).map(f => this.buildVideoQueueTrack(f));

        if (queue.length === 0) {
            queue.push(this.buildVideoQueueTrack(item));
        }

        let index = queue.findIndex(f => f.hash && f.hash === item.hash);
        if (index < 0) {
            const targetSrc = this.normalizeComparableUrl(this.getMediaUrl(item.hash, item));
            index = queue.findIndex(f => this.normalizeComparableUrl(this.resolvePlayerTrackSource(f)) === targetSrc);
        }
        if (index < 0 && item.title) {
            index = queue.findIndex(f => f.title === item.title);
        }
        if (index < 0) {
            queue.unshift(this.buildVideoQueueTrack(item));
            index = 0;
        }

        // Use the host player contract directly, with the track/index moved
        // before the queue to protect the deployed synchronous queue watcher.
        // Do NOT call stopNativePlayback() — audio.pause() queues a DOM pause
        // event that fires AFTER SET_TRACK, racing PAUSE vs PLAY and resetting
        // playing=false. SET_TRACK sets playing=true and the source watcher in
        // AudioElement.vue handles load() + canplay → play() naturally.
        replaceHostPlaybackQueue(store, this.bridge, queue, index);

        this.minimizeNativePlayerIfExpanded();

        Logger.debug(`[MediaViewerController] Playing video in native player: ${item.title} (${index + 1}/${queue.length})`);
    }

    private async handleLightboxVideoSelected(item: MediaFile): Promise<void> {
        if (!item || !matchesRequestedMediaType(item, 'video')) return;
        if (!this.lightboxRef?.getIsActive()) return;
        const hasRealHash = !!item.hash && !item.hash.startsWith('__delegated_');
        const hasDirectSrc = !!(item.mediaStreamUrl || item.media_stream_url);
        if (!hasRealHash && !hasDirectSrc) return;
        if (this.isCurrentTrackMatchingMedia(item)) return;

        const workTreeContext = this.findWorkTreeComponent() || undefined;
        const resolvedList = this.activeVideoMediaList.length > 0 ? this.activeVideoMediaList : undefined;
        await this.playVideoInNativePlayer(item, workTreeContext, resolvedList);
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
        const workTree = this.findWorkTreeComponent() as PatchableWorkTree | null;
        const folder = (workTree?.fatherFolder ??
            workTree?.$data?.fatherFolder ?? []) as MediaFile[];

        qItems.forEach((qItem) => {
            const title = getMediaTitleFromListItem(qItem);
            if (!title) return;

            const vueEl = qItem as Vue2MediaElement;
            const fromVue = readMediaItemFromVueElement(vueEl);
            const candidateType = resolveMediaTypeForCandidate(title, fromVue?.type);
            if (candidateType !== type) return;

            let hash = readMediaHashFromElement(vueEl);

            if (!hash && fromVue?.hash) hash = fromVue.hash;

            const canonicalItem = folder.length > 0
                ? findMatchingMediaItem({ hash, title }, folder)
                : undefined;
            if (canonicalItem?.hash) hash = canonicalItem.hash;

            if (hash && !seenHashes.has(hash)) {
                seenHashes.add(hash);
                items.push(canonicalItem
                    ? { ...canonicalItem, hash, type: candidateType }
                    : fromVue
                    ? { ...fromVue, hash, title, type: candidateType }
                    : { hash, title, type: candidateType });
            }
        });

        return items;
    }

    // =========================================================================
    // Utility Methods
    // =========================================================================

    private getMediaUrl(hash: string, item?: MediaFile): string {
        const token = readHostAuthToken();
        const apiBaseUrl = resolveMediaApiBaseUrl(this.bridge.axios?.defaults?.baseURL);
        return buildMediaStreamUrl(hash, item, token, apiBaseUrl);
    }

    private resolvePlayerTrackSource(track?: PlayerTrack | null): string {
        if (!track) return '';
        return String(
            track.streamLowQualityUrl
            || track.mediaStreamUrl
            || track.media_stream_url
            || track.src
            || track.stream_url
            || track.url
            || '',
        );
    }

    private normalizeComparableUrl(url?: string): string {
        const raw = String(url || '').trim();
        if (!raw) return '';

        try {
            const parsed = new URL(raw, window.location.origin);
            parsed.searchParams.delete('token');
            parsed.searchParams.delete('_r');
            return `${parsed.origin}${parsed.pathname}`.toLowerCase();
        } catch {
            return raw.split('?')[0].toLowerCase();
        }
    }

    private findMatchingVideoFromActiveList(trackHash?: string, trackSrc?: string, trackTitle?: string): { item: MediaFile; index: number } | null {
        if (!this.activeVideoMediaList.length) return null;

        const normalizedTrackSrc = this.normalizeComparableUrl(trackSrc);
        const normalizedTrackTitle = String(trackTitle || '').trim().toLowerCase();
        for (let i = 0; i < this.activeVideoMediaList.length; i++) {
            const candidate = this.activeVideoMediaList[i];
            if (!matchesRequestedMediaType(candidate, 'video')) continue;

            if (trackHash && candidate.hash && candidate.hash === trackHash) {
                return { item: candidate, index: i };
            }

            const candidateSrc = this.normalizeComparableUrl(this.getMediaUrl(candidate.hash, candidate));
            if (normalizedTrackSrc && candidateSrc && normalizedTrackSrc === candidateSrc) {
                return { item: candidate, index: i };
            }

            if (normalizedTrackTitle && String(candidate.title || '').trim().toLowerCase() === normalizedTrackTitle) {
                return { item: candidate, index: i };
            }
        }

        return null;
    }

    private syncLightboxVideoTrack(trackHash?: string, trackSrc?: string, trackTitle?: string): void {
        if (!this.lightboxRef?.getIsActive()) return;
        const modal = document.getElementById('asmr-media-viewer-modal');
        const video = modal?.querySelector('video.media-viewer-video') as HTMLVideoElement | null;
        if (!video) return;

        const match = this.findMatchingVideoFromActiveList(trackHash, trackSrc, trackTitle);
        if (match) {
            this.lightboxRef.updateMediaList(this.activeVideoMediaList, match.index);
            const currentHash = String(video.dataset.mediaHash || '');
            const currentSrc = this.normalizeComparableUrl(video.currentSrc || video.src);
            const nextSrc = this.normalizeComparableUrl(this.getMediaUrl(match.item.hash, match.item));
            const isSameVideo = (currentHash && match.item.hash && currentHash === match.item.hash)
                || (currentSrc && nextSrc && currentSrc === nextSrc);
            if (!isSameVideo) {
                this.lightboxRef.renderResolvedItem(match.item, 'video');
            }
            return;
        }

        if (trackSrc) {
            const normalizedCurrent = this.normalizeComparableUrl(video.currentSrc || video.src);
            const normalizedNext = this.normalizeComparableUrl(trackSrc);
            if (normalizedNext && normalizedNext !== normalizedCurrent) {
                video.src = trackSrc;
                video.load();
            }
        }
    }

    private isDisplayedVideoMatchingPlayer(
        video: HTMLVideoElement,
        trackHash?: string,
        trackSrc?: string,
        trackTitle?: string,
    ): boolean {
        const displayedHash = String(video.dataset.mediaHash || '').trim();
        const displayedTitle = String(video.dataset.mediaTitle || '').trim().toLowerCase();
        const displayedSrc = this.normalizeComparableUrl(video.currentSrc || video.src);
        const normalizedTrackSrc = this.normalizeComparableUrl(trackSrc);

        if (trackHash && displayedHash && trackHash === displayedHash) {
            return true;
        }
        if (normalizedTrackSrc && displayedSrc && normalizedTrackSrc === displayedSrc) {
            return true;
        }
        if (trackTitle && displayedTitle && displayedTitle === String(trackTitle).trim().toLowerCase()) {
            return true;
        }

        const match = this.findMatchingVideoFromActiveList(trackHash, trackSrc, trackTitle);
        if (!match) return false;

        if (displayedHash && match.item.hash && displayedHash === match.item.hash) {
            return true;
        }
        const matchSrc = this.normalizeComparableUrl(this.getMediaUrl(match.item.hash, match.item));
        if (matchSrc && displayedSrc && matchSrc === displayedSrc) {
            return true;
        }
        return false;
    }

    private isCurrentTrackMatchingMedia(item: MediaFile): boolean {
        const state = this.bridge.store.state?.AudioPlayer;
        const currentTrack = (state?.currentTrack || state?.currentPlayingFile) as PlayerTrack | undefined;
        if (!currentTrack) return false;

        if (item.hash && currentTrack.hash && item.hash === currentTrack.hash) {
            return true;
        }

        const currentSrc = this.resolvePlayerTrackSource(currentTrack) || state?.source || state?.src || state?.currentSrc || '';
        const expectedSrc = this.getMediaUrl(item.hash, item);
        return this.normalizeComparableUrl(currentSrc) === this.normalizeComparableUrl(expectedSrc);
    }

    private buildVideoQueueTrack(item: MediaFile): PlayerTrack {
        const currentWork = this.bridge.store.state?.AudioPlayer?.work;
        const mediaStreamUrl = this.getMediaUrl(item.hash, item);
        const workTitle = currentWork?.title || '';
        // Work ID from hash "1458220/subdir/file.mp4" → 1458220
        const workIdNum = parseInt(item.hash?.split('/')[0] || '0', 10) || 0;

        return {
            type: 'audio',
            hash: item.hash,
            title: item.title,
            workTitle,
            mediaStreamUrl,
            mediaDownloadUrl: mediaStreamUrl,
            // The deployed host's AudioElement accesses currentPlayingFile.work.id
            // in event handlers. Without this, work is undefined → .id crashes.
            work: {
                id: currentWork?.id ?? workIdNum,
                source_id: currentWork?.source_id || `RJ${String(workIdNum).padStart(6, '0')}`,
                source_type: currentWork?.source_type || 'DLSITE',
            },
            // Host watcher accesses track.subtitles.length — must not be undefined
            subtitles: [],
        } as PlayerTrack;
    }

    private minimizeNativePlayerIfExpanded(): void {
        const player = this.bridge.store.state?.AudioPlayer;
        if (!player || player.hide) return;
        try {
            this.bridge.commit('AudioPlayer/TOGGLE_HIDE');
        } catch {
            // Optional mutation across host versions
        }
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
                    const trackWithAlt = item as TrackItem & {
                        media_stream_url?: string;
                        media_download_url?: string;
                    };
                    result.push({
                        hash: item.hash,
                        title: item.title,
                        type: item.type,
                        mediaStreamUrl: item.mediaStreamUrl || trackWithAlt.media_stream_url,
                        media_stream_url: trackWithAlt.media_stream_url,
                        mediaDownloadUrl: item.mediaDownloadUrl || trackWithAlt.media_download_url,
                        media_download_url: trackWithAlt.media_download_url,
                        size: item.size,
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
