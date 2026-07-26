import { describe, expect, it } from 'vitest';
import {
    canonicalDownloadPath,
    DownloadPathReservations,
    repairLegacyCp932Filename,
    reserveCollisionFreePath,
    sanitizePathSegment,
    sanitizeRelativePath,
    utf8ByteLength,
} from '../../src/features/downloads/DownloadPathUtils';

const LIVE_MIXED_NAME = '\uEF82\uEFA0\uEF82肪\uEF82Ƃ\uEFA4'
    + '\uEF82\uEFB2\uEF82\uEFB4\uEF82\uEFA2\uEF82܂\uEFB7\uEF81B.txt';

function visibleCharacters(value: string): string {
    return [...value]
        .filter((character) => {
            const codePoint = character.codePointAt(0) ?? 0;
            return codePoint < 0xE000 || codePoint > 0xF8FF;
        })
        .join('');
}

describe('download path safety', () => {
    it('sanitizes illegal characters, controls, trailing dots, and Windows device names', () => {
        expect(sanitizePathSegment('voice: take?*.flac. ')).toBe('voice_ take__.flac');
        expect(sanitizePathSegment('CON')).toBe('_CON');
        expect(sanitizePathSegment('lpt1.txt')).toBe('_lpt1.txt');
        expect(sanitizePathSegment('bad\u0000name.txt')).toBe('bad_name.txt');
        expect(sanitizePathSegment('..')).toBe('untitled');
    });

    it('neutralizes traversal and absolute path syntax', () => {
        expect(sanitizeRelativePath('../../CON/voice?.wav')).toEqual([
            'untitled', 'untitled', '_CON', 'voice_.wav',
        ]);
        expect(sanitizeRelativePath('/root/folder/file.txt')).toEqual(['root', 'folder', 'file.txt']);
        expect(sanitizeRelativePath('C:\\secret\\file.txt')).toEqual(['C_', 'secret', 'file.txt']);
    });

    it('repairs strict legacy CP932 byte-carrier filenames', () => {
        expect(repairLegacyCp932Filename('\uEF91O\uEF95\uEFD2')).toBe('前編');
        expect(sanitizePathSegment('UB-001\uEF91O\uEF95\uEFD2.mp3')).toBe('UB-001前編.mp3');
        expect(sanitizePathSegment('UB-002\uEF8C\uEFE3\uEF95\uEFD2.mp3')).toBe('UB-002後編.mp3');
    });

    it('leaves mixed, invalid, and already-correct Unicode names untouched', () => {
        const mixedCorruption = '台本\uEF91O\uEF95\uEFD2.txt';
        const invalidCp932 = 'track\uEF81.txt';

        expect(repairLegacyCp932Filename(mixedCorruption)).toBe(mixedCorruption);
        expect(repairLegacyCp932Filename(invalidCp932)).toBe(invalidCp932);
        expect(repairLegacyCp932Filename('track\uEF41.txt')).toBe('track\uEF41.txt');
        expect(repairLegacyCp932Filename('前編.mp3')).toBe('前編.mp3');
    });

    it('repairs mixed legacy carriers only after an exact structural round trip', () => {
        expect(repairLegacyCp932Filename(LIVE_MIXED_NAME)).toBe('ありがとうございます。.txt');
        expect(sanitizePathSegment(LIVE_MIXED_NAME)).toBe('ありがとうございます。.txt');
        // Real Japanese text beside carriers is a genuine Unicode name, never a
        // Shift-JIS byte stream, so re-decoding it is deliberately declined.
        expect(repairLegacyCp932Filename('音声\uEF82\uEFA0\uEF82\uEFB7.txt'))
            .toBe('音声\uEF82\uEFA0\uEF82\uEFB7.txt');
    });

    it('repairs mixed carriers whose Shift-JIS decode is half-width katakana', () => {
        // Half-width katakana is ordinary doujin track naming, not evidence of a
        // bad repair. Each carrier run is interrupted only by decoding debris.
        expect(repairLegacyCp932Filename('\uEFC4\u05EF\uEFB801.mp3')).toBe('ﾄﾗｯｸ01.mp3');
        expect(repairLegacyCp932Filename('\u04B2\u0749\uEFB9\uEF90\uEFBA.mp3')).toBe('ﾒｲﾝ音声.mp3');
        expect(sanitizePathSegment('\uEFCA\u07B2\u0270\uEFD7\uEFD9.wav')).toBe('ﾊﾞｲﾉｰﾗﾙ.wav');
    });

    it('repairs mixed carrier names carrying as few as two undecodable bytes', () => {
        // 0x8A 0xC3 0x82 0xA6 ("甘え"): the middle pair is valid UTF-8, so only
        // two carriers survive. The old four-carrier floor left this garbled.
        expect(repairLegacyCp932Filename('\uEF8A\u00C2\uEFA6.mp3')).toBe('甘え.mp3');
        expect(sanitizePathSegment('\uEF8A\u00C2\uEFA6.mp3')).toBe('甘え.mp3');
    });

    it('never writes the invisible private-use residue observed on disk', () => {
        // A downloads folder in the wild contained "肪Ƃ܂B.txt": the U+EFxx
        // carriers render as nothing, leaving only the UTF-8 decoding debris.
        expect(visibleCharacters(LIVE_MIXED_NAME)).toBe('肪Ƃ܂B.txt');
        expect(sanitizePathSegment(LIVE_MIXED_NAME)).toBe('ありがとうございます。.txt');
        expect(sanitizePathSegment(LIVE_MIXED_NAME)).not.toContain('肪');
    });

    it('normalizes unrepairable carriers and replacement characters to underscores', () => {
        expect(sanitizePathSegment('台本\uFFFD\uFFFD.txt')).toBe('台本__.txt');
        expect(sanitizePathSegment('track\uEF81.txt')).toBe('track_.txt');
        expect(sanitizePathSegment('台本\uEF91O\uEF95\uEFD2.txt')).toBe('台本_O__.txt');
    });

    it('emits no invisible or undisplayable characters for any legacy input', () => {
        const inputs = [
            LIVE_MIXED_NAME,
            '台本\uFFFD\uFFFD.txt',
            'track\uEF81.txt',
            '音声\uEF82\uEFA0\uEF82\uEFB7.txt',
            'private\uE000use\uF8FF.mp3',
            `broken\uD842pair.mp3`,
            `${'長'.repeat(400)}.flac`,
        ];

        for (const input of inputs) {
            const safe = sanitizePathSegment(input);
            expect(safe).not.toMatch(/[\uE000-\uF8FF\uFFFD]/);
            expect(safe).not.toMatch(/[\uD800-\uDFFF]/u);
            expect(utf8ByteLength(safe)).toBeLessThanOrEqual(200);
        }
    });

    it('truncates on code point boundaries so surrogate pairs are never split', () => {
        const name = `${'a'.repeat(177)}${'\u{20B9F}'.repeat(5)}`;
        const safe = sanitizePathSegment(name);

        // Slicing UTF-16 code units cuts this name mid-pair; the sink APIs take
        // USVString, which rewrites the resulting lone surrogate to U+FFFD.
        expect(name.slice(0, 180)).toMatch(/[\uD800-\uDBFF]$/);
        expect(safe).toBe(`${'a'.repeat(177)}${'\u{20B9F}'.repeat(3)}`);
        expect(safe).not.toMatch(/[\uD800-\uDFFF]/u);
        expect(safe).not.toContain('\uFFFD');
    });

    it('budgets long Japanese names in UTF-8 bytes, not code units', () => {
        const name = `${'あ'.repeat(100)}.txt`;
        const safe = sanitizePathSegment(name);

        // 104 code points fits the code point cap, but 304 bytes exceeds the
        // 255-byte per-component limit on ext4/APFS and would fail at the sink.
        expect([...name].length).toBeLessThan(180);
        expect(utf8ByteLength(name)).toBeGreaterThan(255);
        expect(utf8ByteLength(safe)).toBeLessThanOrEqual(200);
        expect(safe.startsWith('あ')).toBe(true);
        expect(safe.endsWith('.txt')).toBe(true);
    });

    it('reserves deterministic case-insensitive collision names before the final extension', () => {
        const occupied = new Set<string>();
        expect(reserveCollisionFreePath(['Album', 'track.flac'], occupied)).toEqual(['Album', 'track.flac']);
        expect(reserveCollisionFreePath(['album', 'TRACK.FLAC'], occupied)).toEqual(['album', 'TRACK (2).FLAC']);
        expect(reserveCollisionFreePath(['album', 'track.flac'], occupied)).toEqual(['album', 'track (3).flac']);
        expect(canonicalDownloadPath(['ALBUM', 'track.flac'])).toBe('album/track.flac');
    });

    it('preserves a collision suffix when a long filename must be truncated', () => {
        const occupied = new Set<string>();
        const longName = `${'長'.repeat(190)}.flac`;
        const first = reserveCollisionFreePath([longName], occupied);
        const second = reserveCollisionFreePath([longName], occupied);

        expect([...first[0]].length).toBeLessThanOrEqual(180);
        expect(utf8ByteLength(first[0])).toBeLessThanOrEqual(200);
        expect(utf8ByteLength(second[0])).toBeLessThanOrEqual(200);
        expect(second[0]).toMatch(/ \(2\)\.flac$/);
        expect(second).not.toEqual(first);
    });

    it('keeps ASCII names close to the code point cap when bytes allow', () => {
        const asciiName = `${'a'.repeat(400)}.flac`;

        expect(sanitizePathSegment(asciiName)).toBe(`${'a'.repeat(175)}.flac`);
    });

    it('reserves colliding sibling directories once for their whole subtrees', () => {
        const destinations = new DownloadPathReservations();
        const first = destinations.reserveDirectory(['Album?']);
        const second = destinations.reserveDirectory(['Album*']);

        expect(first).toEqual(['Album_']);
        expect(second).toEqual(['Album_ (2)']);
        expect(destinations.reserveFile([...first, 'track.mp3'])).toEqual(['Album_', 'track.mp3']);
        expect(destinations.reserveFile([...second, 'track.mp3']))
            .toEqual(['Album_ (2)', 'track.mp3']);
    });

    it('keeps files and directories from ever occupying the same tree path', () => {
        const fileFirst = new DownloadPathReservations();
        expect(fileFirst.reserveFile(['foo'])).toEqual(['foo']);
        expect(fileFirst.reserveDirectory(['foo'])).toEqual(['foo (2)']);
        expect(fileFirst.reserveFile(['foo (2)', 'bar.mp3'])).toEqual(['foo (2)', 'bar.mp3']);

        const directoryFirst = new DownloadPathReservations();
        expect(directoryFirst.reserveDirectory(['foo'])).toEqual(['foo']);
        expect(directoryFirst.reserveFile(['foo'])).toEqual(['foo (2)']);
        expect(directoryFirst.reserveFile(['foo', 'bar.mp3'])).toEqual(['foo', 'bar.mp3']);
    });

    it('suffixes the first blocked ancestor in an arbitrary requested path', () => {
        const destinations = new DownloadPathReservations();
        destinations.reserveFile(['foo']);

        expect(destinations.reserveFile(['foo', 'bar.mp3'])).toEqual(['foo (2)', 'bar.mp3']);
    });
});
