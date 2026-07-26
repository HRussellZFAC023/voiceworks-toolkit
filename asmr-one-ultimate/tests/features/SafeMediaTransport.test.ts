import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    fetchSafeMediaArrayBuffer,
    fetchSafeMediaBlob,
    fetchSafeMediaText,
    normalizeSafeMediaNavigationUrl,
    normalizeSafeMediaUrl,
} from '../../src/features/media/safeMediaTransport';

function response(
    finalUrl: string,
    body: BodyInit = 'safe',
    headers: Record<string, string> = {},
): Response {
    const result = new Response(body, { status: 200, headers });
    Object.defineProperty(result, 'url', { configurable: true, value: finalUrl });
    return result;
}

describe('safeMediaTransport', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('blocks mixed-content, credentialed, local, private, and reserved sources before fetch', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const unsafe = [
            'http://media.example.com/file.txt',
            'https://user:password@media.example.com/file.txt',
            'https://localhost/file.txt',
            'https://service.internal/file.txt',
            'https://nas.lan/file.txt',
            'https://router.localdomain/file.txt',
            'https://device.home.arpa/file.txt',
            'https://127.0.0.1/file.txt',
            'https://2130706433/file.txt',
            'https://10.0.0.1/file.txt',
            'https://169.254.169.254/latest/meta-data',
            'https://192.168.0.1/file.txt',
            'https://[::1]/file.txt',
            'https://[fe80::1]/file.txt',
            'https://[2001:db8::1]/file.txt',
        ];

        for (const url of unsafe) {
            expect(normalizeSafeMediaUrl(url)).toBe('');
            await expect(fetchSafeMediaText(url, { maxBytes: 1024 })).resolves.toBeNull();
        }
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('uses credentialless CORS and blocks redirects for arbitrary public HTTPS media', async () => {
        const url = 'https://cdn.example.com/subtitles.vtt';
        const fetchMock = vi.fn(async () => response(
            url,
            'WEBVTT',
            { 'content-length': '6', 'content-type': 'text/vtt' },
        ));
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchSafeMediaText(url, { maxBytes: 1024 })).resolves.toEqual({
            text: 'WEBVTT',
            finalUrl: url,
        });
        expect(fetchMock).toHaveBeenCalledWith(url, expect.objectContaining({
            credentials: 'omit',
            mode: 'cors',
            redirect: 'error',
            referrerPolicy: 'no-referrer',
        }));
    });

    it('decodes a deferred multibyte subtitle response without retaining a duplicate Blob', async () => {
        let resolveResponse!: (response: Response) => void;
        const pending = new Promise<Response>((resolve) => { resolveResponse = resolve; });
        vi.stubGlobal('fetch', vi.fn(() => pending));
        const url = 'https://subtitles.example.org/A.vtt';
        const request = fetchSafeMediaText(url, { maxBytes: 4096 });
        const result = response(url, 'WEBVTT\n\n00:00.000 --> 00:04.000\n外部字幕\n');
        resolveResponse(result);

        await expect(request).resolves.toEqual({
            text: 'WEBVTT\n\n00:00.000 --> 00:04.000\n外部字幕\n',
            finalUrl: url,
        });
    });

    it('follows only exact official one-segment media routes to their matching trusted raw route', async () => {
        const stream = 'https://api.asmr-200.com/api/media/stream/opaque-hash';
        const rawStream = 'https://raw.kiko-play-niptan.one/media/stream/opaque-hash?verify=signed';
        const download = 'https://api.asmr-200.com/api/media/download/opaque-hash';
        const rawDownload = 'https://raw.kiko-play-niptan.one/media/download/opaque-hash?verify=signed';
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(response(rawStream, 'stream'))
            .mockResolvedValueOnce(response(rawDownload, 'download'));
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchSafeMediaText(stream, { maxBytes: 1024 })).resolves.toMatchObject({
            text: 'stream',
            finalUrl: rawStream,
        });
        await expect(fetchSafeMediaText(download, { maxBytes: 1024 })).resolves.toMatchObject({
            text: 'download',
            finalUrl: rawDownload,
        });
        expect(fetchMock).toHaveBeenNthCalledWith(1, stream, expect.objectContaining({ redirect: 'follow' }));
        expect(fetchMock).toHaveBeenNthCalledWith(2, download, expect.objectContaining({ redirect: 'follow' }));
    });

    it('rejects malformed canonical media routes and unexpected redirect targets', async () => {
        const fetchMock = vi.fn(async () => response(
            'https://cdn.example.com/stolen.txt',
            'private response',
        ));
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchSafeMediaText(
            'https://api.asmr-200.com/api/media/stream/%252e%252e',
            { maxBytes: 1024 },
        )).resolves.toBeNull();
        await expect(fetchSafeMediaText(
            'https://api.asmr-200.com/api/media/stream/%253fverify%253devil',
            { maxBytes: 1024 },
        )).resolves.toBeNull();
        await expect(fetchSafeMediaText(
            'https://api.asmr-200.com/api/media/stream/%2523fragment',
            { maxBytes: 1024 },
        )).resolves.toBeNull();
        await expect(fetchSafeMediaText(
            'https://api.asmr-200.com/api/media/stream/hash?target=https://127.0.0.1',
            { maxBytes: 1024 },
        )).resolves.toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();

        await expect(fetchSafeMediaText(
            'https://api.asmr-200.com/api/media/stream/hash',
            { maxBytes: 1024 },
        )).resolves.toBeNull();
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('rejects an oversized Content-Length before reading the response body', async () => {
        const cancel = vi.fn(async () => undefined);
        const oversized = {
            ok: true,
            status: 200,
            statusText: 'OK',
            url: 'https://cdn.example.com/huge.jpg',
            headers: new Headers({ 'content-length': '65' }),
            body: { cancel },
        } as unknown as Response;
        vi.stubGlobal('fetch', vi.fn(async () => oversized));

        await expect(fetchSafeMediaBlob(
            oversized.url,
            { maxBytes: 64 },
        )).resolves.toBeNull();
        expect(cancel).toHaveBeenCalledOnce();
    });

    it('cancels an unknown-length stream as soon as its accumulated bytes exceed the cap', async () => {
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array(40));
                controller.enqueue(new Uint8Array(40));
                controller.enqueue(new Uint8Array(40));
            },
            cancel() {
                cancelled = true;
            },
        });
        vi.stubGlobal('fetch', vi.fn(async () => response(
            'https://cdn.example.com/huge.bin',
            body,
        )));

        await expect(fetchSafeMediaBlob(
            'https://cdn.example.com/huge.bin',
            { maxBytes: 64 },
        )).resolves.toBeNull();
        expect(cancelled).toBe(true);
    });

    it('returns bounded text and array-buffer representations from the same policy', async () => {
        const textUrl = 'https://cdn.example.com/file.txt';
        const pdfUrl = 'https://cdn.example.com/file.pdf';
        vi.stubGlobal('fetch', vi.fn()
            .mockResolvedValueOnce(response(textUrl, 'hello'))
            .mockResolvedValueOnce(response(pdfUrl, Uint8Array.from([1, 2, 3]))));

        await expect(fetchSafeMediaText(textUrl, { maxBytes: 32 })).resolves.toMatchObject({
            text: 'hello',
        });
        const pdf = await fetchSafeMediaArrayBuffer(pdfUrl, { maxBytes: 32 });
        expect(Array.from(new Uint8Array(pdf?.data || new ArrayBuffer(0)))).toEqual([1, 2, 3]);
    });

    it('allows safe HTTPS and local blob navigation URLs but rejects unsafe raw opens', () => {
        expect(normalizeSafeMediaNavigationUrl('https://cdn.example.com/file.mp4'))
            .toBe('https://cdn.example.com/file.mp4');
        expect(normalizeSafeMediaNavigationUrl('blob:https://asmr.one/local-id'))
            .toBe('blob:https://asmr.one/local-id');
        expect(normalizeSafeMediaNavigationUrl('http://127.0.0.1/private')).toBe('');
        expect(normalizeSafeMediaNavigationUrl('javascript:alert(1)')).toBe('');
    });
});
