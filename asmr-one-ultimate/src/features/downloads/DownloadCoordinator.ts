import { I18n } from '../../core/Config';
import { DirectoryDownloadSink, DirectoryPermissionError, ResumeOffsetMismatchError, type DownloadWriter } from './DirectoryDownloadSink';
import { DownloadJobRepository, type DownloadFile } from './DownloadJobRepository';
import {
    DownloadRequestTimeoutError,
    DownloadStallError,
    DownloadTransport,
    RangeRestartRequiredError,
} from './DownloadTransport';
import { OpusConversionMemoryLimitError, type OpusFileTransformer } from './OpusFileTransformer';

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
// Closing a FileSystemWritable commits its safe-write copy. A small interval
// makes large files approach quadratic disk I/O, so checkpoint coarsely while
// retaining close-before-checkpoint ordering and a bounded resume-loss window.
export const DOWNLOAD_DURABLE_CHECKPOINT_INTERVAL = 256 * 1024 * 1024;
export const DOWNLOAD_BODY_MAX_ATTEMPTS = 3;
const DOWNLOAD_BODY_RETRY_BASE_DELAY_MS = 300;
const DOWNLOAD_BODY_RETRY_MAX_DELAY_MS = 2_000;
const RUNNING_JOB_IDS = new Set<string>();

export interface DownloadCoordinatorRetryOptions {
    /** Includes the initial body attempt and is deliberately capped at three. */
    maxBodyAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    sleep?: (milliseconds: number) => Promise<void>;
}

class DownloadBodyRetriesExhaustedError extends Error {
    constructor(
        public readonly attempts: number,
        public readonly originalError: unknown,
    ) {
        super(`Download body failed after ${attempts} attempts`);
        this.name = 'DownloadBodyRetriesExhaustedError';
    }
}

function isAbortError(error: unknown): boolean {
    return error instanceof DOMException
        ? error.name === 'AbortError'
        : error instanceof Error && error.name === 'AbortError';
}

/**
 * Fetch already retries request-establishment failures. This classifier is
 * intentionally narrower: retry only typed stalls, known incomplete bodies,
 * or browser network errors after at least one body byte was delivered.
 */
function isRetryableBodyFailure(error: unknown, receivedBodyBytes: boolean): boolean {
    if (error instanceof DownloadStallError) return true;
    if (error instanceof Error && /^Incomplete download:/i.test(error.message)) return true;
    if (!receivedBodyBytes || isAbortError(error)) return false;
    if (error instanceof TypeError) return true;
    if (error instanceof DownloadRequestTimeoutError) return true;
    return error instanceof DOMException && error.name === 'NetworkError';
}

function isSourceEstablishmentFailure(error: unknown): boolean {
    if (error instanceof DownloadBodyRetriesExhaustedError) {
        return isSourceEstablishmentFailure(error.originalError);
    }
    if (error instanceof DownloadRequestTimeoutError) return true;
    if (error instanceof TypeError) return true;
    if (error instanceof DownloadStallError) return true;
    if (error instanceof Error && /^Incomplete download:/i.test(error.message)) return true;
    return error instanceof Error && /\bHTTP\s+[45]\d{2}\b/i.test(error.message);
}

function sanitizeFailureReason(error: unknown): string {
    if (error instanceof OpusConversionMemoryLimitError) {
        if (error.sourceBytes == null) return I18n.t('backupDownloaderOpusSizeUnknown');
        const sourceMiB = Math.ceil((error.sourceBytes / (1024 * 1024)) * 10) / 10;
        const limitMiB = Math.floor(error.maxSourceBytes / (1024 * 1024));
        return I18n.format('backupDownloaderOpusMemoryLimit', {
            size: sourceMiB,
            limit: limitMiB,
        });
    }
    if (error instanceof DownloadBodyRetriesExhaustedError) {
        const suffix = ` after ${error.attempts} attempts`;
        if (error.originalError instanceof DownloadStallError) return `Download stalled${suffix}`;
        if (error.originalError instanceof Error && /^Incomplete download:/i.test(error.originalError.message)) {
            return `Download ended before all bytes arrived${suffix}`;
        }
        return `Network download failed${suffix}`;
    }
    if (error instanceof DownloadStallError) return 'Download stalled';
    if (error instanceof DownloadRequestTimeoutError) return 'Network request timed out';
    if (error instanceof RangeRestartRequiredError) return 'The server rejected the resume request';
    if (error instanceof TypeError || (error instanceof DOMException && error.name === 'NetworkError')) {
        return 'Network request failed';
    }
    if (error instanceof DOMException && /^(?:QuotaExceededError|QuotaExceeded)$/i.test(error.name)) {
        return 'Not enough storage space';
    }
    const raw = error instanceof Error ? error.message : String(error);
    const httpStatus = raw.match(/\bHTTP\s+(\d{3})\b/i)?.[1];
    if (httpStatus) return `Server returned HTTP ${httpStatus}`;
    const sanitized = raw
        .replace(/https?:\/\/[^\s)]+/gi, 'remote source')
        .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
        .replace(/\b(?:authorization|token|jwt|key|signature|sig)\s*[:=]\s*[^\s&]+/gi, '[redacted]')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 180);
    return sanitized || 'Download could not be completed';
}

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
        retry: DownloadCoordinatorRetryOptions = {},
    ) {
        this.maxBodyAttempts = Math.max(
            1,
            Math.min(DOWNLOAD_BODY_MAX_ATTEMPTS, Math.floor(retry.maxBodyAttempts ?? DOWNLOAD_BODY_MAX_ATTEMPTS)),
        );
        this.bodyRetryBaseDelayMs = Math.max(0, retry.baseDelayMs ?? DOWNLOAD_BODY_RETRY_BASE_DELAY_MS);
        this.bodyRetryMaxDelayMs = Math.max(
            this.bodyRetryBaseDelayMs,
            retry.maxDelayMs ?? DOWNLOAD_BODY_RETRY_MAX_DELAY_MS,
        );
        this.sleep = retry.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    }

    private readonly maxBodyAttempts: number;
    private readonly bodyRetryBaseDelayMs: number;
    private readonly bodyRetryMaxDelayMs: number;
    private readonly sleep: (milliseconds: number) => Promise<void>;

    private retryDelay(failedAttempt: number): number {
        return Math.min(
            this.bodyRetryMaxDelayMs,
            this.bodyRetryBaseDelayMs * (2 ** Math.max(0, failedAttempt - 1)),
        );
    }

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
        let latestDurableOffset = 0;
        try {
            await this.repository.markFileActive(file.id);
            checkpoint = await this.repository.getCheckpoint(file.id);
            latestDurableOffset = checkpoint?.offset ?? 0;
            try {
                writer = await this.sink.open(path, checkpoint?.offset ?? 0);
            } catch (error) {
                if (!(error instanceof ResumeOffsetMismatchError)) throw error;
                await this.repository.resetFile(file.id);
                checkpoint = undefined;
                latestDurableOffset = 0;
                writer = await this.sink.open(path, 0);
            }
            const attempt = async (sourceUrl: string): Promise<number> => {
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
                    latestDurableOffset = offset;
                    if (reopen) writer = await this.sink.open(path, offset);
                };
                let probe: Awaited<ReturnType<DownloadTransport['stream']>> | undefined;
                for (let bodyAttempt = 1; bodyAttempt <= this.maxBodyAttempts; bodyAttempt += 1) {
                    const requestOffset = received;
                    let callbackFailed = false;
                    let callbackError: unknown;
                    try {
                        probe = await this.transport.stream(sourceUrl, received, async chunk => {
                            try {
                                if (!writer) throw new Error('Download writer is unavailable');
                                await writer.write(chunk.bytes, chunk.offset);
                                received = chunk.offset + chunk.bytes.byteLength;
                                lastValidator = {
                                    etag: chunk.etag,
                                    lastModified: chunk.lastModified,
                                    totalBytes: chunk.total ?? lastValidator.totalBytes,
                                };
                                if (received - durableOffset >= DOWNLOAD_DURABLE_CHECKPOINT_INTERVAL) {
                                    await commit(received, true);
                                }
                                onProgress?.({
                                    jobId: file.jobId,
                                    fileId: file.id,
                                    completedBytes: received,
                                    totalBytes: chunk.total ?? file.totalBytes,
                                    status: 'downloading',
                                });
                            } catch (error) {
                                callbackFailed = true;
                                callbackError = error;
                                throw error;
                            }
                        }, {
                            signal: controller.signal,
                            expectedEtag: lastValidator.etag,
                            expectedLastModified: lastValidator.lastModified,
                            expectedTotal: lastValidator.totalBytes,
                        });
                        if (
                            received <= requestOffset
                            && !(
                                probe.confirmedCompleteAtOffset === true
                                && probe.size === requestOffset
                            )
                            && !(
                                requestOffset === 0
                                && probe.confirmedEmpty === true
                                && probe.size === 0
                            )
                        ) {
                            throw new Error(`Incomplete download: received no bytes after offset ${requestOffset}`);
                        }
                        const expectedTotal = probe.size ?? lastValidator.totalBytes;
                        if (typeof expectedTotal === 'number' && received !== expectedTotal) {
                            throw new Error(`Incomplete download: received ${received} of ${expectedTotal} bytes`);
                        }
                        break;
                    } catch (error) {
                        if (callbackFailed) throw callbackError;
                        if (error instanceof RangeRestartRequiredError || !isRetryableBodyFailure(error, received > requestOffset)) {
                            throw error;
                        }

                        // Preserve every valid sequential byte, including on the
                        // final failed attempt, so a later Resume starts exactly
                        // where this run stopped.
                        if (received > durableOffset) {
                            await commit(received, false);
                        } else {
                            await writer?.abort(error);
                            writer = undefined;
                        }

                        if (bodyAttempt >= this.maxBodyAttempts) {
                            throw new DownloadBodyRetriesExhaustedError(bodyAttempt, error);
                        }
                        if (controller.signal.aborted) throw new DOMException('Download aborted', 'AbortError');
                        await this.sleep(this.retryDelay(bodyAttempt));
                        if (controller.signal.aborted) throw new DOMException('Download aborted', 'AbortError');
                        writer = await this.sink.open(path, received);
                    }
                }
                if (!probe) throw new Error('Download body did not return a result');
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
                const candidates = [file.url, ...(file.sourceUrls ?? [])]
                    .filter((url, index, urls) => !!url && urls.indexOf(url) === index);
                for (let sourceIndex = 0; sourceIndex < candidates.length; sourceIndex += 1) {
                    const sourceUrl = candidates[sourceIndex];
                    try {
                        try {
                            total = await attempt(sourceUrl);
                        } catch (error) {
                            if (!(error instanceof RangeRestartRequiredError)) throw error;
                            await writer?.abort(error);
                            writer = undefined;
                            await this.repository.resetFile(file.id);
                            checkpoint = undefined;
                            latestDurableOffset = 0;
                            writer = await this.sink.open(path, 0);
                            total = await attempt(sourceUrl);
                        }
                        break;
                    } catch (error) {
                        const nextSource = candidates[sourceIndex + 1];
                        if (!nextSource || latestDurableOffset > 0 || !isSourceEstablishmentFailure(error)) throw error;
                        await writer?.abort(error);
                        writer = undefined;
                        await this.repository.resetFile(file.id);
                        checkpoint = undefined;
                        await this.repository.selectFileSource(
                            file.id,
                            nextSource,
                            [
                                ...candidates.slice(sourceIndex + 2),
                                ...candidates.slice(0, sourceIndex + 1),
                            ],
                        );
                        writer = await this.sink.open(path, 0);
                    }
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
                onProgress?.({ jobId: file.jobId, fileId: file.id, completedBytes: latestDurableOffset, status: 'paused' });
                return;
            }
            const message = sanitizeFailureReason(error);
            await this.repository.markFileFailed(file.id, message);
            onProgress?.({ jobId: file.jobId, fileId: file.id, completedBytes: latestDurableOffset, status: 'failed', error: message });
        } finally {
            this.controllers.delete(file.id);
        }
    }
}
