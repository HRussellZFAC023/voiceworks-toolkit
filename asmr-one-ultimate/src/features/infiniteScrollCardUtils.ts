const FALLBACK_ORIGIN = 'https://asmr.one';

/** Accept only the host's numeric work-code shape before using it in markup. */
export function normalizeInfiniteScrollRjCode(...candidates: unknown[]): string {
    for (const candidate of candidates) {
        const raw = String(candidate ?? '').trim();
        if (/^RJ\d{1,12}$/i.test(raw)) return raw.toUpperCase();
        if (/^\d{1,12}$/.test(raw)) return `RJ${raw}`;
    }
    return '';
}

/**
 * Resolve an image URL without admitting executable schemes. The returned URL
 * is assigned through DOM/CSS properties, never interpolated into innerHTML.
 */
export function resolveInfiniteScrollCoverUrl(
    candidate: unknown,
    rjCode: string,
    baseHref = typeof window !== 'undefined' ? window.location.href : FALLBACK_ORIGIN,
): string {
    const numericId = rjCode.replace(/^RJ/i, '');
    const fallback = `/api/cover/${encodeURIComponent(numericId)}.jpg?type=main`;
    const raw = String(candidate ?? '').trim();
    if (!raw) return fallback;
    if (!/^https?:\/\//i.test(raw) && !raw.startsWith('//') && !raw.startsWith('/')) {
        return fallback;
    }

    try {
        const parsed = new URL(raw, baseHref || FALLBACK_ORIGIN);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return fallback;
        return parsed.href;
    } catch {
        return fallback;
    }
}

export function finiteWorkMetric(value: unknown): number {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}
