import { getAuthHeader } from '../playlist/PlaylistService';

export interface DownloadProbe {
    size?: number;
    etag?: string;
    lastModified?: string;
    acceptsRanges: boolean;
}

export interface DownloadChunk {
    bytes: Uint8Array;
    offset: number;
    total?: number;
    etag?: string;
    lastModified?: string;
}

export class RangeRestartRequiredError extends Error {
    constructor(message = 'Server did not honor the requested byte range') {
        super(message);
        this.name = 'RangeRestartRequiredError';
    }
}

type FetchLike = typeof fetch;

function numericHeader(headers: Headers, key: string): number | undefined {
    const value = Number(headers.get(key));
    return Number.isFinite(value) && value >= 0 ? value : undefined;
}

interface ParsedContentRange { start: number; end: number; total?: number }
function parseContentRange(value: string | null): ParsedContentRange | undefined {
    const match = value?.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
    if (!match) return undefined;
    const start = Number(match[1]);
    const end = Number(match[2]);
    const total = match[3] === '*' ? undefined : Number(match[3]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return undefined;
    if (total !== undefined && (!Number.isSafeInteger(total) || total <= end)) return undefined;
    return { start, end, total };
}

/** Streaming transport with strict range validation for safe resume. */
export class DownloadTransport {
    constructor(private readonly fetchImpl: FetchLike = fetch) {}

    async probe(url: string, signal?: AbortSignal): Promise<DownloadProbe> {
        const response = await this.fetchImpl(url, {
            method: 'HEAD',
            headers: getAuthHeader(),
            signal,
            credentials: 'include',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        return {
            size: numericHeader(response.headers, 'content-length'),
            etag: response.headers.get('etag') || undefined,
            lastModified: response.headers.get('last-modified') || undefined,
            acceptsRanges: /bytes/i.test(response.headers.get('accept-ranges') || ''),
        };
    }

    async stream(
        url: string,
        offset: number,
        onChunk: (chunk: DownloadChunk) => void | Promise<void>,
        options: { signal?: AbortSignal; expectedEtag?: string; expectedLastModified?: string } = {},
    ): Promise<DownloadProbe> {
        const headers: Record<string, string> = { ...getAuthHeader() };
        if (offset > 0) headers.Range = `bytes=${offset}-`;
        if (offset > 0 && options.expectedEtag) headers['If-Range'] = options.expectedEtag;
        else if (offset > 0 && options.expectedLastModified) headers['If-Range'] = options.expectedLastModified;

        const response = await this.fetchImpl(url, {
            headers,
            signal: options.signal,
            credentials: 'include',
        });
        if (offset > 0 && response.status !== 206) throw new RangeRestartRequiredError();
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

        const range = parseContentRange(response.headers.get('content-range'));
        if (response.status === 206 && range?.start !== offset) {
            throw new RangeRestartRequiredError('Server returned a mismatched byte range');
        }
        const etag = response.headers.get('etag') || undefined;
        const lastModified = response.headers.get('last-modified') || undefined;
        if (options.expectedEtag && etag && etag !== options.expectedEtag) {
            throw new RangeRestartRequiredError('Remote file changed since the checkpoint');
        }
        if (options.expectedLastModified && lastModified && lastModified !== options.expectedLastModified) {
            throw new RangeRestartRequiredError('Remote file changed since the checkpoint');
        }

        const total = range?.total
            ?? (response.status === 206 ? undefined : numericHeader(response.headers, 'content-length'));
        const reader = response.body?.getReader();
        if (!reader) throw new Error('Streaming response body is unavailable');
        let cursor = offset;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value?.byteLength) continue;
            await onChunk({ bytes: value, offset: cursor, total, etag, lastModified });
            cursor += value.byteLength;
        }
        const expectedEnd = typeof total === 'number' ? total : range ? range.end + 1 : undefined;
        if (typeof expectedEnd === 'number' && cursor !== expectedEnd) {
            throw new Error(`Incomplete download: received ${cursor} of ${expectedEnd} bytes`);
        }
        return {
            size: total,
            etag,
            lastModified,
            acceptsRanges: response.status === 206 || /bytes/i.test(response.headers.get('accept-ranges') || ''),
        };
    }
}
