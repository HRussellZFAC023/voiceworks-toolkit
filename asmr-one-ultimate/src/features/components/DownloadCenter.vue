<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { WorksApi } from '../../api';
import type { PlaylistEntry } from '../../api/Playlist';
import { useI18n } from '../../composables/useI18n';
import { Logger } from '../../core/Utils';
import { WorkService } from '../../services/WorkService';
import { buildCoverUrl } from '../../types/api';
import { fetchOwnPlaylistEntries, fetchPlaylistAsExported, type ExportedWork } from '../EmergencyExport';
import type {
    BackupDownloadProfile,
    BackupDownloadProgress,
    BackupDownloadState,
    BackupFileFilter,
    BackupPlaylistDownloadItem,
    BackupPlaylistSource,
    BackupPlaylistSourceFilter,
    BackupWorkDownloadItem,
} from '../backupWorkDownloaderTypes';
import { discoverDownloadManifest, type DownloadTreeNode } from '../downloads/DownloadManifest';
import { chooseDownloadDirectory } from '../downloads/DirectoryDownloadSink';
import {
    DownloadCenterRunError,
    DownloadCenterRunner,
    type DownloadCenterJob,
} from '../downloads/DownloadCenterRunner';
import { fetchCachedCommunityPlaylist } from '../playlist/CommunityPlaylistDetailsService';
import { PlaylistDiscoveryService } from '../playlist/PlaylistDiscoveryService';
import { getApiBaseUrl, getAuthHeader } from '../playlist/PlaylistService';
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
const enrichingWorks = new Map<string, Promise<void>>();
let unsubscribeRunner: (() => void) | undefined;
let enrichmentGeneration = 0;
const DOWNLOAD_CENTER_LIVE_SEARCH_WAIT_MS = 30_000;
const DOWNLOAD_CENTER_SEMANTIC_SEARCH_WAIT_MS = 30_000;

function withSearchDeadline<T>(request: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error(`${label} timed out`));
        }, timeoutMs);
        void request.then(
            value => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            },
            error => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

type SearchOutcome<T> =
    | { status: 'fulfilled'; value: T }
    | { status: 'rejected'; reason: unknown };

function settleSearch<T>(request: Promise<T>): Promise<SearchOutcome<T>> {
    return request.then(
        value => ({ status: 'fulfilled', value }),
        reason => ({ status: 'rejected', reason }),
    );
}

const options = ref<Omit<BackupDownloadProfile, 'labels'>>({
    selectedWorkIds: [],
    // "Complete works" means every manifest leaf by default. Users can opt
    // out of bulky categories explicitly when storage is the priority.
    filters: { audio: true, video: true, image: true, text: true, other: true },
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
    resumeWithoutOpus: t('downloadCenterResumeWithoutOpus'),
    alreadyRunning: t('downloadCenterAlreadyRunning'),
    resumableDownloads: t('backupDownloaderResumeAvailable'),
    expandPlaylist: t('backupDownloaderExpand'),
    collapsePlaylist: t('backupDownloaderCollapse'),
    selectedSummary: t('backupDownloaderSelected'),
    unknownSize: t('backupDownloaderUnknownSize'),
    partialSize: t('backupDownloaderPartialSize'),
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
    convertToOpusMemoryWarning: t('backupDownloaderOpusMemoryWarning'),
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

function setSourcePlaylists(source: BackupPlaylistSource, items: BackupPlaylistDownloadItem[]): void {
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
    enrichmentGeneration += 1;
    void refreshResumableJobs();
}

function close(): void {
    visible.value = false;
    enrichmentGeneration += 1;
}

function handleSourceChange(source: BackupPlaylistSourceFilter): void {
    enrichmentGeneration += 1;
    if (source === 'public') void loadCommunity();
    else if (source === 'own' && signedIn.value) void loadOwn();
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
                    coverUrl: current?.coverUrl || buildCoverUrl(id, '240x240', getApiBaseUrl()),
                    sizeBytes: item.sizeBytes ?? current?.sizeBytes,
                    sizeState: item.sizeBytes ? 'resolved' : current?.sizeState ?? 'loading',
                    durationSeconds: item.durationSeconds ?? current?.durationSeconds,
                    playlistIds: [...playlistIds],
                });
            }
            works.value = [...nextWorks.values()];
            void enrichWorkItems(ids, enrichmentGeneration);
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
    previous?: ReadonlyMap<string, BackupWorkDownloadItem>,
): void {
    const id = normalizeWorkId(result.source_id ?? result.sourceId ?? result.id);
    if (!id) return;
    const current = target.get(id) ?? previous?.get(id);
    const sizeBytes = [result.sizeBytes, result.size, result.file_size, result.filesize, result.total_size]
        .map(Number).find(value => Number.isSafeInteger(value) && value > 0);
    const durationSeconds = [result.durationSeconds, result.duration]
        .map(Number).find(value => Number.isFinite(value) && value > 0);
    const coverUrl = [result.thumbnailCoverUrl, result.samCoverUrl, result.mainCoverUrl, result.coverUrl, result.cover]
        .find(value => typeof value === 'string' && value.trim()) as string | undefined;
    const tags = Array.isArray(result.tags)
        ? result.tags.map(tag => typeof tag === 'string'
            ? tag
            : tag && typeof tag === 'object' && 'name' in tag ? String((tag as { name?: unknown }).name ?? '') : '')
            .filter(Boolean)
        : current?.tags;
    target.set(id, {
        ...current,
        id,
        title: (typeof result.title === 'string' && result.title) || fallbackTitle || current?.title || id,
        coverUrl: coverUrl || current?.coverUrl || buildCoverUrl(id, '240x240', getApiBaseUrl()),
        sizeBytes: sizeBytes ?? current?.sizeBytes,
        sizeState: sizeBytes ? 'resolved' : current?.sizeState ?? 'loading',
        durationSeconds: durationSeconds ?? current?.durationSeconds,
        tags,
        playlistIds: current?.playlistIds,
        directSearchResult: true,
    });
}

function updateWork(id: string, update: Partial<BackupWorkDownloadItem>): void {
    works.value = works.value.map(work => String(work.id) === id ? { ...work, ...update } : work);
}

async function enrichWorkItem(id: string, generation: number): Promise<void> {
    if (!visible.value || generation !== enrichmentGeneration) return;
    const key = `${generation}:${id}`;
    const existing = enrichingWorks.get(key);
    if (existing) return existing;
    const request = (async () => {
        const work = works.value.find(item => String(item.id) === id);
        if (!work) return;
        if (work.sizeBytesByType && work.durationSeconds != null && work.coverUrl) {
            return;
        }
        updateWork(id, {
            sizeState: work.sizeState === 'partial'
                ? 'partial'
                : work.sizeBytes != null ? 'resolved' : 'loading',
        });
        const needsInfo = !work.durationSeconds || !work.tags?.length || !work.coverUrl;
        const [tracksResult, infoResult] = await Promise.allSettled([
            WorkService.getTracks(id),
            needsInfo ? WorkService.getWorkInfo(id) : Promise.resolve(null),
        ]);
        if (!visible.value || generation !== enrichmentGeneration) return;
        const update: Partial<BackupWorkDownloadItem> = {};
        if (tracksResult.status === 'fulfilled') {
            const manifest = discoverDownloadManifest(tracksResult.value as unknown as DownloadTreeNode[]);
            const byType: Partial<Record<BackupFileFilter, number>> = {};
            const unknownByType: Partial<Record<BackupFileFilter, number>> = {};
            for (const entry of manifest.entries) {
                const category: BackupFileFilter = entry.category === 'unknown' ? 'other' : entry.category;
                if (!entry.size || entry.size <= 0) {
                    unknownByType[category] = (unknownByType[category] ?? 0) + 1;
                    continue;
                }
                byType[category] = (byType[category] ?? 0) + entry.size;
            }
            const sizeBytes = Object.values(byType).reduce((sum, value) => sum + (value ?? 0), 0);
            const unknownSizeCount = Object.values(unknownByType).reduce((sum, value) => sum + (value ?? 0), 0);
            if (sizeBytes > 0) {
                update.sizeBytesByType = byType;
                update.unknownSizeCountByType = unknownByType;
                update.sizeBytes = sizeBytes;
                update.sizeState = unknownSizeCount > 0 ? 'partial' : 'resolved';
            } else if (unknownSizeCount > 0) {
                update.unknownSizeCountByType = unknownByType;
                update.sizeState = 'partial';
            }
        }
        if (infoResult.status === 'fulfilled' && infoResult.value) {
            const info = infoResult.value;
            update.title = work.title || info.title;
            update.coverUrl = work.coverUrl || info.thumbnailCoverUrl || info.samCoverUrl || info.mainCoverUrl;
            update.durationSeconds = work.durationSeconds || info.duration;
            if (!work.tags?.length) update.tags = info.tags?.map(tag => tag.name).filter(Boolean);
        }
        if (update.sizeState == null && work.sizeBytes == null) update.sizeState = 'unavailable';
        updateWork(id, update);
    })().catch(error => {
        if (!visible.value || generation !== enrichmentGeneration) return;
        Logger.warn('[DownloadCenter] Could not calculate work size', id, error);
        updateWork(id, { sizeState: 'unavailable' });
    }).finally(() => { enrichingWorks.delete(key); });
    enrichingWorks.set(key, request);
    return request;
}

async function enrichWorkItems(ids: string[], generation: number): Promise<void> {
    const queue = [...new Set(ids)];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
        for (;;) {
            const id = queue[cursor++];
            if (!id || !visible.value || generation !== enrichmentGeneration) return;
            await enrichWorkItem(id, generation);
        }
    });
    await Promise.all(workers);
}

async function searchAllWorks(query: string): Promise<void> {
    const generation = ++enrichmentGeneration;
    const previousWorks = new Map(works.value.map(work => [normalizeWorkId(work.id), work]));
    // A direct-only result belongs to the query that produced it. Keeping it
    // after a later query would leave an invisible selected work in the
    // download job. Playlist-backed entries survive because they still belong
    // to Yours/Community even when they are no longer a Site result.
    const retainedWorks = works.value
        .filter(work => !work.directSearchResult || (work.playlistIds?.length ?? 0) > 0)
        .map(work => ({ ...work, directSearchResult: false }));
    works.value = retainedWorks;
    const retainedIds = new Set(retainedWorks.map(work => String(work.id)));
    const retainedSelectedWorkIds = options.value.selectedWorkIds.filter(id => retainedIds.has(String(id)));
    if (retainedSelectedWorkIds.length !== options.value.selectedWorkIds.length) {
        options.value = { ...options.value, selectedWorkIds: retainedSelectedWorkIds };
    }

    const applyResults = (
        source: 'semantic' | 'live',
        results: readonly Record<string, unknown>[],
    ): void => {
        if (!visible.value || generation !== enrichmentGeneration) return;
        const merged = new Map(works.value.map(work => [normalizeWorkId(work.id), work]));
        for (const result of results) {
            mergeDirectWork(
                merged,
                result,
                source === 'semantic' && typeof result.title === 'string' ? result.title : '',
                previousWorks,
            );
        }
        const mergedWorks = [...merged.values()];
        const retained = mergedWorks.filter(work => !work.directSearchResult);
        const directWorks = mergedWorks.filter(work => work.directSearchResult).slice(0, 30);
        works.value = [...retained, ...directWorks];
        const availableIds = new Set(works.value.map(work => String(work.id)));
        const selectedWorkIds = options.value.selectedWorkIds.filter(id => availableIds.has(String(id)));
        if (selectedWorkIds.length !== options.value.selectedWorkIds.length) {
            options.value = { ...options.value, selectedWorkIds };
        }
        const resultIds = results
            .map(result => normalizeWorkId(result.source_id ?? result.sourceId ?? result.id))
            .filter(Boolean);
        void enrichWorkItems(resultIds, generation);
    };

    const exactRj = /^[A-Za-z]{2}\d+$/.test(query.trim());
    const liveRequest = settleSearch(withSearchDeadline(
        WorksApi.searchWorks(query, { page: 1 }),
        DOWNLOAD_CENTER_LIVE_SEARCH_WAIT_MS,
        'Live site search',
    ));
    if (exactRj) {
        const live = await liveRequest;
        if (live.status === 'rejected') {
            Logger.warn('[DownloadCenter] Live work search unavailable', live.reason);
            throw live.reason;
        }
        applyResults('live', live.value.works as unknown as Record<string, unknown>[]);
        return;
    }

    const semanticRequest = settleSearch(withSearchDeadline(
        semanticWorkSearch(query, 20),
        DOWNLOAD_CENTER_SEMANTIC_SEARCH_WAIT_MS,
        'Hosted semantic search',
    ));
    // Return as soon as either the live catalogue succeeds or semantic search
    // has a non-empty answer. The slower source continues in the background and
    // is merged only if this is still the active query.
    const primary = await Promise.race([
        liveRequest.then(async live => {
            if (live.status === 'fulfilled' && live.value.works.length > 0) {
                return { source: 'live' as const, results: live.value.works };
            }
            const semantic = await semanticRequest;
            if (semantic.status === 'fulfilled') return { source: 'semantic' as const, results: semantic.value };
            if (live.status === 'fulfilled') return { source: 'live' as const, results: live.value.works };
            Logger.warn('[DownloadCenter] Live work search unavailable', live.reason);
            Logger.warn('[DownloadCenter] Hosted semantic work search unavailable', semantic.reason);
            throw live.reason;
        }),
        semanticRequest.then(async semantic => {
            if (semantic.status === 'fulfilled' && semantic.value.length > 0) {
                return { source: 'semantic' as const, results: semantic.value };
            }
            const live = await liveRequest;
            if (live.status === 'fulfilled') return { source: 'live' as const, results: live.value.works };
            if (semantic.status === 'fulfilled') return { source: 'semantic' as const, results: semantic.value };
            Logger.warn('[DownloadCenter] Live work search unavailable', live.reason);
            Logger.warn('[DownloadCenter] Hosted semantic work search unavailable', semantic.reason);
            throw live.reason;
        }),
    ]);
    applyResults(primary.source, primary.results as unknown as Record<string, unknown>[]);

    if (primary.source !== 'semantic') {
        void semanticRequest.then(semantic => {
            if (semantic.status === 'fulfilled') {
                applyResults('semantic', semantic.value as unknown as Record<string, unknown>[]);
            } else {
                Logger.warn('[DownloadCenter] Hosted semantic work search unavailable', semantic.reason);
            }
        });
    }
    if (primary.source !== 'live') {
        void liveRequest.then(live => {
            if (live.status === 'fulfilled') {
                applyResults('live', live.value.works as unknown as Record<string, unknown>[]);
            } else {
                Logger.warn('[DownloadCenter] Live work search unavailable', live.reason);
            }
        });
    }
}

function setRunnerProgress(next: BackupDownloadProgress & { jobId?: string }): void {
    progress.value = next;
}

function sanitizeDownloadFailureDetail(error: unknown): string {
    const cause = error instanceof Error
        ? (error as Error & { cause?: unknown }).cause
        : undefined;
    const raw = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
    if (!raw) return '';
    return raw
        .replace(/https?:\/\/[^\s)]+/gi, t('downloadCenterRemoteSource'))
        .replace(/\b(?:authorization|bearer|token|jwt|key|signature|sig)=[^\s&]+/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240);
}

function friendlyError(error: unknown): string {
    if (error instanceof DownloadCenterRunError) {
        if (error.code === 'unsupported') return t('backupDownloaderUnsupported');
        if (error.code === 'permission') return t('backupDownloaderPermission');
        if (error.code === 'no-files') return t('backupDownloaderNoFiles');
        if (error.code === 'paused') return t('downloadCenterPaused');
        if (error.code === 'already-running') return t('downloadCenterAlreadyRunning');
        if (error.code === 'failed') {
            const detail = sanitizeDownloadFailureDetail(error);
            return detail
                ? format('backupDownloaderFailedDetail', { detail })
                : t('backupDownloaderFailed');
        }
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

function markDownloadComplete(result: { jobId: string; skipped: number }): void {
    resumableJobs.value = resumableJobs.value.filter(job => job.id !== result.jobId);
    progress.value = {
        ...(progress.value ?? { current: 1, total: 1 }),
        phase: 'complete',
        label: result.skipped
            ? format('backupDownloaderDoneWithSkipped', { count: result.skipped })
            : t('backupDownloaderDone'),
    };
}

function markDownloadFailed(error: unknown): void {
    if (error instanceof DownloadCenterRunError && error.code === 'paused') {
        if (progress.value) progress.value = { ...progress.value, phase: 'paused' };
        return;
    }
    jobError.value = friendlyError(error);
    if (progress.value) progress.value = { ...progress.value, phase: 'failed' };
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
        markDownloadComplete(result);
    } catch (error) {
        await rememberSettledJob(activeJobId);
        markDownloadFailed(error);
    } finally {
        busy.value = false;
    }
}

async function resumeDownload(jobId: string, disableOpus = false): Promise<void> {
    const job = resumableJobs.value.find(item => item.id === jobId);
    if (!job || busy.value) return;
    jobError.value = '';
    busy.value = true;
    try {
        const result = await runner.resume(job, setRunnerProgress, { disableOpus });
        markDownloadComplete(result);
    } catch (error) {
        markDownloadFailed(error);
    } finally {
        busy.value = false;
    }
}

function resumeDownloadWithoutOpus(jobId: string): void {
    void resumeDownload(jobId, true);
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
onUnmounted(() => {
    visible.value = false;
    enrichmentGeneration += 1;
    unsubscribeRunner?.();
});

defineExpose({ open });
</script>

<template>
    <button class="q-btn q-btn-flat q-btn-dense asmr-download-center-btn text-white" data-testid="download-center-open" :title="t('downloadCenterButton')" :aria-label="t('downloadCenterButton')" @click="open"><span class="q-btn__content"><i class="q-icon material-icons" aria-hidden="true">download_for_offline</i></span></button>
    <Teleport to="body">
        <BackupWorkDownloader v-if="visible" :playlists="playlists" :works="works" :profile="profile" :show-own="signedIn" :loading-own="loadingOwn" :loading-public="loadingPublic" :own-load-failed="ownLoadFailed" :public-load-failed="publicLoadFailed" :busy="busy" :progress="displayProgress" :error-message="jobError" :resumable-jobs="resumableJobs.map(job => ({ id: job.id, title: job.title, convertToOpus: job.options.state.convertToOpus }))" :resolve-playlist="resolvePlaylist" :search-all-works="searchAllWorks" @close="close" @source-change="handleSourceChange" @update="updateProfile" @start="startDownload" @pause="pauseDownload" @resume="resumeDownload" @resume-without-opus="resumeDownloadWithoutOpus" />
    </Teleport>
</template>
