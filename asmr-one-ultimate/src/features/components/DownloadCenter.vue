<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { WorksApi } from '../../api';
import type { PlaylistEntry } from '../../api/Playlist';
import { useI18n } from '../../composables/useI18n';
import { Logger } from '../../core/Utils';
import { buildCoverUrl } from '../../types/api';
import { fetchOwnPlaylistEntries, fetchPlaylistAsExported, type ExportedWork } from '../EmergencyExport';
import type {
    BackupDownloadProfile,
    BackupDownloadProgress,
    BackupDownloadState,
    BackupPlaylistDownloadItem,
    BackupPlaylistSourceFilter,
    BackupWorkDownloadItem,
} from '../backupWorkDownloaderTypes';
import { chooseDownloadDirectory } from '../downloads/DirectoryDownloadSink';
import {
    DownloadCenterRunError,
    DownloadCenterRunner,
    type DownloadCenterJob,
} from '../downloads/DownloadCenterRunner';
import { fetchCachedCommunityPlaylist } from '../playlist/CommunityPlaylistDetailsService';
import { PlaylistDiscoveryService } from '../playlist/PlaylistDiscoveryService';
import { getAuthHeader } from '../playlist/PlaylistService';
import type { CommunityPlaylistSummary } from '../playlist/types';
import { semanticWorkSearch } from '../SemanticWorkSearchService';
import BackupWorkDownloader from './BackupWorkDownloader.vue';

const { t, format } = useI18n();
const visible = ref(false);
const playlists = ref<BackupPlaylistDownloadItem[]>([]);
const works = ref<BackupWorkDownloadItem[]>([]);
const loadingOwn = ref(false);
const loadingPublic = ref(false);
const ownLoaded = ref(false);
const publicRequested = ref(false);
const ownLoadFailed = ref(false);
const publicLoadFailed = ref(false);
const signedIn = ref(false);
const jobError = ref('');
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
    estimatedOpusSize: t('backupDownloaderEstimatedOpusSize'),
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

function readHttpStatus(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const candidate = error as { status?: unknown; response?: { status?: unknown }; message?: unknown };
    if (typeof candidate.status === 'number') return candidate.status;
    if (typeof candidate.response?.status === 'number') return candidate.response.status;
    if (typeof candidate.message === 'string') {
        const match = candidate.message.match(/\bHTTP\s+(\d{3})\b/i);
        if (match) return Number(match[1]);
    }
    return undefined;
}

async function loadOwn(): Promise<void> {
    if (ownLoaded.value || loadingOwn.value) return;
    loadingOwn.value = true;
    ownLoadFailed.value = false;
    try {
        const entries = await fetchOwnPlaylistEntries();
        ownSeeds.clear();
        for (const entry of entries) ownSeeds.set(String(entry.id), entry);
        setSourcePlaylists('own', entries.map(mapOwn));
        ownLoaded.value = true;
    } catch (error) {
        Logger.warn('[DownloadCenter] Could not load personal playlists', error);
        const status = readHttpStatus(error);
        if (status === 401 || status === 403) {
            signedIn.value = false;
            ownLoadFailed.value = false;
            setSourcePlaylists('own', []);
            void loadCommunity();
        } else {
            ownLoadFailed.value = true;
        }
    } finally {
        loadingOwn.value = false;
    }
}

function hasAuthenticatedSession(): boolean {
    return Boolean(getAuthHeader().Authorization);
}

async function loadCommunity(): Promise<void> {
    if (publicRequested.value || loadingPublic.value) return;
    publicRequested.value = true;
    loadingPublic.value = true;
    publicLoadFailed.value = false;
    try {
        setSourcePlaylists('public', (await discoveryService.loadCommunityCatalog()).map(mapCommunity));
    } catch (error) {
        Logger.warn('[DownloadCenter] Could not refresh community catalog', error);
        publicRequested.value = false;
        publicLoadFailed.value = true;
    } finally {
        loadingPublic.value = false;
    }
}

function open(): void {
    // Visibility is synchronous. Network and IndexedDB work only starts after
    // the modal is already available to the user.
    visible.value = true;
    signedIn.value = hasAuthenticatedSession();
    if (signedIn.value) void loadOwn();
    else void loadCommunity();
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
            let resolvedWorks: ExportedWork[];
            let resolvedWorksCount: number;
            let resolvedError: string | undefined;
            if (playlist.source === 'public') {
                try {
                    const cached = await fetchCachedCommunityPlaylist(String(playlist.id));
                    if (playlist.worksCount != null && cached.works.length < playlist.worksCount) {
                        throw new Error(`Shared playlist details are incomplete (${cached.works.length}/${playlist.worksCount})`);
                    }
                    resolvedWorks = cached.works;
                    resolvedWorksCount = cached.works.length;
                } catch (error) {
                    Logger.debug('[DownloadCenter] Shared playlist details unavailable; using live API', playlist.id, error);
                    const exported = await fetchPlaylistAsExported(String(playlist.id));
                    resolvedWorks = exported.works;
                    resolvedWorksCount = exported.worksCount;
                    resolvedError = exported.error;
                }
            } else {
                const exported = await fetchPlaylistAsExported(String(playlist.id), seed);
                resolvedWorks = exported.works;
                resolvedWorksCount = exported.worksCount;
                resolvedError = exported.error;
            }
            const ids: string[] = [];
            const nextWorks = new Map(works.value.map(work => [String(work.id), { ...work }]));
            for (const item of resolvedWorks) {
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
                    sizeBytes: item.sizeBytes ?? current?.sizeBytes,
                    durationSeconds: item.durationSeconds ?? current?.durationSeconds,
                    playlistIds: [...playlistIds],
                });
            }
            works.value = [...nextWorks.values()];
            playlists.value = playlists.value.map(item => item.source === playlist.source && String(item.id) === String(playlist.id)
                ? { ...item, workIds: ids, worksCount: Math.max(playlist.worksCount ?? 0, resolvedWorksCount, ids.length), error: resolvedError }
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

function normalizeWorkId(value: unknown): string {
    const sourceText = String(value ?? '').trim();
    if (/^[A-Za-z]{2}\d+$/.test(sourceText)) return sourceText.toUpperCase();
    if (/^\d+$/.test(sourceText)) return `RJ${sourceText.padStart(6, '0')}`;
    return sourceText;
}

function mergeDirectWork(
    target: Map<string, BackupWorkDownloadItem>,
    result: Record<string, unknown>,
    fallbackTitle = '',
): void {
    const id = normalizeWorkId(result.source_id ?? result.sourceId ?? result.id);
    if (!id) return;
    const current = target.get(id);
    const sizeBytes = [result.sizeBytes, result.size, result.file_size, result.filesize, result.total_size]
        .map(Number).find(value => Number.isSafeInteger(value) && value > 0);
    const durationSeconds = [result.durationSeconds, result.duration]
        .map(Number).find(value => Number.isFinite(value) && value > 0);
    target.set(id, {
        ...current,
        id,
        title: (typeof result.title === 'string' && result.title) || fallbackTitle || current?.title || id,
        sizeBytes: sizeBytes ?? current?.sizeBytes,
        durationSeconds: durationSeconds ?? current?.durationSeconds,
        playlistIds: current?.playlistIds,
        directSearchResult: true,
    });
}

async function searchAllWorks(query: string): Promise<void> {
    const merged = new Map(works.value.map(work => [String(work.id), { ...work, directSearchResult: false }]));
    const exactRj = /^[A-Za-z]{2}\d+$/.test(query.trim());
    const [semantic, live] = await Promise.allSettled([
        exactRj ? Promise.resolve([]) : semanticWorkSearch(query),
        WorksApi.searchWorks(query, { page: 1 }),
    ]);
    if (semantic.status === 'fulfilled') {
        for (const result of semantic.value) mergeDirectWork(merged, result as unknown as Record<string, unknown>, result.title);
    } else {
        Logger.warn('[DownloadCenter] Hosted semantic work search unavailable', semantic.reason);
    }
    if (live.status === 'fulfilled') {
        for (const result of live.value.works) mergeDirectWork(merged, result as unknown as Record<string, unknown>);
    } else {
        Logger.warn('[DownloadCenter] Live work search unavailable', live.reason);
    }
    if ((exactRj && live.status === 'rejected') || (semantic.status === 'rejected' && live.status === 'rejected')) {
        throw live.status === 'rejected' ? live.reason : semantic.reason;
    }
    works.value = [...merged.values()];
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
    jobError.value = '';
    if (typeof (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker !== 'function') {
        progress.value = null;
        jobError.value = t('backupDownloaderUnsupported');
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
        progress.value = {
            ...(progress.value ?? { current: 1, total: 1 }),
            phase: 'complete',
            label: result.skipped ? format('backupDownloaderDoneWithSkipped', { count: result.skipped }) : t('backupDownloaderDone'),
        };
    } catch (error) {
        await rememberSettledJob(activeJobId);
        if (error instanceof DownloadCenterRunError && error.code === 'paused') {
            if (progress.value) progress.value = { ...progress.value, phase: 'paused' };
        } else {
            jobError.value = friendlyError(error);
            if (progress.value) progress.value = { ...progress.value, phase: 'failed' };
        }
    } finally {
        busy.value = false;
    }
}

async function resumeDownload(jobId: string): Promise<void> {
    const job = resumableJobs.value.find(item => item.id === jobId);
    if (!job || busy.value) return;
    jobError.value = '';
    busy.value = true;
    try {
        const result = await runner.resume(job, setRunnerProgress);
        resumableJobs.value = resumableJobs.value.filter(item => item.id !== jobId);
        progress.value = {
            ...(progress.value ?? { current: 1, total: 1 }),
            phase: 'complete',
            label: result.skipped ? format('backupDownloaderDoneWithSkipped', { count: result.skipped }) : t('backupDownloaderDone'),
        };
    } catch (error) {
        if (error instanceof DownloadCenterRunError && error.code === 'paused') {
            if (progress.value) progress.value = { ...progress.value, phase: 'paused' };
        } else {
            jobError.value = friendlyError(error);
            if (progress.value) progress.value = { ...progress.value, phase: 'failed' };
        }
    } finally {
        busy.value = false;
    }
}

async function pauseDownload(): Promise<void> {
    await runner.pause();
    if (progress.value) progress.value = { ...progress.value, phase: 'paused' };
}

onMounted(() => {
    setSourcePlaylists('public', discoveryService.getCachedCommunityCatalog().map(mapCommunity));
    unsubscribeRunner = runner.subscribe((next, running) => {
        busy.value = running;
        if (next) {
            progress.value = next;
            if (next.phase !== 'failed') jobError.value = '';
        }
        if (!running) void refreshResumableJobs();
    });
    void refreshResumableJobs();
});
onUnmounted(() => { unsubscribeRunner?.(); });

defineExpose({ open });
</script>

<template>
    <button class="q-btn q-btn-flat q-btn-dense asmr-download-center-btn text-white" data-testid="download-center-open" :title="t('downloadCenterButton')" :aria-label="t('downloadCenterButton')" @click="open"><span class="q-btn__content"><i class="q-icon material-icons" aria-hidden="true">download_for_offline</i></span></button>
    <Teleport to="body">
        <BackupWorkDownloader v-if="visible" :playlists="playlists" :works="works" :profile="profile" :show-own="signedIn" :loading-own="loadingOwn" :loading-public="loadingPublic" :own-load-failed="ownLoadFailed" :public-load-failed="publicLoadFailed" :busy="busy" :progress="displayProgress" :error-message="jobError" :resumable-jobs="resumableJobs.map(job => ({ id: job.id, title: job.title }))" :resolve-playlist="resolvePlaylist" :search-all-works="searchAllWorks" @close="visible = false" @source-change="source => { if (source === 'public') void loadCommunity(); else if (signedIn) void loadOwn(); }" @update="updateProfile" @start="startDownload" @pause="pauseDownload" @resume="resumeDownload" />
    </Teleport>
</template>
