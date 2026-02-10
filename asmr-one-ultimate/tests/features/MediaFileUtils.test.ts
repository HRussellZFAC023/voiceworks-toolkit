import { describe, expect, it } from 'vitest';
import {
    findMatchingMediaItem,
    getFileExtension,
    isImageExtension,
    isPdfExtension,
    isTextExtension,
    isVideoExtension,
    normalizeMediaMatchString,
    stripTrailingTranslationLabel,
} from '../../src/features/media/mediaFileUtils';

describe('mediaFileUtils', () => {
    it('detects media file extensions consistently', () => {
        expect(getFileExtension('image.JPG')).toBe('.jpg');
        expect(isImageExtension('.jpg')).toBe(true);
        expect(isVideoExtension('.mkv')).toBe(true);
        expect(isPdfExtension('.pdf')).toBe(true);
        expect(isTextExtension('.vtt')).toBe(true);
        expect(isImageExtension('.zip')).toBe(false);
    });

    it('strips trailing translation labels from titles', () => {
        expect(stripTrailingTranslationLabel('track01.mp3 (Translation)')).toBe('track01.mp3');
        expect(stripTrailingTranslationLabel('track01.mp3')).toBe('track01.mp3');
    });

    it('normalizes media match strings', () => {
        expect(normalizeMediaMatchString('  Track_01.Final.MP3 (EN)  ')).toBe('track 01 final');
        expect(normalizeMediaMatchString('ボイス-01.wav')).toBe('ボイス 01');
    });

    it('findMatchingMediaItem prefers hash, then normalized title', () => {
        const list = [
            { hash: 'a', title: 'voice_01.mp3' },
            { hash: 'b', title: 'voice_02.mp3' },
        ];

        expect(findMatchingMediaItem({ hash: 'b', title: 'voice_02.mp3' }, list)?.hash).toBe('b');
        expect(findMatchingMediaItem({ hash: '', title: 'voice 01 (translation)' }, list)?.hash).toBe('a');
    });

    it('ignores delegated pseudo-hash and falls back to title matching', () => {
        const list = [
            { hash: 'real-1', title: 'Binaural_Track_01.flac' },
            { hash: 'real-2', title: 'Binaural_Track_02.flac' },
        ];

        const match = findMatchingMediaItem(
            { hash: '__delegated_123', title: 'Binaural Track 02 (EN)' },
            list,
        );
        expect(match?.hash).toBe('real-2');
    });
});
