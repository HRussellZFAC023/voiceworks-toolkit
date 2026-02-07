import { describe, it, expect } from 'vitest';

import {
    collectTracks,
    flattenWork,
    getTrackKey,
    filterAudioTracks,
    resolveAudioSource,
    isHLSUrl,
    parseDuration,
    formatDuration,
    calculateFolderScore,
    selectBestFolder,
    shuffleArray,
    shuffleInPlace,
} from '../../src/core/WorkUtils';

describe('WorkUtils', () => {
    describe('collectTracks', () => {
        it('should collect tracks from flat structure', () => {
            const work = {
                tracks: [
                    { hash: 'a', title: 'Track 1' },
                    { hash: 'b', title: 'Track 2' },
                ],
            };
            const tracks = collectTracks(work as any);
            expect(tracks).toHaveLength(2);
        });

        it('should collect tracks from nested folders', () => {
            const work = {
                dirs: [
                    {
                        name: 'Folder 1',
                        tracks: [{ hash: 'a', title: 'Track 1' }],
                    },
                    {
                        name: 'Folder 2',
                        tracks: [{ hash: 'b', title: 'Track 2' }],
                    },
                ],
            };
            const tracks = collectTracks(work as any);
            expect(tracks).toHaveLength(2);
        });

        it('should handle deeply nested structures', () => {
            const work = {
                dirs: [
                    {
                        name: 'Level 1',
                        dirs: [
                            {
                                name: 'Level 2',
                                tracks: [{ hash: 'deep', title: 'Deep Track' }],
                            },
                        ],
                    },
                ],
            };
            const tracks = collectTracks(work as any);
            expect(tracks).toHaveLength(1);
            expect(tracks[0].title).toBe('Deep Track');
        });

        it('should handle children property', () => {
            const work = {
                children: [
                    {
                        name: 'Child Folder',
                        tracks: [{ hash: 'c', title: 'Child Track' }],
                    },
                ],
            };
            const tracks = collectTracks(work as any);
            expect(tracks).toHaveLength(1);
        });
    });

    describe('flattenWork', () => {
        it('should deduplicate tracks by hash', () => {
            const work = {
                tracks: [
                    { hash: 'same', title: 'Track 1' },
                    { hash: 'same', title: 'Track 1 Duplicate' },
                    { hash: 'different', title: 'Track 2' },
                ],
            };
            const tracks = flattenWork(work as any);
            expect(tracks).toHaveLength(2);
        });

        it('should skip non-audio tracks', () => {
            const work = {
                tracks: [
                    { hash: 'a', title: 'Audio', is_audio: true },
                    { hash: 'b', title: 'Image', is_audio: false },
                ],
            };
            const tracks = flattenWork(work as any);
            expect(tracks).toHaveLength(1);
            expect(tracks[0].title).toBe('Audio');
        });
    });

    describe('getTrackKey', () => {
        it('should prefer hash', () => {
            expect(getTrackKey({ hash: 'h', mediaStreamUrl: 'url', title: 't' } as any)).toBe('h');
        });

        it('should fallback to mediaStreamUrl', () => {
            expect(getTrackKey({ mediaStreamUrl: 'url', title: 't' } as any)).toBe('url');
        });

        it('should fallback to title', () => {
            expect(getTrackKey({ title: 't' } as any)).toBe('t');
        });

        it('should return null for empty track', () => {
            expect(getTrackKey({} as any)).toBeNull();
        });
    });

    describe('filterAudioTracks', () => {
        it('should keep audio tracks', () => {
            const tracks = [
                { hash: 'a', is_audio: true },
                { hash: 'b', is_audio: false },
                { hash: 'c' }, // undefined is_audio should be kept
            ];
            const filtered = filterAudioTracks(tracks as any);
            expect(filtered).toHaveLength(2);
        });
    });

    describe('resolveAudioSource', () => {
        it('should resolve mediaDownloadUrl first', () => {
            const track = {
                mediaDownloadUrl: 'download.mp3',
                mediaStreamUrl: 'stream.m3u8',
            };
            expect(resolveAudioSource(track as any)).toBe('download.mp3');
        });

        it('should prefer non-HLS when requested', () => {
            const track = {
                src: 'stream.m3u8',
                mediaDownloadUrl: 'download.mp3',
            };
            expect(resolveAudioSource(track as any, { preferNonHLS: true })).toBe('download.mp3');
        });

        it('should return null for empty track', () => {
            expect(resolveAudioSource({} as any)).toBeNull();
        });
    });

    describe('isHLSUrl', () => {
        it('should detect m3u8 extension', () => {
            expect(isHLSUrl('http://example.com/stream.m3u8')).toBe(true);
            expect(isHLSUrl('http://example.com/stream.m3u8?token=abc')).toBe(true);
        });

        it('should detect /hls/ path', () => {
            expect(isHLSUrl('http://example.com/hls/stream')).toBe(true);
        });

        it('should return false for non-HLS URLs', () => {
            expect(isHLSUrl('http://example.com/audio.mp3')).toBe(false);
            expect(isHLSUrl('http://example.com/audio.wav')).toBe(false);
        });
    });

    describe('parseDuration', () => {
        it('should parse hours and minutes', () => {
            expect(parseDuration('2hr 30min')).toBe(2 * 3600 + 30 * 60);
        });

        it('should parse minutes and seconds', () => {
            expect(parseDuration('45min 30sec')).toBe(45 * 60 + 30);
        });

        it('should parse single unit', () => {
            expect(parseDuration('90min')).toBe(90 * 60);
        });

        it('should handle decimal values', () => {
            expect(parseDuration('1.5hr')).toBe(1.5 * 3600);
        });

        it('should return 0 for empty string', () => {
            expect(parseDuration('')).toBe(0);
        });
    });

    describe('formatDuration', () => {
        it('should format as MM:SS', () => {
            expect(formatDuration(90)).toBe('1:30');
        });

        it('should format with leading zeros', () => {
            expect(formatDuration(65)).toBe('1:05');
        });

        it('should format hours', () => {
            expect(formatDuration(3665)).toBe('1:01:05');
        });

        it('should return --:-- for zero', () => {
            expect(formatDuration(0)).toBe('--:--');
        });

        it('should return --:-- for negative', () => {
            expect(formatDuration(-10)).toBe('--:--');
        });
    });

    describe('calculateFolderScore', () => {
        it('should penalize sample folders', () => {
            const sampleScore = calculateFolderScore('Sample', 5, '30min', false);
            const normalScore = calculateFolderScore('Main', 5, '30min', false);
            expect(sampleScore).toBeLessThan(normalScore);
        });

        it('should penalize cover folders', () => {
            const coverScore = calculateFolderScore('cover', 5, '30min', false);
            const normalScore = calculateFolderScore('Main', 5, '30min', false);
            expect(coverScore).toBeLessThan(normalScore);
        });

        it('should penalize SE folders', () => {
            const seScore = calculateFolderScore('SE Version', 5, '30min', false);
            const normalScore = calculateFolderScore('Normal Version', 5, '30min', false);
            expect(seScore).toBeLessThan(normalScore);
        });

        it('should boost preferred formats', () => {
            const wavScore = calculateFolderScore('wav', 5, '30min', false);
            const mp3Score = calculateFolderScore('mp3', 5, '30min', false);
            expect(wavScore).toBeGreaterThan(mp3Score);
        });
    });

    describe('selectBestFolder', () => {
        it('should select folder with highest score', () => {
            const folders = [
                { name: 'Sample', tracks: [{ hash: 'a' }] },
                { name: 'Main wav', tracks: [{ hash: 'b' }] },
            ];
            const best = selectBestFolder(folders as any);
            expect(best?.name).toBe('Main wav');
        });

        it('should return null for empty array', () => {
            expect(selectBestFolder([])).toBeNull();
        });
    });

    describe('shuffleArray', () => {
        it('should return array of same length', () => {
            const arr = [1, 2, 3, 4, 5];
            const shuffled = shuffleArray(arr);
            expect(shuffled).toHaveLength(5);
        });

        it('should contain same elements', () => {
            const arr = [1, 2, 3, 4, 5];
            const shuffled = shuffleArray(arr);
            expect(shuffled.sort()).toEqual(arr.sort());
        });

        it('should not modify original array', () => {
            const arr = [1, 2, 3, 4, 5];
            const original = [...arr];
            shuffleArray(arr);
            expect(arr).toEqual(original);
        });
    });

    describe('shuffleInPlace', () => {
        it('should modify original array', () => {
            // Use a large array to ensure shuffle happens
            const arr = Array.from({ length: 100 }, (_, i) => i);
            const original = [...arr];
            shuffleInPlace(arr);
            // Very unlikely to be in same order
            expect(arr).not.toEqual(original);
        });
    });
});
