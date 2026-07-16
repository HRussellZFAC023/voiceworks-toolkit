import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error The deployed Worker intentionally remains plain JavaScript.
import worker from '../../proxy-worker/asmr-api-proxy.js';

const BASE_ID = '11111111-1111-4111-8111-111111111111';
const SUBMITTED_ID = '22222222-2222-4222-8222-222222222222';
const PRIVATE_ID = '33333333-3333-4333-8333-333333333333';
const MISSING_ID = '44444444-4444-4444-8444-444444444444';
const generatedUuid = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;

interface StoredObject {
    bytes: Uint8Array;
    etag: string;
    httpMetadata: { contentType?: string };
    customMetadata: Record<string, string>;
}

function bytes(value: string | Uint8Array): Uint8Array {
    return typeof value === 'string' ? new TextEncoder().encode(value) : value;
}

class FakeR2Bucket {
    readonly objects = new Map<string, StoredObject>();
    readonly putCalls: Array<{ key: string; options: Record<string, unknown> }> = [];
    pageSize = 1000;

    constructor(initial: Record<string, string> = {}) {
        for (const [key, value] of Object.entries(initial)) this.seed(key, value);
    }

    seed(key: string, value: string, customMetadata: Record<string, string> = {}) {
        const body = bytes(value);
        this.objects.set(key, {
            bytes: body,
            etag: `etag-${body.byteLength}-${key}`,
            httpMetadata: { contentType: 'application/json' },
            customMetadata,
        });
    }

    descriptor(key: string, value: StoredObject) {
        return {
            key,
            size: value.bytes.byteLength,
            etag: value.etag,
            httpEtag: `"${value.etag}"`,
            httpMetadata: value.httpMetadata,
            customMetadata: value.customMetadata,
        };
    }

    async head(key: string) {
        const value = this.objects.get(key);
        return value ? this.descriptor(key, value) : null;
    }

    async get(key: string) {
        const value = this.objects.get(key);
        if (!value) return null;
        return {
            ...this.descriptor(key, value),
            body: new Response(new TextDecoder().decode(value.bytes)).body,
        };
    }

    async list(options: { prefix?: string; cursor?: string; limit?: number }) {
        const keys = Array.from(this.objects.keys())
            .filter((key) => key.startsWith(options.prefix || ''))
            .sort();
        const start = options.cursor ? Number(options.cursor) : 0;
        const size = Math.min(options.limit || 1000, this.pageSize);
        const selected = keys.slice(start, start + size);
        const next = start + selected.length;
        return {
            objects: selected.map((key) => this.descriptor(key, this.objects.get(key)!)),
            truncated: next < keys.length,
            ...(next < keys.length ? { cursor: String(next) } : {}),
        };
    }

    async put(key: string, value: string | Uint8Array, options: Record<string, any>) {
        this.putCalls.push({ key, options });
        const createOnly = options?.onlyIf instanceof Headers
            ? options.onlyIf.get('If-None-Match') === '*'
            : options?.onlyIf?.etagDoesNotMatch === '*';
        if (createOnly && this.objects.has(key)) return null;
        this.seed(
            key,
            typeof value === 'string' ? value : new TextDecoder().decode(value),
            options?.customMetadata || {},
        );
        return this.head(key);
    }
}

class FakeEdgeCache {
    readonly objects = new Map<string, { body: ArrayBuffer; init: ResponseInit }>();
    readonly match = vi.fn(async (request: Request) => {
        const value = this.objects.get(request.url);
        return value ? new Response(value.body.slice(0), value.init) : undefined;
    });
    readonly put = vi.fn(async (request: Request, response: Response) => {
        this.objects.set(request.url, {
            body: await response.arrayBuffer(),
            init: { status: response.status, statusText: response.statusText, headers: new Headers(response.headers) },
        });
    });
    readonly delete = vi.fn(async (request: Request) => this.objects.delete(request.url));
}

function summary(id: string, name: string) {
    return {
        id,
        name,
        userName: 'catalog-user',
        worksCount: 1,
        coverUrl: 'https://example.test/cover.jpg',
        tags: ['Whisper'],
        latestWorkId: 'RJ123456',
    };
}

function catalog() {
    return JSON.stringify({
        version: 1,
        generatedAt: '2026-07-15T00:00:00.000Z',
        playlists: [summary(BASE_ID, 'Maintained playlist')],
    });
}

function submissionRecord(id = SUBMITTED_ID) {
    return JSON.stringify({
        version: 1,
        verifiedAt: '2026-07-15T01:00:00.000Z',
        playlist: summary(id, 'Submitted playlist'),
    });
}

function env(bucket: FakeR2Bucket, allowed = true) {
    return {
        SEMANTIC_INDEX: bucket,
        COMMUNITY_SUBMISSION_RATE_LIMITER: { limit: vi.fn(async (_input: { key: string }) => ({ success: allowed })) },
    };
}

function post(id: string, body: unknown = { id }, headers: Record<string, string> = {}) {
    return new Request('https://worker.test/community-playlists/submissions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'CF-Connecting-IP': '203.0.113.7',
            'User-Agent': 'Catalog Test 123',
            ...headers,
        },
        body: JSON.stringify(body),
    });
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('community playlist catalog R2 route', () => {
    it('streams the maintained catalog with public revalidation and HEAD/304 support', async () => {
        const bucket = new FakeR2Bucket({ 'community-playlists/catalog.json': catalog() });
        const runtime = env(bucket);
        const response = await worker.fetch(new Request('https://worker.test/community-playlists/catalog.json'), runtime);

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ version: 1, playlists: [{ id: BASE_ID }] });
        expect(response.headers.get('cache-control')).toContain('must-revalidate');
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
        const etag = response.headers.get('etag')!;

        const head = await worker.fetch(new Request('https://worker.test/community-playlists/catalog.json', {
            method: 'HEAD',
        }), runtime);
        expect(head.status).toBe(200);
        expect(await head.text()).toBe('');
        expect(head.headers.get('content-length')).toBe(String(bytes(catalog()).byteLength));

        const notModified = await worker.fetch(new Request('https://worker.test/community-playlists/catalog.json', {
            headers: { 'If-None-Match': etag },
        }), runtime);
        expect(notModified.status).toBe(304);
    });

    it('paginates, bounds, validates, and merges deterministic submission objects', async () => {
        const malformedId = '00000000-0000-4000-8000-000000000000';
        const mismatchedId = '99999999-9999-4999-9999-999999999999';
        const bucket = new FakeR2Bucket({
            'community-playlists/catalog.json': catalog(),
            [`community-playlists/submissions/${SUBMITTED_ID}.json`]: submissionRecord(),
            [`community-playlists/submissions/${BASE_ID}.json`]: submissionRecord(BASE_ID),
            [`community-playlists/submissions/${malformedId}.json`]: '{"not":"a record"}',
            [`community-playlists/submissions/${mismatchedId}.json`]: submissionRecord(SUBMITTED_ID),
            'community-playlists/submissions/not-a-uuid.json': submissionRecord(),
        });
        bucket.pageSize = 1;
        const runtime = env(bucket);
        const response = await worker.fetch(new Request('https://worker.test/community-playlists/catalog.json'), runtime);
        const body = await response.json() as { generatedAt: string; playlists: Array<{ id: string }> };

        expect(response.status).toBe(200);
        expect(body.generatedAt).toBe('2026-07-15T01:00:00.000Z');
        expect(body.playlists.map((playlist) => playlist.id)).toEqual([BASE_ID, SUBMITTED_ID]);
        expect((body.playlists[0] as { name?: string }).name).toBe('Maintained playlist');
        expect(response.headers.get('etag')).toMatch(/^"[a-f0-9]{64}"$/);

        const notModified = await worker.fetch(new Request('https://worker.test/community-playlists/catalog.json', {
            headers: { 'If-None-Match': response.headers.get('etag')! },
        }), runtime);
        expect(notModified.status).toBe(304);
    });

    it('allows POST preflights but rejects unsupported exact-route methods', async () => {
        const preflight = await worker.fetch(new Request('https://worker.test/community-playlists/submissions', {
            method: 'OPTIONS',
        }), {});
        expect(preflight.status).toBe(204);
        expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');

        const rejected = await worker.fetch(new Request('https://worker.test/community-playlists/catalog.json', {
            method: 'POST', body: '{}',
        }), {});
        expect(rejected.status).toBe(405);
        expect(rejected.headers.get('allow')).toContain('HEAD');
    });

    it('serves repeated GET, HEAD, and conditional requests from a short-lived edge cache', async () => {
        const bucket = new FakeR2Bucket({ 'community-playlists/catalog.json': catalog() });
        const listSpy = vi.spyOn(bucket, 'list');
        const getSpy = vi.spyOn(bucket, 'get');
        const edge = new FakeEdgeCache();
        vi.stubGlobal('caches', { default: edge });
        const runtime = env(bucket);

        const first = await worker.fetch(new Request('https://worker.test/community-playlists/catalog.json'), runtime);
        const etag = first.headers.get('etag')!;
        expect((await first.json() as { playlists: unknown[] }).playlists).toHaveLength(1);
        expect(first.headers.get('cache-control')).toContain('max-age=60');

        const second = await worker.fetch(new Request('https://worker.test/community-playlists/catalog.json'), runtime);
        expect(second.status).toBe(200);
        expect((await second.json() as { playlists: unknown[] }).playlists).toHaveLength(1);
        const head = await worker.fetch(new Request('https://worker.test/community-playlists/catalog.json', { method: 'HEAD' }), runtime);
        expect(head.status).toBe(200);
        expect(await head.text()).toBe('');
        const conditional = await worker.fetch(new Request('https://worker.test/community-playlists/catalog.json', {
            headers: { 'If-None-Match': etag },
        }), runtime);
        expect(conditional.status).toBe(304);

        expect(listSpy).toHaveBeenCalledTimes(1);
        expect(getSpy).toHaveBeenCalledTimes(1);
        expect(edge.put).toHaveBeenCalledTimes(1);
        expect(edge.match).toHaveBeenCalledTimes(4);
    });

    it('refuses to stream an oversized base catalog', async () => {
        const oversized = 'x'.repeat(2 * 1024 * 1024 + 1);
        const bucket = new FakeR2Bucket({ 'community-playlists/catalog.json': oversized });
        const response = await worker.fetch(new Request('https://worker.test/community-playlists/catalog.json'), env(bucket));
        expect(response.status).toBe(503);
        expect(response.headers.get('cache-control')).toBe('no-store');
    });

    it('bounds cumulative submission bytes before fetching and parsing the records', async () => {
        const bucket = new FakeR2Bucket({ 'community-playlists/catalog.json': catalog() });
        for (let index = 0; index < 257; index += 1) {
            const id = generatedUuid(index);
            bucket.seed(`community-playlists/submissions/${id}.json`, 'x'.repeat(16 * 1024));
        }
        const getSpy = vi.spyOn(bucket, 'get');
        const response = await worker.fetch(new Request('https://worker.test/community-playlists/catalog.json'), env(bucket));
        expect(response.status).toBe(503);
        expect(getSpy).not.toHaveBeenCalled();
    });

    it('keeps legacy per-object fallback reads below the Worker subrequest ceiling', async () => {
        const bucket = new FakeR2Bucket({ 'community-playlists/catalog.json': catalog() });
        for (let index = 0; index < 901; index += 1) {
            const id = generatedUuid(index);
            bucket.seed(`community-playlists/submissions/${id}.json`, '{}');
        }
        const getSpy = vi.spyOn(bucket, 'get');
        const response = await worker.fetch(new Request('https://worker.test/community-playlists/catalog.json'), env(bucket));
        expect(response.status).toBe(503);
        expect(getSpy).not.toHaveBeenCalled();
    });
});

describe('anonymous public-playlist submissions', () => {
    it('accepts only the exact bounded JSON schema', async () => {
        const runtime = env(new FakeR2Bucket());
        await expect(worker.fetch(post('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'), runtime))
            .resolves.toMatchObject({ status: 400 });
        await expect(worker.fetch(post(BASE_ID, { id: BASE_ID, comment: 'do not persist me' }), runtime))
            .resolves.toMatchObject({ status: 400 });
        await expect(worker.fetch(post(BASE_ID, { id: BASE_ID }, { 'Content-Type': 'text/plain' }), runtime))
            .resolves.toMatchObject({ status: 415 });
        await expect(worker.fetch(new Request('https://worker.test/community-playlists/submissions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': '257' },
            body: '{}',
        }), runtime)).resolves.toMatchObject({ status: 413 });
    });

    it('rate limits before upstream verification and handles duplicates idempotently', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        const limited = env(new FakeR2Bucket(), false);
        const limitedResponse = await worker.fetch(post(BASE_ID), limited);
        expect(limitedResponse.status).toBe(429);
        expect(limitedResponse.headers.get('retry-after')).toBe('60');
        expect(fetchSpy).not.toHaveBeenCalled();

        const key = `community-playlists/submissions/${SUBMITTED_ID}.json`;
        const bucket = new FakeR2Bucket({ [key]: submissionRecord() });
        const duplicate = await worker.fetch(post(SUBMITTED_ID), env(bucket));
        expect(duplicate.status).toBe(200);
        expect(await duplicate.json()).toEqual({ status: 'already-listed', id: SUBMITTED_ID });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('keys the limiter only by trusted client IP, never caller-controlled user agent', async () => {
        const key = `community-playlists/submissions/${SUBMITTED_ID}.json`;
        const runtime = env(new FakeR2Bucket({ [key]: submissionRecord() }));

        await worker.fetch(post(SUBMITTED_ID, { id: SUBMITTED_ID }, { 'User-Agent': 'attacker-a' }), runtime);
        await worker.fetch(post(SUBMITTED_ID, { id: SUBMITTED_ID }, { 'User-Agent': 'attacker-b' }), runtime);
        await worker.fetch(post(SUBMITTED_ID, { id: SUBMITTED_ID }, {
            'User-Agent': 'attacker-a',
            'CF-Connecting-IP': '203.0.113.8',
        }), runtime);

        const rateKeys = runtime.COMMUNITY_SUBMISSION_RATE_LIMITER.limit.mock.calls
            .map(([input]) => input.key);
        expect(rateKeys[0]).toBe(rateKeys[1]);
        expect(rateKeys[2]).not.toBe(rateKeys[0]);
        expect(rateKeys.every(value => /^[a-f0-9]{64}$/.test(value))).toBe(true);
    });

    it('deduplicates IDs already present in the maintained base catalog without upstream fetch or write', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        const bucket = new FakeR2Bucket({ 'community-playlists/catalog.json': catalog() });
        const response = await worker.fetch(post(BASE_ID), env(bucket));

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ status: 'already-listed', id: BASE_ID });
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(bucket.putCalls).toHaveLength(0);
    });

    it('rejects missing and non-public upstream playlists', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(new Response('', { status: 404 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                id: PRIVATE_ID, name: 'Private', privacy: 0, works_count: 0,
            }), { headers: { 'Content-Type': 'application/json' } }));
        const runtime = env(new FakeR2Bucket({ 'community-playlists/catalog.json': catalog() }));

        expect((await worker.fetch(post(MISSING_ID), runtime)).status).toBe(404);
        expect((await worker.fetch(post(PRIVATE_ID), runtime)).status).toBe(403);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(runtime.SEMANTIC_INDEX.putCalls).toHaveLength(0);
    });

    it('treats upstream authorization or region errors as unavailable, not nonexistent', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 403 }));
        const bucket = new FakeR2Bucket({ 'community-playlists/catalog.json': catalog() });
        const response = await worker.fetch(post(SUBMITTED_ID), env(bucket));
        expect(response.status).toBe(503);
        expect(bucket.putCalls).toHaveLength(0);
    });

    it('does not persist a malformed successful upstream response as a missing playlist', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
            id: SUBMITTED_ID,
            privacy: 2,
        }), { headers: { 'Content-Type': 'application/json' } }));
        const bucket = new FakeR2Bucket({ 'community-playlists/catalog.json': catalog() });
        const response = await worker.fetch(post(SUBMITTED_ID), env(bucket));
        expect(response.status).toBe(503);
        expect(bucket.putCalls).toHaveLength(0);
    });

    it('treats malformed privacy metadata as unavailable rather than private', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
            id: SUBMITTED_ID,
            name: 'Missing privacy',
            works_count: 0,
        }), { headers: { 'Content-Type': 'application/json' } }));
        const bucket = new FakeR2Bucket({ 'community-playlists/catalog.json': catalog() });
        const response = await worker.fetch(post(SUBMITTED_ID), env(bucket));
        expect(response.status).toBe(503);
        expect(bucket.putCalls).toHaveLength(0);
    });

    it('stores only a verified summary under the deterministic create-only R2 key', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
            id: SUBMITTED_ID,
            name: 'Public playlist',
            user_name: 'Public curator',
            privacy: 2,
            works_count: 1,
            coverUrl: 'https://example.test/public.jpg',
            tags: [{ name: '耳かき' }],
            works: [{ source_id: 'RJ765432' }],
        }), { headers: { 'Content-Type': 'application/json' } }));
        const bucket = new FakeR2Bucket({ 'community-playlists/catalog.json': catalog() });
        const edge = new FakeEdgeCache();
        vi.stubGlobal('caches', { default: edge });
        const runtime = env(bucket);
        const response = await worker.fetch(post(SUBMITTED_ID), runtime);

        expect(response.status).toBe(201);
        expect(await response.json()).toMatchObject({ status: 'added', playlist: { id: SUBMITTED_ID } });
        const key = `community-playlists/submissions/${SUBMITTED_ID}.json`;
        expect(bucket.putCalls).toEqual([expect.objectContaining({
            key,
            options: expect.objectContaining({ onlyIf: expect.any(Headers) }),
        })]);
        expect((bucket.putCalls[0].options.onlyIf as Headers).get('If-None-Match')).toBe('*');
        expect(bucket.putCalls[0].options.customMetadata).toEqual({ communityRecord: expect.any(String) });
        const stored = JSON.parse(new TextDecoder().decode(bucket.objects.get(key)!.bytes));
        expect(stored).toMatchObject({
            version: 1,
            playlist: { id: SUBMITTED_ID, name: 'Public playlist', latestWorkId: 'RJ765432' },
        });
        expect(JSON.stringify(stored)).not.toContain('203.0.113.7');
        expect(JSON.stringify(stored)).not.toContain('Catalog Test');
        const [{ key: rateKey }] = runtime.COMMUNITY_SUBMISSION_RATE_LIMITER.limit.mock.calls[0];
        expect(rateKey).toMatch(/^[a-f0-9]{64}$/);
        expect(edge.delete).toHaveBeenCalledTimes(1);

        const getSpy = vi.spyOn(bucket, 'get');
        const merged = await worker.fetch(new Request('https://worker.test/community-playlists/catalog.json'), runtime);
        expect(merged.status).toBe(200);
        expect((await merged.json() as { playlists: Array<{ id: string }> }).playlists.map(({ id }) => id))
            .toEqual([BASE_ID, SUBMITTED_ID]);
        expect(getSpy).toHaveBeenCalledTimes(1);
        expect(getSpy).toHaveBeenCalledWith('community-playlists/catalog.json');
    });

    it('trims pathological tag metadata so every accepted submission remains readable', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
            id: SUBMITTED_ID,
            name: 'Large tags',
            privacy: 2,
            works_count: 0,
            tags: Array.from({ length: 128 }, (_, index) => ({ name: `${index}-${'界'.repeat(125)}` })),
        }), { headers: { 'Content-Type': 'application/json' } }));
        const bucket = new FakeR2Bucket({ 'community-playlists/catalog.json': catalog() });
        const response = await worker.fetch(post(SUBMITTED_ID), env(bucket));
        expect(response.status).toBe(201);
        const stored = bucket.objects.get(`community-playlists/submissions/${SUBMITTED_ID}.json`)!;
        expect(stored.bytes.byteLength).toBeLessThanOrEqual(7 * 1024);
        const record = JSON.parse(new TextDecoder().decode(stored.bytes));
        expect(record.playlist.tags.length).toBeLessThan(128);
    });
});
