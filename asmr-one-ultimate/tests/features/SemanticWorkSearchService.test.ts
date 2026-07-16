import { describe, expect, it } from 'vitest';
import { rankSemanticWorkEntries } from '../../src/features/SemanticWorkSearchService';
import type { SemanticVectorEntry } from '../../src/features/vectorSearchIndexTypes';

function entry(id: string, vector: number[]): SemanticVectorEntry {
    return { id, title: id, description: '', tags: [], release: '2026-01-01', vector };
}

describe('rankSemanticWorkEntries', () => {
    it('drops unrelated finite vectors instead of always returning a top-N', () => {
        expect(rankSemanticWorkEntries([1, 0], [
            entry('relevant', [0.8, 0.2]),
            entry('unrelated', [0.1, 0.9]),
            entry('opposite', [-1, 0]),
        ])).toEqual([expect.objectContaining({ id: 'relevant', score: 0.8 })]);
    });
});
