import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error The deployed Worker intentionally remains plain JavaScript.
import worker from '../../proxy-worker/asmr-api-proxy.js';

function envWithObject(body = new TextEncoder().encode('[1]')) {
    const object = {
        body,
        size: body.byteLength,
        httpEtag: '"etag-1"',
        httpMetadata: { contentType: 'application/json' },
    };
    return {
        SEMANTIC_INDEX: {
            get: vi.fn(async () => object),
            head: vi.fn(async () => object),
        },
    };
}

describe('semantic baseline R2 routes', () => {
    it('serves only the exact manifest route with revalidation headers', async () => {
        const env = envWithObject();
        const response = await worker.fetch(new Request('https://worker.test/semantic-index/manifest.json', {
            headers: { Origin: 'https://www.asmr.one' },
        }), env);

        expect(response.status).toBe(200);
        expect(response.headers.get('etag')).toBe('"etag-1"');
        expect(response.headers.get('cache-control')).toContain('must-revalidate');
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
        expect(response.headers.get('access-control-expose-headers')).toContain('ETag');
        expect(env.SEMANTIC_INDEX.get).toHaveBeenCalledWith('semantic-index/manifest.json');
    });

    it('serves immutable content-addressed objects and supports HEAD/304', async () => {
        const sha = 'a'.repeat(64);
        const env = envWithObject();
        const head = await worker.fetch(new Request(`https://worker.test/semantic-index/objects/${sha}.bin.gz`, {
            method: 'HEAD', headers: { 'If-None-Match': '"different"' },
        }), env);
        expect(head.status).toBe(200);
        expect(head.headers.get('cache-control')).toContain('immutable');
        expect(head.headers.get('content-type')).toBe('application/octet-stream');
        expect(head.headers.get('content-encoding')).toBeNull();
        expect(await head.text()).toBe('');
        expect(env.SEMANTIC_INDEX.head).toHaveBeenCalledWith(`semantic-index/objects/${sha}.bin.gz`);

        const notModified = await worker.fetch(new Request(`https://worker.test/semantic-index/objects/${sha}.bin.gz`, {
            headers: { 'If-None-Match': '"etag-1"' },
        }), env);
        expect(notModified.status).toBe(304);
    });

    it('rejects traversal, non-hash keys, and missing bindings without proxying', async () => {
        const env = envWithObject();
        await expect(worker.fetch(new Request('https://worker.test/semantic-index/objects/%2e%2e%2fsecret'), env))
            .resolves.toMatchObject({ status: 404 });
        await expect(worker.fetch(new Request('https://worker.test/semantic-index/objects/not-a-hash.json'), env))
            .resolves.toMatchObject({ status: 404 });
        await expect(worker.fetch(new Request('https://worker.test/semantic-index/manifest.json'), {}))
            .resolves.toMatchObject({ status: 503 });
        expect(env.SEMANTIC_INDEX.get).not.toHaveBeenCalled();
    });

    it('allows conditional cross-origin preflights', async () => {
        const response = await worker.fetch(new Request('https://worker.test/semantic-index/manifest.json', {
            method: 'OPTIONS',
            headers: { Origin: 'https://www.asmr.one', 'Access-Control-Request-Headers': 'if-none-match' },
        }), {});
        expect(response.status).toBe(204);
        expect(response.headers.get('access-control-allow-headers')).toContain('If-None-Match');
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
    });
});

describe('API proxy language negotiation', () => {
    it('forwards a normalized Chinese Accept-Language to the restricted upstream', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}'));
        await worker.fetch(new Request('https://worker.test/api/works', {
            headers: { 'Accept-Language': 'zh-CN, zh;q=0.9, en;q=0.7' },
        }), {});

        const [, init] = fetchSpy.mock.calls[0];
        expect(fetchSpy.mock.calls[0][0]).toBe('https://api.asmr-200.com/api/works');
        expect(new Headers(init?.headers).get('Accept-Language')).toBe('zh-CN, zh;q=0.9, en;q=0.7');
        fetchSpy.mockRestore();
    });

    it('falls back to Japanese for missing or invalid language input', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
        await worker.fetch(new Request('https://worker.test/api/works'), {});
        await worker.fetch(new Request('https://worker.test/api/works', {
            headers: { 'Accept-Language': 'zh-CN;q=2, not valid' },
        }), {});

        for (const [, init] of fetchSpy.mock.calls) {
            expect(new Headers(init?.headers).get('Accept-Language')).toBe('ja');
        }
        fetchSpy.mockRestore();
    });
});
