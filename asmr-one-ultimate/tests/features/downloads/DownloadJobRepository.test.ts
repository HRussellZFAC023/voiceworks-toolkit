import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import {
    DownloadJobRepository,
    DownloadRecordNotFoundError,
} from '../../../src/features/downloads/DownloadJobRepository';

const repositories: DownloadJobRepository[] = [];
const repository = (name = `download-jobs-${crypto.randomUUID()}`) => {
    const value = new DownloadJobRepository(name);
    repositories.push(value);
    return value;
};

const seed = (repo: DownloadJobRepository, statuses?: { job?: 'active'; first?: 'active' | 'failed' }) => repo.createJob(
    { id: 'job-1', title: 'Work', options: { language: 'zh-CN', selected: ['audio'] }, status: statuses?.job },
    [
        { id: 'file-1', path: 'Work/one.wav', url: '/one', totalBytes: 100, status: statuses?.first },
        { id: 'file-2', path: 'Work/two.wav', url: '/two', totalBytes: 200 },
    ],
);

afterEach(async () => {
    await Promise.all(repositories.splice(0).map((repo) => repo.deleteDatabase()));
});

describe('DownloadJobRepository', () => {
    it('atomically persists discovery progress with each newly discovered file', async () => {
        const name = `download-jobs-${crypto.randomUUID()}`;
        const first = repository(name);
        await first.createJob({
            id: 'discovering', title: 'Many works', options: { discovery: { nextIndex: 0 }, selected: ['RJ1', 'RJ2'] },
        }, []);
        await first.appendFilesAndUpdateOptions('discovering', {
            discovery: { nextIndex: 1 }, selected: ['RJ1', 'RJ2'],
        }, [{ id: 'found-1', path: 'One/track.wav', url: '/one' }]);
        await first.close();

        const snapshot = await repository(name).loadJob<{ discovery: { nextIndex: number }; selected: string[] }>('discovering');
        expect(snapshot?.job.options).toEqual({ discovery: { nextIndex: 1 }, selected: ['RJ1', 'RJ2'] });
        expect(snapshot?.files).toEqual([expect.objectContaining({ id: 'found-1', status: 'pending' })]);
    });

    it('persists the job profile, files, and checkpoints across instances', async () => {
        const name = `download-jobs-${crypto.randomUUID()}`;
        const first = repository(name);
        await seed(first);
        await first.checkpointFile('file-1', { offset: 42, etag: 'v1' });
        await first.close();

        const snapshot = await repository(name).loadJob<{ language: string; selected: string[] }>('job-1');
        expect(snapshot?.job.options).toEqual({ language: 'zh-CN', selected: ['audio'] });
        expect(snapshot?.files.find((file) => file.id === 'file-1')?.downloadedBytes).toBe(42);
        expect(snapshot?.checkpoints).toEqual([expect.objectContaining({ fileId: 'file-1', offset: 42, etag: 'v1' })]);
    });

    it('persists the selected full-quality source for refresh-safe resume', async () => {
        const name = `download-jobs-${crypto.randomUUID()}`;
        const first = repository(name);
        await first.createJob({ id: 'fallback', title: 'Fallback', options: {} }, [{
            id: 'audio',
            path: 'Work/track.wav',
            url: 'https://media.test/download.wav',
            sourceUrls: ['https://media.test/stream.wav'],
        }]);
        await first.selectFileSource('audio', 'https://media.test/stream.wav', [
            'https://media.test/download.wav',
        ]);
        await first.close();

        const file = (await repository(name).getFile('audio'));
        expect(file).toMatchObject({ url: 'https://media.test/stream.wav' });
        expect(file?.sourceUrls).toEqual(['https://media.test/download.wav']);
    });

    it('atomically recovers stale active jobs and files as paused on load', async () => {
        const repo = repository();
        await seed(repo, { job: 'active', first: 'active' });
        await repo.checkpointFile('file-1', { offset: 21 });

        const snapshot = await repo.loadJob('job-1');
        expect(snapshot?.job.status).toBe('paused');
        expect(snapshot?.files.find((file) => file.id === 'file-1')).toMatchObject({ status: 'paused', downloadedBytes: 21 });
    });

    it('keeps checkpoints monotonic and clears them when a file completes', async () => {
        const repo = repository();
        await seed(repo);
        await repo.checkpointFile('file-1', { offset: 60, etag: 'v1' });
        const checkpoint = await repo.checkpointFile('file-1', { offset: 20, lastModified: 'today' });
        expect(checkpoint).toMatchObject({ offset: 60, etag: 'v1', lastModified: 'today' });

        await repo.markFileComplete('file-1', 100);
        expect(await repo.getCheckpoint('file-1')).toBeUndefined();
        expect(await repo.getFile('file-1')).toMatchObject({ status: 'completed', downloadedBytes: 100 });
        expect((await repo.listFiles('job-1')).filter((file) => file.status !== 'completed').map((file) => file.id)).toEqual(['file-2']);
    });

    it('retries only failed files while preserving completed files and progress', async () => {
        const repo = repository();
        await seed(repo, { first: 'failed' });
        await repo.checkpointFile('file-1', { offset: 40 });
        await repo.markFileComplete('file-2', 200);
        await repo.retryJob('job-1');

        const snapshot = await repo.loadJob('job-1');
        expect(snapshot?.job.status).toBe('pending');
        expect(snapshot?.files.find((file) => file.id === 'file-1')).toMatchObject({ status: 'pending', downloadedBytes: 40 });
        expect(snapshot?.files.find((file) => file.id === 'file-2')?.status).toBe('completed');
        expect(snapshot?.checkpoints).toHaveLength(1);
    });

    it('cancels unfinished files, then start-over clears every checkpoint and progress', async () => {
        const repo = repository();
        await seed(repo);
        await repo.checkpointFile('file-1', { offset: 30 });
        await repo.markFileComplete('file-2', 200);
        await repo.cancelJob('job-1');
        let snapshot = await repo.loadJob('job-1');
        expect(snapshot?.files.map((file) => file.status)).toEqual(['cancelled', 'completed']);

        await repo.startOverJob('job-1');
        snapshot = await repo.loadJob('job-1');
        expect(snapshot?.job.status).toBe('pending');
        expect(snapshot?.files.every((file) => file.status === 'pending' && file.downloadedBytes === 0)).toBe(true);
        expect(snapshot?.checkpoints).toEqual([]);
    });

    it('resets one file after an invalid Range response and supports job completion', async () => {
        const repo = repository();
        await seed(repo);
        await repo.checkpointFile('file-1', { offset: 50 });
        await repo.markFileFailed('file-1', 'validator changed');
        await repo.resetFile('file-1');
        expect(await repo.getFile('file-1')).toMatchObject({ status: 'pending', downloadedBytes: 0, error: undefined });
        expect(await repo.getCheckpoint('file-1')).toBeUndefined();

        await expect(repo.completeJob('job-1')).rejects.toThrow('unfinished files');
        await repo.markFileComplete('file-1', 100);
        await repo.markFileComplete('file-2', 200);
        await repo.completeJob('job-1');
        expect((await repo.loadJob('job-1'))?.job.status).toBe('completed');
    });

    it('throws typed errors for missing records', async () => {
        const repo = repository();
        await expect(repo.checkpointFile('missing', { offset: 1 })).rejects.toBeInstanceOf(DownloadRecordNotFoundError);
        await expect(repo.pauseJob('missing')).rejects.toBeInstanceOf(DownloadRecordNotFoundError);
        await expect(repo.resetFile('missing')).rejects.toBeInstanceOf(DownloadRecordNotFoundError);
    });

    it('records the final converted path and byte size after durable completion', async () => {
        const repo = repository();
        await seed(repo);
        await repo.markFileComplete('file-1', 100, { path: 'Work/one.opus', bytes: 37 });
        expect(await repo.getFile('file-1')).toMatchObject({
            status: 'completed', path: 'Work/one.opus', downloadedBytes: 37, totalBytes: 37,
        });
    });

    it('atomically deletes an empty discovery job so it cannot become a resumable zombie', async () => {
        const repo = repository();
        await repo.createJob({ id: 'empty', title: 'Empty', options: { discovery: { complete: true } } }, []);

        await repo.deleteJob('empty');

        expect(await repo.loadJob('empty')).toBeUndefined();
        expect(await repo.listJobs()).toEqual([]);
        await expect(repo.deleteJob('empty')).rejects.toBeInstanceOf(DownloadRecordNotFoundError);
    });
});
