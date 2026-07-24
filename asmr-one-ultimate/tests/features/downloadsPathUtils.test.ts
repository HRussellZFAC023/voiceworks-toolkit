import { describe, expect, it } from 'vitest';
import {
    canonicalDownloadPath,
    DownloadPathReservations,
    repairLegacyCp932Filename,
    reserveCollisionFreePath,
    sanitizePathSegment,
    sanitizeRelativePath,
} from '../../src/features/downloads/DownloadPathUtils';

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
        const liveMixedName = '\uEF82\uEFA0\uEF82肪\uEF82Ƃ\uEFA4'
            + '\uEF82\uEFB2\uEF82\uEFB4\uEF82\uEFA2\uEF82܂\uEFB7\uEF81B.txt';

        expect(repairLegacyCp932Filename(liveMixedName)).toBe('ありがとうございます。.txt');
        expect(sanitizePathSegment(liveMixedName)).toBe('ありがとうございます。.txt');
        // Real Unicode beside carriers decodes to half-width mojibake and is
        // deliberately preserved rather than guessed.
        expect(repairLegacyCp932Filename('音声\uEF82\uEFA0\uEF82\uEFB7.txt'))
            .toBe('音声\uEF82\uEFA0\uEF82\uEFB7.txt');
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

        expect(first[0]).toHaveLength(180);
        expect(second[0]).toHaveLength(180);
        expect(second[0]).toMatch(/ \(2\)\.flac$/);
        expect(second).not.toEqual(first);
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
