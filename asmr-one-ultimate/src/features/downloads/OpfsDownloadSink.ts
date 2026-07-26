import { Logger } from '../../core/Utils';
import { DirectoryDownloadSink } from './DirectoryDownloadSink';

/** Reserved root inside the origin private file system used to stage downloads. */
export const OPFS_DOWNLOAD_ROOT = 'asmr-one-downloads';

type StorageManagerLike = {
    getDirectory?: () => Promise<FileSystemDirectoryHandle>;
    persisted?: () => Promise<boolean>;
    persist?: () => Promise<boolean>;
};

function storageManager(): StorageManagerLike | undefined {
    return typeof navigator === 'undefined'
        ? undefined
        : (navigator as Navigator & { storage?: StorageManagerLike }).storage;
}

/**
 * Firefox exposes `getDirectoryHandle`/`getFileHandle`/`createWritable` on the
 * origin private file system, which is exactly the random-access surface the
 * coordinator needs. Detect that surface rather than the browser.
 */
export function supportsOriginPrivateFileSystem(): boolean {
    return typeof storageManager()?.getDirectory === 'function'
        && typeof FileSystemDirectoryHandle !== 'undefined'
        && typeof FileSystemFileHandle !== 'undefined'
        && typeof FileSystemFileHandle.prototype.createWritable === 'function';
}

/**
 * Best-effort request for persistent storage. Staged downloads can be large and
 * eviction mid-job would discard resumable bytes, but a refusal is not fatal.
 */
export async function requestPersistentDownloadStorage(): Promise<boolean> {
    const storage = storageManager();
    if (!storage?.persist) return false;
    try {
        if (storage.persisted && await storage.persisted()) return true;
        return await storage.persist();
    } catch (error) {
        Logger.debug('[DownloadCenter] Persistent storage was not granted', error);
        return false;
    }
}

export async function resolveOpfsDownloadRoot(root = OPFS_DOWNLOAD_ROOT): Promise<FileSystemDirectoryHandle> {
    const getDirectory = storageManager()?.getDirectory;
    if (typeof getDirectory !== 'function') {
        throw new Error('The origin private file system is unavailable in this browser');
    }
    const opfs = await getDirectory.call(storageManager());
    return opfs.getDirectoryHandle(root, { create: true });
}

/**
 * Staging sink backed by the origin private file system.
 *
 * Behaviourally identical to the Chromium directory sink — same seek-on-resume,
 * same bounded range reads — so resume fingerprinting, checkpointing and the
 * Opus transform work unchanged. Completed work folders are handed to the
 * export step because the user cannot browse this storage directly.
 */
export class OpfsDownloadSink extends DirectoryDownloadSink {
    static async create(root = OPFS_DOWNLOAD_ROOT): Promise<OpfsDownloadSink> {
        return new OpfsDownloadSink(await resolveOpfsDownloadRoot(root));
    }
}
