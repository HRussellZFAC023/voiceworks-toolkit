import type { MetadataWritePolicy } from './DownloadDomain';
import type { AudioTags, EmbeddedArtwork } from './MetadataPolicy';
import type { DownloadFile } from './DownloadJobRepository';
import type { DirectoryDownloadSink } from './DirectoryDownloadSink';
import type { OpusTranscoder } from './OpusTranscoder';
import { canonicalDownloadPath, reserveCollisionFreePath, sanitizeRelativePath } from './DownloadPathUtils';
import { isDownloadAudioFile } from './DownloadMediaClassifier';

export interface OpusTransformOptions {
    enabled: boolean;
    bitrateKbps: number;
    metadataPolicy: MetadataWritePolicy;
    tagsForFile?: (file: DownloadFile) => AudioTags;
    artworkForFile?: (file: DownloadFile) => Promise<EmbeddedArtwork | undefined>;
    outputPathForFile?: (file: DownloadFile) => string | undefined;
}

/** Reserve converted names against every source and converted path in the job. */
export function planOpusOutputPaths(files: ReadonlyArray<Pick<DownloadFile, 'id' | 'path'>>): Record<string, string> {
    const occupied = new Set<string>();
    for (const file of files) {
        const segments = file.path.split('/').filter(Boolean);
        occupied.add(canonicalDownloadPath(segments));
        for (let length = 1; length < segments.length; length += 1) {
            occupied.add(canonicalDownloadPath(segments.slice(0, length)));
        }
    }
    const result: Record<string, string> = {};
    for (const file of files) {
        if (!isDownloadAudioFile(file.path) || /\.opus$/i.test(file.path)) continue;
        const desired = file.path.replace(/\.[^./]+$/, '') + '.opus';
        const reserved = reserveCollisionFreePath(sanitizeRelativePath(desired), occupied);
        result[file.id] = reserved.join('/');
    }
    return result;
}

export class OpusFileTransformer {
    constructor(private readonly transcoder: OpusTranscoder, private readonly options: OpusTransformOptions) {}

    shouldTransform(file: DownloadFile): boolean {
        return this.options.enabled && isDownloadAudioFile(file.path) && !/\.opus$/i.test(file.path);
    }

    async transform(
        file: DownloadFile,
        sink: DirectoryDownloadSink,
        signal?: AbortSignal,
        onProgress?: (ratio: number) => void,
    ): Promise<{ path: string; bytes: number }> {
        if (!this.shouldTransform(file)) return { path: file.path, bytes: file.totalBytes ?? file.downloadedBytes };
        const sourcePath = file.path.split('/').filter(Boolean);
        const configuredOutput = this.options.outputPathForFile?.(file);
        const outputPath = configuredOutput?.split('/').filter(Boolean) || [...sourcePath];
        if (!configuredOutput) outputPath[outputPath.length - 1] = outputPath[outputPath.length - 1].replace(/\.[^.]+$/, '') + '.opus';
        const input = await sink.read(sourcePath);
        const extension = sourcePath[sourcePath.length - 1].split('.').pop() || 'audio';
        const output = await this.transcoder.transcode({
            input,
            inputExtension: extension,
            bitrateKbps: this.options.bitrateKbps,
            generatedTags: this.options.tagsForFile?.(file),
            metadataPolicy: this.options.metadataPolicy,
            artwork: await this.options.artworkForFile?.(file),
            signal,
            onProgress,
        });
        await sink.writeAll(outputPath, output);
        return { path: outputPath.join('/'), bytes: output.byteLength };
    }
}
