import type { MediaFile } from './types';
import { DEFAULT_API_SERVER } from '../../core/Constants';

const FALLBACK_ORIGIN = 'https://asmr.one';
const OFFICIAL_MEDIA_API_HOSTS = new Set([
    'api.asmr.one',
    'api.asmr-100.com',
    'api.asmr-200.com',
    'api.asmr-300.com',
]);
const FRONTEND_HOSTS = new Set(['asmr.one', 'www.asmr.one']);
type PublicMediaRoute = 'stream' | 'download';

function isBlobOrDataUrl(url: string): boolean {
    return url.startsWith('blob:') || url.startsWith('data:');
}

function isAbsoluteUrl(url: string): boolean {
    return /^https?:\/\//i.test(url) || url.startsWith('//');
}

function isSupportedMediaSource(url: string): boolean {
    if (!url) return false;
    // Let the URL parser canonicalize embedded ASCII whitespace/control
    // characters before checking the protocol. A regex-only check can miss
    // values such as `java\tscript:` that browsers normalize to javascript:.
    const parsed = parseUrl(url);
    return !!parsed && (
        parsed.protocol === 'http:'
        || parsed.protocol === 'https:'
        || parsed.protocol === 'blob:'
    );
}

function getRuntimeOrigin(): string {
    if (typeof window !== 'undefined' && window.location?.origin && window.location.origin !== 'null') {
        return window.location.origin;
    }
    return FALLBACK_ORIGIN;
}

function parseUrl(url: string): URL | null {
    try {
        return new URL(url, getRuntimeOrigin());
    } catch {
        return null;
    }
}

function isFrontendRootPlaceholder(url: string): boolean {
    const parsed = parseUrl(url);
    if (
        !parsed
        || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        || parsed.pathname !== '/'
    ) {
        return false;
    }

    return !isAbsoluteUrl(url) || FRONTEND_HOSTS.has(parsed.hostname.toLowerCase());
}

function isOfficialMediaApiHost(hostname: string): boolean {
    return OFFICIAL_MEDIA_API_HOSTS.has(hostname.toLowerCase());
}

export function resolveMediaApiBaseUrl(candidate?: string): string {
    try {
        const parsed = new URL(String(candidate || DEFAULT_API_SERVER));
        if (parsed.protocol === 'https:' && isOfficialMediaApiHost(parsed.hostname)) {
            return parsed.origin;
        }
    } catch {
        // Fall through to the maintained API default.
    }
    return DEFAULT_API_SERVER;
}

function fullyDecodeSegment(value: string): string | null {
    let decoded = value;
    for (let i = 0; i < 16; i++) {
        let next: string;
        try {
            next = decodeURIComponent(decoded);
        } catch {
            return null;
        }
        if (next === decoded) return decoded;
        decoded = next;
    }
    // Refuse inputs that never stabilize within a strict bound. This prevents
    // a multiply-decoding upstream from recovering separators or traversal.
    return null;
}

function encodeOpaquePathSegments(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed || /[?#\\\u0000-\u001f\u007f]/.test(trimmed)) return null;

    const segments = trimmed.split('/');
    if (segments.some(segment => segment === '')) return null;

    const encoded: string[] = [];
    for (const segment of segments) {
        const decoded = fullyDecodeSegment(segment);
        if (
            decoded === null
            || decoded === ''
            || decoded === '.'
            || decoded === '..'
            || /[/\\?#\u0000-\u001f\u007f]/.test(decoded)
        ) {
            return null;
        }
        encoded.push(encodeURIComponent(decoded));
    }
    return encoded.join('/');
}

/**
 * Build the host-relative media path for an opaque media hash.
 *
 * Media hashes are `<workId>/<trackIndex>` style values (see `src/api/Media.ts`),
 * so each segment is encoded individually and the `/` separators are preserved.
 * `encodeURIComponent` on the whole hash would emit `%2F`, which the host API
 * and the subtitle URL guards both reject. Returns '' for any hash that cannot
 * be represented as safe, non-traversing path segments.
 */
export function buildMediaPathFromHash(hash: string, route: PublicMediaRoute): string {
    const encoded = encodeOpaquePathSegments(hash);
    return encoded ? `/api/media/${route}/${encoded}` : '';
}

function extractRawPath(url: string): string {
    const absoluteMatch = url.match(/^(?:https?:)?\/\/[^/?#]+([^?#]*)/i);
    if (absoluteMatch) return absoluteMatch[1] || '/';
    return url.split(/[?#]/, 1)[0];
}

function canonicalizeMediaPath(path: string, route: PublicMediaRoute): string | null {
    const prefixes = [
        `/api/media/${route}/`,
        `/media/${route}/`,
        `api/media/${route}/`,
        `media/${route}/`,
    ];
    const prefix = prefixes.find(candidate => path.startsWith(candidate));
    if (!prefix) return null;
    const encoded = encodeOpaquePathSegments(path.slice(prefix.length));
    return encoded ? `/api/media/${route}/${encoded}` : '';
}

function rewriteMediaApiSource(
    url: string,
    route: PublicMediaRoute,
    apiBaseUrl?: string,
): string | null {
    if (!url || isBlobOrDataUrl(url)) return null;

    const parsed = parseUrl(url);
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return null;

    const mediaPath = canonicalizeMediaPath(extractRawPath(url), route);
    if (mediaPath === null) return null;
    if (!mediaPath) return '';

    const sourceHost = parsed.hostname.toLowerCase();
    const isRelative = !isAbsoluteUrl(url);
    if (!isRelative && !isOfficialMediaApiHost(sourceHost) && !FRONTEND_HOSTS.has(sourceHost)) {
        return null;
    }

    try {
        const rewritten = new URL(mediaPath, `${resolveMediaApiBaseUrl(apiBaseUrl)}/`);
        for (const [key, value] of parsed.searchParams) {
            if (key.toLowerCase() !== 'token') rewritten.searchParams.append(key, value);
        }
        rewritten.hash = parsed.hash;
        return rewritten.toString();
    } catch {
        return '';
    }
}

export function buildMediaStreamUrl(
    hash: string,
    item: Pick<MediaFile, 'mediaStreamUrl' | 'media_stream_url'> | undefined,
    _token: string,
    apiBaseUrl?: string,
): string {
    const sourceUrl = (item?.mediaStreamUrl || item?.media_stream_url || '').trim();
    if (
        sourceUrl
        && isSupportedMediaSource(sourceUrl)
        && !isFrontendRootPlaceholder(sourceUrl)
    ) {
        const rewritten = rewriteMediaApiSource(sourceUrl, 'stream', apiBaseUrl);
        if (rewritten !== null) return rewritten;
        return sourceUrl;
    }

    const streamPath = buildMediaPathFromHash(hash, 'stream');
    return streamPath
        ? new URL(streamPath, `${resolveMediaApiBaseUrl(apiBaseUrl)}/`).toString()
        : '';
}

export function buildMediaDownloadUrl(
    hash: string,
    item: Pick<MediaFile, 'mediaDownloadUrl' | 'media_download_url'> | undefined,
    _token: string,
    apiBaseUrl?: string,
): string {
    const sourceUrl = (item?.mediaDownloadUrl || item?.media_download_url || '').trim();
    if (sourceUrl && !isFrontendRootPlaceholder(sourceUrl)) {
        const rewritten = rewriteMediaApiSource(sourceUrl, 'download', apiBaseUrl);
        if (rewritten !== null) return rewritten;

        const parsed = parseUrl(sourceUrl);
        if (isAbsoluteUrl(sourceUrl) && parsed?.protocol === 'https:') {
            return sourceUrl.startsWith('//') ? parsed.toString() : sourceUrl;
        }
    }

    const downloadPath = buildMediaPathFromHash(hash, 'download');
    return downloadPath
        ? new URL(downloadPath, `${resolveMediaApiBaseUrl(apiBaseUrl)}/`).toString()
        : '';
}
