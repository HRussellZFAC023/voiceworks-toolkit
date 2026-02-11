/**
 * FlatView - Side drawer panel showing all files from a work in a flat list
 *
 * Coexists with the native WorkTree - does NOT replace it.
 * Opens as a right-side drawer panel with slide-in animation.
 * Supports playback, lightbox, copy, and all other integrations.
 */

import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { Logger } from '../core/Logger';
import { CentralObserver } from '../core/CentralObserver';
import { TIMING } from '../core/Constants';
import { EventBus } from '../core/EventBus';
import { isDarkMode } from '../core/DomUtils';
import type { TrackFolder, TrackItem, TracksResponse } from '../types/api';
import { WorkService } from '../services/WorkService';
import { I18n } from '../core/Utils';
import { TranslationService } from '../services/TranslationService';
import { Priority } from '../core/GpuScheduler';

/** A flattened item with folder path context */
interface FlatItem {
    type: 'audio' | 'image' | 'text' | 'other';
    hash: string;
    title: string;
    folderPath: string;
    mediaStreamUrl?: string;
    mediaDownloadUrl?: string;
    workTitle?: string;
    duration?: number;
    /** Original item reference for Vuex dispatch */
    raw: TrackItem;
}

export class FlatView {
    private bridge: KikoeruBridge;
    private isActive = false;
    private panelEl: HTMLElement | null = null;
    private backdropEl: HTMLElement | null = null;
    private bodyEl: HTMLElement | null = null;
    private unwatchTrack: (() => void) | null = null;
    private unwatchWork: (() => void) | null = null;
    private escapeHandler: ((e: KeyboardEvent) => void) | null = null;
    private bottomOffsetTimer: ReturnType<typeof setInterval> | null = null;
    private currentItems: FlatItem[] = [];
    private prefetchedData: TracksResponse | null = null;
    private prefetchWorkId: string | null = null;
    private prefetchPromise: Promise<void> | null = null;
    private static readonly TRANSLATION_PRIORITY = Priority.NORMAL;

    constructor() {
        this.bridge = KikoeruBridge.getInstance();
    }

    public get active(): boolean {
        return this.isActive;
    }

    public show(): void {
        this.isActive = true;
        this.ensurePanel();
        this.syncDarkMode();
        this.syncHeaderOffset();
        this.syncBottomOffset();
        this.startBottomOffsetWatch();
        this.renderFlatList();
        this.panelEl?.classList.add('asmr-flat-panel--open');
        this.backdropEl?.classList.add('asmr-flat-backdrop--visible');
        document.body.classList.add('asmr-flat-open');
        this.updateToggleState();
        EventBus.emit('flatview:toggle', { active: true });
    }

    public hide(): void {
        this.isActive = false;
        this.panelEl?.classList.remove('asmr-flat-panel--open');
        this.backdropEl?.classList.remove('asmr-flat-backdrop--visible');
        document.body.classList.remove('asmr-flat-open');
        this.stopBottomOffsetWatch();
        this.updateToggleState();
        // Restore miniplayer position
        const expandedPlayer = document.querySelector('.audio-player.fixed-bottom-right') as HTMLElement | null;
        if (expandedPlayer) expandedPlayer.style.right = '';
        if (this.unwatchTrack) {
            this.unwatchTrack();
            this.unwatchTrack = null;
        }
        TranslationService.cancelPending({ cancellableKey: this.getTranslationQueueKey() });
        EventBus.emit('flatview:toggle', { active: false });
    }

    public enable(): void {
        CentralObserver.register('FlatView', () => this.ensureToggle(), TIMING.OBSERVER_REGISTER_DEBOUNCE_MS);
        this.ensureToggle();
        this.watchWork();
    }

    public disable(): void {
        if (this.isActive) this.hide();
        TranslationService.cancelPending({ cancellableKey: this.getTranslationQueueKey() });
        if (this.unwatchWork) {
            this.unwatchWork();
            this.unwatchWork = null;
        }
        if (this.escapeHandler) {
            document.removeEventListener('keydown', this.escapeHandler);
            this.escapeHandler = null;
        }
    }

    /** Get the current flat items (for external consumers like MediaViewer) */
    public getItems(): FlatItem[] {
        return this.currentItems;
    }

    /**
     * Prefetch tree data for a work so the panel opens instantly.
     * Called by WorkTreeManager when navigating to a work page.
     */
    public prefetch(workId: string): void {
        if (this.prefetchWorkId === workId && this.prefetchPromise) return;
        this.prefetchWorkId = workId;
        this.prefetchedData = null;
        this.prefetchPromise = this.getTreeDataWithRetry().then(data => {
            // Only store if still for the same work
            if (this.prefetchWorkId === workId && data) {
                this.prefetchedData = data;
                Logger.debug(`[FlatView] Prefetched ${data.length} tree nodes for ${workId}`);
            }
        }).catch(() => {
            // Prefetch is best-effort
        });
    }

    // =========================================================================
    // Panel DOM
    // =========================================================================

    private ensurePanel(): void {
        if (this.panelEl) return;

        // Create backdrop (mobile: click to close)
        this.backdropEl = document.createElement('div');
        this.backdropEl.className = 'asmr-flat-backdrop';
        this.backdropEl.setAttribute('aria-hidden', 'true');
        this.backdropEl.addEventListener('click', () => this.hide());
        document.body.appendChild(this.backdropEl);

        // Create panel
        this.panelEl = document.createElement('div');
        this.panelEl.className = 'asmr-flat-panel';
        this.panelEl.setAttribute('role', 'complementary');
        this.panelEl.setAttribute('aria-label', I18n.t('fileListHeader'));

        // Apply Quasar dark classes so item labels/icons inherit the host dark theme
        this.syncDarkMode();

        // Header
        const header = document.createElement('div');
        header.className = 'asmr-flat-panel__header';

        const titleDiv = document.createElement('div');
        titleDiv.className = 'asmr-flat-panel__title';
        titleDiv.innerHTML = `
            <i aria-hidden="true" class="q-icon material-icons">view_list</i>
            <span>${I18n.t('fileListHeader')}</span>
            <span class="asmr-flat-panel__count"></span>
        `;

        const closeBtn = document.createElement('button');
        closeBtn.className = 'asmr-flat-panel__close';
        closeBtn.setAttribute('aria-label', I18n.t('fileListClose'));
        closeBtn.innerHTML = '<i class="q-icon material-icons">close</i>';
        closeBtn.addEventListener('click', () => this.hide());

        header.appendChild(titleDiv);
        header.appendChild(closeBtn);

        // Body (scrollable area)
        this.bodyEl = document.createElement('div');
        this.bodyEl.className = 'asmr-flat-panel__body';

        this.panelEl.appendChild(header);
        this.panelEl.appendChild(this.bodyEl);
        document.body.appendChild(this.panelEl);

        // Close on Escape key (only attach once)
        if (!this.escapeHandler) {
            this.escapeHandler = (e: KeyboardEvent) => {
                if (e.key === 'Escape' && this.isActive) {
                    this.hide();
                }
            };
            document.addEventListener('keydown', this.escapeHandler);
        }
    }

    // =========================================================================
    // Toggle Button
    // =========================================================================

    private ensureToggle(): void {
        if (!location.pathname.includes('/work/')) return;

        const downloadBtn = document.querySelector('button .q-btn__content .block')?.closest('button');
        if (!downloadBtn) return;

        const container = downloadBtn.parentElement;
        if (!container || container.querySelector('.asmr-flat-toggle')) return;

        const btn = document.createElement('button');
        btn.className = 'q-btn q-btn-item non-selectable no-outline q-mt-sm shadow-4 q-mx-xs q-px-sm q-btn--standard q-btn--rectangle text-white q-btn--actionable q-focusable q-hoverable q-btn--wrap q-btn--dense asmr-flat-toggle';
        this.updateButtonStyle(btn);

        btn.innerHTML = `
            <span class="q-focus-helper"></span>
            <span class="q-btn__wrapper col row q-anchor--skip">
                <span class="q-btn__content text-center col items-center q-anchor--skip justify-center row">
                    <i aria-hidden="true" role="img" class="q-icon on-left notranslate material-icons">view_list</i>
                    <span class="block">${I18n.t('flatView')}</span>
                </span>
            </span>
        `;
        btn.addEventListener('click', () => {
            if (this.isActive) {
                this.hide();
            } else {
                this.show();
            }
        });
        container.appendChild(btn);
    }

    private updateToggleState(): void {
        document.querySelectorAll('.asmr-flat-toggle').forEach(el => {
            this.updateButtonStyle(el as HTMLElement);
        });
    }

    private updateButtonStyle(btn: HTMLElement): void {
        if (this.isActive) {
            btn.style.setProperty('background', 'var(--asmr-accent)', 'important');
            btn.classList.remove('bg-grey-8');
        } else {
            btn.style.removeProperty('background');
            btn.classList.add('bg-grey-8');
        }
    }

    // =========================================================================
    // Tree Flattening
    // =========================================================================

    private flattenTree(nodes: TracksResponse, parentPath = ''): FlatItem[] {
        const items: FlatItem[] = [];
        for (const node of nodes) {
            if (node.type === 'folder') {
                const folder = node as TrackFolder;
                const folderPath = parentPath ? `${parentPath} / ${folder.title}` : folder.title;
                items.push(...this.flattenTree(folder.children, folderPath));
            } else {
                const item = node as TrackItem;
                items.push({
                    type: item.type,
                    hash: item.hash,
                    title: item.title,
                    folderPath: parentPath,
                    mediaStreamUrl: item.mediaStreamUrl,
                    mediaDownloadUrl: item.mediaDownloadUrl,
                    workTitle: item.workTitle,
                    duration: (item as any).duration,
                    raw: item,
                });
            }
        }
        return items;
    }

    // =========================================================================
    // Data Source
    // =========================================================================

    private getTreeData(): TracksResponse | null {
        const treeVm = this.bridge.findWorkTreeComponent() as any;
        if (treeVm?.tree && Array.isArray(treeVm.tree) && treeVm.tree.length > 0) {
            return treeVm.tree as TracksResponse;
        }
        return null;
    }

    private async getTreeDataWithRetry(maxAttempts = 8): Promise<TracksResponse | null> {
        for (let i = 0; i < maxAttempts; i++) {
            const data = this.getTreeData();
            if (data) return data;
            await new Promise(r => setTimeout(r, 400));
        }

        // Fallback: fetch via API
        try {
            const workId = this.bridge.currentWorkId;
            if (workId) {
                Logger.debug('[FlatView] Fetching tree data via API fallback');
                return await WorkService.getTracks(workId);
            }
        } catch (e) {
            Logger.warn('[FlatView] API fallback failed:', e);
        }

        return null;
    }

    // =========================================================================
    // DOM Rendering
    // =========================================================================

    private async renderFlatList(): Promise<void> {
        // Use prefetched data if available for the current work
        const currentWorkId = this.bridge.currentWorkId;
        let treeData: TracksResponse | null = null;
        if (this.prefetchedData && this.prefetchWorkId === currentWorkId) {
            treeData = this.prefetchedData;
            Logger.debug('[FlatView] Using prefetched tree data');
        } else if (this.prefetchPromise && this.prefetchWorkId === currentWorkId) {
            // Prefetch in progress — wait for it
            await this.prefetchPromise;
            if (this.prefetchedData && this.prefetchWorkId === currentWorkId) {
                treeData = this.prefetchedData;
                Logger.debug('[FlatView] Using prefetched tree data (waited)');
            }
        }
        if (!treeData) {
            treeData = await this.getTreeDataWithRetry();
        }
        if (!treeData || treeData.length === 0) {
            Logger.warn('[FlatView] No tree data available');
            return;
        }

        this.currentItems = this.flattenTree(treeData);
        if (this.currentItems.length === 0) {
            Logger.warn('[FlatView] No items after flattening');
            return;
        }

        Logger.debug(`[FlatView] Flattened ${this.currentItems.length} items from tree`);

        // Update count in header
        const countEl = this.panelEl?.querySelector('.asmr-flat-panel__count');
        if (countEl) {
            countEl.textContent = I18n.format('fileListCount', { count: this.currentItems.length });
        }

        if (!this.bodyEl) return;

        // Build the list HTML matching WorkTree.vue's Quasar markup
        const audioItems = this.currentItems.filter(i => i.type === 'audio');
        const currentHash = this.getCurrentPlayingHash();
        const dark = isDarkMode();
        const darkItem = dark ? ' q-item--dark' : '';
        const token = this.getToken();

        const listHtml = this.currentItems.map((item, idx) => {
            const isPlaying = item.type === 'audio' && item.hash === currentHash;
            const activeClass = isPlaying ? ' asmr-flat-active' : '';
            const icon = this.getItemIcon(item, token);

            return `
            <div class="q-item q-item-type row no-wrap q-item--clickable q-link cursor-pointer q-focusable q-hoverable non-selectable${darkItem}${activeClass}"
                 role="listitem" tabindex="0"
                 data-asmr-flat-idx="${idx}" data-asmr-flat-hash="${item.hash}" data-asmr-flat-type="${item.type}">
                <div class="q-item__section column q-item__section--avatar q-item__section--side justify-center">
                    ${icon}
                </div>
                <div class="q-item__section column q-item__section--main justify-center">
                    <div class="q-item__label" style="overflow-wrap: break-word;">${this.escapeHtml(item.title)}</div>
                    ${item.folderPath ? `<div class="q-item__label q-item__label--caption text-caption ellipsis">${this.escapeHtml(item.folderPath)}</div>` : ''}
                </div>
            </div>`;
        }).join('\n');

        this.bodyEl.innerHTML = `
            <div class="q-card${dark ? ' q-card--dark q-dark' : ''}">
                <div class="q-list q-list--separator${dark ? ' q-list--dark' : ''}" role="list">
                    ${listHtml}
                </div>
            </div>
        `;

        // Attach click and keyboard handlers
        this.bodyEl.querySelectorAll('[data-asmr-flat-idx]').forEach(el => {
            const handleActivate = () => {
                const idx = parseInt((el as HTMLElement).dataset.asmrFlatIdx || '0', 10);
                this.onClickItem(this.currentItems[idx], audioItems);
            };
            el.addEventListener('click', handleActivate);
            el.addEventListener('keydown', (e: Event) => {
                const ke = e as KeyboardEvent;
                if (ke.key === 'Enter' || ke.key === ' ') {
                    ke.preventDefault();
                    handleActivate();
                }
            });
        });

        // Start watching for active track changes
        this.watchActiveTrack();

        // Auto-translate titles and folder paths
        this.translateVisibleItems();
    }

    private async translateVisibleItems(): Promise<void> {
        if (!this.bodyEl) return;

        // Collect all unique texts that need translation
        const titleEls = this.bodyEl.querySelectorAll<HTMLElement>('.q-item__label:not(.q-item__label--caption)');
        const captionEls = this.bodyEl.querySelectorAll<HTMLElement>('.q-item__label--caption');

        const textsToTranslate: string[] = [];
        const elementMap: { el: HTMLElement; textIdx: number }[] = [];

        const addText = (el: HTMLElement) => {
            const text = el.textContent?.trim();
            if (!text) return;
            const idx = textsToTranslate.indexOf(text);
            if (idx >= 0) {
                elementMap.push({ el, textIdx: idx });
            } else {
                elementMap.push({ el, textIdx: textsToTranslate.length });
                textsToTranslate.push(text);
            }
        };

        titleEls.forEach(addText);
        captionEls.forEach(addText);

        if (textsToTranslate.length === 0) return;

        try {
            const queueKey = this.getTranslationQueueKey();
            TranslationService.cancelPending({ cancellableKey: queueKey });
            const translated = await TranslationService.translateBatch(textsToTranslate, 'en', {
                priority: FlatView.TRANSLATION_PRIORITY,
                cancellable: true,
                cancellableKey: queueKey,
            });
            for (const { el, textIdx } of elementMap) {
                const original = textsToTranslate[textIdx];
                const result = translated[textIdx];
                if (result && result !== original) {
                    el.textContent = `${original} (${result})`;
                }
            }
        } catch (e) {
            Logger.warn('[FlatView] Translation failed:', e);
        }
    }

    private getTranslationQueueKey(): string {
        return `flatview:${this.bridge.currentWorkId || 'unknown'}`;
    }

    private getItemIcon(item: FlatItem, token: string): string {
        switch (item.type) {
            case 'audio':
                return `<button class="q-btn q-btn-item non-selectable no-outline q-btn--round q-btn--actionable q-focusable q-hoverable q-btn--dense bg-primary text-white" type="button">
                    <span class="q-focus-helper"></span>
                    <span class="q-btn__wrapper col row q-anchor--skip">
                        <span class="q-btn__content text-center col items-center q-anchor--skip justify-center row">
                            <i aria-hidden="true" role="img" class="q-icon notranslate material-icons">play_arrow</i>
                        </span>
                    </span>
                </button>`;
            case 'image': {
                const streamUrl = item.mediaStreamUrl || `/api/media/stream/${item.hash}`;
                const thumbUrl = `${streamUrl}${streamUrl.includes('?') ? '&' : '?'}token=${token}`;
                return `<img src="${this.escapeHtml(thumbUrl)}" alt="${this.escapeHtml(item.title)}"
                    width="40" height="40" class="asmr-flat-thumb" loading="lazy"
                    onerror="this.outerHTML='<i aria-hidden=\\'true\\' class=\\'q-icon notranslate material-icons\\' style=\\'font-size:34px;color:#ff9800\\'>photo</i>'" />`;
            }
            case 'text':
                return `<i aria-hidden="true" role="img" class="q-icon notranslate material-icons" style="font-size: 34px; color: #2196f3;">description</i>`;
            case 'other':
                return `<i aria-hidden="true" role="img" class="q-icon notranslate material-icons" style="font-size: 34px; color: #2196f3;">description</i>`;
            default:
                return '';
        }
    }

    // =========================================================================
    // Click Handlers
    // =========================================================================

    private onClickItem(item: FlatItem, audioQueue: FlatItem[]): void {
        if (item.type === 'audio') {
            this.playAudio(item, audioQueue);
        } else if (item.type === 'image') {
            this.openImageInLightbox(item);
        } else if (item.type === 'text') {
            this.openFile(item);
        } else if (item.type === 'other') {
            this.downloadFile(item);
        }
    }

    private playAudio(item: FlatItem, audioQueue: FlatItem[]): void {
        const store = this.bridge.store;
        if (!store.commit) return;

        const currentHash = this.getCurrentPlayingHash();

        // If already playing this track, toggle play/pause
        if (currentHash === item.hash) {
            store.commit('AudioPlayer/TOGGLE_PLAYING');
            return;
        }

        // Build queue from ALL audio items in the flat list
        // Ensure each item has all fields the AudioPlayer expects
        const queue = audioQueue.map(i => ({
            ...i.raw,
            title: i.raw.title || i.title,
            hash: i.raw.hash || i.hash,
            subtitles: (i.raw as any).subtitles || [],
        }));
        const index = audioQueue.findIndex(i => i.hash === item.hash);

        store.commit('AudioPlayer/SET_QUEUE', {
            queue,
            index: Math.max(0, index),
        });
        store.commit('AudioPlayer/PLAY');

        Logger.debug(`[FlatView] Playing: ${item.title} (${index + 1}/${queue.length} in flat queue)`);
    }

    private openImageInLightbox(item: FlatItem): void {
        // Try to use MediaViewer for lightbox experience
        try {
            const { MediaViewerController } = require('./MediaViewerController');
            const viewer = MediaViewerController.getInstance();

            // Collect all image items
            const imageItems = this.currentItems.filter(i => i.type === 'image');
            const startIndex = imageItems.findIndex(i => i.hash === item.hash);

            const token = this.getToken();
            const encodedToken = token ? encodeURIComponent(token) : '';
            const urls = imageItems.map(i => {
                const url = i.mediaStreamUrl || `/api/media/stream/${i.hash}`;
                if (!encodedToken || url.includes('token=')) return url;
                const separator = url.includes('?') ? '&' : '?';
                return `${url}${separator}token=${encodedToken}`;
            });

            if (urls.length > 0) {
                viewer.showExternalImages(urls, Math.max(0, startIndex));
                return;
            }
        } catch {
            // MediaViewer not available, fall back
        }

        this.openFile(item);
    }

    private openFile(item: FlatItem): void {
        const token = this.getToken();
        const encodedToken = token ? encodeURIComponent(token) : '';
        const url = item.mediaStreamUrl
            ? item.mediaStreamUrl
            : `/api/media/stream/${item.hash}`;
        const finalUrl = encodedToken && !url.includes('token=')
            ? `${url}${url.includes('?') ? '&' : '?'}token=${encodedToken}`
            : url;
        const link = document.createElement('a');
        link.href = finalUrl;
        link.target = '_blank';
        link.click();
    }

    private downloadFile(item: FlatItem): void {
        const token = this.getToken();
        const encodedToken = token ? encodeURIComponent(token) : '';
        const url = item.mediaDownloadUrl
            ? item.mediaDownloadUrl
            : `/api/media/download/${item.hash}`;
        const finalUrl = encodedToken && !url.includes('token=')
            ? `${url}${url.includes('?') ? '&' : '?'}token=${encodedToken}`
            : url;
        const link = document.createElement('a');
        link.href = finalUrl;
        link.target = '_blank';
        link.click();
    }

    private getToken(): string {
        try {
            return localStorage.getItem('jwt-token') || '';
        } catch {
            return '';
        }
    }

    // =========================================================================
    // Active Track Highlighting
    // =========================================================================

    private getCurrentPlayingHash(): string | null {
        try {
            const state = this.bridge.store.state?.AudioPlayer;
            const file = state?.currentPlayingFile || state?.currentTrack;
            return file?.hash || null;
        } catch {
            return null;
        }
    }

    private watchActiveTrack(): void {
        if (this.unwatchTrack) this.unwatchTrack();

        this.unwatchTrack = this.bridge.store.watch?.(
            (state: any) => {
                const file = state.AudioPlayer?.currentPlayingFile || state.AudioPlayer?.currentTrack;
                return file?.hash || null;
            },
            (newHash: string | null) => {
                if (!this.bodyEl) return;
                this.updateActiveHighlight(newHash);
            }
        ) || null;
    }

    private updateActiveHighlight(activeHash: string | null): void {
        if (!this.bodyEl) return;

        this.bodyEl.querySelectorAll('[data-asmr-flat-hash]').forEach(el => {
            const hash = (el as HTMLElement).dataset.asmrFlatHash;
            const isActive = hash === activeHash;
            el.classList.toggle('asmr-flat-active', isActive);

            // Update play/pause icon for audio items
            if ((el as HTMLElement).dataset.asmrFlatType === 'audio') {
                const icon = el.querySelector('.q-btn--round .q-icon');
                if (icon) {
                    const playing = this.bridge.store.state?.AudioPlayer?.playing;
                    icon.textContent = isActive && playing ? 'pause' : 'play_arrow';
                }
            }
        });
    }

    // =========================================================================
    // Work Change Watcher
    // =========================================================================

    private watchWork(): void {
        const store = this.bridge.store;
        if (store?.watch) {
            this.unwatchWork = store.watch(
                (state: any) => state.AudioPlayer?.work?.id,
                () => {
                    // Clear stale items and prefetch cache
                    this.currentItems = [];
                    this.prefetchedData = null;
                    this.prefetchWorkId = null;
                    this.prefetchPromise = null;
                    if (this.isActive) {
                        this.renderFlatList();
                    }
                }
            ) || null;
        }
    }

    // =========================================================================
    // Utility
    // =========================================================================

    /** Measure player elements and position the panel to never overlap them.
     *  The flat panel always sits at the far right edge.
     *  When an expanded miniplayer is present, it gets pushed left by the panel width. */
    private syncBottomOffset(): void {
        const playerBar = document.querySelector('.q-footer, .player-bar-container') as HTMLElement | null;
        const expandedPlayer = document.querySelector('.audio-player.fixed-bottom-right') as HTMLElement | null;

        // Player bar at the bottom — always respect its height
        let bottomOffset = playerBar ? playerBar.offsetHeight : 0;

        // Stack above collapsed subs bar if visible
        const subsBar = document.querySelector('body > .learner-subs-collapsed') as HTMLElement | null;
        if (subsBar && subsBar.style.display !== 'none' && !subsBar.classList.contains('hidden') && subsBar.offsetHeight > 0) {
            bottomOffset += subsBar.offsetHeight;
        }

        // Stack above JOI bar if visible
        const joiBar = document.querySelector('body > .asmr-joi-bar-collapsed') as HTMLElement | null;
        if (joiBar && joiBar.style.display !== 'none' && !joiBar.classList.contains('hidden') && joiBar.offsetHeight > 0) {
            bottomOffset += joiBar.offsetHeight;
        }

        // Stack above visualizer bar if visible
        const vizBar = document.querySelector('body > .asmr-viz-bar') as HTMLElement | null;
        if (vizBar && !vizBar.classList.contains('hidden') && vizBar.offsetHeight > 0) {
            bottomOffset += vizBar.offsetHeight;
        }

        // Flat panel always stays at the right edge
        document.documentElement.style.setProperty('--asmr-flat-panel-right', '0px');
        document.documentElement.style.setProperty('--asmr-flat-panel-bottom', `${bottomOffset}px`);

        // Push the expanded miniplayer left by the flat panel width when both are open
        if (expandedPlayer && this.isActive && this.panelEl) {
            const panelWidth = this.panelEl.offsetWidth;
            expandedPlayer.style.right = `${panelWidth}px`;
        } else if (expandedPlayer) {
            expandedPlayer.style.right = '';
        }
    }

    /** Poll bottom offset while panel is open (player can expand/collapse at any time) */
    private startBottomOffsetWatch(): void {
        this.stopBottomOffsetWatch();
        this.bottomOffsetTimer = setInterval(() => this.syncBottomOffset(), 500);
    }

    private stopBottomOffsetWatch(): void {
        if (this.bottomOffsetTimer) {
            clearInterval(this.bottomOffsetTimer);
            this.bottomOffsetTimer = null;
        }
    }

    /** Apply Quasar dark-mode classes to the panel so item labels inherit the host theme */
    private syncDarkMode(): void {
        if (!this.panelEl) return;
        const dark = isDarkMode();
        this.panelEl.classList.toggle('q-dark', dark);
        this.panelEl.classList.toggle('body--dark', dark);
    }

    /** Measure the header/player bar height and position the panel below it */
    private syncHeaderOffset(): void {
        const header = document.querySelector('header.q-header') as HTMLElement | null;
        const top = header ? header.offsetHeight : 50;
        document.documentElement.style.setProperty('--asmr-flat-panel-top', `${top}px`);
    }

    private escapeHtml(str: string): string {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
}
