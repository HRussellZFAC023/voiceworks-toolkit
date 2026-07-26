import { describe, expect, it, vi } from 'vitest';
import type { GmResponse } from '../../src/infrastructure/HttpClient';
import {
    CLOUDFLARE_RESTRICTED_IMAGE_SHA256,
    CLOUDFLARE_RESTRICTED_IMAGE_SIZE,
    MAX_VERIFIED_IMAGE_BYTES,
    fetchVerifiedImageBlob,
    getImageResponseRejection,
    getVerifiedImageCandidates,
    isSafeRasterImageBlob,
    isKnownCloudflareRestrictionBlob,
    isVerifiedImageResponse,
} from '../../src/features/media/externalImageUtils';

function response(overrides: Partial<GmResponse> = {}): GmResponse {
    return {
        status: 200,
        statusText: 'OK',
        responseText: '',
        response: new Blob([
            Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
        ], { type: 'image/png' }),
        responseHeaders: 'content-type: image/png',
        finalUrl: 'https://img.dlsite.jp/example/sample.jpg',
        ...overrides,
    };
}

function hexBuffer(hex: string): ArrayBuffer {
    return Uint8Array.from(hex.match(/.{2}/g) || [], (byte) => Number.parseInt(byte, 16)).buffer;
}

function corsResponse(
    finalUrl: string,
    body: BodyInit = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb]),
    contentType = 'image/jpeg',
): Response {
    const result = new Response(body, {
        status: 200,
        headers: { 'content-type': contentType },
    });
    Object.defineProperty(result, 'url', { configurable: true, value: finalUrl });
    return result;
}

describe('externalImageUtils', () => {
    it('rejects the HTTP-200 Cloudflare restriction PNG by exact final URL', () => {
        const restricted = response({
            response: new Blob([new Uint8Array(CLOUDFLARE_RESTRICTED_IMAGE_SIZE)], { type: 'image/png' }),
            finalUrl: 'https://www.cloudflare-terms-of-service-abuse.com/stream.png',
        });

        expect(getImageResponseRejection(restricted)).toBe('cloudflare-restricted-placeholder');
        expect(isVerifiedImageResponse(restricted)).toBe(false);
    });

    it('accepts a non-empty image blob from a valid final URL', () => {
        const valid = response();
        expect(getImageResponseRejection(valid)).toBeNull();
        expect(isVerifiedImageResponse(valid)).toBe(true);
    });

    it('accepts the media API text/plain header only after raster magic validation', async () => {
        const mediaUrl = 'https://api.asmr-200.com/api/media/stream/1052162/319502';
        const originalFetch = globalThis.fetch;
        const request = vi.fn();
        globalThis.fetch = vi.fn()
            .mockResolvedValueOnce(corsResponse(
                mediaUrl,
                Uint8Array.from([0xff, 0xd8, 0xff, 0xdb]),
                'text/plain',
            ))
            .mockResolvedValueOnce(corsResponse(
                'https://cdn.example.com/not-an-image',
                '<!doctype html>',
                'text/plain',
            )) as typeof fetch;

        try {
            await expect(fetchVerifiedImageBlob(
                mediaUrl,
                { proxyBaseUrl: 'https://relay.example.com', request },
            )).resolves.toMatchObject({ finalUrl: mediaUrl });
            await expect(fetchVerifiedImageBlob(
                'https://cdn.example.com/not-an-image',
                { proxyBaseUrl: 'https://relay.example.com', request },
            )).resolves.toBeNull();
            expect(request).not.toHaveBeenCalled();
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('accepts a cross-realm-compatible Blob payload for raster verification', async () => {
        const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb]);
        const foreignBlob = {
            size: bytes.byteLength,
            type: 'image/jpeg',
            arrayBuffer: async () => bytes.slice().buffer,
            slice: (start = 0, end = bytes.byteLength) => {
                const slice = bytes.slice(start, end);
                return {
                    size: slice.byteLength,
                    type: 'image/jpeg',
                    arrayBuffer: async () => slice.buffer,
                    slice: () => foreignBlob,
                };
            },
        };
        expect(foreignBlob instanceof Blob).toBe(false);
        expect(isVerifiedImageResponse(response({
            response: foreignBlob,
            responseHeaders: 'content-type: image/jpeg',
        }))).toBe(true);
        await expect(isSafeRasterImageBlob(foreignBlob)).resolves.toBe(true);
    });

    it('rejects an oversized cross-realm payload before copying its bytes', async () => {
        const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
        const foreignBlob = {
            size: MAX_VERIFIED_IMAGE_BYTES + 1,
            type: 'image/jpeg',
            arrayBuffer,
            slice: () => foreignBlob,
        };
        const oversized = response({
            response: foreignBlob,
            responseHeaders: 'content-type: image/jpeg',
            finalUrl: 'https://api.asmr-200.com/oversized.jpg',
        });

        expect(getImageResponseRejection(oversized)).toBe('oversized-image-response');
        const originalFetch = globalThis.fetch;
        const sourceUrl = 'https://cdn.example.com/oversized.jpg';
        globalThis.fetch = vi.fn(async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers({ 'content-type': 'image/jpeg' }),
            url: sourceUrl,
            blob: async () => foreignBlob,
        } as unknown as Response)) as typeof fetch;
        try {
            await expect(fetchVerifiedImageBlob(
                sourceUrl,
                { proxyBaseUrl: 'https://relay.example.com', request: vi.fn() },
            )).resolves.toBeNull();
            expect(arrayBuffer).not.toHaveBeenCalled();
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('never invokes the privileged bridge for an official non-redirect image', async () => {
        const originalFetch = globalThis.fetch;
        const sourceUrl = 'https://api.asmr-200.com/cors.jpg';
        globalThis.fetch = vi.fn(async () => corsResponse(sourceUrl)) as typeof fetch;
        const request = vi.fn(async () => {
            throw new Error('GM must remain unreachable');
        });

        try {
            const verified = await fetchVerifiedImageBlob(
                sourceUrl,
                { proxyBaseUrl: 'https://relay.example.com', request },
            );
            expect(request).not.toHaveBeenCalled();
            expect(globalThis.fetch).toHaveBeenCalledTimes(1);
            expect(verified?.blob.type).toBe('image/jpeg');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('uses ordinary credentialless CORS only for an arbitrary public image host', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn(async () => new Response(
            Uint8Array.from([0xff, 0xd8, 0xff, 0xdb]),
            { status: 200, headers: { 'content-type': 'image/jpeg' } },
        )) as typeof fetch;
        const request = vi.fn(async () => response());

        try {
            const verified = await fetchVerifiedImageBlob(
                'https://cdn.example.com/public.jpg',
                { proxyBaseUrl: 'https://relay.example.com', request },
            );

            expect(request).not.toHaveBeenCalled();
            expect(globalThis.fetch).toHaveBeenCalledTimes(1);
            expect(globalThis.fetch).toHaveBeenCalledWith(
                'https://cdn.example.com/public.jpg',
                expect.objectContaining({
                    credentials: 'omit',
                    mode: 'cors',
                    redirect: 'error',
                    referrerPolicy: 'no-referrer',
                }),
            );
            expect(verified?.blob.type).toBe('image/jpeg');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('uses a bounded anonymous privileged request only for the exact no-ACAO imgbox raster host', async () => {
        const originalFetch = globalThis.fetch;
        const sourceUrl = 'https://images2.imgbox.com/c8/21/h1DhlGPW_o.png';
        globalThis.fetch = vi.fn(async () => {
            throw new TypeError('CORS blocked: no Access-Control-Allow-Origin');
        }) as typeof fetch;
        const request = vi.fn(async () => response({
            finalUrl: sourceUrl,
            response: new Blob([
                Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            ], { type: 'image/png' }),
            responseHeaders: 'content-type: image/png',
        }));

        try {
            const verified = await fetchVerifiedImageBlob(
                sourceUrl,
                { proxyBaseUrl: 'https://relay.example.com', request },
            );
            expect(verified?.blob.type).toBe('image/png');
            expect(request).toHaveBeenCalledWith(expect.objectContaining({
                url: sourceUrl,
                responseType: 'blob',
                anonymous: true,
                redirect: 'error',
                timeout: 45_000,
                onprogress: expect.any(Function),
            }));
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('retries an official media route through the privileged bridge when CORS blocks the browser', async () => {
        const originalFetch = globalThis.fetch;
        const mediaUrl = 'https://api.asmr-200.com/api/media/stream/1052162/319502';
        const rawUrl = 'https://raw.kiko-play-niptan.one/media/stream/daily/RJ01052162/image.jpg?verify=signed';
        globalThis.fetch = vi.fn(async () => {
            throw new TypeError('CORS blocked: no Access-Control-Allow-Origin');
        }) as typeof fetch;
        const request = vi.fn(async () => response({
            finalUrl: rawUrl,
            response: new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0xdb])], { type: 'image/jpeg' }),
            responseHeaders: 'content-type: image/jpeg',
        }));
        localStorage.setItem('jwt-token', 'host-session-token');

        try {
            const verified = await fetchVerifiedImageBlob(mediaUrl, {
                proxyBaseUrl: 'https://relay.example.com',
                request,
                headers: { Accept: 'image/avif,image/webp,image/*' },
            });

            expect(verified?.blob.type).toBe('image/jpeg');
            expect(verified?.finalUrl).toBe(rawUrl);
            expect(request).toHaveBeenCalledWith(expect.objectContaining({
                url: mediaUrl,
                responseType: 'blob',
                anonymous: false,
                redirect: 'follow',
                headers: {
                    Accept: 'image/avif,image/webp,image/*',
                    Authorization: 'Bearer host-session-token',
                },
            }));
        } finally {
            localStorage.removeItem('jwt-token');
            globalThis.fetch = originalFetch;
        }
    });

    it('recovers an authenticated official media image after an HTTP 401 browser response', async () => {
        const originalFetch = globalThis.fetch;
        const mediaUrl = 'https://api.asmr-100.com/api/media/stream/abc123';
        const denied = new Response('', { status: 401, statusText: 'Unauthorized' });
        Object.defineProperty(denied, 'url', { configurable: true, value: mediaUrl });
        globalThis.fetch = vi.fn(async () => denied) as typeof fetch;
        const request = vi.fn(async () => response({
            finalUrl: mediaUrl,
            response: new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0xdb])], { type: 'image/jpeg' }),
            responseHeaders: 'content-type: image/jpeg',
        }));

        try {
            await expect(fetchVerifiedImageBlob(mediaUrl, {
                proxyBaseUrl: 'https://relay.example.com',
                request,
            })).resolves.toMatchObject({ finalUrl: mediaUrl });
            expect(request).toHaveBeenCalledOnce();
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('rejects a privileged official response that lands outside the trusted raw media origin', async () => {
        const originalFetch = globalThis.fetch;
        const mediaUrl = 'https://api.asmr-200.com/api/media/stream/1052162/319502';
        globalThis.fetch = vi.fn(async () => {
            throw new TypeError('CORS blocked');
        }) as typeof fetch;
        const request = vi.fn(async () => response({
            finalUrl: 'https://www.cloudflare-terms-of-service-abuse.com/stream.png',
        }));

        try {
            await expect(fetchVerifiedImageBlob(mediaUrl, {
                proxyBaseUrl: 'https://relay.example.com',
                request,
            })).resolves.toBeNull();
            expect(request).toHaveBeenCalledOnce();
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('never sends the host session to a DLsite relay or any other image host', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn(async () => {
            throw new TypeError('CORS blocked');
        }) as typeof fetch;
        const request = vi.fn();
        localStorage.setItem('jwt-token', 'host-session-token');

        try {
            for (const url of [
                'https://img.dlsite.jp/modpub/images2/work/sample.jpg',
                'https://relay.example.com/modpub/images2/work/sample.jpg',
                'https://cdn.example.com/public.jpg',
                'https://api.asmr-200.com/statics/cover.jpg',
            ]) {
                await expect(fetchVerifiedImageBlob(url, {
                    proxyBaseUrl: 'https://relay.example.com',
                    request,
                })).resolves.toBeNull();
            }
            expect(request).not.toHaveBeenCalled();
        } finally {
            localStorage.removeItem('jwt-token');
            globalThis.fetch = originalFetch;
        }
    });

    it('never escalates another no-ACAO image host to the privileged bridge', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn(async () => {
            throw new TypeError('CORS blocked');
        }) as typeof fetch;
        const request = vi.fn();

        try {
            await expect(fetchVerifiedImageBlob(
                'https://images.example.net/public.png',
                { proxyBaseUrl: 'https://relay.example.com', request },
            )).resolves.toBeNull();
            expect(request).not.toHaveBeenCalled();
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('rejects imgbox redirects and aborts its privileged bridge at the byte cap', async () => {
        const originalFetch = globalThis.fetch;
        const sourceUrl = 'https://images2.imgbox.com/c8/21/h1DhlGPW_o.png';
        globalThis.fetch = vi.fn(async () => {
            throw new TypeError('CORS blocked');
        }) as typeof fetch;
        const redirected = vi.fn(async () => response({
            finalUrl: 'https://127.0.0.1/private.png',
        }));
        const oversized = vi.fn(async (config: {
            onprogress?: (event: { loaded: number; total: number; lengthComputable: boolean }) => void;
        }) => {
            config.onprogress?.({
                loaded: MAX_VERIFIED_IMAGE_BYTES + 1,
                total: MAX_VERIFIED_IMAGE_BYTES + 1,
                lengthComputable: true,
            });
            return response({ finalUrl: sourceUrl });
        });

        try {
            await expect(fetchVerifiedImageBlob(
                sourceUrl,
                { proxyBaseUrl: 'https://relay.example.com', request: redirected },
            )).resolves.toBeNull();
            await expect(fetchVerifiedImageBlob(
                sourceUrl,
                { proxyBaseUrl: 'https://relay.example.com', request: oversized },
            )).resolves.toBeNull();
            expect(redirected).toHaveBeenCalledOnce();
            expect(oversized).toHaveBeenCalledOnce();
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('does not request credentialed, non-HTTPS, local, private, link-local, or reserved URLs', async () => {
        const originalFetch = globalThis.fetch;
        const corsFetch = vi.fn(async () => {
            throw new Error('unsafe URL reached fetch');
        });
        globalThis.fetch = corsFetch as typeof fetch;
        const request = vi.fn(async () => response());
        const unsafeUrls = [
            'http://cdn.example.com/image.jpg',
            'https://user:pass@api.asmr-200.com/image.jpg',
            'https://localhost/image.jpg',
            'https://metadata/image.jpg',
            'https://service.internal/image.jpg',
            'https://127.0.0.1/image.jpg',
            'https://2130706433/image.jpg',
            'https://10.0.0.1/image.jpg',
            'https://100.64.0.1/image.jpg',
            'https://169.254.169.254/latest/meta-data',
            'https://172.16.0.1/image.jpg',
            'https://192.168.0.1/image.jpg',
            'https://192.88.99.1/image.jpg',
            'https://198.51.100.1/image.jpg',
            'https://203.0.113.1/image.jpg',
            'https://[::1]/image.jpg',
            'https://[fc00::1]/image.jpg',
            'https://[fe80::1]/image.jpg',
            'https://[::ffff:127.0.0.1]/image.jpg',
            'https://[2001::1]/image.jpg',
            'https://[2001:db8::1]/image.jpg',
            'https://[2002::1]/image.jpg',
            'https://[3fff::1]/image.jpg',
        ];

        try {
            for (const url of unsafeUrls) {
                await expect(fetchVerifiedImageBlob(
                    url,
                    { proxyBaseUrl: 'https://relay.example.com', request },
                )).resolves.toBeNull();
            }
            expect(request).not.toHaveBeenCalled();
            expect(corsFetch).not.toHaveBeenCalled();
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('follows the exact official media route to the known raw media origin without GM privileges', async () => {
        const originalFetch = globalThis.fetch;
        const mediaUrl = 'https://api.asmr-200.com/api/media/stream/1052162/319502';
        const rawUrl = 'https://raw.kiko-play-niptan.one/media/stream/daily/2023-05-31/RJ01052162/image.jpg?verify=signed';
        const corsFetch = vi.fn(async () => corsResponse(rawUrl));
        globalThis.fetch = corsFetch as typeof fetch;
        const request = vi.fn();

        try {
            const verified = await fetchVerifiedImageBlob(
                mediaUrl,
                { proxyBaseUrl: 'https://relay.example.com', request },
            );
            expect(verified?.finalUrl).toBe(rawUrl);
            expect(request).not.toHaveBeenCalled();
            expect(corsFetch).toHaveBeenCalledWith(mediaUrl, expect.objectContaining({
                credentials: 'omit',
                mode: 'cors',
                redirect: 'follow',
                referrerPolicy: 'no-referrer',
            }));
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('supports single-hash official media routes and direct trusted raw-media URLs without GM', async () => {
        const originalFetch = globalThis.fetch;
        const mediaUrl = 'https://api.asmr-200.com/api/media/stream/abc123';
        const redirectedRawUrl = 'https://raw.kiko-play-niptan.one/media/stream/abc123?verify=signed';
        const directRawUrl = 'https://raw.kiko-play-niptan.one/media/stream/direct/image.jpg?verify=signed';
        const corsFetch = vi.fn()
            .mockResolvedValueOnce(corsResponse(redirectedRawUrl))
            .mockResolvedValueOnce(corsResponse(directRawUrl));
        globalThis.fetch = corsFetch as typeof fetch;
        const request = vi.fn();

        try {
            await expect(fetchVerifiedImageBlob(
                mediaUrl,
                { proxyBaseUrl: 'https://relay.example.com', request },
            )).resolves.toMatchObject({ finalUrl: redirectedRawUrl });
            await expect(fetchVerifiedImageBlob(
                directRawUrl,
                { proxyBaseUrl: 'https://relay.example.com', request },
            )).resolves.toMatchObject({ finalUrl: directRawUrl });

            expect(request).not.toHaveBeenCalled();
            expect(corsFetch).toHaveBeenNthCalledWith(1, mediaUrl, expect.objectContaining({
                credentials: 'omit',
                mode: 'cors',
                redirect: 'follow',
                referrerPolicy: 'no-referrer',
            }));
            expect(corsFetch).toHaveBeenNthCalledWith(2, directRawUrl, expect.objectContaining({
                credentials: 'omit',
                mode: 'cors',
                redirect: 'error',
                referrerPolicy: 'no-referrer',
            }));
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('does not follow encoded traversal variants of the official media route', async () => {
        const originalFetch = globalThis.fetch;
        const request = vi.fn();
        const corsFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
            expect(init?.redirect).toBe('error');
            throw new TypeError('redirect blocked');
        });
        globalThis.fetch = corsFetch as typeof fetch;

        try {
            await expect(fetchVerifiedImageBlob(
                'https://api.asmr-200.com/api/media/stream/%252e%252e',
                { proxyBaseUrl: 'https://relay.example.com', request },
            )).resolves.toBeNull();
            expect(corsFetch).not.toHaveBeenCalled();
            expect(request).not.toHaveBeenCalled();
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('rejects unexpected official-media redirect targets without ever invoking GM', async () => {
        const originalFetch = globalThis.fetch;
        const mediaUrl = 'https://api.asmr-200.com/api/media/stream/1052162/319502';
        const request = vi.fn();
        globalThis.fetch = vi.fn()
            .mockResolvedValueOnce(corsResponse('https://cdn.example.com/redirected.jpg'))
            .mockResolvedValueOnce(corsResponse('https://127.0.0.1/private.jpg')) as typeof fetch;

        try {
            await expect(fetchVerifiedImageBlob(
                mediaUrl,
                { proxyBaseUrl: 'https://relay.example.com', request },
            )).resolves.toBeNull();
            await expect(fetchVerifiedImageBlob(
                mediaUrl,
                { proxyBaseUrl: 'https://relay.example.com', request },
            )).resolves.toBeNull();
            expect(request).not.toHaveBeenCalled();
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('blocks redirects for every URL outside the exact official media route', async () => {
        const originalFetch = globalThis.fetch;
        const sourceUrl = 'https://cdn.example.com/redirect.jpg';
        const corsFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
            expect(init?.redirect).toBe('error');
            throw new TypeError('redirect blocked');
        });
        globalThis.fetch = corsFetch as typeof fetch;
        const request = vi.fn();

        try {
            await expect(fetchVerifiedImageBlob(
                sourceUrl,
                { proxyBaseUrl: 'https://relay.example.com', request },
            )).resolves.toBeNull();
            expect(corsFetch).toHaveBeenCalledOnce();
            expect(request).not.toHaveBeenCalled();
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('rejects active SVG documents from the gallery blob pipeline', () => {
        const svg = response({
            response: new Blob(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], { type: 'image/svg+xml' }),
            responseHeaders: 'content-type: image/svg+xml',
            finalUrl: 'https://images.example/sample.svg',
        });

        expect(getImageResponseRejection(svg)).toBe('active-image-response');
        expect(isVerifiedImageResponse(svg)).toBe(false);
    });

    it('detects SVG bytes even when a server declares a generic blob type', async () => {
        const disguised = new Blob([
            '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>',
        ], { type: 'application/octet-stream' });

        await expect(isSafeRasterImageBlob(disguised)).resolves.toBe(false);
        await expect(isSafeRasterImageBlob(new Blob([
            Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        ], { type: 'application/octet-stream' }))).resolves.toBe(true);
    });

    it('tries maintained DLsite proxy candidates before the direct URL', () => {
        const source = 'https://img.dlsite.jp/modpub/images2/work/doujin/RJ01409000/RJ01409932_img_smp1.jpg';
        const candidates = getVerifiedImageCandidates(source, 'https://relay.example.com');

        expect(candidates[0]).toContain('https://relay.example.com/modpub/images2/work/');
        expect(candidates[0]).toContain('__host=img.dlsite.jp');
        expect(candidates.at(-1)).toBe(source);
    });

    it('does not construct candidates for an unsafe configured proxy origin', () => {
        const source = 'https://img.dlsite.jp/modpub/images2/work/sample.jpg';

        expect(getVerifiedImageCandidates(source, 'http://127.0.0.1:8787')).toEqual([source]);
        expect(getVerifiedImageCandidates(source, 'https://user:pass@relay.example.com')).toEqual([source]);
        expect(getVerifiedImageCandidates(source, '/relative-proxy')).toEqual([source]);
    });

    it('hashes only the exact-size blob and rejects the known placeholder digest', async () => {
        const digest = vi.fn(async () => hexBuffer(CLOUDFLARE_RESTRICTED_IMAGE_SHA256));
        const exactSize = new Blob([new Uint8Array(CLOUDFLARE_RESTRICTED_IMAGE_SIZE)], { type: 'image/png' });
        const otherSize = new Blob(['small'], { type: 'image/png' });
        Object.defineProperty(exactSize, 'arrayBuffer', {
            configurable: true,
            value: async () => new ArrayBuffer(CLOUDFLARE_RESTRICTED_IMAGE_SIZE),
        });

        await expect(isKnownCloudflareRestrictionBlob(exactSize, digest)).resolves.toBe(true);
        await expect(isKnownCloudflareRestrictionBlob(otherSize, digest)).resolves.toBe(false);
        expect(digest).toHaveBeenCalledTimes(1);
    });

    it('skips a restricted proxy response and returns the next verified blob', async () => {
        const originalFetch = globalThis.fetch;
        const request = vi.fn();
        const corsFetch = vi.fn()
            .mockRejectedValueOnce(new TypeError('redirect blocked'))
            .mockResolvedValueOnce(corsResponse('https://relay.example.com/sample.jpg'));
        globalThis.fetch = corsFetch as typeof fetch;

        try {
            const verified = await fetchVerifiedImageBlob(
                'https://img.dlsite.jp/sample.jpg',
                { proxyBaseUrl: 'https://relay.example.com', request },
            );
            expect(request).not.toHaveBeenCalled();
            expect(corsFetch).toHaveBeenCalledTimes(2);
            expect(verified?.blob.type).toBe('image/jpeg');
            expect(verified?.finalUrl).toBe('https://relay.example.com/sample.jpg');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('accepts a same-size payload when its URL and digest are not the known placeholder', async () => {
        const bytes = new Uint8Array(CLOUDFLARE_RESTRICTED_IMAGE_SIZE);
        bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const suspicious = response({
            finalUrl: undefined,
            response: new Blob([bytes], { type: 'image/png' }),
        });

        expect(getImageResponseRejection(suspicious)).toBeNull();
        await expect(isKnownCloudflareRestrictionBlob(
            suspicious.response as Blob,
            async () => new ArrayBuffer(32),
        )).resolves.toBe(false);

        const originalFetch = globalThis.fetch;
        const sourceUrl = 'https://cdn.example.com/same-size.png';
        globalThis.fetch = vi.fn(async () => corsResponse(
            sourceUrl,
            bytes,
            'image/png',
        )) as typeof fetch;
        try {
            const verified = await fetchVerifiedImageBlob(
                sourceUrl,
                { proxyBaseUrl: 'https://relay.example.com', request: vi.fn() },
            );
            expect(verified?.blob.size).toBe(CLOUDFLARE_RESTRICTED_IMAGE_SIZE);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});
