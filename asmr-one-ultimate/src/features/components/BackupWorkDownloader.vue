<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from '../../composables/useI18n';
import type {
    BackupDownloadProfile,
    BackupDownloadProgress,
    BackupDownloadState,
    BackupFileFilter,
    BackupPlaylistDownloadItem,
    BackupPlaylistSourceFilter,
    BackupWorkDownloadItem,
} from '../backupWorkDownloaderTypes';
import {
    MAX_DOWNLOAD_CONCURRENCY,
    normalizeDownloadConcurrency,
} from '../backupWorkDownloaderTypes';

interface ResumableJobItem {
    id: string;
    title: string;
    convertToOpus?: boolean;
    needsTitleTranslation?: boolean;
}

const props = withDefaults(defineProps<{
    playlists: BackupPlaylistDownloadItem[];
    works: BackupWorkDownloadItem[];
    profile: BackupDownloadProfile;
    showOwn?: boolean;
    loadingOwn?: boolean;
    loadingPublic?: boolean;
    ownLoadFailed?: boolean;
    publicLoadFailed?: boolean;
    busy?: boolean;
    progress?: BackupDownloadProgress | null;
    errorMessage?: string;
    resumableJobs?: ResumableJobItem[];
    resolvePlaylist?: (playlist: BackupPlaylistDownloadItem) => Promise<void>;
    searchAllWorks?: (query: string) => Promise<void>;
    loadMoreWorks?: () => Promise<void>;
    /** Demand-driven metadata fetch; `detailed` also reads the file manifest. */
    enrichWorks?: (ids: Array<string | number>, detailed?: boolean) => void;
    searchTotal?: number;
    /** How far `searchTotal` can be trusted; 'unknown' hides it entirely. */
    searchTotalKind?: 'unknown' | 'exact' | 'approximate';
    searchHasMore?: boolean;
    stagedDestination?: boolean;
}>(), {
    showOwn: true,
    loadingOwn: false,
    loadingPublic: false,
    ownLoadFailed: false,
    publicLoadFailed: false,
    busy: false,
    progress: null,
    errorMessage: '',
    resumableJobs: () => [],
    resolvePlaylist: undefined,
    searchAllWorks: undefined,
    loadMoreWorks: undefined,
    enrichWorks: undefined,
    searchTotal: 0,
    searchTotalKind: 'unknown',
    searchHasMore: false,
    stagedDestination: false,
});

const { t, format } = useI18n();
const workUrl = (work: BackupWorkDownloadItem): string => `/work/${encodeURIComponent(String(work.id))}`;

const emit = defineEmits<{
    close: [];
    start: [state: BackupDownloadState];
    update: [state: BackupDownloadState];
    sourceChange: [source: BackupPlaylistSourceFilter];
    pause: [];
    resume: [jobId: string];
    resumeWithoutOpus: [jobId: string];
    resumeWithOriginalTitles: [jobId: string];
}>();

const searchQuery = ref('');
const sourceFilter = ref<BackupPlaylistSourceFilter>('site');
const tagFilter = ref('');
const dialog = ref<HTMLElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);
const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
const selectedIds = ref(new Set((props.profile.selectedWorkIds ?? []).map(String)));
const expandedIds = ref(new Set<string>());
const resolvingIds = ref(new Set<string>());
const searchingAll = ref(false);
const searchError = ref(false);
const completedSearchQuery = ref('');
const filters = ref({ ...props.profile.filters });
const downloadConcurrency = ref(normalizeDownloadConcurrency(props.profile.downloadConcurrency));
const titleMode = ref(props.profile.titleMode);
const convertToOpus = ref(props.profile.convertToOpus);
const opusBitrate = ref(props.profile.opusBitrate);
const metadataMode = ref(props.profile.metadataMode);
const includeArtwork = ref(props.profile.includeArtwork);
const darkTheme = ref(false);
const loadingMore = ref(false);
const loadMoreError = ref(false);
let themeObserver: MutationObserver | undefined;

/**
 * Rows fetch their own metadata only once they are actually on screen. Without
 * this, opening a large result set fired two API calls per row immediately.
 */
const VISIBLE_ENRICH_FALLBACK_ROWS = 12;
let visibilityObserver: IntersectionObserver | undefined;
let pendingVisibleIds = new Set<string>();
let visibleFlush: ReturnType<typeof setTimeout> | undefined;

function flushVisibleIds(): void {
    visibleFlush = undefined;
    if (!pendingVisibleIds.size) return;
    const ids = [...pendingVisibleIds];
    pendingVisibleIds = new Set();
    props.enrichWorks?.(ids, false);
}

function queueVisibleId(id: string): void {
    if (!props.enrichWorks || !id) return;
    pendingVisibleIds.add(id);
    if (visibleFlush) return;
    visibleFlush = setTimeout(flushVisibleIds, 80);
}

// Created during setup: directive `mounted` hooks run before the component's
// own onMounted, so the observer has to exist before the first row appears.
if (typeof IntersectionObserver === 'function') {
    visibilityObserver = new IntersectionObserver(entries => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            queueVisibleId((entry.target as HTMLElement).dataset.enrichWorkId ?? '');
        }
    }, { rootMargin: '200px' });
}

let fallbackEnrichCount = 0;

const vWorkVisible = {
    mounted(element: HTMLElement, binding: { value: string | number }): void {
        element.dataset.enrichWorkId = String(binding.value);
        if (visibilityObserver) visibilityObserver.observe(element);
        // Without IntersectionObserver there is no viewport signal, so enrich a
        // small bounded prefix rather than every row.
        else if (fallbackEnrichCount < VISIBLE_ENRICH_FALLBACK_ROWS) {
            fallbackEnrichCount += 1;
            queueVisibleId(String(binding.value));
        }
    },
    updated(element: HTMLElement, binding: { value: string | number }): void {
        element.dataset.enrichWorkId = String(binding.value);
    },
    unmounted(element: HTMLElement): void {
        visibilityObserver?.unobserve(element);
    },
};

const workById = computed(() => new Map(props.works.map(work => [String(work.id), work])));

function playlistWorks(playlist: BackupPlaylistDownloadItem): BackupWorkDownloadItem[] {
    const playlistId = String(playlist.id);
    if (playlist.workIds) {
        return playlist.workIds
            .map(id => workById.value.get(String(id)))
            .filter((work): work is BackupWorkDownloadItem => Boolean(work));
    }
    return props.works.filter(work => work.playlistIds?.some(id => String(id) === playlistId));
}

function normalized(value: string | undefined): string {
    return (value ?? '').normalize('NFKC').toLocaleLowerCase();
}

function matchesSearch(work: BackupWorkDownloadItem): boolean {
    const query = normalized(searchQuery.value.trim());
    return !query
        || normalized(String(work.id)).includes(query)
        || normalized(work.title).includes(query)
        || normalized(work.translatedTitle).includes(query);
}

function visiblePlaylistWorks(playlist: BackupPlaylistDownloadItem): BackupWorkDownloadItem[] {
    const query = normalized(searchQuery.value.trim());
    const playlistMatches = !!query && (
        normalized(playlist.title).includes(query) || normalized(playlist.translatedTitle).includes(query)
    );
    return playlistMatches ? playlistWorks(playlist) : playlistWorks(playlist).filter(matchesSearch);
}

const activePlaylists = computed(() => sourceFilter.value === 'site'
    ? []
    : props.playlists.filter(playlist => playlist.source === sourceFilter.value));
const availableTags = computed(() => {
    const tags = new Map<string, string>();
    if (sourceFilter.value === 'site') {
        for (const work of props.works.filter(work => work.directSearchResult)) {
            for (const tag of work.tags ?? []) {
                const key = normalized(tag);
                if (key && !tags.has(key)) tags.set(key, tag);
            }
        }
    }
    for (const playlist of activePlaylists.value) {
        for (const tag of playlist.tags ?? []) {
            const key = normalized(tag);
            if (key && !tags.has(key)) tags.set(key, tag);
        }
    }
    return [...tags.values()].sort((a, b) => a.localeCompare(b));
});

const visiblePlaylists = computed(() => {
    const query = normalized(searchQuery.value.trim());
    const tag = normalized(tagFilter.value);
    return activePlaylists.value.filter(playlist => {
        if (tag && !(playlist.tags ?? []).some(value => normalized(value) === tag)) return false;
        return !query
            || normalized(playlist.title).includes(query)
            || normalized(playlist.translatedTitle).includes(query)
            || normalized(playlist.owner).includes(query)
            || (playlist.tags ?? []).some(value => normalized(value).includes(query))
            || visiblePlaylistWorks(playlist).length > 0;
    });
});

const sourceCounts = computed(() => ({
    site: props.works.filter(work => work.directSearchResult).length,
    own: props.playlists.filter(playlist => playlist.source === 'own').length,
    public: props.playlists.filter(playlist => playlist.source === 'public').length,
}));
const selectedWorks = computed(() => props.works.filter(work => selectedIds.value.has(String(work.id))));
const standaloneWorks = computed(() => {
    if (sourceFilter.value !== 'site' || !completedSearchQuery.value) return [];
    const tag = normalized(tagFilter.value);
    const results = props.works.filter(work => work.directSearchResult
        && (!tag || (work.tags ?? []).some(value => normalized(value) === tag)));
    const query = normalized(searchQuery.value.trim());
    if (!query || query === completedSearchQuery.value) return results;
    // Refining the box filters the last completed result set rather than
    // hiding it. Hosted semantic hits rarely contain the literal query, so an
    // empty text match keeps the results visible instead of looking broken.
    const filtered = results.filter(matchesSearch);
    return filtered.length ? filtered : results;
});
const searchResultSummary = computed(() => {
    const shown = standaloneWorks.value.length;
    if (!shown) return '';
    const total = Math.max(props.searchTotal, shown);
    // A bare "Showing 200" is only honest when no source could report how many
    // matches exist; every other case says how much is still out there.
    if (props.searchTotalKind === 'unknown') {
        return format('downloadCenterResultCountUnknown', { shown: shown.toLocaleString() });
    }
    const key = props.searchTotalKind === 'approximate'
        ? 'downloadCenterResultCountApprox'
        : 'downloadCenterResultCount';
    return format(key, { shown: shown.toLocaleString(), total: total.toLocaleString() });
});
const selectedMeasuredBytes = computed(() => selectedWorks.value.reduce((sum, work) => sum + Math.max(0, displayedSizeBytes(work) ?? 0), 0));
const hasUnknownSelectedBytes = computed(() => selectedWorks.value.some(work => sizeCompleteness(work) === 'unavailable' || sizeCompleteness(work) === 'loading'));
const hasPartialSelectedBytes = computed(() => selectedWorks.value.some(work => sizeCompleteness(work) === 'partial'));
const hasEstimatedSelectedBytes = computed(() => convertToOpus.value && filters.value.audio && selectedWorks.value.some(work => estimatedOpusBytes(work) != null));
const selectedSizeLabel = computed(() => {
    const formatted = formatBytes(selectedMeasuredBytes.value);
    if (hasPartialSelectedBytes.value) return props.profile.labels.partialSize.replace('{size}', formatted);
    return hasEstimatedSelectedBytes.value
        ? props.profile.labels.estimatedOpusSize.replace('{size}', formatted)
        : formatted;
});
const isLoadingCurrentSource = computed(() => sourceFilter.value === 'site'
    ? searchingAll.value
    : sourceFilter.value === 'own' ? props.loadingOwn : props.loadingPublic);
const currentSourceLoadFailed = computed(() => sourceFilter.value === 'site'
    ? false
    : sourceFilter.value === 'own' ? props.ownLoadFailed : props.publicLoadFailed);
const canPause = computed(() => props.busy && !!props.progress && [
    'recovering', 'discovering', 'translating', 'downloading', 'converting',
].includes(props.progress.phase));
const progressPercent = computed(() => {
    if (!props.progress || props.progress.total <= 0) return 0;
    const partial = props.progress.phase === 'converting' ? (props.progress.conversionRatio ?? 0) : 0;
    return Math.min(100, Math.max(0, ((props.progress.current + partial) / props.progress.total) * 100));
});

function displayTitle(item: { title: string; translatedTitle?: string }): string {
    return item.translatedTitle && item.translatedTitle !== item.title
        ? `${item.title} [${item.translatedTitle}]`
        : item.title;
}

function playlistKey(playlist: BackupPlaylistDownloadItem): string {
    return `${playlist.source}:${String(playlist.id)}`;
}

function playlistElementId(playlist: BackupPlaylistDownloadItem): string {
    return `backup-playlist-${playlist.source}-${String(playlist.id)}`;
}

function isExpanded(playlist: BackupPlaylistDownloadItem): boolean {
    return expandedIds.value.has(playlistKey(playlist));
}

function isRenderedExpanded(playlist: BackupPlaylistDownloadItem): boolean {
    return isExpanded(playlist) || (!!searchQuery.value.trim() && visiblePlaylistWorks(playlist).length > 0);
}

async function ensureResolved(playlist: BackupPlaylistDownloadItem): Promise<void> {
    if ((playlist.workIds && !playlist.error) || !props.resolvePlaylist) return;
    const key = playlistKey(playlist);
    if (resolvingIds.value.has(key)) return;
    resolvingIds.value = new Set(resolvingIds.value).add(key);
    try {
        await props.resolvePlaylist(playlist);
        await nextTick();
    } finally {
        const next = new Set(resolvingIds.value);
        next.delete(key);
        resolvingIds.value = next;
    }
}

async function toggleExpanded(playlist: BackupPlaylistDownloadItem): Promise<void> {
    const key = playlistKey(playlist);
    if (!expandedIds.value.has(key)) await ensureResolved(playlist);
    const next = new Set(expandedIds.value);
    next.has(key) ? next.delete(key) : next.add(key);
    expandedIds.value = next;
}

function selectedInPlaylist(playlist: BackupPlaylistDownloadItem): number {
    return playlistWorks(playlist).filter(work => selectedIds.value.has(String(work.id))).length;
}

function playlistChecked(playlist: BackupPlaylistDownloadItem): boolean {
    const works = playlistWorks(playlist);
    return works.length > 0 && selectedInPlaylist(playlist) === works.length;
}

function playlistIndeterminate(playlist: BackupPlaylistDownloadItem): boolean {
    const count = selectedInPlaylist(playlist);
    return count > 0 && count < playlistWorks(playlist).length;
}

function toggleWork(work: BackupWorkDownloadItem): void {
    const next = new Set(selectedIds.value);
    const id = String(work.id);
    if (next.has(id)) next.delete(id);
    else {
        next.add(id);
        // Selecting one row is an explicit request for its real size, so this
        // is the only place a full file manifest is read from the list view.
        props.enrichWorks?.([id], true);
    }
    selectedIds.value = next;
    emitUpdate();
}

async function togglePlaylist(playlist: BackupPlaylistDownloadItem): Promise<void> {
    const wasChecked = playlistChecked(playlist);
    await ensureResolved(playlist);
    const next = new Set(selectedIds.value);
    for (const work of playlistWorks(playlist)) {
        wasChecked ? next.delete(String(work.id)) : next.add(String(work.id));
    }
    selectedIds.value = next;
    emitUpdate();
}

async function selectAllVisible(): Promise<void> {
    const queue = [...visiblePlaylists.value];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
        for (;;) {
            const playlist = queue[cursor++];
            if (!playlist) return;
            await ensureResolved(playlist);
        }
    });
    await Promise.all(workers);
    const next = new Set(selectedIds.value);
    for (const playlist of visiblePlaylists.value) {
        for (const work of playlistWorks(playlist)) next.add(String(work.id));
    }
    for (const work of standaloneWorks.value) next.add(String(work.id));
    selectedIds.value = next;
    emitUpdate();
}

async function runAllWorksSearch(): Promise<void> {
    const query = searchQuery.value.trim();
    if (!query || !props.searchAllWorks || searchingAll.value) return;
    searchingAll.value = true;
    searchError.value = false;
    loadMoreError.value = false;
    fallbackEnrichCount = 0;
    try {
        await props.searchAllWorks(query);
        completedSearchQuery.value = normalized(query);
    } catch {
        completedSearchQuery.value = '';
        searchError.value = true;
    }
    finally { searchingAll.value = false; }
}

async function loadMoreResults(): Promise<void> {
    if (!props.loadMoreWorks || loadingMore.value || !props.searchHasMore) return;
    loadingMore.value = true;
    loadMoreError.value = false;
    try { await props.loadMoreWorks(); }
    catch { loadMoreError.value = true; }
    finally { loadingMore.value = false; }
}

function clearAll(): void {
    selectedIds.value = new Set();
    emitUpdate();
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = -1;
    do { value /= 1024; unit += 1; } while (value >= 1024 && unit < units.length - 1);
    return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[unit]}`;
}

function formatDuration(seconds: number | undefined): string {
    if (!Number.isFinite(seconds) || Number(seconds) <= 0) return '';
    const wholeSeconds = Math.max(0, Math.round(Number(seconds)));
    const hours = Math.floor(wholeSeconds / 3_600);
    const minutes = Math.floor((wholeSeconds % 3_600) / 60);
    const remainder = wholeSeconds % 60;
    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
        : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function selectedFileCount(work: BackupWorkDownloadItem): number {
    if (!work.fileCountByType) return 0;
    return (Object.keys(filters.value) as BackupFileFilter[]).reduce((sum, category) => (
        sum + (filters.value[category] ? work.fileCountByType?.[category] ?? 0 : 0)
    ), 0);
}

function estimatedOpusBytes(work: BackupWorkDownloadItem): number | undefined {
    if (!convertToOpus.value || !work.durationSeconds || work.durationSeconds <= 0) return undefined;
    // Opus bitrate is kilobits/second. Include a small container/metadata allowance.
    return Math.ceil(work.durationSeconds * opusBitrate.value * 125 * 1.02);
}

function displayedSizeBytes(work: BackupWorkDownloadItem): number | undefined {
    if (convertToOpus.value) {
        let total = filters.value.audio ? estimatedOpusBytes(work) : 0;
        if (total == null) return undefined;
        for (const category of ['video', 'image', 'text', 'other'] as const) {
            if (filters.value[category]) total += work.sizeBytesByType?.[category] ?? 0;
        }
        return total;
    }
    if (work.sizeBytesByType) {
        return (Object.keys(filters.value) as Array<keyof typeof filters.value>)
            .reduce((sum, category) => sum + (filters.value[category] ? work.sizeBytesByType?.[category] ?? 0 : 0), 0);
    }
    return work.sizeBytes;
}

function selectedUnknownSizeCount(work: BackupWorkDownloadItem): number {
    if (!work.unknownSizeCountByType) return work.sizeState === 'partial' ? 1 : 0;
    return (Object.keys(filters.value) as BackupFileFilter[]).reduce((sum, category) => {
        if (!filters.value[category]) return sum;
        if (category === 'audio' && convertToOpus.value && estimatedOpusBytes(work) != null) return sum;
        return sum + (work.unknownSizeCountByType?.[category] ?? 0);
    }, 0);
}

function sizeCompleteness(work: BackupWorkDownloadItem): 'loading' | 'complete' | 'partial' | 'unavailable' {
    const bytes = displayedSizeBytes(work);
    const unknownCount = selectedUnknownSizeCount(work);
    if (unknownCount > 0) return bytes != null && bytes > 0 ? 'partial' : 'unavailable';
    if (work.sizeState === 'loading' && bytes == null) return 'loading';
    if (work.sizeState === 'unavailable' && bytes == null) return 'unavailable';
    return bytes == null ? 'unavailable' : 'complete';
}

function workMeasure(work: BackupWorkDownloadItem): string {
    const bytes = displayedSizeBytes(work);
    const completeness = sizeCompleteness(work);
    if (completeness === 'loading') return props.profile.labels.loading;
    if (completeness === 'unavailable' || bytes == null) {
        const duration = filters.value.audio ? formatDuration(work.durationSeconds) : '';
        const files = selectedFileCount(work);
        if (duration && files > 0) {
            return props.profile.labels.durationAndFiles
                .replace('{duration}', duration)
                .replace('{count}', String(files));
        }
        if (files > 0) return props.profile.labels.fileCount.replace('{count}', String(files));
        if (duration) return duration;
        return props.profile.labels.unknownSize;
    }
    const formatted = formatBytes(bytes);
    if (completeness === 'partial') return props.profile.labels.partialSize.replace('{size}', formatted);
    return filters.value.audio && estimatedOpusBytes(work) != null
        ? props.profile.labels.estimatedOpusSize.replace('{size}', formatted)
        : formatted;
}

function currentState(): BackupDownloadState {
    return {
        selectedWorkIds: props.works.filter(work => selectedIds.value.has(String(work.id))).map(work => work.id),
        filters: { ...filters.value },
        downloadConcurrency: normalizeDownloadConcurrency(downloadConcurrency.value),
        titleMode: titleMode.value,
        convertToOpus: convertToOpus.value,
        opusBitrate: opusBitrate.value,
        metadataMode: metadataMode.value,
        includeArtwork: includeArtwork.value,
    };
}

function emitUpdate(): void { emit('update', currentState()); }
function startDownload(): void { if (selectedIds.value.size > 0 && !props.busy) emit('start', currentState()); }
function onImageError(event: Event): void { (event.currentTarget as HTMLImageElement).hidden = true; }

function handleDialogKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') { event.preventDefault(); emit('close'); return; }
    if (event.key !== 'Tab' || !dialog.value) return;
    const focusable = [...dialog.value.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    )].filter(element => element.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

function syncTheme(): void {
    darkTheme.value = document.body.classList.contains('body--dark')
        || document.documentElement.classList.contains('dark')
        || Boolean(dialog.value?.closest('.q-dark'))
        || Boolean(document.getElementById('q-app')?.classList.contains('q-dark'));
}

onMounted(() => {
    void nextTick(() => {
        searchInput.value?.focus();
        syncTheme();
    });
    themeObserver = new MutationObserver(syncTheme);
    const targets = [document.documentElement, document.body, document.getElementById('q-app')]
        .filter((target): target is HTMLElement => Boolean(target));
    for (const target of targets) themeObserver.observe(target, { attributes: true, attributeFilter: ['class'] });
});
onUnmounted(() => {
    themeObserver?.disconnect();
    visibilityObserver?.disconnect();
    visibilityObserver = undefined;
    if (visibleFlush) clearTimeout(visibleFlush);
    visibleFlush = undefined;
    pendingVisibleIds = new Set();
    if (returnFocus?.isConnected) returnFocus.focus();
});

watch(sourceFilter, source => {
    tagFilter.value = '';
    searchQuery.value = '';
    completedSearchQuery.value = '';
    searchError.value = false;
    emit('sourceChange', source);
});
watch(() => props.showOwn, showOwn => {
    if (!showOwn && sourceFilter.value === 'own') sourceFilter.value = 'site';
});
watch(searchQuery, () => { searchError.value = false; });
watch(() => props.profile, profile => {
    selectedIds.value = new Set((profile.selectedWorkIds ?? []).map(String));
    filters.value = { ...profile.filters };
    downloadConcurrency.value = normalizeDownloadConcurrency(profile.downloadConcurrency);
    titleMode.value = profile.titleMode;
    convertToOpus.value = profile.convertToOpus;
    opusBitrate.value = profile.opusBitrate;
    metadataMode.value = profile.metadataMode;
    includeArtwork.value = profile.includeArtwork;
}, { deep: true });
</script>

<template>
    <div class="backup-downloader-backdrop asmr-dialog-overlay" data-testid="backup-downloader" @click.self="emit('close')">
        <section ref="dialog" class="backup-downloader asmr-dialog-card" :class="{ 'theme-dark': darkTheme }" role="dialog" aria-modal="true" aria-labelledby="backup-downloader-title" @keydown="handleDialogKeydown">
            <header class="dialog-header">
                <h2 id="backup-downloader-title">{{ profile.labels.dialogTitle }}</h2>
                <button type="button" class="icon-button" data-testid="close" :aria-label="profile.labels.close" @click="emit('close')"><i class="material-icons" aria-hidden="true">close</i></button>
            </header>

            <div class="source-tabs" role="tablist" :aria-label="profile.labels.playlistSource">
                <button type="button" role="tab" data-testid="source-site" :aria-selected="sourceFilter === 'site'" :class="{ active: sourceFilter === 'site' }" @click="sourceFilter = 'site'">{{ profile.labels.sourceAll }} <span v-if="sourceCounts.site">{{ sourceCounts.site.toLocaleString() }}</span></button>
                <button v-if="showOwn" type="button" role="tab" data-testid="source-own" :aria-selected="sourceFilter === 'own'" :class="{ active: sourceFilter === 'own' }" @click="sourceFilter = 'own'">{{ profile.labels.sourceOwn }} <span>{{ sourceCounts.own.toLocaleString() }}</span></button>
                <button type="button" role="tab" data-testid="source-public" :aria-selected="sourceFilter === 'public'" :class="{ active: sourceFilter === 'public' }" @click="sourceFilter = 'public'">{{ profile.labels.sourcePublic }} <span>{{ sourceCounts.public.toLocaleString() }}</span></button>
            </div>

            <div class="dialog-body">
                <section class="work-picker" aria-labelledby="work-picker-label">
                    <label id="work-picker-label" for="backup-work-search" class="section-label">{{ profile.labels.search }}</label>
                    <div class="search-row"><input id="backup-work-search" ref="searchInput" v-model="searchQuery" type="search" data-testid="search" :placeholder="profile.labels.searchPlaceholder" @keydown.enter="sourceFilter === 'site' && runAllWorksSearch()" /><button v-if="sourceFilter === 'site'" type="button" data-testid="search-all-works" :disabled="!searchQuery.trim() || searchingAll || busy" @click="runAllWorksSearch"><span v-if="searchingAll" class="spinner small" />{{ searchingAll ? profile.labels.searchAllLoading : profile.labels.searchAll }}</button></div>
                    <div class="picker-toolbar">
                        <label class="tag-filter"><span class="sr-only">{{ profile.labels.filterTags }}</span><select v-model="tagFilter" data-testid="tag-filter"><option value="">{{ profile.labels.allTags }}</option><option v-for="tag in availableTags" :key="tag" :value="tag">{{ tag }}</option></select></label>
                        <button type="button" data-testid="select-all" :disabled="busy || isLoadingCurrentSource || (!visiblePlaylists.length && !standaloneWorks.length)" @click="selectAllVisible">{{ profile.labels.selectAll }}</button>
                        <button type="button" data-testid="clear-all" :disabled="busy || !selectedIds.size" @click="clearAll">{{ profile.labels.clearAll }}</button>
                    </div>

                    <div class="playlist-list" data-testid="playlist-list">
                        <p v-if="searchError" class="inline-error search-error" data-testid="all-work-search-error">{{ profile.labels.searchFailed }}</p>
                        <p v-if="currentSourceLoadFailed" class="inline-error source-error" data-testid="source-load-error" role="alert">{{ profile.labels.loadFailed }}</p>
                        <section v-if="standaloneWorks.length" class="standalone-results" data-testid="all-work-results">
                            <div class="results-heading"><strong>{{ profile.labels.searchResults }}</strong><small v-if="searchResultSummary" data-testid="search-result-count">{{ searchResultSummary }}</small></div>
                            <div v-for="work in standaloneWorks" :key="work.id" v-work-visible="work.id" class="work-row work-result-row" :data-testid="`search-work-${work.id}`"><label class="work-select"><input type="checkbox" :checked="selectedIds.has(String(work.id))" :disabled="busy" @change="toggleWork(work)" /><span class="work-cover" aria-hidden="true"><img v-if="work.coverUrl" :src="work.coverUrl" alt="" loading="lazy" @error="onImageError" /><i class="material-icons">album</i></span><span class="work-copy"><strong>{{ displayTitle(work) }}</strong><small>{{ work.id }}</small></span></label><a class="work-link" :href="workUrl(work)" target="_blank" rel="noopener" :data-testid="`open-work-${work.id}`" :title="t('downloadCenterOpenWork')" :aria-label="t('downloadCenterOpenWork')"><i class="material-icons" aria-hidden="true">open_in_new</i></a><span class="work-size">{{ workMeasure(work) }}</span></div>
                            <p v-if="loadMoreError" class="inline-error search-error" data-testid="load-more-error">{{ profile.labels.searchFailed }}</p>
                            <button v-if="searchHasMore" type="button" class="load-more" data-testid="load-more" :disabled="loadingMore || busy" @click="loadMoreResults"><span v-if="loadingMore" class="spinner small" />{{ loadingMore ? t('downloadCenterLoadingMore') : t('downloadCenterLoadMore') }}</button>
                        </section>
                        <div v-if="isLoadingCurrentSource && !activePlaylists.length" class="loading-state" data-testid="playlist-loading"><span class="spinner" />{{ profile.labels.loading }}</div>
                        <article v-for="playlist in visiblePlaylists" :key="playlistKey(playlist)" class="playlist-group" :data-testid="`playlist-${playlist.id}`">
                            <div class="playlist-heading">
                                <div class="playlist-cover" aria-hidden="true">
                                    <img v-if="playlist.coverUrl" :src="playlist.coverUrl" alt="" loading="lazy" @error="onImageError" />
                                    <i class="material-icons">album</i>
                                </div>
                                <button type="button" class="expand-button" :disabled="resolvingIds.has(playlistKey(playlist))" :aria-expanded="isRenderedExpanded(playlist)" :aria-label="isRenderedExpanded(playlist) ? profile.labels.collapsePlaylist : profile.labels.expandPlaylist" :aria-controls="playlistElementId(playlist)" :data-testid="`expand-${playlist.id}`" @click="toggleExpanded(playlist)">
                                    <span v-if="resolvingIds.has(playlistKey(playlist))" class="spinner small" />
                                    <i v-else class="material-icons">{{ isExpanded(playlist) ? 'expand_more' : 'chevron_right' }}</i>
                                </button>
                                <label class="playlist-select">
                                    <input type="checkbox" :checked="playlistChecked(playlist)" :indeterminate.prop="playlistIndeterminate(playlist)" :disabled="busy || resolvingIds.has(playlistKey(playlist)) || playlist.worksCount === 0" :data-testid="`playlist-check-${playlist.id}`" @change="togglePlaylist(playlist)" />
                                    <span class="playlist-copy"><strong>{{ displayTitle(playlist) }}</strong><small><template v-if="playlist.owner">{{ profile.labels.playlistOwner.replace('{owner}', playlist.owner) }} · </template>{{ profile.labels.playlistWorks.replace('{count}', String(playlist.worksCount ?? playlistWorks(playlist).length)) }}</small></span>
                                    <span class="selected-count">{{ selectedInPlaylist(playlist) }}/{{ playlistWorks(playlist).length || playlist.worksCount || 0 }}</span>
                                </label>
                            </div>
                            <p v-if="playlist.error" class="inline-error">{{ profile.labels.loadFailed }}</p>
                            <div v-if="isRenderedExpanded(playlist)" :id="playlistElementId(playlist)" class="work-list">
                                <div v-for="work in visiblePlaylistWorks(playlist)" :key="work.id" v-work-visible="work.id" class="work-row work-result-row" :data-testid="`work-${work.id}`"><label class="work-select"><input type="checkbox" :checked="selectedIds.has(String(work.id))" :disabled="busy" @change="toggleWork(work)" /><span class="work-cover" aria-hidden="true"><img v-if="work.coverUrl" :src="work.coverUrl" alt="" loading="lazy" @error="onImageError" /><i class="material-icons">album</i></span><span class="work-copy"><strong>{{ displayTitle(work) }}</strong><small>{{ work.id }}</small></span></label><a class="work-link" :href="workUrl(work)" target="_blank" rel="noopener" :data-testid="`open-work-${work.id}`" :title="t('downloadCenterOpenWork')" :aria-label="t('downloadCenterOpenWork')"><i class="material-icons" aria-hidden="true">open_in_new</i></a><span class="work-size">{{ workMeasure(work) }}</span></div>
                                <p v-if="!playlistWorks(playlist).length && !playlist.error" class="loading-state">{{ profile.labels.loading }}</p>
                            </div>
                        </article>
                        <p v-if="!isLoadingCurrentSource && !currentSourceLoadFailed && visiblePlaylists.length === 0 && standaloneWorks.length === 0" class="empty-state" data-testid="no-results">{{ profile.labels.noResults }}</p>
                    </div>
                </section>

                <aside class="download-sidebar">
                    <details class="download-options" data-testid="download-options" open>
                        <summary>{{ profile.labels.options }}</summary>
                        <div class="download-options-content">
                            <p v-if="stagedDestination" class="hint" data-testid="staged-destination-hint">{{ t('downloadCenterStagedDestination') }}</p>
                            <fieldset><legend>{{ profile.labels.fileTypes }}</legend><label class="option-row"><input v-model="filters.audio" type="checkbox" data-testid="file-filter-audio" @change="emitUpdate" /> <span>{{ profile.labels.audio }}</span></label><label class="option-row"><input v-model="filters.video" type="checkbox" data-testid="file-filter-video" @change="emitUpdate" /> <span>{{ profile.labels.video }}</span></label><label class="option-row"><input v-model="filters.image" type="checkbox" data-testid="file-filter-image" @change="emitUpdate" /> <span>{{ profile.labels.images }}</span></label><label class="option-row"><input v-model="filters.text" type="checkbox" data-testid="file-filter-text" @change="emitUpdate" /> <span>{{ profile.labels.text }}</span></label><label class="option-row"><input v-model="filters.other" type="checkbox" data-testid="file-filter-other" @change="emitUpdate" /> <span>{{ profile.labels.other }}</span></label></fieldset>
                            <label class="stacked-option" data-testid="download-concurrency-option"><span>{{ t('downloadCenterConcurrency') }}</span><select v-model.number="downloadConcurrency" data-testid="download-concurrency" :disabled="convertToOpus || busy" @change="emitUpdate"><option v-for="count in MAX_DOWNLOAD_CONCURRENCY" :key="count" :value="count">{{ count }}</option></select><small class="stacked-hint">{{ convertToOpus ? t('downloadCenterConcurrencyOpusHint') : t('downloadCenterConcurrencyHint') }}</small></label>
                            <label class="stacked-option"><span>{{ profile.labels.filenameTitle }}</span><select v-model="titleMode" data-testid="title-mode" @change="emitUpdate"><option value="original">{{ profile.labels.titleOriginal }}</option><option value="translated">{{ profile.labels.titleTranslated }}</option><option value="original-bracketed-translation">{{ profile.labels.titleOriginalTranslated }}</option><option value="none">{{ profile.labels.titleNone }}</option></select></label>
                            <div class="hinted-option"><label class="option-row" data-testid="opus-option"><input v-model="convertToOpus" type="checkbox" data-testid="opus-toggle" aria-describedby="opus-memory-warning" @change="emitUpdate" /> <span>{{ profile.labels.convertToOpus }}</span></label><p id="opus-memory-warning" class="hint" data-testid="opus-memory-warning">{{ profile.labels.convertToOpusMemoryWarning }}</p></div>
                            <label v-if="convertToOpus" class="stacked-option" data-testid="opus-bitrate-option"><span>{{ profile.labels.opusBitrate }}</span><select v-model.number="opusBitrate" data-testid="opus-bitrate" @change="emitUpdate"><option :value="64">64 kbps</option><option :value="96">96 kbps</option><option :value="128">128 kbps</option><option :value="160">160 kbps</option><option :value="192">192 kbps</option></select></label>
                            <fieldset v-if="convertToOpus" data-testid="metadata-options"><legend>{{ profile.labels.metadata }}</legend><div class="hinted-option"><label class="option-row"><input v-model="metadataMode" name="backup-metadata-mode" type="radio" value="additive" @change="emitUpdate" /> <span>{{ profile.labels.metadataAdditive }}</span></label><p class="hint">{{ profile.labels.metadataAdditiveHint }}</p></div><div class="hinted-option"><label class="option-row"><input v-model="metadataMode" name="backup-metadata-mode" type="radio" value="overwrite" @change="emitUpdate" /> <span>{{ profile.labels.metadataOverwrite }}</span></label><p class="hint">{{ profile.labels.metadataOverwriteHint }}</p></div></fieldset>
                            <div class="hinted-option" data-testid="artwork-option"><label class="option-row"><input v-model="includeArtwork" type="checkbox" data-testid="artwork-toggle" @change="emitUpdate" /> <span>{{ profile.labels.includeArtwork }}</span></label><p class="hint">{{ profile.labels.includeArtworkHint }}</p></div>
                        </div>
                    </details>

                    <section v-if="errorMessage" class="error-panel" data-testid="download-error" role="alert"><i class="material-icons" aria-hidden="true">error_outline</i><p>{{ errorMessage }}</p></section>
                    <section v-if="progress" class="progress-panel" data-testid="download-progress" aria-live="polite">
                        <strong>{{ profile.labels.progress }}</strong><p class="progress-label" :title="progress.label">{{ progress.label }}</p><div v-if="progress.total > 0 || canPause" class="progress-track" :class="{ indeterminate: progress.total <= 0 }"><div :style="{ width: `${progressPercent}%` }" /></div><small v-if="progress.total > 0" data-testid="progress-count">{{ progress.current.toLocaleString() }} / {{ progress.total.toLocaleString() }}</small><small v-else data-testid="progress-count">{{ t('downloadCenterPreparing') }}</small><button v-if="canPause" type="button" data-testid="pause" @click="emit('pause')">{{ profile.labels.pause }}</button>
                    </section>
                    <section v-if="resumableJobs.length" class="resume-panel" data-testid="resume-list">
                        <strong>{{ profile.labels.resumableDownloads }}</strong>
                        <div v-for="job in resumableJobs" :key="job.id" class="resume-job">
                            <button type="button" :disabled="busy" :data-testid="`resume-${job.id}`" @click="emit('resume', job.id)"><i class="material-icons">resume</i>{{ job.title }}</button>
                            <button v-if="job.convertToOpus" type="button" :disabled="busy" :data-testid="`resume-without-opus-${job.id}`" @click="emit('resumeWithoutOpus', job.id)">{{ profile.labels.resumeWithoutOpus }}</button>
                            <button v-if="job.needsTitleTranslation" type="button" :disabled="busy" :data-testid="`resume-with-original-titles-${job.id}`" @click="emit('resumeWithOriginalTitles', job.id)">{{ profile.labels.resumeWithOriginalTitles }}</button>
                        </div>
                    </section>
                </aside>
            </div>

            <footer class="dialog-footer"><div class="footer-copy"><p class="selection-summary" data-testid="selection-summary" aria-live="polite">{{ profile.labels.selectedSummary.replace('{count}', String(selectedWorks.length)).replace('{bytes}', selectedSizeLabel) }} <span v-if="hasUnknownSelectedBytes"> + {{ profile.labels.unknownSize }}</span></p><p class="full-work-hint" data-testid="full-work-hint">{{ t('downloadCenterFullWorkHint') }}</p></div><div class="footer-actions"><button type="button" data-testid="cancel" @click="emit('close')">{{ busy ? profile.labels.close : profile.labels.cancel }}</button><button type="button" class="primary" data-testid="start" :disabled="selectedWorks.length === 0 || busy" @click="startDownload">{{ profile.labels.start }}</button></div></footer>
        </section>
    </div>
</template>

<style scoped>
.backup-downloader-backdrop { position: fixed; inset: 0; align-items: center; justify-content: center; padding: 20px; }
.backup-downloader { width: min(1040px, 100%); max-height: min(900px, calc(100vh - 40px)); display: flex; flex-direction: column; overflow: hidden; color: var(--asmr-text-primary); background: var(--asmr-bg-primary); border: 1px solid var(--asmr-border-color); }
.dialog-header,.dialog-footer { display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 18px }.dialog-header{border-bottom:1px solid var(--asmr-border-color)}.dialog-header h2{margin:0;color:inherit;font-size:1.25rem}.icon-button{display:grid;place-items:center;width:38px;height:38px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--asmr-text-primary)}
.source-tabs{display:flex;padding:0 18px;border-bottom:1px solid var(--asmr-border-color)}.source-tabs button{border:0;border-bottom:3px solid transparent;border-radius:0;background:transparent}.source-tabs button.active{color:var(--asmr-accent);border-color:var(--asmr-accent);font-weight:700}.source-tabs span{margin-left:5px;color:var(--asmr-text-tertiary)}
.dialog-body{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(270px,.8fr);flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain}.work-picker,.download-sidebar{min-width:0;min-height:0;padding:14px 18px;overflow:visible}.work-picker{display:flex;flex-direction:column;border-right:1px solid var(--asmr-border-color)}.section-label,legend,.stacked-option>span,summary{font-weight:650}input[type='search'],select{box-sizing:border-box;width:100%;min-height:38px;padding:7px 9px;color:inherit;background:var(--asmr-input-bg);border:1px solid var(--asmr-border-color);border-radius:7px}.search-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;margin-top:7px}.search-row button{display:flex;align-items:center;gap:6px;white-space:nowrap}.picker-toolbar{display:grid;grid-template-columns:minmax(120px,1fr) auto auto;gap:8px;margin-top:9px}.tag-filter{min-width:0}
.playlist-list{flex:1;min-height:180px;margin-top:10px;overflow:visible}.standalone-results{padding:10px;margin-bottom:8px;border:1px solid var(--asmr-accent);border-radius:8px;background:var(--asmr-bg-tertiary)}.standalone-results>strong{display:block;margin-bottom:5px}.playlist-group{border-bottom:1px solid var(--asmr-border-color)}.playlist-heading{display:flex;align-items:center;min-height:64px;padding:5px 2px}.playlist-cover,.work-cover{position:relative;overflow:hidden;border-radius:7px;background:var(--asmr-bg-tertiary);display:grid;place-items:center;color:var(--asmr-text-tertiary)}.playlist-cover{flex:0 0 48px;height:48px}.work-cover{width:44px;height:44px}.playlist-cover img,.work-cover img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.expand-button{flex:0 0 34px;width:34px;height:38px;padding:0;border:0;background:transparent}.playlist-select{display:flex;align-items:center;gap:9px;min-width:0;flex:1}.playlist-copy,.work-copy{display:flex;flex-direction:column;min-width:0}.playlist-copy strong,.playlist-copy small,.work-copy strong,.work-copy small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.playlist-copy small,.work-copy small,.selected-count,.work-size,.hint{color:var(--asmr-text-tertiary);font-size:.82rem}.selected-count{margin-left:auto;white-space:nowrap}.work-list{padding:0 0 8px 86px}.work-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:start;gap:8px;padding:6px 4px}.work-result-row{grid-template-columns:minmax(0,1fr) auto auto;align-items:center}.work-select{display:grid;grid-template-columns:auto 44px minmax(0,1fr);align-items:center;gap:8px;min-width:0}.work-link{display:grid;place-items:center;width:32px;height:32px;color:var(--asmr-text-tertiary);border-radius:6px;text-decoration:none}.work-link:hover{color:var(--asmr-accent)}.results-heading{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:5px}.load-more{width:100%;margin-top:8px;display:flex;align-items:center;justify-content:center;gap:6px}.footer-copy{display:flex;flex-direction:column;gap:2px;min-width:0}.full-work-hint{margin:0;color:var(--asmr-text-tertiary);font-size:.82rem;overflow-wrap:anywhere}.work-size{white-space:nowrap}.empty-state,.loading-state{padding:22px 8px;text-align:center;color:var(--asmr-text-tertiary)}.loading-state{display:flex;align-items:center;justify-content:center;gap:8px}.inline-error{margin:0 0 8px 86px;color:var(--asmr-state-stop);font-size:.85rem}
.download-sidebar{display:flex;flex-direction:column;gap:14px}.download-options{display:block}.download-options>summary{cursor:pointer;margin-bottom:12px}.download-options-content{display:flex;flex-direction:column;gap:18px}.download-options fieldset{display:flex;flex-direction:column;gap:9px;margin:0;padding:10px 12px;border:1px solid var(--asmr-border-color);border-radius:8px}.option-row{display:flex;align-items:flex-start;gap:7px;min-width:0;min-height:22px}.option-row span{min-width:0;overflow-wrap:anywhere}.option-row input{flex:0 0 auto;margin-top:3px}.stacked-option{display:block;min-width:0;margin:0}.stacked-option select{margin-top:6px}.stacked-hint{display:block;margin-top:5px;color:var(--asmr-text-tertiary);font-size:.78rem;line-height:1.35}.hinted-option{display:flex;flex-direction:column;min-width:0;gap:6px}.hint{margin:0 0 0 23px;line-height:1.35;overflow-wrap:anywhere}.progress-panel,.resume-panel,.error-panel{min-width:0;padding:12px;border:1px solid var(--asmr-border-color);border-radius:9px;background:var(--asmr-bg-secondary)}.error-panel{display:flex;align-items:flex-start;gap:8px;color:var(--asmr-state-stop);border-color:color-mix(in srgb,var(--asmr-state-stop) 45%,var(--asmr-border-color))}.error-panel p{margin:0;line-height:1.4}.progress-label{max-width:100%;min-height:1.4em;margin:7px 0;overflow:hidden;line-height:1.4;white-space:nowrap;text-overflow:ellipsis}.progress-track{height:8px;overflow:hidden;border-radius:99px;background:var(--asmr-input-bg)}.progress-track>div{height:100%;background:var(--asmr-accent);transition:width .2s}.progress-track.indeterminate>div{width:35%!important;animation:indeterminate 1.3s ease-in-out infinite}.progress-panel small{display:block;margin:6px 0}.resume-panel,.resume-job{display:flex;flex-direction:column;gap:7px}.resume-panel button{display:flex;align-items:center;gap:6px;text-align:left;overflow-wrap:anywhere}.resume-job+ .resume-job{padding-top:7px;border-top:1px solid var(--asmr-border-color)}
.dialog-footer{flex-wrap:wrap;border-top:1px solid var(--asmr-border-color)}.selection-summary{min-width:0;margin:0;overflow-wrap:anywhere}.footer-actions{display:flex;min-width:0;gap:10px;margin-left:auto}.footer-actions button{min-width:0;white-space:normal;overflow-wrap:anywhere}.footer-actions button:not(.primary){color:var(--asmr-text-primary)}button{min-height:38px;padding:7px 12px;cursor:pointer;color:inherit;background:var(--asmr-bg-secondary);border:1px solid var(--asmr-border-color);border-radius:7px}button.primary{color:#fff;background:color-mix(in srgb,var(--asmr-accent) 42%,#000);border-color:var(--asmr-accent);font-weight:700;text-shadow:0 1px 1px rgb(0 0 0 / 35%)}button:disabled{cursor:not-allowed;opacity:.5}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid var(--asmr-accent);outline-offset:2px}.spinner{width:18px;height:18px;border:2px solid var(--asmr-border-color);border-top-color:var(--asmr-accent);border-radius:50%;animation:spin .8s linear infinite}.spinner.small{display:inline-block;width:14px;height:14px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@keyframes spin{to{transform:rotate(360deg)}}@keyframes indeterminate{0%{transform:translateX(-110%)}100%{transform:translateX(300%)}}
.backup-downloader.theme-dark{color:#fff}
@media(max-width:720px){.backup-downloader-backdrop{align-items:stretch;padding:0}.backup-downloader{max-height:100vh;border-radius:0}.dialog-body{display:block}.work-picker{border-right:0;border-bottom:1px solid var(--asmr-border-color)}.dialog-footer{align-items:stretch}.footer-actions{width:100%;margin-left:0}.footer-actions button{flex:1}.picker-toolbar{grid-template-columns:1fr 1fr}.tag-filter{grid-column:1/-1}.work-list{padding-left:42px}}
.search-error,.source-error{margin-left:0}
</style>
