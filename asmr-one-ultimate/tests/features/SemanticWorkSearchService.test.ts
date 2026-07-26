import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    embed: vi.fn(),
    getMergedEntries: vi.fn(),
    synchronize: vi.fn(),
}));

vi.mock('../../src/core/GpuScheduler', () => ({ Priority: { NORMAL: 1 } }));
vi.mock('../../src/services/EmbeddingService', () => ({ EmbeddingService: { embed: mocks.embed } }));
vi.mock('../../src/features/vectorSearchRepository', () => ({
    VectorSearchRepository: class { getMergedEntries = mocks.getMergedEntries; },
}));
vi.mock('../../src/features/vectorSearchBaselineClient', () => ({
    VectorSearchBaselineClient: class { synchronize = mocks.synchronize; },
}));

import {
    clearSemanticWorkSearchCache,
    rankAllSemanticWorkEntries,
    rankSemanticWorkEntries,
    semanticWorkSearch,
} from '../../src/features/SemanticWorkSearchService';
import type { SemanticVectorEntry } from '../../src/features/vectorSearchIndexTypes';

function entry(id: string, vector: number[]): SemanticVectorEntry {
    return { id, title: id, description: '', tags: [], release: '2026-01-01', vector };
}

/** `count` entries whose scores descend, so page order is predictable. */
function rankedEntries(count: number): SemanticVectorEntry[] {
    return Array.from({ length: count }, (_, index) => entry(`work-${index}`, [1 - index / (count * 2), 0]));
}

describe('rankSemanticWorkEntries', () => {
    it('drops unrelated finite vectors instead of always returning a top-N', () => {
        expect(rankSemanticWorkEntries([1, 0], [
            entry('relevant', [0.8, 0.2]),
            entry('unrelated', [0.1, 0.9]),
            entry('opposite', [-1, 0]),
        ]).results).toEqual([expect.objectContaining({ id: 'relevant', score: 0.8 })]);
    });

    it('counts every match above the threshold before the page is sliced', () => {
        const page = rankSemanticWorkEntries([1, 0], [
            ...rankedEntries(250),
            entry('unrelated', [0.1, 0.9]),
        ], { limit: 20 });

        expect(page.results).toHaveLength(20);
        expect(page.total).toBe(250);
    });

    it('has no hidden ceiling on the ranking a caller can page through', () => {
        expect(rankAllSemanticWorkEntries([1, 0], rankedEntries(320))).toHaveLength(320);
        expect(rankSemanticWorkEntries([1, 0], rankedEntries(320), { limit: 320 }).results).toHaveLength(320);
    });

    it('returns disjoint pages in rank order for successive offsets', () => {
        const entries = rankedEntries(50);
        const first = rankSemanticWorkEntries([1, 0], entries, { limit: 20, offset: 0 });
        const second = rankSemanticWorkEntries([1, 0], entries, { limit: 20, offset: 20 });
        const third = rankSemanticWorkEntries([1, 0], entries, { limit: 20, offset: 40 });

        expect(second.total).toBe(50);
        expect(third.results).toHaveLength(10);
        const ids = [...first.results, ...second.results, ...third.results].map(result => result.id);
        expect(new Set(ids).size).toBe(50);
        expect(first.results.at(-1)!.score).toBeGreaterThanOrEqual(second.results[0].score);
    });

    it('accepts a bare page size for callers that never page', () => {
        expect(rankSemanticWorkEntries([1, 0], rankedEntries(30), 5).results).toHaveLength(5);
    });

    it('reports an empty page rather than wrapping around past the last match', () => {
        const page = rankSemanticWorkEntries([1, 0], rankedEntries(10), { limit: 10, offset: 10 });

        expect(page.results).toEqual([]);
        expect(page.total).toBe(10);
    });
});

describe('semanticWorkSearch', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearSemanticWorkSearchCache();
        mocks.synchronize.mockResolvedValue(undefined);
        mocks.embed.mockResolvedValue([1, 0]);
        mocks.getMergedEntries.mockResolvedValue(rankedEntries(120));
    });

    it('reports the match count with the first page', async () => {
        const page = await semanticWorkSearch('warm rain', { limit: 40, offset: 0 });

        expect(page.results).toHaveLength(40);
        expect(page.total).toBe(120);
    });

    it('serves a later offset from the ranking it already computed', async () => {
        const first = await semanticWorkSearch('warm rain', { limit: 40, offset: 0 });
        const second = await semanticWorkSearch('warm rain', { limit: 40, offset: 40 });

        expect(second.total).toBe(120);
        expect(second.results.map(result => result.id)).not.toEqual(first.results.map(result => result.id));
        expect(new Set([...first.results, ...second.results].map(result => result.id)).size).toBe(80);
        // Paging must not re-embed the query or re-read the whole index.
        expect(mocks.embed).toHaveBeenCalledTimes(1);
        expect(mocks.getMergedEntries).toHaveBeenCalledTimes(1);
    });

    it('re-reads the index for a new query and for a repeated first page', async () => {
        await semanticWorkSearch('warm rain', { limit: 40, offset: 40 });
        await semanticWorkSearch('cold wind', { limit: 40, offset: 40 });
        expect(mocks.embed).toHaveBeenCalledTimes(2);

        await semanticWorkSearch('cold wind', { limit: 40, offset: 0 });
        expect(mocks.embed).toHaveBeenCalledTimes(3);
    });

    it('answers an empty query without touching the index', async () => {
        expect(await semanticWorkSearch('   ', { limit: 40 })).toEqual({ results: [], total: 0 });
        expect(mocks.synchronize).not.toHaveBeenCalled();
    });
});
