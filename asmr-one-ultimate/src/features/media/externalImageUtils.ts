import type { GmRequestConfig, GmResponse } from '../../infrastructure/HttpClient';

export const CLOUDFLARE_RESTRICTED_IMAGE_HOST = 'www.cloudflare-terms-of-service-abuse.com';
export const CLOUDFLARE_RESTRICTED_IMAGE_PATH = '/stream.png';
export const CLOUDFLARE_RESTRICTED_IMAGE_SIZE = 23_983;
export const CLOUDFLARE_RESTRICTED_IMAGE_SHA256 = 'e1b18d65bf8ec24d6abf8f461a87609d2a5b2783342cc2067d49c20da17ee248';

export type ImageResponseRejection =
    | 'cloudflare-restricted-placeholder'
    | 'empty-image-response'
    | 'non-image-response'
    | 'active-image-response';

export interface VerifiedImageBlob {
    blob: Blob;
    candidateUrl: string;
    finalUrl: string;
}

export type ImageRequest = (config: GmRequestConfig) => Promise<GmResponse>;

function parseUrl(value: string): URL | null {
    try {
        return new URL(value, globalThis.location?.href || 'https://asmr.one/');
    } catch {
        return null;
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
    const proxy = parseUrl(proxyBaseUrl);
    if (!source || !proxy || !isDlsiteImageUrl(source.toString())) return url;
    if (proxy.protocol !== 'https:' && proxy.protocol !== 'http:') return url;

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
    if (!(blob instanceof Blob) || blob.size <= 0) return 'empty-image-response';

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

    if (declaredType && !declaredType.startsWith('image/') && declaredType !== 'application/octet-stream') {
        return 'non-image-response';
    }

    return null;
}

export function isVerifiedImageResponse(
    response: Pick<GmResponse, 'response' | 'responseHeaders' | 'finalUrl'>,
): response is Pick<GmResponse, 'response' | 'responseHeaders' | 'finalUrl'> & { response: Blob } {
    return getImageResponseRejection(response) === null;
}

export async function isKnownCloudflareRestrictionBlob(
    blob: Blob,
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

async function readBlobPrefix(blob: Blob, length = 32): Promise<Uint8Array> {
    const slice = blob.slice(0, length);
    if (typeof slice.arrayBuffer === 'function') {
        return new Uint8Array(await slice.arrayBuffer());
    }
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
export async function isSafeRasterImageBlob(blob: Blob): Promise<boolean> {
    if (!(blob instanceof Blob) || blob.size <= 0) return false;
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
    options: {
        proxyBaseUrl: string;
        request: ImageRequest;
        signal?: AbortSignal;
        headers?: Record<string, string>;
        dlsiteHeaders?: Record<string, string>;
    },
): Promise<VerifiedImageBlob | null> {
    const candidates = getVerifiedImageCandidates(sourceUrl, options.proxyBaseUrl);

    for (const candidateUrl of candidates) {
        if (options.signal?.aborted) return null;
        if (candidateUrl.startsWith('blob:') || candidateUrl.startsWith('data:')) return null;

        try {
            const response = await options.request({
                url: candidateUrl,
                responseType: 'blob',
                signal: options.signal,
                headers: isDlsiteImageUrl(sourceUrl)
                    ? { ...options.headers, ...options.dlsiteHeaders }
                    : options.headers,
            });
            if (!isVerifiedImageResponse(response)) continue;
            if (!await isSafeRasterImageBlob(response.response)) continue;
            if (await isKnownCloudflareRestrictionBlob(response.response)) continue;

            return {
                blob: response.response,
                candidateUrl,
                finalUrl: String(response.finalUrl || candidateUrl),
            };
        } catch (error) {
            if (options.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
                return null;
            }
        }
    }

    return null;
}
