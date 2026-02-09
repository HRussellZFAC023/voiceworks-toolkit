export function normalizeWorkId(value: string | number | null | undefined): string | null {
    if (value == null) return null;

    const raw = String(value).trim();
    if (!raw) return null;

    const stripped = raw.replace(/^[A-Za-z]+/, '');
    if (!/^\d+$/.test(stripped)) return null;

    const asNumber = Number(stripped);
    if (!Number.isFinite(asNumber) || asNumber <= 0) return null;
    return String(asNumber);
}

export function parseWorkIdFromCoverUrl(coverUrl: string): string | null {
    if (!coverUrl) return null;
    const match = coverUrl.match(/\/cover\/((?:[A-Za-z]+)?\d+)/i);
    if (!match?.[1]) return null;
    return normalizeWorkId(match[1]);
}
