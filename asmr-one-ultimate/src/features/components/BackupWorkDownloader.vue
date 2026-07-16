<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type {
    BackupDownloadProfile,
    BackupDownloadProgress,
    BackupDownloadState,
    BackupPlaylistDownloadItem,
    BackupPlaylistSourceFilter,
    BackupWorkDownloadItem,
} from '../backupWorkDownloaderTypes';

interface ResumableJobItem { id: string; title: string }

const props = withDefaults(defineProps<{
    playlists: BackupPlaylistDownloadItem[];
    works: BackupWorkDownloadItem[];
    profile: BackupDownloadProfile;
    loadingOwn?: boolean;
    loadingPublic?: boolean;
    busy?: boolean;
    progress?: BackupDownloadProgress | null;
    resumableJobs?: ResumableJobItem[];
    resolvePlaylist?: (playlist: BackupPlaylistDownloadItem) => Promise<void>;
    searchAllWorks?: (query: string) => Promise<void>;
}>(), {
    loadingOwn: false,
    loadingPublic: false,
    busy: false,
    progress: null,
    resumableJobs: () => [],
    resolvePlaylist: undefined,
    searchAllWorks: undefined,
});

const emit = defineEmits<{
    close: [];
    start: [state: BackupDownloadState];
    update: [state: BackupDownloadState];
    sourceChange: [source: BackupPlaylistSourceFilter];
    pause: [];
    resume: [jobId: string];
    importBackup: [file: File];
}>();

const searchQuery = ref('');
const sourceFilter = ref<BackupPlaylistSourceFilter>('own');
const tagFilter = ref('');
const dialog = ref<HTMLElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);
const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
const selectedIds = ref(new Set((props.profile.selectedWorkIds ?? []).map(String)));
const expandedIds = ref(new Set<string>());
const resolvingIds = ref(new Set<string>());
const searchingAll = ref(false);
const searchError = ref(false);
const filters = ref({ ...props.profile.filters });
const titleMode = ref(props.profile.titleMode);
const convertToOpus = ref(props.profile.convertToOpus);
const opusBitrate = ref(props.profile.opusBitrate);
const metadataMode = ref(props.profile.metadataMode);
const includeArtwork = ref(props.profile.includeArtwork);

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

const activePlaylists = computed(() => props.playlists.filter(playlist => playlist.source === sourceFilter.value));
const availableTags = computed(() => {
    const tags = new Map<string, string>();
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
    own: props.playlists.filter(playlist => playlist.source === 'own').length,
    public: props.playlists.filter(playlist => playlist.source === 'public').length,
}));
const selectedWorks = computed(() => props.works.filter(work => selectedIds.value.has(String(work.id))));
const standaloneWorks = computed(() => props.works.filter(work => work.directSearchResult && matchesSearch(work)));
const knownSelectedBytes = computed(() => selectedWorks.value.reduce((sum, work) => sum + Math.max(0, work.sizeBytes ?? 0), 0));
const hasUnknownSelectedBytes = computed(() => selectedWorks.value.some(work => work.sizeBytes == null));
const isLoadingCurrentSource = computed(() => sourceFilter.value === 'own' ? props.loadingOwn : props.loadingPublic);
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
    next.has(id) ? next.delete(id) : next.add(id);
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
    try { await props.searchAllWorks(query); }
    catch { searchError.value = true; }
    finally { searchingAll.value = false; }
}

function importBackupFile(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) emit('importBackup', file);
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

function currentState(): BackupDownloadState {
    return {
        selectedWorkIds: props.works.filter(work => selectedIds.value.has(String(work.id))).map(work => work.id),
        filters: { ...filters.value },
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
        'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter(element => element.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

onMounted(() => { void nextTick(() => searchInput.value?.focus()); });
onUnmounted(() => { if (returnFocus?.isConnected) returnFocus.focus(); });

watch(sourceFilter, source => { tagFilter.value = ''; emit('sourceChange', source); });
watch(searchQuery, () => { searchError.value = false; });
watch(() => props.profile, profile => {
    selectedIds.value = new Set((profile.selectedWorkIds ?? []).map(String));
    filters.value = { ...profile.filters };
    titleMode.value = profile.titleMode;
    convertToOpus.value = profile.convertToOpus;
    opusBitrate.value = profile.opusBitrate;
    metadataMode.value = profile.metadataMode;
    includeArtwork.value = profile.includeArtwork;
}, { deep: true });
</script>

<template>
    <div class="backup-downloader-backdrop asmr-dialog-overlay" data-testid="backup-downloader" @click.self="emit('close')">
        <section ref="dialog" class="backup-downloader asmr-dialog-card" role="dialog" aria-modal="true" aria-labelledby="backup-downloader-title" @keydown="handleDialogKeydown">
            <header class="dialog-header">
                <h2 id="backup-downloader-title">{{ profile.labels.dialogTitle }}</h2>
                <div class="header-actions"><label class="import-button" :class="{ disabled: busy }"><input type="file" accept="application/json,.json" data-testid="download-center-import-input" :disabled="busy" @change="importBackupFile" /><i class="material-icons" aria-hidden="true">upload_file</i>{{ profile.labels.importBackup }}</label><button type="button" class="icon-button" data-testid="close" :aria-label="profile.labels.close" @click="emit('close')"><i class="material-icons">close</i></button></div>
            </header>

            <div class="source-tabs" role="tablist" :aria-label="profile.labels.playlistSource">
                <button type="button" role="tab" data-testid="source-own" :aria-selected="sourceFilter === 'own'" :class="{ active: sourceFilter === 'own' }" @click="sourceFilter = 'own'">{{ profile.labels.sourceOwn }} <span>{{ sourceCounts.own.toLocaleString() }}</span></button>
                <button type="button" role="tab" data-testid="source-public" :aria-selected="sourceFilter === 'public'" :class="{ active: sourceFilter === 'public' }" @click="sourceFilter = 'public'">{{ profile.labels.sourcePublic }} <span>{{ sourceCounts.public.toLocaleString() }}</span></button>
            </div>

            <div class="dialog-body">
                <section class="work-picker" aria-labelledby="work-picker-label">
                    <label id="work-picker-label" for="backup-work-search" class="section-label">{{ profile.labels.search }}</label>
                    <div class="search-row"><input id="backup-work-search" ref="searchInput" v-model="searchQuery" type="search" data-testid="search" :placeholder="profile.labels.searchPlaceholder" @keydown.enter="runAllWorksSearch" /><button type="button" data-testid="search-all-works" :disabled="!searchQuery.trim() || searchingAll || busy" @click="runAllWorksSearch"><span v-if="searchingAll" class="spinner small" />{{ searchingAll ? profile.labels.searchAllLoading : profile.labels.searchAll }}</button></div>
                    <div class="picker-toolbar">
                        <label class="tag-filter"><span class="sr-only">{{ profile.labels.filterTags }}</span><select v-model="tagFilter" data-testid="tag-filter"><option value="">{{ profile.labels.allTags }}</option><option v-for="tag in availableTags" :key="tag" :value="tag">{{ tag }}</option></select></label>
                        <button type="button" data-testid="select-all" :disabled="busy || isLoadingCurrentSource || (!visiblePlaylists.length && !standaloneWorks.length)" @click="selectAllVisible">{{ profile.labels.selectAll }}</button>
                        <button type="button" data-testid="clear-all" :disabled="busy || !selectedIds.size" @click="clearAll">{{ profile.labels.clearAll }}</button>
                    </div>

                    <div class="playlist-list" data-testid="playlist-list">
                        <p v-if="searchError" class="inline-error search-error" data-testid="all-work-search-error">{{ profile.labels.searchFailed }}</p>
                        <section v-if="standaloneWorks.length" class="standalone-results" data-testid="all-work-results"><strong>{{ profile.labels.searchResults }}</strong><label v-for="work in standaloneWorks" :key="work.id" class="work-row" :data-testid="`search-work-${work.id}`"><input type="checkbox" :checked="selectedIds.has(String(work.id))" :disabled="busy" @change="toggleWork(work)" /><span>{{ displayTitle(work) }}</span><span class="work-size">{{ work.sizeBytes == null ? profile.labels.unknownSize : formatBytes(work.sizeBytes) }}</span></label></section>
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
                                <label v-for="work in visiblePlaylistWorks(playlist)" :key="work.id" class="work-row" :data-testid="`work-${work.id}`"><input type="checkbox" :checked="selectedIds.has(String(work.id))" :disabled="busy" @change="toggleWork(work)" /><span>{{ displayTitle(work) }}</span><span class="work-size">{{ work.sizeBytes == null ? profile.labels.unknownSize : formatBytes(work.sizeBytes) }}</span></label>
                                <p v-if="!playlistWorks(playlist).length && !playlist.error" class="loading-state">{{ profile.labels.loading }}</p>
                            </div>
                        </article>
                        <p v-if="!isLoadingCurrentSource && visiblePlaylists.length === 0 && standaloneWorks.length === 0" class="empty-state" data-testid="no-results">{{ profile.labels.noResults }}</p>
                    </div>
                </section>

                <aside class="download-sidebar">
                    <details class="download-options" data-testid="download-options" open>
                        <summary>{{ profile.labels.options }}</summary>
                        <fieldset><legend>{{ profile.labels.fileTypes }}</legend><label><input v-model="filters.audio" type="checkbox" @change="emitUpdate" /> {{ profile.labels.audio }}</label><label><input v-model="filters.video" type="checkbox" @change="emitUpdate" /> {{ profile.labels.video }}</label><label><input v-model="filters.image" type="checkbox" @change="emitUpdate" /> {{ profile.labels.images }}</label><label><input v-model="filters.text" type="checkbox" @change="emitUpdate" /> {{ profile.labels.text }}</label><label><input v-model="filters.other" type="checkbox" @change="emitUpdate" /> {{ profile.labels.other }}</label></fieldset>
                        <label class="stacked-option"><span>{{ profile.labels.filenameTitle }}</span><select v-model="titleMode" data-testid="title-mode" @change="emitUpdate"><option value="original">{{ profile.labels.titleOriginal }}</option><option value="translated">{{ profile.labels.titleTranslated }}</option><option value="original-bracketed-translation">{{ profile.labels.titleOriginalTranslated }}</option><option value="none">{{ profile.labels.titleNone }}</option></select></label>
                        <label><input v-model="convertToOpus" type="checkbox" data-testid="opus-toggle" @change="emitUpdate" /> {{ profile.labels.convertToOpus }}</label>
                        <label v-if="convertToOpus" class="stacked-option"><span>{{ profile.labels.opusBitrate }}</span><select v-model.number="opusBitrate" data-testid="opus-bitrate" @change="emitUpdate"><option :value="64">64 kbps</option><option :value="96">96 kbps</option><option :value="128">128 kbps</option><option :value="160">160 kbps</option><option :value="192">192 kbps</option></select></label>
                        <template v-if="convertToOpus"><fieldset><legend>{{ profile.labels.metadata }}</legend><label><input v-model="metadataMode" name="backup-metadata-mode" type="radio" value="additive" @change="emitUpdate" /> {{ profile.labels.metadataAdditive }}</label><p class="hint">{{ profile.labels.metadataAdditiveHint }}</p><label><input v-model="metadataMode" name="backup-metadata-mode" type="radio" value="overwrite" @change="emitUpdate" /> {{ profile.labels.metadataOverwrite }}</label><p class="hint">{{ profile.labels.metadataOverwriteHint }}</p></fieldset></template><label><input v-model="includeArtwork" type="checkbox" data-testid="artwork-toggle" @change="emitUpdate" /> {{ profile.labels.includeArtwork }}</label><p class="hint">{{ profile.labels.includeArtworkHint }}</p>
                    </details>

                    <section v-if="progress" class="progress-panel" data-testid="download-progress" aria-live="polite">
                        <strong>{{ profile.labels.progress }}</strong><p>{{ progress.label }}</p><div class="progress-track" :class="{ indeterminate: progress.total <= 0 }"><div :style="{ width: `${progressPercent}%` }" /></div><small>{{ progress.current.toLocaleString() }} / {{ progress.total.toLocaleString() }}</small><button v-if="busy && (progress.phase === 'downloading' || progress.phase === 'converting')" type="button" data-testid="pause" @click="emit('pause')">{{ profile.labels.pause }}</button>
                    </section>
                    <section v-if="resumableJobs.length" class="resume-panel" data-testid="resume-list"><strong>{{ profile.labels.resumableDownloads }}</strong><button v-for="job in resumableJobs" :key="job.id" type="button" :disabled="busy" :data-testid="`resume-${job.id}`" @click="emit('resume', job.id)"><i class="material-icons">resume</i>{{ job.title }}</button></section>
                </aside>
            </div>

            <footer class="dialog-footer"><p class="selection-summary" data-testid="selection-summary" aria-live="polite">{{ profile.labels.selectedSummary.replace('{count}', String(selectedWorks.length)).replace('{bytes}', formatBytes(knownSelectedBytes)) }} <span v-if="hasUnknownSelectedBytes"> + {{ profile.labels.unknownSize }}</span></p><div class="footer-actions"><button type="button" data-testid="cancel" @click="emit('close')">{{ busy ? profile.labels.close : profile.labels.cancel }}</button><button type="button" class="primary" data-testid="start" :disabled="selectedWorks.length === 0 || busy" @click="startDownload">{{ profile.labels.start }}</button></div></footer>
        </section>
    </div>
</template>

<style scoped>
.backup-downloader-backdrop { position: fixed; inset: 0; align-items: center; justify-content: center; padding: 20px; }
.backup-downloader { width: min(1040px, 100%); max-height: min(900px, calc(100vh - 40px)); display: flex; flex-direction: column; overflow: hidden; color: var(--asmr-text-primary); background: var(--asmr-bg-primary); border: 1px solid var(--asmr-border-color); }
.dialog-header,.dialog-footer { display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 18px }.dialog-header{border-bottom:1px solid var(--asmr-border-color)}.dialog-header h2{margin:0;font-size:1.25rem}.header-actions{display:flex;align-items:center;gap:8px}.import-button{display:flex;align-items:center;gap:6px;min-height:38px;padding:7px 10px;cursor:pointer;border:1px solid var(--asmr-border-color);border-radius:7px;background:var(--asmr-bg-secondary)}.import-button input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}.import-button.disabled{cursor:not-allowed;opacity:.5}.icon-button{display:grid;place-items:center;width:38px;height:38px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--asmr-text-primary)}
.source-tabs{display:flex;padding:0 18px;border-bottom:1px solid var(--asmr-border-color)}.source-tabs button{border:0;border-bottom:3px solid transparent;border-radius:0;background:transparent}.source-tabs button.active{color:var(--asmr-accent);border-color:var(--asmr-accent);font-weight:700}.source-tabs span{margin-left:5px;color:var(--asmr-text-tertiary)}
.dialog-body{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(270px,.8fr);min-height:0;overflow:hidden}.work-picker,.download-sidebar{min-height:0;padding:14px 18px;overflow:auto}.work-picker{display:flex;flex-direction:column;border-right:1px solid var(--asmr-border-color)}.section-label,legend,.stacked-option>span,summary{font-weight:650}input[type='search'],select{box-sizing:border-box;width:100%;min-height:38px;padding:7px 9px;color:inherit;background:var(--asmr-input-bg);border:1px solid var(--asmr-border-color);border-radius:7px}.search-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;margin-top:7px}.search-row button{display:flex;align-items:center;gap:6px;white-space:nowrap}.picker-toolbar{display:grid;grid-template-columns:minmax(120px,1fr) auto auto;gap:8px;margin-top:9px}.tag-filter{min-width:0}
.playlist-list{flex:1;min-height:180px;margin-top:10px;overflow:auto}.standalone-results{padding:10px;margin-bottom:8px;border:1px solid var(--asmr-accent);border-radius:8px;background:var(--asmr-bg-tertiary)}.standalone-results>strong{display:block;margin-bottom:5px}.playlist-group{border-bottom:1px solid var(--asmr-border-color)}.playlist-heading{display:flex;align-items:center;min-height:64px;padding:5px 2px}.playlist-cover{position:relative;flex:0 0 48px;height:48px;overflow:hidden;border-radius:7px;background:var(--asmr-bg-tertiary);display:grid;place-items:center;color:var(--asmr-text-tertiary)}.playlist-cover img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.expand-button{flex:0 0 34px;width:34px;height:38px;padding:0;border:0;background:transparent}.playlist-select{display:flex;align-items:center;gap:9px;min-width:0;flex:1}.playlist-copy{display:flex;flex-direction:column;min-width:0}.playlist-copy strong,.playlist-copy small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.playlist-copy small,.selected-count,.work-size,.hint{color:var(--asmr-text-tertiary);font-size:.82rem}.selected-count{margin-left:auto;white-space:nowrap}.work-list{padding:0 0 8px 86px}.work-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:start;gap:8px;padding:6px 4px}.empty-state,.loading-state{padding:22px 8px;text-align:center;color:var(--asmr-text-tertiary)}.loading-state{display:flex;align-items:center;justify-content:center;gap:8px}.inline-error{margin:0 0 8px 86px;color:var(--asmr-state-stop);font-size:.85rem}
.download-sidebar{display:flex;flex-direction:column;gap:14px}.download-options{display:flex;flex-direction:column;gap:13px}.download-options>summary{cursor:pointer;margin-bottom:12px}.download-options fieldset{display:flex;flex-direction:column;gap:7px;margin:0 0 13px;padding:10px 12px;border:1px solid var(--asmr-border-color);border-radius:8px}.stacked-option{display:block;margin-bottom:13px}.stacked-option select{margin-top:6px}.hint{margin:-8px 0 10px 23px;line-height:1.35}.progress-panel,.resume-panel{padding:12px;border:1px solid var(--asmr-border-color);border-radius:9px;background:var(--asmr-bg-secondary)}.progress-panel p{margin:7px 0}.progress-track{height:8px;overflow:hidden;border-radius:99px;background:var(--asmr-input-bg)}.progress-track>div{height:100%;background:var(--asmr-accent);transition:width .2s}.progress-track.indeterminate>div{width:35%!important;animation:indeterminate 1.3s ease-in-out infinite}.progress-panel small{display:block;margin:6px 0}.resume-panel{display:flex;flex-direction:column;gap:7px}.resume-panel button{display:flex;align-items:center;gap:6px;text-align:left}
.dialog-footer{flex-wrap:wrap;border-top:1px solid var(--asmr-border-color)}.selection-summary{margin:0}.footer-actions{display:flex;gap:10px;margin-left:auto}button{min-height:38px;padding:7px 12px;cursor:pointer;color:inherit;background:var(--asmr-bg-secondary);border:1px solid var(--asmr-border-color);border-radius:7px}button.primary{color:var(--asmr-text-inverted);background:var(--asmr-accent);border-color:var(--asmr-accent);font-weight:700}button:disabled{cursor:not-allowed;opacity:.5}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid var(--asmr-accent);outline-offset:2px}.spinner{width:18px;height:18px;border:2px solid var(--asmr-border-color);border-top-color:var(--asmr-accent);border-radius:50%;animation:spin .8s linear infinite}.spinner.small{display:inline-block;width:14px;height:14px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@keyframes spin{to{transform:rotate(360deg)}}@keyframes indeterminate{0%{transform:translateX(-110%)}100%{transform:translateX(300%)}}
@media(max-width:720px){.backup-downloader-backdrop{align-items:stretch;padding:0}.backup-downloader{max-height:100vh;border-radius:0}.dialog-body{display:block;overflow:auto}.work-picker,.download-sidebar{overflow:visible}.work-picker{border-right:0;border-bottom:1px solid var(--asmr-border-color)}.playlist-list{max-height:42vh}.dialog-footer{align-items:stretch}.footer-actions{width:100%;margin-left:0}.footer-actions button{flex:1}.picker-toolbar{grid-template-columns:1fr 1fr}.tag-filter{grid-column:1/-1}.work-list{padding-left:42px}}
.search-error{margin-left:0}
</style>
