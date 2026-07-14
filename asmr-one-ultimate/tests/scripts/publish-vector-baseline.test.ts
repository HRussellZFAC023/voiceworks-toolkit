import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Standalone Node builder intentionally remains plain ESM.
import { writeBuiltVectorBaseline } from '../../scripts/build-vector-baseline.mjs';
// @ts-expect-error Standalone Node publisher intentionally remains plain ESM.
import { parsePublisherCliArgs, publishVectorBaseline, validatePublicationDirectory } from '../../scripts/publish-vector-baseline.mjs';
import { SEMANTIC_EMBEDDING_DIMENSION } from '../../src/features/vectorSearchIndexTypes';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'semantic-publish-test-'));
    directories.push(directory);
    await writeBuiltVectorBaseline([{
        id: 'A', title: 'A', description: '', tags: [], release: '2026-07-14',
        vector: [1, ...Array.from({ length: SEMANTIC_EMBEDDING_DIMENSION - 1 }, () => 0)],
    }], directory, { datasetId: 'publish-test', generatedAt: '2026-07-14T00:00:00.000Z' });
    const manifestPath = join(directory, 'semantic-index/manifest.json');
    const manifestBytes = await readFile(manifestPath);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const markerPath = join(directory, 'semantic-index/complete.json');
    await mkdir(dirname(markerPath), { recursive: true });
    await writeFile(markerPath, JSON.stringify({
        markerVersion: 1,
        datasetId: manifest.datasetId,
        entryCount: manifest.entryCount,
        manifestBytes: manifestBytes.byteLength,
        manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    }));
    return { directory, manifest };
}

async function rewriteManifestAndMarker(directory: string, mutate: (manifest: Record<string, unknown>) => void) {
    const manifestPath = join(directory, 'semantic-index/manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    mutate(manifest);
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
    await writeFile(manifestPath, manifestBytes);
    await writeFile(join(directory, 'semantic-index/complete.json'), JSON.stringify({
        markerVersion: 1,
        datasetId: manifest.datasetId,
        entryCount: manifest.entryCount,
        manifestBytes: manifestBytes.byteLength,
        manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    }));
}

describe('guarded semantic baseline publisher', () => {
    it('rejects a stale marker or modified object before remote writes', async () => {
        const { directory, manifest } = await fixture();
        await writeFile(join(directory, 'semantic-index/complete.json'), '{}');
        await expect(validatePublicationDirectory(directory)).rejects.toThrow('marker');

        const fresh = await fixture();
        await writeFile(join(fresh.directory, fresh.manifest.shards[0].key.replace(/^\//, '')), 'tampered');
        await expect(publishVectorBaseline({
            directory: fresh.directory, dryRun: false, putObject: vi.fn(), getObject: vi.fn(), log: vi.fn(),
        })).rejects.toThrow('Local shard verification');
    });

    it('supports validation-only dry runs without remote operations', async () => {
        const { directory } = await fixture();
        const putObject = vi.fn();
        const getObject = vi.fn();
        await expect(publishVectorBaseline({ directory, dryRun: true, putObject, getObject, log: vi.fn() }))
            .resolves.toMatchObject({ status: 'dry-run', objects: 1 });
        expect(putObject).not.toHaveBeenCalled();
        expect(getObject).not.toHaveBeenCalled();
    });

    it('parses an omitted bucket dry run safely and rejects unknown flags', () => {
        expect(parsePublisherCliArgs(['out', '--dry-run'])).toEqual({
            directory: 'out', bucket: 'asmr-semantic-index', dryRun: true,
        });
        expect(parsePublisherCliArgs(['out', 'custom-bucket', '--dry-run'])).toEqual({
            directory: 'out', bucket: 'custom-bucket', dryRun: true,
        });
        expect(() => parsePublisherCliArgs(['out', '--dryrun'])).toThrow('Unknown option');
        expect(() => parsePublisherCliArgs(['out', '--dry-run', '--dry-run'])).toThrow('Duplicate');
    });

    it('rejects self-consistently remarked incompatible manifests before remote writes', async () => {
        const { directory } = await fixture();
        await rewriteManifestAndMarker(directory, (manifest) => { manifest.modelRevision = 'different'; });
        const putObject = vi.fn();
        await expect(publishVectorBaseline({
            directory, dryRun: false, putObject, getObject: vi.fn(), log: vi.fn(),
        })).rejects.toThrow('manifest contract');
        expect(putObject).not.toHaveBeenCalled();
    });

    it('rejects inconsistent counts and duplicate shard descriptors before remote writes', async () => {
        const inconsistent = await fixture();
        await rewriteManifestAndMarker(inconsistent.directory, (manifest) => {
            manifest.entryCount = Number(manifest.entryCount) + 1;
        });
        await expect(validatePublicationDirectory(inconsistent.directory)).rejects.toThrow('entry count');

        const duplicate = await fixture();
        await rewriteManifestAndMarker(duplicate.directory, (manifest) => {
            const shards = manifest.shards as Array<Record<string, unknown>>;
            shards.push({ ...shards[0] });
            manifest.entryCount = Number(manifest.entryCount) * 2;
        });
        await expect(validatePublicationDirectory(duplicate.directory)).rejects.toThrow('duplicate');
    });

    it('decompresses and decodes local shards before permitting remote writes', async () => {
        const { directory } = await fixture();
        const invalidDecoded = Buffer.from('not-a-semantic-binary-shard');
        const compressed = gzipSync(invalidDecoded);
        const sha256 = createHash('sha256').update(compressed).digest('hex');
        const key = `/semantic-index/objects/${sha256}.bin.gz`;
        await mkdir(dirname(join(directory, key.replace(/^\//, ''))), { recursive: true });
        await writeFile(join(directory, key.replace(/^\//, '')), compressed);
        await rewriteManifestAndMarker(directory, (manifest) => {
            const shards = manifest.shards as Array<Record<string, unknown>>;
            shards[0] = {
                ...shards[0], key, sha256, bytes: compressed.byteLength, decodedBytes: invalidDecoded.byteLength,
            };
        });
        const putObject = vi.fn();
        await expect(publishVectorBaseline({
            directory, dryRun: false, putObject, getObject: vi.fn(), log: vi.fn(),
        })).rejects.toThrow('decoding failed');
        expect(putObject).not.toHaveBeenCalled();
    });

    it('uploads and remotely verifies every object before putting the manifest last', async () => {
        const { directory } = await fixture();
        const remote = new Map<string, Buffer>();
        const order: string[] = [];
        const putObject = vi.fn(async (object: { key: string; path: string }) => {
            order.push(`put:${object.key}`);
            remote.set(object.key, await readFile(object.path));
        });
        const getObject = vi.fn(async (key: string) => {
            order.push(`get:${key}`);
            return remote.get(key)!;
        });
        await expect(publishVectorBaseline({ directory, dryRun: false, putObject, getObject, log: vi.fn() }))
            .resolves.toMatchObject({ status: 'published', objects: 1 });
        expect(order.at(-2)).toBe('put:semantic-index/manifest.json');
        expect(order.at(-1)).toBe('get:semantic-index/manifest.json');
        expect(order[0]).toMatch(/^put:semantic-index\/objects\//);
    });
});
