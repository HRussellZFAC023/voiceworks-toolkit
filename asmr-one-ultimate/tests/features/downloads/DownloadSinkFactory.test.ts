import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectoryDownloadSink } from '../../../src/features/downloads/DirectoryDownloadSink';
import {
    canCreateDownloadDestination,
    createDownloadDestination,
    createDownloadSink,
    DownloadDestinationCancelledError,
    supportsDirectoryPicker,
    supportsUserscriptDownload,
} from '../../../src/features/downloads/DownloadSinkFactory';
import { DownloadDestinationUnsupportedError } from '../../../src/features/downloads/DownloadSink';
import { OPFS_DOWNLOAD_ROOT, OpfsDownloadSink } from '../../../src/features/downloads/OpfsDownloadSink';

function fakeDirectory(name = 'root') {
    const handle = {
        name,
        getDirectoryHandle: vi.fn(async (child: string) => fakeDirectory(child)),
        getFileHandle: vi.fn(),
        entries: vi.fn(() => (async function* () { /* empty */ })()),
    };
    return handle as unknown as FileSystemDirectoryHandle;
}

/** Firefox exposes the OPFS surface but no folder picker. */
function stubOriginPrivateFileSystem(root = fakeDirectory()): { getDirectory: ReturnType<typeof vi.fn> } {
    const getDirectory = vi.fn(async () => root);
    vi.stubGlobal('navigator', { storage: { getDirectory, persist: vi.fn(async () => true) } });
    vi.stubGlobal('FileSystemDirectoryHandle', class {});
    vi.stubGlobal('FileSystemFileHandle', class { createWritable() { /* present */ } });
    return { getDirectory };
}

describe('DownloadSinkFactory', () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
        delete (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker;
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        delete (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker;
        delete (globalThis as Record<string, unknown>).GM_download;
    });

    it('reports no destination when neither a picker nor browser storage exists', () => {
        vi.stubGlobal('navigator', {});
        expect(supportsDirectoryPicker()).toBe(false);
        expect(canCreateDownloadDestination()).toBe(false);
    });

    it('prefers the Chromium folder picker so existing jobs keep their on-disk behaviour', async () => {
        const handle = fakeDirectory('Chosen');
        (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker = vi.fn(async () => handle);
        stubOriginPrivateFileSystem();

        expect(canCreateDownloadDestination()).toBe(true);
        await expect(createDownloadDestination()).resolves.toEqual({ kind: 'fsa', handle });
    });

    it('translates a dismissed picker into a dedicated cancellation error', async () => {
        (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker = vi.fn(async () => {
            throw new DOMException('The user aborted a request.', 'AbortError');
        });
        await expect(createDownloadDestination()).rejects.toBeInstanceOf(DownloadDestinationCancelledError);
    });

    it('falls back to a userscript-delivered browser-storage destination in Firefox', async () => {
        stubOriginPrivateFileSystem();
        (globalThis as Record<string, unknown>).GM_download = vi.fn();

        expect(supportsUserscriptDownload()).toBe(true);
        expect(canCreateDownloadDestination()).toBe(true);
        await expect(createDownloadDestination()).resolves.toEqual({ kind: 'gm', subfolder: OPFS_DOWNLOAD_ROOT });
    });

    it('does not advertise private browser storage as a user-visible destination', async () => {
        stubOriginPrivateFileSystem();
        expect(supportsUserscriptDownload()).toBe(false);
        expect(canCreateDownloadDestination()).toBe(false);
        await expect(createDownloadDestination()).rejects.toBeInstanceOf(DownloadDestinationUnsupportedError);
    });

    it('rejects when the origin private file system is unavailable', async () => {
        vi.stubGlobal('navigator', {});
        await expect(createDownloadDestination()).rejects.toBeInstanceOf(DownloadDestinationUnsupportedError);
    });

    it('rebuilds each destination kind into a working sink on resume', async () => {
        const handle = fakeDirectory('Chosen');
        expect(await createDownloadSink({ kind: 'fsa', handle })).toBeInstanceOf(DirectoryDownloadSink);

        const root = fakeDirectory();
        const { getDirectory } = stubOriginPrivateFileSystem(root);
        expect(await createDownloadSink({ kind: 'gm', subfolder: 'staged' })).toBeInstanceOf(OpfsDownloadSink);
        expect(root.getDirectoryHandle).toHaveBeenCalledWith('staged', { create: true });
        expect(await createDownloadSink({ kind: 'opfs', root: 'other' })).toBeInstanceOf(OpfsDownloadSink);
        expect(getDirectory).toHaveBeenCalled();
    });
});
