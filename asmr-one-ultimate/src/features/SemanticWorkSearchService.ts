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
    tags: string[];
    score: number;
}

/** One page of semantic hits, plus the size of the whole match set. */
export interface SemanticWorkSearchPage {
    results: SemanticWorkSearchResult[];
    /** Matches at or above the score threshold, counted before paging. */
    total: number;
}

export interface SemanticWorkSearchPaging {
    /** Page size. There is no hidden ceiling: ask for what you can render. */
    limit?: number;
    /** Rank of the first returned match, for paging past an earlier page. */
    offset?: number;
}

export const DOWNLOAD_CENTER_SEMANTIC_MIN_SCORE = 0.25;
/** Default page size: enough to feel complete, small enough to stay renderable. */
export const SEMANTIC_WORK_SEARCH_PAGE_SIZE = 100;

const repository = new VectorSearchRepository();
const baseline = new VectorSearchBaselineClient(repository);

/** The last full ranking, so paging does not re-embed and re-read the index. */
let cachedRanking: { query: string; ranked: SemanticWorkSearchResult[] } | null = null;

function readPaging(paging: number | SemanticWorkSearchPaging | undefined): { limit: number; offset: number } {
    const source = typeof paging === 'number' ? { limit: paging, offset: 0 } : paging ?? {};
    const limit = Number.isFinite(source.limit) ? Math.max(1, Math.floor(Number(source.limit))) : SEMANTIC_WORK_SEARCH_PAGE_SIZE;
    const offset = Number.isFinite(source.offset) ? Math.max(0, Math.floor(Number(source.offset))) : 0;
    return { limit, offset };
}

/**
 * Every match above the score threshold, best first.
 *
 * Deliberately uncapped: the caller pages this list, and a silent ceiling here
 * would make the reported total a lie.
 */
export function rankAllSemanticWorkEntries(
    vector: ArrayLike<number>,
    entries: readonly SemanticVectorEntry[],
): SemanticWorkSearchResult[] {
    return entries
        .map(entry => ({ id: entry.id, title: entry.title, cover: entry.cover, tags: entry.tags, score: semanticDotProduct(vector, entry.vector) }))
        .filter(result => Number.isFinite(result.score) && result.score >= DOWNLOAD_CENTER_SEMANTIC_MIN_SCORE)
        .sort((left, right) => right.score - left.score);
}

function pageRankedEntries(
    ranked: readonly SemanticWorkSearchResult[],
    paging: number | SemanticWorkSearchPaging | undefined,
): SemanticWorkSearchPage {
    const { limit, offset } = readPaging(paging);
    // `total` is counted before slicing, so a caller can report how many
    // matches exist rather than how many happened to fit in one page.
    return { results: ranked.slice(offset, offset + limit), total: ranked.length };
}

/** Ranks every match above the threshold, then returns one page of it. */
export function rankSemanticWorkEntries(
    vector: ArrayLike<number>,
    entries: readonly SemanticVectorEntry[],
    paging?: number | SemanticWorkSearchPaging,
): SemanticWorkSearchPage {
    return pageRankedEntries(rankAllSemanticWorkEntries(vector, entries), paging);
}

/** Forgets the cached ranking, so the next search re-reads the index. */
export function clearSemanticWorkSearchCache(): void {
    cachedRanking = null;
}

/** Search the same hosted multilingual vector index used by Semantic Super Search. */
export async function semanticWorkSearch(
    query: string,
    paging?: number | SemanticWorkSearchPaging,
): Promise<SemanticWorkSearchPage> {
    const normalized = query.normalize('NFKC').trim();
    if (!normalized) return { results: [], total: 0 };
    const { limit, offset } = readPaging(paging);
    // Only later pages reuse the cached ranking. A fresh search always re-reads
    // the index, both because embedding is cheap relative to being stale and
    // because newly indexed works must be able to appear.
    if (offset > 0 && cachedRanking?.query === normalized) {
        return pageRankedEntries(cachedRanking.ranked, { limit, offset });
    }
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
    const ranked = rankAllSemanticWorkEntries(vector, entries);
    cachedRanking = { query: normalized, ranked };
    return pageRankedEntries(ranked, { limit, offset });
}
