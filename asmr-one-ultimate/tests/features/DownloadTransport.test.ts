import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    DownloadStallError,
    DownloadTransport,
    RangeRestartRequiredError,
} from '../../src/features/downloads/DownloadTransport';

function response(chunks: number[][], init: ResponseInit): Response {
    return new Response(new ReadableStream({
        start(controller) {
            chunks.forEach(chunk => controller.enqueue(new Uint8Array(chunk)));
            controller.close();
        },
    }), init);
}

describe('DownloadTransport', () => {
    afterEach(() => {
        localStorage.removeItem('jwt-token');
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

    it('requires a safe restart when a server ignores Range', async () => {
        const fetchMock = vi.fn().mockResolvedValue(response([[1, 2, 3]], { status: 200 }));
        await expect(new DownloadTransport(fetchMock as typeof fetch).stream(
            'https://media.example/file', 2, vi.fn(),
        )).rejects.toBeInstanceOf(RangeRestartRequiredError);
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

    it('rejects a truncated unknown-total byte range using its declared end', async () => {
        const fetchMock = vi.fn().mockResolvedValue(response([[3, 4]], {
            status: 206, headers: { 'content-range': 'bytes 2-5/*' },
        }));
        await expect(new DownloadTransport(fetchMock as typeof fetch).stream(
            'https://media.example/file', 2, vi.fn(),
        )).rejects.toThrow('Incomplete download: received 4 of 6 bytes');
    });

    it('does not confuse offset 2 with a range starting at 20', async () => {
        const fetchMock = vi.fn().mockResolvedValue(response([[1]], {
            status: 206, headers: { 'content-range': 'bytes 20-20/21' },
        }));
        await expect(new DownloadTransport(fetchMock as typeof fetch).stream(
            'https://media.example/file', 2, vi.fn(),
        )).rejects.toBeInstanceOf(RangeRestartRequiredError);
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

    it('does not retry permanent HTTP or safe-range restart failures', async () => {
        const notFound = vi.fn().mockResolvedValue(response([], { status: 404 }));
        await expect(new DownloadTransport(notFound as typeof fetch, {
            sleep: vi.fn(async () => undefined),
        }).probe('https://media.example/missing')).rejects.toThrow('HTTP 404');
        expect(notFound).toHaveBeenCalledTimes(1);

        const ignoredRange = vi.fn().mockResolvedValue(response([[1]], { status: 200 }));
        await expect(new DownloadTransport(ignoredRange as typeof fetch, {
            sleep: vi.fn(async () => undefined),
        }).stream('https://media.example/file', 2, vi.fn()))
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
