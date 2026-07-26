const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
// Private-use and replacement characters are neutralized too: they render as
// blank boxes on disk, so unrepairable legacy garbage becomes visible
// underscores instead of an invisible filename.
const CONTROL_OR_ILLEGAL = /[\u0000-\u001F\u007F<>:"/\\|?*\uE000-\uF8FF\uFFFD]/g;
// In Unicode mode this class matches only unpaired surrogates, because a valid
// pair is a single code point outside the range. Lone surrogates would reach the
// USVString sink APIs and be silently replaced with U+FFFD on disk.
const LONE_SURROGATE = /[\uD800-\uDFFF]/gu;
/** Maximum code points per segment (Windows caps components at 255 UTF-16 units). */
const MAX_SEGMENT_LENGTH = 180;
/** Maximum UTF-8 bytes per segment (ext4/APFS/exFAT cap components at 255 bytes). */
const MAX_SEGMENT_BYTES = 200;
const LEGACY_CP932_PUA = /[\uEF00-\uEFFF]/;
const UNSAFE_DECODED_FILENAME = /[\u0000-\u001F\u007F-\u009F\uE000-\uF8FF\uFFFD]/;
// Half-width katakana counts as Japanese here: doujin track names use it
// constantly, so a decode that produces it is not evidence of a bad repair.
const JAPANESE_TEXT = /[\u3040-\u30FF\u3400-\u9FFF\uFF61-\uFF9F]/;
/**
 * Scripts and symbols that plausibly appear in a real work or track filename.
 * CP932 byte pairs that accidentally form valid UTF-8 land almost anywhere else
 * (Latin Extended, Cyrillic, Hebrew, Syriac, ...), which is how a genuine
 * Japanese name beside byte carriers is told apart from decoding debris.
 */
const PLAUSIBLE_FILENAME_UNICODE =
    /[\u00A0-\u00BF\u2000-\u2BFF\u3000-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/;
const PORTABLE_EXTENSION = /\.[A-Za-z0-9]{1,15}$/;

interface LegacyCarrierBytes {
    bytes: Uint8Array;
    carrierCount: number;
    unicodeCount: number;
    hasImplausibleUnicode: boolean;
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
    let hasImplausibleUnicode = false;
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
        hasImplausibleUnicode ||= !PLAUSIBLE_FILENAME_UNICODE.test(character);
    }
    return {
        bytes: Uint8Array.from(bytes),
        carrierCount,
        unicodeCount,
        hasImplausibleUnicode,
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
    return candidate.carrierCount >= 2
        && candidate.unicodeCount >= 1
        // Every "Unicode" character here must look like decoding debris. A name
        // whose non-carrier characters are all real Japanese or normal symbols
        // is a genuine Unicode name that must never be re-read as Shift-JIS.
        && candidate.hasImplausibleUnicode
        && !candidate.hasUnsupportedUnicode;
}

function isSafeDecodedFilename(original: string, decoded: string): boolean {
    const extension = original.match(PORTABLE_EXTENSION)?.[0];
    return Boolean(decoded)
        && decoded !== original
        && JAPANESE_TEXT.test(decoded)
        && !UNSAFE_DECODED_FILENAME.test(decoded)
        && (extension === undefined || decoded.endsWith(extension));
}

function repairMixedLegacyCp932Filename(value: string): string {
    if (typeof TextEncoder === 'undefined') return value;
    const candidate = bytesFromLegacyCarrierText(value);
    // A mixed recovery is stricter than the all-carrier case: the carriers must
    // be interrupted only by characters that cannot be real filename text.
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
            || !/[^\u0000-\u007F]/.test(decoded)
            || UNSAFE_DECODED_FILENAME.test(decoded)
        ) return value;
        return decoded;
    } catch {
        return value;
    }
}

function utf8ByteLengthOfCodePoint(codePoint: number): number {
    if (codePoint <= 0x7F) return 1;
    if (codePoint <= 0x7FF) return 2;
    if (codePoint <= 0xFFFF) return 3;
    return 4;
}

/** UTF-8 byte length, which is what filesystems actually budget per component. */
export function utf8ByteLength(value: string): number {
    let bytes = 0;
    for (const character of value) bytes += utf8ByteLengthOfCodePoint(character.codePointAt(0) ?? 0);
    return bytes;
}

function fitsSegmentLimits(value: string, maxCodePoints: number, maxBytes: number): boolean {
    let codePoints = 0;
    let bytes = 0;
    for (const character of value) {
        codePoints += 1;
        bytes += utf8ByteLengthOfCodePoint(character.codePointAt(0) ?? 0);
        if (codePoints > maxCodePoints || bytes > maxBytes) return false;
    }
    return true;
}

/**
 * Truncates on code point boundaries under both a code point and a UTF-8 byte
 * budget. Slicing UTF-16 code units would cut surrogate pairs in half, and the
 * sink APIs take USVString, which turns a lone surrogate into U+FFFD on disk.
 */
function truncateToLimits(value: string, maxCodePoints: number, maxBytes: number): string {
    let result = '';
    let codePoints = 0;
    let bytes = 0;
    for (const character of value) {
        const size = utf8ByteLengthOfCodePoint(character.codePointAt(0) ?? 0);
        if (codePoints + 1 > maxCodePoints || bytes + size > maxBytes) break;
        result += character;
        codePoints += 1;
        bytes += size;
    }
    return result;
}

function shortenPreservingExtension(
    value: string,
    maxCodePoints = MAX_SEGMENT_LENGTH,
    maxBytes = MAX_SEGMENT_BYTES,
): string {
    if (fitsSegmentLimits(value, maxCodePoints, maxBytes)) return value;
    const dot = value.lastIndexOf('.');
    const extension = dot > 0 && value.length - dot <= 16 ? value.slice(dot) : '';
    const stem = truncateToLimits(
        extension ? value.slice(0, dot) : value,
        Math.max(1, maxCodePoints - [...extension].length),
        Math.max(1, maxBytes - utf8ByteLength(extension)),
    ).replace(/[ .]+$/g, '');
    if (stem) return stem + extension;
    // A pathological extension leaves no room for a stem; keep a portable prefix.
    return truncateToLimits(value, maxCodePoints, maxBytes).replace(/[ .]+$/g, '');
}

export function sanitizePathSegment(segment: string, fallback = 'untitled'): string {
    let safe = repairLegacyCp932Filename(segment).normalize('NFC')
        .replace(LONE_SURROGATE, '_')
        .replace(CONTROL_OR_ILLEGAL, '_')
        .replace(/[ .]+$/g, '')
        .trim();
    if (!safe || safe === '.' || safe === '..') safe = fallback;
    if (WINDOWS_RESERVED_NAME.test(safe)) safe = `_${safe}`;
    safe = shortenPreservingExtension(safe);
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
    const shortenedStem = truncateToLimits(
        stem,
        Math.max(1, MAX_SEGMENT_LENGTH - suffix.length - [...extension].length),
        Math.max(1, MAX_SEGMENT_BYTES - suffix.length - utf8ByteLength(extension)),
    ).replace(/[ .]+$/g, '') || 'untitled';
    return sanitizePathSegment(`${shortenedStem}${suffix}${extension}`);
}

function addDirectoryCollisionSuffix(directory: string, number: number): string {
    const suffix = ` (${number})`;
    const shortened = truncateToLimits(
        directory,
        Math.max(1, MAX_SEGMENT_LENGTH - suffix.length),
        Math.max(1, MAX_SEGMENT_BYTES - suffix.length),
    ).replace(/[ .]+$/g, '') || 'untitled';
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
