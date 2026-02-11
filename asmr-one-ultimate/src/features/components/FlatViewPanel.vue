<script setup lang="ts">
/**
 * FlatViewPanel.vue - Side drawer panel showing all files from a work in a flat list
 *
 * Coexists with the native WorkTree - does NOT replace it.
 * Opens as a right-side drawer panel with slide-in animation.
 * Supports playback, lightbox, copy, and all other integrations.
 *
 * This component renders:
 *   1. A toggle button (inline at the injection point)
 *   2. A drawer panel + backdrop (teleported to document.body)
 */

import { ref, computed, watch, onMounted, onUnmounted, nextTick, type Ref } from 'vue';
import { useBridge } from '../../composables/useBridge';
import { useI18n } from '../../composables/useI18n';
import { useEventBus } from '../../composables/useEventBus';
import { isDarkMode } from '../../core/DomUtils';
import { Priority } from '../../core/GpuScheduler';
import { WorkService } from '../../services/WorkService';
import { TranslationService } from '../../services/TranslationService';
import { Logger } from '../../core/Logger';
import { flattenTree, type FlatItem } from '../flatViewUtils';
import type { TracksResponse } from '../../types/api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Translation overlay: original text -> translated appendage */
interface TranslationMap {
    [key: string]: string;
}

// ---------------------------------------------------------------------------
// Props / Emits
// ---------------------------------------------------------------------------

const props = defineProps<{
    /** Called by the controller to supply prefetched tree data */
    prefetchedData?: TracksResponse | null;
    prefetchWorkId?: string | null;
}>();

// ---------------------------------------------------------------------------
// Composables
// ---------------------------------------------------------------------------

const bridge = useBridge();
const { t, format } = useI18n();
const { emit: busEmit } = useEventBus();

// ---------------------------------------------------------------------------
// Reactive State
// ---------------------------------------------------------------------------

const isActive = ref(false);
const items = ref<FlatItem[]>([]);
const activeHash = ref<string | null>(null);
const isPlaying = ref(false);
const dark = ref(isDarkMode());
const headerTop = ref(50);
const panelBottom = ref(0);
const translations = ref<TranslationMap>({});
const thumbErrors = ref(new Set<string>());
const loading = ref(false);

// Non-reactive handles
let unwatchTrack: (() => void) | null = null;
let unwatchWork: (() => void) | null = null;
let bottomOffsetTimer: ReturnType<typeof setInterval> | null = null;
let escapeHandler: ((e: KeyboardEvent) => void) | null = null;

// Prefetch state managed externally by the controller via exposed methods
let prefetchedTreeData: TracksResponse | null = null;
let prefetchTreeWorkId: string | null = null;
let prefetchPromise: Promise<void> | null = null;
const FLATVIEW_TRANSLATION_PRIORITY = Priority.NORMAL;

// ---------------------------------------------------------------------------
// Computed
// ---------------------------------------------------------------------------

const audioItems = computed(() => items.value.filter(i => i.type === 'audio'));
const itemCount = computed(() => items.value.length);
const fileCountText = computed(() => format('fileListCount', { count: itemCount.value }));
const token = computed(() => {
    try {
        return localStorage.getItem('jwt-token') || '';
    } catch {
        return '';
    }
});

const panelClasses = computed(() => ({
    'asmr-flat-panel': true,
    'asmr-flat-panel--open': isActive.value,
    'q-dark': dark.value,
    'body--dark': dark.value,
}));

const panelStyle = computed(() => ({
    top: `${headerTop.value}px`,
    bottom: `${panelBottom.value}px`,
}));

const backdropClasses = computed(() => ({
    'asmr-flat-backdrop': true,
    'asmr-flat-backdrop--visible': isActive.value,
}));

const backdropStyle = computed(() => ({
    top: `${headerTop.value}px`,
}));

const toggleBtnClasses = computed(() => [
    'q-btn', 'q-btn-item', 'non-selectable', 'no-outline',
    'q-mt-sm', 'shadow-4', 'q-mx-xs', 'q-px-sm',
    'q-btn--standard', 'q-btn--rectangle', 'text-white',
    'q-btn--actionable', 'q-focusable', 'q-hoverable',
    'q-btn--wrap', 'q-btn--dense', 'asmr-flat-toggle',
    { 'bg-grey-8': !isActive.value },
]);

const toggleBtnStyle = computed(() =>
    isActive.value
        ? { background: 'var(--asmr-accent) !important' }
        : {}
);

const cardClasses = computed(() => ({
    'q-card': true,
    'q-card--dark': dark.value,
    'q-dark': dark.value,
}));

const listClasses = computed(() => ({
    'q-list': true,
    'q-list--separator': true,
    'q-list--dark': dark.value,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDisplayTitle(item: FlatItem): string {
    const tr = translations.value[item.title];
    return tr ? `${item.title} (${tr})` : item.title;
}

function getDisplayFolder(item: FlatItem): string {
    if (!item.folderPath) return '';
    const tr = translations.value[item.folderPath];
    return tr ? `${item.folderPath} (${tr})` : item.folderPath;
}

function isItemActive(item: FlatItem): boolean {
    return item.type === 'audio' && item.hash === activeHash.value;
}

function itemClasses(item: FlatItem): Record<string, boolean> {
    return {
        'q-item': true,
        'q-item-type': true,
        'row': true,
        'no-wrap': true,
        'q-item--clickable': true,
        'q-link': true,
        'cursor-pointer': true,
        'q-focusable': true,
        'q-hoverable': true,
        'non-selectable': true,
        'q-item--dark': dark.value,
        'asmr-flat-active': isItemActive(item),
    };
}

function getItemIcon(item: FlatItem): string {
    if (item.type === 'audio') {
        const active = isItemActive(item);
        return active && isPlaying.value ? 'pause' : 'play_arrow';
    }
    if (item.type === 'text' || item.type === 'other') return 'description';
    return 'photo'; // image fallback icon (used when thumb errors)
}

function getThumbUrl(item: FlatItem): string {
    const streamUrl = item.mediaStreamUrl || `/api/media/stream/${item.hash}`;
    const sep = streamUrl.includes('?') ? '&' : '?';
    return `${streamUrl}${sep}token=${token.value}`;
}

function onThumbError(item: FlatItem): void {
    thumbErrors.value = new Set([...thumbErrors.value, item.hash]);
}

function shouldShowThumb(item: FlatItem): boolean {
    return item.type === 'image' && !thumbErrors.value.has(item.hash);
}

// ---------------------------------------------------------------------------
// Data Source
// ---------------------------------------------------------------------------

function getTreeData(): TracksResponse | null {
    const treeVm = bridge.findWorkTreeComponent() as any;
    if (treeVm?.tree && Array.isArray(treeVm.tree) && treeVm.tree.length > 0) {
        return treeVm.tree as TracksResponse;
    }
    return null;
}

async function getTreeDataWithRetry(maxAttempts = 8): Promise<TracksResponse | null> {
    for (let i = 0; i < maxAttempts; i++) {
        const data = getTreeData();
        if (data) return data;
        await new Promise(r => setTimeout(r, 400));
    }

    // Fallback: fetch via API
    try {
        const workId = bridge.currentWorkId;
        if (workId) {
            Logger.debug('[FlatView] Fetching tree data via API fallback');
            return await WorkService.getTracks(workId);
        }
    } catch (e) {
        Logger.warn('[FlatView] API fallback failed:', e);
    }

    return null;
}

// ---------------------------------------------------------------------------
// Render Flat List
// ---------------------------------------------------------------------------

async function renderFlatList(): Promise<void> {
    loading.value = true;

    // Use prefetched data if available for the current work
    const currentWorkId = bridge.currentWorkId;
    let treeData: TracksResponse | null = null;

    if (prefetchedTreeData && prefetchTreeWorkId === currentWorkId) {
        treeData = prefetchedTreeData;
        Logger.debug('[FlatView] Using prefetched tree data');
    } else if (prefetchPromise && prefetchTreeWorkId === currentWorkId) {
        await prefetchPromise;
        if (prefetchedTreeData && prefetchTreeWorkId === currentWorkId) {
            treeData = prefetchedTreeData;
            Logger.debug('[FlatView] Using prefetched tree data (waited)');
        }
    }
    if (!treeData) {
        treeData = await getTreeDataWithRetry();
    }
    if (!treeData || treeData.length === 0) {
        Logger.warn('[FlatView] No tree data available');
        loading.value = false;
        return;
    }

    const flatItems = flattenTree(treeData);
    if (flatItems.length === 0) {
        Logger.warn('[FlatView] No items after flattening');
        loading.value = false;
        return;
    }

    items.value = flatItems;
    Logger.debug(`[FlatView] Flattened ${flatItems.length} items from tree`);

    loading.value = false;

    // Update active track highlight
    syncActiveHash();

    // Start watching for active track changes
    watchActiveTrack();

    // Auto-translate titles and folder paths
    await translateVisibleItems();
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

async function translateVisibleItems(): Promise<void> {
    const textsToTranslate: string[] = [];

    for (const item of items.value) {
        const title = item.title?.trim();
        if (title && !textsToTranslate.includes(title)) {
            textsToTranslate.push(title);
        }
        const folder = item.folderPath?.trim();
        if (folder && !textsToTranslate.includes(folder)) {
            textsToTranslate.push(folder);
        }
    }

    if (textsToTranslate.length === 0) return;

    try {
        const queueKey = `flatview:${bridge.currentWorkId || 'unknown'}`;
        TranslationService.cancelPending({ cancellableKey: queueKey });
        const translated = await TranslationService.translateBatch(textsToTranslate, 'en', {
            priority: FLATVIEW_TRANSLATION_PRIORITY,
            cancellable: true,
            cancellableKey: queueKey,
        });
        const newTranslations: TranslationMap = {};
        for (let i = 0; i < textsToTranslate.length; i++) {
            const original = textsToTranslate[i];
            const result = translated[i];
            if (result && result !== original) {
                newTranslations[original] = result;
            }
        }
        translations.value = { ...translations.value, ...newTranslations };
    } catch (e) {
        Logger.warn('[FlatView] Translation failed:', e);
    }
}

// ---------------------------------------------------------------------------
// Click Handlers
// ---------------------------------------------------------------------------

function onClickItem(item: FlatItem): void {
    if (item.type === 'audio') {
        playAudio(item);
    } else if (item.type === 'image') {
        openImageInLightbox(item);
    } else if (item.type === 'text') {
        openFile(item);
    } else if (item.type === 'other') {
        downloadFile(item);
    }
}

function playAudio(item: FlatItem): void {
    const store = bridge.store;
    if (!store.commit) return;

    const currentHash = activeHash.value;

    // If already playing this track, toggle play/pause
    if (currentHash === item.hash) {
        store.commit('AudioPlayer/TOGGLE_PLAYING');
        return;
    }

    // Build queue from ALL audio items in the flat list
    const queue = audioItems.value.map(i => ({
        ...i.raw,
        title: i.raw.title || i.title,
        hash: i.raw.hash || i.hash,
        subtitles: (i.raw as any).subtitles || [],
    }));
    const index = audioItems.value.findIndex(i => i.hash === item.hash);

    store.commit('AudioPlayer/SET_QUEUE', {
        queue,
        index: Math.max(0, index),
    });
    store.commit('AudioPlayer/PLAY');

    Logger.debug(`[FlatView] Playing: ${item.title} (${index + 1}/${queue.length} in flat queue)`);
}

function openImageInLightbox(item: FlatItem): void {
    try {
        const { MediaViewerController } = require('../MediaViewerController');
        const viewer = MediaViewerController.getInstance();

        const imageItems = items.value.filter(i => i.type === 'image');
        const startIndex = imageItems.findIndex(i => i.hash === item.hash);

        const encodedToken = token.value ? encodeURIComponent(token.value) : '';
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

    openFile(item);
}

function openFile(item: FlatItem): void {
    const encodedToken = token.value ? encodeURIComponent(token.value) : '';
    const url = item.mediaStreamUrl || `/api/media/stream/${item.hash}`;
    const finalUrl = encodedToken && !url.includes('token=')
        ? `${url}${url.includes('?') ? '&' : '?'}token=${encodedToken}`
        : url;
    const link = document.createElement('a');
    link.href = finalUrl;
    link.target = '_blank';
    link.click();
}

function downloadFile(item: FlatItem): void {
    const encodedToken = token.value ? encodeURIComponent(token.value) : '';
    const url = item.mediaDownloadUrl || `/api/media/download/${item.hash}`;
    const finalUrl = encodedToken && !url.includes('token=')
        ? `${url}${url.includes('?') ? '&' : '?'}token=${encodedToken}`
        : url;
    const link = document.createElement('a');
    link.href = finalUrl;
    link.target = '_blank';
    link.click();
}

// ---------------------------------------------------------------------------
// Active Track Highlighting
// ---------------------------------------------------------------------------

function syncActiveHash(): void {
    try {
        const state = bridge.store.state?.AudioPlayer;
        const file = state?.currentPlayingFile || state?.currentTrack;
        activeHash.value = file?.hash || null;
        isPlaying.value = !!state?.playing;
    } catch {
        activeHash.value = null;
        isPlaying.value = false;
    }
}

function watchActiveTrack(): void {
    if (unwatchTrack) unwatchTrack();

    unwatchTrack = bridge.store.watch?.(
        (state: any) => {
            const file = state.AudioPlayer?.currentPlayingFile || state.AudioPlayer?.currentTrack;
            return (file?.hash || null) + ':' + (state.AudioPlayer?.playing ? '1' : '0');
        },
        (combined: string) => {
            const [hash, playState] = combined.split(':');
            activeHash.value = hash || null;
            isPlaying.value = playState === '1';
        }
    ) || null;
}

// ---------------------------------------------------------------------------
// Show / Hide
// ---------------------------------------------------------------------------

function show(): void {
    isActive.value = true;
    dark.value = isDarkMode();
    syncHeaderOffset();
    syncBottomOffset();
    startBottomOffsetWatch();
    renderFlatList();
    document.body.classList.add('asmr-flat-open');
    busEmit('flatview:toggle', { active: true });
}

function hide(): void {
    isActive.value = false;
    document.body.classList.remove('asmr-flat-open');
    stopBottomOffsetWatch();

    // Restore miniplayer position
    const expandedPlayer = document.querySelector('.audio-player.fixed-bottom-right') as HTMLElement | null;
    if (expandedPlayer) expandedPlayer.style.right = '';

    if (unwatchTrack) {
        unwatchTrack();
        unwatchTrack = null;
    }
    busEmit('flatview:toggle', { active: false });
}

function toggle(): void {
    if (isActive.value) {
        hide();
    } else {
        show();
    }
}

// ---------------------------------------------------------------------------
// Layout Sync
// ---------------------------------------------------------------------------

function syncHeaderOffset(): void {
    const header = document.querySelector('header.q-header') as HTMLElement | null;
    headerTop.value = header ? header.offsetHeight : 50;
}

function syncBottomOffset(): void {
    const playerBar = document.querySelector('.player-bar') as HTMLElement | null;
    const barHeight = playerBar ? playerBar.offsetHeight : 0;
    panelBottom.value = barHeight;

    // Push expanded miniplayer left by the flat panel width when both are open
    const expandedPlayer = document.querySelector('.audio-player.fixed-bottom-right') as HTMLElement | null;
    if (expandedPlayer && isActive.value) {
        const panelEl = document.querySelector('.asmr-flat-panel') as HTMLElement | null;
        if (panelEl) {
            expandedPlayer.style.right = `${panelEl.offsetWidth}px`;
        }
    } else if (expandedPlayer) {
        expandedPlayer.style.right = '';
    }
}

function startBottomOffsetWatch(): void {
    stopBottomOffsetWatch();
    bottomOffsetTimer = setInterval(() => syncBottomOffset(), 500);
}

function stopBottomOffsetWatch(): void {
    if (bottomOffsetTimer) {
        clearInterval(bottomOffsetTimer);
        bottomOffsetTimer = null;
    }
}

// ---------------------------------------------------------------------------
// Work Change Watcher
// ---------------------------------------------------------------------------

function watchWork(): void {
    const store = bridge.store;
    if (store?.watch) {
        unwatchWork = store.watch(
            (state: any) => state.AudioPlayer?.work?.id,
            () => {
                // Clear stale items and prefetch cache
                items.value = [];
                translations.value = {};
                thumbErrors.value = new Set();
                prefetchedTreeData = null;
                prefetchTreeWorkId = null;
                prefetchPromise = null;
                if (isActive.value) {
                    renderFlatList();
                }
            }
        ) || null;
    }
}

// ---------------------------------------------------------------------------
// Prefetch (called by controller)
// ---------------------------------------------------------------------------

function prefetch(workId: string): void {
    if (prefetchTreeWorkId === workId && prefetchPromise) return;
    prefetchTreeWorkId = workId;
    prefetchedTreeData = null;
    prefetchPromise = getTreeDataWithRetry().then(data => {
        if (prefetchTreeWorkId === workId && data) {
            prefetchedTreeData = data;
            Logger.debug(`[FlatView] Prefetched ${data.length} tree nodes for ${workId}`);
        }
    }).catch(() => {
        // Prefetch is best-effort
    });
}

// ---------------------------------------------------------------------------
// Escape Key Handler
// ---------------------------------------------------------------------------

function onEscape(e: KeyboardEvent): void {
    if (e.key === 'Escape' && isActive.value) {
        hide();
    }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

onMounted(() => {
    escapeHandler = onEscape;
    document.addEventListener('keydown', escapeHandler);
    watchWork();
});

onUnmounted(() => {
    TranslationService.cancelPending({ cancellableKey: `flatview:${bridge.currentWorkId || 'unknown'}` });
    if (isActive.value) hide();
    if (unwatchWork) {
        unwatchWork();
        unwatchWork = null;
    }
    if (escapeHandler) {
        document.removeEventListener('keydown', escapeHandler);
        escapeHandler = null;
    }
    stopBottomOffsetWatch();
});

// ---------------------------------------------------------------------------
// Expose public API for controller
// ---------------------------------------------------------------------------

defineExpose({
    show,
    hide,
    toggle,
    prefetch,
    getItems: () => items.value,
    get active() { return isActive.value; },
});
</script>

<template>
    <!-- Toggle Button (rendered at the injection point) -->
    <button :class="toggleBtnClasses"
            :style="toggleBtnStyle"
            type="button"
            @click="toggle">
        <span class="q-focus-helper"></span>
        <span class="q-btn__wrapper col row q-anchor--skip">
            <span class="q-btn__content text-center col items-center q-anchor--skip justify-center row">
                <i aria-hidden="true" role="img"
                   class="q-icon on-left notranslate material-icons">view_list</i>
                <span class="block">{{ t('flatView') }}</span>
            </span>
        </span>
    </button>

    <!-- Drawer Panel + Backdrop (teleported to body) -->
    <Teleport to="body">
        <!-- Backdrop (click to close) -->
        <div :class="backdropClasses"
             :style="backdropStyle"
             @click="hide" />

        <!-- Panel -->
        <div :class="panelClasses"
             :style="panelStyle"
             role="complementary"
             :aria-label="t('fileListHeader')">

            <!-- Header -->
            <div class="asmr-flat-panel__header">
                <div class="asmr-flat-panel__title">
                    <i aria-hidden="true" class="q-icon material-icons">view_list</i>
                    <span>{{ t('fileListHeader') }}</span>
                    <span v-if="itemCount > 0" class="asmr-flat-panel__count">
                        {{ fileCountText }}
                    </span>
                </div>
                <button class="asmr-flat-panel__close"
                        :aria-label="t('fileListClose')"
                        @click="hide">
                    <i class="q-icon material-icons">close</i>
                </button>
            </div>

            <!-- Body (scrollable file list) -->
            <div class="asmr-flat-panel__body">
                <div v-if="items.length > 0" :class="cardClasses">
                    <div :class="listClasses" role="list">
                        <div v-for="(item, idx) in items"
                             :key="item.hash"
                             :class="itemClasses(item)"
                             role="listitem"
                             tabindex="0"
                             :data-asmr-flat-idx="idx"
                             :data-asmr-flat-hash="item.hash"
                             :data-asmr-flat-type="item.type"
                             @click="onClickItem(item)">

                            <!-- Avatar / Icon section -->
                            <div class="q-item__section column q-item__section--avatar q-item__section--side justify-center">
                                <!-- Audio: play/pause button -->
                                <template v-if="item.type === 'audio'">
                                    <button class="q-btn q-btn-item non-selectable no-outline q-btn--round q-btn--actionable q-focusable q-hoverable q-btn--dense bg-primary text-white"
                                            type="button"
                                            @click.stop="onClickItem(item)">
                                        <span class="q-focus-helper"></span>
                                        <span class="q-btn__wrapper col row q-anchor--skip">
                                            <span class="q-btn__content text-center col items-center q-anchor--skip justify-center row">
                                                <i aria-hidden="true" role="img"
                                                   class="q-icon notranslate material-icons">{{ getItemIcon(item) }}</i>
                                            </span>
                                        </span>
                                    </button>
                                </template>

                                <!-- Image: thumbnail or fallback icon -->
                                <template v-else-if="item.type === 'image'">
                                    <img v-if="shouldShowThumb(item)"
                                         :src="getThumbUrl(item)"
                                         :alt="item.title"
                                         width="40" height="40"
                                         class="asmr-flat-thumb"
                                         loading="lazy"
                                         @error="onThumbError(item)" />
                                    <i v-else
                                       aria-hidden="true"
                                       class="q-icon notranslate material-icons"
                                       style="font-size: 34px; color: #ff9800">photo</i>
                                </template>

                                <!-- Text / Other: file icon -->
                                <template v-else>
                                    <i aria-hidden="true" role="img"
                                       class="q-icon notranslate material-icons"
                                       style="font-size: 34px; color: #2196f3">description</i>
                                </template>
                            </div>

                            <!-- Main content section -->
                            <div class="q-item__section column q-item__section--main justify-center">
                                <div class="q-item__label" style="overflow-wrap: break-word;">
                                    {{ getDisplayTitle(item) }}
                                </div>
                                <div v-if="item.folderPath"
                                     class="q-item__label q-item__label--caption text-caption ellipsis">
                                    {{ getDisplayFolder(item) }}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </Teleport>
</template>

<style scoped>
/* Toggle button active state override - needs scoped specificity */
.asmr-flat-toggle {
    transition: background 0.2s ease;
}
</style>
