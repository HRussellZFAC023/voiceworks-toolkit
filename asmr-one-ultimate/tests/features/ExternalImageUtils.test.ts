import { describe, expect, it, vi } from 'vitest';
import type { GmResponse } from '../../src/infrastructure/HttpClient';
import {
    CLOUDFLARE_RESTRICTED_IMAGE_SHA256,
    CLOUDFLARE_RESTRICTED_IMAGE_SIZE,
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
        const candidates = getVerifiedImageCandidates(source, 'https://relay.example');

        expect(candidates[0]).toContain('https://relay.example/modpub/images2/work/');
        expect(candidates[0]).toContain('__host=img.dlsite.jp');
        expect(candidates.at(-1)).toBe(source);
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
        const request = vi.fn()
            .mockResolvedValueOnce(response({
                finalUrl: 'https://www.cloudflare-terms-of-service-abuse.com/stream.png',
            }))
            .mockResolvedValueOnce(response({
                finalUrl: 'https://relay.example/sample.jpg',
                response: new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0xdb])], { type: 'image/jpeg' }),
                responseHeaders: 'content-type: image/jpeg',
            }));

        const verified = await fetchVerifiedImageBlob(
            'https://img.dlsite.jp/sample.jpg',
            { proxyBaseUrl: 'https://relay.example', request },
        );

        expect(request).toHaveBeenCalledTimes(2);
        expect(verified?.blob.type).toBe('image/jpeg');
        expect(verified?.finalUrl).toBe('https://relay.example/sample.jpg');
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

        const request = vi.fn(async () => suspicious);
        const verified = await fetchVerifiedImageBlob(
            'https://images.example/same-size.png',
            { proxyBaseUrl: 'https://relay.example', request },
        );
        expect(verified?.blob).toBe(suspicious.response);
    });
});
