export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'] as const;
export const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v'] as const;
export const AUDIO_EXTENSIONS = ['.wav', '.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wma'] as const;
export const PDF_EXTENSIONS = ['.pdf'] as const;
export const TEXT_EXTENSIONS = ['.txt', '.md', '.log', '.nfo', '.csv', '.json', '.srt', '.ass', '.vtt', '.lrc'] as const;

export interface MatchableMediaItem {
    hash?: string;
    title: string;
}

export function getFileExtension(filename: string): string {
    const match = filename.match(/\.[^.]+$/);
    return match ? match[0].toLowerCase() : '';
}

export function isImageExtension(ext: string): boolean {
    return IMAGE_EXTENSIONS.includes(ext as (typeof IMAGE_EXTENSIONS)[number]);
}

export function isVideoExtension(ext: string): boolean {
    return VIDEO_EXTENSIONS.includes(ext as (typeof VIDEO_EXTENSIONS)[number]);
}

export function isPdfExtension(ext: string): boolean {
    return PDF_EXTENSIONS.includes(ext as (typeof PDF_EXTENSIONS)[number]);
}

export function isTextExtension(ext: string): boolean {
    return TEXT_EXTENSIONS.includes(ext as (typeof TEXT_EXTENSIONS)[number]);
}

export function stripTrailingTranslationLabel(title: string): string {
    if (!title) return '';
    const match = title.match(/^(.+?)\s*\([^)]+\)$/);
    return match ? match[1].trim() : title.trim();
}

export function normalizeMediaMatchString(title: string): string {
    if (!title) return '';
    let normalized = title.normalize('NFC').toLowerCase();
    normalized = normalized.replace(/\s*\([^)]+\)\s*$/, '');

    // Strip only known media extensions, preserving semantic suffixes (e.g. ".final").
    const knownExtensions = new Set<string>([
        ...IMAGE_EXTENSIONS,
        ...VIDEO_EXTENSIONS,
        ...AUDIO_EXTENSIONS,
        ...PDF_EXTENSIONS,
        ...TEXT_EXTENSIONS,
    ]);
    while (true) {
        const match = normalized.match(/\.[a-z0-9]{2,5}$/);
        if (!match) break;
        const ext = match[0];
        if (!knownExtensions.has(ext)) break;
        normalized = normalized.slice(0, -ext.length);
    }

    normalized = normalized.replace(/[\s\-_.]+/g, ' ');
    return normalized.trim();
}

export function findMatchingMediaItem<T extends MatchableMediaItem>(
    target: MatchableMediaItem,
    list: T[],
): T | undefined {
    if (!target?.title || !Array.isArray(list) || list.length === 0) return undefined;

    if (target.hash && !target.hash.startsWith('__delegated_')) {
        const hashMatch = list.find((item) => item.hash === target.hash);
        if (hashMatch) return hashMatch;
    }

    const normalizedTarget = normalizeMediaMatchString(target.title);
    let match = list.find((item) => normalizeMediaMatchString(item.title) === normalizedTarget);
    if (match) return match;

    match = list.find((item) => item.title === target.title);
    if (match) return match;

    return list.find((item) => {
        const normalizedItem = normalizeMediaMatchString(item.title);
        return (normalizedItem.length > 3 && normalizedTarget.length > 3)
            && (normalizedItem.includes(normalizedTarget) || normalizedTarget.includes(normalizedItem));
    });
}
