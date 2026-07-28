<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { WorksApi } from '../../api';
import { hasMoreWorkPages, readWorksTotalCount, WORKS_MAX_PAGE_SIZE, type WorksResponse } from '../../api/Works';
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
import type { DownloadDestination } from '../downloads/DownloadSink';
import {
    canCreateDownloadDestination,
    createDownloadDestination,
    DownloadDestinationCancelledError,
    supportsDirectoryPicker,
} from '../downloads/DownloadSinkFactory';
import {
    DownloadCenterRunError,
    DownloadCenterRunner,
    type DownloadCenterJob,
    type DownloadCenterResumeOptions,
} from '../downloads/DownloadCenterRunner';
import { fetchCachedCommunityPlaylist } from '../playlist/CommunityPlaylistDetailsService';
import { PlaylistDiscoveryService } from '../playlist/PlaylistDiscoveryService';
import { getApiBaseUrl, getAuthHeader } from '../playlist/PlaylistService';
import type { CommunityPlaylistSummary } from '../playlist/types';
import {
    clearSemanticWorkSearchCache,
    SEMANTIC_WORK_SEARCH_PAGE_SIZE,
    semanticWorkSearch,
    type SemanticWorkSearchPage,
} from '../SemanticWorkSearchService';
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
const searchTotal = ref(0);
/**
 * How much the reported total can be trusted. `exact` when it is derived from
 * one lane (or from lanes that are fully loaded), `approximate` while two
 * overlapping lanes still have unread pages, `unknown` before any lane answers.
 */
const searchTotalKind = ref<'unknown' | 'exact' | 'approximate'>('unknown');
const searchHasMore = ref(false);
let unsubscribeRunner: (() => void) | undefined;
let disposed = false;
/** Invalidates results merged by a query the user has already replaced. */
let searchGeneration = 0;
interface LiveSearchLane {
    query: string; page: number; loaded: number; total: number; hasMore: boolean;
    /**
     * Whether the API actually sent pagination.totalCount. readWorksTotalCount
     * falls back to the page length, which is a defensive guess — presenting
     * that as an exact total ('Showing 5 of 5') states a non-fact.
     */
    reportedTotal: boolean;
}
/** The semantic lane pages by rank, so its next offset is what it has loaded. */
interface SemanticSearchLane { query: string; loaded: number; total: number; hasMore: boolean }
let livePages: LiveSearchLane | null = null;
let semanticPages: SemanticSearchLane | null = null;
const DOWNLOAD_CENTER_LIVE_SEARCH_WAIT_MS = 30_000;
const DOWNLOAD_CENTER_SEMANTIC_SEARCH_WAIT_MS = 30_000;
/** One page of semantic hits; paging replaced the old silent 200-hit ceiling. */
const DOWNLOAD_CENTER_SEMANTIC_PAGE_SIZE = SEMANTIC_WORK_SEARCH_PAGE_SIZE;
const DOWNLOAD_CENTER_ENRICH_CONCURRENCY = 3;
/** True when finished works must be exported instead of written to a folder. */
const stagedDestination = computed(() => canCreateDownloadDestination() && !supportsDirectoryPicker());

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
    downloadConcurrency: 1,
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
    resumeWithOriginalTitles: t('downloadCenterResumeWithOriginalTitles'),
    alreadyRunning: t('downloadCenterAlreadyRunning'),
    resumableDownloads: t('backupDownloaderResumeAvailable'),
    expandPlaylist: t('backupDownloaderExpand'),
    collapsePlaylist: t('backupDownloaderCollapse'),
    selectedSummary: t('backupDownloaderSelected'),
    unknownSize: t('backupDownloaderUnknownSize'),
    durationAndFiles: t('backupDownloaderDurationAndFiles'),
    fileCount: t('backupDownloaderFileCount'),
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
    void refreshResumableJobs();
}

function close(): void {
    visible.value = false;
}

function handleSourceChange(source: BackupPlaylistSourceFilter): void {
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
                    // Rows start on their payload duration/file counts, never a
                    // spinner: exact sizes are only read on demand.
                    sizeState: item.sizeBytes ? 'resolved' : current?.sizeState ?? 'unavailable',
                    durationSeconds: item.durationSeconds ?? current?.durationSeconds,
                    playlistIds: [...playlistIds],
                });
            }
            works.value = [...nextWorks.values()];
            // Rows enrich themselves once they scroll into view; resolving a
            // playlist must not fan out one manifest request per work.
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
        sizeState: sizeBytes ? 'resolved' : current?.sizeState ?? 'unavailable',
        durationSeconds: durationSeconds ?? current?.durationSeconds,
        tags,
        playlistIds: current?.playlistIds,
        directSearchResult: true,
    });
}

function updateWork(id: string, update: Partial<BackupWorkDownloadItem>): void {
    works.value = works.value.map(work => String(work.id) === id ? { ...work, ...update } : work);
}

/**
 * Fills in what a list row is missing.
 *
 * `detailed` is reserved for user-driven work (an explicitly selected row) and
 * is the only mode that reads the full file manifest. Viewport rows ask for
 * cheap metadata only, so scrolling a large result set never fans out into a
 * manifest download per row. Every path writes a terminal state, so a row can
 * never be stranded showing a spinner.
 */
async function enrichWorkItem(id: string, detailed = false): Promise<void> {
    const key = `${detailed ? 'full' : 'basic'}:${id}`;
    const existing = enrichingWorks.get(key);
    if (existing) return existing;
    const work = works.value.find(item => String(item.id) === id);
    if (!work) return;
    const needsSizes = detailed && !work.sizeBytesByType;
    const needsInfo = !work.durationSeconds || !work.tags?.length || !work.coverUrl;
    if (!needsSizes && !needsInfo) return;
    const previousSizeState = work.sizeState;
    if (needsSizes) updateWork(id, { sizeState: 'loading' });
    const request = (async () => {
        const [tracksResult, infoResult] = await Promise.allSettled([
            needsSizes ? WorkService.getTracks(id) : Promise.resolve(null),
            needsInfo ? WorkService.getWorkInfo(id) : Promise.resolve(null),
        ]);
        const update: Partial<BackupWorkDownloadItem> = {};
        if (tracksResult.status === 'fulfilled' && tracksResult.value) {
            const manifest = discoverDownloadManifest(tracksResult.value as unknown as DownloadTreeNode[]);
            const byType: Partial<Record<BackupFileFilter, number>> = {};
            const fileCountByType: Partial<Record<BackupFileFilter, number>> = {};
            const unknownByType: Partial<Record<BackupFileFilter, number>> = {};
            for (const entry of manifest.entries) {
                const category: BackupFileFilter = entry.category === 'unknown' ? 'other' : entry.category;
                fileCountByType[category] = (fileCountByType[category] ?? 0) + 1;
                if (!entry.size || entry.size <= 0) {
                    unknownByType[category] = (unknownByType[category] ?? 0) + 1;
                    continue;
                }
                byType[category] = (byType[category] ?? 0) + entry.size;
            }
            const sizeBytes = Object.values(byType).reduce((sum, value) => sum + (value ?? 0), 0);
            const unknownSizeCount = Object.values(unknownByType).reduce((sum, value) => sum + (value ?? 0), 0);
            update.fileCountByType = fileCountByType;
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
        if (update.sizeState == null) {
            update.sizeState = needsSizes
                ? (work.sizeBytes != null ? 'resolved' : 'unavailable')
                : previousSizeState ?? (work.sizeBytes != null ? 'resolved' : 'unavailable');
        }
        updateWork(id, update);
    })().catch(error => {
        Logger.warn('[DownloadCenter] Could not enrich work', id, error);
        // Roll the row back instead of leaving it on the spinner forever; the
        // next viewport pass or selection can retry it.
        updateWork(id, { sizeState: needsSizes ? 'unavailable' : previousSizeState ?? 'unavailable' });
    }).finally(() => { enrichingWorks.delete(key); });
    enrichingWorks.set(key, request);
    return request;
}

async function enrichWorkItems(ids: readonly (string | number)[], detailed = false): Promise<void> {
    const queue = [...new Set(ids.map(String))].filter(Boolean);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(DOWNLOAD_CENTER_ENRICH_CONCURRENCY, queue.length) }, async () => {
        for (;;) {
            const id = queue[cursor++];
            // Requests already in flight still write their terminal state; only
            // the not-yet-started remainder is abandoned once the feature ends.
            if (!id || disposed) return;
            await enrichWorkItem(id, detailed);
        }
    });
    await Promise.all(workers);
}

function requestWorkEnrichment(ids: readonly (string | number)[], detailed = false): void {
    void enrichWorkItems(ids, detailed);
}

function mergeSearchResults(
    source: 'semantic' | 'live',
    results: readonly Record<string, unknown>[],
    previousWorks: ReadonlyMap<string, BackupWorkDownloadItem>,
): void {
    const merged = new Map(works.value.map(work => [normalizeWorkId(work.id), work]));
    for (const result of results) {
        mergeDirectWork(
            merged,
            result,
            source === 'semantic' && typeof result.title === 'string' ? result.title : '',
            previousWorks,
        );
    }
    works.value = [...merged.values()];
    const availableIds = new Set(works.value.map(work => String(work.id)));
    const previousSelection = options.value.selectedWorkIds ?? [];
    const selectedWorkIds = previousSelection.filter(id => availableIds.has(String(id)));
    if (selectedWorkIds.length !== previousSelection.length) {
        options.value = { ...options.value, selectedWorkIds };
    }
}

function countDirectResults(): number {
    return works.value.filter(work => work.directSearchResult).length;
}

function nextLiveLane(query: string, response: WorksResponse, previous: LiveSearchLane | null): LiveSearchLane {
    const loaded = (previous?.loaded ?? 0) + response.works.length;
    return {
        query,
        page: (previous?.page ?? 0) + 1,
        loaded,
        // Never let a later page shrink the reported total. Recomputing it from
        // the newest response alone made "Showing 3 of 900" become
        // "Showing 6 of 6" on the next click.
        total: Math.max(
            previous?.total ?? 0,
            readWorksTotalCount(response, loaded - response.works.length),
        ),
        reportedTotal: (previous?.reportedTotal ?? false)
            || typeof response.pagination?.totalCount === 'number',
        // An empty page ends the lane even when the reported total disagrees,
        // so "load more" can never loop on a catalogue that has run out.
        hasMore: hasMoreWorkPages(response, loaded),
    };
}

function nextSemanticLane(query: string, page: SemanticWorkSearchPage, previous: SemanticSearchLane | null): SemanticSearchLane {
    const loaded = (previous?.loaded ?? 0) + page.results.length;
    const total = Math.max(page.total, loaded);
    return { query, loaded, total, hasMore: page.results.length > 0 && loaded < total };
}

/**
 * Recomputes the combined total from both lanes.
 *
 * The lanes overlap and only the duplicates among already-delivered rows are
 * observable, so the combined figure is both lane totals minus the duplicates
 * seen so far. That can only ever over-count works nobody has loaded yet, it
 * never drops below what is on screen, and it converges on the exact number
 * once every page has been read — which is why a two-lane result set in
 * progress is labelled as approximate rather than presented as fact.
 */
function updateSearchTotals(): void {
    const shown = countDirectResults();
    searchHasMore.value = (livePages?.hasMore ?? false) || (semanticPages?.hasMore ?? false);
    if (!livePages && !semanticPages) {
        searchTotal.value = shown;
        searchTotalKind.value = 'unknown';
        return;
    }
    const liveTotal = livePages?.total ?? 0;
    const semanticTotal = semanticPages?.total ?? 0;
    const delivered = (livePages?.loaded ?? 0) + (semanticPages?.loaded ?? 0);
    const duplicates = Math.max(0, delivered - shown);
    searchTotal.value = Math.max(shown, liveTotal + semanticTotal - duplicates);
    const pending = (liveTotal - (livePages?.loaded ?? 0)) + (semanticTotal - (semanticPages?.loaded ?? 0));
    // If the only lane that answered never actually reported a total, we are
    // showing a fallback derived from the page length. Say "unknown" rather
    // than dressing a defensive guess up as an exact count.
    const liveTotalIsReal = !livePages || livePages.reportedTotal;
    if (!liveTotalIsReal && semanticTotal === 0) {
        searchTotal.value = shown;
        searchTotalKind.value = 'unknown';
        return;
    }
    searchTotalKind.value = liveTotal > 0 && semanticTotal > 0 && pending > 0 ? 'approximate' : 'exact';
}

async function searchAllWorks(query: string): Promise<void> {
    const generation = ++searchGeneration;
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
    const previousSelection = options.value.selectedWorkIds ?? [];
    const retainedSelectedWorkIds = previousSelection.filter(id => retainedIds.has(String(id)));
    if (retainedSelectedWorkIds.length !== previousSelection.length) {
        options.value = { ...options.value, selectedWorkIds: retainedSelectedWorkIds };
    }
    livePages = null;
    semanticPages = null;
    searchTotal.value = 0;
    searchTotalKind.value = 'unknown';
    searchHasMore.value = false;

    const applyResults = (
        source: 'semantic' | 'live',
        results: readonly Record<string, unknown>[],
    ): void => {
        if (generation !== searchGeneration) return;
        mergeSearchResults(source, results, previousWorks);
        updateSearchTotals();
    };

    const recordLivePage = (response: WorksResponse): void => {
        if (generation !== searchGeneration) return;
        livePages = nextLiveLane(query, response, livePages);
    };

    const recordSemanticPage = (page: SemanticWorkSearchPage): void => {
        if (generation !== searchGeneration) return;
        semanticPages = nextSemanticLane(query, page, semanticPages);
    };

    const exactRj = /^[A-Za-z]{2}\d+$/.test(query.trim());
    const liveRequest = settleSearch(withSearchDeadline(
        WorksApi.searchWorks(query, { page: 1, pageSize: WORKS_MAX_PAGE_SIZE, limit: WORKS_MAX_PAGE_SIZE }),
        DOWNLOAD_CENTER_LIVE_SEARCH_WAIT_MS,
        'Live site search',
    ));
    if (exactRj) {
        const live = await liveRequest;
        if (live.status === 'rejected') {
            Logger.warn('[DownloadCenter] Live work search unavailable', live.reason);
            throw live.reason;
        }
        recordLivePage(live.value);
        applyResults('live', live.value.works as unknown as Record<string, unknown>[]);
        return;
    }

    const semanticRequest = settleSearch(withSearchDeadline(
        semanticWorkSearch(query, { limit: DOWNLOAD_CENTER_SEMANTIC_PAGE_SIZE, offset: 0 }),
        DOWNLOAD_CENTER_SEMANTIC_SEARCH_WAIT_MS,
        'Hosted semantic search',
    ));
    const fromLive = (response: WorksResponse) => ({ source: 'live' as const, response });
    const fromSemantic = (page: SemanticWorkSearchPage) => ({ source: 'semantic' as const, page });
    // Return as soon as either the live catalogue succeeds or semantic search
    // has a non-empty answer. The slower source continues in the background and
    // is merged only if this is still the active query.
    const primary = await Promise.race([
        liveRequest.then(async live => {
            if (live.status === 'fulfilled' && live.value.works.length > 0) return fromLive(live.value);
            const semantic = await semanticRequest;
            if (semantic.status === 'fulfilled') return fromSemantic(semantic.value);
            if (live.status === 'fulfilled') return fromLive(live.value);
            Logger.warn('[DownloadCenter] Live work search unavailable', live.reason);
            Logger.warn('[DownloadCenter] Hosted semantic work search unavailable', semantic.reason);
            throw live.reason;
        }),
        semanticRequest.then(async semantic => {
            if (semantic.status === 'fulfilled' && semantic.value.results.length > 0) return fromSemantic(semantic.value);
            const live = await liveRequest;
            if (live.status === 'fulfilled') return fromLive(live.value);
            if (semantic.status === 'fulfilled') return fromSemantic(semantic.value);
            Logger.warn('[DownloadCenter] Live work search unavailable', live.reason);
            Logger.warn('[DownloadCenter] Hosted semantic work search unavailable', semantic.reason);
            throw live.reason;
        }),
    ]);
    if (primary.source === 'live') {
        recordLivePage(primary.response);
        applyResults('live', primary.response.works as unknown as Record<string, unknown>[]);
    } else {
        recordSemanticPage(primary.page);
        applyResults('semantic', primary.page.results as unknown as Record<string, unknown>[]);
    }

    if (primary.source !== 'semantic') {
        void semanticRequest.then(semantic => {
            if (semantic.status === 'fulfilled') {
                recordSemanticPage(semantic.value);
                applyResults('semantic', semantic.value.results as unknown as Record<string, unknown>[]);
            } else {
                Logger.warn('[DownloadCenter] Hosted semantic work search unavailable', semantic.reason);
            }
        });
    }
    if (primary.source !== 'live') {
        void liveRequest.then(live => {
            if (live.status === 'fulfilled') {
                recordLivePage(live.value);
                applyResults('live', live.value.works as unknown as Record<string, unknown>[]);
            } else {
                Logger.warn('[DownloadCenter] Live work search unavailable', live.reason);
            }
        });
    }
}

/**
 * Appends the next page of every lane that still has results.
 *
 * Both lanes advance together and merge into the same collection, so results
 * beyond the first semantic page are reachable, duplicates across lanes
 * collapse onto one row, and an existing selection is never disturbed. A lane
 * that fails keeps its unread pages, so the button can simply be pressed again.
 */
async function loadMoreWorks(): Promise<void> {
    if (!searchHasMore.value) return;
    const generation = searchGeneration;
    const live = livePages;
    const semantic = semanticPages;
    const liveRequest = live?.hasMore
        ? settleSearch(withSearchDeadline(
            WorksApi.searchWorks(live.query, {
                page: live.page + 1,
                pageSize: WORKS_MAX_PAGE_SIZE,
                limit: WORKS_MAX_PAGE_SIZE,
            }),
            DOWNLOAD_CENTER_LIVE_SEARCH_WAIT_MS,
            'Live site search',
        ))
        : undefined;
    const semanticRequest = semantic?.hasMore
        ? settleSearch(withSearchDeadline(
            semanticWorkSearch(semantic.query, {
                limit: DOWNLOAD_CENTER_SEMANTIC_PAGE_SIZE,
                offset: semantic.loaded,
            }),
            DOWNLOAD_CENTER_SEMANTIC_SEARCH_WAIT_MS,
            'Hosted semantic search',
        ))
        : undefined;
    const [liveOutcome, semanticOutcome] = await Promise.all([liveRequest, semanticRequest]);
    // Only a NEW SEARCH invalidates this page. Do not compare both lane refs:
    // searchAllWorks merges the slower lane's first page in the background, so
    // that lane's ref changes for reasons unrelated to this request, and
    // comparing it discarded a perfectly good page — a dead "Load more" click
    // with no error and no spinner, during the ordinary first-search window.
    // Each lane is instead validated against the ref it actually paged from,
    // just before it is applied.
    if (generation !== searchGeneration) return;
    let advanced = false;
    let failure: unknown;
    if (live && livePages === live && liveOutcome?.status === 'fulfilled') {
        livePages = nextLiveLane(live.query, liveOutcome.value, live);
        mergeSearchResults('live', liveOutcome.value.works as unknown as Record<string, unknown>[], new Map());
        advanced = true;
    } else if (liveOutcome?.status === 'rejected') {
        Logger.warn('[DownloadCenter] Could not load another live search page', liveOutcome.reason);
        failure = liveOutcome.reason;
    }
    if (semantic && semanticPages === semantic && semanticOutcome?.status === 'fulfilled') {
        semanticPages = nextSemanticLane(semantic.query, semanticOutcome.value, semantic);
        mergeSearchResults('semantic', semanticOutcome.value.results as unknown as Record<string, unknown>[], new Map());
        advanced = true;
    } else if (semanticOutcome?.status === 'rejected') {
        Logger.warn('[DownloadCenter] Could not load another semantic search page', semanticOutcome.reason);
        failure ??= semanticOutcome.reason;
    }
    updateSearchTotals();
    // One lane answering is a usable page; only a page that added nothing at
    // all is a failure the user has to be told about.
    if (!advanced && failure) throw failure;
}

function setRunnerProgress(next: BackupDownloadProgress & { jobId?: string }): void {
    progress.value = next;
}

/** A run error's own message is a machine code, never user-facing detail. */
function failureText(value: unknown): string {
    if (value instanceof DownloadCenterRunError) return '';
    if (value instanceof Error) return value.message;
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && 'message' in value) {
        return String((value as { message?: unknown }).message ?? '');
    }
    return '';
}

function sanitizeDownloadFailureDetail(error: unknown): string {
    const cause = error instanceof Error
        ? (error as Error & { cause?: unknown }).cause
        : undefined;
    // Unclassified failures (an IndexedDB refusal under strict privacy, for
    // example) arrive with no cause at all, so fall back to the error itself
    // rather than showing the generic "download failed" wall.
    const raw = failureText(cause) || failureText(error);
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
        if (error.code === 'export') return t('backupDownloaderExportPending');
        if (error.code === 'title-translation') return t('backupDownloaderTitleTranslationRequired');
        if (error.code === 'already-running') return t('downloadCenterAlreadyRunning');
    }
    const detail = sanitizeDownloadFailureDetail(error);
    return detail
        ? format('backupDownloaderFailedDetail', { detail })
        : t('backupDownloaderFailed');
}

function needsTitleTranslation(job: DownloadCenterJob): boolean {
    const { discovery, state } = job.options;
    return discovery?.titlesReady === false
        && discovery.nextIndex === 0
        && (state.titleMode === 'translated' || state.titleMode === 'original-bracketed-translation');
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

function completionLabel(result: { skipped: number; exportFailures?: number; skippedFiles?: number }): string {
    if (result.exportFailures) {
        return format('backupDownloaderDoneWithExportFailures', { count: result.exportFailures });
    }
    // A file that fails no longer aborts the job, so the count has to be
    // reported or the run would look completely clean.
    if (result.skippedFiles) {
        return format('backupDownloaderDoneWithSkippedFiles', { count: result.skippedFiles });
    }
    return result.skipped
        ? format('backupDownloaderDoneWithSkipped', { count: result.skipped })
        : t('backupDownloaderDone');
}

function markDownloadComplete(result: { jobId: string; skipped: number; exportFailures?: number; skippedFiles?: number }): void {
    resumableJobs.value = resumableJobs.value.filter(job => job.id !== result.jobId);
    progress.value = {
        ...(progress.value ?? { current: 1, total: 1 }),
        phase: 'complete',
        label: completionLabel(result),
    };
}

function markDownloadFailed(error: unknown): void {
    if (
        error instanceof DownloadCenterRunError
        && (error.code === 'paused' || error.code === 'export' || error.code === 'title-translation')
    ) {
        if (error.code === 'title-translation' || error.code === 'export') jobError.value = friendlyError(error);
        if (progress.value) progress.value = { ...progress.value, phase: 'paused' };
        return;
    }
    jobError.value = friendlyError(error);
    if (progress.value) progress.value = { ...progress.value, phase: 'failed' };
}

async function startDownload(state: BackupDownloadState): Promise<void> {
    if (busy.value) return;
    jobError.value = '';
    // The gate is "no sink can be constructed at all", not "this browser lacks
    // the Chromium folder picker": Firefox stages into private browser storage.
    if (!canCreateDownloadDestination()) {
        progress.value = null;
        jobError.value = t('backupDownloaderUnsupported');
        return;
    }
    let destination: DownloadDestination;
    try { destination = await createDownloadDestination(); }
    catch (error) {
        if (error instanceof DownloadDestinationCancelledError) return;
        progress.value = null;
        jobError.value = friendlyError(error);
        return;
    }
    busy.value = true;
    progress.value = { phase: 'discovering', current: 0, total: state.selectedWorkIds.length };
    let activeJobId: string | undefined;
    try {
        const result = await runner.start(
            works.value,
            state,
            destination,
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

async function resumeDownload(
    jobId: string,
    resumeOptions: DownloadCenterResumeOptions = {},
): Promise<void> {
    const job = resumableJobs.value.find(item => item.id === jobId);
    if (!job || busy.value) return;
    jobError.value = '';
    busy.value = true;
    try {
        const result = await runner.resume(job, setRunnerProgress, resumeOptions);
        markDownloadComplete(result);
    } catch (error) {
        markDownloadFailed(error);
    } finally {
        busy.value = false;
    }
}

function resumeDownloadWithoutOpus(jobId: string): void {
    void resumeDownload(jobId, { disableOpus: true });
}

function resumeDownloadWithOriginalTitles(jobId: string): void {
    void resumeDownload(jobId, { useOriginalTitles: true });
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
    disposed = true;
    // The paging cache holds a whole ranked index in memory; nothing can page
    // once this feature is gone, so release it.
    clearSemanticWorkSearchCache();
    unsubscribeRunner?.();
});

defineExpose({ open });
</script>

<template>
    <button class="q-btn q-btn-flat q-btn-dense asmr-download-center-btn text-white" data-testid="download-center-open" :title="t('downloadCenterButton')" :aria-label="t('downloadCenterButton')" @click="open"><span class="q-btn__content"><i class="q-icon material-icons" aria-hidden="true">download</i></span></button>
    <Teleport to="body">
        <BackupWorkDownloader v-if="visible" :playlists="playlists" :works="works" :profile="profile" :show-own="signedIn" :loading-own="loadingOwn" :loading-public="loadingPublic" :own-load-failed="ownLoadFailed" :public-load-failed="publicLoadFailed" :busy="busy" :progress="displayProgress" :error-message="jobError" :resumable-jobs="resumableJobs.map(job => ({ id: job.id, title: job.title, convertToOpus: job.options.state.convertToOpus, needsTitleTranslation: needsTitleTranslation(job) }))" :resolve-playlist="resolvePlaylist" :search-all-works="searchAllWorks" :load-more-works="loadMoreWorks" :enrich-works="requestWorkEnrichment" :search-total="searchTotal" :search-total-kind="searchTotalKind" :search-has-more="searchHasMore" :staged-destination="stagedDestination" @close="close" @source-change="handleSourceChange" @update="updateProfile" @start="startDownload" @pause="pauseDownload" @resume="resumeDownload" @resume-without-opus="resumeDownloadWithoutOpus" @resume-with-original-titles="resumeDownloadWithOriginalTitles" />
    </Teleport>
</template>
