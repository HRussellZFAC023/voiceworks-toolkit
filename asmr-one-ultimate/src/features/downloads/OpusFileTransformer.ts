import type { MetadataWritePolicy } from './DownloadDomain';
import type { AudioTags, EmbeddedArtwork } from './MetadataPolicy';
import type { DownloadFile } from './DownloadJobRepository';
import type { DirectoryDownloadSink } from './DirectoryDownloadSink';
import type { OpusTranscoder } from './OpusTranscoder';
import { canonicalDownloadPath, reserveCollisionFreePath, sanitizeRelativePath } from './DownloadPathUtils';
import { isDownloadAudioFile } from './DownloadMediaClassifier';

const MEBIBYTE = 1024 * 1024;
const UNKNOWN_DESKTOP_SOURCE_LIMIT = 128 * MEBIBYTE;
const UNKNOWN_MOBILE_SOURCE_LIMIT = 64 * MEBIBYTE;
const MOBILE_SOURCE_LIMIT = 96 * MEBIBYTE;
const ABSOLUTE_SOURCE_LIMIT = 256 * MEBIBYTE;
const SOURCE_BYTES_PER_DEVICE_GIB = 32 * MEBIBYTE;

export interface OpusConversionDeviceProfile {
    /** Coarse navigator.deviceMemory value in GiB, or a negative value when unavailable. */
    deviceMemoryGiB: number;
    isMobile: boolean;
}

export interface OpusConversionMemoryBudget {
    maxSourceBytes: number;
}

/**
 * ffmpeg.wasm materializes the source in JS and its virtual filesystem; it
 * does not stream this conversion. Keep one source to a conservative fraction
 * of device RAM and retain an absolute ceiling even on high-memory machines.
 */
export function getOpusConversionMemoryBudget(
    profile: OpusConversionDeviceProfile = { deviceMemoryGiB: -1, isMobile: false },
): OpusConversionMemoryBudget {
    const knownMemory = Number.isFinite(profile.deviceMemoryGiB) && profile.deviceMemoryGiB > 0;
    const deviceLimit = knownMemory
        ? Math.max(32 * MEBIBYTE, Math.floor(profile.deviceMemoryGiB * SOURCE_BYTES_PER_DEVICE_GIB))
        : profile.isMobile ? UNKNOWN_MOBILE_SOURCE_LIMIT : UNKNOWN_DESKTOP_SOURCE_LIMIT;
    return {
        maxSourceBytes: Math.min(
            ABSOLUTE_SOURCE_LIMIT,
            profile.isMobile ? MOBILE_SOURCE_LIMIT : ABSOLUTE_SOURCE_LIMIT,
            deviceLimit,
        ),
    };
}

export class OpusConversionMemoryLimitError extends Error {
    readonly name = 'OpusConversionMemoryLimitError';

    constructor(
        public readonly sourceBytes: number | undefined,
        public readonly maxSourceBytes: number,
    ) {
        super(sourceBytes == null
            ? 'Opus conversion source size is unavailable'
            : 'Opus conversion source exceeds the browser memory budget');
    }
}

export interface OpusTransformOptions {
    enabled: boolean;
    bitrateKbps: number;
    metadataPolicy: MetadataWritePolicy;
    memoryBudget?: OpusConversionMemoryBudget;
    tagsForFile?: (file: DownloadFile) => AudioTags;
    artworkForFile?: (file: DownloadFile, signal?: AbortSignal) => Promise<EmbeddedArtwork | undefined>;
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
        if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
        const sourceBytes = await sink.size(sourcePath);
        const memoryBudget = this.options.memoryBudget ?? getOpusConversionMemoryBudget();
        if (!Number.isFinite(sourceBytes) || sourceBytes < 0) {
            throw new OpusConversionMemoryLimitError(undefined, memoryBudget.maxSourceBytes);
        }
        if (sourceBytes > memoryBudget.maxSourceBytes) {
            throw new OpusConversionMemoryLimitError(sourceBytes, memoryBudget.maxSourceBytes);
        }
        // Resolve bounded optional artwork before retaining the full source
        // audio buffer. This avoids cover-network stalls doubling peak memory.
        const artwork = await this.options.artworkForFile?.(file, signal);
        if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
        const input = await sink.read(sourcePath);
        const extension = sourcePath[sourcePath.length - 1].split('.').pop() || 'audio';
        const output = await this.transcoder.transcode({
            input,
            inputExtension: extension,
            bitrateKbps: this.options.bitrateKbps,
            generatedTags: this.options.tagsForFile?.(file),
            metadataPolicy: this.options.metadataPolicy,
            artwork,
            signal,
            onProgress,
        });
        await sink.writeAll(outputPath, output);
        return { path: outputPath.join('/'), bytes: output.byteLength };
    }
}
