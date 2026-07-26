/**
 * Storage contract shared by every download destination.
 *
 * The coordinator, the Opus transformer and the resume fingerprinting logic all
 * require random access: seek-on-resume writes plus bounded range reads. Any
 * backend that satisfies this interface therefore keeps checkpointing and Opus
 * conversion byte-identical, which is what allows Firefox (origin private file
 * system) to reuse the exact Chromium (File System Access) pipeline.
 */

export interface DownloadWriter {
    write(bytes: Uint8Array, offset: number): Promise<void>;
    close(): Promise<void>;
    abort(reason?: unknown): Promise<void>;
}

export interface DownloadRemoveOptions {
    /** Remove a directory together with everything beneath it. */
    recursive?: boolean;
}

export interface DownloadSink {
    /** Resolve to false when the destination is readable but not yet writable. */
    ensurePermission(request?: boolean): Promise<boolean>;
    /** Names already occupying the destination root, including files and folders. */
    listTopLevelEntryNames(): Promise<string[]>;
    open(path: readonly string[], offset: number): Promise<DownloadWriter>;
    read(path: readonly string[]): Promise<Uint8Array>;
    readRange(path: readonly string[], offset: number, length: number): Promise<Uint8Array>;
    size(path: readonly string[]): Promise<number>;
    writeAll(path: readonly string[], bytes: Uint8Array): Promise<void>;
    remove(path: readonly string[], options?: DownloadRemoveOptions): Promise<void>;
    /**
     * Optional lazily-backed handle used by the export step so a multi-gigabyte
     * archive never has to be materialized in memory. Callers must fall back to
     * {@link DownloadSink.read} when it is absent.
     */
    file?(path: readonly string[]): Promise<Blob>;
}

/**
 * Serialisable description of where a job writes. Only the Chromium variant
 * carries a live object, and structured clone preserves it; the browser-storage
 * variants are plain JSON so Firefox can persist and resume a job.
 */
export type DownloadDestination =
    | { kind: 'fsa'; handle: FileSystemDirectoryHandle }
    | { kind: 'opfs'; root: string }
    | { kind: 'gm'; subfolder: string };

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

export class DownloadDestinationUnsupportedError extends Error {
    constructor() {
        super('No download destination is available in this browser');
        this.name = 'DownloadDestinationUnsupportedError';
    }
}

/** Browser-storage destinations stage bytes and must be exported afterwards. */
export function requiresDownloadExport(destination: DownloadDestination): boolean {
    return destination.kind !== 'fsa';
}

export function downloadDestinationFolderName(destination: DownloadDestination): string {
    return destination.kind === 'gm' ? destination.subfolder : destination.kind === 'opfs' ? destination.root : '';
}
