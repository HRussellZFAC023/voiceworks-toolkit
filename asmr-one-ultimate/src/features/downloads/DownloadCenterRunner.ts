import { Logger } from '../../core/Utils';
import { TranslationService } from '../../services/TranslationService';
import { WorkService } from '../../services/WorkService';
import type { BackupDownloadProgress, BackupDownloadState, BackupWorkDownloadItem } from '../backupWorkDownloaderTypes';
import { resolveDownloadWorkTranslations } from '../backupWorkDownloaderUtils';
import { canonicalDownloadPath, reserveCollisionFreePath } from './DownloadPathUtils';
import { DirectoryDownloadSink } from './DirectoryDownloadSink';
import { discoverDownloadManifest, type DownloadTreeNode } from './DownloadManifest';
import { DOWNLOAD_JOB_LEASE_MS, DownloadJobRepository, type DownloadJob } from './DownloadJobRepository';
import { DownloadTransport } from './DownloadTransport';
import { DownloadCoordinator, type DownloadCoordinatorProgress } from './DownloadCoordinator';
import { FfmpegOpusTranscoder } from './OpusTranscoder';
import { OpusFileTransformer, planOpusOutputPaths } from './OpusFileTransformer';
import type { AudioTags, EmbeddedArtwork } from './MetadataPolicy';

interface DownloadEnrichment { tags: AudioTags; artworkUrl?: string }
export const DOWNLOAD_DISCOVERY_BATCH_SIZE = 8;

export interface PersistedDownloadDiscovery {
    works: BackupWorkDownloadItem[];
    nextIndex: number;
    skippedWorkIds: string[];
    titlesReady: boolean;
    complete: boolean;
}

export interface PersistedDownloadCenterOptions {
    state: BackupDownloadState;
    directory: FileSystemDirectoryHandle;
    enrichment: Record<string, DownloadEnrichment>;
    opusOutputPaths?: Record<string, string>;
    discovery?: PersistedDownloadDiscovery;
}

export type DownloadCenterJob = DownloadJob<PersistedDownloadCenterOptions>;
export type DownloadCenterProgressListener = (progress: BackupDownloadProgress & { jobId?: string }) => void;
export type DownloadCenterStateListener = (
    progress: (BackupDownloadProgress & { jobId?: string }) | null,
    running: boolean,
) => void;

export class DownloadCenterRunError extends Error {
    constructor(public readonly code: 'unsupported' | 'permission' | 'no-files' | 'paused' | 'already-running' | 'failed', cause?: unknown) {
        super(code);
        this.name = 'DownloadCenterRunError';
        if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
    }
}

function cloneOptions(options: PersistedDownloadCenterOptions): PersistedDownloadCenterOptions {
    const { directory, ...serializable } = options;
    return {
        ...(JSON.parse(JSON.stringify(serializable)) as Omit<PersistedDownloadCenterOptions, 'directory'>),
        directory,
    };
}

function titleModeNeedsTranslation(state: BackupDownloadState): boolean {
    return state.titleMode === 'translated' || state.titleMode === 'original-bracketed-translation';
}

function resolvedWorkFolder(work: BackupWorkDownloadItem, state: BackupDownloadState): string {
    const original = work.title || String(work.id);
    const translated = work.translatedTitle && work.translatedTitle !== original ? work.translatedTitle : '';
    if (state.titleMode === 'translated') return translated || original;
    if (state.titleMode === 'original-bracketed-translation') return translated ? `${original} [${translated}]` : original;
    if (state.titleMode === 'none') return String(work.id);
    return original;
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
        directory: FileSystemDirectoryHandle,
        title: string,
        onProgress?: DownloadCenterProgressListener,
    ): Promise<{ jobId: string; skipped: number }> {
        if (this.activeJobId) throw new DownloadCenterRunError('already-running');
        const selected = new Set(state.selectedWorkIds.map(String));
        const snapshots = works.filter(work => selected.has(String(work.id))).map(work => ({
            ...work,
            playlistIds: work.playlistIds ? [...work.playlistIds] : undefined,
        }));
        const jobId = crypto.randomUUID();
        let options = cloneOptions({
            state,
            directory,
            enrichment: {},
            opusOutputPaths: {},
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

    async resume(job: DownloadCenterJob, onProgress?: DownloadCenterProgressListener): Promise<{ jobId: string; skipped: number }> {
        if (this.activeJobId) throw new DownloadCenterRunError('already-running');
        const sink = new DirectoryDownloadSink(job.options.directory);
        if (!await sink.ensurePermission(true)) throw new DownloadCenterRunError('permission');
        return this.runClaimed(job.id, job.options, onProgress, sink);
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
        sink?: DirectoryDownloadSink,
    ): Promise<{ jobId: string; skipped: number }> {
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
                const options = await this.prepareAndRun(jobId, snapshot?.job.options ?? initialOptions, report, sink);
                return { jobId, skipped: options.discovery?.skippedWorkIds.length ?? 0 };
            } catch (error) {
                const normalized = this.leaseLost && !(error instanceof DownloadCenterRunError)
                    ? new DownloadCenterRunError('paused', error)
                    : error;
                const paused = normalized instanceof DownloadCenterRunError && normalized.code === 'paused';
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
        existingSink?: DirectoryDownloadSink,
    ): Promise<PersistedDownloadCenterOptions> {
        let options = await this.ensureTitles(jobId, initialOptions, onProgress);
        options = await this.continueDiscovery(jobId, options, onProgress);
        const files = await this.repository.listFiles(jobId);
        if (!files.length) {
            await this.repository.deleteJob(jobId);
            throw new DownloadCenterRunError('no-files');
        }
        const sink = existingSink ?? new DirectoryDownloadSink(options.directory);
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
        const completed = new Set(files.filter(file => file.status === 'completed').map(file => file.id));
        const bytes = new Map(files.map(file => [file.id, file.downloadedBytes]));
        const totals = new Map(files.filter(file => file.totalBytes != null).map(file => [file.id, file.totalBytes as number]));
        const labels = new Map(files.map(file => [file.id, file.path]));
        const notify = (progress: DownloadCoordinatorProgress): void => {
            bytes.set(progress.fileId, progress.completedBytes);
            if (progress.totalBytes != null) totals.set(progress.fileId, progress.totalBytes);
            if (progress.status === 'complete') completed.add(progress.fileId);
            onProgress?.({
                jobId,
                phase: progress.status === 'paused'
                    ? 'paused'
                    : progress.status === 'converting' ? 'converting' : 'downloading',
                current: completed.size,
                total: files.length,
                completedBytes: [...bytes.values()].reduce((sum, value) => sum + value, 0),
                totalBytes: totals.size === files.length ? [...totals.values()].reduce((sum, value) => sum + value, 0) : undefined,
                conversionRatio: progress.conversionRatio,
                label: labels.get(progress.fileId) ?? progress.fileId,
            });
        };
        onProgress?.({ jobId, phase: 'downloading', current: completed.size, total: files.length });
        await coordinator.run(jobId, notify);
        const finalFiles = await this.repository.listFiles(jobId);
        if (!finalFiles.every(file => file.status === 'completed')) {
            const error = finalFiles.find(file => file.error)?.error;
            if (error) Logger.warn('[DownloadCenter] File download failed', error);
            throw new DownloadCenterRunError(error ? 'failed' : 'paused', error);
        }
        onProgress?.({ jobId, phase: 'complete', current: finalFiles.length, total: finalFiles.length });
        return options;
    }

    private async ensureTitles(
        jobId: string,
        options: PersistedDownloadCenterOptions,
        onProgress?: DownloadCenterProgressListener,
    ): Promise<PersistedDownloadCenterOptions> {
        const discovery = options.discovery;
        if (!discovery || discovery.titlesReady || !titleModeNeedsTranslation(options.state)) return options;
        onProgress?.({ jobId, phase: 'translating', current: 0, total: discovery.works.length });
        let works = discovery.works;
        try {
            const target = TranslationService.getUiTargetLang();
            works = await resolveDownloadWorkTranslations(works, options.state.titleMode, texts =>
                TranslationService.translateBatch(texts, target, { preserveRequestedTarget: true }));
        } catch (error) {
            Logger.warn('[DownloadCenter] Title translation unavailable; using original titles', error);
        }
        const next = cloneOptions({ ...options, discovery: { ...discovery, works, titlesReady: true } });
        await this.assertLease(jobId);
        await this.repository.appendFilesAndUpdateOptions(jobId, next, []);
        return next;
    }

    private async continueDiscovery(
        jobId: string,
        initialOptions: PersistedDownloadCenterOptions,
        onProgress?: DownloadCenterProgressListener,
    ): Promise<PersistedDownloadCenterOptions> {
        let options = initialOptions;
        let discovery = options.discovery;
        if (!discovery || discovery.complete) return options;
        const existingFiles = await this.repository.listFiles(jobId);
        const occupiedWorkFolders = new Set(existingFiles
            .map(file => file.path.split('/')[0])
            .filter(Boolean)
            .map(folder => canonicalDownloadPath([folder])));
        const existingRootEntries = await new DirectoryDownloadSink(options.directory).listTopLevelEntryNames();
        for (const entry of existingRootEntries) occupiedWorkFolders.add(canonicalDownloadPath([entry]));
        let pendingFiles: Array<{ id: string; path: string; url: string; totalBytes?: number }> = [];
        const enrichment = { ...options.enrichment };
        const skippedWorkIds = [...discovery.skippedWorkIds];
        for (let index = discovery.nextIndex; index < discovery.works.length; index += 1) {
            await this.assertLease(jobId);
            const work = discovery.works[index];
            onProgress?.({ jobId, phase: 'discovering', current: index, total: discovery.works.length, label: work.title });
            const newFiles: Array<{ id: string; path: string; url: string; totalBytes?: number }> = [];
            try {
                const [tracks, info] = await Promise.all([
                    // A non-essential size preview may already own the shared
                    // in-flight request. Reuse fresh cache data, but never let
                    // that preview stall a user-started download.
                    WorkService.getTracks(work.id, false, true),
                    WorkService.getWorkInfo(work.id).catch(error => {
                        Logger.warn('[DownloadCenter] Optional work metadata unavailable; downloading files without enrichment', work.id, error);
                        return null;
                    }),
                ]);
                const manifest = discoverDownloadManifest(tracks as unknown as DownloadTreeNode[]);
                const folder = reserveCollisionFreePath([resolvedWorkFolder(work, options.state)], occupiedWorkFolders)[0];
                const occupiedRelativePaths = new Set<string>();
                let hasCoverImage = false;
                for (const entry of manifest.entries) {
                    occupiedRelativePaths.add(entry.relativePath.join('/').toLocaleLowerCase('en-US'));
                    const category = entry.category === 'unknown' ? 'other' : entry.category;
                    if (category === 'image' && entry.primaryUrl && /(?:^|[\/_. -])(?:cover|main|folder|thumb)/i.test(entry.relativePath.at(-1) || entry.sourceTitle)) {
                        hasCoverImage = true;
                    }
                    if (!options.state.filters[category] || !entry.primaryUrl) continue;
                    const id = `${jobId}:${work.id}:${entry.id}`;
                    const path = [folder, ...entry.relativePath].join('/');
                    newFiles.push({ id, path, url: entry.primaryUrl, totalBytes: entry.size });
                    const filename = entry.relativePath.at(-1) || entry.sourceTitle;
                    enrichment[id] = {
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
                        artworkUrl: info?.mainCoverUrl || info?.thumbnailCoverUrl || info?.samCoverUrl,
                    };
                }
                const generatedCoverUrl = info?.mainCoverUrl || info?.thumbnailCoverUrl || info?.samCoverUrl;
                if (options.state.filters.image && options.state.includeArtwork && !hasCoverImage && generatedCoverUrl) {
                    const coverName = reserveCollisionFreePath(['cover.jpg'], occupiedRelativePaths)[0];
                    newFiles.push({
                        id: `${jobId}:${work.id}:generated-cover`,
                        path: [folder, coverName].join('/'),
                        url: generatedCoverUrl,
                    });
                }
            } catch (error) {
                skippedWorkIds.push(String(work.id));
                Logger.warn('[DownloadCenter] Skipping unavailable work', String(work.id), error);
            }
            pendingFiles.push(...newFiles);
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
        const artworkCache = new Map<string, Promise<EmbeddedArtwork | undefined>>();
        const loadArtwork = (url: string): Promise<EmbeddedArtwork | undefined> => {
            const existing = artworkCache.get(url);
            if (existing) return existing;
            const request = fetch(url, { credentials: 'include' }).then(async response => {
                if (!response.ok) return undefined;
                return { mimeType: response.headers.get('content-type') || 'image/jpeg', data: new Uint8Array(await response.arrayBuffer()) };
            }).catch(() => undefined);
            artworkCache.set(url, request);
            return request;
        };
        return new OpusFileTransformer(new FfmpegOpusTranscoder(), {
            enabled: true,
            bitrateKbps: options.state.opusBitrate,
            metadataPolicy: options.state.metadataMode,
            tagsForFile: file => options.enrichment[file.id]?.tags || {},
            outputPathForFile: file => options.opusOutputPaths?.[file.id],
            artworkForFile: async (file): Promise<EmbeddedArtwork | undefined> => {
                if (!options.state.includeArtwork) return undefined;
                const url = options.enrichment[file.id]?.artworkUrl;
                return url ? loadArtwork(url) : undefined;
            },
        });
    }
}
