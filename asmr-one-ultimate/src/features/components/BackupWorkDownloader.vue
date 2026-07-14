<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type {
    BackupDownloadProfile,
    BackupDownloadState,
    BackupPlaylistDownloadItem,
    BackupWorkDownloadItem,
} from '../backupWorkDownloaderTypes';

const props = defineProps<{
    playlists: BackupPlaylistDownloadItem[];
    works: BackupWorkDownloadItem[];
    profile: BackupDownloadProfile;
}>();

const emit = defineEmits<{
    close: [];
    start: [state: BackupDownloadState];
    update: [state: BackupDownloadState];
}>();

const searchQuery = ref('');
const dialog = ref<HTMLElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);
const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
const selectedIds = ref(new Set((props.profile.selectedWorkIds ?? []).map(String)));
// Backups can contain hundreds of playlists and thousands of works. Keep
// groups collapsed until requested so the dialog does not eagerly mount every
// work row (search still reveals matching rows across all groups).
const expandedIds = ref(new Set<string>());
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

const visiblePlaylists = computed(() => {
    const query = normalized(searchQuery.value.trim());
    return props.playlists.filter(playlist => {
        return !query
            || normalized(playlist.title).includes(query)
            || normalized(playlist.translatedTitle).includes(query)
            || visiblePlaylistWorks(playlist).length > 0;
    });
});

const assignedWorkIds = computed(() => {
    const ids = new Set<string>();
    for (const playlist of props.playlists) {
        for (const work of playlistWorks(playlist)) ids.add(String(work.id));
    }
    return ids;
});

const ungroupedWorks = computed(() => props.works.filter(work => !assignedWorkIds.value.has(String(work.id)) && matchesSearch(work)));
const selectedWorks = computed(() => props.works.filter(work => selectedIds.value.has(String(work.id))));
const knownSelectedBytes = computed(() => selectedWorks.value.reduce((sum, work) => sum + Math.max(0, work.sizeBytes ?? 0), 0));
const hasUnknownSelectedBytes = computed(() => selectedWorks.value.some(work => work.sizeBytes == null));

function displayTitle(item: { title: string; translatedTitle?: string }): string {
    if (item.translatedTitle && item.translatedTitle !== item.title) {
        return `${item.title} [${item.translatedTitle}]`;
    }
    return item.title;
}

function isExpanded(playlist: BackupPlaylistDownloadItem): boolean {
    return expandedIds.value.has(String(playlist.id));
}

function isRenderedExpanded(playlist: BackupPlaylistDownloadItem): boolean {
    return isExpanded(playlist) || (!!searchQuery.value.trim() && visiblePlaylistWorks(playlist).length > 0);
}

function toggleExpanded(playlist: BackupPlaylistDownloadItem): void {
    const next = new Set(expandedIds.value);
    const id = String(playlist.id);
    next.has(id) ? next.delete(id) : next.add(id);
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

function togglePlaylist(playlist: BackupPlaylistDownloadItem): void {
    const next = new Set(selectedIds.value);
    const works = playlistWorks(playlist);
    const select = !playlistChecked(playlist);
    for (const work of works) {
        select ? next.add(String(work.id)) : next.delete(String(work.id));
    }
    selectedIds.value = next;
    emitUpdate();
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = -1;
    do {
        value /= 1024;
        unit += 1;
    } while (value >= 1024 && unit < units.length - 1);
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

function emitUpdate(): void {
    emit('update', currentState());
}

function startDownload(): void {
    if (selectedIds.value.size > 0) emit('start', currentState());
}

function handleDialogKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
        event.preventDefault();
        emit('close');
        return;
    }
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

watch(
    () => props.profile,
    profile => {
        selectedIds.value = new Set((profile.selectedWorkIds ?? []).map(String));
        filters.value = { ...profile.filters };
        titleMode.value = profile.titleMode;
        convertToOpus.value = profile.convertToOpus;
        opusBitrate.value = profile.opusBitrate;
        metadataMode.value = profile.metadataMode;
        includeArtwork.value = profile.includeArtwork;
    },
    { deep: true },
);
</script>

<template>
    <div class="backup-downloader-backdrop" data-testid="backup-downloader" @click.self="emit('close')">
        <section ref="dialog" class="backup-downloader" role="dialog" aria-modal="true" aria-labelledby="backup-downloader-title" @keydown="handleDialogKeydown">
            <header class="dialog-header">
                <h2 id="backup-downloader-title">{{ profile.labels.dialogTitle }}</h2>
                <button type="button" class="icon-button" data-testid="close" :aria-label="profile.labels.close" @click="emit('close')">×</button>
            </header>

            <div class="dialog-body">
                <section class="work-picker" aria-labelledby="work-picker-label">
                    <label id="work-picker-label" for="backup-work-search" class="section-label">{{ profile.labels.search }}</label>
                    <input id="backup-work-search" ref="searchInput" v-model="searchQuery" type="search" data-testid="search" :placeholder="profile.labels.searchPlaceholder" />

                    <div class="playlist-list" data-testid="playlist-list">
                        <article v-for="playlist in visiblePlaylists" :key="playlist.id" class="playlist-group" :data-testid="`playlist-${playlist.id}`">
                            <div class="playlist-heading">
                                <button
                                    v-if="!searchQuery.trim()"
                                    type="button"
                                    class="expand-button"
                                    :aria-expanded="isRenderedExpanded(playlist)"
                                    :aria-label="isRenderedExpanded(playlist) ? profile.labels.collapsePlaylist : profile.labels.expandPlaylist"
                                    :aria-controls="`backup-playlist-${playlist.id}`"
                                    :data-testid="`expand-${playlist.id}`"
                                    @click="toggleExpanded(playlist)"
                                >{{ isExpanded(playlist) ? '▾' : '▸' }}</button>
                                <span v-else class="expand-button search-expanded" aria-hidden="true">▾</span>
                                <label>
                                    <input
                                        type="checkbox"
                                        :checked="playlistChecked(playlist)"
                                        :indeterminate.prop="playlistIndeterminate(playlist)"
                                        :disabled="playlistWorks(playlist).length === 0"
                                        :data-testid="`playlist-check-${playlist.id}`"
                                        @change="togglePlaylist(playlist)"
                                    />
                                    <span>{{ displayTitle(playlist) }}</span>
                                    <span class="muted">{{ selectedInPlaylist(playlist) }}/{{ playlistWorks(playlist).length }}</span>
                                </label>
                            </div>
                            <div v-if="isRenderedExpanded(playlist)" :id="`backup-playlist-${playlist.id}`" class="work-list">
                                <label v-for="work in visiblePlaylistWorks(playlist)" :key="work.id" class="work-row" :data-testid="`work-${work.id}`">
                                    <input type="checkbox" :checked="selectedIds.has(String(work.id))" @change="toggleWork(work)" />
                                    <span>{{ displayTitle(work) }}</span>
                                    <span class="work-size">{{ work.sizeBytes == null ? profile.labels.unknownSize : formatBytes(work.sizeBytes) }}</span>
                                </label>
                            </div>
                        </article>

                        <div v-if="ungroupedWorks.length" class="work-list ungrouped-works">
                            <label v-for="work in ungroupedWorks" :key="work.id" class="work-row" :data-testid="`work-${work.id}`">
                                <input type="checkbox" :checked="selectedIds.has(String(work.id))" @change="toggleWork(work)" />
                                <span>{{ displayTitle(work) }}</span>
                                <span class="work-size">{{ work.sizeBytes == null ? profile.labels.unknownSize : formatBytes(work.sizeBytes) }}</span>
                            </label>
                        </div>

                        <p v-if="visiblePlaylists.length === 0 && ungroupedWorks.length === 0" class="empty-state" data-testid="no-results">{{ profile.labels.noResults }}</p>
                    </div>
                </section>

                <section class="download-options" data-testid="download-options">
                    <fieldset>
                        <legend>{{ profile.labels.fileTypes }}</legend>
                        <label><input v-model="filters.audio" type="checkbox" @change="emitUpdate" /> {{ profile.labels.audio }}</label>
                        <label><input v-model="filters.video" type="checkbox" @change="emitUpdate" /> {{ profile.labels.video }}</label>
                        <label><input v-model="filters.image" type="checkbox" @change="emitUpdate" /> {{ profile.labels.images }}</label>
                        <label><input v-model="filters.text" type="checkbox" @change="emitUpdate" /> {{ profile.labels.text }}</label>
                        <label><input v-model="filters.other" type="checkbox" @change="emitUpdate" /> {{ profile.labels.other }}</label>
                    </fieldset>

                    <label class="stacked-option">
                        <span>{{ profile.labels.filenameTitle }}</span>
                        <select v-model="titleMode" data-testid="title-mode" @change="emitUpdate">
                            <option value="original">{{ profile.labels.titleOriginal }}</option>
                            <option value="translated">{{ profile.labels.titleTranslated }}</option>
                            <option value="original-bracketed-translation">{{ profile.labels.titleOriginalTranslated }}</option>
                            <option value="none">{{ profile.labels.titleNone }}</option>
                        </select>
                    </label>

                    <label><input v-model="convertToOpus" type="checkbox" data-testid="opus-toggle" @change="emitUpdate" /> {{ profile.labels.convertToOpus }}</label>
                    <label v-if="convertToOpus" class="stacked-option">
                        <span>{{ profile.labels.opusBitrate }}</span>
                        <select v-model.number="opusBitrate" data-testid="opus-bitrate" @change="emitUpdate">
                            <option :value="64">64 kbps</option>
                            <option :value="96">96 kbps</option>
                            <option :value="128">128 kbps</option>
                            <option :value="160">160 kbps</option>
                            <option :value="192">192 kbps</option>
                        </select>
                    </label>

                    <template v-if="convertToOpus">
                        <fieldset>
                            <legend>{{ profile.labels.metadata }}</legend>
                            <label><input v-model="metadataMode" name="backup-metadata-mode" type="radio" value="additive" @change="emitUpdate" /> {{ profile.labels.metadataAdditive }}</label>
                            <p class="hint">{{ profile.labels.metadataAdditiveHint }}</p>
                            <label><input v-model="metadataMode" name="backup-metadata-mode" type="radio" value="overwrite" @change="emitUpdate" /> {{ profile.labels.metadataOverwrite }}</label>
                            <p class="hint">{{ profile.labels.metadataOverwriteHint }}</p>
                        </fieldset>

                        <label><input v-model="includeArtwork" type="checkbox" data-testid="artwork-toggle" @change="emitUpdate" /> {{ profile.labels.includeArtwork }}</label>
                        <p class="hint">{{ profile.labels.includeArtworkHint }}</p>
                    </template>
                </section>
            </div>

            <footer class="dialog-footer">
                <p class="selection-summary" data-testid="selection-summary" aria-live="polite">
                    {{ profile.labels.selectedSummary.replace('{count}', String(selectedWorks.length)).replace('{bytes}', formatBytes(knownSelectedBytes)) }}
                    <span v-if="hasUnknownSelectedBytes"> + {{ profile.labels.unknownSize }}</span>
                </p>
                <div class="footer-actions">
                    <button type="button" data-testid="cancel" @click="emit('close')">{{ profile.labels.cancel }}</button>
                    <button type="button" class="primary" data-testid="start" :disabled="selectedWorks.length === 0" @click="startDownload">{{ profile.labels.start }}</button>
                </div>
            </footer>
        </section>
    </div>
</template>

<style scoped>
.backup-downloader-backdrop { position: fixed; inset: 0; z-index: 10020; display: grid; place-items: center; padding: 20px; background: rgb(0 0 0 / 65%); }
.backup-downloader { width: min(920px, 100%); max-height: min(860px, calc(100vh - 40px)); display: flex; flex-direction: column; overflow: hidden; color: #eee; background: #222; border: 1px solid #555; border-radius: 12px; box-shadow: 0 16px 50px rgb(0 0 0 / 45%); }
.dialog-header, .dialog-footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 20px; }
.dialog-header { border-bottom: 1px solid #444; }
.dialog-header h2 { margin: 0; font-size: 1.25rem; }
.icon-button { min-width: 36px; min-height: 36px; border: 0; border-radius: 50%; color: inherit; background: transparent; font-size: 1.6rem; }
.dialog-body { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(250px, 1fr); min-height: 0; overflow: hidden; }
.work-picker, .download-options { min-height: 0; padding: 16px 20px; overflow: auto; }
.work-picker { display: flex; flex-direction: column; border-right: 1px solid #444; }
.section-label, legend, .stacked-option > span { font-weight: 650; }
input[type='search'], select { box-sizing: border-box; width: 100%; min-height: 38px; margin-top: 7px; padding: 7px 9px; color: inherit; background: #303030; border: 1px solid #666; border-radius: 5px; }
.playlist-list { margin-top: 12px; overflow: auto; }
.playlist-group { border-bottom: 1px solid #404040; }
.playlist-heading { display: flex; align-items: center; min-height: 42px; }
.playlist-heading > label { display: flex; flex: 1; align-items: center; gap: 8px; min-width: 0; }
.expand-button { width: 32px; height: 32px; border: 0; color: inherit; background: transparent; }
.search-expanded { display: inline-grid; flex: 0 0 32px; place-items: center; }
.muted, .work-size, .hint { color: #bbb; font-size: .82rem; }
.muted { margin-left: auto; }
.work-list { padding: 0 0 8px 34px; }
.work-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; gap: 8px; padding: 6px 4px; }
.work-size { white-space: nowrap; }
.ungrouped-works { padding-left: 34px; }
.empty-state { padding: 24px 8px; text-align: center; color: #bbb; }
.download-options { display: flex; flex-direction: column; gap: 14px; }
fieldset { display: flex; flex-direction: column; gap: 7px; margin: 0; padding: 10px 12px; border: 1px solid #555; border-radius: 6px; }
fieldset .hint { margin: -4px 0 3px 23px; }
.stacked-option { display: block; }
.hint { margin: -9px 0 0 23px; line-height: 1.35; }
.dialog-footer { flex-wrap: wrap; border-top: 1px solid #444; }
.selection-summary { margin: 0; }
.footer-actions { display: flex; gap: 10px; margin-left: auto; }
button { min-height: 38px; padding: 7px 14px; cursor: pointer; color: inherit; background: #393939; border: 1px solid #666; border-radius: 5px; }
button.primary { color: #111; background: #ffca28; border-color: #ffca28; font-weight: 700; }
button:disabled { cursor: not-allowed; opacity: .5; }
button:focus-visible, input:focus-visible, select:focus-visible { outline: 3px solid #6cb6ff; outline-offset: 2px; }

@media (max-width: 680px) {
    .backup-downloader-backdrop { align-items: stretch; padding: 0; }
    .backup-downloader { max-height: 100vh; border-radius: 0; }
    .dialog-body { display: block; overflow: auto; }
    .work-picker, .download-options { overflow: visible; }
    .work-picker { border-right: 0; border-bottom: 1px solid #444; }
    .playlist-list { max-height: 42vh; }
    .dialog-footer { align-items: stretch; }
    .footer-actions { width: 100%; margin-left: 0; }
    .footer-actions button { flex: 1; }
}
</style>
