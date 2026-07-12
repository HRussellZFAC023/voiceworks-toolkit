import type { MediaFile } from './types';

const FALLBACK_ORIGIN = 'https://asmr.one';

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

function isTrustedAsmrHost(hostname: string): boolean {
    const host = hostname.toLowerCase();
    return host === 'asmr.one' || host === 'www.asmr.one' || host.endsWith('.asmr.one');
}

function hasTokenQuery(url: string): boolean {
    const parsed = parseUrl(url);
    if (!parsed) {
        return /(?:\?|&)token=/.test(url);
    }
    return parsed.searchParams.has('token');
}

function ensureLeadingSlash(path: string): string {
    return path.startsWith('/') ? path : `/${path}`;
}

function normalizeLocalStreamPath(hash: string): string {
    if (hash.includes('/')) {
        if (hash.startsWith('/api/') || hash.startsWith('/media/')) {
            return hash;
        }
        if (hash.startsWith('api/') || hash.startsWith('media/')) {
            return ensureLeadingSlash(hash);
        }
        return `/api/media/stream/${hash}`;
    }
    return `/api/media/stream/${hash}`;
}

function appendTokenToUrl(url: string, token: string): string {
    if (!token || isBlobOrDataUrl(url) || hasTokenQuery(url)) return url;

    const parsed = parseUrl(url);
    if (!parsed) return url;

    const isApiPath = parsed.pathname.startsWith('/api/')
        || parsed.pathname.startsWith('/media/');
    if (!isApiPath) return url;

    const isAbsolute = isAbsoluteUrl(url);
    if (isAbsolute) {
        const currentOrigin = getRuntimeOrigin();
        const current = parseUrl(currentOrigin);
        const currentHost = current?.hostname.toLowerCase() || '';
        const targetHost = parsed.hostname.toLowerCase();
        const isSameHost = currentHost !== '' && targetHost === currentHost;
        if (!isSameHost && !isTrustedAsmrHost(targetHost)) return url;
    }

    parsed.searchParams.set('token', token);
    const hasProtocolRelativePrefix = url.startsWith('//');
    if (isAbsolute) {
        if (hasProtocolRelativePrefix) {
            return `//${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
        }
        return parsed.toString();
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

export function buildMediaStreamUrl(
    hash: string,
    item: Pick<MediaFile, 'mediaStreamUrl' | 'media_stream_url'> | undefined,
    token: string,
): string {
    const sourceUrl = (item?.mediaStreamUrl || item?.media_stream_url || '').trim();
    if (sourceUrl && isSupportedMediaSource(sourceUrl)) {
        return appendTokenToUrl(sourceUrl, token);
    }
    return appendTokenToUrl(normalizeLocalStreamPath(hash), token);
}
