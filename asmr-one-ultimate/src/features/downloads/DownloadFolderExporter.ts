import { Logger } from '../../core/Utils';
import { gmDownload, type GmDownloadConfig } from '../../infrastructure/HttpClient';
import type { DownloadDestination, DownloadSink } from './DownloadSink';
import { StoredZipWriter } from './StoredZipWriter';

/** Hidden staging folder holding an archive only while it is being exported. */
export const DOWNLOAD_EXPORT_STAGING_FOLDER = '.asmr-export';
export const DOWNLOAD_EXPORT_CHUNK_BYTES = 4 * 1024 * 1024;

export interface DownloadFolderExportResult {
    /** The archive reached the browser's download pipeline. */
    exported: boolean;
    /** Staged source bytes were intentionally kept because delivery is unconfirmed. */
    stagedFilesRetained: boolean;
}

export interface DownloadFolderExporterOptions {
    download?: (config: GmDownloadConfig) => Promise<boolean>;
    /** Injected for tests; the default clicks a temporary object-URL anchor. */
    anchorDownload?: (blob: Blob, filename: string) => boolean;
    chunkBytes?: number;
}

/** Keeps the URL alive long enough for the browser to start reading it. */
const OBJECT_URL_LIFETIME_MS = 10 * 60 * 1000;

function createObjectUrl(blob: Blob): string | undefined {
    if (typeof URL?.createObjectURL !== 'function') return undefined;
    const url = URL.createObjectURL(blob);
    setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_LIFETIME_MS);
    return url;
}

function defaultAnchorDownload(blob: Blob, filename: string): boolean {
    const url = typeof document === 'undefined' ? undefined : createObjectUrl(blob);
    if (!url) return false;
    try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.rel = 'noopener';
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        return true;
    } catch (error) {
        Logger.warn('[DownloadCenter] Anchor export failed', error);
        return false;
    }
}

async function* readFileChunks(
    sink: DownloadSink,
    path: readonly string[],
    size: number,
    chunkBytes: number,
): AsyncGenerator<Uint8Array> {
    for (let offset = 0; offset < size; offset += chunkBytes) {
        yield await sink.readRange(path, offset, Math.min(chunkBytes, size - offset));
    }
}

/**
 * Turns one completed work folder in a staging sink into a single archive the
 * browser can hand to the user.
 *
 * A flat `<work>.zip` filename is used deliberately: nested paths in
 * `GM_download`'s `name` are not portable across userscript managers, and a
 * per-file export would create thousands of download entries for a large job.
 */
export class DownloadFolderExporter {
    private readonly download: (config: GmDownloadConfig) => Promise<boolean>;
    private readonly anchorDownload: (blob: Blob, filename: string) => boolean;
    private readonly chunkBytes: number;

    constructor(
        private readonly sink: DownloadSink,
        private readonly destination: DownloadDestination,
        options: DownloadFolderExporterOptions = {},
    ) {
        this.download = options.download ?? gmDownload;
        this.anchorDownload = options.anchorDownload ?? defaultAnchorDownload;
        this.chunkBytes = Math.max(64 * 1024, options.chunkBytes ?? DOWNLOAD_EXPORT_CHUNK_BYTES);
    }

    /**
     * @param folder Top-level work folder name inside the sink.
     * @param filePaths Slash-separated paths, each starting with `folder`.
     */
    async exportFolder(folder: string, filePaths: readonly string[]): Promise<DownloadFolderExportResult> {
        const archiveName = `${folder}.zip`;
        const archivePath = [DOWNLOAD_EXPORT_STAGING_FOLDER, archiveName];
        try {
            const written = await this.writeArchive(archivePath, filePaths);
            if (!written) return { exported: false, stagedFilesRetained: true };
            const blob = this.sink.file
                ? await this.sink.file(archivePath)
                : new Blob([await this.sink.read(archivePath) as BlobPart]);
            // GM_download is documented to take a URL, so hand it an object URL
            // rather than the blob itself; a manager that refuses simply reports
            // false and the anchor fallback runs.
            const objectUrl = this.destination.kind === 'gm' ? createObjectUrl(blob) : undefined;
            const delivered = objectUrl
                ? await this.download({ url: objectUrl, name: archiveName, saveAs: false })
                : false;
            if (delivered) {
                await this.discard(archivePath);
                await this.discard([folder], true);
                return { exported: true, stagedFilesRetained: false };
            }
            // Without a manager callback the transfer cannot be confirmed, so
            // the staged bytes stay put rather than being silently destroyed.
            if (this.anchorDownload(blob, archiveName)) {
                return { exported: true, stagedFilesRetained: true };
            }
            await this.discard(archivePath);
            return { exported: false, stagedFilesRetained: true };
        } catch (error) {
            Logger.warn('[DownloadCenter] Could not export work folder', folder, error);
            await this.discard(archivePath);
            return { exported: false, stagedFilesRetained: true };
        }
    }

    private async writeArchive(archivePath: readonly string[], filePaths: readonly string[]): Promise<boolean> {
        const writer = await this.sink.open(archivePath, 0);
        let offset = 0;
        const zip = new StoredZipWriter(async bytes => {
            await writer.write(bytes, offset);
            offset += bytes.byteLength;
        });
        try {
            let entries = 0;
            for (const filePath of filePaths) {
                const path = filePath.split('/').filter(Boolean);
                if (!path.length) continue;
                let size: number;
                try { size = await this.sink.size(path); }
                catch (error) {
                    // A missing staged file is not fatal: it was either filtered
                    // out or already exported by an earlier run.
                    Logger.debug('[DownloadCenter] Skipping missing staged file', filePath, error);
                    continue;
                }
                await zip.addEntry({
                    name: path.join('/'),
                    size,
                    chunks: readFileChunks(this.sink, path, size, this.chunkBytes),
                });
                entries += 1;
            }
            if (!entries) {
                await writer.abort(new Error('No staged files to export'));
                await this.discard(archivePath);
                return false;
            }
            await zip.finish();
            await writer.close();
            return true;
        } catch (error) {
            await Promise.resolve(writer.abort(error)).catch(() => undefined);
            throw error;
        }
    }

    private async discard(path: readonly string[], recursive = false): Promise<void> {
        await this.sink.remove(path, { recursive }).catch(() => undefined);
    }
}
