const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const CONTROL_OR_ILLEGAL = /[\u0000-\u001f\u007f<>:"/\\|?*]/g;
const MAX_SEGMENT_LENGTH = 180;
const LEGACY_CP932_PUA = /[\uEF00-\uEFFF]/;
const UNSAFE_DECODED_FILENAME = /[\u0000-\u001f\u007f-\u009f\uE000-\uF8FF\uFFFD]/;
const HALFWIDTH_KATAKANA = /[\uFF61-\uFF9F]/;
const JAPANESE_TEXT = /[\u3040-\u30FF\u3400-\u9FFF]/;
const PORTABLE_EXTENSION = /\.[A-Za-z0-9]{1,15}$/;

interface LegacyCarrierBytes {
    bytes: Uint8Array;
    carrierCount: number;
    unicodeCount: number;
    hasThreeByteUnicode: boolean;
    hasUnsupportedUnicode: boolean;
}

function legacyCarrierByte(codePoint: number): number | null {
    if (codePoint <= 0x7F) return codePoint;
    if (codePoint >= 0xEF00 && codePoint <= 0xEFFF) return codePoint & 0xFF;
    return null;
}

function bytesFromLegacyCarrierText(value: string): LegacyCarrierBytes {
    const bytes: number[] = [];
    let carrierCount = 0;
    let unicodeCount = 0;
    let hasThreeByteUnicode = false;
    let hasUnsupportedUnicode = false;
    const encoder = new TextEncoder();
    for (const character of value) {
        const codePoint = character.codePointAt(0) ?? 0;
        const carrierByte = legacyCarrierByte(codePoint);
        if (carrierByte !== null) {
            bytes.push(carrierByte);
            if (codePoint > 0x7F) carrierCount += 1;
            continue;
        }
        const encoded = encoder.encode(character);
        hasUnsupportedUnicode ||= encoded.length > 3;
        bytes.push(...encoded);
        unicodeCount += 1;
        hasThreeByteUnicode ||= encoded.length === 3;
    }
    return {
        bytes: Uint8Array.from(bytes),
        carrierCount,
        unicodeCount,
        hasThreeByteUnicode,
        hasUnsupportedUnicode,
    };
}

function utf8SequenceLength(byte: number): number {
    if (byte >= 0xC2 && byte <= 0xDF) return 2;
    if (byte >= 0xE0 && byte <= 0xEF) return 3;
    if (byte >= 0xF0 && byte <= 0xF4) return 4;
    return 1;
}

/**
 * Recreates the host's mixed carrier representation: valid UTF-8 byte runs
 * become Unicode while every undecodable byte becomes one U+EFxx carrier.
 */
function legacyCarrierTextFromBytes(bytes: Uint8Array): string {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let result = '';
    for (let index = 0; index < bytes.length;) {
        const byte = bytes[index];
        if (byte <= 0x7F) {
            result += String.fromCodePoint(byte);
            index += 1;
            continue;
        }
        const length = utf8SequenceLength(byte);
        if (length > 1 && index + length <= bytes.length) {
            try {
                result += decoder.decode(bytes.slice(index, index + length));
                index += length;
                continue;
            } catch {
                // This byte was carried verbatim by the legacy serializer.
            }
        }
        result += String.fromCodePoint(0xEF00 | byte);
        index += 1;
    }
    return result;
}

function isPlausibleMixedCarrier(candidate: LegacyCarrierBytes): boolean {
    return candidate.carrierCount >= 4
        && candidate.unicodeCount >= 1
        && candidate.hasThreeByteUnicode
        && !candidate.hasUnsupportedUnicode
        && candidate.carrierCount >= candidate.unicodeCount * 2;
}

function isSafeDecodedFilename(original: string, decoded: string): boolean {
    const extension = original.match(PORTABLE_EXTENSION)?.[0];
    return Boolean(decoded)
        && decoded !== original
        && JAPANESE_TEXT.test(decoded)
        && !UNSAFE_DECODED_FILENAME.test(decoded)
        // Genuine Unicode encoded as UTF-8 typically becomes classic
        // half-width Shift-JIS mojibake. Never "repair" that case.
        && !HALFWIDTH_KATAKANA.test(decoded)
        && (extension === undefined || decoded.endsWith(extension));
}

function repairMixedLegacyCp932Filename(value: string): string {
    if (typeof TextEncoder === 'undefined') return value;
    const candidate = bytesFromLegacyCarrierText(value);
    // A mixed recovery is intentionally stricter than the all-carrier case.
    // The live corruption has many byte carriers interrupted by a few valid
    // UTF-8 clusters; sparse carriers beside real Unicode are ambiguous.
    if (!isPlausibleMixedCarrier(candidate)) return value;
    if (legacyCarrierTextFromBytes(candidate.bytes) !== value) return value;

    try {
        const decoded = new TextDecoder('shift_jis', { fatal: true }).decode(candidate.bytes);
        return isSafeDecodedFilename(value, decoded) ? decoded : value;
    } catch {
        return value;
    }
}

/**
 * Repair a legacy asmr.one filename encoding where original CP932 bytes were
 * stored as U+EFxx private-use characters. Mixed Unicode is repaired only when
 * it round-trips through the host's byte-carrier representation and passes
 * conservative structural checks.
 */
export function repairLegacyCp932Filename(value: string): string {
    if (!LEGACY_CP932_PUA.test(value) || typeof TextDecoder === 'undefined') return value;
    const bytes: number[] = [];
    for (const character of value) {
        const codePoint = character.codePointAt(0) ?? 0;
        const carrierByte = legacyCarrierByte(codePoint);
        if (carrierByte === null) return repairMixedLegacyCp932Filename(value);
        bytes.push(carrierByte);
    }
    try {
        const decoded = new TextDecoder('shift_jis', { fatal: true })
            .decode(Uint8Array.from(bytes));
        if (
            !decoded
            || decoded === value
            || !/[^\u0000-\u007f]/.test(decoded)
            || UNSAFE_DECODED_FILENAME.test(decoded)
        ) return value;
        return decoded;
    } catch {
        return value;
    }
}

function shortenPreservingExtension(value: string, limit: number): string {
    if (value.length <= limit) return value;
    const dot = value.lastIndexOf('.');
    const extension = dot > 0 && value.length - dot <= 16 ? value.slice(dot) : '';
    const stemLength = Math.max(1, limit - extension.length);
    return value.slice(0, stemLength).replace(/[ .]+$/g, '') + extension;
}

export function sanitizePathSegment(segment: string, fallback = 'untitled'): string {
    let safe = repairLegacyCp932Filename(segment).normalize('NFC')
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

function addDirectoryCollisionSuffix(directory: string, number: number): string {
    const suffix = ` (${number})`;
    const maximumLength = Math.max(1, MAX_SEGMENT_LENGTH - suffix.length);
    const shortened = directory.slice(0, maximumLength).replace(/[ .]+$/g, '') || 'untitled';
    return sanitizePathSegment(`${shortened}${suffix}`);
}

export class DownloadPathReservations {
    private readonly files = new Set<string>();
    private readonly directories = new Set<string>();

    constructor(private readonly caseInsensitive = true) {}

    reserveDirectory(requestedPath: readonly string[]): string[] {
        return this.reserve(requestedPath, 'directory');
    }

    reserveFile(requestedPath: readonly string[]): string[] {
        return this.reserve(requestedPath, 'file');
    }

    private reserve(requestedPath: readonly string[], kind: 'directory' | 'file'): string[] {
        const safe = sanitizeRelativePath(requestedPath);
        const candidate: string[] = [];

        for (let index = 0; index < safe.length; index += 1) {
            const isLeaf = index === safe.length - 1;
            const segmentKind = isLeaf ? kind : 'directory';
            const original = safe[index];
            let segment = original;
            let number = 2;

            while (this.segmentConflicts([...candidate, segment], segmentKind, isLeaf)) {
                segment = segmentKind === 'file'
                    ? addCollisionSuffix(original, number)
                    : addDirectoryCollisionSuffix(original, number);
                number += 1;
            }
            candidate.push(segment);
            this.directories.add(canonicalDownloadPath(candidate, this.caseInsensitive));
        }

        const key = canonicalDownloadPath(candidate, this.caseInsensitive);
        if (kind === 'file') {
            this.directories.delete(key);
            this.files.add(key);
        }
        return candidate;
    }

    private segmentConflicts(
        path: readonly string[],
        kind: 'directory' | 'file',
        isLeaf: boolean,
    ): boolean {
        const key = canonicalDownloadPath(path, this.caseInsensitive);
        if (this.files.has(key)) return true;
        if (kind === 'file') return this.directories.has(key);
        return isLeaf && this.directories.has(key);
    }
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
