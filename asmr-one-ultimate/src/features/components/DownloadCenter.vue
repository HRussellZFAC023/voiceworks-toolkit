<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { WorksApi } from '../../api';
import type { PlaylistEntry } from '../../api/Playlist';
import { useI18n } from '../../composables/useI18n';
import { Logger } from '../../core/Utils';
import { buildCoverUrl } from '../../types/api';
import { fetchOwnPlaylistEntries, fetchPlaylistAsExported, type EmergencyExportDocument } from '../EmergencyExport';
import type {
    BackupDownloadProfile,
    BackupDownloadProgress,
    BackupDownloadState,
    BackupPlaylistDownloadItem,
    BackupPlaylistSourceFilter,
    BackupWorkDownloadItem,
} from '../backupWorkDownloaderTypes';
import { mapBackupPlaylistSources } from '../backupWorkDownloaderUtils';
import { chooseDownloadDirectory } from '../downloads/DirectoryDownloadSink';
import {
    DownloadCenterRunError,
    DownloadCenterRunner,
    type DownloadCenterJob,
} from '../downloads/DownloadCenterRunner';
import { PlaylistDiscoveryService } from '../playlist/PlaylistDiscoveryService';
import type { CommunityPlaylistSummary } from '../playlist/types';
import BackupWorkDownloader from './BackupWorkDownloader.vue';

const { t, format } = useI18n();
const visible = ref(false);
const playlists = ref<BackupPlaylistDownloadItem[]>([]);
const works = ref<BackupWorkDownloadItem[]>([]);
const loadingOwn = ref(false);
const loadingPublic = ref(false);
const ownLoaded = ref(false);
const publicRequested = ref(false);
const runner = DownloadCenterRunner.getInstance();
const busy = ref(runner.isRunning);
const progress = ref<(BackupDownloadProgress & { jobId?: string }) | null>(runner.progress);
const resumableJobs = ref<DownloadCenterJob[]>([]);
const discoveryService = PlaylistDiscoveryService.getInstance();
const ownSeeds = new Map<string, PlaylistEntry>();
const resolving = new Map<string, Promise<void>>();
let unsubscribeRunner: (() => void) | undefined;

const options = ref<Omit<BackupDownloadProfile, 'labels'>>({
    selectedWorkIds: [],
    filters: { audio: true, video: false, image: true, text: true, other: false },
    titleMode: 'original-bracketed-translation',
    convertToOpus: false,
    opusBitrate: 96,
    metadataMode: 'additive',
    includeArtwork: true,
});

const labels = computed(() => ({
    dialogTitle: t('backupDownloaderTitle'),
    close: t('backupDownloaderClose'),
    search: t('backupDownloaderSearch'),
    searchPlaceholder: t('backupDownloaderSearchPlaceholder'),
    searchAll: t('downloadCenterSearchAll'),
    searchAllLoading: t('downloadCenterSearchAllLoading'),
    searchResults: t('downloadCenterSearchResults'),
    searchFailed: t('downloadCenterSearchFailed'),
    importBackup: t('downloadCenterImportBackup'),
    importBackupInvalid: t('backupDownloaderInvalid'),
    playlistSource: t('backupDownloaderSource'),
    sourceAll: t('backupDownloaderSourceAll'),
    sourceOwn: t('backupDownloaderSourceOwn'),
    sourcePublic: t('backupDownloaderSourcePublic'),
    selectAll: t('downloadCenterSelectAll'),
    clearAll: t('downloadCenterClearAll'),
    filterTags: t('downloadCenterFilterTags'),
    allTags: t('downloadCenterAllTags'),
    playlistOwner: t('downloadCenterOwner'),
    playlistWorks: t('downloadCenterWorks'),
    loading: t('downloadCenterLoading'),
    loadFailed: t('downloadCenterLoadFailed'),
    options: t('downloadCenterOptions'),
    progress: t('downloadCenterProgress'),
    pause: t('downloadCenterPause'),
    resume: t('downloadCenterResume'),
    alreadyRunning: t('downloadCenterAlreadyRunning'),
    resumableDownloads: t('backupDownloaderResumeAvailable'),
    expandPlaylist: t('backupDownloaderExpand'),
    collapsePlaylist: t('backupDownloaderCollapse'),
    selectedSummary: t('backupDownloaderSelected'),
    unknownSize: t('backupDownloaderUnknownSize'),
    noResults: t('backupDownloaderNoResults'),
    fileTypes: t('backupDownloaderFileTypes'),
    audio: t('backupDownloaderAudio'),
    video: t('backupDownloaderVideo'),
    images: t('backupDownloaderImages'),
    text: t('backupDownloaderText'),
    other: t('backupDownloaderOther'),
    filenameTitle: t('backupDownloaderFilename'),
    titleOriginal: t('backupDownloaderTitleOriginal'),
    titleTranslated: t('backupDownloaderTitleTranslated'),
    titleOriginalTranslated: t('backupDownloaderTitleBoth'),
    titleNone: t('backupDownloaderTitleNone'),
    convertToOpus: t('backupDownloaderOpus'),
    opusBitrate: t('backupDownloaderBitrate'),
    metadata: t('backupDownloaderMetadata'),
    metadataAdditive: t('backupDownloaderMetadataAdditive'),
    metadataOverwrite: t('backupDownloaderOverwrite'),
    metadataAdditiveHint: t('backupDownloaderAdditiveHint'),
    metadataOverwriteHint: t('backupDownloaderOverwriteHint'),
    includeArtwork: t('backupDownloaderArtwork'),
    includeArtworkHint: t('backupDownloaderArtworkHint'),
    cancel: t('backupDownloaderCancel'),
    start: t('backupDownloaderStart'),
}));

const profile = computed<BackupDownloadProfile>(() => ({ ...options.value, labels: labels.value }));
const displayProgress = computed<BackupDownloadProgress | null>(() => {
    if (!progress.value) return null;
    const phaseKey: Record<BackupDownloadProgress['phase'], string> = {
        recovering: 'downloadCenterRecovering',
        discovering: 'backupDownloaderDiscovering',
        translating: 'backupDownloaderTranslatingTitles',
        downloading: 'downloadCenterDownloading',
        converting: 'downloadCenterConverting',
        paused: 'downloadCenterPaused',
        complete: 'backupDownloaderDone',
        failed: 'backupDownloaderFailed',
    };
    const conversionPercent = progress.value.phase === 'converting' && progress.value.conversionRatio != null
        ? ` ${Math.round(progress.value.conversionRatio * 100)}%`
        : '';
    const phase = `${t(phaseKey[progress.value.phase])}${conversionPercent}`;
    return { ...progress.value, label: progress.value.label ? `${phase} — ${progress.value.label}` : phase };
});

function mapCommunity(summary: CommunityPlaylistSummary): BackupPlaylistDownloadItem {
    return {
        id: summary.id,
        title: summary.name,
        source: 'public',
        owner: summary.userName,
        worksCount: summary.worksCount,
        coverUrl: summary.coverUrl,
        tags: [...summary.tags],
    };
}

function setSourcePlaylists(source: BackupPlaylistSourceFilter, items: BackupPlaylistDownloadItem[]): void {
    const existing = new Map(playlists.value
        .filter(playlist => playlist.source === source)
        .map(playlist => [String(playlist.id), playlist]));
    playlists.value = [
        ...playlists.value.filter(playlist => playlist.source !== source),
        ...items.map(item => {
            const previous = existing.get(String(item.id));
            return previous?.workIds ? { ...item, workIds: previous.workIds, error: previous.error } : item;
        }),
    ];
}

function mapOwn(entry: PlaylistEntry): BackupPlaylistDownloadItem {
    const firstWork = entry.works?.[0];
    return {
        id: entry.id,
        title: entry.name,
        source: 'own',
        owner: entry.user_name,
        worksCount: entry.works_count ?? entry.worksCount ?? entry.works?.length ?? 0,
        coverUrl: firstWork ? buildCoverUrl(firstWork, '240x240') : '',
    };
}

async function loadOwn(): Promise<void> {
    if (ownLoaded.value || loadingOwn.value) return;
    loadingOwn.value = true;
    try {
        const entries = await fetchOwnPlaylistEntries();
        ownSeeds.clear();
        for (const entry of entries) ownSeeds.set(String(entry.id), entry);
        setSourcePlaylists('own', entries.map(mapOwn));
        ownLoaded.value = true;
    } catch (error) {
        Logger.warn('[DownloadCenter] Could not load personal playlists', error);
        progress.value = { phase: 'failed', current: 0, total: 0 };
    } finally {
        loadingOwn.value = false;
    }
}

async function loadCommunity(): Promise<void> {
    if (publicRequested.value || loadingPublic.value) return;
    publicRequested.value = true;
    loadingPublic.value = true;
    try {
        setSourcePlaylists('public', (await discoveryService.loadCommunityCatalog()).map(mapCommunity));
    } catch (error) {
        Logger.warn('[DownloadCenter] Could not refresh community catalog', error);
        publicRequested.value = false;
    } finally {
        loadingPublic.value = false;
    }
}

function open(): void {
    // Visibility is synchronous. Network and IndexedDB work only starts after
    // the modal is already available to the user.
    visible.value = true;
    void loadOwn();
    void refreshResumableJobs();
}

function updateProfile(state: BackupDownloadState): void {
    options.value = { ...state };
}

async function resolvePlaylist(playlist: BackupPlaylistDownloadItem): Promise<void> {
    const key = `${playlist.source}:${playlist.id}`;
    const existing = resolving.get(key);
    if (existing) return existing;
    const request = (async () => {
        playlists.value = playlists.value.map(item => item.source === playlist.source && String(item.id) === String(playlist.id)
            ? { ...item, error: undefined }
            : item);
        const seed = playlist.source === 'own' ? ownSeeds.get(String(playlist.id)) : undefined;
        try {
            const exported = await fetchPlaylistAsExported(String(playlist.id), seed);
            const ids: string[] = [];
            const nextWorks = new Map(works.value.map(work => [String(work.id), { ...work }]));
            for (const item of exported.works) {
                const id = String(item.rjCode);
                if (!id) continue;
                ids.push(id);
                const current = nextWorks.get(id);
                const playlistIds = new Set((current?.playlistIds ?? []).map(String));
                playlistIds.add(String(playlist.id));
                nextWorks.set(id, {
                    ...current,
                    id,
                    title: item.title || current?.title || id,
                    playlistIds: [...playlistIds],
                });
            }
            works.value = [...nextWorks.values()];
            playlists.value = playlists.value.map(item => item.source === playlist.source && String(item.id) === String(playlist.id)
                ? { ...item, workIds: ids, worksCount: Math.max(exported.worksCount, ids.length), error: exported.error }
                : item);
        } catch (error) {
            Logger.warn('[DownloadCenter] Could not resolve playlist', playlist.id, error);
            playlists.value = playlists.value.map(item => item.source === playlist.source && String(item.id) === String(playlist.id)
                ? { ...item, workIds: undefined, error: 'unavailable' }
                : item);
        }
    })().finally(() => { resolving.delete(key); });
    resolving.set(key, request);
    return request;
}

async function searchAllWorks(query: string): Promise<void> {
    const response = await WorksApi.searchWorks(query, { page: 1 });
    const existing = new Map(works.value.map(work => [String(work.id), work]));
    for (const result of response.works) {
        const sourceId = result.source_id ?? result.sourceId ?? result.id;
        const sourceText = String(sourceId).trim();
        const id = /^[A-Za-z]{2}\d+$/.test(sourceText)
            ? sourceText.toUpperCase()
            : (/^\d+$/.test(sourceText) ? `RJ${sourceText.padStart(6, '0')}` : sourceText);
        if (!id) continue;
        const current = existing.get(id);
        existing.set(id, {
            ...current,
            id,
            title: result.title || current?.title || id,
            playlistIds: current?.playlistIds,
            directSearchResult: true,
        });
    }
    works.value = [...existing.values()];
}

function isEmergencyExportDocument(value: unknown): value is EmergencyExportDocument {
    if (!value || typeof value !== 'object') return false;
    const document = value as Partial<EmergencyExportDocument>;
    if (document.format !== 'asmr-one-ultimate-playlist-backup' || document.version !== 1
        || !Array.isArray(document.ownPlaylists) || !Array.isArray(document.publicPlaylists)) return false;
    return [...document.ownPlaylists, ...document.publicPlaylists].every(playlist =>
        playlist && (typeof playlist.id === 'string' || typeof playlist.id === 'number')
        && typeof playlist.name === 'string' && Array.isArray(playlist.works)
        && playlist.works.every(work => work && typeof work.rjCode === 'string' && typeof work.title === 'string'));
}

async function readBackupText(file: File): Promise<string> {
    if (typeof file.text === 'function') return file.text();
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(reader.error ?? new Error('Could not read backup'));
        reader.readAsText(file);
    });
}

async function importBackup(file: File): Promise<void> {
    try {
        if (file.size > 64 * 1024 * 1024) throw new Error('Backup exceeds the import limit');
        const document = JSON.parse(await readBackupText(file)) as unknown;
        if (!isEmergencyExportDocument(document)) throw new Error('Invalid backup');
        const mapped = mapBackupPlaylistSources(document);
        const playlistMap = new Map(playlists.value.map(item => [`${item.source}:${String(item.id)}`, item]));
        for (const item of mapped.playlists) {
            const key = `${item.source}:${String(item.id)}`;
            const current = playlistMap.get(key);
            playlistMap.set(key, { ...current, ...item, coverUrl: current?.coverUrl, owner: current?.owner, tags: current?.tags });
        }
        playlists.value = [...playlistMap.values()];
        const workMap = new Map(works.value.map(item => [String(item.id), item]));
        for (const item of mapped.works) {
            const current = workMap.get(String(item.id));
            workMap.set(String(item.id), {
                ...current,
                ...item,
                title: item.title || current?.title || String(item.id),
                playlistIds: [...new Set([...(current?.playlistIds ?? []), ...(item.playlistIds ?? [])].map(String))],
                directSearchResult: current?.directSearchResult,
            });
        }
        works.value = [...workMap.values()];
    } catch (error) {
        Logger.warn('[DownloadCenter] Invalid saved backup import', error);
        progress.value = { phase: 'failed', current: 0, total: 0, label: t('backupDownloaderInvalid') };
    }
}

function setRunnerProgress(next: BackupDownloadProgress & { jobId?: string }): void {
    progress.value = next;
}

function friendlyError(error: unknown): string {
    if (error instanceof DownloadCenterRunError) {
        if (error.code === 'unsupported') return t('backupDownloaderUnsupported');
        if (error.code === 'permission') return t('backupDownloaderPermission');
        if (error.code === 'no-files') return t('backupDownloaderNoFiles');
        if (error.code === 'paused') return t('downloadCenterPaused');
        if (error.code === 'already-running') return t('downloadCenterAlreadyRunning');
    }
    return t('backupDownloaderFailed');
}

async function rememberSettledJob(jobId?: string): Promise<void> {
    if (!jobId) return;
    const job = await runner.loadSettledJob(jobId);
    if (job && job.status !== 'completed' && job.status !== 'cancelled' && !resumableJobs.value.some(item => item.id === job.id)) {
        resumableJobs.value = [...resumableJobs.value, job];
    }
}

async function refreshResumableJobs(): Promise<void> {
    try { resumableJobs.value = await runner.recoverInterruptedJobs(); }
    catch (error) { Logger.warn('[DownloadCenter] Could not recover interrupted downloads', error); }
}

async function startDownload(state: BackupDownloadState): Promise<void> {
    if (busy.value) return;
    if (typeof (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker !== 'function') {
        progress.value = { phase: 'failed', current: 0, total: 0, label: t('backupDownloaderUnsupported') };
        return;
    }
    let directory: FileSystemDirectoryHandle;
    try { directory = await chooseDownloadDirectory(); }
    catch { return; }
    busy.value = true;
    progress.value = { phase: 'discovering', current: 0, total: state.selectedWorkIds.length };
    let activeJobId: string | undefined;
    try {
        const result = await runner.start(
            works.value,
            state,
            directory,
            format('backupDownloaderJobTitle', { date: new Date().toLocaleString() }),
            next => { activeJobId = next.jobId ?? activeJobId; setRunnerProgress(next); },
        );
        resumableJobs.value = resumableJobs.value.filter(job => job.id !== result.jobId);
        progress.value = { phase: 'complete', current: 1, total: 1, label: result.skipped ? format('backupDownloaderDoneWithSkipped', { count: result.skipped }) : t('backupDownloaderDone') };
    } catch (error) {
        await rememberSettledJob(activeJobId);
        progress.value = error instanceof DownloadCenterRunError && error.code === 'paused'
            ? { phase: 'paused', current: progress.value?.current ?? 0, total: progress.value?.total ?? 0 }
            : { phase: 'failed', current: 0, total: 1, label: friendlyError(error) };
    } finally {
        busy.value = false;
    }
}

async function resumeDownload(jobId: string): Promise<void> {
    const job = resumableJobs.value.find(item => item.id === jobId);
    if (!job || busy.value) return;
    busy.value = true;
    try {
        const result = await runner.resume(job, setRunnerProgress);
        resumableJobs.value = resumableJobs.value.filter(item => item.id !== jobId);
        progress.value = { phase: 'complete', current: 1, total: 1, label: result.skipped ? format('backupDownloaderDoneWithSkipped', { count: result.skipped }) : t('backupDownloaderDone') };
    } catch (error) {
        progress.value = error instanceof DownloadCenterRunError && error.code === 'paused'
            ? { phase: 'paused', current: progress.value?.current ?? 0, total: progress.value?.total ?? 0 }
            : { phase: 'failed', current: 0, total: 1, label: friendlyError(error) };
    } finally {
        busy.value = false;
    }
}

async function pauseDownload(): Promise<void> {
    await runner.pause();
    progress.value = { ...(progress.value ?? { current: 0, total: 0 }), phase: 'paused' };
}

onMounted(() => {
    setSourcePlaylists('public', discoveryService.getCachedCommunityCatalog().map(mapCommunity));
    unsubscribeRunner = runner.subscribe((next, running) => {
        busy.value = running;
        if (next) progress.value = next;
        if (!running) void refreshResumableJobs();
    });
    void refreshResumableJobs();
});
onUnmounted(() => { unsubscribeRunner?.(); });

defineExpose({ open });
</script>

<template>
    <button class="q-btn q-btn-flat q-btn-dense asmr-vector-btn asmr-download-center-btn text-white" data-testid="download-center-open" :title="t('downloadCenterButton')" :aria-label="t('downloadCenterButton')" @click="open"><span class="q-btn__content"><i class="q-icon material-icons" aria-hidden="true">download_for_offline</i></span></button>
    <Teleport to="body">
        <BackupWorkDownloader v-if="visible" :playlists="playlists" :works="works" :profile="profile" :loading-own="loadingOwn" :loading-public="loadingPublic" :busy="busy" :progress="displayProgress" :resumable-jobs="resumableJobs.map(job => ({ id: job.id, title: job.title }))" :resolve-playlist="resolvePlaylist" :search-all-works="searchAllWorks" @close="visible = false" @source-change="source => { if (source === 'public') void loadCommunity(); else void loadOwn(); }" @update="updateProfile" @start="startDownload" @pause="pauseDownload" @resume="resumeDownload" @import-backup="importBackup" />
    </Teleport>
</template>
