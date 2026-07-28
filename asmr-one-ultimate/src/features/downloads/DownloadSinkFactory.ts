import { Logger } from '../../core/Utils';
import { chooseDownloadDirectory, DirectoryDownloadSink } from './DirectoryDownloadSink';
import {
    DownloadDestinationUnsupportedError,
    type DownloadDestination,
    type DownloadSink,
} from './DownloadSink';
import {
    OPFS_DOWNLOAD_ROOT,
    OpfsDownloadSink,
    requestPersistentDownloadStorage,
    supportsOriginPrivateFileSystem,
} from './OpfsDownloadSink';

export function supportsDirectoryPicker(): boolean {
    return typeof window !== 'undefined'
        && typeof (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

/**
 * GM_download is granted by the userscript header; page contexts lack it. This
 * only selects the preferred export transport — the exporter still falls back
 * to an anchor download when the manager declines at runtime.
 */
export function supportsUserscriptDownload(): boolean {
    const origin = globalThis.location?.origin;
    const bridged = origin
        ? (globalThis.document as unknown as Record<string, unknown> | undefined)?.[`__monkeyWindow-${origin}`]
        : undefined;
    const candidates = [
        bridged,
        (globalThis as unknown as { unsafeWindow?: unknown }).unsafeWindow,
        globalThis,
    ] as Array<Record<string, unknown> | undefined>;
    return candidates.some(candidate => typeof candidate?.GM_download === 'function');
}

/**
 * True when the browser can both stage and deliver the selected files.
 *
 * OPFS alone is private browser storage, not a user-visible destination. A
 * userscript download callback is required to confirm Firefox ZIP delivery.
 */
export function canCreateDownloadDestination(): boolean {
    return supportsDirectoryPicker()
        || (supportsOriginPrivateFileSystem() && supportsUserscriptDownload());
}

export class DownloadDestinationCancelledError extends Error {
    constructor() {
        super('The download destination picker was dismissed');
        this.name = 'DownloadDestinationCancelledError';
    }
}

function isPickerDismissal(error: unknown): boolean {
    return error instanceof DOMException
        ? error.name === 'AbortError' || error.name === 'NotAllowedError'
        : error instanceof Error && (error.name === 'AbortError' || error.name === 'NotAllowedError');
}

/**
 * Choose the strongest destination this browser supports.
 *
 * The Chromium folder picker stays preferred so existing resumable jobs and
 * on-disk behaviour are unchanged. Everything else stages into the origin
 * private file system and exports completed work folders afterwards.
 */
export async function createDownloadDestination(): Promise<DownloadDestination> {
    if (supportsDirectoryPicker()) {
        try {
            return { kind: 'fsa', handle: await chooseDownloadDirectory() };
        } catch (error) {
            if (isPickerDismissal(error)) throw new DownloadDestinationCancelledError();
            throw error;
        }
    }
    if (!supportsOriginPrivateFileSystem()) throw new DownloadDestinationUnsupportedError();
    // Confirm the staging root really is writable before a job is created;
    // private windows expose the API but refuse to open a directory.
    await OpfsDownloadSink.create(OPFS_DOWNLOAD_ROOT);
    const persisted = await requestPersistentDownloadStorage();
    if (!persisted) Logger.debug('[DownloadCenter] Staged downloads are using best-effort storage');
    if (!supportsUserscriptDownload()) throw new DownloadDestinationUnsupportedError();
    return { kind: 'gm', subfolder: OPFS_DOWNLOAD_ROOT };
}

export async function createDownloadSink(destination: DownloadDestination): Promise<DownloadSink> {
    if (destination.kind === 'fsa') return new DirectoryDownloadSink(destination.handle);
    return OpfsDownloadSink.create(
        destination.kind === 'gm' ? destination.subfolder : destination.root,
    );
}
