import { describe, expect, it } from 'vitest';
import {
    canonicalDownloadPath,
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
});
