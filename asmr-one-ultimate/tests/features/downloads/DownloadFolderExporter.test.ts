import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    DOWNLOAD_EXPORT_STAGING_FOLDER,
    DownloadFolderExporter,
} from '../../../src/features/downloads/DownloadFolderExporter';
import type { DownloadSink, DownloadWriter } from '../../../src/features/downloads/DownloadSink';

/** In-memory sink with the same path semantics as the real directory sinks. */
function memorySink(initial: Record<string, Uint8Array> = {}) {
    const files = new Map<string, Uint8Array>(Object.entries(initial));
    const removed: Array<{ path: string; recursive: boolean }> = [];
    const key = (path: readonly string[]): string => path.join('/');
    const sink: DownloadSink = {
        ensurePermission: async () => true,
        listTopLevelEntryNames: async () => [...new Set([...files.keys()].map(path => path.split('/')[0]))],
        open: async (path, offset): Promise<DownloadWriter> => {
            let buffer = offset > 0 ? files.get(key(path)) ?? new Uint8Array(0) : new Uint8Array(0);
            return {
                write: async (bytes, writeOffset) => {
                    const end = writeOffset + bytes.byteLength;
                    if (end > buffer.byteLength) {
                        const grown = new Uint8Array(end);
                        grown.set(buffer);
                        buffer = grown;
                    }
                    buffer.set(bytes, writeOffset);
                },
                close: async () => { files.set(key(path), buffer); },
                abort: async () => { files.delete(key(path)); },
            };
        },
        read: async path => {
            const value = files.get(key(path));
            if (!value) throw new Error(`missing ${key(path)}`);
            return value;
        },
        readRange: async (path, offset, length) => {
            const value = files.get(key(path));
            if (!value) throw new Error(`missing ${key(path)}`);
            return value.slice(offset, offset + length);
        },
        size: async path => {
            const value = files.get(key(path));
            if (!value) throw new Error(`missing ${key(path)}`);
            return value.byteLength;
        },
        writeAll: async (path, bytes) => { files.set(key(path), bytes); },
        remove: async (path, options) => {
            removed.push({ path: key(path), recursive: Boolean(options?.recursive) });
            if (options?.recursive) {
                for (const existing of [...files.keys()]) {
                    if (existing === key(path) || existing.startsWith(`${key(path)}/`)) files.delete(existing);
                }
            } else files.delete(key(path));
        },
    };
    return { sink, files, removed };
}

function archiveNames(archive: Uint8Array): string[] {
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    let end = archive.byteLength - 22;
    while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end -= 1;
    const count = view.getUint16(end + 10, true);
    let cursor = view.getUint32(end + 16, true);
    const names: string[] = [];
    for (let index = 0; index < count; index += 1) {
        const nameLength = view.getUint16(cursor + 28, true);
        const extraLength = view.getUint16(cursor + 30, true);
        const commentLength = view.getUint16(cursor + 32, true);
        names.push(new TextDecoder().decode(archive.subarray(cursor + 46, cursor + 46 + nameLength)));
        cursor += 46 + nameLength + extraLength + commentLength;
    }
    return names;
}

const staged = () => ({
    'Work A/track.wav': new Uint8Array([1, 2, 3, 4, 5]),
    'Work A/sub/notes.txt': new Uint8Array([9, 9]),
    'Work B/other.wav': new Uint8Array([7]),
});

describe('DownloadFolderExporter', () => {
    beforeEach(() => {
        vi.stubGlobal('URL', {
            createObjectURL: vi.fn(() => 'blob:staged'),
            revokeObjectURL: vi.fn(),
        });
    });

    it('archives one work folder with its nested paths and removes the staged copy', async () => {
        const { sink, files, removed } = memorySink(staged());
        const archives: Uint8Array[] = [];
        const download = vi.fn(async () => {
            archives.push(files.get(`${DOWNLOAD_EXPORT_STAGING_FOLDER}/Work A.zip`)!);
            return true;
        });
        const exporter = new DownloadFolderExporter(sink, { kind: 'gm', subfolder: 'root' }, { download });

        const result = await exporter.exportFolder('Work A', ['Work A/track.wav', 'Work A/sub/notes.txt']);

        expect(result).toEqual({ exported: true, stagedFilesRetained: false });
        expect(download).toHaveBeenCalledWith({ url: 'blob:staged', name: 'Work A.zip', saveAs: false });
        expect(archiveNames(archives[0])).toEqual(['Work A/track.wav', 'Work A/sub/notes.txt']);
        // Only the exported work is cleaned up; other staged works survive.
        expect(files.has('Work A/track.wav')).toBe(false);
        expect(files.has('Work B/other.wav')).toBe(true);
        expect(removed).toContainEqual({ path: 'Work A', recursive: true });
        expect(files.has(`${DOWNLOAD_EXPORT_STAGING_FOLDER}/Work A.zip`)).toBe(false);
    });

    it('falls back to an anchor download and keeps staged bytes when the manager declines', async () => {
        const { sink, files } = memorySink(staged());
        const anchorDownload = vi.fn(() => true);
        const exporter = new DownloadFolderExporter(sink, { kind: 'gm', subfolder: 'root' }, {
            download: vi.fn(async () => false),
            anchorDownload,
        });

        const result = await exporter.exportFolder('Work A', ['Work A/track.wav']);

        expect(result).toEqual({ exported: true, stagedFilesRetained: true });
        expect(anchorDownload).toHaveBeenCalledWith(expect.anything(), 'Work A.zip');
        expect(files.has('Work A/track.wav')).toBe(true);
    });

    it('never asks the userscript manager for a plain browser-storage destination', async () => {
        const { sink } = memorySink(staged());
        const download = vi.fn(async () => true);
        const anchorDownload = vi.fn(() => true);
        const exporter = new DownloadFolderExporter(sink, { kind: 'opfs', root: 'root' }, { download, anchorDownload });

        await exporter.exportFolder('Work A', ['Work A/track.wav']);

        expect(download).not.toHaveBeenCalled();
        expect(anchorDownload).toHaveBeenCalled();
    });

    it('reports a failure without discarding staged bytes when both transports refuse', async () => {
        const { sink, files } = memorySink(staged());
        const exporter = new DownloadFolderExporter(sink, { kind: 'gm', subfolder: 'root' }, {
            download: vi.fn(async () => false),
            anchorDownload: vi.fn(() => false),
        });

        const result = await exporter.exportFolder('Work A', ['Work A/track.wav']);

        expect(result).toEqual({ exported: false, stagedFilesRetained: true });
        expect(files.has('Work A/track.wav')).toBe(true);
        expect(files.has(`${DOWNLOAD_EXPORT_STAGING_FOLDER}/Work A.zip`)).toBe(false);
    });

    it('skips missing staged files rather than aborting the archive', async () => {
        const { sink, files } = memorySink(staged());
        const download = vi.fn(async () => true);
        let captured: Uint8Array | undefined;
        download.mockImplementation(async () => {
            captured = files.get(`${DOWNLOAD_EXPORT_STAGING_FOLDER}/Work A.zip`);
            return true;
        });
        const exporter = new DownloadFolderExporter(sink, { kind: 'gm', subfolder: 'root' }, { download });

        const result = await exporter.exportFolder('Work A', ['Work A/track.wav', 'Work A/deleted.wav']);

        expect(result.exported).toBe(true);
        expect(archiveNames(captured!)).toEqual(['Work A/track.wav']);
    });

    it('reports a failure when every staged file is missing', async () => {
        const { sink } = memorySink({});
        const download = vi.fn(async () => true);
        const exporter = new DownloadFolderExporter(sink, { kind: 'gm', subfolder: 'root' }, { download });

        const result = await exporter.exportFolder('Work A', ['Work A/track.wav']);

        expect(result).toEqual({ exported: false, stagedFilesRetained: true });
        expect(download).not.toHaveBeenCalled();
    });
});
