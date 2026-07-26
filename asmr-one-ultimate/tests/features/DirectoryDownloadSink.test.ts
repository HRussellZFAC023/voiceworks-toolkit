import { describe, expect, it, vi } from 'vitest';
import { DirectoryDownloadSink, DirectoryPermissionError, ResumeOffsetMismatchError } from '../../src/features/downloads/DirectoryDownloadSink';

describe('DirectoryDownloadSink', () => {
    it('recreates folders and seeks before a resumed write', async () => {
        const writable = { seek: vi.fn(), write: vi.fn(), close: vi.fn(), abort: vi.fn() };
        const child = { getFileHandle: vi.fn().mockResolvedValue({ getFile: vi.fn().mockResolvedValue({ size: 128 }), createWritable: vi.fn().mockResolvedValue(writable) }) };
        const root = {
            queryPermission: vi.fn().mockResolvedValue('granted'),
            getDirectoryHandle: vi.fn().mockResolvedValue(child),
        };
        const writer = await new DirectoryDownloadSink(root as any).open(['Work', 'track.opus'], 128);
        await writer.write(new Uint8Array([1, 2]), 128);
        await writer.close();

        expect(root.getDirectoryHandle).toHaveBeenCalledWith('Work', { create: true });
        expect(writable.seek).toHaveBeenCalledWith(128);
        expect(writable.write).toHaveBeenCalledWith(expect.objectContaining({ position: 128 }));
    });

    it('requires permission to be re-granted after refresh', async () => {
        const root = { queryPermission: vi.fn().mockResolvedValue('prompt') };
        await expect(new DirectoryDownloadSink(root as any).open(['track.wav'], 0))
            .rejects.toBeInstanceOf(DirectoryPermissionError);
    });

    it('refuses to seek beyond the bytes actually committed on disk', async () => {
        const handle = { getFile: vi.fn().mockResolvedValue({ size: 64 }), createWritable: vi.fn() };
        const root = { getFileHandle: vi.fn().mockResolvedValue(handle) };
        await expect(new DirectoryDownloadSink(root as any).open(['track.wav'], 128))
            .rejects.toBeInstanceOf(ResumeOffsetMismatchError);
        expect(handle.createWritable).not.toHaveBeenCalled();
    });

    it('reads only the requested fingerprint range from a committed file', async () => {
        const slice = vi.fn().mockReturnValue({
            arrayBuffer: vi.fn().mockResolvedValue(new Uint8Array([3, 4]).buffer),
        });
        const handle = {
            getFile: vi.fn().mockResolvedValue({ slice }),
        };
        const root = {
            queryPermission: vi.fn().mockResolvedValue('granted'),
            getFileHandle: vi.fn().mockResolvedValue(handle),
        };

        const bytes = await new DirectoryDownloadSink(root as any).readRange(['track.flac'], 2, 2);

        expect(slice).toHaveBeenCalledWith(2, 4);
        expect([...bytes]).toEqual([3, 4]);
    });
});
