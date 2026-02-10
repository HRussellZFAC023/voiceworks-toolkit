import type { WorkOrder } from '../types/api';

export interface SortOption {
    label: string;
    order: string;
    sort: string;
}

export interface StoredSortOption {
    order: WorkOrder;
    sort: 'asc' | 'desc';
}

export const FALLBACK_SORT_OPTIONS: ReadonlyArray<{ value: WorkOrder; labelKey: string }> = [
    { value: 'insert_time', labelKey: 'sortNewest' },
    { value: 'release', labelKey: 'sortRelease' },
    { value: 'id', labelKey: 'sortRJCode' },
    { value: 'nsfw', labelKey: 'sortNSFW' },
    { value: 'rate_average_2dp', labelKey: 'sortDlsiteRating' },
    { value: 'dl_count', labelKey: 'sortDownloads' },
    { value: 'rating', labelKey: 'sortRating' },
    { value: 'review_count', labelKey: 'sortReviews' },
    { value: 'price', labelKey: 'sortPrice' },
    { value: 'random', labelKey: 'sortRandom' },
];

function getFallbackLabelKey(order: string): string | null {
    const fallback = FALLBACK_SORT_OPTIONS.find(opt => opt.value === order)
        || (order === 'create_date'
            ? FALLBACK_SORT_OPTIONS.find(opt => opt.value === 'insert_time')
            : undefined);
    return fallback?.labelKey ?? null;
}

export function resolveSortOrder(order: string, options: Array<{ order: string }>): string {
    if (options.some(opt => opt.order === order)) return order;
    if (order === 'create_date' && options.some(opt => opt.order === 'insert_time')) return 'insert_time';
    if (order === 'insert_time' && options.some(opt => opt.order === 'create_date')) return 'create_date';
    return order;
}

export function getFallbackSortOptions(translate: (key: string) => string): Array<{ order: string; label: string }> {
    return FALLBACK_SORT_OPTIONS.map(opt => ({
        order: opt.value,
        label: translate(opt.labelKey),
    }));
}

export function getSortLabel(
    order: string,
    sort: 'asc' | 'desc',
    hostOptions: SortOption[],
    translate: (key: string) => string,
): string {
    const matched = hostOptions.find(opt => opt.order === order && opt.sort === sort)
        || hostOptions.find(opt => opt.order === order);
    if (matched?.label) return matched.label;
    const fallbackKey = getFallbackLabelKey(order);
    return fallbackKey ? translate(fallbackKey) : order;
}

export function resolveSortSelection(
    order: WorkOrder,
    sort: 'asc' | 'desc',
    hostOptions: SortOption[],
    translate: (key: string) => string,
): { order: WorkOrder; sort: 'asc' | 'desc'; label: string } {
    const available = hostOptions.length ? hostOptions : getFallbackSortOptions(translate);
    const resolvedOrder = resolveSortOrder(order, available) as WorkOrder;
    const label = getSortLabel(resolvedOrder, sort, hostOptions, translate);
    return { order: resolvedOrder, sort, label };
}

export function parseStoredSortOption(raw: string | null): StoredSortOption | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as { order?: WorkOrder; sort?: 'asc' | 'desc' } | null;
        if (!parsed?.order || !parsed.sort) return null;
        if (parsed.sort !== 'asc' && parsed.sort !== 'desc') return null;
        return { order: parsed.order, sort: parsed.sort };
    } catch {
        return null;
    }
}
