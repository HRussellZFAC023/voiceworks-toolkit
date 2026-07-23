import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getTracks: vi.fn(),
    getWorkInfo: vi.fn(),
    coordinatorRun: vi.fn(),
    coordinatorPause: vi.fn(),
    coordinatorArgs: [] as unknown[][],
    translateBatch: vi.fn(),
    cancelPending: vi.fn(),
    isTargetLanguage: vi.fn(),
}));

vi.mock('../../src/services/WorkService', () => ({
    WorkService: { getTracks: mocks.getTracks, getWorkInfo: mocks.getWorkInfo },
}));
vi.mock('../../src/services/TranslationService', () => ({
    TranslationService: {
        getUiTargetLang: vi.fn(() => 'en'),
        translateBatch: mocks.translateBatch,
        cancelPending: mocks.cancelPending,
        isTargetLanguage: mocks.isTargetLanguage,
    },
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
    DOWNLOAD_ARTWORK_MAX_BYTES,
    DOWNLOAD_ARTWORK_TIMEOUT_MS,
    DOWNLOAD_DISCOVERY_BATCH_SIZE,
    DOWNLOAD_DISCOVERY_CONCURRENCY,
    DOWNLOAD_OPTIONAL_METADATA_CONCURRENCY,
    DOWNLOAD_OPTIONAL_METADATA_WAIT_MS,
    DOWNLOAD_OPTIONAL_TRANSLATION_WAIT_MS,
    DOWNLOAD_TITLE_TRANSLATION_BATCH_SIZE,
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
        mocks.translateBatch.mockResolvedValue(['Translated work']);
        mocks.isTargetLanguage.mockReturnValue(false);
        mocks.getTracks.mockResolvedValue([{ type: 'audio', hash: 'audio', title: 'track.wav', mediaDownloadUrl: 'https://media.test/track.wav' }]);
        mocks.getWorkInfo.mockResolvedValue(info());
        mocks.coordinatorRun.mockResolvedValue(undefined);
    });

    afterEach(async () => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
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
        expect(mocks.getTracks).toHaveBeenCalledWith('RJ2', false, true);
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

    it('persists full-quality stream fallbacks without ever selecting low-quality audio', async () => {
        mocks.getTracks.mockResolvedValue([{
            type: 'audio',
            hash: 'audio',
            title: 'track.wav',
            mediaDownloadUrl: 'https://media.test/download.wav',
            mediaStreamUrl: 'https://media.test/stream.wav',
            streamLowQualityUrl: 'https://media.test/low.mp3',
        }]);
        mocks.getWorkInfo.mockResolvedValue(info(''));
        const repo = repository();
        const runner = new DownloadCenterRunner(repo as any);

        await (runner as any).continueDiscovery('job', options([{ id: 'RJ2', title: 'Work' }]));

        const file = repo.appendFilesAndUpdateOptions.mock.calls.flatMap(call => call[2] as any[])[0];
        expect(file).toMatchObject({
            url: 'https://media.test/download.wav',
            sourceUrls: ['https://media.test/stream.wav'],
        });
        expect(file.sourceUrls).not.toContain('https://media.test/low.mp3');
    });

    it('skips preview-only entries and reports their work as unavailable', async () => {
        mocks.getTracks.mockResolvedValue([{
            type: 'audio',
            hash: 'audio',
            title: 'track.mp3',
            streamLowQualityUrl: 'https://media.test/whisper-preview.mp3',
        }]);
        mocks.getWorkInfo.mockResolvedValue(info(''));
        const repo = repository();
        const runner = new DownloadCenterRunner(repo as any);

        const result = await (runner as any).continueDiscovery(
            'job',
            options([{ id: 'RJ2', title: 'Work' }], 0, {
                filters: { audio: true, video: false, image: false, text: true, other: false },
                includeArtwork: false,
            }),
        );

        const additions = repo.appendFilesAndUpdateOptions.mock.calls.flatMap(call => call[2] as any[]);
        expect(additions).toEqual([]);
        expect(result.discovery).toMatchObject({
            complete: true,
            skippedWorkIds: ['RJ2'],
        });
    });

    it('selects a later full-quality source when a low-quality preview appears first', async () => {
        mocks.getTracks.mockResolvedValue([{
            type: 'audio',
            hash: 'audio',
            title: 'track.wav',
            streamLowQualityUrl: 'https://media.test/whisper-preview.mp3',
            src: 'https://media.test/full-source.wav',
            url: 'https://media.test/full-alternate.wav',
        }]);
        mocks.getWorkInfo.mockResolvedValue(info(''));
        const repo = repository();
        const runner = new DownloadCenterRunner(repo as any);

        await (runner as any).continueDiscovery('job', options([{ id: 'RJ2', title: 'Work' }]));

        const file = repo.appendFilesAndUpdateOptions.mock.calls.flatMap(call => call[2] as any[])[0];
        expect(file).toMatchObject({
            url: 'https://media.test/full-source.wav',
            sourceUrls: ['https://media.test/full-alternate.wav'],
        });
        expect(file.sourceUrls).not.toContain('https://media.test/whisper-preview.mp3');
    });

    it('starts required tracks and optional metadata requests concurrently for each work', async () => {
        const tracks = deferred<unknown[]>();
        const metadata = deferred<ReturnType<typeof info>>();
        mocks.getTracks.mockReturnValueOnce(tracks.promise);
        mocks.getWorkInfo.mockReturnValueOnce(metadata.promise);
        const repo = repository();
        const runner = new DownloadCenterRunner(repo as any);

        const discovery = (runner as any).continueDiscovery('job', options([{ id: 'RJ2', title: 'Work' }]));
        await vi.waitFor(() => expect(mocks.getTracks).toHaveBeenCalledWith('RJ2', false, true));
        expect(mocks.getWorkInfo).toHaveBeenCalledWith('RJ2');

        tracks.resolve([{ type: 'audio', hash: 'audio', title: 'track.wav', mediaDownloadUrl: 'https://media.test/track.wav' }]);
        metadata.resolve(info(''));
        await discovery;
    });

    it('does not let stalled optional metadata block required file discovery', async () => {
        vi.useFakeTimers();
        mocks.getTracks.mockResolvedValueOnce([
            { type: 'audio', hash: 'audio', title: 'track.wav', mediaDownloadUrl: 'https://media.test/track.wav' },
        ]);
        mocks.getWorkInfo.mockReturnValueOnce(new Promise(() => undefined));
        const repo = repository();
        const runner = new DownloadCenterRunner(repo as any);

        const discovery = (runner as any).continueDiscovery('job', options([{ id: 'RJ2', title: 'Work' }]));
        await vi.advanceTimersByTimeAsync(DOWNLOAD_OPTIONAL_METADATA_WAIT_MS);
        await discovery;

        const additions = repo.appendFilesAndUpdateOptions.mock.calls.flatMap(call => call[2] as any[]);
        expect(additions).toEqual(expect.arrayContaining([
            expect.objectContaining({ path: 'Work/track.wav' }),
        ]));
    });

    it('bounds timed-out optional metadata while continuing every required manifest', async () => {
        vi.useFakeTimers();
        const works = Array.from({ length: DOWNLOAD_OPTIONAL_METADATA_CONCURRENCY + 5 }, (_, index) => ({
            id: `RJ${index + 1}`,
            title: `Work ${index + 1}`,
        }));
        mocks.getWorkInfo.mockImplementation(() => new Promise(() => undefined));
        const repo = repository();
        const runner = new DownloadCenterRunner(repo as any);

        const discovery = (runner as any).continueDiscovery('job', options(works));
        await vi.advanceTimersByTimeAsync(DOWNLOAD_OPTIONAL_METADATA_WAIT_MS);
        await discovery;

        expect(mocks.getTracks).toHaveBeenCalledTimes(works.length);
        expect(mocks.getWorkInfo).toHaveBeenCalledTimes(DOWNLOAD_OPTIONAL_METADATA_CONCURRENCY);
        expect(repo.appendFilesAndUpdateOptions.mock.calls.flatMap(call => call[2] as any[])).toHaveLength(works.length);
    });

    it('keeps stalled filename translation retryable instead of permanently accepting originals', async () => {
        vi.useFakeTimers();
        mocks.translateBatch.mockReturnValueOnce(new Promise(() => undefined));
        const repo = repository();
        const runner = new DownloadCenterRunner(repo as any);
        const persisted = options([{ id: 'RJ2', title: 'Original work' }]);
        persisted.discovery!.titlesReady = false;
        persisted.state.titleMode = 'original-bracketed-translation';

        const preparingTitles = (runner as any).prepareAndRun('job', persisted)
            .catch((value: unknown) => value);
        await vi.advanceTimersByTimeAsync(DOWNLOAD_OPTIONAL_TRANSLATION_WAIT_MS);
        const error = await preparingTitles;

        expect(error).toBeInstanceOf(DownloadCenterRunError);
        expect(error).toMatchObject({ code: 'failed' });
        expect(repo.storedOptions?.discovery).toMatchObject({
            titlesReady: false,
            works: [expect.objectContaining({ title: 'Original work' })],
        });
        expect(repo.storedOptions?.discovery?.works[0].translatedTitle).toBeUndefined();
        expect(mocks.cancelPending).toHaveBeenCalledWith({ cancellableKey: 'download-titles:job:0' });
        expect(repo.appendFilesAndUpdateOptions).toHaveBeenCalledTimes(1);
        expect(mocks.getTracks).not.toHaveBeenCalled();
    });

    it('translates and checkpoints large selections in bounded progressive batches', async () => {
        const works = Array.from({ length: DOWNLOAD_TITLE_TRANSLATION_BATCH_SIZE * 2 + 1 }, (_, index) => ({
            id: `RJ${index + 1}`,
            title: `Work ${index + 1}`,
        }));
        mocks.translateBatch.mockImplementation(async (titles: string[]) =>
            titles.map(title => `Translated ${title}`));
        const repo = repository();
        const runner = new DownloadCenterRunner(repo as any);
        const persisted = options(works);
        persisted.discovery!.titlesReady = false;
        persisted.state.titleMode = 'translated';
        const progress = vi.fn();

        const resolved = await (runner as any).ensureTitles('job', persisted, progress);

        expect(mocks.translateBatch).toHaveBeenCalledTimes(3);
        expect(mocks.translateBatch.mock.calls.map(call => call[0])).toEqual([
            works.slice(0, DOWNLOAD_TITLE_TRANSLATION_BATCH_SIZE).map(work => work.title),
            works.slice(DOWNLOAD_TITLE_TRANSLATION_BATCH_SIZE, DOWNLOAD_TITLE_TRANSLATION_BATCH_SIZE * 2).map(work => work.title),
            works.slice(DOWNLOAD_TITLE_TRANSLATION_BATCH_SIZE * 2).map(work => work.title),
        ]);
        expect(repo.appendFilesAndUpdateOptions).toHaveBeenCalledTimes(3);
        expect(repo.appendFilesAndUpdateOptions.mock.calls.map(call =>
            call[1].discovery!.works.filter((work: BackupWorkDownloadItem) => work.translatedTitle).length,
        )).toEqual([
            DOWNLOAD_TITLE_TRANSLATION_BATCH_SIZE,
            DOWNLOAD_TITLE_TRANSLATION_BATCH_SIZE * 2,
            works.length,
        ]);
        expect(resolved.discovery?.titlesReady).toBe(true);
        expect(progress).toHaveBeenLastCalledWith({
            jobId: 'job',
            phase: 'translating',
            current: works.length,
            total: works.length,
        });
    });

    it('does not mark titles ready when a completed batch falls back to source text', async () => {
        mocks.translateBatch.mockResolvedValueOnce(['Translated first', '作品 2']);
        const repo = repository();
        const runner = new DownloadCenterRunner(repo as any);
        const persisted = options([
            { id: 'RJ1', title: '作品 1' },
            { id: 'RJ2', title: '作品 2' },
        ]);
        persisted.discovery!.titlesReady = false;
        persisted.state.titleMode = 'translated';

        const error = await (runner as any).ensureTitles('job', persisted).catch((value: unknown) => value);

        expect(error).toBeInstanceOf(DownloadCenterRunError);
        expect(error).toMatchObject({ code: 'failed' });
        expect(repo.storedOptions?.discovery?.works).toEqual([
            expect.objectContaining({ translatedTitle: 'Translated first' }),
            expect.objectContaining({ translatedTitle: '作品 2' }),
        ]);
        expect(repo.storedOptions?.discovery?.titlesReady).toBe(false);
    });

    it('accepts already-target titles and bare RJ identifiers as legitimate unchanged names', async () => {
        mocks.isTargetLanguage.mockImplementation((title: string, target: string) =>
            title === 'Already English' && target === 'en');
        const repo = repository();
        const runner = new DownloadCenterRunner(repo as any);
        const persisted = options([
            { id: 'RJ1', title: 'Already English' },
            { id: 'RJ123456', title: 'RJ123456' },
        ]);
        persisted.discovery!.titlesReady = false;
        persisted.state.titleMode = 'translated';

        const resolved = await (runner as any).ensureTitles('job', persisted);

        expect(mocks.translateBatch).not.toHaveBeenCalled();
        expect(resolved.discovery?.titlesReady).toBe(true);
        expect(resolved.discovery?.works).toEqual(persisted.discovery?.works);
    });

    it('persists completed title batches and retries only unresolved titles on resume', async () => {
        vi.useFakeTimers();
        const works = Array.from({ length: DOWNLOAD_TITLE_TRANSLATION_BATCH_SIZE + 2 }, (_, index) => ({
            id: `RJ${index + 1}`,
            title: `Work ${index + 1}`,
        }));
        mocks.translateBatch
            .mockImplementationOnce(async (titles: string[]) => titles.map(title => `Translated ${title}`))
            .mockReturnValueOnce(new Promise(() => undefined));
        const repo = repository();
        const runner = new DownloadCenterRunner(repo as any);
        const persisted = options(works);
        persisted.discovery!.titlesReady = false;
        persisted.state.titleMode = 'original-bracketed-translation';

        const firstAttempt = (runner as any).ensureTitles('job', persisted)
            .catch((value: unknown) => value);
        await vi.waitFor(() => expect(mocks.translateBatch).toHaveBeenCalledTimes(2));
        await vi.advanceTimersByTimeAsync(DOWNLOAD_OPTIONAL_TRANSLATION_WAIT_MS);
        const firstError = await firstAttempt;
        const partial = repo.storedOptions!;

        expect(firstError).toBeInstanceOf(DownloadCenterRunError);
        expect(firstError).toMatchObject({ code: 'failed' });
        expect(partial.discovery?.titlesReady).toBe(false);
        expect(partial.discovery?.works.slice(0, DOWNLOAD_TITLE_TRANSLATION_BATCH_SIZE))
            .toEqual(expect.arrayContaining([
                expect.objectContaining({ translatedTitle: 'Translated Work 1' }),
            ]));
        expect(repo.appendFilesAndUpdateOptions).toHaveBeenCalledTimes(1);

        mocks.translateBatch.mockImplementation(async (titles: string[]) =>
            titles.map(title => `Retried ${title}`));
        const resumed = await (runner as any).ensureTitles('job', partial);

        expect(mocks.translateBatch).toHaveBeenLastCalledWith(
            works.slice(DOWNLOAD_TITLE_TRANSLATION_BATCH_SIZE).map(work => work.title),
            'en',
            expect.objectContaining({ preserveRequestedTarget: true }),
        );
        expect(resumed.discovery?.titlesReady).toBe(true);
        expect(resumed.discovery?.works.every((work: BackupWorkDownloadItem) => work.translatedTitle)).toBe(true);
    });

    it('pauses during discovery and atomically checkpoints the completed partial batch', async () => {
        const tracks = deferred<unknown[]>();
        mocks.getTracks.mockReturnValueOnce(tracks.promise);
        const repo = repository();
        const runner = new DownloadCenterRunner(repo as any);
        (runner as any).activeJobId = 'job';

        const discovery = (runner as any).continueDiscovery('job', options([
            { id: 'RJ1', title: 'First' },
            { id: 'RJ2', title: 'Second' },
        ]));
        await vi.waitFor(() => expect(mocks.getTracks).toHaveBeenCalledWith('RJ1', false, true));
        await runner.pause();
        tracks.resolve([{ type: 'audio', hash: 'audio', title: 'track.wav', mediaDownloadUrl: 'https://media.test/track.wav' }]);

        await expect(discovery).rejects.toMatchObject({ code: 'paused' });
        // Bounded prefetch may already have started RJ2, but a pause must not
        // checkpoint speculative work beyond the completed ordered prefix.
        expect(repo.appendFilesAndUpdateOptions).toHaveBeenCalledTimes(1);
        expect(repo.appendFilesAndUpdateOptions).toHaveBeenCalledWith('job', expect.objectContaining({
            discovery: expect.objectContaining({ nextIndex: 1, complete: false }),
        }), expect.arrayContaining([expect.objectContaining({ path: 'First/track.wav' })]));
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

    it('prefetches manifests with bounded concurrency and preserves output order', async () => {
        const works = Array.from({ length: 6 }, (_, index) => ({
            id: `RJ${index + 1}`,
            title: `Work ${index + 1}`,
        }));
        const releases: Array<() => void> = [];
        let active = 0;
        let maxActive = 0;
        mocks.getTracks.mockImplementation(async (id: string) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise<void>(resolve => releases.push(resolve));
            active -= 1;
            return [{
                type: 'audio',
                hash: id,
                title: `${id}.wav`,
                mediaDownloadUrl: `https://media.test/${id}.wav`,
            }];
        });
        mocks.getWorkInfo.mockResolvedValue(info(''));
        const repo = repository();
        const runner = new DownloadCenterRunner(repo as any);
        const pending = (runner as any).continueDiscovery('job', options(works));

        await vi.waitFor(() => expect(active).toBe(DOWNLOAD_DISCOVERY_CONCURRENCY));
        while (active > 0 || releases.length > 0) {
            releases.splice(0).forEach(release => release());
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        await pending;

        expect(maxActive).toBe(DOWNLOAD_DISCOVERY_CONCURRENCY);
        const additions = repo.appendFilesAndUpdateOptions.mock.calls.flatMap(call => call[2] as any[]);
        expect(additions.map(file => file.path)).toEqual(
            works.map(work => `${work.title}/${work.id}.wav`),
        );
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

    it('uses three file workers when conversion is disabled', async () => {
        const file = { id: 'file', jobId: 'job', path: 'Work/track.wav', status: 'paused', downloadedBytes: 0 };
        const repo = repository([file]);
        const runner = new DownloadCenterRunner(repo as any);
        const persisted = options([{ id: 'RJ2', title: 'Work' }]);
        persisted.discovery!.complete = true;

        await (runner as any).prepareAndRun('job', persisted).catch(() => undefined);

        expect(mocks.coordinatorArgs.at(-1)?.[3]).toBe(3);
    });

    it('omits credentials when loading Opus artwork from an external CDN', async () => {
        const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
        }));
        vi.stubGlobal('fetch', fetchMock);
        const runner = new DownloadCenterRunner(repository() as any);
        const persisted = options([{ id: 'RJ2', title: 'Work' }], 0, { convertToOpus: true });
        persisted.enrichment = {
            file: { tags: {}, artworkUrl: 'https://images.example.test/cover.jpg' },
        };

        const transformer = (runner as any).createOpusTransformer(persisted);
        const artwork = await transformer.options.artworkForFile({ id: 'file' });

        expect(artwork).toMatchObject({ mimeType: 'image/jpeg' });
        expect(fetchMock).toHaveBeenCalledWith(
            'https://images.example.test/cover.jpg',
            {
                credentials: 'omit',
                headers: {},
                signal: expect.any(AbortSignal),
            },
        );
    });

    it('continues Opus conversion without artwork when request establishment never resolves', async () => {
        vi.useFakeTimers();
        let artworkSignal: AbortSignal | undefined;
        vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
            artworkSignal = init?.signal as AbortSignal;
            return new Promise<Response>(() => undefined);
        }));
        const runner = new DownloadCenterRunner(repository() as any);
        const persisted = options([{ id: 'RJ2', title: 'Work' }], 0, { convertToOpus: true });
        persisted.enrichment = {
            file: { tags: {}, artworkUrl: 'https://images.example.test/hanging-cover.jpg' },
        };
        const transformer = (runner as any).createOpusTransformer(persisted);
        const transcode = vi.fn(async () => new Uint8Array([7, 8]));
        transformer.transcoder = { transcode };
        const sink = {
            read: vi.fn(async () => new Uint8Array([1, 2, 3])),
            writeAll: vi.fn(),
        };

        const conversion = transformer.transform(
            { id: 'file', path: 'Work/track.wav', totalBytes: 3, downloadedBytes: 3 },
            sink,
        );
        await Promise.resolve();
        expect(sink.read).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(DOWNLOAD_ARTWORK_TIMEOUT_MS);

        await expect(conversion).resolves.toEqual({ path: 'Work/track.opus', bytes: 2 });
        expect(artworkSignal?.aborted).toBe(true);
        expect(sink.read).toHaveBeenCalledTimes(1);
        expect(transcode).toHaveBeenCalledWith(expect.objectContaining({ artwork: undefined }));
    });

    it('times out a stalled artwork body, cancels it, and converts without artwork', async () => {
        vi.useFakeTimers();
        const cancel = vi.fn();
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
            pull: () => new Promise<void>(() => undefined),
            cancel,
        }), {
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
        })));
        const runner = new DownloadCenterRunner(repository() as any);
        const persisted = options([{ id: 'RJ2', title: 'Work' }], 0, { convertToOpus: true });
        persisted.enrichment = {
            file: { tags: {}, artworkUrl: 'https://images.example.test/stalled-body.jpg' },
        };
        const transformer = (runner as any).createOpusTransformer(persisted);
        const transcode = vi.fn(async () => new Uint8Array([7]));
        transformer.transcoder = { transcode };
        const sink = {
            read: vi.fn(async () => new Uint8Array([1])),
            writeAll: vi.fn(),
        };

        const conversion = transformer.transform(
            { id: 'file', path: 'track.wav', totalBytes: 1, downloadedBytes: 1 },
            sink,
        );
        await vi.advanceTimersByTimeAsync(DOWNLOAD_ARTWORK_TIMEOUT_MS);

        await expect(conversion).resolves.toEqual({ path: 'track.opus', bytes: 1 });
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(transcode).toHaveBeenCalledWith(expect.objectContaining({ artwork: undefined }));
    });

    it('cancels declared-oversize artwork before reading its body', async () => {
        const cancel = vi.fn();
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
            cancel,
        }), {
            status: 200,
            headers: {
                'content-type': 'image/jpeg',
                'content-length': String(DOWNLOAD_ARTWORK_MAX_BYTES + 1),
            },
        })));
        const runner = new DownloadCenterRunner(repository() as any);
        const persisted = options([{ id: 'RJ2', title: 'Work' }], 0, { convertToOpus: true });
        persisted.enrichment = {
            file: { tags: {}, artworkUrl: 'https://images.example.test/oversize.jpg' },
        };
        const transformer = (runner as any).createOpusTransformer(persisted);

        await expect(transformer.options.artworkForFile({ id: 'file' })).resolves.toBeUndefined();
        expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('cancels an artwork body that exceeds the cap without a declared size', async () => {
        const cancel = vi.fn();
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array(DOWNLOAD_ARTWORK_MAX_BYTES));
                controller.enqueue(new Uint8Array([1]));
            },
            cancel,
        }), {
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
        })));
        const runner = new DownloadCenterRunner(repository() as any);
        const persisted = options([{ id: 'RJ2', title: 'Work' }], 0, { convertToOpus: true });
        persisted.enrichment = {
            file: { tags: {}, artworkUrl: 'https://images.example.test/streamed-oversize.jpg' },
        };
        const transformer = (runner as any).createOpusTransformer(persisted);

        await expect(transformer.options.artworkForFile({ id: 'file' })).resolves.toBeUndefined();
        expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('threads a job abort into artwork loading and does not retain source audio', async () => {
        let artworkSignal: AbortSignal | undefined;
        vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
            artworkSignal = init?.signal as AbortSignal;
            return new Promise<Response>(() => undefined);
        }));
        const runner = new DownloadCenterRunner(repository() as any);
        const persisted = options([{ id: 'RJ2', title: 'Work' }], 0, { convertToOpus: true });
        persisted.enrichment = {
            file: { tags: {}, artworkUrl: 'https://images.example.test/abort.jpg' },
        };
        const transformer = (runner as any).createOpusTransformer(persisted);
        const sink = { read: vi.fn(), writeAll: vi.fn() };
        const controller = new AbortController();

        const conversion = transformer.transform(
            { id: 'file', path: 'track.wav', totalBytes: 1, downloadedBytes: 1 },
            sink,
            controller.signal,
        );
        await Promise.resolve();
        controller.abort('paused');

        await expect(conversion).rejects.toMatchObject({ name: 'AbortError' });
        expect(artworkSignal?.aborted).toBe(true);
        expect(sink.read).not.toHaveBeenCalled();
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
