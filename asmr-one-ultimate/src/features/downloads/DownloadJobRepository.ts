import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb';

export type DownloadJobStatus = 'pending' | 'active' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type DownloadFileStatus = DownloadJobStatus;

export interface DownloadJob<TOptions = Record<string, unknown>> {
    id: string;
    title: string;
    status: DownloadJobStatus;
    /** Complete selection/profile snapshot required to reproduce the job after reload. */
    options: TOptions;
    createdAt: number;
    updatedAt: number;
}

export interface DownloadFile {
    id: string;
    jobId: string;
    path: string;
    url: string;
    status: DownloadFileStatus;
    downloadedBytes: number;
    totalBytes?: number;
    error?: string;
    /** Source bytes are fully written; post-processing may safely resume without network. */
    sourceComplete?: boolean;
    createdAt: number;
    updatedAt: number;
}

export interface DownloadCheckpoint {
    fileId: string;
    jobId: string;
    offset: number;
    etag?: string;
    lastModified?: string;
    updatedAt: number;
}

export interface DownloadJobSnapshot<TOptions = Record<string, unknown>> {
    job: DownloadJob<TOptions>;
    files: DownloadFile[];
    checkpoints: DownloadCheckpoint[];
}

export interface CreateDownloadJob<TOptions = Record<string, unknown>> {
    id: string;
    title: string;
    options: TOptions;
    status?: DownloadJobStatus;
}

export interface CreateDownloadFile {
    id: string;
    path: string;
    url: string;
    totalBytes?: number;
    status?: DownloadFileStatus;
}

interface DownloadDatabase extends DBSchema {
    jobs: {
        key: string;
        value: DownloadJob<unknown>;
        indexes: { 'by-status': DownloadJobStatus };
    };
    files: {
        key: string;
        value: DownloadFile;
        indexes: { 'by-job': string; 'by-job-status': [string, DownloadFileStatus] };
    };
    checkpoints: {
        key: string;
        value: DownloadCheckpoint;
        indexes: { 'by-job': string };
    };
}

const DATABASE_NAME = 'asmr-one-downloads';
const DATABASE_VERSION = 1;

export class DownloadRecordNotFoundError extends Error {
    constructor(kind: 'job' | 'file', id: string) {
        super(`Download ${kind} not found: ${id}`);
        this.name = 'DownloadRecordNotFoundError';
    }
}

export class DownloadJobRepository {
    private database?: Promise<IDBPDatabase<DownloadDatabase>>;

    constructor(private readonly databaseName = DATABASE_NAME) {}

    async createJob<TOptions>(jobInput: CreateDownloadJob<TOptions>, fileInputs: CreateDownloadFile[]): Promise<DownloadJobSnapshot<TOptions>> {
        const database = await this.getDatabase();
        const transaction = database.transaction(['jobs', 'files'], 'readwrite');
        const now = Date.now();
        const job: DownloadJob<TOptions> = {
            ...jobInput,
            status: jobInput.status ?? 'pending',
            createdAt: now,
            updatedAt: now,
        };
        const files: DownloadFile[] = fileInputs.map((file) => ({
            ...file,
            jobId: job.id,
            status: file.status ?? 'pending',
            downloadedBytes: 0,
            createdAt: now,
            updatedAt: now,
        }));

        await transaction.objectStore('jobs').add(job as DownloadJob<unknown>);
        await Promise.all(files.map((file) => transaction.objectStore('files').add(file)));
        await transaction.done;
        return { job, files, checkpoints: [] };
    }

    async loadJob<TOptions = Record<string, unknown>>(jobId: string): Promise<DownloadJobSnapshot<TOptions> | undefined> {
        await this.recoverStaleActiveRecords();
        const database = await this.getDatabase();
        const transaction = database.transaction(['jobs', 'files', 'checkpoints']);
        const [storedJob, files, checkpoints] = await Promise.all([
            transaction.objectStore('jobs').get(jobId),
            transaction.objectStore('files').index('by-job').getAll(jobId),
            transaction.objectStore('checkpoints').index('by-job').getAll(jobId),
        ]);
        await transaction.done;
        if (!storedJob) return undefined;
        return { job: storedJob as DownloadJob<TOptions>, files, checkpoints };
    }

    async listJobs<TOptions = Record<string, unknown>>(): Promise<Array<DownloadJob<TOptions>>> {
        await this.recoverStaleActiveRecords();
        const jobs = await (await this.getDatabase()).getAll('jobs');
        return jobs as Array<DownloadJob<TOptions>>;
    }

    async listFiles(jobId: string): Promise<DownloadFile[]> {
        return (await this.getDatabase()).getAllFromIndex('files', 'by-job', jobId);
    }

    async getFile(fileId: string): Promise<DownloadFile | undefined> {
        return (await this.getDatabase()).get('files', fileId);
    }

    async getCheckpoint(fileId: string): Promise<DownloadCheckpoint | undefined> {
        return (await this.getDatabase()).get('checkpoints', fileId);
    }

    async checkpointFile(
        fileId: string,
        checkpoint: Pick<DownloadCheckpoint, 'offset' | 'etag' | 'lastModified'> & { totalBytes?: number },
    ): Promise<DownloadCheckpoint> {
        if (!Number.isSafeInteger(checkpoint.offset) || checkpoint.offset < 0) {
            throw new RangeError('Checkpoint offset must be a non-negative safe integer');
        }
        const database = await this.getDatabase();
        const transaction = database.transaction(['files', 'checkpoints'], 'readwrite');
        const files = transaction.objectStore('files');
        const checkpoints = transaction.objectStore('checkpoints');
        const file = await files.get(fileId);
        if (!file) throw new DownloadRecordNotFoundError('file', fileId);
        const previous = await checkpoints.get(fileId);
        const offset = Math.max(previous?.offset ?? 0, file.downloadedBytes, checkpoint.offset);
        const updatedAt = Date.now();
        const value: DownloadCheckpoint = {
            fileId,
            jobId: file.jobId,
            offset,
            etag: checkpoint.etag ?? previous?.etag,
            lastModified: checkpoint.lastModified ?? previous?.lastModified,
            updatedAt,
        };
        await checkpoints.put(value);
        await files.put({ ...file, downloadedBytes: offset, totalBytes: checkpoint.totalBytes ?? file.totalBytes, updatedAt });
        await transaction.done;
        return value;
    }

    async markFileComplete(fileId: string, totalBytes: number, output?: { path: string; bytes: number }): Promise<DownloadFile> {
        if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) throw new RangeError('Total bytes must be a non-negative safe integer');
        if (output && (!Number.isSafeInteger(output.bytes) || output.bytes < 0)) throw new RangeError('Output bytes must be a non-negative safe integer');
        const finalBytes = output?.bytes ?? totalBytes;
        return this.updateFileAndDeleteCheckpoint(fileId, (file, now) => ({
            ...file,
            path: output?.path ?? file.path,
            status: 'completed',
            downloadedBytes: finalBytes,
            totalBytes: finalBytes,
            error: undefined,
            updatedAt: now,
        }));
    }

    async markFileFailed(fileId: string, error?: string): Promise<DownloadFile> {
        return this.updateFile(fileId, (file, now) => ({ ...file, status: 'failed', error, updatedAt: now }));
    }

    async resetFile(fileId: string): Promise<DownloadFile> {
        return this.updateFileAndDeleteCheckpoint(fileId, (file, now) => ({
            ...file,
            status: 'pending',
            downloadedBytes: 0,
            sourceComplete: false,
            error: undefined,
            updatedAt: now,
        }));
    }

    async markSourceComplete(fileId: string, totalBytes: number): Promise<DownloadFile> {
        return this.updateFile(fileId, (file, now) => ({
            ...file, downloadedBytes: totalBytes, totalBytes, sourceComplete: true, updatedAt: now,
        }));
    }

    async markFileActive(fileId: string): Promise<DownloadFile> {
        return this.updateFile(fileId, (file, now) => ({
            ...file,
            status: 'active',
            error: undefined,
            updatedAt: now,
        }));
    }

    async activateJob(jobId: string): Promise<void> {
        await this.transitionJob(jobId, 'active', (file) => file.status === 'paused'
            ? { ...file, status: 'pending' }
            : file);
    }

    async pauseJob(jobId: string): Promise<void> {
        await this.transitionJob(jobId, 'paused', (file) => file.status === 'active' ? { ...file, status: 'paused' } : file);
    }

    async retryJob(jobId: string): Promise<void> {
        await this.transitionJob(jobId, 'pending', (file) => file.status === 'failed'
            ? { ...file, status: 'pending', error: undefined }
            : file);
    }

    async cancelJob(jobId: string): Promise<void> {
        await this.transitionJob(jobId, 'cancelled', (file) => file.status === 'completed'
            ? file
            : { ...file, status: 'cancelled' });
    }

    async completeJob(jobId: string): Promise<void> {
        const database = await this.getDatabase();
        const transaction = database.transaction(['jobs', 'files'], 'readwrite');
        const job = await transaction.objectStore('jobs').get(jobId);
        if (!job) throw new DownloadRecordNotFoundError('job', jobId);
        const unfinished = await transaction.objectStore('files').index('by-job').getAll(jobId);
        if (unfinished.some((file) => file.status !== 'completed')) {
            throw new Error(`Cannot complete download job with unfinished files: ${jobId}`);
        }
        await transaction.objectStore('jobs').put({ ...job, status: 'completed', updatedAt: Date.now() });
        await transaction.done;
    }

    async startOverJob(jobId: string): Promise<void> {
        const database = await this.getDatabase();
        const transaction = database.transaction(['jobs', 'files', 'checkpoints'], 'readwrite');
        const jobStore = transaction.objectStore('jobs');
        const job = await jobStore.get(jobId);
        if (!job) throw new DownloadRecordNotFoundError('job', jobId);
        const now = Date.now();
        const files = await transaction.objectStore('files').index('by-job').getAll(jobId);
        const checkpoints = await transaction.objectStore('checkpoints').index('by-job').getAllKeys(jobId);
        await jobStore.put({ ...job, status: 'pending', updatedAt: now });
        await Promise.all(files.map((file) => transaction.objectStore('files').put({
            ...file,
            status: 'pending',
            downloadedBytes: 0,
            sourceComplete: false,
            error: undefined,
            updatedAt: now,
        })));
        await Promise.all(checkpoints.map((key) => transaction.objectStore('checkpoints').delete(key)));
        await transaction.done;
    }

    async clear(): Promise<void> {
        const database = await this.getDatabase();
        const transaction = database.transaction(['jobs', 'files', 'checkpoints'], 'readwrite');
        await Promise.all([
            transaction.objectStore('jobs').clear(),
            transaction.objectStore('files').clear(),
            transaction.objectStore('checkpoints').clear(),
        ]);
        await transaction.done;
    }

    async close(): Promise<void> {
        if (!this.database) return;
        (await this.database).close();
        this.database = undefined;
    }

    async deleteDatabase(): Promise<void> {
        await this.close();
        await deleteDB(this.databaseName);
    }

    private getDatabase(): Promise<IDBPDatabase<DownloadDatabase>> {
        this.database ??= openDB<DownloadDatabase>(this.databaseName, DATABASE_VERSION, {
            upgrade(database) {
                const jobs = database.createObjectStore('jobs', { keyPath: 'id' });
                jobs.createIndex('by-status', 'status');
                const files = database.createObjectStore('files', { keyPath: 'id' });
                files.createIndex('by-job', 'jobId');
                files.createIndex('by-job-status', ['jobId', 'status']);
                const checkpoints = database.createObjectStore('checkpoints', { keyPath: 'fileId' });
                checkpoints.createIndex('by-job', 'jobId');
            },
        });
        return this.database;
    }

    private async recoverStaleActiveRecords(): Promise<void> {
        const database = await this.getDatabase();
        const transaction = database.transaction(['jobs', 'files'], 'readwrite');
        const jobs = await transaction.objectStore('jobs').index('by-status').getAll('active');
        const files = await transaction.objectStore('files').getAll();
        const now = Date.now();
        await Promise.all(jobs.map((job) => transaction.objectStore('jobs').put({ ...job, status: 'paused', updatedAt: now })));
        await Promise.all(files.filter((file) => file.status === 'active').map((file) =>
            transaction.objectStore('files').put({ ...file, status: 'paused', updatedAt: now })));
        await transaction.done;
    }

    private async transitionJob(
        jobId: string,
        status: DownloadJobStatus,
        transformFile: (file: DownloadFile) => DownloadFile,
    ): Promise<void> {
        const database = await this.getDatabase();
        const transaction = database.transaction(['jobs', 'files'], 'readwrite');
        const jobStore = transaction.objectStore('jobs');
        const job = await jobStore.get(jobId);
        if (!job) throw new DownloadRecordNotFoundError('job', jobId);
        const now = Date.now();
        const files = await transaction.objectStore('files').index('by-job').getAll(jobId);
        await jobStore.put({ ...job, status, updatedAt: now });
        await Promise.all(files.map((file) => {
            const next = transformFile(file);
            return next === file ? Promise.resolve() : transaction.objectStore('files').put({ ...next, updatedAt: now });
        }));
        await transaction.done;
    }

    private async updateFile(fileId: string, update: (file: DownloadFile, now: number) => DownloadFile): Promise<DownloadFile> {
        const database = await this.getDatabase();
        const transaction = database.transaction('files', 'readwrite');
        const file = await transaction.store.get(fileId);
        if (!file) throw new DownloadRecordNotFoundError('file', fileId);
        const updated = update(file, Date.now());
        await transaction.store.put(updated);
        await transaction.done;
        return updated;
    }

    private async updateFileAndDeleteCheckpoint(
        fileId: string,
        update: (file: DownloadFile, now: number) => DownloadFile,
    ): Promise<DownloadFile> {
        const database = await this.getDatabase();
        const transaction = database.transaction(['files', 'checkpoints'], 'readwrite');
        const file = await transaction.objectStore('files').get(fileId);
        if (!file) throw new DownloadRecordNotFoundError('file', fileId);
        const updated = update(file, Date.now());
        await transaction.objectStore('files').put(updated);
        await transaction.objectStore('checkpoints').delete(fileId);
        await transaction.done;
        return updated;
    }
}
