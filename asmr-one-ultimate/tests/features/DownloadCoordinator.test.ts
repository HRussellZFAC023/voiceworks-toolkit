import { describe, expect, it, vi } from 'vitest';
import { DownloadAlreadyRunningError, DownloadCoordinator } from '../../src/features/downloads/DownloadCoordinator';
import { DirectoryPermissionError, ResumeOffsetMismatchError } from '../../src/features/downloads/DirectoryDownloadSink';

describe('DownloadCoordinator', () => {
    it('resumes at a checkpoint, writes the remaining bytes, and completes the job', async () => {
        const file: any = {
            id: 'file-1', jobId: 'job-1', path: 'Work/track.wav', url: 'https://media/track',
            status: 'pending', downloadedBytes: 2, createdAt: 1, updatedAt: 1,
        };
        const repository: any = {
            activateJob: vi.fn(),
            listFiles: vi.fn(async () => [file]),
            markFileActive: vi.fn(async () => { file.status = 'active'; }),
            getCheckpoint: vi.fn(async () => ({ fileId: file.id, jobId: file.jobId, offset: 2, etag: 'v1' })),
            checkpointFile: vi.fn(async (_id: string, checkpoint: any) => checkpoint),
            markSourceComplete: vi.fn(),
            markFileComplete: vi.fn(async (_id: string, total: number) => { file.status = 'completed'; file.downloadedBytes = total; }),
            completeJob: vi.fn(),
            pauseJob: vi.fn(),
            markFileFailed: vi.fn(),
            resetFile: vi.fn(),
        };
        const writer = { write: vi.fn(), close: vi.fn(), abort: vi.fn() };
        const sink: any = { open: vi.fn(async () => writer) };
        const transport: any = {
            stream: vi.fn(async (_url: string, offset: number, onChunk: any) => {
                expect(offset).toBe(2);
                await onChunk({ bytes: new Uint8Array([3, 4, 5]), offset: 2, total: 5, etag: 'v1' });
                return { size: 5, etag: 'v1', acceptsRanges: true };
            }),
        };

        await new DownloadCoordinator(repository, transport, sink, 1).run('job-1');

        expect(sink.open).toHaveBeenCalledWith(['Work', 'track.wav'], 2);
        expect(writer.write).toHaveBeenCalledWith(expect.any(Uint8Array), 2);
        expect(repository.checkpointFile).toHaveBeenCalledWith('file-1', expect.objectContaining({ offset: 5 }));
        expect(writer.close.mock.invocationCallOrder[0]).toBeLessThan(repository.checkpointFile.mock.invocationCallOrder[0]);
        expect(repository.markFileComplete).toHaveBeenCalledWith('file-1', 5);
        expect(repository.completeJob).toHaveBeenCalledWith('job-1');
    });

    it('never requests files already completed before refresh', async () => {
        const repository: any = {
            activateJob: vi.fn(),
            listFiles: vi.fn(async () => [{ id: 'done', jobId: 'job', status: 'completed' }]),
            completeJob: vi.fn(),
            pauseJob: vi.fn(),
        };
        const transport: any = { stream: vi.fn() };
        await new DownloadCoordinator(repository, transport, {} as any).run('job');
        expect(transport.stream).not.toHaveBeenCalled();
        expect(repository.completeJob).toHaveBeenCalledWith('job');
    });

    it('does not start another queued file after the job is paused', async () => {
        const files = ['one', 'two'].map(id => ({
            id, jobId: 'job', path: `${id}.wav`, url: `https://media/${id}`,
            status: 'pending', downloadedBytes: 0, createdAt: 1, updatedAt: 1,
        }));
        const repository: any = {
            activateJob: vi.fn(), listFiles: vi.fn(async () => files),
            markFileActive: vi.fn(async (id: string) => { files.find(file => file.id === id)!.status = 'active'; }),
            getCheckpoint: vi.fn(), checkpointFile: vi.fn(), markSourceComplete: vi.fn(),
            markFileComplete: vi.fn(), markFileFailed: vi.fn(), resetFile: vi.fn(),
            completeJob: vi.fn(), pauseJob: vi.fn(async () => undefined), cancelJob: vi.fn(),
        };
        const writer = { write: vi.fn(), close: vi.fn(), abort: vi.fn() };
        const transport: any = {
            stream: vi.fn((_url: string, _offset: number, _chunk: unknown, options: { signal: AbortSignal }) =>
                new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('paused', 'AbortError')), { once: true }))),
        };
        const coordinator = new DownloadCoordinator(repository, transport, { open: vi.fn(async () => writer) } as any, 1);
        const running = coordinator.run('job');
        await vi.waitFor(() => expect(transport.stream).toHaveBeenCalledTimes(1));
        await expect(new DownloadCoordinator(repository, transport, {} as any).run('job'))
            .rejects.toBeInstanceOf(DownloadAlreadyRunningError);
        await coordinator.pause('job');
        await running;
        expect(transport.stream).toHaveBeenCalledTimes(1);
        expect(repository.markFileActive).not.toHaveBeenCalledWith('two');
    });

    it('pauses cleanly when opening the destination loses permission', async () => {
        const file: any = { id: 'file', jobId: 'job', path: 'track.wav', url: 'url', status: 'pending' };
        const repository: any = {
            activateJob: vi.fn(), listFiles: vi.fn(async () => [file]), markFileActive: vi.fn(),
            getCheckpoint: vi.fn(), pauseJob: vi.fn(async () => { file.status = 'paused'; }),
            completeJob: vi.fn(), markFileFailed: vi.fn(),
        };
        const sink: any = { open: vi.fn().mockRejectedValue(new DirectoryPermissionError()) };
        await expect(new DownloadCoordinator(repository, {} as any, sink, 1).run('job')).resolves.toBeUndefined();
        expect(repository.markFileFailed).not.toHaveBeenCalled();
        expect(repository.pauseJob).toHaveBeenCalledWith('job');
    });

    it('does not remove source audio until the completed record is committed', async () => {
        const file: any = {
            id: 'file', jobId: 'job', path: 'track.wav', url: 'url', status: 'pending', sourceComplete: true, totalBytes: 4,
        };
        const repository: any = {
            activateJob: vi.fn(), listFiles: vi.fn(async () => [file]), markFileActive: vi.fn(), getCheckpoint: vi.fn(),
            markSourceComplete: vi.fn(), markFileComplete: vi.fn().mockRejectedValue(new Error('database crash')),
            markFileFailed: vi.fn(async () => { file.status = 'failed'; }), pauseJob: vi.fn(), completeJob: vi.fn(),
        };
        const writer = { close: vi.fn(), abort: vi.fn() };
        const sink: any = { open: vi.fn(async () => writer), remove: vi.fn() };
        const transformer: any = { shouldTransform: () => true, transform: vi.fn(async () => ({ path: 'track.opus', bytes: 2 })) };
        await new DownloadCoordinator(repository, {} as any, sink, 1, transformer).run('job');
        expect(transformer.transform).toHaveBeenCalled();
        expect(sink.remove).not.toHaveBeenCalled();
        expect(repository.markFileFailed).toHaveBeenCalledWith('file', 'database crash');
    });

    it('reports live Opus conversion progress after the source download completes', async () => {
        const file: any = {
            id: 'file', jobId: 'job', path: 'track.wav', url: 'url', status: 'pending', sourceComplete: true, totalBytes: 4,
        };
        const repository: any = {
            activateJob: vi.fn(), listFiles: vi.fn(async () => [file]), markFileActive: vi.fn(), getCheckpoint: vi.fn(),
            markSourceComplete: vi.fn(), markFileComplete: vi.fn(async () => { file.status = 'completed'; }),
            markFileFailed: vi.fn(), pauseJob: vi.fn(), completeJob: vi.fn(),
        };
        const writer = { close: vi.fn(), abort: vi.fn() };
        const sink: any = { open: vi.fn(async () => writer), remove: vi.fn() };
        const transformer: any = {
            shouldTransform: () => true,
            transform: vi.fn(async (_file, _sink, _signal, onProgress) => {
                onProgress(0.5);
                return { path: 'track.opus', bytes: 2 };
            }),
        };
        const progress = vi.fn();

        await new DownloadCoordinator(repository, {} as any, sink, 1, transformer).run('job', progress);

        expect(progress).toHaveBeenCalledWith(expect.objectContaining({
            fileId: 'file', status: 'converting', conversionRatio: 0.5,
        }));
    });

    it('durably closes and checkpoints before reopening at the 64 MiB boundary', async () => {
        const boundary = 64 * 1024 * 1024;
        const file: any = { id: 'file', jobId: 'job', path: 'track.wav', url: 'url', status: 'pending' };
        const repository: any = {
            activateJob: vi.fn(), listFiles: vi.fn(async () => [file]), markFileActive: vi.fn(), getCheckpoint: vi.fn(),
            checkpointFile: vi.fn(), markSourceComplete: vi.fn(), markFileComplete: vi.fn(async () => { file.status = 'completed'; }),
            markFileFailed: vi.fn(), resetFile: vi.fn(), completeJob: vi.fn(), pauseJob: vi.fn(),
        };
        const first = { write: vi.fn(), close: vi.fn(), abort: vi.fn() };
        const second = { write: vi.fn(), close: vi.fn(), abort: vi.fn() };
        const sink: any = { open: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second) };
        const transport: any = { stream: vi.fn(async (_url: string, _offset: number, onChunk: any) => {
            const block = new Uint8Array(1024 * 1024);
            for (let offset = 0; offset < boundary; offset += block.byteLength) {
                await onChunk({ bytes: block, offset, total: boundary + 1, etag: 'stable' });
            }
            await onChunk({ bytes: new Uint8Array([1]), offset: boundary, total: boundary + 1, etag: 'stable' });
            return { size: boundary + 1, etag: 'stable', acceptsRanges: true };
        }) };
        await new DownloadCoordinator(repository, transport, sink, 1).run('job');
        expect(sink.open).toHaveBeenNthCalledWith(2, ['track.wav'], boundary);
        expect(first.close.mock.invocationCallOrder[0]).toBeLessThan(repository.checkpointFile.mock.invocationCallOrder[0]);
        expect(repository.checkpointFile.mock.invocationCallOrder[0]).toBeLessThan(sink.open.mock.invocationCallOrder[1]);
        expect(second.close.mock.invocationCallOrder[0]).toBeLessThan(repository.checkpointFile.mock.invocationCallOrder[1]);
    });

    it('restarts safely when the on-disk partial file is shorter than its checkpoint', async () => {
        const file: any = { id: 'file', jobId: 'job', path: 'track.wav', url: 'url', status: 'pending', downloadedBytes: 128 };
        const repository: any = {
            activateJob: vi.fn(), listFiles: vi.fn(async () => [file]), markFileActive: vi.fn(),
            getCheckpoint: vi.fn(async () => ({ offset: 128, etag: 'old' })),
            resetFile: vi.fn(async () => { file.downloadedBytes = 0; }), checkpointFile: vi.fn(), markSourceComplete: vi.fn(),
            markFileComplete: vi.fn(async () => { file.status = 'completed'; }), markFileFailed: vi.fn(), completeJob: vi.fn(), pauseJob: vi.fn(),
        };
        const writer = { write: vi.fn(), close: vi.fn(), abort: vi.fn() };
        const sink: any = { open: vi.fn().mockRejectedValueOnce(new ResumeOffsetMismatchError(128, 64)).mockResolvedValueOnce(writer) };
        const transport: any = { stream: vi.fn(async (_url: string, offset: number, onChunk: any) => {
            expect(offset).toBe(0);
            await onChunk({ bytes: new Uint8Array([1]), offset: 0, total: 1 });
            return { size: 1, acceptsRanges: true };
        }) };
        await new DownloadCoordinator(repository, transport, sink, 1).run('job');
        expect(repository.resetFile).toHaveBeenCalledWith('file');
        expect(sink.open).toHaveBeenNthCalledWith(2, ['track.wav'], 0);
    });
});
