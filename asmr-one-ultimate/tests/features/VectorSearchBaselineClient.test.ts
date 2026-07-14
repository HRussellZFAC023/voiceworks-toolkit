import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteDB } from 'idb';
import {
    VectorSearchBaselineClient,
    parseSemanticBaselineManifest,
    parseSemanticVectorEntry,
} from '../../src/features/vectorSearchBaselineClient';
import { VectorSearchRepository } from '../../src/features/vectorSearchRepository';
import {
    SEMANTIC_EMBEDDING_DIMENSION,
    SEMANTIC_EMBEDDING_MODEL,
    SEMANTIC_EMBEDDING_MODEL_REVISION,
    SEMANTIC_EMBEDDING_DTYPE,
    SEMANTIC_MODEL_ONNX_SHA256,
    SEMANTIC_SHARD_FORMAT,
    SEMANTIC_INDEX_SCHEMA_VERSION,
    SEMANTIC_PAYLOAD_RECIPE_VERSION,
} from '../../src/features/vectorSearchIndexTypes';
import { encodeSemanticBinaryShard } from '../../src/features/vectorSearchBinaryShard';

const names: string[] = [];
const repositories: VectorSearchRepository[] = [];
function repository() {
    const name = `baseline-client-${crypto.randomUUID()}`;
    names.push(name);
    const repo = new VectorSearchRepository(name);
    repositories.push(repo);
    return repo;
}

afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(repositories.splice(0).map((repo) => repo.close()));
    await Promise.all(names.splice(0).map((name) => deleteDB(name)));
});

function vector(): number[] {
    return [1, ...Array.from({ length: SEMANTIC_EMBEDDING_DIMENSION - 1 }, () => 0)];
}

function fixture(datasetId = 'baseline-v1') {
    const entries = [{ id: 'RJ1', title: 'One', description: '', tags: [], vector: vector(), release: '2026-07-14' }];
    const decoded = encodeSemanticBinaryShard(entries, SEMANTIC_EMBEDDING_DIMENSION);
    const bytes = gzipSync(decoded, { level: 9 });
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const manifest = {
        schemaVersion: SEMANTIC_INDEX_SCHEMA_VERSION,
        datasetId,
        generatedAt: '2026-07-14T12:00:00.000Z',
        cutoffInclusive: '2026-07-14',
        model: SEMANTIC_EMBEDDING_MODEL,
        modelRevision: SEMANTIC_EMBEDDING_MODEL_REVISION,
        dtype: SEMANTIC_EMBEDDING_DTYPE,
        modelOnnxSha256: SEMANTIC_MODEL_ONNX_SHA256,
        shardFormat: SEMANTIC_SHARD_FORMAT,
        dimension: SEMANTIC_EMBEDDING_DIMENSION,
        metric: 'dot', normalized: true,
        payloadRecipeVersion: SEMANTIC_PAYLOAD_RECIPE_VERSION,
        entryCount: 1,
        shards: [{ key: `/semantic-index/objects/${sha256}.bin.gz`, sha256, bytes: bytes.byteLength, decodedBytes: decoded.byteLength, entryCount: 1 }],
    };
    return { entries, bytes, sha256, manifest };
}

describe('VectorSearchBaselineClient', () => {
    it('validates the compatibility contract and rejects a cutoff mismatch', () => {
        const { manifest } = fixture();
        expect(parseSemanticBaselineManifest(manifest)).toMatchObject({ datasetId: 'baseline-v1', shardFormat: 'gzip-f32le-v1' });
        expect(() => parseSemanticBaselineManifest({ ...manifest, cutoffInclusive: '2026-07-15' })).toThrow('Incompatible');
        expect(() => parseSemanticVectorEntry({ ...fixture().entries[0], release: '2026-07-15' })).toThrow('Invalid');
        expect(() => parseSemanticVectorEntry({ ...fixture().entries[0], vector: Array(SEMANTIC_EMBEDDING_DIMENSION).fill(0) }))
            .toThrow('not normalized');
        expect(() => parseSemanticBaselineManifest({ ...manifest, entryCount: 250_001 })).toThrow('Incompatible');
        expect(() => parseSemanticBaselineManifest({
            ...manifest,
            entryCount: 65,
            shards: Array.from({ length: 65 }, (_, index) => ({
                ...manifest.shards[0],
                key: `/semantic-index/objects/${String(index).padStart(64, '0')}.bin.gz`,
                sha256: String(index).padStart(64, '0'),
                bytes: 8 * 1024 * 1024,
                decodedBytes: 8 * 1024 * 1024,
            })),
        })).toThrow('global size limit');
    });

    it('verifies and atomically activates a complete baseline', async () => {
        const repo = repository();
        const { bytes, manifest } = fixture();
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200, headers: { etag: '"m1"' } }))
            .mockResolvedValueOnce(new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } }));

        const result = await new VectorSearchBaselineClient(repo, 'https://baseline.test/semantic-index/manifest.json', fetchMock).synchronize();
        expect(result).toEqual({ status: 'activated', datasetId: 'baseline-v1', entries: 1 });
        expect((await repo.getState()).activeDatasetId).toBe('baseline-v1');
        expect((await repo.getState()).expectedBaselineCount).toBe(1);
        expect((await repo.getState()).activeManifestSha256).toMatch(/^[a-f0-9]{64}$/);
        expect((await repo.getMergedEntries()).map((entry) => entry.id)).toEqual(['RJ1']);
    });

    it('keeps the previous dataset active when shard integrity fails', async () => {
        const repo = repository();
        const old = fixture('old');
        await repo.putBaselineBatch('old', old.entries);
        await repo.activateDataset('old', 1, 'old-compat');
        const next = fixture('next');
        const corrupt = new TextEncoder().encode('[]');
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify(next.manifest), { status: 200 }))
            .mockResolvedValueOnce(new Response(corrupt, { status: 200 }));

        const result = await new VectorSearchBaselineClient(repo, 'https://baseline.test/semantic-index/manifest.json', fetchMock).synchronize();
        expect(result.status).toBe('unavailable');
        expect((await repo.getState()).activeDatasetId).toBe('old');
        expect(await repo.countDataset('next')).toBe(0);
    });

    it('does not activate a dataset interrupted between verified shards', async () => {
        const repo = repository();
        const old = fixture('old');
        await repo.putBaselineBatch('old', old.entries);
        await repo.activateDataset('old', 1, 'old-compat');
        const firstBytes = old.bytes;
        const secondEntries = [{ ...old.entries[0], id: 'RJ2' }];
        const secondDecoded = encodeSemanticBinaryShard(secondEntries, SEMANTIC_EMBEDDING_DIMENSION);
        const secondBytes = gzipSync(secondDecoded, { level: 9 });
        const firstHash = createHash('sha256').update(firstBytes).digest('hex');
        const secondHash = createHash('sha256').update(secondBytes).digest('hex');
        const manifest = {
            ...old.manifest,
            datasetId: 'next', entryCount: 2,
            shards: [
                { ...old.manifest.shards[0], key: `/semantic-index/objects/${firstHash}.bin.gz`, sha256: firstHash, bytes: firstBytes.byteLength },
                { key: `/semantic-index/objects/${secondHash}.bin.gz`, sha256: secondHash, bytes: secondBytes.byteLength, decodedBytes: secondDecoded.byteLength, entryCount: 1 },
            ],
        };
        const abort = new AbortController();
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200 }))
            .mockImplementationOnce(async () => {
                abort.abort();
                return new Response(firstBytes, { status: 200, headers: { 'content-length': String(firstBytes.byteLength) } });
            });

        const result = await new VectorSearchBaselineClient(repo, 'https://baseline.test/semantic-index/manifest.json', fetchMock)
            .synchronize(abort.signal);
        expect(result.status).toBe('unavailable');
        expect((await repo.getState()).activeDatasetId).toBe('old');
        expect(await repo.countDataset('next')).toBe(0);
    });

    it('uses conditional manifest requests for an already active dataset', async () => {
        const repo = repository();
        const old = fixture('old');
        await repo.putBaselineBatch('old', old.entries);
        await repo.activateDataset('old', 1, 'compat', '"etag"', 'a'.repeat(64));
        const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 304 }));

        await expect(new VectorSearchBaselineClient(repo, 'https://baseline.test/semantic-index/manifest.json', fetchMock).synchronize())
            .resolves.toMatchObject({ status: 'cached', datasetId: 'old' });
        expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ 'If-None-Match': '"etag"' });
    });

    it('clears a stale etag after a 304 without an active dataset and retries unconditionally', async () => {
        const repo = repository();
        await repo.updateState({ manifestEtag: '"stale"' });
        const { bytes, manifest } = fixture();
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(null, { status: 304 }))
            .mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200, headers: { etag: '"fresh"' } }))
            .mockResolvedValueOnce(new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } }));
        const client = new VectorSearchBaselineClient(repo, 'https://baseline.test/semantic-index/manifest.json', fetchMock);

        await expect(client.synchronize()).resolves.toMatchObject({ status: 'unavailable' });
        expect((await repo.getState()).manifestEtag).toBeUndefined();
        await expect(client.synchronize()).resolves.toMatchObject({ status: 'activated', datasetId: 'baseline-v1' });
        expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ 'If-None-Match': '"stale"' });
        expect(fetchMock.mock.calls[1][1].headers).not.toHaveProperty('If-None-Match');
    });

    it('rejects a changed manifest that reuses an active dataset ID', async () => {
        const repo = repository();
        const { bytes, manifest } = fixture('same-id');
        const firstFetch = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200, headers: { etag: '"one"' } }))
            .mockResolvedValueOnce(new Response(bytes, { status: 200 }));
        await new VectorSearchBaselineClient(repo, 'https://baseline.test/semantic-index/manifest.json', firstFetch).synchronize();

        const changed = { ...manifest, generatedAt: '2026-07-14T13:00:00.000Z' };
        const result = await new VectorSearchBaselineClient(
            repo,
            'https://baseline.test/semantic-index/manifest.json',
            vi.fn().mockResolvedValue(new Response(JSON.stringify(changed), { status: 200 })),
        ).synchronize();

        expect(result).toMatchObject({ status: 'unavailable', error: expect.stringContaining('new dataset ID') });
        expect((await repo.getState()).activeDatasetId).toBe('same-id');
        expect((await repo.getMergedEntries()).map((entry) => entry.id)).toEqual(['RJ1']);
    });

    it('fully reimports a same-ID legacy dataset that has no persisted manifest digest', async () => {
        const repo = repository();
        const { bytes, manifest } = fixture('legacy-same-id');
        await repo.putBaselineBatch('legacy-same-id', [{ ...fixture().entries[0], title: 'Stale local row' }]);
        await repo.activateDataset('legacy-same-id', 1, 'compat-without-digest', '"legacy"');
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200, headers: { etag: '"fresh"' } }))
            .mockResolvedValueOnce(new Response(bytes, { status: 200 }));

        const result = await new VectorSearchBaselineClient(
            repo, 'https://baseline.test/semantic-index/manifest.json', fetchMock,
        ).synchronize();

        expect(result).toMatchObject({ status: 'activated', datasetId: 'legacy-same-id' });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect((await repo.getMergedEntries()).map((entry) => entry.title)).toEqual(['One']);
        expect((await repo.getState()).activeManifestSha256).toMatch(/^[a-f0-9]{64}$/);
    });

    it('fully reimports a same-ID dataset whose persisted expected count is missing', async () => {
        const repo = repository();
        const { bytes, manifest } = fixture('missing-count');
        await repo.putBaselineBatch('missing-count', [{ ...fixture().entries[0], title: 'Stale local row' }]);
        await repo.activateDataset('missing-count', 1, 'compat', '"legacy"', 'a'.repeat(64));
        await repo.updateState({ expectedBaselineCount: undefined });
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200 }))
            .mockResolvedValueOnce(new Response(bytes, { status: 200 }));

        await expect(new VectorSearchBaselineClient(
            repo, 'https://baseline.test/semantic-index/manifest.json', fetchMock,
        ).synchronize()).resolves.toMatchObject({ status: 'activated', datasetId: 'missing-count' });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect((await repo.getMergedEntries()).map((entry) => entry.title)).toEqual(['One']);
    });

    it('clears the complete active identity after a 304 with a missing digest', async () => {
        const repo = repository();
        const old = fixture('legacy-304');
        await repo.putBaselineBatch('legacy-304', old.entries);
        await repo.activateDataset('legacy-304', 1, 'compat', '"etag"');

        const result = await new VectorSearchBaselineClient(
            repo,
            'https://baseline.test/semantic-index/manifest.json',
            vi.fn().mockResolvedValue(new Response(null, { status: 304 })),
        ).synchronize();
        expect(result).toMatchObject({ status: 'unavailable', error: expect.stringContaining('verified active dataset') });
        expect(await repo.getState()).toMatchObject({
            activeDatasetId: undefined,
            expectedBaselineCount: undefined,
            activeManifestSha256: undefined,
            compatibilityFingerprint: undefined,
            manifestEtag: undefined,
        });
        await expect(repo.hasUsableActiveBaseline()).resolves.toBe(false);
    });

    it('rejects 304 when the active row count differs from the persisted manifest count', async () => {
        const repo = repository();
        const old = fixture('old');
        await repo.putBaselineBatch('old', old.entries);
        await repo.activateDataset('old', 1, 'compat', '"etag"', 'a'.repeat(64));
        await repo.updateState({ expectedBaselineCount: 2 });

        const result = await new VectorSearchBaselineClient(
            repo,
            'https://baseline.test/semantic-index/manifest.json',
            vi.fn().mockResolvedValue(new Response(null, { status: 304 })),
        ).synchronize();
        expect(result).toMatchObject({ status: 'unavailable', error: expect.stringContaining('count') });
        expect((await repo.getState()).activeDatasetId).toBeUndefined();
    });

    it('cleans up a staging dataset after an IndexedDB quota failure', async () => {
        const repo = repository();
        const { bytes, manifest } = fixture('quota-failure');
        vi.spyOn(repo, 'putBaselineBatch').mockRejectedValueOnce(new DOMException('Quota exceeded', 'QuotaExceededError'));
        const remove = vi.spyOn(repo, 'removeDataset');
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200 }))
            .mockResolvedValueOnce(new Response(bytes, { status: 200 }));

        const result = await new VectorSearchBaselineClient(repo, 'https://baseline.test/semantic-index/manifest.json', fetchMock).synchronize();
        expect(result).toMatchObject({ status: 'unavailable', error: expect.stringContaining('Quota exceeded') });
        expect(remove).toHaveBeenCalledWith('quota-failure');
        expect(await repo.countDataset('quota-failure')).toBe(0);
    });

    it('fails gracefully when the browser has no gzip decompressor', async () => {
        vi.stubGlobal('DecompressionStream', undefined);
        const repo = repository();
        const { bytes, manifest } = fixture('no-decompressor');
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200 }))
            .mockResolvedValueOnce(new Response(bytes, { status: 200 }));

        const result = await new VectorSearchBaselineClient(repo, 'https://baseline.test/semantic-index/manifest.json', fetchMock).synchronize();
        expect(result).toMatchObject({ status: 'unavailable', error: expect.stringContaining('cannot decompress') });
        expect(await repo.countDataset('no-decompressor')).toBe(0);
    });

    it('rejects an import when conservative IndexedDB headroom is unavailable', async () => {
        vi.stubGlobal('navigator', { storage: { estimate: vi.fn(async () => ({ quota: 64 * 1024 * 1024, usage: 48 * 1024 * 1024 })) } });
        const repo = repository();
        const { manifest } = fixture('low-space');
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(manifest), { status: 200 }));

        const result = await new VectorSearchBaselineClient(repo, 'https://baseline.test/semantic-index/manifest.json', fetchMock).synchronize();
        expect(result).toMatchObject({ status: 'unavailable', error: expect.stringContaining('Insufficient browser storage') });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
