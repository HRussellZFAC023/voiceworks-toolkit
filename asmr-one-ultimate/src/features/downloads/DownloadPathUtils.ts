const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const CONTROL_OR_ILLEGAL = /[\u0000-\u001f\u007f<>:"/\\|?*]/g;
const MAX_SEGMENT_LENGTH = 180;

function shortenPreservingExtension(value: string, limit: number): string {
    if (value.length <= limit) return value;
    const dot = value.lastIndexOf('.');
    const extension = dot > 0 && value.length - dot <= 16 ? value.slice(dot) : '';
    const stemLength = Math.max(1, limit - extension.length);
    return value.slice(0, stemLength).replace(/[ .]+$/g, '') + extension;
}

export function sanitizePathSegment(segment: string, fallback = 'untitled'): string {
    let safe = segment.normalize('NFC')
        .replace(CONTROL_OR_ILLEGAL, '_')
        .replace(/[ .]+$/g, '')
        .trim();
    if (!safe || safe === '.' || safe === '..') safe = fallback;
    if (WINDOWS_RESERVED_NAME.test(safe)) safe = `_${safe}`;
    safe = shortenPreservingExtension(safe, MAX_SEGMENT_LENGTH);
    return safe || fallback;
}

/** Converts an untrusted relative path into portable, non-traversing path segments. */
export function sanitizeRelativePath(path: string | readonly string[]): string[] {
    const input = typeof path === 'string' ? path.split(/[\\/]+/) : path;
    const segments: string[] = [];
    for (const raw of input) {
        // Empty root markers do not create absolute destinations. Dot segments cannot navigate.
        if (!raw || raw === '.') continue;
        segments.push(sanitizePathSegment(raw === '..' ? 'untitled' : raw));
    }
    return segments.length ? segments : ['untitled'];
}

export function canonicalDownloadPath(path: readonly string[], caseInsensitive = true): string {
    const normalized = sanitizeRelativePath(path).join('/').normalize('NFC');
    return caseInsensitive ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function addCollisionSuffix(filename: string, number: number): string {
    const dot = filename.lastIndexOf('.');
    const hasExtension = dot > 0 && dot < filename.length - 1;
    const stem = hasExtension ? filename.slice(0, dot) : filename;
    const extension = hasExtension ? filename.slice(dot) : '';
    const suffix = ` (${number})`;
    // Reserve suffix space before truncating; otherwise truncation can erase it and
    // make the collision loop retry the same filename forever.
    const maximumStemLength = Math.max(1, MAX_SEGMENT_LENGTH - suffix.length - extension.length);
    const shortenedStem = stem.slice(0, maximumStemLength).replace(/[ .]+$/g, '') || 'untitled';
    return sanitizePathSegment(`${shortenedStem}${suffix}${extension}`);
}

/** Reserves a path and returns a deterministic ` (n)` filename when it already exists. */
export function reserveCollisionFreePath(
    requestedPath: readonly string[],
    occupied: Set<string>,
    caseInsensitive = true,
): string[] {
    const safe = sanitizeRelativePath(requestedPath);
    let candidate = safe;
    let number = 2;
    while (occupied.has(canonicalDownloadPath(candidate, caseInsensitive))) {
        candidate = [...safe.slice(0, -1), addCollisionSuffix(safe[safe.length - 1], number)];
        number += 1;
    }
    occupied.add(canonicalDownloadPath(candidate, caseInsensitive));
    return candidate;
}
