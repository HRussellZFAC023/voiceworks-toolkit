import {
    DirectoryPermissionError,
    ResumeOffsetMismatchError,
    type DownloadRemoveOptions,
    type DownloadSink,
    type DownloadWriter,
} from './DownloadSink';

// Re-exported so existing importers keep working after the sink contract moved
// into its own module.
export { DirectoryPermissionError, ResumeOffsetMismatchError };
export type { DownloadRemoveOptions, DownloadSink, DownloadWriter };

type PermissionStateLike = 'granted' | 'denied' | 'prompt';
type PermissionHandle = FileSystemDirectoryHandle & {
    queryPermission?: (options?: { mode: 'readwrite' }) => Promise<PermissionStateLike>;
    requestPermission?: (options?: { mode: 'readwrite' }) => Promise<PermissionStateLike>;
};
type EnumerableDirectoryHandle = FileSystemDirectoryHandle & {
    entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
    values?: () => AsyncIterableIterator<FileSystemHandle>;
};

class DirectoryInspectionError extends Error {
    constructor() {
        super('Download directory entries cannot be inspected safely');
        this.name = 'DirectoryInspectionError';
    }
}

/**
 * Directory sink that recreates nested folders and supports seek-on-resume.
 *
 * Backed by any `FileSystemDirectoryHandle`, so it serves both the Chromium
 * folder picker and the origin private file system available in Firefox.
 */
export class DirectoryDownloadSink implements DownloadSink {
    constructor(private readonly root: FileSystemDirectoryHandle) {}

    async ensurePermission(request = false): Promise<boolean> {
        const handle = this.root as PermissionHandle;
        if (!handle.queryPermission) return true;
        if (await handle.queryPermission({ mode: 'readwrite' }) === 'granted') return true;
        if (!request || !handle.requestPermission) return false;
        return await handle.requestPermission({ mode: 'readwrite' }) === 'granted';
    }

    /** Names already occupying the destination root, including files and folders. */
    async listTopLevelEntryNames(): Promise<string[]> {
        if (!await this.ensurePermission(false)) throw new DirectoryPermissionError();
        const root = this.root as EnumerableDirectoryHandle;
        const names: string[] = [];
        if (typeof root.entries === 'function') {
            for await (const [name] of root.entries()) names.push(name);
            return names;
        }
        if (typeof root.values === 'function') {
            for await (const handle of root.values()) names.push(handle.name);
            return names;
        }
        // Creating a writable without first enumerating would let a later job
        // truncate a same-named folder/file selected in an earlier run.
        throw new DirectoryInspectionError();
    }

    async open(path: readonly string[], offset: number): Promise<DownloadWriter> {
        if (!await this.ensurePermission(false)) throw new DirectoryPermissionError();
        if (!path.length) throw new Error('A destination filename is required');
        let directory = this.root;
        for (const segment of path.slice(0, -1)) {
            directory = await directory.getDirectoryHandle(segment, { create: true });
        }
        const file = await directory.getFileHandle(path[path.length - 1], { create: true });
        if (offset > 0) {
            const actualSize = (await file.getFile()).size;
            if (actualSize !== offset) throw new ResumeOffsetMismatchError(offset, actualSize);
        }
        const writable = await file.createWritable({ keepExistingData: offset > 0 });
        if (offset > 0) await writable.seek(offset);
        return {
            write: async (bytes, writeOffset) => {
                const copy = new Uint8Array(bytes.byteLength);
                copy.set(bytes);
                await writable.write({ type: 'write', position: writeOffset, data: copy.buffer });
            },
            close: () => writable.close(),
            abort: async (reason) => { await writable.abort(reason); },
        };
    }

    private async resolve(path: readonly string[], createDirectories = false): Promise<{ directory: FileSystemDirectoryHandle; filename: string }> {
        if (!path.length) throw new Error('A destination filename is required');
        let directory = this.root;
        for (const segment of path.slice(0, -1)) {
            directory = await directory.getDirectoryHandle(segment, { create: createDirectories });
        }
        return { directory, filename: path[path.length - 1] };
    }

    async read(path: readonly string[]): Promise<Uint8Array> {
        const { directory, filename } = await this.resolve(path);
        const file = await (await directory.getFileHandle(filename)).getFile();
        return new Uint8Array(await file.arrayBuffer());
    }

    /** Read a bounded range without materializing a large partial file. */
    async readRange(path: readonly string[], offset: number, length: number): Promise<Uint8Array> {
        if (!await this.ensurePermission(false)) throw new DirectoryPermissionError();
        if (
            !Number.isSafeInteger(offset)
            || offset < 0
            || !Number.isSafeInteger(length)
            || length < 0
        ) throw new RangeError('A valid file range is required');
        const { directory, filename } = await this.resolve(path);
        const file = await (await directory.getFileHandle(filename)).getFile();
        return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
    }

    /** Inspect a source without materializing its contents in browser memory. */
    async size(path: readonly string[]): Promise<number> {
        const { directory, filename } = await this.resolve(path);
        return (await (await directory.getFileHandle(filename)).getFile()).size;
    }

    /** Disk-backed handle so exports can stream instead of buffering. */
    async file(path: readonly string[]): Promise<Blob> {
        const { directory, filename } = await this.resolve(path);
        return (await directory.getFileHandle(filename)).getFile();
    }

    async writeAll(path: readonly string[], bytes: Uint8Array): Promise<void> {
        const writer = await this.open(path, 0);
        try { await writer.write(bytes, 0); await writer.close(); }
        catch (error) { await writer.abort(error); throw error; }
    }

    async remove(path: readonly string[], options: DownloadRemoveOptions = {}): Promise<void> {
        const { directory, filename } = await this.resolve(path);
        if (options.recursive) await directory.removeEntry(filename, { recursive: true });
        else await directory.removeEntry(filename);
    }
}

export async function chooseDownloadDirectory(): Promise<FileSystemDirectoryHandle> {
    const picker = (window as typeof window & {
        showDirectoryPicker?: (options?: { mode: 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
    }).showDirectoryPicker;
    if (!picker) throw new Error('Folder downloads are not supported by this browser');
    return picker({ mode: 'readwrite' });
}
