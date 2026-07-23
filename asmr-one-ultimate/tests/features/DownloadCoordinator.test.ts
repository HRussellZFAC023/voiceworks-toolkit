import { describe, expect, it, vi } from 'vitest';
import {
    DOWNLOAD_DURABLE_CHECKPOINT_INTERVAL,
    DownloadAlreadyRunningError,
    DownloadCoordinator,
} from '../../src/features/downloads/DownloadCoordinator';
import { DirectoryPermissionError, ResumeOffsetMismatchError } from '../../src/features/downloads/DirectoryDownloadSink';
import {
    DownloadRequestTimeoutError,
    DownloadStallError,
    RangeRestartRequiredError,
} from '../../src/features/downloads/DownloadTransport';

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

    it('finalizes a fully durable checkpoint left before sourceComplete without requesting bytes past EOF', async () => {
        const file: any = {
            id: 'file-1', jobId: 'job-1', path: 'Work/track.wav', url: 'https://media/track',
            status: 'pending', sourceComplete: false, downloadedBytes: 5, totalBytes: 5,
            createdAt: 1, updatedAt: 1,
        };
        const checkpoint = {
            fileId: file.id,
            jobId: file.jobId,
            offset: 5,
            lastModified: 'Thu, 23 Jul 2026 18:21:43 GMT',
        };
        const repository: any = {
            activateJob: vi.fn(),
            listFiles: vi.fn(async () => [file]),
            markFileActive: vi.fn(async () => { file.status = 'active'; }),
            getCheckpoint: vi.fn(async () => checkpoint),
            checkpointFile: vi.fn(async (_id: string, value: any) => value),
            markSourceComplete: vi.fn(async () => { file.sourceComplete = true; }),
            markFileComplete: vi.fn(async (_id: string, total: number) => {
                file.status = 'completed';
                file.downloadedBytes = total;
            }),
            completeJob: vi.fn(),
            pauseJob: vi.fn(),
            markFileFailed: vi.fn(),
            resetFile: vi.fn(),
        };
        const writer = { write: vi.fn(), close: vi.fn(), abort: vi.fn() };
        const sink: any = { open: vi.fn(async () => writer) };
        const transport: any = {
            stream: vi.fn(async (_url: string, offset: number, _onChunk: any, options: any) => {
                expect(offset).toBe(5);
                expect(options).toMatchObject({
                    expectedLastModified: checkpoint.lastModified,
                    expectedTotal: 5,
                });
                return {
                    size: 5,
                    lastModified: checkpoint.lastModified,
                    acceptsRanges: true,
                    confirmedCompleteAtOffset: true,
                };
            }),
        };

        await new DownloadCoordinator(repository, transport, sink, 1).run('job-1');

        expect(writer.write).not.toHaveBeenCalled();
        expect(writer.close).toHaveBeenCalledTimes(1);
        expect(repository.resetFile).not.toHaveBeenCalled();
        expect(repository.checkpointFile).toHaveBeenCalledWith('file-1', expect.objectContaining({
            offset: 5,
            totalBytes: 5,
            lastModified: checkpoint.lastModified,
        }));
        expect(repository.markSourceComplete).toHaveBeenCalledWith('file-1', 5);
        expect(repository.markFileComplete).toHaveBeenCalledWith('file-1', 5);
        expect(repository.completeJob).toHaveBeenCalledWith('job-1');
    });

    it('completes a server-proven empty file without weakening unknown-size zero-body checks', async () => {
        const file: any = {
            id: 'empty', jobId: 'job', path: 'Work/empty.txt', url: 'https://media/empty',
            status: 'pending', downloadedBytes: 0, totalBytes: 0,
        };
        const repository: any = {
            activateJob: vi.fn(),
            listFiles: vi.fn(async () => [file]),
            markFileActive: vi.fn(),
            getCheckpoint: vi.fn(),
            checkpointFile: vi.fn(),
            markSourceComplete: vi.fn(),
            markFileComplete: vi.fn(async (_id: string, total: number) => {
                file.status = 'completed';
                file.downloadedBytes = total;
            }),
            completeJob: vi.fn(),
            pauseJob: vi.fn(),
            markFileFailed: vi.fn(),
            resetFile: vi.fn(),
        };
        const writer = { write: vi.fn(), close: vi.fn(), abort: vi.fn() };
        const sink: any = { open: vi.fn(async () => writer) };
        const transport: any = {
            stream: vi.fn(async () => ({
                size: 0,
                acceptsRanges: false,
                confirmedEmpty: true,
            })),
        };

        await new DownloadCoordinator(repository, transport, sink, 1).run('job');

        expect(writer.write).not.toHaveBeenCalled();
        expect(repository.markSourceComplete).toHaveBeenCalledWith('empty', 0);
        expect(repository.markFileComplete).toHaveBeenCalledWith('empty', 0);
        expect(repository.completeJob).toHaveBeenCalledWith('job');
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

    it('uses coarse durable checkpoints and closes before persisting their offsets', async () => {
        const boundary = DOWNLOAD_DURABLE_CHECKPOINT_INTERVAL;
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
            const block = new Uint8Array(4 * 1024 * 1024);
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

    it('persists and uses a full-quality fallback when the preferred source is rejected', async () => {
        const file: any = {
            id: 'file',
            jobId: 'job',
            path: 'Work/track.wav',
            url: 'https://media.test/download.wav',
            sourceUrls: ['https://media.test/stream.wav'],
            status: 'pending',
            downloadedBytes: 0,
        };
        const repository: any = {
            activateJob: vi.fn(),
            listFiles: vi.fn(async () => [file]),
            markFileActive: vi.fn(),
            getCheckpoint: vi.fn(),
            checkpointFile: vi.fn(),
            resetFile: vi.fn(),
            selectFileSource: vi.fn(async (_id: string, url: string, sourceUrls: string[]) => {
                file.url = url;
                file.sourceUrls = sourceUrls;
            }),
            markSourceComplete: vi.fn(),
            markFileComplete: vi.fn(async (_id: string, total: number) => {
                file.status = 'completed';
                file.downloadedBytes = total;
            }),
            markFileFailed: vi.fn(),
            completeJob: vi.fn(),
            pauseJob: vi.fn(),
        };
        const firstWriter = { write: vi.fn(), close: vi.fn(), abort: vi.fn() };
        const fallbackWriter = { write: vi.fn(), close: vi.fn(), abort: vi.fn() };
        const sink: any = {
            open: vi.fn()
                .mockResolvedValueOnce(firstWriter)
                .mockResolvedValueOnce(fallbackWriter),
        };
        const transport: any = {
            stream: vi.fn()
                .mockRejectedValueOnce(new Error('HTTP 403: Error'))
                .mockImplementationOnce(async (_url: string, offset: number, onChunk: any) => {
                    expect(offset).toBe(0);
                    await onChunk({ bytes: new Uint8Array([1, 2]), offset: 0, total: 2 });
                    return { size: 2, acceptsRanges: true };
                }),
        };

        await new DownloadCoordinator(repository, transport, sink, 1).run('job');

        expect(transport.stream.mock.calls.map((call: unknown[]) => call[0])).toEqual([
            'https://media.test/download.wav',
            'https://media.test/stream.wav',
        ]);
        expect(firstWriter.abort).toHaveBeenCalledTimes(1);
        expect(repository.selectFileSource).toHaveBeenCalledWith(
            'file',
            'https://media.test/stream.wav',
            ['https://media.test/download.wav'],
        );
        expect(fallbackWriter.write).toHaveBeenCalled();
        expect(repository.markFileComplete).toHaveBeenCalledWith('file', 2);
    });

    it('does not mark a truncated body complete when only the manifest declares its size', async () => {
        const file: any = {
            id: 'file', jobId: 'job', path: 'Work/track.wav', url: 'https://media/track',
            status: 'pending', downloadedBytes: 0, totalBytes: 4,
        };
        const repository: any = {
            activateJob: vi.fn(), listFiles: vi.fn(async () => [file]), markFileActive: vi.fn(),
            getCheckpoint: vi.fn(), checkpointFile: vi.fn(), markSourceComplete: vi.fn(),
            markFileComplete: vi.fn(), resetFile: vi.fn(), completeJob: vi.fn(), pauseJob: vi.fn(),
            markFileFailed: vi.fn(async (_id: string, error: string) => { file.status = 'failed'; file.error = error; }),
        };
        const writers = Array.from({ length: 3 }, () => ({
            write: vi.fn(), close: vi.fn(), abort: vi.fn(),
        }));
        const sink: any = {
            open: vi.fn()
                .mockResolvedValueOnce(writers[0])
                .mockResolvedValueOnce(writers[1])
                .mockResolvedValueOnce(writers[2]),
        };
        const transport: any = {
            stream: vi.fn(async (_url: string, offset: number, onChunk: any) => {
                await onChunk({ bytes: new Uint8Array([offset + 1]), offset });
                return { size: undefined, acceptsRanges: false };
            }),
        };

        await new DownloadCoordinator(
            repository, transport, sink, 1, undefined, undefined,
            { sleep: async () => undefined },
        ).run('job');

        expect(transport.stream.mock.calls.map((call: any[]) => call[1])).toEqual([0, 1, 2]);
        expect(repository.checkpointFile.mock.calls.map((call: any[]) => call[1].offset)).toEqual([1, 2, 3]);
        expect(repository.markSourceComplete).not.toHaveBeenCalled();
        expect(repository.markFileComplete).not.toHaveBeenCalled();
        expect(repository.markFileFailed).toHaveBeenCalledWith(
            'file',
            'Download ended before all bytes arrived after 3 attempts',
        );
    });

    it('rotates every full-quality source so a failed fallback can resume with the original', async () => {
        const file: any = {
            id: 'file',
            jobId: 'job',
            path: 'Work/track.wav',
            url: 'https://media.test/primary.wav',
            sourceUrls: ['https://media.test/fallback.wav'],
            status: 'pending',
            downloadedBytes: 0,
        };
        const repository: any = {
            activateJob: vi.fn(), listFiles: vi.fn(async () => [file]), markFileActive: vi.fn(),
            getCheckpoint: vi.fn(), checkpointFile: vi.fn(), resetFile: vi.fn(),
            selectFileSource: vi.fn(async (_id: string, url: string, sourceUrls: string[]) => {
                file.url = url;
                file.sourceUrls = sourceUrls;
            }),
            markSourceComplete: vi.fn(), markFileComplete: vi.fn(), completeJob: vi.fn(), pauseJob: vi.fn(),
            markFileFailed: vi.fn(async (_id: string, error: string) => { file.status = 'failed'; file.error = error; }),
        };
        const writers = Array.from({ length: 2 }, () => ({
            write: vi.fn(), close: vi.fn(), abort: vi.fn(),
        }));
        const sink: any = {
            open: vi.fn()
                .mockResolvedValueOnce(writers[0])
                .mockResolvedValueOnce(writers[1]),
        };
        const transport: any = {
            stream: vi.fn()
                .mockRejectedValueOnce(new TypeError('primary unavailable'))
                .mockRejectedValueOnce(new TypeError('fallback unavailable')),
        };

        await new DownloadCoordinator(repository, transport, sink, 1).run('job');

        expect(repository.selectFileSource).toHaveBeenCalledWith(
            'file',
            'https://media.test/fallback.wav',
            ['https://media.test/primary.wav'],
        );
        expect(file).toMatchObject({
            url: 'https://media.test/fallback.wav',
            sourceUrls: ['https://media.test/primary.wav'],
            status: 'failed',
        });
    });

    it('uses a full-quality alternate after a zero-byte primary stalls repeatedly', async () => {
        const file: any = {
            id: 'file',
            jobId: 'job',
            path: 'Work/track.wav',
            url: 'https://media.test/primary.wav',
            sourceUrls: ['https://media.test/fallback.wav'],
            status: 'pending',
            downloadedBytes: 0,
        };
        const repository: any = {
            activateJob: vi.fn(), listFiles: vi.fn(async () => [file]), markFileActive: vi.fn(),
            getCheckpoint: vi.fn(), checkpointFile: vi.fn(), resetFile: vi.fn(),
            selectFileSource: vi.fn(async (_id: string, url: string, sourceUrls: string[]) => {
                file.url = url;
                file.sourceUrls = sourceUrls;
            }),
            markSourceComplete: vi.fn(),
            markFileComplete: vi.fn(async (_id: string, total: number) => {
                file.status = 'completed';
                file.downloadedBytes = total;
            }),
            markFileFailed: vi.fn(), completeJob: vi.fn(), pauseJob: vi.fn(),
        };
        const writers = Array.from({ length: 4 }, () => ({
            write: vi.fn(), close: vi.fn(), abort: vi.fn(),
        }));
        const sink: any = { open: vi.fn() };
        writers.forEach(writer => sink.open.mockResolvedValueOnce(writer));
        const transport: any = {
            stream: vi.fn(async (url: string, _offset: number, onChunk: any) => {
                if (url.includes('primary')) throw new DownloadStallError();
                await onChunk({ bytes: new Uint8Array([1, 2]), offset: 0, total: 2 });
                return { size: 2, acceptsRanges: true };
            }),
        };

        await new DownloadCoordinator(
            repository, transport, sink, 1, undefined, undefined,
            { sleep: async () => undefined },
        ).run('job');

        expect(transport.stream.mock.calls.map((call: any[]) => call[0])).toEqual([
            'https://media.test/primary.wav',
            'https://media.test/primary.wav',
            'https://media.test/primary.wav',
            'https://media.test/fallback.wav',
        ]);
        expect(repository.selectFileSource).toHaveBeenCalledWith(
            'file',
            'https://media.test/fallback.wav',
            ['https://media.test/primary.wav'],
        );
        expect(repository.markFileComplete).toHaveBeenCalledWith('file', 2);
    });

    it('uses a full-quality alternate after the primary request times out', async () => {
        const file: any = {
            id: 'file',
            jobId: 'job',
            path: 'Work/track.wav',
            url: 'https://media.test/primary.wav',
            sourceUrls: ['https://media.test/fallback.wav'],
            status: 'pending',
            downloadedBytes: 0,
        };
        const repository: any = {
            activateJob: vi.fn(), listFiles: vi.fn(async () => [file]), markFileActive: vi.fn(),
            getCheckpoint: vi.fn(), checkpointFile: vi.fn(), resetFile: vi.fn(),
            selectFileSource: vi.fn(async (_id: string, url: string, sourceUrls: string[]) => {
                file.url = url;
                file.sourceUrls = sourceUrls;
            }),
            markSourceComplete: vi.fn(),
            markFileComplete: vi.fn(async (_id: string, total: number) => {
                file.status = 'completed';
                file.downloadedBytes = total;
            }),
            markFileFailed: vi.fn(), completeJob: vi.fn(), pauseJob: vi.fn(),
        };
        const writers = Array.from({ length: 2 }, () => ({
            write: vi.fn(), close: vi.fn(), abort: vi.fn(),
        }));
        const sink: any = { open: vi.fn() };
        writers.forEach(writer => sink.open.mockResolvedValueOnce(writer));
        const transport: any = {
            stream: vi.fn(async (url: string, _offset: number, onChunk: any) => {
                if (url.includes('primary')) throw new DownloadRequestTimeoutError();
                await onChunk({ bytes: new Uint8Array([1, 2]), offset: 0, total: 2 });
                return { size: 2, acceptsRanges: true };
            }),
        };

        await new DownloadCoordinator(repository, transport, sink, 1).run('job');

        expect(transport.stream.mock.calls.map((call: any[]) => call[0])).toEqual([
            'https://media.test/primary.wav',
            'https://media.test/fallback.wav',
        ]);
        expect(repository.selectFileSource).toHaveBeenCalledWith(
            'file',
            'https://media.test/fallback.wav',
            ['https://media.test/primary.wav'],
        );
        expect(repository.markFileComplete).toHaveBeenCalledWith('file', 2);
    });

    it('uses a full-quality alternate after an unknown-size zero-byte primary ends incomplete', async () => {
        const file: any = {
            id: 'file',
            jobId: 'job',
            path: 'Work/track.wav',
            url: 'https://media.test/primary.wav',
            sourceUrls: ['https://media.test/fallback.wav'],
            status: 'pending',
            downloadedBytes: 0,
        };
        const repository: any = {
            activateJob: vi.fn(), listFiles: vi.fn(async () => [file]), markFileActive: vi.fn(),
            getCheckpoint: vi.fn(), checkpointFile: vi.fn(), resetFile: vi.fn(),
            selectFileSource: vi.fn(async (_id: string, url: string, sourceUrls: string[]) => {
                file.url = url;
                file.sourceUrls = sourceUrls;
            }),
            markSourceComplete: vi.fn(),
            markFileComplete: vi.fn(async (_id: string, total: number) => {
                file.status = 'completed';
                file.downloadedBytes = total;
            }),
            markFileFailed: vi.fn(), completeJob: vi.fn(), pauseJob: vi.fn(),
        };
        const writers = Array.from({ length: 4 }, () => ({
            write: vi.fn(), close: vi.fn(), abort: vi.fn(),
        }));
        const sink: any = { open: vi.fn() };
        writers.forEach(writer => sink.open.mockResolvedValueOnce(writer));
        const transport: any = {
            stream: vi.fn(async (url: string, _offset: number, onChunk: any) => {
                if (url.includes('primary')) return { size: undefined, acceptsRanges: false };
                await onChunk({ bytes: new Uint8Array([1, 2]), offset: 0, total: 2 });
                return { size: 2, acceptsRanges: true };
            }),
        };

        await new DownloadCoordinator(
            repository, transport, sink, 1, undefined, undefined,
            { sleep: async () => undefined },
        ).run('job');

        expect(transport.stream.mock.calls.map((call: any[]) => call[0])).toEqual([
            'https://media.test/primary.wav',
            'https://media.test/primary.wav',
            'https://media.test/primary.wav',
            'https://media.test/fallback.wav',
        ]);
        expect(repository.markFileComplete).toHaveBeenCalledWith('file', 2);
    });

    it('commits a partial response before retrying from the exact durable range', async () => {
        const file: any = {
            id: 'file', jobId: 'job', path: 'Work/track.wav', url: 'https://media/track',
            status: 'pending', downloadedBytes: 0,
        };
        const repository: any = {
            activateJob: vi.fn(), listFiles: vi.fn(async () => [file]), markFileActive: vi.fn(),
            getCheckpoint: vi.fn(), checkpointFile: vi.fn(), markSourceComplete: vi.fn(),
            markFileComplete: vi.fn(async (_id: string, total: number) => {
                file.status = 'completed';
                file.downloadedBytes = total;
            }),
            markFileFailed: vi.fn(), resetFile: vi.fn(), completeJob: vi.fn(), pauseJob: vi.fn(),
        };
        const first = { write: vi.fn(), close: vi.fn(), abort: vi.fn() };
        const second = { write: vi.fn(), close: vi.fn(), abort: vi.fn() };
        const sink: any = { open: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second) };
        const transport: any = {
            stream: vi.fn()
                .mockImplementationOnce(async (_url: string, offset: number, onChunk: any) => {
                    expect(offset).toBe(0);
                    await onChunk({ bytes: new Uint8Array([1, 2]), offset: 0, total: 4, etag: 'stable' });
                    throw new TypeError('Network reset at https://secret.example/file?token=private');
                })
                .mockImplementationOnce(async (_url: string, offset: number, onChunk: any, options: any) => {
                    expect(offset).toBe(2);
                    expect(options).toMatchObject({ expectedEtag: 'stable' });
                    await onChunk({ bytes: new Uint8Array([3, 4]), offset: 2, total: 4, etag: 'stable' });
                    return { size: 4, etag: 'stable', acceptsRanges: true };
                }),
        };
        const sleep = vi.fn(async () => undefined);

        await new DownloadCoordinator(
            repository, transport, sink, 1, undefined, undefined,
            { baseDelayMs: 25, maxDelayMs: 25, sleep },
        ).run('job');

        expect(transport.stream).toHaveBeenCalledTimes(2);
        expect(first.close.mock.invocationCallOrder[0]).toBeLessThan(repository.checkpointFile.mock.invocationCallOrder[0]);
        expect(repository.checkpointFile).toHaveBeenNthCalledWith(1, 'file', expect.objectContaining({
            offset: 2, etag: 'stable',
        }));
        expect(repository.checkpointFile.mock.invocationCallOrder[0]).toBeLessThan(sink.open.mock.invocationCallOrder[1]);
        expect(sink.open).toHaveBeenNthCalledWith(2, ['Work', 'track.wav'], 2);
        expect(sleep).toHaveBeenCalledWith(25);
        expect(first.abort).not.toHaveBeenCalled();
        expect(repository.markFileComplete).toHaveBeenCalledWith('file', 4);
    });

    it('bounds body retries, checkpoints the final partial bytes, and stores a sanitized reason', async () => {
        const file: any = {
            id: 'file', jobId: 'job', path: 'track.wav', url: 'https://media/track',
            status: 'pending', downloadedBytes: 0,
        };
        const repository: any = {
            activateJob: vi.fn(), listFiles: vi.fn(async () => [file]), markFileActive: vi.fn(),
            getCheckpoint: vi.fn(), checkpointFile: vi.fn(), markSourceComplete: vi.fn(),
            markFileComplete: vi.fn(), resetFile: vi.fn(), completeJob: vi.fn(), pauseJob: vi.fn(),
            markFileFailed: vi.fn(async (_id: string, error: string) => { file.status = 'failed'; file.error = error; }),
        };
        const writers = Array.from({ length: 3 }, () => ({
            write: vi.fn(), close: vi.fn(), abort: vi.fn(),
        }));
        const sink: any = {
            open: vi.fn()
                .mockResolvedValueOnce(writers[0])
                .mockResolvedValueOnce(writers[1])
                .mockResolvedValueOnce(writers[2]),
        };
        const failures = [
            new TypeError('network failed at https://secret.example/file?signature=private'),
            new DownloadStallError(),
            new Error('Incomplete download: received 3 of 4 bytes'),
        ];
        const transport: any = { stream: vi.fn(async (_url: string, offset: number, onChunk: any) => {
            await onChunk({ bytes: new Uint8Array([offset + 1]), offset, total: 4, etag: 'stable' });
            throw failures[offset];
        }) };
        const sleep = vi.fn(async () => undefined);
        const progress = vi.fn();

        await new DownloadCoordinator(
            repository, transport, sink, 1, undefined, undefined,
            { baseDelayMs: 10, maxDelayMs: 100, sleep },
        ).run('job', progress);

        expect(transport.stream.mock.calls.map((call: any[]) => call[1])).toEqual([0, 1, 2]);
        expect(repository.checkpointFile.mock.calls.map((call: any[]) => call[1].offset)).toEqual([1, 2, 3]);
        expect(sink.open.mock.calls.map((call: any[]) => call[1])).toEqual([0, 1, 2]);
        expect(sleep.mock.calls.map((call: any[]) => call[0])).toEqual([10, 20]);
        expect(repository.markFileFailed).toHaveBeenCalledWith(
            'file',
            'Download ended before all bytes arrived after 3 attempts',
        );
        expect(file.error).not.toContain('secret.example');
        expect(file.error).not.toContain('private');
        expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({
            fileId: 'file', completedBytes: 3, status: 'failed',
        }));
    });

    it('never retries or checkpoints a destination write failure', async () => {
        const file: any = { id: 'file', jobId: 'job', path: 'track.wav', url: 'url', status: 'pending' };
        const repository: any = {
            activateJob: vi.fn(), listFiles: vi.fn(async () => [file]), markFileActive: vi.fn(),
            getCheckpoint: vi.fn(), checkpointFile: vi.fn(), markSourceComplete: vi.fn(),
            markFileComplete: vi.fn(), resetFile: vi.fn(), completeJob: vi.fn(), pauseJob: vi.fn(),
            markFileFailed: vi.fn(async (_id: string, error: string) => { file.status = 'failed'; file.error = error; }),
        };
        const writer = {
            write: vi.fn().mockRejectedValue(new DOMException('disk full', 'QuotaExceededError')),
            close: vi.fn(),
            abort: vi.fn(),
        };
        const sink: any = { open: vi.fn(async () => writer) };
        const transport: any = { stream: vi.fn(async (_url: string, _offset: number, onChunk: any) => {
            await onChunk({ bytes: new Uint8Array([1]), offset: 0, total: 1 });
            return { size: 1, acceptsRanges: true };
        }) };
        const sleep = vi.fn(async () => undefined);

        await new DownloadCoordinator(
            repository, transport, sink, 1, undefined, undefined, { sleep },
        ).run('job');

        expect(transport.stream).toHaveBeenCalledTimes(1);
        expect(sink.open).toHaveBeenCalledTimes(1);
        expect(repository.checkpointFile).not.toHaveBeenCalled();
        expect(sleep).not.toHaveBeenCalled();
        expect(writer.abort).toHaveBeenCalledTimes(1);
        expect(repository.markFileFailed).toHaveBeenCalledWith('file', 'Not enough storage space');
    });

    it('does not add coordinator retries to a request-establishment failure', async () => {
        const file: any = { id: 'file', jobId: 'job', path: 'track.wav', url: 'url', status: 'pending' };
        const repository: any = {
            activateJob: vi.fn(), listFiles: vi.fn(async () => [file]), markFileActive: vi.fn(),
            getCheckpoint: vi.fn(), checkpointFile: vi.fn(), markSourceComplete: vi.fn(),
            markFileComplete: vi.fn(), resetFile: vi.fn(), completeJob: vi.fn(), pauseJob: vi.fn(),
            markFileFailed: vi.fn(async (_id: string, error: string) => { file.status = 'failed'; file.error = error; }),
        };
        const writer = { write: vi.fn(), close: vi.fn(), abort: vi.fn() };
        const sink: any = { open: vi.fn(async () => writer) };
        const transport: any = { stream: vi.fn().mockRejectedValue(new TypeError('Failed to fetch secret URL')) };
        const sleep = vi.fn(async () => undefined);

        await new DownloadCoordinator(
            repository, transport, sink, 1, undefined, undefined, { sleep },
        ).run('job');

        expect(transport.stream).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
        expect(repository.checkpointFile).not.toHaveBeenCalled();
        expect(repository.markFileFailed).toHaveBeenCalledWith('file', 'Network request failed');
    });

    it('preserves the full-reset path when a server rejects a resume range', async () => {
        const file: any = {
            id: 'file', jobId: 'job', path: 'track.wav', url: 'url',
            status: 'pending', downloadedBytes: 2,
        };
        const repository: any = {
            activateJob: vi.fn(), listFiles: vi.fn(async () => [file]), markFileActive: vi.fn(),
            getCheckpoint: vi.fn(async () => ({ offset: 2, etag: 'old' })),
            checkpointFile: vi.fn(), markSourceComplete: vi.fn(),
            resetFile: vi.fn(async () => { file.downloadedBytes = 0; }),
            markFileComplete: vi.fn(async () => { file.status = 'completed'; }),
            markFileFailed: vi.fn(), completeJob: vi.fn(), pauseJob: vi.fn(),
        };
        const first = { write: vi.fn(), close: vi.fn(), abort: vi.fn() };
        const second = { write: vi.fn(), close: vi.fn(), abort: vi.fn() };
        const sink: any = { open: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second) };
        const transport: any = {
            stream: vi.fn()
                .mockRejectedValueOnce(new RangeRestartRequiredError())
                .mockImplementationOnce(async (_url: string, offset: number, onChunk: any) => {
                    expect(offset).toBe(0);
                    await onChunk({ bytes: new Uint8Array([1]), offset: 0, total: 1, etag: 'new' });
                    return { size: 1, etag: 'new', acceptsRanges: true };
                }),
        };
        const sleep = vi.fn(async () => undefined);

        await new DownloadCoordinator(
            repository, transport, sink, 1, undefined, undefined, { sleep },
        ).run('job');

        expect(first.abort).toHaveBeenCalledTimes(1);
        expect(repository.resetFile).toHaveBeenCalledWith('file');
        expect(sink.open).toHaveBeenNthCalledWith(2, ['track.wav'], 0);
        expect(transport.stream.mock.calls.map((call: any[]) => call[1])).toEqual([2, 0]);
        expect(sleep).not.toHaveBeenCalled();
        expect(repository.markFileComplete).toHaveBeenCalledWith('file', 1);
    });
});
