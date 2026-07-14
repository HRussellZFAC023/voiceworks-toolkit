import { access, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Standalone Node producer intentionally remains plain ESM.
import { crawlStableCatalog, fetchWithRetry, prepareProducerEntry, produceVectorBaseline, PRODUCER_PAGE_SIZE } from '../../scripts/produce-vector-baseline.mjs';
import { SEMANTIC_EMBEDDING_DIMENSION } from '../../src/features/vectorSearchIndexTypes';

const directories: string[] = [];
async function temporaryDirectory() {
    const directory = await mkdtemp(join(tmpdir(), 'semantic-producer-test-'));
    directories.push(directory);
    return directory;
}

afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function work(id: string, overrides: Record<string, unknown> = {}) {
    return { id, title: `Work ${id}`, release: '2026-07-14', tags: [], vas: [], ...overrides };
}

function page(works: ReturnType<typeof work>[]) {
    return new Response(JSON.stringify({
        works,
        pagination: { currentPage: 1, pageSize: PRODUCER_PAGE_SIZE, totalCount: works.length },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function normalizedVector() {
    return [1, ...Array.from({ length: SEMANTIC_EMBEDDING_DIMENSION - 1 }, () => 0)];
}

describe('complete semantic baseline producer', () => {
    it('does not retry a non-retryable 4xx response', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(new Response('no', { status: 404 }));
        const sleepImpl = vi.fn();
        await expect(fetchWithRetry('https://api.test/api/works', { fetchImpl, sleepImpl })).rejects.toThrow('HTTP 404');
        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(sleepImpl).not.toHaveBeenCalled();
    });

    it('honors Retry-After for 429 responses before retrying', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }))
            .mockResolvedValueOnce(new Response('{}', { status: 200 }));
        const sleepImpl = vi.fn();
        await expect(fetchWithRetry('https://api.test/api/works', { fetchImpl, sleepImpl })).resolves.toMatchObject({ status: 200 });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(sleepImpl).toHaveBeenCalledWith(2_000);
    });

    it('restarts crawl-only checkpoints when reconciliation observes catalog mutation', async () => {
        const stateDirectory = await temporaryDirectory();
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(page([work('C', { title: 'Old title' })]))
            .mockResolvedValueOnce(page([work('C', { title: 'Changed title' })]))
            .mockResolvedValueOnce(page([work('C')]))
            .mockResolvedValueOnce(page([work('C')]));
        const result = await crawlStableCatalog({
            apiBase: 'https://api.test', stateDirectory, fetchImpl, sleepImpl: vi.fn(), maximumReconciliationCycles: 2,
        });
        expect(result.works.map((item: { id: string }) => item.id)).toEqual(['C']);
        expect(fetchImpl).toHaveBeenCalledTimes(4);
        expect(JSON.parse(await readFile(join(stateDirectory, 'crawl-pass-1/page-000001.json'), 'utf8')).works[0].id).toBe('C');
    });

    it('fingerprints exact canonical metadata and model input', () => {
        const original = prepareProducerEntry(work('A', { tags: [{ id: 1, name: 'Tag A' }] }));
        const titleChanged = prepareProducerEntry(work('A', { title: 'Different', tags: [{ id: 1, name: 'Tag A' }] }));
        const tagChanged = prepareProducerEntry(work('A', { tags: [{ id: 1, name: 'Tag B' }] }));
        expect(original.modelInput).toMatch(/^passage: /);
        expect(new Set([original.fingerprint, titleChanged.fingerprint, tagChanged.fingerprint]).size).toBe(3);
    });

    it('resumes embedding checkpoints and emits a manifest only after a fresh stable verification', async () => {
        const root = await temporaryDirectory();
        const stateDirectory = join(root, 'state');
        const outputDirectory = join(root, 'output');
        const works = Array.from({ length: 17 }, (_, index) => work(String(index + 1).padStart(2, '0')));
        const firstFetch = vi.fn().mockResolvedValueOnce(page(works)).mockResolvedValueOnce(page(works));
        let batch = 0;
        const interruptedEmbed = vi.fn(async (inputs: string[]) => {
            batch += 1;
            if (batch === 2) throw new Error('interrupted');
            return inputs.map(normalizedVector);
        });
        await expect(produceVectorBaseline({
            apiBase: 'https://api.test', stateDirectory, outputDirectory, datasetId: 'resume-test',
            fetchImpl: firstFetch, sleepImpl: vi.fn(), embed: interruptedEmbed, batchSize: 16,
        })).rejects.toThrow('interrupted');
        await expect(access(join(outputDirectory, 'semantic-index/manifest.json'))).rejects.toThrow();

        const finalFetch = vi.fn().mockResolvedValueOnce(page(works));
        const resumedEmbed = vi.fn(async (inputs: string[]) => inputs.map(normalizedVector));
        const manifest = await produceVectorBaseline({
            apiBase: 'https://api.test', stateDirectory, outputDirectory, datasetId: 'resume-test',
            fetchImpl: finalFetch, sleepImpl: vi.fn(), embed: resumedEmbed, batchSize: 16,
        });
        expect(resumedEmbed).toHaveBeenCalledOnce();
        expect(resumedEmbed.mock.calls[0][0]).toHaveLength(1);
        expect(finalFetch).toHaveBeenCalledOnce();
        expect(manifest.entryCount).toBe(17);
        expect(JSON.parse(await readFile(join(outputDirectory, 'semantic-index/manifest.json'), 'utf8')).shardFormat).toBe('gzip-f32le-v1');
        const marker = JSON.parse(await readFile(join(outputDirectory, 'semantic-index/complete.json'), 'utf8'));
        expect(marker).toMatchObject({ markerVersion: 1, datasetId: 'resume-test', entryCount: 17 });
    });

    it('invalidates same-ID embedding checkpoints when canonical payload metadata drifts', async () => {
        const root = await temporaryDirectory();
        const stateDirectory = join(root, 'state');
        const outputDirectory = join(root, 'output');
        const oldWorks = Array.from({ length: 17 }, (_, index) => work(String(index + 1).padStart(2, '0')));
        const initialFetch = vi.fn().mockResolvedValueOnce(page(oldWorks)).mockResolvedValueOnce(page(oldWorks));
        let batch = 0;
        await expect(produceVectorBaseline({
            apiBase: 'https://api.test', stateDirectory, outputDirectory, datasetId: 'metadata-drift',
            fetchImpl: initialFetch, sleepImpl: vi.fn(), batchSize: 16,
            embed: async (inputs: string[]) => {
                batch += 1;
                if (batch === 2) throw new Error('interrupted');
                return inputs.map(normalizedVector);
            },
        })).rejects.toThrow('interrupted');
        await Promise.all([
            rm(join(stateDirectory, 'crawl-pass-1'), { recursive: true, force: true }),
            rm(join(stateDirectory, 'crawl-pass-2'), { recursive: true, force: true }),
        ]);
        const changedWorks = oldWorks.map((item, index) => index === 0 ? { ...item, title: 'Changed canonical title' } : item);
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(page(changedWorks))
            .mockResolvedValueOnce(page(changedWorks))
            .mockResolvedValueOnce(page(changedWorks));
        const embed = vi.fn(async (inputs: string[]) => inputs.map(normalizedVector));
        await produceVectorBaseline({
            apiBase: 'https://api.test', stateDirectory, outputDirectory, datasetId: 'metadata-drift',
            fetchImpl, sleepImpl: vi.fn(), embed, batchSize: 16,
        });
        expect(embed).toHaveBeenCalledTimes(2);
        expect(embed.mock.calls[0][0][0]).toContain('Changed canonical title');
    });

    it('refuses final catalog drift and invalidates unsafe checkpoints without a manifest', async () => {
        const root = await temporaryDirectory();
        const stateDirectory = join(root, 'state');
        const outputDirectory = join(root, 'output');
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(page([work('A')]))
            .mockResolvedValueOnce(page([work('A')]))
            .mockResolvedValueOnce(page([work('A', { tags: [{ id: 9, name: 'Changed tag payload' }] })]));
        await expect(produceVectorBaseline({
            apiBase: 'https://api.test', stateDirectory, outputDirectory, datasetId: 'drift-test',
            fetchImpl, sleepImpl: vi.fn(), embed: async (inputs: string[]) => inputs.map(normalizedVector), batchSize: 16,
        })).rejects.toThrow('Catalog changed after embedding');
        await expect(access(join(outputDirectory, 'semantic-index/manifest.json'))).rejects.toThrow();
        await expect(access(join(stateDirectory, 'crawl-pass-1'))).rejects.toThrow();
        await expect(access(join(stateDirectory, 'entry-batches'))).rejects.toThrow();
    });

    it('revokes stale completion attestations as soon as a new attempt starts', async () => {
        const root = await temporaryDirectory();
        const stateDirectory = join(root, 'state');
        const outputDirectory = join(root, 'output');
        await mkdir(join(outputDirectory, 'semantic-index'), { recursive: true });
        await mkdir(stateDirectory, { recursive: true });
        await writeFile(join(outputDirectory, 'semantic-index/manifest.json'), '{"old":true}\n');
        await writeFile(join(outputDirectory, 'semantic-index/complete.json'), '{"old":true}\n');
        await writeFile(join(stateDirectory, 'complete.json'), '{"old":true}\n');

        await expect(produceVectorBaseline({
            apiBase: 'https://api.test', stateDirectory, outputDirectory, datasetId: 'failed-refresh',
            fetchImpl: vi.fn().mockResolvedValue(new Response('unavailable', { status: 404 })),
            sleepImpl: vi.fn(), embed: vi.fn(), batchSize: 16,
        })).rejects.toThrow('HTTP 404');

        await expect(access(join(outputDirectory, 'semantic-index/complete.json'))).rejects.toThrow();
        await expect(access(join(stateDirectory, 'complete.json'))).rejects.toThrow();
        expect(await readFile(join(outputDirectory, 'semantic-index/manifest.json'), 'utf8')).toContain('old');
    });
});
