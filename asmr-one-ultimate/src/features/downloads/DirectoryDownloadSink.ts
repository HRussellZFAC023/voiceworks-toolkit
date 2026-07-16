export interface DownloadWriter {
    write(bytes: Uint8Array, offset: number): Promise<void>;
    close(): Promise<void>;
    abort(reason?: unknown): Promise<void>;
}

type PermissionStateLike = 'granted' | 'denied' | 'prompt';
type PermissionHandle = FileSystemDirectoryHandle & {
    queryPermission?: (options?: { mode: 'readwrite' }) => Promise<PermissionStateLike>;
    requestPermission?: (options?: { mode: 'readwrite' }) => Promise<PermissionStateLike>;
};
type EnumerableDirectoryHandle = FileSystemDirectoryHandle & {
    entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
    values?: () => AsyncIterableIterator<FileSystemHandle>;
};

export class DirectoryPermissionError extends Error {
    constructor() {
        super('Download directory permission is required to resume');
        this.name = 'DirectoryPermissionError';
    }
}

export class ResumeOffsetMismatchError extends Error {
    constructor(public readonly expectedOffset: number, public readonly actualSize: number) {
        super(`Partial file size ${actualSize} does not match checkpoint ${expectedOffset}`);
        this.name = 'ResumeOffsetMismatchError';
    }
}

class DirectoryInspectionError extends Error {
    constructor() {
        super('Download directory entries cannot be inspected safely');
        this.name = 'DirectoryInspectionError';
    }
}

/** Chromium directory sink that recreates nested folders and supports seek-on-resume. */
export class DirectoryDownloadSink {
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

    async open(path: string[], offset: number): Promise<DownloadWriter> {
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

    private async resolve(path: string[], createDirectories = false): Promise<{ directory: FileSystemDirectoryHandle; filename: string }> {
        if (!path.length) throw new Error('A destination filename is required');
        let directory = this.root;
        for (const segment of path.slice(0, -1)) {
            directory = await directory.getDirectoryHandle(segment, { create: createDirectories });
        }
        return { directory, filename: path[path.length - 1] };
    }

    async read(path: string[]): Promise<Uint8Array> {
        const { directory, filename } = await this.resolve(path);
        const file = await (await directory.getFileHandle(filename)).getFile();
        return new Uint8Array(await file.arrayBuffer());
    }

    async writeAll(path: string[], bytes: Uint8Array): Promise<void> {
        const writer = await this.open(path, 0);
        try { await writer.write(bytes, 0); await writer.close(); }
        catch (error) { await writer.abort(error); throw error; }
    }

    async remove(path: string[]): Promise<void> {
        const { directory, filename } = await this.resolve(path);
        await directory.removeEntry(filename);
    }
}

export async function chooseDownloadDirectory(): Promise<FileSystemDirectoryHandle> {
    const picker = (window as typeof window & {
        showDirectoryPicker?: (options?: { mode: 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
    }).showDirectoryPicker;
    if (!picker) throw new Error('Folder downloads are not supported by this browser');
    return picker({ mode: 'readwrite' });
}
