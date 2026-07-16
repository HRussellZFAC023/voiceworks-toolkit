import { getApiBaseUrl, getAuthHeader } from '../playlist/PlaylistService';

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

export class DownloadStallError extends Error {
    constructor(message = 'Download stalled while waiting for data') {
        super(message);
        this.name = 'DownloadStallError';
    }
}

type FetchLike = typeof fetch;

export interface DownloadRetryOptions {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    sleep?: (milliseconds: number) => Promise<void>;
    random?: () => number;
    stallTimeoutMs?: number;
    setTimer?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

const DEFAULT_RETRY_ATTEMPTS = 3;

function isAbortError(error: unknown): boolean {
    return error instanceof DOMException
        ? error.name === 'AbortError'
        : error instanceof Error && error.name === 'AbortError';
}

function isRetryableStatus(status: number): boolean {
    return status === 408 || status === 429 || status >= 500;
}

function retryAfterMilliseconds(value: string | null, now = Date.now()): number | undefined {
    if (!value) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function numericHeader(headers: Headers, key: string): number | undefined {
    const raw = headers.get(key);
    if (raw === null || raw.trim() === '') return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Return host authentication only when the request resolves to the selected
 * ASMR API origin. Resolving against that base also permits relative API URLs,
 * while rejecting protocol-relative CDN URLs and arbitrary manifest origins.
 */
function getTrustedAuthHeader(url: string): Record<string, string> {
    try {
        const apiUrl = new URL(getApiBaseUrl());
        const requestUrl = new URL(url, apiUrl);
        if (!/^https?:$/.test(apiUrl.protocol)
            || !/^https?:$/.test(requestUrl.protocol)
            || requestUrl.origin !== apiUrl.origin) {
            return {};
        }
        return getAuthHeader();
    } catch {
        return {};
    }
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
    private readonly maxAttempts: number;
    private readonly baseDelayMs: number;
    private readonly maxDelayMs: number;
    private readonly sleep: (milliseconds: number) => Promise<void>;
    private readonly random: () => number;
    private readonly stallTimeoutMs: number;
    private readonly setTimer: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
    private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;

    constructor(private readonly fetchImpl: FetchLike = fetch, retry: DownloadRetryOptions = {}) {
        this.maxAttempts = Math.max(1, Math.floor(retry.maxAttempts ?? DEFAULT_RETRY_ATTEMPTS));
        this.baseDelayMs = Math.max(0, retry.baseDelayMs ?? 300);
        this.maxDelayMs = Math.max(this.baseDelayMs, retry.maxDelayMs ?? 5_000);
        this.sleep = retry.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
        this.random = retry.random ?? Math.random;
        this.stallTimeoutMs = Math.max(0, retry.stallTimeoutMs ?? 30_000);
        this.setTimer = retry.setTimer ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
        this.clearTimer = retry.clearTimer ?? (timer => clearTimeout(timer));
    }

    private retryDelay(attempt: number, response?: Response): number {
        const retryAfter = retryAfterMilliseconds(response?.headers.get('retry-after') ?? null);
        if (retryAfter !== undefined) return Math.min(this.maxDelayMs, retryAfter);
        const exponential = Math.min(this.maxDelayMs, this.baseDelayMs * (2 ** attempt));
        return exponential * (0.5 + this.random() * 0.5);
    }

    /** Retries only request establishment/status failures, before any body bytes reach the sink. */
    private async request(url: string, init: RequestInit): Promise<Response> {
        for (let attempt = 0; ; attempt += 1) {
            let response: Response;
            try {
                response = await this.fetchImpl(url, init);
            } catch (error) {
                if (isAbortError(error) || init.signal?.aborted || attempt + 1 >= this.maxAttempts) throw error;
                await this.sleep(this.retryDelay(attempt));
                continue;
            }
            if (!isRetryableStatus(response.status) || attempt + 1 >= this.maxAttempts) return response;
            await response.body?.cancel().catch(() => undefined);
            await this.sleep(this.retryDelay(attempt, response));
        }
    }

    private readWithStallTimeout(
        reader: ReadableStreamDefaultReader<Uint8Array>,
        controller: AbortController,
    ): Promise<ReadableStreamReadResult<Uint8Array>> {
        if (this.stallTimeoutMs === 0) return reader.read();
        let timer: ReturnType<typeof setTimeout> | undefined;
        return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
            timer = this.setTimer(() => {
                const error = new DownloadStallError();
                controller.abort(error);
                void reader.cancel(error).catch(() => undefined);
                reject(error);
            }, this.stallTimeoutMs);
            reader.read().then(resolve, reject);
        }).finally(() => {
            if (timer !== undefined) this.clearTimer(timer);
        });
    }

    async probe(url: string, signal?: AbortSignal): Promise<DownloadProbe> {
        const response = await this.request(url, {
            method: 'HEAD',
            headers: getTrustedAuthHeader(url),
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
        const headers: Record<string, string> = { ...getTrustedAuthHeader(url) };
        if (offset > 0) headers.Range = `bytes=${offset}-`;
        if (offset > 0 && options.expectedEtag) headers['If-Range'] = options.expectedEtag;
        else if (offset > 0 && options.expectedLastModified) headers['If-Range'] = options.expectedLastModified;

        const requestController = new AbortController();
        const forwardAbort = () => requestController.abort(options.signal?.reason);
        if (options.signal?.aborted) forwardAbort();
        else options.signal?.addEventListener('abort', forwardAbort, { once: true });
        try {
            const response = await this.request(url, {
                headers,
                signal: requestController.signal,
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
                const { done, value } = await this.readWithStallTimeout(reader, requestController);
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
        } finally {
            options.signal?.removeEventListener('abort', forwardAbort);
        }
    }
}
