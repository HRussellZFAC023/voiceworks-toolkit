import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    DownloadRequestTimeoutError,
    DownloadStallError,
    DownloadTransport,
    RangeRestartRequiredError,
} from '../../src/features/downloads/DownloadTransport';
import { createDownloadResumeFingerprint } from '../../src/features/downloads/DownloadResumeFingerprint';

function response(chunks: number[][], init: ResponseInit): Response {
    return new Response(new ReadableStream({
        start(controller) {
            chunks.forEach(chunk => controller.enqueue(new Uint8Array(chunk)));
            controller.close();
        },
    }), init);
}

function responseAt(url: string, chunks: number[][], init: ResponseInit): Response {
    const result = response(chunks, init);
    Object.defineProperty(result, 'url', { configurable: true, value: url });
    return result;
}

describe('DownloadTransport', () => {
    afterEach(() => {
        localStorage.removeItem('jwt-token');
    });

    it('does not bind the fetch receiver to the transport instance', async () => {
        let receiver: unknown = Symbol('not-called');
        const fetchMock = vi.fn(function (this: unknown) {
            receiver = this;
            return Promise.resolve(response([[1]], {
                status: 200,
                headers: { 'content-length': '1' },
            }));
        }) as unknown as typeof fetch;

        await new DownloadTransport(fetchMock).stream('https://media.example/file', 0, vi.fn());

        expect(receiver).toBeUndefined();
    });

    it('never sends the host JWT to cross-origin manifest media', async () => {
        localStorage.setItem('jwt-token', 'host-secret');
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(response([], { status: 200 }))
            .mockResolvedValueOnce(response([[1]], {
                status: 200,
                headers: { 'content-length': '1' },
            }));
        const transport = new DownloadTransport(fetchMock as typeof fetch);

        await transport.probe('//cdn.example/media/file.mp3');
        await transport.stream('https://untrusted.example/media/file.mp3', 0, vi.fn());

        expect(new Headers(fetchMock.mock.calls[0][1]?.headers).has('Authorization')).toBe(false);
        expect(new Headers(fetchMock.mock.calls[1][1]?.headers).has('Authorization')).toBe(false);
        expect(fetchMock.mock.calls[0]).toEqual(expect.arrayContaining([
            'https://cdn.example/media/file.mp3',
            expect.objectContaining({ credentials: 'omit' }),
        ]));
        expect(fetchMock.mock.calls[1]).toEqual(expect.arrayContaining([
            'https://untrusted.example/media/file.mp3',
            expect.objectContaining({ credentials: 'omit' }),
        ]));
    });

    it('keeps an absent Content-Length indeterminate instead of reporting zero bytes', async () => {
        const result = await new DownloadTransport(vi.fn().mockResolvedValue(
            response([], { status: 200 }),
        ) as typeof fetch).probe('https://media.example/file');

        expect(result.size).toBeUndefined();
    });

    it('retains authentication for relative and trusted ASMR API-origin requests', async () => {
        localStorage.setItem('jwt-token', 'host-secret');
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(response([], { status: 200 }))
            .mockResolvedValueOnce(response([[1]], {
                status: 200,
                headers: { 'content-length': '1' },
            }));
        const transport = new DownloadTransport(fetchMock as typeof fetch);

        await transport.probe('/api/media/check/hash');
        await transport.stream(
            'https://api.asmr-200.com/api/media/stream/hash', 0, vi.fn(),
        );

        expect(fetchMock.mock.calls[0][0]).toBe('https://api.asmr-200.com/api/media/check/hash');
        expect(fetchMock.mock.calls[0][1]?.credentials).toBe('include');
        expect(fetchMock.mock.calls[1][1]?.credentials).toBe('include');
        expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Authorization'))
            .toBe('Bearer host-secret');
        expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get('Authorization'))
            .toBe('Bearer host-secret');
    });

    it('streams a validated range from its persisted offset', async () => {
        const fetchMock = vi.fn().mockResolvedValue(response([[3, 4], [5]], {
            status: 206,
            headers: {
                'content-range': 'bytes 2-4/5',
                etag: 'same',
                'accept-ranges': 'bytes',
            },
        }));
        const seen: Array<{ offset: number; bytes: number[] }> = [];

        const result = await new DownloadTransport(fetchMock as typeof fetch).stream(
            'https://media.example/file',
            2,
            chunk => { seen.push({ offset: chunk.offset, bytes: [...chunk.bytes] }); },
            { expectedEtag: 'same' },
        );

        expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ Range: 'bytes=2-', 'If-Range': 'same' });
        expect(seen).toEqual([
            { offset: 2, bytes: [3, 4] },
            { offset: 4, bytes: [5] },
        ]);
        expect(result.size).toBe(5);
    });

    it('requires a safe restart before requesting a validator-less persisted range', async () => {
        const fetchMock = vi.fn();
        const chunks = vi.fn();

        await expect(new DownloadTransport(fetchMock as typeof fetch).stream(
            'https://media.example/file',
            2,
            chunks,
            { expectedTotal: 5 },
        )).rejects.toBeInstanceOf(RangeRestartRequiredError);

        expect(fetchMock).not.toHaveBeenCalled();
        expect(chunks).not.toHaveBeenCalled();
    });

    it('resumes the trusted raw media object with persisted source, total, and Backblaze mtime', async () => {
        const url = 'https://raw.kiko-play-niptan.one/media/download/object/track.wav?verify=token';
        const objectIdentity = 'https://raw.kiko-play-niptan.one/media/download/object/track.wav';
        const objectVersion = '1783777782.543';
        const fetchMock = vi.fn().mockResolvedValue(responseAt(url, [[3, 4], [5]], {
            status: 206,
            headers: {
                'content-range': 'bytes 2-4/5',
                'content-length': '3',
                'accept-ranges': 'bytes',
                'x-bz-info-mtime': objectVersion,
            },
        }));
        const chunks = vi.fn();

        const result = await new DownloadTransport(fetchMock as typeof fetch).stream(
            url,
            2,
            chunks,
            {
                expectedObjectVersion: objectVersion,
                expectedObjectIdentity: objectIdentity,
                expectedSourceUrl: url,
                expectedTotal: 5,
            },
        );

        expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ Range: 'bytes=2-' });
        expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('If-Range');
        expect(chunks).toHaveBeenCalledTimes(2);
        expect(result).toMatchObject({
            size: 5,
            objectVersion,
            objectIdentity,
            sourceUrl: url,
            acceptsRanges: true,
        });
    });

    it('resumes a validator-less real-sized FLAC only after matching local and remote boundary samples', async () => {
        const sourceUrl = 'https://api.asmr-200.com/api/media/download/flac-hash';
        const rawUrl = 'https://raw.kiko-play-niptan.one/media/download/object/track.flac?verify=token';
        const objectIdentity = 'https://raw.kiko-play-niptan.one/media/download/object/track.flac';
        const total = 201_474_412;
        const offset = total - 1;
        const prefix = new Uint8Array(64 * 1024);
        prefix.set([0x66, 0x4c, 0x61, 0x43]); // fLaC
        const boundary = new Uint8Array(64 * 1024).fill(0x5a);
        const localSamples = new Map<number, Uint8Array>([
            [0, prefix],
            [offset - boundary.byteLength, boundary],
        ]);
        const fingerprint = await createDownloadResumeFingerprint(
            offset,
            async sampleOffset => localSamples.get(sampleOffset)!,
        );
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(responseAt(rawUrl, [[...prefix]], {
                status: 206,
                headers: { 'content-range': `bytes 0-${prefix.byteLength - 1}/${total}` },
            }))
            .mockResolvedValueOnce(responseAt(rawUrl, [[...boundary]], {
                status: 206,
                headers: {
                    'content-range': `bytes ${offset - boundary.byteLength}-${offset - 1}/${total}`,
                },
            }))
            .mockResolvedValueOnce(responseAt(rawUrl, [[0x01]], {
                status: 206,
                headers: { 'content-range': `bytes ${offset}-${offset}/${total}` },
            }));
        const chunks = vi.fn();

        const result = await new DownloadTransport(fetchMock as typeof fetch).stream(
            sourceUrl,
            offset,
            chunks,
            {
                expectedObjectIdentity: objectIdentity,
                expectedSourceUrl: sourceUrl,
                expectedResumeFingerprint: fingerprint,
                expectedTotal: total,
            },
        );

        expect(fetchMock).toHaveBeenNthCalledWith(1, sourceUrl, expect.objectContaining({
            headers: expect.objectContaining({ Range: `bytes=0-${prefix.byteLength - 1}` }),
        }));
        expect(fetchMock).toHaveBeenNthCalledWith(2, sourceUrl, expect.objectContaining({
            headers: expect.objectContaining({
                Range: `bytes=${offset - boundary.byteLength}-${offset - 1}`,
            }),
        }));
        expect(fetchMock).toHaveBeenNthCalledWith(3, sourceUrl, expect.objectContaining({
            headers: expect.objectContaining({ Range: `bytes=${offset}-` }),
        }));
        expect(chunks).toHaveBeenCalledWith(expect.objectContaining({
            offset,
            objectIdentity,
            sourceUrl,
        }));
        expect(result).toMatchObject({ size: total, objectIdentity, sourceUrl });
    });

    it('rejects a validator-less resume before append when a remote boundary sample changed', async () => {
        const sourceUrl = 'https://api.asmr-200.com/api/media/download/flac-hash';
        const rawUrl = 'https://raw.kiko-play-niptan.one/media/download/object/track.flac';
        const total = 8;
        const offset = 4;
        const original = new Uint8Array([1, 2, 3, 4]);
        const fingerprint = await createDownloadResumeFingerprint(
            offset,
            async () => original,
        );
        const fetchMock = vi.fn().mockResolvedValue(responseAt(rawUrl, [[1, 2, 3, 9]], {
            status: 206,
            headers: { 'content-range': 'bytes 0-3/8' },
        }));
        const chunks = vi.fn();

        await expect(new DownloadTransport(fetchMock as typeof fetch).stream(
            sourceUrl,
            offset,
            chunks,
            {
                expectedObjectIdentity: rawUrl,
                expectedSourceUrl: sourceUrl,
                expectedResumeFingerprint: fingerprint,
                expectedTotal: total,
            },
        )).rejects.toBeInstanceOf(RangeRestartRequiredError);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(chunks).not.toHaveBeenCalled();
    });

    it('aborts a validator-less resume when a fingerprint proof body stalls', async () => {
        const sourceUrl = 'https://api.asmr-200.com/api/media/download/flac-hash';
        const rawUrl = 'https://raw.kiko-play-niptan.one/media/download/object/track.flac';
        const fingerprint = await createDownloadResumeFingerprint(
            4,
            async () => new Uint8Array([1, 2, 3, 4]),
        );
        const cancelled = vi.fn();
        const body = new ReadableStream<Uint8Array>({
            pull: () => new Promise(() => undefined),
            cancel: cancelled,
        });
        const stalled = new Response(body, {
            status: 206,
            headers: { 'content-range': 'bytes 0-3/8' },
        });
        Object.defineProperty(stalled, 'url', { configurable: true, value: rawUrl });
        let expire!: () => void;
        const transport = new DownloadTransport(
            vi.fn().mockResolvedValue(stalled) as typeof fetch,
            {
                stallTimeoutMs: 10,
                requestTimeoutMs: 0,
                setTimer: callback => {
                    expire = callback;
                    return 1 as unknown as ReturnType<typeof setTimeout>;
                },
                clearTimer: vi.fn(),
            },
        );
        const streaming = transport.stream(sourceUrl, 4, vi.fn(), {
            expectedObjectIdentity: rawUrl,
            expectedSourceUrl: sourceUrl,
            expectedResumeFingerprint: fingerprint,
            expectedTotal: 8,
        });

        await vi.waitFor(() => expect(expire).toBeTypeOf('function'));
        expire();

        await expect(streaming).rejects.toBeInstanceOf(DownloadStallError);
        expect(cancelled).toHaveBeenCalledOnce();
    });

    it('rejects a trusted raw media range when Backblaze object metadata changes', async () => {
        const url = 'https://raw.kiko-play-niptan.one/media/download/object/track.wav';
        const cancelled = vi.fn();
        const body = new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(new Uint8Array([3, 4, 5])); },
            cancel: cancelled,
        });
        const changed = new Response(body, {
            status: 206,
            headers: {
                'content-range': 'bytes 2-4/5',
                'x-bz-info-mtime': '1783777783.000',
            },
        });
        Object.defineProperty(changed, 'url', { configurable: true, value: url });
        const chunks = vi.fn();

        await expect(new DownloadTransport(
            vi.fn().mockResolvedValue(changed) as typeof fetch,
        ).stream(url, 2, chunks, {
            expectedObjectVersion: '1783777782.543',
            expectedObjectIdentity: url,
            expectedSourceUrl: url,
            expectedTotal: 5,
        })).rejects.toBeInstanceOf(RangeRestartRequiredError);

        expect(chunks).not.toHaveBeenCalled();
        expect(cancelled).toHaveBeenCalledOnce();
    });

    it('retries a date-validated Cloudflare resume without If-Range and still validates the range', async () => {
        const lastModified = 'Thu, 23 Jul 2026 18:21:43 GMT';
        const cancelled = vi.fn();
        const ignoredBody = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array([1, 2, 3, 4, 5]));
            },
            cancel: cancelled,
        });
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(ignoredBody, {
                status: 200,
                headers: { 'content-length': '5', 'last-modified': lastModified },
            }))
            .mockResolvedValueOnce(response([[3, 4], [5]], {
                status: 206,
                headers: {
                    'content-range': 'bytes 2-4/5',
                    'accept-ranges': 'bytes',
                },
            }))
            .mockResolvedValueOnce(response([], {
                status: 200,
                headers: {
                    'content-length': '5',
                    'last-modified': lastModified,
                    'accept-ranges': 'bytes',
                },
            }));
        const chunks = vi.fn();

        const result = await new DownloadTransport(fetchMock as typeof fetch).stream(
            'https://media.example/file',
            2,
            chunks,
            { expectedLastModified: lastModified, expectedTotal: 5 },
        );

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
            Range: 'bytes=2-',
            'If-Range': lastModified,
        });
        expect(fetchMock.mock.calls[1][1].headers).toMatchObject({ Range: 'bytes=2-' });
        expect(fetchMock.mock.calls[1][1].headers).not.toHaveProperty('If-Range');
        expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: 'HEAD' });
        expect(cancelled).toHaveBeenCalledTimes(1);
        expect(chunks).toHaveBeenCalledTimes(2);
        expect(result.size).toBe(5);
        expect(result.lastModified).toBe(lastModified);
    });

    it('does not append a headerless resumed range when its HEAD continuity proof mismatches', async () => {
        const lastModified = 'Thu, 23 Jul 2026 18:21:43 GMT';
        const cancelledRange = vi.fn();
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(response([[1, 2, 3, 4, 5]], {
                status: 200,
                headers: { 'content-length': '5', 'last-modified': lastModified },
            }))
            .mockResolvedValueOnce(new Response(new ReadableStream({
                start(controller) {
                    controller.enqueue(new Uint8Array([3, 4, 5]));
                },
                cancel: cancelledRange,
            }), {
                status: 206,
                headers: {
                    'content-range': 'bytes 2-4/5',
                    'accept-ranges': 'bytes',
                },
            }))
            .mockResolvedValueOnce(response([], {
                status: 200,
                headers: {
                    'content-length': '5',
                    'last-modified': 'Thu, 23 Jul 2026 20:00:00 GMT',
                },
            }));
        const chunks = vi.fn();

        await expect(new DownloadTransport(fetchMock as typeof fetch).stream(
            'https://media.example/file',
            2,
            chunks,
            { expectedLastModified: lastModified, expectedTotal: 5 },
        )).rejects.toBeInstanceOf(RangeRestartRequiredError);

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(chunks).not.toHaveBeenCalled();
        expect(cancelledRange).toHaveBeenCalledTimes(1);
    });

    it('cancels the pending resumed body when its HEAD continuity proof fails', async () => {
        const lastModified = 'Thu, 23 Jul 2026 18:21:43 GMT';
        const cancelledRange = vi.fn();
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(response([[1, 2, 3, 4, 5]], {
                status: 200,
                headers: { 'content-length': '5', 'last-modified': lastModified },
            }))
            .mockResolvedValueOnce(new Response(new ReadableStream({
                start(controller) {
                    controller.enqueue(new Uint8Array([3, 4, 5]));
                },
                cancel: cancelledRange,
            }), {
                status: 206,
                headers: {
                    'content-range': 'bytes 2-4/5',
                    'accept-ranges': 'bytes',
                },
            }))
            .mockRejectedValueOnce(new TypeError('HEAD network failure'));
        const chunks = vi.fn();

        await expect(new DownloadTransport(fetchMock as typeof fetch, {
            maxAttempts: 1,
        }).stream(
            'https://media.example/file',
            2,
            chunks,
            { expectedLastModified: lastModified, expectedTotal: 5 },
        )).rejects.toThrow('HEAD network failure');

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(chunks).not.toHaveBeenCalled();
        expect(cancelledRange).toHaveBeenCalledTimes(1);
    });

    it('rejects a resumed range that omits the persisted date without prior continuity proof', async () => {
        const lastModified = 'Thu, 23 Jul 2026 18:21:43 GMT';
        const fetchMock = vi.fn().mockResolvedValue(response([[3, 4], [5]], {
            status: 206,
            headers: {
                'content-range': 'bytes 2-4/5',
                'accept-ranges': 'bytes',
            },
        }));
        const chunks = vi.fn();

        await expect(new DownloadTransport(fetchMock as typeof fetch).stream(
            'https://media.example/file',
            2,
            chunks,
            { expectedLastModified: lastModified },
        )).rejects.toBeInstanceOf(RangeRestartRequiredError);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(chunks).not.toHaveBeenCalled();
    });

    it('accepts an exact offset-at-EOF 416 only after proving persisted validator continuity', async () => {
        const lastModified = 'Thu, 23 Jul 2026 18:21:43 GMT';
        const cancelledFull = vi.fn();
        const cancelledRange = vi.fn();
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(new ReadableStream({
                start(controller) { controller.enqueue(new Uint8Array([1, 2, 3, 4, 5])); },
                cancel: cancelledFull,
            }), {
                status: 200,
                headers: { 'content-length': '5', 'last-modified': lastModified },
            }))
            .mockResolvedValueOnce(new Response(new ReadableStream({
                cancel: cancelledRange,
            }), {
                status: 416,
                headers: { 'content-range': 'bytes */5', 'content-length': '0' },
            }));
        const chunks = vi.fn();

        const result = await new DownloadTransport(fetchMock as typeof fetch).stream(
            'https://media.example/file',
            5,
            chunks,
            { expectedLastModified: lastModified, expectedTotal: 5 },
        );

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
            Range: 'bytes=5-',
            'If-Range': lastModified,
        });
        expect(fetchMock.mock.calls[1][1].headers).toMatchObject({ Range: 'bytes=5-' });
        expect(fetchMock.mock.calls[1][1].headers).not.toHaveProperty('If-Range');
        expect(cancelledFull).toHaveBeenCalledTimes(1);
        expect(cancelledRange).toHaveBeenCalledTimes(1);
        expect(chunks).not.toHaveBeenCalled();
        expect(result).toEqual({
            size: 5,
            lastModified,
            acceptsRanges: true,
            confirmedCompleteAtOffset: true,
        });
    });

    it('rejects a matching offset-at-EOF 416 without validator continuity', async () => {
        const cancelled = vi.fn();
        const fetchMock = vi.fn().mockResolvedValue(new Response(new ReadableStream({
            cancel: cancelled,
        }), {
            status: 416,
            headers: { 'content-range': 'bytes */5' },
        }));

        await expect(new DownloadTransport(fetchMock as typeof fetch).stream(
            'https://media.example/file',
            5,
            vi.fn(),
            {
                expectedLastModified: 'Thu, 23 Jul 2026 18:21:43 GMT',
                expectedTotal: 5,
            },
        )).rejects.toBeInstanceOf(RangeRestartRequiredError);

        expect(cancelled).toHaveBeenCalledTimes(1);
    });

    it('rejects a validator-proven 416 whose remote total differs from the checkpoint', async () => {
        const lastModified = 'Thu, 23 Jul 2026 18:21:43 GMT';
        const cancelledRange = vi.fn();
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(response([[1, 2, 3, 4, 5]], {
                status: 200,
                headers: { 'content-length': '5', 'last-modified': lastModified },
            }))
            .mockResolvedValueOnce(new Response(new ReadableStream({
                cancel: cancelledRange,
            }), {
                status: 416,
                headers: { 'content-range': 'bytes */6' },
            }));

        await expect(new DownloadTransport(fetchMock as typeof fetch).stream(
            'https://media.example/file',
            5,
            vi.fn(),
            { expectedLastModified: lastModified, expectedTotal: 5 },
        )).rejects.toBeInstanceOf(RangeRestartRequiredError);

        expect(cancelledRange).toHaveBeenCalledTimes(1);
    });

    it('requires a safe restart when a server ignores Range', async () => {
        const cancelled = vi.fn();
        const fetchMock = vi.fn().mockResolvedValue(new Response(new ReadableStream({
            start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
            cancel: cancelled,
        }), { status: 200 }));
        await expect(new DownloadTransport(fetchMock as typeof fetch).stream(
            'https://media.example/file', 2, vi.fn(), { expectedEtag: 'same' },
        )).rejects.toBeInstanceOf(RangeRestartRequiredError);
        expect(cancelled).toHaveBeenCalledTimes(1);
    });

    it('rejects truncated responses before marking a file complete', async () => {
        const fetchMock = vi.fn().mockResolvedValue(response([[1, 2]], {
            status: 200,
            headers: { 'content-length': '3' },
        }));
        await expect(new DownloadTransport(fetchMock as typeof fetch).stream(
            'https://media.example/file', 0, vi.fn(),
        )).rejects.toThrow('Incomplete download');
    });

    it('cancels the response stream when the destination rejects a chunk', async () => {
        const cancelled = vi.fn();
        const destinationError = new DOMException('disk full', 'QuotaExceededError');
        const fetchMock = vi.fn().mockResolvedValue(new Response(new ReadableStream({
            start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
            cancel: cancelled,
        }), {
            status: 200,
            headers: { 'content-length': '3' },
        }));

        await expect(new DownloadTransport(fetchMock as typeof fetch).stream(
            'https://media.example/file',
            0,
            async () => { throw destinationError; },
        )).rejects.toBe(destinationError);

        expect(cancelled).toHaveBeenCalledTimes(1);
        expect(cancelled).toHaveBeenCalledWith(destinationError);
    });

    it('marks an explicit zero-length full response as a proven empty file', async () => {
        const result = await new DownloadTransport(vi.fn().mockResolvedValue(
            response([], { status: 200, headers: { 'content-length': '0' } }),
        ) as typeof fetch).stream('https://media.example/empty.txt', 0, vi.fn());

        expect(result).toMatchObject({
            size: 0,
            confirmedEmpty: true,
        });
    });

    it('rejects a truncated unknown-total byte range using its declared end', async () => {
        const fetchMock = vi.fn().mockResolvedValue(response([[3, 4]], {
            status: 206, headers: { 'content-range': 'bytes 2-5/*', etag: 'same' },
        }));
        await expect(new DownloadTransport(fetchMock as typeof fetch).stream(
            'https://media.example/file', 2, vi.fn(), { expectedEtag: 'same' },
        )).rejects.toThrow('Incomplete download: received 4 of 6 bytes');
    });

    it('does not confuse offset 2 with a range starting at 20', async () => {
        const cancelled = vi.fn();
        const fetchMock = vi.fn().mockResolvedValue(new Response(new ReadableStream({
            start(controller) { controller.enqueue(new Uint8Array([1])); },
            cancel: cancelled,
        }), {
            status: 206,
            headers: { 'content-range': 'bytes 20-20/21', etag: 'same' },
        }));
        await expect(new DownloadTransport(fetchMock as typeof fetch).stream(
            'https://media.example/file', 2, vi.fn(), { expectedEtag: 'same' },
        )).rejects.toBeInstanceOf(RangeRestartRequiredError);
        expect(cancelled).toHaveBeenCalledTimes(1);
    });

    it('cancels an error response body before surfacing the HTTP failure', async () => {
        const cancelled = vi.fn();
        const fetchMock = vi.fn().mockResolvedValue(new Response(new ReadableStream({
            cancel: cancelled,
        }), { status: 404, statusText: 'Not Found' }));

        await expect(new DownloadTransport(fetchMock as typeof fetch, {
            maxAttempts: 1,
        }).stream('https://media.example/missing', 0, vi.fn())).rejects.toThrow('HTTP 404');

        expect(cancelled).toHaveBeenCalledTimes(1);
    });

    it('retries transient status failures before exposing any body bytes', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(response([], { status: 503, headers: { 'retry-after': '2' } }))
            .mockResolvedValueOnce(response([[1]], { status: 200, headers: { 'content-length': '1' } }));
        const sleep = vi.fn(async () => undefined);
        const chunks = vi.fn();

        await new DownloadTransport(fetchMock as typeof fetch, {
            sleep, random: () => 0, maxAttempts: 3,
        }).stream('https://media.example/file', 0, chunks);

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledWith(2_000);
        expect(chunks).toHaveBeenCalledTimes(1);
    });

    it('bounds and retries a request that never establishes a response', async () => {
        const timers: Array<() => void> = [];
        const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => {
                    reject(init.signal?.reason ?? new DOMException('aborted', 'AbortError'));
                }, { once: true });
            }));
        const sleep = vi.fn(async () => undefined);
        const transport = new DownloadTransport(fetchMock as typeof fetch, {
            maxAttempts: 2,
            requestTimeoutMs: 10,
            sleep,
            setTimer: callback => {
                timers.push(callback);
                return timers.length as unknown as ReturnType<typeof setTimeout>;
            },
            clearTimer: vi.fn(),
        });
        const probing = transport.probe('https://media.example/hangs');

        await vi.waitFor(() => expect(timers).toHaveLength(1));
        timers.shift()?.();
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(timers).toHaveLength(1));
        timers.shift()?.();

        await expect(probing).rejects.toBeInstanceOf(DownloadRequestTimeoutError);
        expect(sleep).toHaveBeenCalledTimes(1);
    });

    it('does not retry permanent HTTP or safe-range restart failures', async () => {
        const notFound = vi.fn().mockResolvedValue(response([], { status: 404 }));
        await expect(new DownloadTransport(notFound as typeof fetch, {
            sleep: vi.fn(async () => undefined),
        }).probe('https://media.example/missing')).rejects.toThrow('HTTP 404');
        expect(notFound).toHaveBeenCalledTimes(1);

        const ignoredRange = vi.fn().mockResolvedValue(response([[1]], { status: 200 }));
        await expect(new DownloadTransport(ignoredRange as typeof fetch, {
            sleep: vi.fn(async () => undefined),
        }).stream('https://media.example/file', 2, vi.fn(), { expectedEtag: 'same' }))
            .rejects.toBeInstanceOf(RangeRestartRequiredError);
        expect(ignoredRange).toHaveBeenCalledTimes(1);
    });

    it('does not retry an aborted request', async () => {
        const controller = new AbortController();
        controller.abort();
        const aborted = new DOMException('stopped', 'AbortError');
        const fetchMock = vi.fn().mockRejectedValue(aborted);
        const sleep = vi.fn(async () => undefined);

        await expect(new DownloadTransport(fetchMock as typeof fetch, { sleep }).probe(
            'https://media.example/file', controller.signal,
        )).rejects.toBe(aborted);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
    });

    it('cancels a stalled body read and clears its inactivity timer', async () => {
        const cancelled = vi.fn();
        const body = new ReadableStream<Uint8Array>({
            pull: () => new Promise(() => undefined),
            cancel: cancelled,
        });
        const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));
        let expire!: () => void;
        const timerToken = 7 as unknown as ReturnType<typeof setTimeout>;
        const setTimer = vi.fn((callback: () => void) => { expire = callback; return timerToken; });
        const clearTimer = vi.fn();
        const streaming = new DownloadTransport(fetchMock as typeof fetch, {
            stallTimeoutMs: 10,
            requestTimeoutMs: 0,
            setTimer,
            clearTimer,
        }).stream('https://media.example/file', 0, vi.fn());

        await vi.waitFor(() => expect(setTimer).toHaveBeenCalledTimes(1));
        expire();

        await expect(streaming).rejects.toBeInstanceOf(DownloadStallError);
        expect(cancelled).toHaveBeenCalledTimes(1);
        expect(clearTimer).toHaveBeenCalledWith(timerToken);
    });
});
