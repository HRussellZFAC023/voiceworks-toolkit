import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    coordinatorRun: vi.fn(),
    createDownloadSink: vi.fn(),
    exportFolder: vi.fn(),
    exporterArgs: [] as unknown[][],
}));

vi.mock('../../../src/services/WorkService', () => ({
    WorkService: { getValidatedLiveTracks: vi.fn(), getWorkInfo: vi.fn() },
}));
vi.mock('../../../src/features/downloads/DownloadCoordinator', () => ({
    DownloadCoordinator: class DownloadCoordinator {
        run = mocks.coordinatorRun;
        pause = vi.fn();
        cancel = vi.fn();
    },
}));
vi.mock('../../../src/features/downloads/DownloadSinkFactory', () => ({
    createDownloadSink: mocks.createDownloadSink,
}));
vi.mock('../../../src/features/downloads/DownloadFolderExporter', () => ({
    DOWNLOAD_EXPORT_STAGING_FOLDER: '.asmr-export',
    DownloadFolderExporter: class DownloadFolderExporter {
        constructor(...args: unknown[]) { mocks.exporterArgs.push(args); }
        exportFolder = mocks.exportFolder;
    },
}));

import type { BackupDownloadState } from '../../../src/features/backupWorkDownloaderTypes';
import {
    DownloadCenterRunner,
    type PersistedDownloadCenterOptions,
} from '../../../src/features/downloads/DownloadCenterRunner';
import type { DownloadDestination } from '../../../src/features/downloads/DownloadSink';

const STAGED: DownloadDestination = { kind: 'gm', subfolder: 'staged' };

function state(): BackupDownloadState {
    return {
        selectedWorkIds: ['RJ1'],
        filters: { audio: true, video: true, image: true, text: true, other: true },
        titleMode: 'original', convertToOpus: false, opusBitrate: 96,
        metadataMode: 'additive', includeArtwork: false,
    };
}

function persisted(destination: DownloadDestination, overrides: Partial<PersistedDownloadCenterOptions> = {}): PersistedDownloadCenterOptions {
    return {
        state: state(),
        destination,
        enrichment: {},
        opusOutputPaths: {},
        discovery: { works: [], nextIndex: 0, skippedWorkIds: [], titlesReady: true, complete: true },
        ...overrides,
    };
}

function file(id: string, path: string, status = 'pending') {
    return { id, jobId: 'job', path, url: `https://media.test/${id}`, status, downloadedBytes: 0 };
}

function repository(files: any[], jobs: any[] = []) {
    let stored: PersistedDownloadCenterOptions | undefined;
    return {
        get stored() { return stored; },
        listJobs: vi.fn(async () => jobs),
        listFiles: vi.fn(async () => files),
        appendFilesAndUpdateOptions: vi.fn(async (_job: string, next: PersistedDownloadCenterOptions) => { stored = next; }),
        completeJob: vi.fn(async () => true),
        pauseJob: vi.fn(async () => true),
        deleteJob: vi.fn(),
    };
}

describe('DownloadCenterRunner staged export', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.exporterArgs.length = 0;
        mocks.createDownloadSink.mockResolvedValue({
            ensurePermission: vi.fn(async () => true),
            listTopLevelEntryNames: vi.fn(async () => []),
        });
        mocks.exportFolder.mockResolvedValue({ exported: true, stagedFilesRetained: false });
        mocks.coordinatorRun.mockResolvedValue(undefined);
    });

    it('hands each work folder to the exporter as soon as its last file completes', async () => {
        const files = [
            file('a1', 'Work A/one.wav'),
            file('a2', 'Work A/two.wav'),
            file('b1', 'Work B/one.wav'),
        ];
        const repo = repository(files);
        const order: string[] = [];
        mocks.exportFolder.mockImplementation(async (folder: string) => {
            order.push(folder);
            return { exported: true, stagedFilesRetained: false };
        });
        mocks.coordinatorRun.mockImplementation(async (_jobId: string, notify: (progress: any) => void) => {
            notify({ jobId: 'job', fileId: 'a1', completedBytes: 1, status: 'complete' });
            notify({ jobId: 'job', fileId: 'b1', completedBytes: 1, status: 'complete' });
            notify({ jobId: 'job', fileId: 'a2', completedBytes: 1, status: 'complete' });
            for (const entry of files) entry.status = 'completed';
        });
        const runner = new DownloadCenterRunner(repo as any);

        const result = await (runner as any).prepareAndRun('job', persisted(STAGED));

        expect(order).toEqual(['Work B', 'Work A']);
        expect(mocks.coordinatorRun).toHaveBeenCalledWith(
            'job',
            expect.any(Function),
            { deferJobCompletion: true },
        );
        expect(mocks.exportFolder).toHaveBeenCalledWith('Work A', ['Work A/one.wav', 'Work A/two.wav']);
        expect(result.exportFailures).toBe(0);
        expect(repo.stored?.exportedFolders).toEqual(['Work B', 'Work A']);
        expect(repo.completeJob).toHaveBeenCalledWith('job', expect.any(String));
    });

    it('never builds an exporter for a folder the user picked themselves', async () => {
        const files = [file('a1', 'Work A/one.wav', 'completed')];
        const runner = new DownloadCenterRunner(repository(files) as any);

        const result = await (runner as any).prepareAndRun(
            'job',
            persisted({ kind: 'fsa', handle: {} as FileSystemDirectoryHandle }),
        );

        expect(mocks.exporterArgs).toHaveLength(0);
        expect(mocks.exportFolder).not.toHaveBeenCalled();
        expect(result.exportFailures).toBe(0);
    });

    it('exports folders finished by an earlier run that stopped before delivery', async () => {
        const files = [file('a1', 'Work A/one.wav', 'completed')];
        const runner = new DownloadCenterRunner(repository(files) as any);

        await (runner as any).prepareAndRun('job', persisted(STAGED));

        expect(mocks.exportFolder).toHaveBeenCalledWith('Work A', ['Work A/one.wav']);
    });

    it('does not re-export a folder already recorded as delivered', async () => {
        const files = [file('a1', 'Work A/one.wav', 'completed')];
        const runner = new DownloadCenterRunner(repository(files) as any);

        await (runner as any).prepareAndRun('job', persisted(STAGED, { exportedFolders: ['Work A'] }));

        expect(mocks.exportFolder).not.toHaveBeenCalled();
    });

    it('archives the converted output path rather than the discovered source path', async () => {
        const files = [file('a1', 'Work A/one.wav')];
        const repo = repository(files);
        mocks.coordinatorRun.mockImplementation(async (_jobId: string, notify: (progress: any) => void) => {
            // Opus conversion rewrites the record's path when the file lands.
            files[0].path = 'Work A/one.opus';
            files[0].status = 'completed';
            notify({ jobId: 'job', fileId: 'a1', completedBytes: 1, status: 'complete' });
        });
        const runner = new DownloadCenterRunner(repo as any);

        await (runner as any).prepareAndRun('job', persisted(STAGED));

        expect(mocks.exportFolder).toHaveBeenCalledWith('Work A', ['Work A/one.opus']);
    });

    it('keeps refused exports resumable instead of completing the download job', async () => {
        const files = [file('a1', 'Work A/one.wav', 'completed')];
        const repo = repository(files);
        mocks.exportFolder.mockResolvedValue({ exported: false, stagedFilesRetained: true });
        const runner = new DownloadCenterRunner(repo as any);

        const error = await (runner as any).prepareAndRun('job', persisted(STAGED))
            .catch((value: unknown) => value);

        expect(error).toMatchObject({ code: 'export' });
        expect(repo.completeJob).not.toHaveBeenCalled();
        expect(repo.stored?.exportedFolders).toBeUndefined();
    });

    it('still delivers a work folder whose remaining file only failed', async () => {
        // `remaining` counts down on completion only, so without an explicit
        // end-of-run flush a folder holding a failed file is never handed over
        // and the user receives nothing for that work.
        const files = [
            { ...file('a1', 'Work A/one.wav', 'completed'), status: 'completed' },
            { ...file('a2', 'Work A/two.wav', 'failed'), status: 'failed', error: 'boom' },
        ];
        const repo = repository(files);
        const runner = new DownloadCenterRunner(repo as any);

        await (runner as any).prepareAndRun('job', persisted(STAGED));

        expect(mocks.exportFolder).toHaveBeenCalledWith('Work A', ['Work A/one.wav']);
    });

    it('keeps a partial job resumable when its completed files cannot be exported', async () => {
        const files = [
            { ...file('a1', 'Work A/one.wav', 'completed'), status: 'completed' },
            { ...file('b1', 'Work B/two.wav', 'failed'), status: 'failed', error: 'boom' },
        ];
        const repo = repository(files);
        mocks.exportFolder.mockResolvedValue({ exported: false, stagedFilesRetained: true });
        const runner = new DownloadCenterRunner(repo as any);

        const error = await (runner as any).prepareAndRun('job', persisted(STAGED))
            .catch((value: unknown) => value);

        expect(error).toMatchObject({ code: 'export' });
        expect(repo.completeJob).not.toHaveBeenCalled();
    });

    it('does not deliver a folder that still has files waiting to download', async () => {
        const files = [
            { ...file('a1', 'Work A/one.wav', 'completed'), status: 'completed' },
            { ...file('a2', 'Work A/two.wav', 'paused'), status: 'paused' },
        ];
        const runner = new DownloadCenterRunner(repository(files) as any);

        await (runner as any).prepareAndRun('job', persisted(STAGED)).catch(() => undefined);

        expect(mocks.exportFolder).not.toHaveBeenCalledWith('Work A', expect.anything());
    });

    it('rebuilds the sink from a legacy directory handle recorded before destinations existed', async () => {
        const handle = {} as FileSystemDirectoryHandle;
        const files = [file('a1', 'Work A/one.wav', 'completed')];
        const runner = new DownloadCenterRunner(repository(files) as any);

        await (runner as any).prepareAndRun('job', {
            ...persisted({ kind: 'fsa', handle }),
            destination: undefined as unknown as DownloadDestination,
            directory: handle,
        });

        expect(mocks.createDownloadSink).toHaveBeenCalledWith({ kind: 'fsa', handle });
    });

    it('reopens a v175 completed staged job when its supposedly exported folder is still retained', async () => {
        const options = persisted(STAGED, { exportedFolders: ['Work A'] });
        const job = {
            id: 'job',
            title: 'Legacy staged download',
            status: 'completed',
            options,
            createdAt: 1,
            updatedAt: 1,
        };
        const repo = repository(
            [file('a1', 'Work A/one.wav', 'completed')],
            [job],
        );
        mocks.createDownloadSink.mockResolvedValueOnce({
            listTopLevelEntryNames: vi.fn(async () => ['Work A']),
            size: vi.fn(async (path: readonly string[]) => {
                if (path.join('/') === '.asmr-export/Work A.zip') return 100;
                throw new Error('missing');
            }),
        });
        const runner = new DownloadCenterRunner(repo as any);

        const recovered = await runner.recoverInterruptedJobs();

        expect(recovered).toEqual([
            expect.objectContaining({
                id: 'job',
                status: 'paused',
                options: expect.objectContaining({ exportedFolders: [] }),
            }),
        ]);
        expect(repo.appendFilesAndUpdateOptions).toHaveBeenCalledWith(
            'job',
            expect.objectContaining({ exportedFolders: [] }),
            [],
        );
        expect(repo.pauseJob).toHaveBeenCalledWith('job');
    });

    it('leaves a confirmed completed staged job closed when no source folder remains', async () => {
        const options = persisted(STAGED, { exportedFolders: ['Work A'] });
        const job = {
            id: 'job',
            title: 'Confirmed staged download',
            status: 'completed',
            options,
            createdAt: 1,
            updatedAt: 1,
        };
        const repo = repository(
            [file('a1', 'Work A/one.wav', 'completed')],
            [job],
        );
        mocks.createDownloadSink.mockResolvedValueOnce({
            // A newer job can legitimately recreate the same top-level folder.
            // Without the old hidden ZIP marker it does not belong to this job.
            listTopLevelEntryNames: vi.fn(async () => ['Work A']),
            size: vi.fn(async () => { throw new Error('missing'); }),
        });
        const runner = new DownloadCenterRunner(repo as any);

        expect(await runner.recoverInterruptedJobs()).toEqual([]);
        expect(repo.appendFilesAndUpdateOptions).not.toHaveBeenCalled();
        expect(repo.pauseJob).not.toHaveBeenCalled();
    });
});
