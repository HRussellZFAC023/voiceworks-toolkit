import { SEMANTIC_BASELINE_CUTOFF } from './vectorSearchIndexTypes';

const RELEASE_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidSemanticReleaseDate(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    const match = RELEASE_DATE_PATTERN.exec(value);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year
        && date.getUTCMonth() === month - 1
        && date.getUTCDate() === day;
}

export function isPostBaselineRelease(value: unknown): value is string {
    return isValidSemanticReleaseDate(value) && value > SEMANTIC_BASELINE_CUTOFF;
}

export function pageIsAtOrBeforeBaselineCutoff(
    works: ReadonlyArray<{ release?: unknown }>,
): boolean {
    return works.length > 0 && works.every((work) =>
        isValidSemanticReleaseDate(work.release) && work.release <= SEMANTIC_BASELINE_CUTOFF,
    );
}

export function postBaselineWorks<T extends { release?: unknown }>(works: readonly T[]): T[] {
    return works.filter((work) => isPostBaselineRelease(work.release));
}

