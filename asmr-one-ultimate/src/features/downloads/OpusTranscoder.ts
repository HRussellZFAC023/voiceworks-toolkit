import type { AudioTags, EmbeddedArtwork } from './MetadataPolicy';
import { mergeAudioMetadata } from './MetadataPolicy';
import type { MetadataWritePolicy } from './DownloadDomain';

export interface OpusTranscodeRequest {
    input: Uint8Array;
    inputExtension: string;
    bitrateKbps: number;
    generatedTags?: AudioTags;
    metadataPolicy?: MetadataWritePolicy;
    artwork?: EmbeddedArtwork;
    signal?: AbortSignal;
    onProgress?: (ratio: number) => void;
}

export interface OpusTranscoder {
    isSupported(): boolean;
    transcode(request: OpusTranscodeRequest): Promise<Uint8Array>;
}

export interface FfmpegInstance {
    load(config: { coreURL: string; wasmURL: string; classWorkerURL?: string }): Promise<boolean>;
    writeFile(path: string, data: Uint8Array): Promise<void>;
    readFile(path: string): Promise<Uint8Array | string>;
    deleteFile(path: string): Promise<void>;
    exec(args: string[]): Promise<number>;
    ffprobe(args: string[]): Promise<number>;
    terminate(): void;
    on(event: 'progress', listener: (event: { progress: number }) => void): void;
    off(event: 'progress', listener: (event: { progress: number }) => void): void;
}

interface ProbeStream {
    index?: number;
    codec_type?: string;
    codec_name?: string;
    disposition?: { attached_pic?: number };
    tags?: AudioTags;
}

interface ProbeDocument {
    streams?: ProbeStream[];
    format?: { tags?: AudioTags };
}

type DynamicImport = (url: string) => Promise<any>;
const dynamicImport: DynamicImport = new Function('url', 'return import(url)') as DynamicImport;

export interface FfmpegLoaderRuntime {
    importModule: DynamicImport;
    fetchImpl: typeof fetch;
    createObjectURL: (blob: Blob) => string;
    revokeObjectURL: (url: string) => void;
}

const DEFAULT_FFMPEG_LOADER_RUNTIME: FfmpegLoaderRuntime = {
    importModule: dynamicImport,
    fetchImpl: (...args) => fetch(...args),
    createObjectURL: blob => URL.createObjectURL(blob),
    revokeObjectURL: url => URL.revokeObjectURL(url),
};

const MAX_FFMPEG_CLASS_WORKER_BYTES = 256 * 1024;

/**
 * FFmpeg's ESM wrapper creates a module worker from its package URL. Browsers
 * reject that cross-origin worker even though normal ESM imports are CORS
 * enabled. A same-origin blob worker is allowed, but its relative imports must
 * first be pinned back to the selected CDN package directory.
 */
export function rewriteFfmpegClassWorkerSource(source: string, packageBaseUrl: string): string {
    let rewritten = source;
    for (const specifier of ['./const.js', './errors.js']) {
        const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`from\\s*(["'])${escaped}\\1`, 'g');
        let found = false;
        rewritten = rewritten.replace(pattern, (_match, quote: string) => {
            found = true;
            return `from ${quote}${new URL(specifier, packageBaseUrl).href}${quote}`;
        });
        if (!found) throw new Error(`FFmpeg worker is missing required import: ${specifier}`);
    }
    return rewritten;
}

async function fetchFfmpegClassWorkerSource(url: string, runtime: FfmpegLoaderRuntime): Promise<string> {
    // Keep native Firefox fetch unbound if a caller supplies it directly.
    const fetchImpl = runtime.fetchImpl;
    const response = await fetchImpl(url, {
        credentials: 'omit',
        headers: { Accept: 'text/javascript' },
    });
    if (!response.ok) throw new Error(`Unable to load the FFmpeg worker (HTTP ${response.status})`);
    const declared = response.headers.get('content-length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_FFMPEG_CLASS_WORKER_BYTES)) {
        throw new Error('FFmpeg worker exceeds its size limit');
    }
    const source = await response.text();
    if (new TextEncoder().encode(source).byteLength > MAX_FFMPEG_CLASS_WORKER_BYTES) {
        throw new Error('FFmpeg worker exceeds its size limit');
    }
    return source;
}

/** Load one pinned CDN candidate and own/revoke its same-origin class worker. */
export async function loadFfmpegInstanceFromCdn(
    cdn: string,
    runtime: FfmpegLoaderRuntime = DEFAULT_FFMPEG_LOADER_RUNTIME,
): Promise<FfmpegInstance> {
    const packageUrl = (name: string, version: string, path: string) => `${cdn}/${name}@${version}/${path}`;
    const wrapperBase = packageUrl('@ffmpeg/ffmpeg', '0.12.15', 'dist/esm/');
    const workerUrl = new URL('worker.js', wrapperBase).href;
    const [{ FFmpeg }, { toBlobURL }, workerSource] = await Promise.all([
        runtime.importModule(new URL('index.js', wrapperBase).href),
        runtime.importModule(packageUrl('@ffmpeg/util', '0.12.2', 'dist/esm/index.js')),
        fetchFfmpegClassWorkerSource(workerUrl, runtime),
    ]);
    const ffmpeg = new FFmpeg() as FfmpegInstance;
    let classWorkerURL = '';
    let revoked = false;
    const revoke = (): void => {
        if (!classWorkerURL || revoked) return;
        revoked = true;
        runtime.revokeObjectURL(classWorkerURL);
    };
    const originalTerminate = ffmpeg.terminate.bind(ffmpeg);
    ffmpeg.terminate = (): void => {
        revoke();
        originalTerminate();
    };
    try {
        const rewrittenWorker = rewriteFfmpegClassWorkerSource(workerSource, wrapperBase);
        classWorkerURL = runtime.createObjectURL(new Blob([rewrittenWorker], { type: 'text/javascript' }));
        const core = packageUrl('@ffmpeg/core', '0.12.10', 'dist/esm');
        await ffmpeg.load({
            coreURL: await toBlobURL(`${core}/ffmpeg-core.js`, 'text/javascript'),
            wasmURL: await toBlobURL(`${core}/ffmpeg-core.wasm`, 'application/wasm'),
            classWorkerURL,
        });
        return ffmpeg;
    } catch (error) {
        try { ffmpeg.terminate(); } catch { revoke(); }
        throw error;
    }
}

export class AsyncSerialQueue {
    private tail: Promise<unknown> = Promise.resolve();

    run<T>(task: () => Promise<T>): Promise<T> {
        const result = this.tail.then(task, task);
        this.tail = result.then(() => undefined, () => undefined);
        return result;
    }
}

export function buildOpusArguments(inputPath: string, outputPath: string, request: { bitrateKbps: number; tags?: AudioTags }): string[] {
    const args = ['-i', inputPath, '-map', '0:a:0'];
    args.push('-map_metadata', '-1', '-c:a', 'libopus', '-b:a', `${request.bitrateKbps}k`);
    for (const [key, value] of Object.entries(request.tags || {})) {
        args.push('-metadata', `${key}=${Array.isArray(value) ? value.join('; ') : value}`);
    }
    args.push('-y', outputPath);
    return args;
}

/** Ogg Opus stores cover art in a Vorbis-comment FLAC picture block, not as a video stream. */
export function encodeMetadataBlockPicture(artwork: EmbeddedArtwork): string {
    const mime = new TextEncoder().encode(artwork.mimeType || 'image/jpeg');
    const description = new TextEncoder().encode(artwork.description || 'Cover');
    const total = 4 + 4 + mime.length + 4 + description.length + (5 * 4) + artwork.data.length;
    const bytes = new Uint8Array(total);
    const view = new DataView(bytes.buffer);
    let offset = 0;
    const writeU32 = (value: number) => { view.setUint32(offset, value, false); offset += 4; };
    writeU32(3); // front cover
    writeU32(mime.length); bytes.set(mime, offset); offset += mime.length;
    writeU32(description.length); bytes.set(description, offset); offset += description.length;
    writeU32(0); writeU32(0); writeU32(0); writeU32(0); // dimensions/colour count unknown
    writeU32(artwork.data.length); bytes.set(artwork.data, offset);
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
}

export function hasOpusContainerSignature(bytes: Uint8Array): boolean {
    const needle = new TextEncoder().encode('OpusHead');
    let cursor = 0;
    let foundOpusHead = false;
    let foundEndOfStream = false;
    while (cursor < bytes.length) {
        if (cursor + 27 > bytes.length || new TextDecoder().decode(bytes.subarray(cursor, cursor + 4)) !== 'OggS') return false;
        if (bytes[cursor + 4] !== 0) return false;
        const segmentCount = bytes[cursor + 26];
        const tableEnd = cursor + 27 + segmentCount;
        if (tableEnd > bytes.length) return false;
        let bodyLength = 0;
        for (let index = cursor + 27; index < tableEnd; index += 1) bodyLength += bytes[index];
        const pageEnd = tableEnd + bodyLength;
        if (pageEnd > bytes.length) return false;
        const body = bytes.subarray(tableEnd, pageEnd);
        outer: for (let index = 0; index + needle.length <= body.length; index += 1) {
            for (let offset = 0; offset < needle.length; offset += 1) {
                if (body[index + offset] !== needle[offset]) continue outer;
            }
            foundOpusHead = true;
            break;
        }
        foundEndOfStream = (bytes[cursor + 5] & 0x04) !== 0;
        cursor = pageEnd;
    }
    return cursor === bytes.length && foundOpusHead && foundEndOfStream;
}

/** Dynamically loaded to keep the userscript below its distribution size cap. */
export class FfmpegOpusTranscoder implements OpusTranscoder {
    private ffmpeg?: Promise<FfmpegInstance>;
    private readonly transcodes = new AsyncSerialQueue();

    isSupported(): boolean { return typeof WebAssembly !== 'undefined' && typeof Worker !== 'undefined'; }

    private async instance(): Promise<FfmpegInstance> {
        if (!this.ffmpeg) this.ffmpeg = this.loadInstance().catch(error => {
            // A transient CDN/CSP failure must not poison every later retry.
            this.ffmpeg = undefined;
            throw error;
        });
        return this.ffmpeg;
    }

    private async loadInstance(): Promise<FfmpegInstance> {
        const cdns = [
            'https://unpkg.com',
            'https://cdn.jsdelivr.net/npm',
        ];
        let lastError: unknown;
        for (const cdn of cdns) {
            try {
                return await loadFfmpegInstanceFromCdn(cdn);
            } catch (error) {
                lastError = error;
            }
        }
        throw new Error(`Unable to load the Opus converter: ${lastError instanceof Error ? lastError.message : 'CDN unavailable'}`);
    }

    transcode(request: OpusTranscodeRequest): Promise<Uint8Array> {
        return this.transcodes.run(async () => {
            if (request.signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
            return this.transcodeExclusive(request);
        });
    }

    private async transcodeExclusive(request: OpusTranscodeRequest): Promise<Uint8Array> {
        if (!this.isSupported()) throw new Error('Opus conversion is not supported in this browser');
        const ffmpeg = await this.instance();
        const suffix = crypto.randomUUID();
        const inputPath = `input-${suffix}.${request.inputExtension.replace(/^\./, '') || 'audio'}`;
        const outputPath = `output-${suffix}.opus`;
        const probePath = `probe-${suffix}.json`;
        const verifyPath = `verify-${suffix}.json`;
        let extractedCoverPath = '';
        const abort = () => { ffmpeg.terminate(); this.ffmpeg = undefined; };
        const progress = ({ progress }: { progress: number }) => request.onProgress?.(Math.max(0, Math.min(1, progress)));
        request.signal?.addEventListener('abort', abort, { once: true });
        ffmpeg.on('progress', progress);
        try {
            await ffmpeg.writeFile(inputPath, request.input);
            await ffmpeg.ffprobe(['-v', 'error', '-show_entries', 'format_tags:stream=index,codec_type,codec_name:stream_disposition:stream_tags', '-of', 'json', inputPath, '-o', probePath]);
            const probeRaw = await ffmpeg.readFile(probePath);
            let sourceTags: AudioTags = {};
            let sourceArtwork: EmbeddedArtwork | undefined;
            try {
                const json = JSON.parse(
                    typeof probeRaw === 'string' ? probeRaw : new TextDecoder().decode(probeRaw),
                ) as ProbeDocument;
                for (const stream of json?.streams || []) sourceTags = { ...sourceTags, ...(stream?.tags || {}) };
                sourceTags = { ...sourceTags, ...(json?.format?.tags || {}) };
                const picture = (json?.streams || []).find(stream => stream.codec_type === 'video' && stream.disposition?.attached_pic === 1);
                if (picture) {
                    const isPng = picture.codec_name === 'png';
                    extractedCoverPath = `source-cover-${suffix}.${isPng ? 'png' : 'jpg'}`;
                    const map = Number.isInteger(picture.index) ? `0:${picture.index}` : '0:v:0';
                    const code = await ffmpeg.exec(['-i', inputPath, '-map', map, '-c:v', 'copy', '-y', extractedCoverPath]);
                    if (code === 0) {
                        const extracted = await ffmpeg.readFile(extractedCoverPath);
                        if (typeof extracted !== 'string') sourceArtwork = {
                            mimeType: isPng ? 'image/png' : 'image/jpeg', data: new Uint8Array(extracted),
                        };
                    }
                }
            } catch { /* malformed source metadata is non-fatal */ }
            const merged = mergeAudioMetadata({
                sourceTags,
                generatedTags: request.generatedTags || {},
                sourceArtwork: sourceArtwork ? [sourceArtwork] : [],
                generatedArtwork: request.artwork,
                policy: request.metadataPolicy || 'additive',
                includeArtwork: true,
            });
            if (merged.artwork[0]) merged.tags.METADATA_BLOCK_PICTURE = encodeMetadataBlockPicture(merged.artwork[0]);
            const args = buildOpusArguments(inputPath, outputPath, {
                bitrateKbps: request.bitrateKbps,
                tags: merged.tags,
            });
            const exitCode = await ffmpeg.exec(args);
            if (exitCode !== 0) throw new Error(`FFmpeg Opus conversion failed with exit code ${exitCode}`);
            const output = await ffmpeg.readFile(outputPath);
            if (typeof output === 'string') throw new Error('FFmpeg returned an invalid Opus payload');
            const bytes = new Uint8Array(output);
            if (!hasOpusContainerSignature(bytes)) throw new Error('FFmpeg returned an invalid Opus container');
            const verifyCode = await ffmpeg.ffprobe([
                '-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'json', outputPath, '-o', verifyPath,
            ]);
            const verifyRaw = verifyCode === 0 ? await ffmpeg.readFile(verifyPath) : '';
            const verifyText = typeof verifyRaw === 'string' ? verifyRaw : new TextDecoder().decode(verifyRaw);
            const probedAsOpus = (() => {
                try {
                    const json = JSON.parse(verifyText);
                    return json?.streams?.some((stream: { codec_name?: string }) => stream.codec_name === 'opus');
                } catch { return false; }
            })();
            // Some ffmpeg.wasm builds return -1 for ffprobe on Ogg picture
            // comments. In that known case the complete page/EOS validation
            // above remains authoritative; a successful contradictory probe still fails.
            if (verifyCode === 0 && !probedAsOpus) throw new Error('Generated Opus file failed validation');
            return bytes;
        } finally {
            request.signal?.removeEventListener('abort', abort);
            ffmpeg.off('progress', progress);
            await Promise.allSettled([
                ffmpeg.deleteFile(inputPath), ffmpeg.deleteFile(outputPath),
                ffmpeg.deleteFile(probePath),
                ffmpeg.deleteFile(verifyPath),
                ...(extractedCoverPath ? [ffmpeg.deleteFile(extractedCoverPath)] : []),
            ]);
        }
    }
}
