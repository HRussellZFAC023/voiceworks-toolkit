import { DirectoryDownloadSink, DirectoryPermissionError, ResumeOffsetMismatchError, type DownloadWriter } from './DirectoryDownloadSink';
import { DownloadJobRepository, type DownloadFile } from './DownloadJobRepository';
import { DownloadTransport, RangeRestartRequiredError } from './DownloadTransport';
import type { OpusFileTransformer } from './OpusFileTransformer';

export interface DownloadCoordinatorProgress {
    jobId: string;
    fileId: string;
    completedBytes: number;
    totalBytes?: number;
    status: 'downloading' | 'converting' | 'complete' | 'failed' | 'paused';
    conversionRatio?: number;
    error?: string;
}

export type DownloadProgressListener = (progress: DownloadCoordinatorProgress) => void;
// Closing a File System Access writer commits safely but may copy the partial
// file. Use coarse checkpoints to avoid quadratic I/O on large audio files.
const DURABLE_CHECKPOINT_INTERVAL = 64 * 1024 * 1024;
const RUNNING_JOB_IDS = new Set<string>();

export class DownloadAlreadyRunningError extends Error {
    constructor(jobId: string) {
        super(`Download job is already running: ${jobId}`);
        this.name = 'DownloadAlreadyRunningError';
    }
}

/** Lifecycle-independent runner: UI teardown does not own or erase the job. */
export class DownloadCoordinator {
    private readonly controllers = new Map<string, { jobId: string; controller: AbortController }>();
    private readonly stoppedJobs = new Set<string>();

    constructor(
        private readonly repository: DownloadJobRepository,
        private readonly transport: DownloadTransport,
        private readonly sink: DirectoryDownloadSink,
        private readonly concurrency = 2,
        private readonly transformer?: OpusFileTransformer,
        private readonly leaseOwnerId?: string,
    ) {}

    async run(jobId: string, onProgress?: DownloadProgressListener): Promise<void> {
        if (RUNNING_JOB_IDS.has(jobId)) throw new DownloadAlreadyRunningError(jobId);
        RUNNING_JOB_IDS.add(jobId);
        try {
            await this.runExclusive(jobId, onProgress);
        } finally {
            RUNNING_JOB_IDS.delete(jobId);
        }
    }

    private async runExclusive(jobId: string, onProgress?: DownloadProgressListener): Promise<void> {
        this.stoppedJobs.delete(jobId);
        if (this.leaseOwnerId) {
            if (!await this.repository.renewJobLease(jobId, this.leaseOwnerId)) {
                throw new DownloadAlreadyRunningError(jobId);
            }
        } else {
            await this.repository.activateJob(jobId);
        }
        const files = (await this.repository.listFiles(jobId))
            .filter(file => file.status !== 'completed' && file.status !== 'cancelled');
        let cursor = 0;
        const workers = Array.from({ length: Math.min(this.concurrency, files.length) }, async () => {
            for (;;) {
                if (this.stoppedJobs.has(jobId)) return;
                const index = cursor++;
                const file = files[index];
                if (!file) return;
                await this.downloadFile(file, onProgress);
            }
        });
        await Promise.all(workers);
        const finalFiles = await this.repository.listFiles(jobId);
        if (finalFiles.every(file => file.status === 'completed')) {
            if (this.leaseOwnerId) await this.repository.completeJob(jobId, this.leaseOwnerId);
            else await this.repository.completeJob(jobId);
        }
        else if (!finalFiles.every(file => file.status === 'completed' || file.status === 'cancelled')) {
            if (this.leaseOwnerId) await this.repository.pauseJob(jobId, this.leaseOwnerId);
            else await this.repository.pauseJob(jobId);
        }
    }

    pause(jobId: string): Promise<void> {
        this.stoppedJobs.add(jobId);
        for (const active of this.controllers.values()) {
            if (active.jobId === jobId) active.controller.abort('paused');
        }
        const result = this.leaseOwnerId
            ? this.repository.pauseJob(jobId, this.leaseOwnerId)
            : this.repository.pauseJob(jobId);
        return result.then(() => undefined);
    }

    cancel(jobId: string): Promise<void> {
        this.stoppedJobs.add(jobId);
        for (const active of this.controllers.values()) {
            if (active.jobId === jobId) active.controller.abort('cancelled');
        }
        const result = this.leaseOwnerId
            ? this.repository.cancelJob(jobId, this.leaseOwnerId)
            : this.repository.cancelJob(jobId);
        return result.then(() => undefined);
    }

    private async downloadFile(file: DownloadFile, onProgress?: DownloadProgressListener): Promise<void> {
        const controller = new AbortController();
        this.controllers.set(file.id, { jobId: file.jobId, controller });
        const path = file.path.split('/').filter(Boolean);
        let checkpoint: Awaited<ReturnType<DownloadJobRepository['getCheckpoint']>> = undefined;
        let writer: DownloadWriter | undefined;
        try {
            await this.repository.markFileActive(file.id);
            checkpoint = await this.repository.getCheckpoint(file.id);
            try {
                writer = await this.sink.open(path, checkpoint?.offset ?? 0);
            } catch (error) {
                if (!(error instanceof ResumeOffsetMismatchError)) throw error;
                await this.repository.resetFile(file.id);
                checkpoint = undefined;
                writer = await this.sink.open(path, 0);
            }
            const attempt = async (): Promise<number> => {
                let received = checkpoint?.offset ?? 0;
                let durableOffset = received;
                let lastValidator = {
                    etag: checkpoint?.etag,
                    lastModified: checkpoint?.lastModified,
                    totalBytes: file.totalBytes,
                };
                const commit = async (offset: number, reopen: boolean): Promise<void> => {
                    if (!writer) throw new Error('Download writer is unavailable');
                    // File System Access bytes are only guaranteed durable after close.
                    // Never let IndexedDB advertise an offset beyond committed disk data.
                    await writer.close();
                    writer = undefined;
                    await this.repository.checkpointFile(file.id, { offset, ...lastValidator });
                    durableOffset = offset;
                    if (reopen) writer = await this.sink.open(path, offset);
                };
                const probe = await this.transport.stream(file.url, received, async chunk => {
                    if (!writer) throw new Error('Download writer is unavailable');
                    await writer.write(chunk.bytes, chunk.offset);
                    received = chunk.offset + chunk.bytes.byteLength;
                    lastValidator = {
                        etag: chunk.etag,
                        lastModified: chunk.lastModified,
                        totalBytes: chunk.total,
                    };
                    if (received - durableOffset >= DURABLE_CHECKPOINT_INTERVAL) await commit(received, true);
                    onProgress?.({
                        jobId: file.jobId,
                        fileId: file.id,
                        completedBytes: received,
                        totalBytes: chunk.total ?? file.totalBytes,
                        status: 'downloading',
                    });
                }, {
                    signal: controller.signal,
                    expectedEtag: checkpoint?.etag,
                    expectedLastModified: checkpoint?.lastModified,
                });
                lastValidator = {
                    etag: probe.etag ?? lastValidator.etag,
                    lastModified: probe.lastModified ?? lastValidator.lastModified,
                    totalBytes: probe.size ?? lastValidator.totalBytes,
                };
                await commit(received, false);
                return received;
            };

            let total = file.totalBytes ?? checkpoint?.offset ?? 0;
            const sourceAlreadyDownloaded = file.sourceComplete === true;
            if (!sourceAlreadyDownloaded) {
                try {
                    total = await attempt();
                } catch (error) {
                    if (!(error instanceof RangeRestartRequiredError)) throw error;
                    await writer?.abort(error);
                    writer = undefined;
                    await this.repository.resetFile(file.id);
                    checkpoint = undefined;
                    writer = await this.sink.open(path, 0);
                    total = await attempt();
                }
            } else {
                await writer.close();
                writer = undefined;
            }
            await this.repository.markSourceComplete(file.id, total);
            let transformed: { path: string; bytes: number } | undefined;
            if (this.transformer?.shouldTransform(file)) {
                onProgress?.({ jobId: file.jobId, fileId: file.id, completedBytes: total, totalBytes: total, status: 'downloading' });
                transformed = await this.transformer.transform(
                    { ...file, downloadedBytes: total, totalBytes: total }, this.sink, controller.signal,
                    ratio => onProgress?.({
                        jobId: file.jobId,
                        fileId: file.id,
                        completedBytes: total,
                        totalBytes: total,
                        status: 'converting',
                        conversionRatio: ratio,
                    }),
                );
            }
            if (transformed) await this.repository.markFileComplete(file.id, total, transformed);
            else await this.repository.markFileComplete(file.id, total);
            // The Opus output and completed DB state are now durable. Source
            // cleanup is deliberately last: a crash can leave an extra source,
            // but can never strand a valid Opus file behind an incomplete job.
            if (transformed && transformed.path !== file.path) {
                await this.sink.remove(path).catch(() => undefined);
            }
            onProgress?.({ jobId: file.jobId, fileId: file.id, completedBytes: total, totalBytes: total, status: 'complete' });
        } catch (error) {
            await Promise.resolve(writer?.abort(error)).catch(() => undefined);
            if (controller.signal.aborted || error instanceof DirectoryPermissionError) {
                this.stoppedJobs.add(file.jobId);
                onProgress?.({ jobId: file.jobId, fileId: file.id, completedBytes: checkpoint?.offset ?? 0, status: 'paused' });
                return;
            }
            const message = error instanceof Error ? error.message : String(error);
            await this.repository.markFileFailed(file.id, message);
            onProgress?.({ jobId: file.jobId, fileId: file.id, completedBytes: checkpoint?.offset ?? 0, status: 'failed', error: message });
        } finally {
            this.controllers.delete(file.id);
        }
    }
}
