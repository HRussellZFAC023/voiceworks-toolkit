import { getApiBaseUrl, getAuthHeader } from '../playlist/PlaylistService';
import {
    downloadResumeFingerprintCoversFullPrefix,
    matchesDownloadResumeFingerprint,
    type DownloadResumeFingerprint,
} from './DownloadResumeFingerprint';

export interface DownloadProbe {
    size?: number;
    etag?: string;
    lastModified?: string;
    /** Trusted raw-object version metadata used when standard HTTP validators are absent. */
    objectVersion?: string;
    /** Canonical trusted raw-object origin + path (verification query excluded). */
    objectIdentity?: string;
    /** Exact manifest/API request URL that selected this object. */
    sourceUrl?: string;
    acceptsRanges: boolean;
    /** A validator-proven 416 established that the persisted offset is exact EOF. */
    confirmedCompleteAtOffset?: true;
    /** A successful full response explicitly declared Content-Length: 0. */
    confirmedEmpty?: true;
}

export interface DownloadChunk {
    bytes: Uint8Array;
    offset: number;
    total?: number;
    etag?: string;
    lastModified?: string;
    objectVersion?: string;
    objectIdentity?: string;
    sourceUrl?: string;
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

export class DownloadRequestTimeoutError extends Error {
    constructor(message = 'Download request timed out before receiving a response') {
        super(message);
        this.name = 'DownloadRequestTimeoutError';
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
    requestTimeoutMs?: number;
    setTimer?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface DownloadStreamOptions {
    signal?: AbortSignal;
    expectedEtag?: string;
    expectedLastModified?: string;
    expectedObjectVersion?: string;
    expectedObjectIdentity?: string;
    expectedSourceUrl?: string;
    expectedResumeFingerprint?: DownloadResumeFingerprint;
    /** Manifest/checkpoint total required to prove an offset-at-EOF 416 is complete. */
    expectedTotal?: number;
}

const TRUSTED_RAW_MEDIA_ORIGIN = 'https://raw.kiko-play-niptan.one';

function canonicalTrustedObjectIdentity(value: string): string | undefined {
    try {
        const url = new URL(value);
        if (url.origin !== TRUSTED_RAW_MEDIA_ORIGIN || !url.pathname.startsWith('/')) return undefined;
        return `${url.origin}${url.pathname}`;
    } catch {
        return undefined;
    }
}

function trustedObjectValidator(
    response: Response,
    fallbackUrl: string,
): { objectVersion?: string; objectIdentity?: string } {
    const objectIdentity = canonicalTrustedObjectIdentity(response.url || fallbackUrl);
    if (!objectIdentity) return {};
    const rawVersion = response.headers.get('x-bz-info-mtime')?.trim() || '';
    if (!/^\d+(?:\.\d+)?$/.test(rawVersion) || rawVersion.length > 64) {
        return { objectIdentity };
    }
    return { objectVersion: rawVersion, objectIdentity };
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

interface DownloadRequestTarget {
    url: string;
    headers: Record<string, string>;
    credentials: RequestCredentials;
}

/**
 * Resolve relative manifest URLs against the selected API (not the page), and
 * send credentials only to that trusted API origin. Public media CDNs commonly
 * answer with `Access-Control-Allow-Origin: *`; credentialed fetches are
 * forbidden for those responses and fail in browsers even when the URL itself
 * returns HTTP 200.
 */
export function resolveDownloadRequestTarget(url: string): DownloadRequestTarget {
    try {
        const apiUrl = new URL(getApiBaseUrl());
        const requestUrl = new URL(url, apiUrl);
        const trustedApiOrigin = /^https?:$/.test(apiUrl.protocol)
            && /^https?:$/.test(requestUrl.protocol)
            && requestUrl.origin === apiUrl.origin;
        return {
            url: requestUrl.href,
            headers: trustedApiOrigin ? getAuthHeader() : {},
            credentials: trustedApiOrigin ? 'include' : 'omit',
        };
    } catch {
        return { url, headers: {}, credentials: 'omit' };
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

function parseUnsatisfiedContentRange(value: string | null): number | undefined {
    const match = value?.match(/^bytes\s+\*\/(\d+)$/i);
    if (!match) return undefined;
    const total = Number(match[1]);
    return Number.isSafeInteger(total) && total >= 0 ? total : undefined;
}

/** Streaming transport with strict range validation for safe resume. */
export class DownloadTransport {
    private readonly maxAttempts: number;
    private readonly baseDelayMs: number;
    private readonly maxDelayMs: number;
    private readonly sleep: (milliseconds: number) => Promise<void>;
    private readonly random: () => number;
    private readonly stallTimeoutMs: number;
    private readonly requestTimeoutMs: number;
    private readonly setTimer: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
    private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;

    constructor(private readonly fetchImpl: FetchLike = fetch, retry: DownloadRetryOptions = {}) {
        this.maxAttempts = Math.max(1, Math.floor(retry.maxAttempts ?? DEFAULT_RETRY_ATTEMPTS));
        this.baseDelayMs = Math.max(0, retry.baseDelayMs ?? 300);
        this.maxDelayMs = Math.max(this.baseDelayMs, retry.maxDelayMs ?? 5_000);
        this.sleep = retry.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
        this.random = retry.random ?? Math.random;
        this.stallTimeoutMs = Math.max(0, retry.stallTimeoutMs ?? 30_000);
        this.requestTimeoutMs = Math.max(0, retry.requestTimeoutMs ?? 30_000);
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
            const attemptController = new AbortController();
            const forwardAbort = () => attemptController.abort(init.signal?.reason);
            if (init.signal?.aborted) forwardAbort();
            else init.signal?.addEventListener('abort', forwardAbort, { once: true });
            let timer: ReturnType<typeof setTimeout> | undefined;
            let timedOut = false;
            const timeoutError = new DownloadRequestTimeoutError();
            try {
                // Firefox enforces the WebIDL receiver for window.fetch. Reading
                // it through the transport instance and immediately calling
                // `this.fetchImpl(...)` binds `this` to DownloadTransport, which
                // Firefox rejects before issuing the request.
                const fetchImpl = this.fetchImpl;
                const fetchRequest = fetchImpl(url, {
                    ...init,
                    signal: attemptController.signal,
                });
                if (this.requestTimeoutMs > 0) {
                    const timeout = new Promise<never>((_resolve, reject) => {
                        timer = this.setTimer(() => {
                            timedOut = true;
                            attemptController.abort(timeoutError);
                            reject(timeoutError);
                        }, this.requestTimeoutMs);
                    });
                    response = await Promise.race([fetchRequest, timeout]);
                } else {
                    response = await fetchRequest;
                }
            } catch (error) {
                const failure = timedOut ? timeoutError : error;
                if (
                    init.signal?.aborted
                    || (!timedOut && isAbortError(error))
                    || attempt + 1 >= this.maxAttempts
                ) throw failure;
                await this.sleep(this.retryDelay(attempt));
                continue;
            } finally {
                if (timer !== undefined) this.clearTimer(timer);
                init.signal?.removeEventListener('abort', forwardAbort);
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

    private async readExactResponseBytes(
        response: Response,
        expectedLength: number,
        controller: AbortController,
    ): Promise<Uint8Array> {
        if (!response.body) throw new RangeRestartRequiredError('Resume proof body is unavailable');
        const reader = response.body.getReader();
        const result = new Uint8Array(expectedLength);
        let cursor = 0;
        try {
            for (;;) {
                const { done, value } = await this.readWithStallTimeout(reader, controller);
                if (done) break;
                if (!value?.byteLength) continue;
                if (cursor + value.byteLength > expectedLength) {
                    throw new RangeRestartRequiredError('Resume proof exceeded its declared byte range');
                }
                result.set(value, cursor);
                cursor += value.byteLength;
            }
            if (cursor !== expectedLength) {
                throw new RangeRestartRequiredError('Resume proof was truncated');
            }
            return result;
        } catch (error) {
            await reader.cancel(error).catch(() => undefined);
            throw error;
        }
    }

    private async verifyTrustedResumeFingerprint(
        target: DownloadRequestTarget,
        fingerprint: DownloadResumeFingerprint,
        expectedObjectIdentity: string,
        expectedTotal: number,
        controller: AbortController,
    ): Promise<boolean> {
        return matchesDownloadResumeFingerprint(fingerprint, async (offset, length) => {
            const end = offset + length - 1;
            const response = await this.request(target.url, {
                headers: { ...target.headers, Range: `bytes=${offset}-${end}` },
                signal: controller.signal,
                credentials: target.credentials,
            });
            const range = parseContentRange(response.headers.get('content-range'));
            const identity = canonicalTrustedObjectIdentity(response.url || target.url);
            if (
                response.status !== 206
                || range?.start !== offset
                || range.end !== end
                || range.total !== expectedTotal
                || identity !== expectedObjectIdentity
            ) {
                await response.body?.cancel().catch(() => undefined);
                throw new RangeRestartRequiredError('Remote resume proof did not match the checkpoint object');
            }
            return this.readExactResponseBytes(response, length, controller);
        });
    }

    async probe(url: string, signal?: AbortSignal): Promise<DownloadProbe> {
        const target = resolveDownloadRequestTarget(url);
        const response = await this.request(target.url, {
            method: 'HEAD',
            headers: target.headers,
            signal,
            credentials: target.credentials,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        const objectValidator = trustedObjectValidator(response, target.url);
        return {
            size: numericHeader(response.headers, 'content-length'),
            etag: response.headers.get('etag') || undefined,
            lastModified: response.headers.get('last-modified') || undefined,
            ...objectValidator,
            ...(objectValidator.objectIdentity ? { sourceUrl: target.url } : {}),
            acceptsRanges: /bytes/i.test(response.headers.get('accept-ranges') || ''),
        };
    }

    async stream(
        url: string,
        offset: number,
        onChunk: (chunk: DownloadChunk) => void | Promise<void>,
        options: DownloadStreamOptions = {},
    ): Promise<DownloadProbe> {
        const target = resolveDownloadRequestTarget(url);
        const hasTrustedObjectValidator = !!options.expectedObjectVersion
            && !!options.expectedObjectIdentity
            && !!options.expectedSourceUrl
            && options.expectedSourceUrl === target.url
            && Number.isSafeInteger(options.expectedTotal)
            && canonicalTrustedObjectIdentity(options.expectedObjectIdentity) === options.expectedObjectIdentity;
        const hasTrustedResumeFingerprint = !options.expectedObjectVersion
            && !!options.expectedObjectIdentity
            && !!options.expectedSourceUrl
            && options.expectedSourceUrl === target.url
            && Number.isSafeInteger(options.expectedTotal)
            && canonicalTrustedObjectIdentity(options.expectedObjectIdentity) === options.expectedObjectIdentity
            && downloadResumeFingerprintCoversFullPrefix(options.expectedResumeFingerprint)
            && options.expectedResumeFingerprint.checkpointOffset === offset;
        if (
            offset > 0
            && !options.expectedEtag
            && !options.expectedLastModified
            && !hasTrustedObjectValidator
            && !hasTrustedResumeFingerprint
        ) {
            throw new RangeRestartRequiredError(
                'Cannot safely resume without a persisted remote object validator',
            );
        }
        const headers: Record<string, string> = { ...target.headers };
        if (offset > 0) headers.Range = `bytes=${offset}-`;
        if (offset > 0 && options.expectedEtag) headers['If-Range'] = options.expectedEtag;
        else if (offset > 0 && options.expectedLastModified) headers['If-Range'] = options.expectedLastModified;

        const requestController = new AbortController();
        const forwardAbort = () => requestController.abort(options.signal?.reason);
        if (options.signal?.aborted) forwardAbort();
        else options.signal?.addEventListener('abort', forwardAbort, { once: true });
        try {
            let validatorContinuityProven = hasTrustedResumeFingerprint
                ? await this.verifyTrustedResumeFingerprint(
                    target,
                    options.expectedResumeFingerprint!,
                    options.expectedObjectIdentity!,
                    options.expectedTotal!,
                    requestController,
                )
                : false;
            if (hasTrustedResumeFingerprint && !validatorContinuityProven) {
                throw new RangeRestartRequiredError('Remote file changed since the checkpoint');
            }
            let response = await this.request(target.url, {
                headers: { ...headers },
                signal: requestController.signal,
                credentials: target.credentials,
            });
            // Some Cloudflare-backed media origins return the full object when a
            // date-based If-Range is present even though the identical plain
            // Range request is supported. If the full response proves the
            // persisted validator is still current, cancel it before consuming
            // bytes and retry once with the same strictly validated range.
            if (
                offset > 0
                && response.status === 200
                && !options.expectedEtag
                && !!options.expectedLastModified
                && response.headers.get('last-modified') === options.expectedLastModified
            ) {
                validatorContinuityProven = true;
                await response.body?.cancel().catch(() => undefined);
                delete headers['If-Range'];
                response = await this.request(target.url, {
                    headers: { ...headers },
                    signal: requestController.signal,
                    credentials: target.credentials,
                });
            }
            if (offset > 0 && response.status === 416) {
                const remoteTotal = parseUnsatisfiedContentRange(response.headers.get('content-range'));
                const responseEtag = response.headers.get('etag') || undefined;
                const responseLastModified = response.headers.get('last-modified') || undefined;
                const responseObject = trustedObjectValidator(response, target.url);
                const responseProvesContinuity = options.expectedEtag
                    ? responseEtag === options.expectedEtag
                    : options.expectedLastModified
                        ? responseLastModified === options.expectedLastModified
                        : hasTrustedObjectValidator
                            ? responseObject.objectVersion === options.expectedObjectVersion
                                && responseObject.objectIdentity === options.expectedObjectIdentity
                            : hasTrustedResumeFingerprint
                                ? validatorContinuityProven
                                    && responseObject.objectIdentity === options.expectedObjectIdentity
                            : false;
                await response.body?.cancel().catch(() => undefined);
                if (
                    Number.isSafeInteger(options.expectedTotal)
                    && options.expectedTotal === offset
                    && remoteTotal === options.expectedTotal
                    && (validatorContinuityProven || responseProvesContinuity)
                ) {
                    return {
                        size: remoteTotal,
                        etag: responseEtag ?? options.expectedEtag,
                        lastModified: responseLastModified ?? options.expectedLastModified,
                        ...(responseObject.objectIdentity ? {
                            ...responseObject,
                            sourceUrl: target.url,
                        } : {}),
                        acceptsRanges: true,
                        confirmedCompleteAtOffset: true,
                    };
                }
                throw new RangeRestartRequiredError('Server could not prove the completed byte range');
            }
            if (offset > 0 && response.status !== 206) {
                await response.body?.cancel().catch(() => undefined);
                throw new RangeRestartRequiredError();
            }
            if (!response.ok) {
                await response.body?.cancel().catch(() => undefined);
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const range = parseContentRange(response.headers.get('content-range'));
            if (response.status === 206 && range?.start !== offset) {
                await response.body?.cancel().catch(() => undefined);
                throw new RangeRestartRequiredError('Server returned a mismatched byte range');
            }
            let etag = response.headers.get('etag') || undefined;
            let lastModified = response.headers.get('last-modified') || undefined;
            const responseObject = trustedObjectValidator(response, target.url);
            if (
                hasTrustedObjectValidator
                && (
                    responseObject.objectVersion !== options.expectedObjectVersion
                    || responseObject.objectIdentity !== options.expectedObjectIdentity
                    || range?.total !== options.expectedTotal
                )
            ) {
                await response.body?.cancel().catch(() => undefined);
                throw new RangeRestartRequiredError('Remote file changed since the checkpoint');
            }
            if (
                hasTrustedResumeFingerprint
                && (
                    !validatorContinuityProven
                    || responseObject.objectIdentity !== options.expectedObjectIdentity
                    || range?.total !== options.expectedTotal
                )
            ) {
                await response.body?.cancel().catch(() => undefined);
                throw new RangeRestartRequiredError('Remote file changed since the checkpoint');
            }
            if (options.expectedEtag && etag !== options.expectedEtag) {
                await response.body?.cancel().catch(() => undefined);
                throw new RangeRestartRequiredError('Remote file changed since the checkpoint');
            }
            if (options.expectedLastModified && lastModified !== options.expectedLastModified) {
                // Cloudflare may omit Last-Modified from the byte-bearing 206
                // after the validated If-Range workaround. Do not append that
                // response until an independent HEAD proves both the persisted
                // date and the exact object total. This closes the
                // old-prefix/new-suffix race while retaining real CDN resume.
                if (validatorContinuityProven && !lastModified && response.status === 206) {
                    let proof: DownloadProbe;
                    try {
                        proof = await this.probe(url, requestController.signal);
                    } catch (error) {
                        await response.body?.cancel().catch(() => undefined);
                        throw error;
                    }
                    const expectedTotal = options.expectedTotal;
                    const proofMatches = Number.isSafeInteger(expectedTotal)
                        && range?.total === expectedTotal
                        && proof.size === expectedTotal
                        && proof.lastModified === options.expectedLastModified;
                    if (!proofMatches) {
                        await response.body?.cancel().catch(() => undefined);
                        throw new RangeRestartRequiredError('Remote file changed since the checkpoint');
                    }
                    lastModified = proof.lastModified;
                    etag = proof.etag ?? etag;
                } else {
                    await response.body?.cancel().catch(() => undefined);
                    throw new RangeRestartRequiredError('Remote file changed since the checkpoint');
                }
            }

            const total = range?.total
                ?? (response.status === 206 ? undefined : numericHeader(response.headers, 'content-length'));
            const reader = response.body?.getReader();
            if (!reader) {
                await response.body?.cancel().catch(() => undefined);
                throw new Error('Streaming response body is unavailable');
            }
            let cursor = offset;
            try {
                for (;;) {
                    const { done, value } = await this.readWithStallTimeout(reader, requestController);
                    if (done) break;
                    if (!value?.byteLength) continue;
                    await onChunk({
                        bytes: value,
                        offset: cursor,
                        total,
                        etag,
                        lastModified,
                        ...(responseObject.objectIdentity ? {
                            ...responseObject,
                            sourceUrl: target.url,
                        } : {}),
                    });
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
                    ...(responseObject.objectIdentity ? {
                        ...responseObject,
                        sourceUrl: target.url,
                    } : {}),
                    acceptsRanges: response.status === 206 || /bytes/i.test(response.headers.get('accept-ranges') || ''),
                    ...(response.status === 200 && total === 0 && cursor === 0
                        ? { confirmedEmpty: true as const }
                        : {}),
                };
            } catch (error) {
                requestController.abort(error);
                await reader.cancel(error).catch(() => undefined);
                throw error;
            }
        } finally {
            options.signal?.removeEventListener('abort', forwardAbort);
        }
    }
}
