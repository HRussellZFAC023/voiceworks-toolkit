import { describe, expect, it, vi } from 'vitest';
import { DownloadTransport, RangeRestartRequiredError } from '../../src/features/downloads/DownloadTransport';

function response(chunks: number[][], init: ResponseInit): Response {
    return new Response(new ReadableStream({
        start(controller) {
            chunks.forEach(chunk => controller.enqueue(new Uint8Array(chunk)));
            controller.close();
        },
    }), init);
}

describe('DownloadTransport', () => {
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
});
