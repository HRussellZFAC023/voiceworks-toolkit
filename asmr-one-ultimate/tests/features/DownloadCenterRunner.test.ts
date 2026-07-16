import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getTracks: vi.fn(),
    getWorkInfo: vi.fn(),
    coordinatorRun: vi.fn(),
    coordinatorPause: vi.fn(),
    coordinatorArgs: [] as unknown[][],
}));

vi.mock('../../src/services/WorkService', () => ({
    WorkService: { getTracks: mocks.getTracks, getWorkInfo: mocks.getWorkInfo },
}));
vi.mock('../../src/features/downloads/DownloadCoordinator', () => ({
    DownloadCoordinator: class DownloadCoordinator {
        constructor(...args: unknown[]) { mocks.coordinatorArgs.push(args); }
        run = mocks.coordinatorRun;
        pause = mocks.coordinatorPause;
        cancel = vi.fn();
    },
}));

import {
    DOWNLOAD_DISCOVERY_BATCH_SIZE,
    DownloadCenterRunError,
    DownloadCenterRunner,
    type DownloadCenterJob,
    type PersistedDownloadCenterOptions,
} from '../../src/features/downloads/DownloadCenterRunner';
import {
    DOWNLOAD_JOB_LEASE_MS,
    DownloadJobRepository,
} from '../../src/features/downloads/DownloadJobRepository';
import type { BackupDownloadState, BackupWorkDownloadItem } from '../../src/features/backupWorkDownloaderTypes';

function testDirectory(entries: Array<{ name: string; kind: 'file' | 'directory' }> = []) {
    const enumerate = vi.fn(() => (async function* () {
        for (const entry of entries) yield [entry.name, entry] as [string, FileSystemHandle];
    })());
    return {
        enumerate,
        handle: {
            queryPermission: vi.fn().mockResolvedValue('granted'),
            entries: enumerate,
        } as unknown as FileSystemDirectoryHandle,
    };
}

function state(overrides: Partial<BackupDownloadState> = {}): BackupDownloadState {
    return {
        selectedWorkIds: ['RJ2'],
        filters: { audio: true, video: false, image: true, text: true, other: false },
        titleMode: 'original', convertToOpus: false, opusBitrate: 96,
        metadataMode: 'additive', includeArtwork: true, ...overrides,
    };
}

function options(works: BackupWorkDownloadItem[], nextIndex = 0, overrides: Partial<BackupDownloadState> = {}): PersistedDownloadCenterOptions {
    return {
        state: state(overrides), directory: testDirectory().handle, enrichment: {}, opusOutputPaths: {},
        discovery: { works, nextIndex, skippedWorkIds: [], titlesReady: true, complete: false },
    };
}

function repository(initialFiles: any[] = []) {
    const files = [...initialFiles];
    let storedOptions: PersistedDownloadCenterOptions | undefined;
    let storedJob: any;
    return {
        files,
        get storedOptions() { return storedOptions; },
        listJobs: vi.fn(async () => []),
        loadJob: vi.fn(async () => storedJob ? { job: storedJob, files, checkpoints: [] } : undefined),
        listFiles: vi.fn(async () => files),
        appendFilesAndUpdateOptions: vi.fn(async (_jobId: string, next: PersistedDownloadCenterOptions, additions: any[]) => {
            storedOptions = next;
            files.push(...additions.map(file => ({ ...file, jobId: 'job', status: 'pending', downloadedBytes: 0 })));
        }),
        createJob: vi.fn(async (input: any) => {
            storedOptions = input.options;
            storedJob = { ...input, status: input.status ?? 'pending', createdAt: Date.now(), updatedAt: Date.now() };
        }),
        claimJob: vi.fn(async () => {
            if (storedJob) storedJob = { ...storedJob, status: 'active' };
            return true;
        }),
        renewJobLease: vi.fn(async () => true),
        pauseJob: vi.fn(async () => {
            if (storedJob) storedJob = { ...storedJob, status: 'paused' };
            return true;
        }),
        deleteJob: vi.fn(),
    };
}

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    return { promise, resolve, reject };
}

const persistentRepositories: DownloadJobRepository[] = [];
const persistentDatabaseNames = new Set<string>();

function persistentRepository(databaseName: string): DownloadJobRepository {
    const value = new DownloadJobRepository(databaseName);
    persistentRepositories.push(value);
    persistentDatabaseNames.add(databaseName);
    return value;
}

async function beginHeldRun(runner: DownloadCenterRunner) {
    const entered = deferred<void>();
    const finish = deferred<void>();
    const prepare = vi.spyOn(runner as any, 'prepareAndRun').mockImplementation(async (...args: unknown[]) => {
        const initial = args[1] as PersistedDownloadCenterOptions;
        entered.resolve();
        await finish.promise;
        return initial;
    });
    const run = runner.start(
        [{ id: 'RJ2', title: 'Work' }],
        state(),
        {} as FileSystemDirectoryHandle,
        'Held job',
    );
    await entered.promise;
    const jobId = runner.runningJobId;
    if (!jobId) throw new Error('Runner did not expose its active job');
    return { finish, jobId, prepare, run };
}

const info = (cover = 'https://media.test/work-cover.jpg') => ({
    vas: [], tags: [], circle: { name: 'Circle' }, name: 'Circle', release: '2026-01-01',
    source_url: '', source_id: 'RJ2', circle_id: 1, age_category_string: 'adult',
    mainCoverUrl: cover, thumbnailCoverUrl: '', samCoverUrl: '',
});

describe('DownloadCenterRunner', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.coordinatorArgs.length = 0;
        mocks.getTracks.mockResolvedValue([{ type: 'audio', hash: 'audio', title: 'track.wav', mediaDownloadUrl: 'https://media.test/track.wav' }]);
        mocks.getWorkInfo.mockResolvedValue(info());
        mocks.coordinatorRun.mockResolvedValue(undefined);
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await Promise.all(persistentRepositories.splice(0).map(repository => repository.close()));
        await Promise.all([...persistentDatabaseNames].map(databaseName => new DownloadJobRepository(databaseName).deleteDatabase()));
        persistentDatabaseNames.clear();
    });

    it('continues discovery from the persisted nextIndex checkpoint after refresh', async () => {
        const repo = repository();
        const runner = new DownloadCenterRunner(repo as any);
        const persisted = options([{ id: 'RJ1', title: 'Already done' }, { id: 'RJ2', title: 'Resume here' }], 1);

        const result = await (runner as any).continueDiscovery('job', persisted);

        expect(mocks.getTracks).toHaveBeenCalledTimes(1);
        expect(mocks.getTracks).toHaveBeenCalledWith('RJ2');
        expect(repo.appendFilesAndUpdateOptions).toHaveBeenCalledWith('job', expect.objectContaining({
            discovery: expect.objectContaining({ nextIndex: 2 }),
        }), expect.arrayContaining([expect.objectContaining({ path: 'Resume here/track.wav' })]));
        expect(result.discovery).toMatchObject({ nextIndex: 2, complete: true });
    });

    it('reports a clean coordinator pause as paused, never failed', async () => {
        const pausedFile = { id: 'file', jobId: 'job', path: 'Work/track.wav', status: 'paused', downloadedBytes: 4 };
        const repo = repository([pausedFile]);
        const runner = new DownloadCenterRunner(repo as any);
        const persisted = options([{ id: 'RJ2', title: 'Work' }]);
        persisted.discovery!.complete = true;

        const error = await (runner as any).prepareAndRun('job', persisted).catch((value: unknown) => value);

        expect(error).toBeInstanceOf(DownloadCenterRunError);
        expect(error).toMatchObject({ code: 'paused' });
        expect(String((error as Error).message)).not.toMatch(/failed/i);
    });

    it('maps coordinator conversion progress and ratio without presenting it as downloading', async () => {
        const file = { id: 'file', jobId: 'job', path: 'Work/track.wav', status: 'paused', downloadedBytes: 4 };
        const repo = repository([file]);
        const runner = new DownloadCenterRunner(repo as any);
        const persisted = options([{ id: 'RJ2', title: 'Work' }]);
        persisted.discovery!.complete = true;
        const progress = vi.fn();
        mocks.coordinatorRun.mockImplementationOnce(async (jobId: string, notify: (value: unknown) => void) => {
            notify({
                jobId,
                fileId: 'file',
                completedBytes: 4,
                totalBytes: 10,
                status: 'converting',
                conversionRatio: 0.42,
            });
        });

        await (runner as any).prepareAndRun('job', persisted, progress).catch(() => undefined);

        expect(progress).toHaveBeenCalledWith(expect.objectContaining({
            jobId: 'job',
            phase: 'converting',
            conversionRatio: 0.42,
            completedBytes: 4,
            totalBytes: 10,
        }));
    });

    it.each([
        { image: true, artwork: true, existingCover: false, expected: true },
        { image: false, artwork: true, existingCover: false, expected: false },
        { image: true, artwork: false, existingCover: false, expected: false },
        { image: true, artwork: true, existingCover: true, expected: false },
    ])('adds collision-safe cover.jpg only when required: $expected', async ({ image, artwork, existingCover, expected }) => {
        mocks.getTracks.mockResolvedValue([
            { type: 'audio', hash: 'audio', title: 'track.wav', mediaDownloadUrl: 'https://media.test/track.wav' },
            ...(existingCover ? [{ type: 'image', hash: 'cover', title: 'cover.jpg', mediaDownloadUrl: 'https://media.test/existing.jpg' }] : []),
        ]);
        const repo = repository();
        const runner = new DownloadCenterRunner(repo as any);
        await (runner as any).continueDiscovery('job', options([{ id: 'RJ2', title: 'Work' }], 0, {
            filters: { audio: true, video: false, image, text: true, other: false }, includeArtwork: artwork,
        }));
        const additions = repo.appendFilesAndUpdateOptions.mock.calls.flatMap(call => call[2] as any[]);
        const generated = additions.filter(file => file.id.endsWith(':generated-cover'));
        expect(generated.length > 0).toBe(expected);
        if (expected) expect(generated[0]).toMatchObject({ path: 'Work/cover.jpg', url: 'https://media.test/work-cover.jpg' });
    });

    it('keeps downloadable tracks when optional work metadata is unavailable', async () => {
        mocks.getWorkInfo.mockRejectedValueOnce(new Error('metadata offline'));
        const repo = repository();
        const runner = new DownloadCenterRunner(repo as any);

        await (runner as any).continueDiscovery('job', options([{ id: 'RJ2', title: 'Work' }]));

        const additions = repo.appendFilesAndUpdateOptions.mock.calls.flatMap(call => call[2] as any[]);
        expect(additions).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'Work/track.wav' })]));
    });

    it('starts required tracks and optional metadata requests concurrently for each work', async () => {
        const tracks = deferred<unknown[]>();
        const metadata = deferred<ReturnType<typeof info>>();
        mocks.getTracks.mockReturnValueOnce(tracks.promise);
        mocks.getWorkInfo.mockReturnValueOnce(metadata.promise);
        const repo = repository();
        const runner = new DownloadCenterRunner(repo as any);

        const discovery = (runner as any).continueDiscovery('job', options([{ id: 'RJ2', title: 'Work' }]));
        await vi.waitFor(() => expect(mocks.getTracks).toHaveBeenCalledWith('RJ2'));
        expect(mocks.getWorkInfo).toHaveBeenCalledWith('RJ2');

        tracks.resolve([{ type: 'audio', hash: 'audio', title: 'track.wav', mediaDownloadUrl: 'https://media.test/track.wav' }]);
        metadata.resolve(info(''));
        await discovery;
    });

    it('checkpoints discovery in fixed atomic batches instead of rewriting after every work', async () => {
        const workCount = DOWNLOAD_DISCOVERY_BATCH_SIZE * 2 + 1;
        const works = Array.from({ length: workCount }, (_, index) => ({ id: `RJ${index + 1}`, title: `Work ${index + 1}` }));
        mocks.getWorkInfo.mockResolvedValue(info(''));
        const repo = repository();
        const runner = new DownloadCenterRunner(repo as any);

        await (runner as any).continueDiscovery('job', options(works));

        const calls = repo.appendFilesAndUpdateOptions.mock.calls;
        expect(calls).toHaveLength(Math.ceil(workCount / DOWNLOAD_DISCOVERY_BATCH_SIZE) + 1);
        expect(calls.slice(0, -1).map(call => ({
            nextIndex: call[1].discovery!.nextIndex,
            files: call[2].length,
        }))).toEqual([
            { nextIndex: DOWNLOAD_DISCOVERY_BATCH_SIZE, files: DOWNLOAD_DISCOVERY_BATCH_SIZE },
            { nextIndex: DOWNLOAD_DISCOVERY_BATCH_SIZE * 2, files: DOWNLOAD_DISCOVERY_BATCH_SIZE },
            { nextIndex: workCount, files: 1 },
        ]);
        expect(calls.at(-1)?.[1].discovery).toMatchObject({ nextIndex: workCount, complete: true });
        expect(calls.at(-1)?.[2]).toEqual([]);
    });

    it('replays an uncommitted discovery batch with identical IDs and paths', async () => {
        const works = Array.from({ length: DOWNLOAD_DISCOVERY_BATCH_SIZE }, (_, index) => ({
            id: `RJ${index + 1}`,
            title: `Work ${index + 1}`,
        }));
        mocks.getWorkInfo.mockResolvedValue(info(''));
        const repo = repository();
        const runner = new DownloadCenterRunner(repo as any);
        const persisted = options(works);
        repo.appendFilesAndUpdateOptions.mockRejectedValueOnce(new Error('simulated transaction abort'));

        await expect((runner as any).continueDiscovery('job', persisted)).rejects.toThrow('transaction abort');
        const firstAttempt = repo.appendFilesAndUpdateOptions.mock.calls[0]!;
        expect(firstAttempt[1].discovery!.nextIndex).toBe(DOWNLOAD_DISCOVERY_BATCH_SIZE);

        await (runner as any).continueDiscovery('job', persisted);
        const retry = repo.appendFilesAndUpdateOptions.mock.calls[1]!;
        expect(retry[1].discovery!.nextIndex).toBe(DOWNLOAD_DISCOVERY_BATCH_SIZE);
        expect(retry[2].map((file: { id: string; path: string }) => ({ id: file.id, path: file.path })))
            .toEqual(firstAttempt[2].map((file: { id: string; path: string }) => ({ id: file.id, path: file.path })));
    });

    it.each(['directory', 'file'] as const)('suffixes a new work folder instead of touching a pre-existing root %s', async kind => {
        const root = testDirectory([{ name: 'Work', kind }]);
        const persisted = options([{ id: 'RJ2', title: 'Work' }]);
        persisted.directory = root.handle;
        const repo = repository();
        const runner = new DownloadCenterRunner(repo as any);

        await (runner as any).continueDiscovery('job', persisted);

        const additions = repo.appendFilesAndUpdateOptions.mock.calls.flatMap(call => call[2] as any[]);
        expect(root.enumerate).toHaveBeenCalledTimes(1);
        expect(additions).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'Work (2)/track.wav' })]));
        expect(additions).not.toEqual(expect.arrayContaining([expect.objectContaining({ path: 'Work/track.wav' })]));
    });

    it('canonicalizes existing folders when resuming same-title discovery', async () => {
        const repo = repository([{ id: 'existing', jobId: 'job', path: 'Same/first.wav', status: 'completed', downloadedBytes: 1 }]);
        const runner = new DownloadCenterRunner(repo as any);
        const persisted = options([{ id: 'RJ1', title: 'Same' }, { id: 'RJ2', title: 'Same' }], 1);
        const root = testDirectory([{ name: 'Same', kind: 'directory' }]);
        persisted.directory = root.handle;

        await (runner as any).continueDiscovery('job', persisted);

        const additions = repo.appendFilesAndUpdateOptions.mock.calls.flatMap(call => call[2] as any[]);
        expect(repo.files[0].path).toBe('Same/first.wav');
        expect(root.enumerate).toHaveBeenCalledTimes(1);
        expect(additions).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'Same (2)/track.wav' })]));
    });

    it('does not re-enumerate or rename persisted paths once discovery is complete', async () => {
        const root = testDirectory([{ name: 'Work', kind: 'directory' }]);
        const file = { id: 'file', jobId: 'job', path: 'Work/track.wav', status: 'paused', downloadedBytes: 64 };
        const repo = repository([file]);
        const runner = new DownloadCenterRunner(repo as any);
        const persisted = options([{ id: 'RJ2', title: 'Work' }]);
        persisted.directory = root.handle;
        persisted.discovery!.complete = true;

        const result = await (runner as any).continueDiscovery('job', persisted);

        expect(result).toBe(persisted);
        expect(root.enumerate).not.toHaveBeenCalled();
        expect(repo.files[0]).toMatchObject({ path: 'Work/track.wav', downloadedBytes: 64 });
        expect(repo.appendFilesAndUpdateOptions).not.toHaveBeenCalled();
    });

    it('serializes downloads when Opus conversion is enabled to bound wasm memory', async () => {
        const file = { id: 'file', jobId: 'job', path: 'Work/track.wav', status: 'paused', downloadedBytes: 0 };
        const repo = repository([file]);
        const runner = new DownloadCenterRunner(repo as any);
        const persisted = options([{ id: 'RJ2', title: 'Work' }], 0, { convertToOpus: true });
        persisted.discovery!.complete = true;

        await (runner as any).prepareAndRun('job', persisted).catch(() => undefined);

        expect(mocks.coordinatorArgs.at(-1)?.[3]).toBe(1);
    });

    it('persists only selected playlist/direct-search works and never polls listJobs while active', async () => {
        const repo = repository();
        const runner = new DownloadCenterRunner(repo as any);
        vi.spyOn(runner as any, 'prepareAndRun').mockImplementation(async (...args: unknown[]) => args[1] as PersistedDownloadCenterOptions);
        const allWorks = [
            { id: 'RJ1', title: 'Playlist work', playlistIds: ['mine'] },
            { id: 'RJ2', title: 'Direct search result' },
        ];

        await runner.start(allWorks, state({ selectedWorkIds: ['RJ2'] }), {} as FileSystemDirectoryHandle, 'Job');

        const created = repo.createJob.mock.calls[0][0];
        expect(created.options.discovery.works).toEqual([{ id: 'RJ2', title: 'Direct search result', playlistIds: undefined }]);
        expect(repo.listJobs).not.toHaveBeenCalled();
    });

    it('performs stale-job recovery exactly once', async () => {
        const repo = repository();
        const runner = new DownloadCenterRunner(repo as any);
        await Promise.all([runner.recoverInterruptedJobs(), runner.recoverInterruptedJobs(), runner.recoverInterruptedJobs()]);
        expect(repo.listJobs).toHaveBeenCalledTimes(1);
    });

    it('keeps a healthy active run leased when a remounted view queries recovery in the same page', async () => {
        const databaseName = `download-center-remount-${crypto.randomUUID()}`;
        const ownerRepository = persistentRepository(databaseName);
        const remountedRepository = persistentRepository(databaseName);
        const owner = new DownloadCenterRunner(ownerRepository);
        const held = await beginHeldRun(owner);
        try {
            const sameRunnerRecovery = await owner.recoverInterruptedJobs();
            const remounted = new DownloadCenterRunner(remountedRepository);
            const recoverable = await remounted.recoverInterruptedJobs();
            const persisted = (await ownerRepository.listJobs()).find(job => job.id === held.jobId);

            expect(sameRunnerRecovery.map(job => job.id)).not.toContain(held.jobId);
            expect(recoverable.map(job => job.id)).not.toContain(held.jobId);
            expect(persisted?.status).toBe('active');
            expect(owner.runningJobId).toBe(held.jobId);
        } finally {
            held.finish.resolve();
            await held.run.catch(() => undefined);
        }
    });

    it('prevents a second tab owner from recovering or resuming a currently leased job', async () => {
        const databaseName = `download-center-owners-${crypto.randomUUID()}`;
        const ownerRepository = persistentRepository(databaseName);
        const competingRepository = persistentRepository(databaseName);
        const owner = new DownloadCenterRunner(ownerRepository);
        const held = await beginHeldRun(owner);
        try {
            const active = (await ownerRepository.listJobs<PersistedDownloadCenterOptions>())
                .find(job => job.id === held.jobId) as DownloadCenterJob | undefined;
            expect(active?.status).toBe('active');

            const competitor = new DownloadCenterRunner(competingRepository);
            expect((await competitor.recoverInterruptedJobs()).map(job => job.id)).not.toContain(held.jobId);
            const competingPrepare = vi.spyOn(competitor as any, 'prepareAndRun');
            await expect(competitor.resume(active!)).rejects.toThrow();
            expect(competingPrepare).not.toHaveBeenCalled();
            expect(owner.runningJobId).toBe(held.jobId);
        } finally {
            held.finish.resolve();
            await held.run.catch(() => undefined);
        }
    });

    it('recovers and resumes a lease only after its heartbeat deadline has genuinely expired', async () => {
        const databaseName = `download-center-stale-${crypto.randomUUID()}`;
        const firstRepository = persistentRepository(databaseName);
        const recoveryRepository = persistentRepository(databaseName);
        let now = Date.UTC(2026, 6, 16, 0, 0, 0);
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const abandoned = new DownloadCenterRunner(firstRepository);
        const held = await beginHeldRun(abandoned);
        try {
            const observerBeforeExpiry = new DownloadCenterRunner(recoveryRepository);

            expect((await observerBeforeExpiry.recoverInterruptedJobs()).map(job => job.id)).not.toContain(held.jobId);

            // Advancing Date.now without running the first owner's interval models a
            // suspended/crashed tab: no heartbeat can extend the persisted lease.
            now += DOWNLOAD_JOB_LEASE_MS + 1;
            const recoveryAfterExpiry = new DownloadCenterRunner(persistentRepository(databaseName));
            const recoverable = await recoveryAfterExpiry.recoverInterruptedJobs();
            const stale = recoverable.find(job => job.id === held.jobId);
            expect(stale).toMatchObject({ id: held.jobId, status: 'paused' });

            const recoveringPrepare = vi.spyOn(recoveryAfterExpiry as any, 'prepareAndRun')
                .mockImplementation(async (...args: unknown[]) => args[1] as PersistedDownloadCenterOptions);
            await expect(recoveryAfterExpiry.resume(stale!)).resolves.toMatchObject({ jobId: held.jobId });
            expect(recoveringPrepare).toHaveBeenCalledTimes(1);
        } finally {
            held.finish.resolve();
            await held.run.catch(() => undefined);
        }
    });

    it('releases ownership and clears active runner state when a run settles with an error', async () => {
        const databaseName = `download-center-release-${crypto.randomUUID()}`;
        const firstRepository = persistentRepository(databaseName);
        const nextRepository = persistentRepository(databaseName);
        const first = new DownloadCenterRunner(firstRepository);
        const failure = new Error('simulated tab-local failure');
        vi.spyOn(first as any, 'prepareAndRun').mockRejectedValue(failure);

        await expect(first.start(
            [{ id: 'RJ2', title: 'Work' }],
            state(),
            {} as FileSystemDirectoryHandle,
            'Failed job',
        )).rejects.toBe(failure);
        expect(first.runningJobId).toBeNull();

        const next = new DownloadCenterRunner(nextRepository);
        const [released] = await next.recoverInterruptedJobs();
        expect(released).toMatchObject({ status: 'paused' });
        const nextPrepare = vi.spyOn(next as any, 'prepareAndRun')
            .mockImplementation(async (...args: unknown[]) => args[1] as PersistedDownloadCenterOptions);
        await expect(next.resume(released)).resolves.toMatchObject({ jobId: released.id });
        expect(nextPrepare).toHaveBeenCalledTimes(1);
        expect(next.runningJobId).toBeNull();
    });
});
