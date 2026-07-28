import type { GmRequestConfig, GmResponse } from '../../infrastructure/HttpClient';
import { readHostAuthToken } from '../../core/hostAuthToken';
import {
    fetchSafeMediaBlob,
    getOfficialMediaRequestPolicy,
    normalizeSafeMediaUrl,
    type SafeMediaFailureReason,
} from './safeMediaTransport';

export const CLOUDFLARE_RESTRICTED_IMAGE_HOST = 'www.cloudflare-terms-of-service-abuse.com';
export const CLOUDFLARE_RESTRICTED_IMAGE_PATH = '/stream.png';
export const CLOUDFLARE_RESTRICTED_IMAGE_SIZE = 23_983;
export const CLOUDFLARE_RESTRICTED_IMAGE_SHA256 = 'e1b18d65bf8ec24d6abf8f461a87609d2a5b2783342cc2067d49c20da17ee248';
export const MAX_VERIFIED_IMAGE_BYTES = 64 * 1024 * 1024;
const TRUSTED_NO_CORS_IMAGE_ORIGIN = 'https://images2.imgbox.com';

export type ImageResponseRejection =
    | 'cloudflare-restricted-placeholder'
    | 'empty-image-response'
    | 'oversized-image-response'
    | 'non-image-response'
    | 'active-image-response';

export interface VerifiedImageBlob {
    blob: Blob;
    candidateUrl: string;
    finalUrl: string;
}

export type ImageRequest = (config: GmRequestConfig) => Promise<GmResponse>;

interface CrossRealmBlob {
    readonly size: number;
    readonly type?: string;
    arrayBuffer(): Promise<ArrayBuffer>;
    slice(start?: number, end?: number, contentType?: string): CrossRealmBlob;
}

type BlobLike = Blob | CrossRealmBlob;

function isBlobLike(value: unknown): value is BlobLike {
    if (value instanceof Blob) return value.size >= 0;
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<CrossRealmBlob>;
    return Number.isFinite(candidate.size)
        && Number(candidate.size) >= 0
        && typeof candidate.arrayBuffer === 'function'
        && typeof candidate.slice === 'function';
}

async function normalizeBlob(blob: BlobLike): Promise<Blob> {
    if (blob instanceof Blob) return blob;
    return new Blob([await blob.arrayBuffer()], { type: String(blob.type || '') });
}

interface VerifiedImageRequestOptions {
    proxyBaseUrl: string;
    /**
     * Privileged userscript bridge, used only after the ordinary browser
     * transport fails, and only for the official ASMR media origins or the
     * exact imgbox raster allowlist. Every other host stays on credentialless
     * CORS with no privileged retry.
     */
    request: ImageRequest;
    /** @deprecated Other image requests remain ordinary credentialless CORS. */
    allowCorsFallback?: boolean;
    signal?: AbortSignal;
    headers?: Record<string, string>;
    dlsiteHeaders?: Record<string, string>;
}

/**
 * Failures that mean the browser never received a readable answer. A blocked
 * final URL or a refused body was a deliberate rejection, so those must not be
 * retried through the privileged bridge.
 */
const PRIVILEGED_RETRY_FAILURES: ReadonlySet<SafeMediaFailureReason> = new Set<SafeMediaFailureReason>([
    'transport-error',
    'http-error',
]);

async function normalizeVerifiedRaster(response: GmResponse): Promise<Blob | null> {
    if (!isVerifiedImageResponse(response)) return null;
    if (!await isSafeRasterImageBlob(response.response)) return null;
    if (await isKnownCloudflareRestrictionBlob(response.response)) return null;
    const blob = await normalizeBlob(response.response);
    return await isSafeRasterImageBlob(blob) ? blob : null;
}

function parseUrl(value: string): URL | null {
    try {
        return new URL(value, globalThis.location?.href || 'https://asmr.one/');
    } catch {
        return null;
    }
}

function parseValidatedProxyUrl(proxyBaseUrl: string): URL | null {
    try {
        // Proxies are configuration, not page content: require an explicit
        // absolute URL rather than resolving a relative value against the host.
        const absolute = new URL(proxyBaseUrl);
        const normalized = normalizeSafeMediaUrl(absolute.toString());
        const parsed = normalized ? new URL(normalized) : null;
        if (!parsed || parsed.search || parsed.hash) return null;
        return parsed;
    } catch {
        return null;
    }
}

function isTrustedNoCorsImageUrl(value: string): boolean {
    const normalized = normalizeSafeMediaUrl(value);
    if (!normalized) return false;
    const parsed = new URL(normalized);
    return parsed.origin === TRUSTED_NO_CORS_IMAGE_ORIGIN
        && /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|webp)$/i.test(parsed.pathname);
}

function isSameNetworkUrl(left: string, right: string): boolean {
    const normalizedLeft = normalizeSafeMediaUrl(left);
    const normalizedRight = normalizeSafeMediaUrl(right);
    if (!normalizedLeft || !normalizedRight) return false;
    const leftUrl = new URL(normalizedLeft);
    const rightUrl = new URL(normalizedRight);
    leftUrl.hash = '';
    rightUrl.hash = '';
    return leftUrl.toString() === rightUrl.toString();
}

interface PrivilegedImagePolicy {
    url: string;
    redirect: 'follow' | 'error';
    /** Official ASMR media may carry the host session; foreign rasters stay anonymous. */
    anonymous: boolean;
    headers: Record<string, string>;
    /** Managers that never report a final URL are only trusted when redirects are blocked. */
    requiresFinalUrl: boolean;
    acceptsFinalUrl(finalUrl: string): boolean;
}

/**
 * Authorization for the official ASMR media API only. The token travels in a
 * request header on the privileged (CORS-exempt) bridge, never in a URL.
 */
function getOfficialMediaAuthHeaders(): Record<string, string> {
    const token = readHostAuthToken();
    if (token) return { Authorization: `Bearer ${token}` };
    return {};
}

function resolvePrivilegedImagePolicy(candidateUrl: string): PrivilegedImagePolicy | null {
    const official = getOfficialMediaRequestPolicy(candidateUrl);
    if (official) {
        return {
            url: official.url,
            redirect: official.redirect === 'follow' ? 'follow' : 'error',
            anonymous: false,
            headers: getOfficialMediaAuthHeaders(),
            // The API legitimately redirects to the trusted raw-media origin,
            // so a missing final URL is read as "no redirect happened" and is
            // still validated against the same policy below.
            requiresFinalUrl: false,
            acceptsFinalUrl: official.acceptsFinalUrl,
        };
    }

    if (isTrustedNoCorsImageUrl(candidateUrl)) {
        const normalized = normalizeSafeMediaUrl(candidateUrl);
        return {
            url: normalized,
            redirect: 'error',
            anonymous: true,
            headers: {},
            requiresFinalUrl: true,
            acceptsFinalUrl: finalUrl => isTrustedNoCorsImageUrl(finalUrl)
                && isSameNetworkUrl(normalized, finalUrl),
        };
    }

    return null;
}

async function requestPrivilegedImage(
    candidateUrl: string,
    options: VerifiedImageRequestOptions,
): Promise<GmResponse | null> {
    const policy = resolvePrivilegedImagePolicy(candidateUrl);
    if (!policy || options.signal?.aborted) return null;

    const controller = new AbortController();
    let exceededLimit = false;
    const abort = () => controller.abort(options.signal?.reason);
    const accept = Object.entries(options.headers || {})
        .find(([key]) => key.toLowerCase() === 'accept')?.[1];
    const headers: Record<string, string> = {
        ...(accept ? { Accept: accept } : {}),
        ...policy.headers,
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();

    try {
        const response = await options.request({
            url: policy.url,
            responseType: 'blob',
            timeout: 45_000,
            anonymous: policy.anonymous,
            redirect: policy.redirect,
            signal: controller.signal,
            headers: Object.keys(headers).length > 0 ? headers : undefined,
            onprogress: ({ loaded, total, lengthComputable }) => {
                if (
                    loaded > MAX_VERIFIED_IMAGE_BYTES
                    || (lengthComputable && total > MAX_VERIFIED_IMAGE_BYTES)
                ) {
                    exceededLimit = true;
                    controller.abort();
                }
            },
        });
        const reportedFinalUrl = String(response.finalUrl || '');
        if (exceededLimit || (policy.requiresFinalUrl && !reportedFinalUrl)) return null;
        if (!policy.acceptsFinalUrl(reportedFinalUrl || policy.url)) return null;
        return response;
    } catch {
        return null;
    } finally {
        options.signal?.removeEventListener('abort', abort);
    }
}

export function normalizeImageUrl(url: string): string {
    if (!url) return '';
    const withProtocol = url.startsWith('//') ? `https:${url}` : url;
    const parsed = parseUrl(withProtocol);
    if (!parsed) return withProtocol;
    parsed.searchParams.delete('_r');
    parsed.searchParams.delete('_recover');
    return parsed.toString();
}

export function isDlsiteImageUrl(url: string): boolean {
    const host = parseUrl(url)?.hostname.toLowerCase() || '';
    return host === 'dlsite.com'
        || host.endsWith('.dlsite.com')
        || host === 'dlsite.jp'
        || host.endsWith('.dlsite.jp');
}

export function buildDlsiteProxyImageUrl(
    url: string,
    proxyBaseUrl: string,
    preserveHost = true,
): string {
    const source = parseUrl(url);
    const proxy = parseValidatedProxyUrl(proxyBaseUrl);
    if (!source || !proxy || !isDlsiteImageUrl(source.toString())) return url;

    const params = new URLSearchParams(source.search);
    const sourceHost = source.hostname.toLowerCase();
    if (preserveHost && sourceHost !== 'www.dlsite.com') {
        params.set('__host', sourceHost);
    }
    const query = params.toString();
    return `${proxy.toString().replace(/\/+$/, '')}${source.pathname}${query ? `?${query}` : ''}`;
}

/**
 * Return image candidates in safety order. DLsite images always use the
 * maintained/configured Japan relay before a direct request, because a direct
 * HTTP 200 may redirect to Cloudflare's restriction PNG.
 */
export function getVerifiedImageCandidates(url: string, proxyBaseUrl: string): string[] {
    const normalized = normalizeImageUrl(url);
    if (!normalized) return [];
    if (normalized.startsWith('blob:') || normalized.startsWith('data:')) return [normalized];
    if (!normalizeSafeMediaUrl(normalized)) return [];

    const candidates = isDlsiteImageUrl(normalized)
        ? [
            buildDlsiteProxyImageUrl(normalized, proxyBaseUrl, true),
            buildDlsiteProxyImageUrl(normalized, proxyBaseUrl, false),
            normalized,
        ]
        : [normalized];

    return candidates.filter((candidate, index) => !!candidate && candidates.indexOf(candidate) === index);
}

export function getImageResponseRejection(
    response: Pick<GmResponse, 'response' | 'responseHeaders' | 'finalUrl'>,
): ImageResponseRejection | null {
    const finalUrl = String(response.finalUrl || '');
    const final = parseUrl(finalUrl);
    const finalHost = final?.hostname.toLowerCase().replace(/\.$/, '') || '';
    const finalPath = final?.pathname.toLowerCase() || '';

    // Primary signal: GM_xmlhttpRequest reports the post-redirect URL. The
    // Cloudflare placeholder is a valid HTTP-200 image/png, so <img>.onerror
    // and MIME checks cannot detect it.
    if (
        (finalHost === CLOUDFLARE_RESTRICTED_IMAGE_HOST
            || finalHost === CLOUDFLARE_RESTRICTED_IMAGE_HOST.replace(/^www\./, ''))
        && (finalPath === CLOUDFLARE_RESTRICTED_IMAGE_PATH || finalPath.endsWith('/stream.png'))
    ) {
        return 'cloudflare-restricted-placeholder';
    }

    const blob = response.response;
    if (!isBlobLike(blob) || blob.size <= 0) return 'empty-image-response';
    if (blob.size > MAX_VERIFIED_IMAGE_BYTES) return 'oversized-image-response';

    const headerType = String(response.responseHeaders || '')
        .match(/(?:^|\r?\n)content-type:\s*([^;\r\n]+)/i)?.[1]
        ?.trim()
        .toLowerCase() || '';
    const blobType = String(blob.type || '').toLowerCase();
    const declaredType = blobType || headerType;

    // SVG is active document content when a blob URL is opened in a new tab.
    // Keep the gallery/lightbox pipeline passive rather than granting an SVG
    // document the page's blob origin.
    if (declaredType === 'image/svg+xml') return 'active-image-response';

    // The deployed ASMR media API serves raster bytes as text/plain. This is
    // safe to admit here because normalizeVerifiedRaster still requires a
    // positive passive-raster magic-byte match before creating a blob URL.
    if (declaredType
        && !declaredType.startsWith('image/')
        && declaredType !== 'application/octet-stream'
        && declaredType !== 'text/plain') {
        return 'non-image-response';
    }

    return null;
}

export function isVerifiedImageResponse(
    response: Pick<GmResponse, 'response' | 'responseHeaders' | 'finalUrl'>,
): response is Pick<GmResponse, 'response' | 'responseHeaders' | 'finalUrl'> & { response: BlobLike } {
    return getImageResponseRejection(response) === null;
}

export async function isKnownCloudflareRestrictionBlob(
    blob: BlobLike,
    digest: (data: ArrayBuffer) => Promise<ArrayBuffer> = async (data) => {
        if (!globalThis.crypto?.subtle) return new ArrayBuffer(0);
        return globalThis.crypto.subtle.digest('SHA-256', data);
    },
): Promise<boolean> {
    // Hashing every multi-megabyte gallery image would be wasteful. The exact
    // known byte length gates the digest to the tiny restriction asset only.
    if (blob.size !== CLOUDFLARE_RESTRICTED_IMAGE_SIZE) return false;
    try {
        const hash = await digest(await blob.arrayBuffer());
        if (hash.byteLength === 0) return false;
        const hex = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
        return hex === CLOUDFLARE_RESTRICTED_IMAGE_SHA256;
    } catch {
        return false;
    }
}

async function readBlobPrefix(blob: BlobLike, length = 32): Promise<Uint8Array> {
    const slice = blob.slice(0, length);
    if (typeof slice.arrayBuffer === 'function') {
        return new Uint8Array(await slice.arrayBuffer());
    }
    if (!(slice instanceof Blob)) return new Uint8Array();
    return new Promise<Uint8Array>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error || new Error('Blob read failed'));
        reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
        reader.readAsArrayBuffer(slice);
    });
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
    return String.fromCharCode(...bytes.slice(start, start + length));
}

/** Positive magic-byte allowlist for passive raster formats used by the UI. */
export async function isSafeRasterImageBlob(blob: BlobLike): Promise<boolean> {
    if (!isBlobLike(blob) || blob.size <= 0) return false;
    try {
        const bytes = await readBlobPrefix(blob);
        if (bytes.length >= 8
            && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
                .every((value, index) => bytes[index] === value)) return true; // PNG/APNG
        if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true; // JPEG
        if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6))) return true;
        if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return true;
        if (bytes.length >= 2 && ascii(bytes, 0, 2) === 'BM') return true;
        if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') {
            const brands = ascii(bytes, 8, Math.min(24, bytes.length - 8));
            if (/(?:avif|avis|heic|heix|mif1|msf1)/.test(brands)) return true;
        }
        return false;
    } catch {
        return false;
    }
}

export async function fetchVerifiedImageBlob(
    sourceUrl: string,
    options: VerifiedImageRequestOptions,
): Promise<VerifiedImageBlob | null> {
    const candidates = getVerifiedImageCandidates(sourceUrl, options.proxyBaseUrl);

    for (const candidateUrl of candidates) {
        if (options.signal?.aborted) return null;
        if (candidateUrl.startsWith('blob:') || candidateUrl.startsWith('data:')) return null;

        const failures: SafeMediaFailureReason[] = [];
        const result = await fetchSafeMediaBlob(candidateUrl, {
            maxBytes: MAX_VERIFIED_IMAGE_BYTES,
            signal: options.signal,
            timeoutMs: 45_000,
            headers: options.headers,
            onFailure: reason => failures.push(reason),
        });
        let response: GmResponse | null = null;
        if (result) {
            const responseHeaders: string[] = [];
            result.headers.forEach((value, key) => responseHeaders.push(`${key}: ${value}`));
            response = {
                status: result.status,
                statusText: result.statusText,
                responseText: '',
                response: result.blob,
                responseHeaders: responseHeaders.join('\r\n'),
                finalUrl: result.finalUrl,
            };
        } else if (failures.every(reason => PRIVILEGED_RETRY_FAILURES.has(reason))) {
            // The browser could not read an answer at all (missing CORS headers
            // or an authenticated 4xx). Retry through the privileged bridge for
            // the allowlisted origins only.
            response = await requestPrivilegedImage(candidateUrl, options);
        }
        if (!response) continue;
        const blob = await normalizeVerifiedRaster(response);
        if (!blob) continue;

        return {
            blob,
            candidateUrl,
            finalUrl: String(response.finalUrl || candidateUrl),
        };
    }

    return null;
}
