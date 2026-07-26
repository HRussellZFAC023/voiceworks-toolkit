const OFFICIAL_ASMR_API_ORIGINS = new Set([
    'https://api.asmr.one',
    'https://api.asmr-100.com',
    'https://api.asmr-200.com',
    'https://api.asmr-300.com',
]);
const TRUSTED_RAW_MEDIA_ORIGIN = 'https://raw.kiko-play-niptan.one';
const MAX_DECODE_PASSES = 16;

type OfficialMediaRoute = 'stream' | 'download';

export interface SafeMediaFetchOptions {
    maxBytes: number;
    signal?: AbortSignal;
    timeoutMs?: number;
    headers?: Record<string, string>;
}

export interface SafeMediaBlob {
    blob: Blob;
    finalUrl: string;
    headers: Headers;
    status: number;
    statusText: string;
}

export interface SafeMediaArrayBuffer {
    data: ArrayBuffer;
    finalUrl: string;
    headers: Headers;
    status: number;
    statusText: string;
}

interface SafeMediaFetchPolicy {
    url: string;
    redirect: RequestRedirect;
    acceptsFinalUrl(finalUrl: string): boolean;
}

function parseUrl(value: string): URL | null {
    try {
        return new URL(value, globalThis.location?.href || 'https://asmr.one/');
    } catch {
        return null;
    }
}

function parseIpv4(hostname: string): number[] | null {
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return null;
    const octets = hostname.split('.').map(Number);
    return octets.every(octet => octet >= 0 && octet <= 255) ? octets : null;
}

function isReservedIpv4([a, b, c]: number[]): boolean {
    return a === 0
        || a === 10
        || a === 127
        || (a === 100 && b >= 64 && b <= 127)
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 0)
        || (a === 192 && b === 88 && c === 99)
        || (a === 192 && b === 168)
        || (a === 198 && (b === 18 || b === 19))
        || (a === 198 && b === 51 && c === 100)
        || (a === 203 && b === 0 && c === 113)
        || a >= 224;
}

function isPublicIpv6(hostname: string): boolean {
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!host.includes(':') || host.includes('%')) return false;

    const halves = host.split('::');
    if (halves.length > 2) return false;
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return false;
    const segments = [
        ...left,
        ...Array.from({ length: missing }, () => '0'),
        ...right,
    ].map(segment => /^[0-9a-f]{1,4}$/.test(segment) ? Number.parseInt(segment, 16) : -1);
    if (segments.length !== 8 || segments.some(segment => segment < 0)) return false;

    const [first, second] = segments;
    if (first < 0x2000 || first > 0x3fff) return false;
    return !(first === 0x2001 && second < 0x0200)
        && !(first === 0x2001 && second === 0x0db8)
        && first !== 0x2002
        && !(first === 0x3fff && second < 0x1000);
}

function isPublicHostname(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/\.$/, '');
    if (
        !host
        || host === 'localhost'
        || host.endsWith('.localhost')
        || host.endsWith('.local')
        || host.endsWith('.lan')
        || host.endsWith('.localdomain')
        || host.endsWith('.internal')
        || host.endsWith('.home')
        || host === 'home.arpa'
        || host.endsWith('.home.arpa')
        || host.endsWith('.test')
        || host.endsWith('.invalid')
        || host.endsWith('.example')
    ) {
        return false;
    }
    const ipv4 = parseIpv4(host);
    if (ipv4) return !isReservedIpv4(ipv4);
    if (host.includes(':') || host.startsWith('[')) return isPublicIpv6(host);
    return host.includes('.');
}

export function normalizeSafeMediaUrl(value: string): string {
    const parsed = parseUrl(value);
    if (
        !parsed
        || parsed.protocol !== 'https:'
        || parsed.username !== ''
        || parsed.password !== ''
        || !isPublicHostname(parsed.hostname)
    ) {
        return '';
    }
    return parsed.toString();
}

export function normalizeSafeMediaNavigationUrl(value: string): string {
    if (value.startsWith('blob:')) {
        const parsed = parseUrl(value);
        return parsed?.protocol === 'blob:' ? parsed.toString() : '';
    }
    return normalizeSafeMediaUrl(value);
}

function fullyDecodePathSegment(segment: string): string | null {
    let decoded = segment;
    for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
        let next: string;
        try {
            next = decodeURIComponent(decoded);
        } catch {
            return null;
        }
        if (next === decoded) {
            return decoded
                && decoded !== '.'
                && decoded !== '..'
                && !/[/\\?#\u0000-\u001f\u007f]/.test(decoded)
                ? decoded
                : null;
        }
        decoded = next;
    }
    return null;
}

function parseOfficialMediaRoute(url: URL): OfficialMediaRoute | null {
    if (!OFFICIAL_ASMR_API_ORIGINS.has(url.origin)) return null;
    const match = url.pathname.match(/^\/api\/media\/(stream|download)\/(.+)$/);
    if (!match) return null;
    const segments = match[2].split('/');
    if (segments.some(segment => fullyDecodePathSegment(segment) === null)) return null;
    if (Array.from(url.searchParams.keys()).some(key => key !== 'quality')) return null;
    return match[1] as OfficialMediaRoute;
}

function sameNetworkUrl(left: URL, right: URL): boolean {
    const normalizedLeft = new URL(left);
    const normalizedRight = new URL(right);
    normalizedLeft.hash = '';
    normalizedRight.hash = '';
    return normalizedLeft.toString() === normalizedRight.toString();
}

function isTrustedOfficialFinalUrl(source: URL, route: OfficialMediaRoute, value: string): boolean {
    const normalized = normalizeSafeMediaUrl(value);
    if (!normalized) return false;
    const final = new URL(normalized);
    if (sameNetworkUrl(source, final)) return true;
    if (
        final.origin !== TRUSTED_RAW_MEDIA_ORIGIN
        || !final.pathname.startsWith(`/media/${route}/`)
        || final.hash
        || Array.from(final.searchParams.keys()).some(key => key !== 'verify')
    ) {
        return false;
    }
    const segments = final.pathname.slice(`/media/${route}/`.length).split('/');
    return segments.length > 0 && segments.every(segment => fullyDecodePathSegment(segment) !== null);
}

function getSafeMediaFetchPolicy(value: string): SafeMediaFetchPolicy | null {
    const normalized = normalizeSafeMediaUrl(value);
    if (!normalized) return null;
    const source = new URL(normalized);
    const officialRoute = parseOfficialMediaRoute(source);
    if (officialRoute) {
        return {
            url: normalized,
            redirect: 'follow',
            acceptsFinalUrl: finalUrl => isTrustedOfficialFinalUrl(source, officialRoute, finalUrl),
        };
    }
    if (
        OFFICIAL_ASMR_API_ORIGINS.has(source.origin)
        && /^\/api\/media\/(?:stream|download)(?:\/|$)/.test(source.pathname)
    ) {
        return null;
    }
    return {
        url: normalized,
        redirect: 'error',
        acceptsFinalUrl: (finalUrl) => {
            const normalizedFinal = normalizeSafeMediaUrl(finalUrl);
            return !!normalizedFinal && sameNetworkUrl(source, new URL(normalizedFinal));
        },
    };
}

function safeRequestHeaders(headers?: Record<string, string>): Headers | undefined {
    const accept = Object.entries(headers || {})
        .find(([key]) => key.toLowerCase() === 'accept')?.[1];
    return accept ? new Headers({ Accept: accept }) : undefined;
}

function validContentLength(headers: Headers, maxBytes: number): boolean {
    const raw = headers.get('content-length');
    if (raw === null) return true;
    if (!/^\d+$/.test(raw.trim())) return false;
    const length = Number(raw);
    return Number.isSafeInteger(length) && length >= 0 && length <= maxBytes;
}

interface SafeMediaChunks {
    chunks: Uint8Array<ArrayBuffer>[];
    total: number;
    finalUrl: string;
    headers: Headers;
    status: number;
    statusText: string;
}

async function readResponseChunks(
    response: Response,
    maxBytes: number,
): Promise<{ chunks: Uint8Array<ArrayBuffer>[]; total: number } | null> {
    if (!validContentLength(response.headers, maxBytes) || !response.body) {
        try {
            await response.body?.cancel();
        } catch {
            // Best-effort connection cleanup.
        }
        return null;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value?.byteLength) continue;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel('Media response exceeded byte limit');
                return null;
            }
            chunks.push(new Uint8Array(value));
        }
    } catch {
        try {
            await reader.cancel();
        } catch {
            // Ignore cleanup failures.
        }
        return null;
    } finally {
        reader.releaseLock();
    }
    if (total === 0) return null;
    return { chunks, total };
}

async function fetchSafeMediaChunks(
    value: string,
    options: SafeMediaFetchOptions,
): Promise<SafeMediaChunks | null> {
    const policy = getSafeMediaFetchPolicy(value);
    const maxBytes = Math.floor(options.maxBytes);
    if (!policy || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || options.signal?.aborted) return null;

    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const timeout = options.timeoutMs && options.timeoutMs > 0
        ? globalThis.setTimeout(() => controller.abort(new DOMException('Media request timed out', 'TimeoutError')), options.timeoutMs)
        : undefined;

    try {
        const response = await fetch(policy.url, {
            method: 'GET',
            headers: safeRequestHeaders(options.headers),
            signal: controller.signal,
            credentials: 'omit',
            mode: 'cors',
            redirect: policy.redirect,
            referrerPolicy: 'no-referrer',
        });
        if (!response.ok || !policy.acceptsFinalUrl(response.url || policy.url)) {
            try {
                await response.body?.cancel();
            } catch {
                // Best-effort connection cleanup.
            }
            return null;
        }
        const body = await readResponseChunks(response, maxBytes);
        return body
            ? {
                chunks: body.chunks,
                total: body.total,
                finalUrl: response.url || policy.url,
                headers: response.headers,
                status: response.status,
                statusText: response.statusText,
            }
            : null;
    } catch {
        return null;
    } finally {
        options.signal?.removeEventListener('abort', abort);
        if (timeout !== undefined) globalThis.clearTimeout(timeout);
    }
}

export async function fetchSafeMediaBlob(
    value: string,
    options: SafeMediaFetchOptions,
): Promise<SafeMediaBlob | null> {
    const result = await fetchSafeMediaChunks(value, options);
    return result
        ? {
            blob: new Blob(result.chunks, {
                type: result.headers.get('content-type') || 'application/octet-stream',
            }),
            finalUrl: result.finalUrl,
            headers: result.headers,
            status: result.status,
            statusText: result.statusText,
        }
        : null;
}

export async function fetchSafeMediaText(
    value: string,
    options: SafeMediaFetchOptions,
): Promise<{ text: string; finalUrl: string } | null> {
    const result = await fetchSafeMediaChunks(value, options);
    if (!result) return null;
    const decoder = new TextDecoder();
    const parts = result.chunks.map(chunk => decoder.decode(chunk, { stream: true }));
    parts.push(decoder.decode());
    return { text: parts.join(''), finalUrl: result.finalUrl };
}

export async function fetchSafeMediaArrayBuffer(
    value: string,
    options: SafeMediaFetchOptions,
): Promise<SafeMediaArrayBuffer | null> {
    const result = await fetchSafeMediaChunks(value, options);
    if (!result) return null;
    const data = new Uint8Array(result.total);
    let offset = 0;
    for (const chunk of result.chunks) {
        data.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return {
        data: data.buffer,
        finalUrl: result.finalUrl,
        headers: result.headers,
        status: result.status,
        statusText: result.statusText,
    };
}
