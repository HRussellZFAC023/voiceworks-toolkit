import { Priority } from '../core/GpuScheduler';
import { EmbeddingService } from '../services/EmbeddingService';
import { VectorSearchBaselineClient } from './vectorSearchBaselineClient';
import { semanticDotProduct } from './vectorSearchEntryUtils';
import type { SemanticVectorEntry } from './vectorSearchIndexTypes';
import { VectorSearchRepository } from './vectorSearchRepository';

export interface SemanticWorkSearchResult {
    id: string;
    title: string;
    cover?: string;
    score: number;
}

export const DOWNLOAD_CENTER_SEMANTIC_MIN_SCORE = 0.25;

const repository = new VectorSearchRepository();
const baseline = new VectorSearchBaselineClient(repository);

export function rankSemanticWorkEntries(
    vector: ArrayLike<number>,
    entries: readonly SemanticVectorEntry[],
    limit = 80,
): SemanticWorkSearchResult[] {
    return entries
        .map(entry => ({ id: entry.id, title: entry.title, cover: entry.cover, score: semanticDotProduct(vector, entry.vector) }))
        .filter(result => Number.isFinite(result.score) && result.score >= DOWNLOAD_CENTER_SEMANTIC_MIN_SCORE)
        .sort((left, right) => right.score - left.score)
        .slice(0, Math.max(1, Math.min(200, limit)));
}

/** Search the same hosted multilingual vector index used by Semantic Super Search. */
export async function semanticWorkSearch(query: string, limit = 80): Promise<SemanticWorkSearchResult[]> {
    const normalized = query.normalize('NFKC').trim();
    if (!normalized) return [];
    await baseline.synchronize();
    const [vector, entries] = await Promise.all([
        EmbeddingService.embed(normalized, 'query', {
            priority: Priority.NORMAL,
            cancellable: true,
            cancellableKey: 'download-center-search',
            semanticBaselineCompatible: true,
        }),
        repository.getMergedEntries(),
    ]);
    return rankSemanticWorkEntries(vector, entries, limit);
}
