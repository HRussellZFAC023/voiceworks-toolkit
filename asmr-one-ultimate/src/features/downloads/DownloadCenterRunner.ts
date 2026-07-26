import { Logger } from '../../core/Utils';
import { I18n } from '../../core/Config';
import { DeviceCapabilities } from '../../core/DeviceCapabilities';
import { TranslationService } from '../../services/TranslationService';
import { WorkService } from '../../services/WorkService';
import type { BackupDownloadProgress, BackupDownloadState, BackupWorkDownloadItem } from '../backupWorkDownloaderTypes';
import { resolveDownloadWorkTranslations } from '../backupWorkDownloaderUtils';
import { canonicalDownloadPath, reserveCollisionFreePath } from './DownloadPathUtils';
import { DownloadFolderExporter } from './DownloadFolderExporter';
import {
    requiresDownloadExport,
    type DownloadDestination,
    type DownloadSink,
} from './DownloadSink';
import { createDownloadSink } from './DownloadSinkFactory';
import { discoverDownloadManifest, type DownloadTreeNode } from './DownloadManifest';
import {
    DOWNLOAD_JOB_LEASE_MS,
    DownloadJobRepository,
    type DownloadFile,
    type DownloadJob,
} from './DownloadJobRepository';
import { DownloadTransport, resolveDownloadRequestTarget } from './DownloadTransport';
import { DownloadCoordinator, type DownloadCoordinatorProgress } from './DownloadCoordinator';
import { FfmpegOpusTranscoder } from './OpusTranscoder';
import {
    getOpusConversionMemoryBudget,
    OpusFileTransformer,
    planOpusOutputPaths,
} from './OpusFileTransformer';
import type { AudioTags, EmbeddedArtwork } from './MetadataPolicy';

interface DownloadEnrichment { tags: AudioTags; artworkUrl?: string }
export const DOWNLOAD_DISCOVERY_BATCH_SIZE = 8;
export const DOWNLOAD_DISCOVERY_CONCURRENCY = 3;
export const DOWNLOAD_OPTIONAL_METADATA_CONCURRENCY = 3;
export const DOWNLOAD_OPTIONAL_METADATA_WAIT_MS = 2_000;
export const DOWNLOAD_OPTIONAL_TRANSLATION_WAIT_MS = 30_000;
export const DOWNLOAD_ARTWORK_TIMEOUT_MS = 8_000;
export const DOWNLOAD_ARTWORK_MAX_BYTES = 5 * 1024 * 1024;
// Match the translation service's default remote concurrency so each
// checkpoint is one bounded wave rather than one all-selection barrier.
export const DOWNLOAD_TITLE_TRANSLATION_BATCH_SIZE = 8;

export interface PersistedDownloadDiscovery {
    works: BackupWorkDownloadItem[];
    nextIndex: number;
    skippedWorkIds: string[];
    titlesReady: boolean;
    complete: boolean;
}

export interface PersistedDownloadCenterOptions {
    state: BackupDownloadState;
    destination: DownloadDestination;
    /** Legacy field from jobs created before destinations became a union. */
    directory?: FileSystemDirectoryHandle;
    enrichment: Record<string, DownloadEnrichment>;
    opusOutputPaths?: Record<string, string>;
    discovery?: PersistedDownloadDiscovery;
    /** Work folders already handed to the browser by the export step. */
    exportedFolders?: string[];
}

/** Jobs persisted before the destination union still carry a raw handle. */
export function resolvePersistedDestination(
    options: Pick<PersistedDownloadCenterOptions, 'destination' | 'directory'>,
): DownloadDestination {
    if (options.destination) return options.destination;
    if (options.directory) return { kind: 'fsa', handle: options.directory };
    throw new DownloadCenterRunError('unsupported');
}

export type DownloadCenterJob = DownloadJob<PersistedDownloadCenterOptions>;
export type DownloadCenterProgressListener = (progress: BackupDownloadProgress & { jobId?: string }) => void;
export type DownloadCenterStateListener = (
    progress: (BackupDownloadProgress & { jobId?: string }) | null,
    running: boolean,
) => void;
export interface DownloadCenterResumeOptions {
    disableOpus?: boolean;
    useOriginalTitles?: boolean;
}

export interface DownloadCenterRunResult {
    jobId: string;
    skipped: number;
    /** Completed work folders the browser refused to receive. */
    exportFailures: number;
    /** Individual files that failed but did not abort the surrounding job. */
    skippedFiles: number;
}

export class DownloadCenterRunError extends Error {
    constructor(public readonly code: 'unsupported' | 'permission' | 'no-files' | 'paused' | 'title-translation' | 'already-running' | 'failed', cause?: unknown) {
        super(code);
        this.name = 'DownloadCenterRunError';
        if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
    }
}

function cloneOptions(options: PersistedDownloadCenterOptions): PersistedDownloadCenterOptions {
    const { directory, destination, enrichment, ...serializable } = options;
    // Enrichment is consumed only by Opus metadata/artwork conversion. Strip
    // it before serializing non-Opus jobs so large manifests do not repeatedly
    // clone and checkpoint an ever-growing per-file metadata object.
    const persistable = {
        ...serializable,
        enrichment: options.state.convertToOpus ? enrichment : {},
    };
    const resolved = resolvePersistedDestination({ destination, directory });
    return {
        ...(JSON.parse(JSON.stringify(persistable)) as Omit<PersistedDownloadCenterOptions, 'destination' | 'directory'>),
        // A directory handle survives structured clone but not JSON, so the
        // live object is re-attached instead of serialized.
        destination: resolved.kind === 'fsa' ? resolved : { ...resolved },
    };
}

function titleModeNeedsTranslation(state: BackupDownloadState): boolean {
    return state.titleMode === 'translated' || state.titleMode === 'original-bracketed-translation';
}

function workHasTitleTranslation(work: BackupWorkDownloadItem, targetLanguage: string): boolean {
    const title = String(work.title || '').trim();
    const translated = String(work.translatedTitle || '').trim();
    if (translated && translated !== title) return true;
    // Identifiers cannot be translated, and source text already written in the
    // requested lane is a legitimate unchanged result. Other source echoes are
    // provider fallbacks and must remain retryable.
    if (/^RJ\d{5,}$/i.test(title)) return true;
    return Boolean(title && TranslationService.isTargetLanguage(title, targetLanguage));
}

function reserveManifestPath(
    occupied: Set<string>,
    relativePath: readonly string[],
): void {
    for (let length = 1; length <= relativePath.length; length += 1) {
        occupied.add(canonicalDownloadPath(relativePath.slice(0, length)));
    }
}

function readHttpStatus(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const candidate = error as {
        status?: unknown;
        response?: { status?: unknown };
        cause?: unknown;
        message?: unknown;
    };
    if (typeof candidate.status === 'number') return candidate.status;
    if (typeof candidate.response?.status === 'number') return candidate.response.status;
    const messageStatus = typeof candidate.message === 'string'
        ? candidate.message.match(/\bHTTP\s+(\d{3})\b/i)
        : null;
    if (messageStatus) return Number(messageStatus[1]);
    return readHttpStatus(candidate.cause);
}

function isUnavailableWorkFailure(error: unknown): boolean {
    const status = readHttpStatus(error);
    return status === 404 || status === 410;
}

const ARTWORK_TIMEOUT = Symbol('artwork-timeout');
const ARTWORK_ABORTED = Symbol('artwork-aborted');

async function fetchBoundedArtwork(url: string, signal?: AbortSignal): Promise<EmbeddedArtwork | undefined> {
    if (signal?.aborted) return undefined;
    const target = resolveDownloadRequestTarget(url);
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let abandoned = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    const boundedExit = new Promise<typeof ARTWORK_TIMEOUT | typeof ARTWORK_ABORTED>(resolve => {
        timer = setTimeout(() => resolve(ARTWORK_TIMEOUT), DOWNLOAD_ARTWORK_TIMEOUT_MS);
        if (signal) {
            onAbort = () => resolve(ARTWORK_ABORTED);
            signal.addEventListener('abort', onAbort, { once: true });
        }
    });
    const request = (async (): Promise<EmbeddedArtwork | undefined> => {
        try {
            const response = await fetch(target.url, {
                credentials: target.credentials,
                headers: target.headers,
                signal: controller.signal,
            });
            if (abandoned) {
                void response.body?.cancel().catch(() => undefined);
                return undefined;
            }
            if (!response.ok) {
                void response.body?.cancel().catch(() => undefined);
                return undefined;
            }
            const declaredRaw = response.headers.get('content-length');
            if (declaredRaw !== null) {
                const declared = Number(declaredRaw);
                if (
                    !/^\d+$/.test(declaredRaw)
                    || !Number.isSafeInteger(declared)
                    || declared <= 0
                    || declared > DOWNLOAD_ARTWORK_MAX_BYTES
                ) {
                    void response.body?.cancel().catch(() => undefined);
                    return undefined;
                }
            }
            reader = response.body?.getReader();
            if (!reader) return undefined;
            const chunks: Uint8Array[] = [];
            let total = 0;
            for (;;) {
                const next = await reader.read();
                if (abandoned) {
                    void reader.cancel().catch(() => undefined);
                    return undefined;
                }
                if (next.done) break;
                if (!next.value?.byteLength) continue;
                if (total + next.value.byteLength > DOWNLOAD_ARTWORK_MAX_BYTES) {
                    void reader.cancel().catch(() => undefined);
                    return undefined;
                }
                const copy = new Uint8Array(next.value.byteLength);
                copy.set(next.value);
                chunks.push(copy);
                total += copy.byteLength;
            }
            if (total === 0) return undefined;
            const data = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
                data.set(chunk, offset);
                offset += chunk.byteLength;
            }
            return {
                mimeType: response.headers.get('content-type') || 'image/jpeg',
                data,
            };
        } catch {
            return undefined;
        }
    })();

    try {
        const result = await Promise.race([request, boundedExit]);
        if (result === ARTWORK_TIMEOUT || result === ARTWORK_ABORTED) {
            abandoned = true;
            controller.abort(result === ARTWORK_TIMEOUT
                ? new DOMException('Artwork request timed out', 'TimeoutError')
                : signal?.reason);
            void reader?.cancel().catch(() => undefined);
            return undefined;
        }
        return result;
    } finally {
        if (timer) clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
}

function resolvedWorkFolder(work: BackupWorkDownloadItem, state: BackupDownloadState): string {
    const original = work.title || String(work.id);
    const translated = work.translatedTitle && work.translatedTitle !== original ? work.translatedTitle : '';
    if (state.titleMode === 'translated') return translated || original;
    if (state.titleMode === 'original-bracketed-translation') return translated ? `${original} [${translated}]` : original;
    if (state.titleMode === 'none') return String(work.id);
    return original;
}

async function optionalWorkInfo(
    workId: string | number,
    activeRequests: Set<Promise<unknown>>,
): Promise<Awaited<ReturnType<typeof WorkService.getWorkInfo>> | null> {
    // An optional request must never starve the required track manifests. If
    // transports ignore their timeout, retain at most a tiny bounded pool and
    // omit enrichment for later works until a slot genuinely settles.
    if (activeRequests.size >= DOWNLOAD_OPTIONAL_METADATA_CONCURRENCY) return null;
    const metadata = WorkService.getWorkInfo(workId)
        .catch(error => {
            Logger.warn('[DownloadCenter] Optional work metadata unavailable; downloading files without enrichment', workId, error);
            return null;
        });
    activeRequests.add(metadata);
    void metadata.then(
        () => activeRequests.delete(metadata),
        () => activeRequests.delete(metadata),
    );
    return new Promise(resolve => {
        let settled = false;
        const finish = (value: Awaited<ReturnType<typeof WorkService.getWorkInfo>> | null): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };
        const timer = setTimeout(() => finish(null), DOWNLOAD_OPTIONAL_METADATA_WAIT_MS);
        void metadata.then(finish);
    });
}

/**
 * Owns the resumable download lifecycle independently from the modal. The
 * repository only recovers expired leases; healthy runs remain owned across
 * modal remounts and tabs. Browser locks provide immediate orphan recovery
 * where available, with the persisted lease as the cross-browser fallback.
 */
export class DownloadCenterRunner {
    private static sharedInstance: DownloadCenterRunner | undefined;
    private readonly repository: DownloadJobRepository;
    private recoveryRequest: Promise<DownloadCenterJob[]> | null = null;
    private activeCoordinator: DownloadCoordinator | null = null;
    private readonly optionalMetadataRequests = new Set<Promise<unknown>>();
    private activeJobId: string | null = null;
    private readonly ownerId: string;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private heartbeatPending = false;
    private leaseLost = false;
    private readonly pauseRequestedJobs = new Set<string>();
    private currentProgress: (BackupDownloadProgress & { jobId?: string }) | null = null;
    private readonly stateListeners = new Set<DownloadCenterStateListener>();

    constructor(repository = new DownloadJobRepository(), ownerId = crypto.randomUUID()) {
        this.repository = repository;
        this.ownerId = ownerId;
    }

    static getInstance(): DownloadCenterRunner {
        this.sharedInstance ??= new DownloadCenterRunner();
        return this.sharedInstance;
    }

    subscribe(listener: DownloadCenterStateListener): () => void {
        this.stateListeners.add(listener);
        listener(this.currentProgress, this.activeJobId !== null);
        return () => { this.stateListeners.delete(listener); };
    }

    get progress(): (BackupDownloadProgress & { jobId?: string }) | null {
        return this.currentProgress ? { ...this.currentProgress } : null;
    }

    get isRunning(): boolean { return this.activeJobId !== null; }

    recoverInterruptedJobs(): Promise<DownloadCenterJob[]> {
        if (!this.recoveryRequest) {
            this.recoveryRequest = this.findRecoverableJobs()
                .finally(() => { this.recoveryRequest = null; });
        }
        return this.recoveryRequest;
    }

    get runningJobId(): string | null { return this.activeJobId; }

    /** Read a job only after its run promise has settled; never call while active. */
    async loadSettledJob(jobId: string): Promise<DownloadCenterJob | undefined> {
        if (this.activeJobId === jobId) return undefined;
        return (await this.repository.loadJob<PersistedDownloadCenterOptions>(jobId))?.job;
    }

    async start(
        works: readonly BackupWorkDownloadItem[],
        state: BackupDownloadState,
        destination: DownloadDestination,
        title: string,
        onProgress?: DownloadCenterProgressListener,
    ): Promise<DownloadCenterRunResult> {
        if (this.activeJobId) throw new DownloadCenterRunError('already-running');
        const selected = new Set(state.selectedWorkIds.map(String));
        const snapshots = works.filter(work => selected.has(String(work.id))).map(work => ({
            ...work,
            playlistIds: work.playlistIds ? [...work.playlistIds] : undefined,
        }));
        const jobId = crypto.randomUUID();
        let options = cloneOptions({
            state,
            destination,
            enrichment: {},
            opusOutputPaths: {},
            exportedFolders: [],
            discovery: {
                works: snapshots,
                nextIndex: 0,
                skippedWorkIds: [],
                titlesReady: !titleModeNeedsTranslation(state),
                complete: false,
            },
        });
        await this.repository.createJob({ id: jobId, title, options }, []);
        return this.runClaimed(jobId, options, onProgress);
    }

    async resume(
        job: DownloadCenterJob,
        onProgress?: DownloadCenterProgressListener,
        resumeOptions: DownloadCenterResumeOptions = {},
    ): Promise<DownloadCenterRunResult> {
        if (this.activeJobId) throw new DownloadCenterRunError('already-running');
        const sink = await createDownloadSink(resolvePersistedDestination(job.options));
        if (!await sink.ensurePermission(true)) throw new DownloadCenterRunError('permission');
        return this.runClaimed(job.id, job.options, onProgress, sink, resumeOptions);
    }

    async pause(): Promise<void> {
        if (!this.activeJobId) return;
        this.pauseRequestedJobs.add(this.activeJobId);
        if (this.activeCoordinator) await this.activeCoordinator.pause(this.activeJobId);
    }

    private async runClaimed(
        jobId: string,
        initialOptions: PersistedDownloadCenterOptions,
        onProgress?: DownloadCenterProgressListener,
        sink?: DownloadSink,
        resumeOptions: DownloadCenterResumeOptions = {},
    ): Promise<DownloadCenterRunResult> {
        return this.withBrowserJobLock(jobId, async () => {
            if (!await this.repository.claimJob(jobId, this.ownerId, DOWNLOAD_JOB_LEASE_MS)) {
                throw new DownloadCenterRunError('already-running');
            }
            this.activeJobId = jobId;
            this.pauseRequestedJobs.delete(jobId);
            this.leaseLost = false;
            this.currentProgress = {
                jobId,
                phase: 'recovering',
                current: initialOptions.discovery?.nextIndex ?? 0,
                total: initialOptions.discovery?.works.length ?? 0,
            };
            this.startHeartbeat(jobId);
            this.notifyState();
            const report: DownloadCenterProgressListener = next => {
                this.currentProgress = { ...next };
                this.notifyState();
                onProgress?.(next);
            };
            try {
                const snapshot = await this.repository.loadJob<PersistedDownloadCenterOptions>(jobId);
                let persistedOptions = snapshot?.job.options ?? initialOptions;
                let resumeOptionsChanged = false;
                if (resumeOptions.disableOpus && persistedOptions.state.convertToOpus) {
                    persistedOptions = cloneOptions({
                        ...persistedOptions,
                        state: { ...persistedOptions.state, convertToOpus: false },
                        opusOutputPaths: {},
                    });
                    resumeOptionsChanged = true;
                }
                const discovery = persistedOptions.discovery;
                if (
                    resumeOptions.useOriginalTitles
                    && discovery
                    && !discovery.titlesReady
                    && discovery.nextIndex === 0
                    && titleModeNeedsTranslation(persistedOptions.state)
                ) {
                    persistedOptions = cloneOptions({
                        ...persistedOptions,
                        state: { ...persistedOptions.state, titleMode: 'original' },
                        discovery: { ...discovery, titlesReady: true },
                    });
                    resumeOptionsChanged = true;
                }
                if (resumeOptionsChanged) {
                    await this.repository.appendFilesAndUpdateOptions(jobId, persistedOptions, []);
                }
                const outcome = await this.prepareAndRun(jobId, persistedOptions, report, sink);
                return {
                    jobId,
                    skipped: outcome.options.discovery?.skippedWorkIds.length ?? 0,
                    exportFailures: outcome.exportFailures,
                    skippedFiles: outcome.skippedFiles ?? 0,
                };
            } catch (error) {
                const normalized = this.leaseLost && !(error instanceof DownloadCenterRunError)
                    ? new DownloadCenterRunError('paused', error)
                    : error;
                const paused = normalized instanceof DownloadCenterRunError
                    && (normalized.code === 'paused' || normalized.code === 'title-translation');
                this.currentProgress = {
                    ...(this.currentProgress ?? { jobId, current: 0, total: 0 }),
                    jobId,
                    phase: paused ? 'paused' : 'failed',
                };
                this.notifyState();
                throw normalized;
            } finally {
                this.stopHeartbeat();
                await this.repository.pauseJob(jobId, this.ownerId).catch(() => false);
                this.activeJobId = null;
                this.activeCoordinator = null;
                this.pauseRequestedJobs.delete(jobId);
                this.notifyState();
            }
        });
    }

    private async prepareAndRun(
        jobId: string,
        initialOptions: PersistedDownloadCenterOptions,
        onProgress?: DownloadCenterProgressListener,
        existingSink?: DownloadSink,
    ): Promise<{ options: PersistedDownloadCenterOptions; exportFailures: number; skippedFiles?: number }> {
        const destination = resolvePersistedDestination(initialOptions);
        const sink = existingSink ?? await createDownloadSink(destination);
        let options = await this.ensureTitles(jobId, initialOptions, onProgress);
        options = await this.continueDiscovery(jobId, options, onProgress, sink);
        const files = await this.repository.listFiles(jobId);
        if (!files.length) {
            await this.repository.deleteJob(jobId);
            throw new DownloadCenterRunError('no-files');
        }
        const exporter = requiresDownloadExport(destination)
            ? new DownloadFolderExporter(sink, destination)
            : undefined;
        const coordinator = new DownloadCoordinator(
            this.repository,
            new DownloadTransport(),
            sink,
            // ffmpeg.wasm keeps input/output copies in memory. Serial Opus
            // conversion prevents two large source buffers being resident.
            options.state.convertToOpus ? 1 : 3,
            this.createOpusTransformer(options),
            this.ownerId,
        );
        this.activeCoordinator = coordinator;
        const exportTracker = exporter
            ? this.createExportTracker(jobId, files, exporter, () => options, next => { options = next; })
            : undefined;
        const completed = new Set(files.filter(file => file.status === 'completed').map(file => file.id));
        const bytes = new Map(files.map(file => [file.id, file.downloadedBytes]));
        const totals = new Map(files.filter(file => file.totalBytes != null).map(file => [file.id, file.totalBytes as number]));
        const labels = new Map(files.map(file => [file.id, file.path]));
        let completedBytes = files.reduce((sum, file) => sum + file.downloadedBytes, 0);
        let knownTotalBytes = files.reduce((sum, file) => sum + (file.totalBytes ?? 0), 0);
        let knownTotalCount = totals.size;
        const notify = (progress: DownloadCoordinatorProgress): void => {
            const previousBytes = bytes.get(progress.fileId) ?? 0;
            bytes.set(progress.fileId, progress.completedBytes);
            completedBytes += progress.completedBytes - previousBytes;
            if (progress.totalBytes != null) {
                const previousTotal = totals.get(progress.fileId);
                if (previousTotal == null) knownTotalCount += 1;
                else knownTotalBytes -= previousTotal;
                totals.set(progress.fileId, progress.totalBytes);
                knownTotalBytes += progress.totalBytes;
            }
            if (progress.status === 'complete') {
                completed.add(progress.fileId);
                exportTracker?.fileCompleted(progress.fileId);
            }
            onProgress?.({
                jobId,
                phase: progress.status === 'paused'
                    ? 'paused'
                    : progress.status === 'converting' ? 'converting' : 'downloading',
                current: completed.size,
                total: files.length,
                completedBytes,
                totalBytes: knownTotalCount === files.length ? knownTotalBytes : undefined,
                conversionRatio: progress.conversionRatio,
                label: labels.get(progress.fileId) ?? progress.fileId,
            });
        };
        onProgress?.({ jobId, phase: 'downloading', current: completed.size, total: files.length });
        await coordinator.run(jobId, notify);
        exportTracker?.startPending();
        // Exports are already-downloaded bytes leaving the staging area. Let
        // them settle before any pause/failure is reported so a paused job
        // still hands over every work folder it finished.
        const exportFailures = (await exportTracker?.settle()) ?? 0;
        const finalFiles = await this.repository.listFiles(jobId);
        if (!finalFiles.every(file => file.status === 'completed')) {
            const failedFiles = finalFiles.filter(file => file.error);
            if (failedFiles.length) {
                for (const file of failedFiles) {
                    Logger.warn('[DownloadCenter] File download failed', file.path, file.error);
                }
                // One unreadable or unconvertible file must not destroy a whole
                // multi-work job. A 32-file run that died at file 7 and reported
                // only "Work download failed" was the single worst reported
                // downloader behaviour. Failed files keep their error and stay
                // resumable; the run reports how many were skipped.
                const completedFiles = finalFiles.filter(file => file.status === 'completed');
                if (!completedFiles.length) {
                    const first = failedFiles[0];
                    throw new DownloadCenterRunError(
                        'failed',
                        new Error(`${first.path}: ${first.error}`),
                    );
                }
                onProgress?.({ jobId, phase: 'complete', current: completedFiles.length, total: finalFiles.length });
                return { options, exportFailures, skippedFiles: failedFiles.length };
            }
            throw new DownloadCenterRunError('paused');
        }
        onProgress?.({ jobId, phase: 'complete', current: finalFiles.length, total: finalFiles.length });
        return { options, exportFailures, skippedFiles: 0 };
    }

    /**
     * Hands each work folder to the browser as soon as its last file lands, so
     * a long multi-work job delivers progressively instead of only at the end.
     * Successful exports are checkpointed to keep resume idempotent.
     */
    private createExportTracker(
        jobId: string,
        files: readonly DownloadFile[],
        exporter: DownloadFolderExporter,
        readOptions: () => PersistedDownloadCenterOptions,
        writeOptions: (options: PersistedDownloadCenterOptions) => void,
    ): {
        fileCompleted: (fileId: string) => void;
        startPending: () => void;
        settle: () => Promise<number>;
    } {
        const folderOf = (path: string): string => path.split('/')[0] ?? '';
        const folders = new Set<string>();
        const remaining = new Map<string, number>();
        const fileFolders = new Map<string, string>();
        for (const file of files) {
            const folder = folderOf(file.path);
            if (!folder) continue;
            fileFolders.set(file.id, folder);
            folders.add(folder);
            if (file.status !== 'completed') remaining.set(folder, (remaining.get(folder) ?? 0) + 1);
        }
        // Paths are read back at export time rather than from this snapshot:
        // Opus conversion rewrites a file's path when it completes.
        const currentFolderPaths = async (folder: string): Promise<string[]> => (await this.repository.listFiles(jobId))
            .filter(file => file.status === 'completed' && folderOf(file.path) === folder)
            .map(file => file.path);
        const exported = new Set(readOptions().exportedFolders ?? []);
        const attempted = new Set(exported);
        let chain: Promise<void> = Promise.resolve();
        let failures = 0;
        const enqueue = (folder: string): void => {
            if (attempted.has(folder)) return;
            attempted.add(folder);
            chain = chain.then(async () => {
                const result = await exporter.exportFolder(folder, await currentFolderPaths(folder));
                if (!result.exported) {
                    failures += 1;
                    return;
                }
                exported.add(folder);
                const next = cloneOptions({ ...readOptions(), exportedFolders: [...exported] });
                writeOptions(next);
                await this.repository.appendFilesAndUpdateOptions(jobId, next, [])
                    .catch(error => Logger.warn('[DownloadCenter] Could not record exported folder', folder, error));
            });
        };
        return {
            fileCompleted: fileId => {
                const folder = fileFolders.get(fileId);
                if (!folder) return;
                const left = (remaining.get(folder) ?? 0) - 1;
                remaining.set(folder, left);
                if (left <= 0) enqueue(folder);
            },
            // Folders finished by an earlier run that stopped before exporting.
            startPending: () => {
                for (const folder of folders) {
                    if ((remaining.get(folder) ?? 0) <= 0) enqueue(folder);
                }
            },
            settle: async () => {
                let settled: Promise<void> | undefined;
                while (settled !== chain) { settled = chain; await settled; }
                return failures;
            },
        };
    }

    private async ensureTitles(
        jobId: string,
        options: PersistedDownloadCenterOptions,
        onProgress?: DownloadCenterProgressListener,
    ): Promise<PersistedDownloadCenterOptions> {
        const discovery = options.discovery;
        if (!discovery || discovery.titlesReady || !titleModeNeedsTranslation(options.state)) return options;
        let works = discovery.works.map(work => ({ ...work }));
        const target = TranslationService.getUiTargetLang();
        const missingIndexes = works
            .map((work, index) => ({ work, index }))
            .filter(({ work }) => !workHasTitleTranslation(work, target))
            .map(({ index }) => index);
        let resolvedCount = works.length - missingIndexes.length;
        let checkpointed = false;
        onProgress?.({ jobId, phase: 'translating', current: resolvedCount, total: works.length });

        const checkpoint = async (): Promise<void> => {
            const titlesReady = works.every(work => workHasTitleTranslation(work, target));
            options = cloneOptions({
                ...options,
                discovery: { ...discovery, works, titlesReady },
            });
            await this.assertLease(jobId);
            await this.repository.appendFilesAndUpdateOptions(jobId, options, []);
            checkpointed = true;
        };

        for (let offset = 0; offset < missingIndexes.length; offset += DOWNLOAD_TITLE_TRANSLATION_BATCH_SIZE) {
            const indexes = missingIndexes.slice(offset, offset + DOWNLOAD_TITLE_TRANSLATION_BATCH_SIZE);
            const batch = indexes.map(index => works[index]);
            const cancellableKey = `download-titles:${jobId}:${offset}`;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const timedOut = Symbol('translation-timeout');
            try {
                const translation = resolveDownloadWorkTranslations(batch, options.state.titleMode, texts =>
                    TranslationService.translateBatch(texts, target, {
                        preserveRequestedTarget: true,
                        cancellable: true,
                        cancellableKey,
                    }));
                const result = await Promise.race([
                    translation,
                    new Promise<typeof timedOut>(resolve => {
                        timer = setTimeout(() => resolve(timedOut), DOWNLOAD_OPTIONAL_TRANSLATION_WAIT_MS);
                    }),
                ]);
                if (result === timedOut) {
                    TranslationService.cancelPending({ cancellableKey });
                    Logger.warn('[DownloadCenter] Title translation timed out; remaining titles will retry on resume');
                    break;
                }
                result.forEach((work, batchIndex) => {
                    works[indexes[batchIndex]] = work;
                });
                resolvedCount = works.filter(work => workHasTitleTranslation(work, target)).length;
                await checkpoint();
                onProgress?.({ jobId, phase: 'translating', current: resolvedCount, total: works.length });
            } catch (error) {
                TranslationService.cancelPending({ cancellableKey });
                Logger.warn('[DownloadCenter] Title translation unavailable; remaining titles will retry on resume', error);
                break;
            } finally {
                if (timer) clearTimeout(timer);
            }
        }

        // Preserve the retryable false state even when the first batch stalls.
        // Successful batches checkpoint themselves so a refresh loses no work.
        if (!checkpointed) await checkpoint();
        if (!options.discovery?.titlesReady) {
            throw new DownloadCenterRunError(
                'title-translation',
                new Error(I18n.t('backupDownloaderTitleTranslationRequired')),
            );
        }
        return options;
    }

    private async continueDiscovery(
        jobId: string,
        initialOptions: PersistedDownloadCenterOptions,
        onProgress?: DownloadCenterProgressListener,
        existingSink?: DownloadSink,
    ): Promise<PersistedDownloadCenterOptions> {
        let options = initialOptions;
        let discovery = options.discovery;
        if (!discovery || discovery.complete) return options;
        const existingFiles = await this.repository.listFiles(jobId);
        const occupiedWorkFolders = new Set(existingFiles
            .map(file => file.path.split('/')[0])
            .filter(Boolean)
            .map(folder => canonicalDownloadPath([folder])));
        const sink = existingSink ?? await createDownloadSink(resolvePersistedDestination(options));
        const existingRootEntries = await sink.listTopLevelEntryNames();
        for (const entry of existingRootEntries) occupiedWorkFolders.add(canonicalDownloadPath([entry]));
        let pendingFiles: Array<{ id: string; path: string; url: string; sourceUrls?: string[]; totalBytes?: number }> = [];
        const enrichOpusFiles = options.state.convertToOpus;
        const enrichment = enrichOpusFiles ? { ...options.enrichment } : {};
        const skippedWorkIds = [...discovery.skippedWorkIds];
        const skippedWorkIdSet = new Set(skippedWorkIds.map(String));
        const markWorkUnavailable = (workId: string | number): void => {
            const normalized = String(workId);
            if (skippedWorkIdSet.has(normalized)) return;
            skippedWorkIdSet.add(normalized);
            skippedWorkIds.push(normalized);
        };
        const manifestRequests = new Map<number, Promise<{
            tracks: Awaited<ReturnType<typeof WorkService.getValidatedLiveTracks>>;
            info: Awaited<ReturnType<typeof WorkService.getWorkInfo>> | null;
        }>>();
        const prefetchManifest = (index: number): void => {
            if (index >= discovery!.works.length || manifestRequests.has(index)) return;
            const work = discovery!.works[index];
            const request = Promise.all([
                WorkService.getValidatedLiveTracks(work.id, { cacheFallback: 'none' }),
                optionalWorkInfo(work.id, this.optionalMetadataRequests),
            ]).then(([tracks, info]) => ({ tracks, info }));
            // A pause can leave speculative requests unconsumed. Attach a
            // handler immediately while preserving rejection for ordered await.
            void request.catch(() => undefined);
            manifestRequests.set(index, request);
        };
        for (let index = discovery.nextIndex; index < discovery.works.length; index += 1) {
            await this.assertLease(jobId);
            const work = discovery.works[index];
            onProgress?.({ jobId, phase: 'discovering', current: index, total: discovery.works.length, label: work.title });
            const newFiles: Array<{ id: string; path: string; url: string; sourceUrls?: string[]; totalBytes?: number }> = [];
            const workEnrichment: Record<string, DownloadEnrichment> = {};
            let workFailure: unknown;
            try {
                // Fetch several work manifests concurrently, then consume them
                // in source order so folder names and resume checkpoints remain
                // deterministic.
                for (let ahead = 0; ahead < DOWNLOAD_DISCOVERY_CONCURRENCY; ahead += 1) {
                    prefetchManifest(index + ahead);
                }
                const request = manifestRequests.get(index);
                if (!request) throw new Error(`Could not prepare work ${String(work.id)}`);
                const { tracks, info } = await request;
                manifestRequests.delete(index);
                const manifest = discoverDownloadManifest(tracks as unknown as DownloadTreeNode[]);
                const folder = reserveCollisionFreePath([resolvedWorkFolder(work, options.state)], occupiedWorkFolders)[0];
                const occupiedRelativePaths = new Set<string>();
                let hasCoverImage = false;
                const artworkUrl = info?.mainCoverUrl
                    || info?.thumbnailCoverUrl
                    || info?.samCoverUrl
                    || work.coverUrl;
                for (const entry of manifest.entries) {
                    reserveManifestPath(occupiedRelativePaths, entry.relativePath);
                    const category = entry.category === 'unknown' ? 'other' : entry.category;
                    if (category === 'image' && entry.primaryUrl && /(?:^|[\/_. -])(?:cover|main|folder|thumb)/i.test(entry.relativePath.at(-1) || entry.sourceTitle)) {
                        hasCoverImage = true;
                    }
                    if (!options.state.filters[category]) continue;
                    const fullQualitySources = entry.sourceUrls
                        .filter(source => source.kind !== 'low-quality-stream');
                    const primarySource = fullQualitySources
                        .find(source => source.url === entry.primaryUrl)
                        ?? fullQualitySources[0];
                    if (!primarySource) {
                        throw new Error(`Missing full-quality source: ${entry.sourcePath.join('/')}`);
                    }
                    const id = `${jobId}:${work.id}:${entry.id}`;
                    const path = [folder, ...entry.relativePath].join('/');
                    const sourceUrls = fullQualitySources
                        .map(source => source.url)
                        .filter((url, sourceIndex, urls) => url !== primarySource.url && urls.indexOf(url) === sourceIndex);
                    newFiles.push({
                        id,
                        path,
                        url: primarySource.url,
                        sourceUrls: sourceUrls.length ? sourceUrls : undefined,
                        totalBytes: entry.size,
                    });
                    const filename = entry.relativePath.at(-1) || entry.sourceTitle;
                    if (enrichOpusFiles) {
                        workEnrichment[id] = {
                            tags: {
                                title: filename.replace(/\.[^.]+$/, ''),
                                album: folder,
                                artist: info?.vas?.map(va => va.name).filter(Boolean) || [],
                                albumartist: info?.circle?.name || info?.name || '',
                                genre: info?.tags?.map(tag => tag.name).filter(Boolean) || [],
                                date: info?.release || '',
                                website: info?.source_url || (info?.source_id ? `https://www.dlsite.com/maniax/work/=/product_id/${info.source_id}.html` : ''),
                                circle_id: String(info?.circle_id || ''),
                                age_rating: info?.age_category_string || '',
                            },
                            artworkUrl,
                        };
                    }
                }
                if (options.state.filters.image && options.state.includeArtwork && !hasCoverImage && artworkUrl) {
                    const coverName = reserveCollisionFreePath(['cover.jpg'], occupiedRelativePaths)[0];
                    newFiles.push({
                        id: `${jobId}:${work.id}:generated-cover`,
                        path: [folder, coverName].join('/'),
                        url: artworkUrl,
                    });
                }
                if (enrichOpusFiles) Object.assign(enrichment, workEnrichment);
            } catch (error) {
                // Lease loss and pause requests are job-level and must abort.
                if (error instanceof DownloadCenterRunError) throw error;
                workFailure = error;
            }
            if (workFailure !== undefined) {
                // One unreadable manifest must not destroy a multi-work run.
                // The work is recorded as skipped and reported at the end; no
                // file or metadata from it enters the resumable job.
                markWorkUnavailable(work.id);
                Logger.warn(
                    isUnavailableWorkFailure(workFailure)
                        ? '[DownloadCenter] Skipping unavailable work'
                        : '[DownloadCenter] Skipping work whose file list could not be read',
                    String(work.id),
                    workFailure,
                );
            } else {
                pendingFiles.push(...newFiles);
            }
            const completedInBatch = index - discovery.nextIndex + 1;
            const pauseRequested = this.pauseRequestedJobs.has(jobId);
            const checkpointDue = pauseRequested
                || completedInBatch >= DOWNLOAD_DISCOVERY_BATCH_SIZE
                || index === discovery.works.length - 1;
            if (!checkpointDue) continue;
            discovery = { ...discovery, nextIndex: index + 1, skippedWorkIds: [...skippedWorkIds] };
            options = cloneOptions({ ...options, enrichment, discovery });
            // A pause requested while this work was loading still permits one
            // final atomic batch commit; the job remains leased until it lands.
            await this.assertLease(jobId, pauseRequested);
            await this.repository.appendFilesAndUpdateOptions(jobId, options, pendingFiles);
            pendingFiles = [];
            if (pauseRequested) throw new DownloadCenterRunError('paused');
        }
        const allFiles = await this.repository.listFiles(jobId);
        options = cloneOptions({
            ...options,
            opusOutputPaths: options.state.convertToOpus ? planOpusOutputPaths(allFiles) : {},
            discovery: { ...discovery, complete: true },
        });
        await this.assertLease(jobId);
        await this.repository.appendFilesAndUpdateOptions(jobId, options, []);
        return options;
    }

    private async assertLease(jobId: string, allowPauseForCheckpoint = false): Promise<void> {
        if (!allowPauseForCheckpoint && this.pauseRequestedJobs.has(jobId)) throw new DownloadCenterRunError('paused');
        if (this.leaseLost || !await this.repository.renewJobLease(jobId, this.ownerId, DOWNLOAD_JOB_LEASE_MS)) {
            this.leaseLost = true;
            throw new DownloadCenterRunError('paused');
        }
    }

    private startHeartbeat(jobId: string): void {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (this.heartbeatPending || this.activeJobId !== jobId) return;
            this.heartbeatPending = true;
            void this.repository.renewJobLease(jobId, this.ownerId, DOWNLOAD_JOB_LEASE_MS)
                .then(renewed => {
                    if (renewed) return;
                    this.leaseLost = true;
                    if (this.activeCoordinator) void this.activeCoordinator.pause(jobId);
                })
                .catch(error => Logger.warn('[DownloadCenter] Could not renew download lease', error))
                .finally(() => { this.heartbeatPending = false; });
        }, Math.floor(DOWNLOAD_JOB_LEASE_MS / 4));
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        this.heartbeatPending = false;
    }

    private notifyState(): void {
        for (const listener of this.stateListeners) {
            try { listener(this.progress, this.activeJobId !== null); }
            catch (error) { Logger.warn('[DownloadCenter] State listener failed', error); }
        }
    }

    private async findRecoverableJobs(): Promise<DownloadCenterJob[]> {
        let jobs = await this.repository.listJobs<PersistedDownloadCenterOptions>();
        const active = jobs.filter(job => job.status === 'active');
        if (active.length && this.browserLocks()) {
            await Promise.all(active.map(job => this.recoverUnlockedJob(job.id)));
            jobs = await this.repository.listJobs<PersistedDownloadCenterOptions>();
        }
        return jobs.filter(job => job.status === 'pending' || job.status === 'paused' || job.status === 'failed');
    }

    private browserLocks(): LockManager | undefined {
        return typeof navigator !== 'undefined' ? navigator.locks : undefined;
    }

    private lockName(jobId: string): string { return `asmr-one-download:${jobId}`; }

    private async recoverUnlockedJob(jobId: string): Promise<void> {
        const locks = this.browserLocks();
        if (!locks) return;
        await locks.request(this.lockName(jobId), { mode: 'exclusive', ifAvailable: true }, async lock => {
            if (lock) await this.repository.recoverActiveJob(jobId);
        });
    }

    private async withBrowserJobLock<T>(jobId: string, operation: () => Promise<T>): Promise<T> {
        const locks = this.browserLocks();
        if (!locks) return operation();
        return locks.request(this.lockName(jobId), { mode: 'exclusive', ifAvailable: true }, async lock => {
            if (!lock) throw new DownloadCenterRunError('already-running');
            return operation();
        });
    }

    private createOpusTransformer(options: PersistedDownloadCenterOptions): OpusFileTransformer | undefined {
        if (!options.state.convertToOpus) return undefined;
        let artworkCache: {
            url: string;
            request: Promise<EmbeddedArtwork | undefined>;
        } | undefined;
        const loadArtwork = (url: string, signal?: AbortSignal): Promise<EmbeddedArtwork | undefined> => {
            if (artworkCache?.url === url) return artworkCache.request;
            const request = fetchBoundedArtwork(url, signal);
            artworkCache = { url, request };
            void request.then(result => {
                if (!result && artworkCache?.request === request) artworkCache = undefined;
            });
            return request;
        };
        const device = DeviceCapabilities.profile;
        return new OpusFileTransformer(new FfmpegOpusTranscoder(), {
            enabled: true,
            bitrateKbps: options.state.opusBitrate,
            metadataPolicy: options.state.metadataMode,
            memoryBudget: getOpusConversionMemoryBudget({
                deviceMemoryGiB: device.memory,
                isMobile: device.isMobile,
            }),
            tagsForFile: file => options.enrichment[file.id]?.tags || {},
            outputPathForFile: file => options.opusOutputPaths?.[file.id],
            artworkForFile: async (file, signal): Promise<EmbeddedArtwork | undefined> => {
                if (!options.state.includeArtwork) return undefined;
                const url = options.enrichment[file.id]?.artworkUrl;
                return url ? loadArtwork(url, signal) : undefined;
            },
        });
    }
}
