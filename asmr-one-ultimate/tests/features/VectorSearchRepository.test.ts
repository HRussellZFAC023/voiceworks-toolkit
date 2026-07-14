import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { deleteDB } from 'idb';
import { VectorSearchRepository } from '../../src/features/vectorSearchRepository';
import type { SemanticVectorEntry } from '../../src/features/vectorSearchIndexTypes';

const names: string[] = [];
const repository = () => {
    const name = `semantic-index-${crypto.randomUUID()}`;
    names.push(name);
    return new VectorSearchRepository(name);
};

function entry(id: string, release = '2026-07-14'): SemanticVectorEntry {
    return { id, title: id, description: '', tags: [], vector: [1], release };
}

afterEach(async () => {
    await Promise.all(names.splice(0).map((name) => deleteDB(name)));
});

describe('VectorSearchRepository', () => {
    it('keeps an incomplete staging dataset inactive', async () => {
        const repo = repository();
        await repo.putBaselineBatch('old', [entry('old')]);
        await repo.activateDataset('old', 1, 'compat-old');
        await repo.putBaselineBatch('next', [entry('next-1')]);

        expect((await repo.getState()).activeDatasetId).toBe('old');
        expect((await repo.getMergedEntries()).map((item) => item.id)).toEqual(['old']);
        await expect(repo.activateDataset('next', 2, 'compat-next')).rejects.toThrow('count mismatch');
        expect((await repo.getState()).activeDatasetId).toBe('old');
        await repo.close();
    });

    it('only considers an active baseline usable at its persisted exact count', async () => {
        const repo = repository();
        await repo.putBaselineBatch('v1', [entry('one')]);
        await repo.activateDataset('v1', 1, 'compat');
        await expect(repo.hasUsableActiveBaseline()).resolves.toBe(false);
        await repo.activateDataset('v1', 1, 'compat', undefined, 'a'.repeat(64));
        await expect(repo.hasUsableActiveBaseline()).resolves.toBe(true);
        await repo.updateState({ expectedBaselineCount: 2 });
        await expect(repo.hasUsableActiveBaseline()).resolves.toBe(false);
        await repo.updateState({ expectedBaselineCount: 1, activeManifestSha256: 'not-a-digest' });
        await expect(repo.hasUsableActiveBaseline()).resolves.toBe(false);
        await repo.close();
    });

    it('atomically switches the active dataset and lets delta override baseline IDs', async () => {
        const repo = repository();
        await repo.putBaselineBatch('v1', [entry('same'), entry('base-only')]);
        await repo.activateDataset('v1', 2, 'compat');
        await repo.putDelta({ ...entry('same', '2026-07-15'), title: 'newer' });
        await repo.putDelta(entry('delta-only', '2026-07-16'));

        const merged = await repo.getMergedEntries();
        expect(merged).toHaveLength(3);
        expect(merged.find((item) => item.id === 'same')?.title).toBe('newer');
        expect(merged.every((item) => item.vector instanceof Float32Array)).toBe(true);
        expect(await repo.countMerged()).toBe(3);
        await repo.close();
    });

    it('uses legacy fallback entries only until a baseline is active', async () => {
        const repo = repository();
        expect((await repo.getMergedEntries([entry('legacy')])).map((item) => item.id)).toEqual(['legacy']);
        await repo.putBaselineBatch('v1', [entry('base')]);
        await repo.activateDataset('v1', 1, 'compat');
        expect((await repo.getMergedEntries([entry('legacy')])).map((item) => item.id)).toEqual(['base']);
        await repo.close();
    });

    it('atomically prunes historical local entries when the complete baseline activates', async () => {
        const repo = repository();
        await repo.putDelta(entry('historical', '2020-01-01'));
        await repo.putDelta(entry('new', '2026-07-15'));
        await repo.putBaselineBatch('v1', [entry('base')]);
        await repo.activateDataset('v1', 1, 'compat');

        expect((await repo.getMergedEntries()).map((item) => item.id).sort()).toEqual(['base', 'new']);
        await repo.close();
    });

    it('serializes historical delta writes with baseline activation across repository instances', async () => {
        const name = `semantic-index-race-${crypto.randomUUID()}`;
        names.push(name);
        const activating = new VectorSearchRepository(name);
        const indexing = new VectorSearchRepository(name);
        await activating.putBaselineBatch('v1', [entry('base')]);

        await Promise.all([
            activating.activateDataset('v1', 1, 'compat'),
            indexing.putDelta(entry('racing-historical', '2020-01-01')),
        ]);

        expect(await activating.getDelta('racing-historical')).toBeUndefined();
        await expect(indexing.putDelta(entry('late-historical', '2020-01-01'))).resolves.toBe(false);
        expect(await activating.getDelta('late-historical')).toBeUndefined();
        await activating.close();
        await indexing.close();
    });
});
