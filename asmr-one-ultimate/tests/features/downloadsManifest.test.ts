import { describe, expect, it } from 'vitest';
import {
    discoverDownloadManifest,
    type DownloadTreeNode,
} from '../../src/features/downloads/DownloadManifest';
import { classifyDownloadMedia } from '../../src/features/downloads/DownloadMediaClassifier';
import { repairLegacyCp932Filename } from '../../src/features/downloads/DownloadPathUtils';

describe('download manifest discovery', () => {
    it('recursively flattens folders while preserving source paths, sizes, identities, and URL variants', () => {
        const tree: DownloadTreeNode[] = [{
            type: 'folder',
            title: 'Disc 1',
            children: [{
                type: 'folder',
                title: '本編',
                children: [{
                    type: 'audio',
                    hash: 'track-hash',
                    title: '01 添い寝.flac',
                    size: 123456,
                    mediaDownloadUrl: '/download/track-hash',
                    media_download_url: '/download/track-hash',
                    mediaStreamUrl: '/media/stream/track-hash',
                    stream_low_quality_url: '/media/low/track-hash',
                    src: '/legacy/track-hash',
                }],
            }],
        }, {
            type: 'directory',
            name: 'Extras',
            tracks: [{
                type: 'image',
                title: 'cover.jpg',
                file_size: '4096',
                file_url: '/files/cover.jpg',
            }],
        }];

        const manifest = discoverDownloadManifest(tree);

        expect(manifest.entries).toHaveLength(2);
        expect(manifest.totalKnownBytes).toBe(127552);
        expect(manifest.unknownSizeCount).toBe(0);
        expect(manifest.entries[0]).toMatchObject({
            id: 'track-hash',
            hash: 'track-hash',
            category: 'audio',
            size: 123456,
            sourcePath: ['Disc 1', '本編', '01 添い寝.flac'],
            relativePath: ['Disc 1', '本編', '01 添い寝.flac'],
            primaryUrl: '/download/track-hash',
        });
        expect(manifest.entries[0].sourceUrls).toEqual([
            { kind: 'download', url: '/download/track-hash' },
            { kind: 'stream', url: '/media/stream/track-hash' },
            { kind: 'low-quality-stream', url: '/media/low/track-hash' },
            { kind: 'source', url: '/legacy/track-hash' },
        ]);
        expect(manifest.entries[1]).toMatchObject({
            category: 'image',
            size: 4096,
            sourcePath: ['Extras', 'cover.jpg'],
        });
    });

    it('creates stable fallback identities and collision-free portable paths', () => {
        const tree: DownloadTreeNode[] = [
            { type: 'audio', title: 'Track?.mp3', url: '/a' },
            { type: 'audio', title: 'track*.MP3', url: '/b' },
            { type: 'text', title: 'notes.txt' },
        ];

        const first = discoverDownloadManifest(tree);
        const second = discoverDownloadManifest(tree);

        expect(first.entries.map((entry) => entry.id)).toEqual(second.entries.map((entry) => entry.id));
        expect(first.entries.map((entry) => entry.relativePath)).toEqual([
            ['Track_.mp3'],
            ['track_ (2).MP3'],
            ['notes.txt'],
        ]);
        expect(first.unknownSizeCount).toBe(3);
    });

    it('retains leaf files that carry empty serializer child arrays', () => {
        const manifest = discoverDownloadManifest([{
            type: 'audio',
            title: 'leaf.mp3',
            hash: 'leaf',
            children: [],
            mediaStreamUrl: '/stream/leaf',
        }]);

        expect(manifest.entries).toHaveLength(1);
        expect(manifest.entries[0]).toMatchObject({ id: 'leaf', sourceTitle: 'leaf.mp3' });
    });

    it('treats a host-declared zero as unknown rather than rejecting real bytes as oversized', () => {
        const manifest = discoverDownloadManifest([{
            type: 'audio',
            title: 'unknown.wav',
            hash: 'unknown-size',
            size: 0,
            mediaDownloadUrl: '/download/unknown-size',
        }]);

        expect(manifest.entries[0].size).toBeUndefined();
        expect(manifest.totalKnownBytes).toBe(0);
        expect(manifest.unknownSizeCount).toBe(1);
    });

    it('never promotes a low-quality preview to the full-folder primary source', () => {
        const manifest = discoverDownloadManifest([{
            type: 'audio',
            hash: 'low-only',
            title: 'preview-only.mp3',
            streamLowQualityUrl: '/media/low/only',
        }, {
            type: 'audio',
            hash: 'low-first',
            title: 'full-source.wav',
            streamLowQualityUrl: '/media/low/first',
            src: '/media/full/later',
            url: '/media/full/alternate',
        }]);

        expect(manifest.entries[0]).toMatchObject({
            id: 'low-only',
            primaryUrl: undefined,
            sourceUrls: [{ kind: 'low-quality-stream', url: '/media/low/only' }],
        });
        expect(manifest.entries[1]).toMatchObject({
            id: 'low-first',
            primaryUrl: '/media/full/later',
            sourceUrls: [
                { kind: 'low-quality-stream', url: '/media/low/first' },
                { kind: 'source', url: '/media/full/later' },
                { kind: 'url', url: '/media/full/alternate' },
            ],
        });
    });

    it('repairs confidence-safe legacy CP932 byte carriers only in destination names', () => {
        const manifest = discoverDownloadManifest([{
            type: 'folder',
            title: '\uEF91O\uEF95\uEFD2',
            children: [{
                type: 'audio',
                hash: 'legacy-name',
                title: 'UB-001\uEF91O\uEF95\uEFD2.mp3',
                mediaDownloadUrl: '/download/legacy-name',
            }, {
                type: 'audio',
                hash: 'native-name',
                title: 'UB-001前編.mp3',
                mediaDownloadUrl: '/download/native-name',
            }],
        }]);

        expect(repairLegacyCp932Filename('\uEF91O\uEF95\uEFD2')).toBe('前編');
        expect(manifest.entries[0].sourcePath).toEqual([
            '\uEF91O\uEF95\uEFD2',
            'UB-001\uEF91O\uEF95\uEFD2.mp3',
        ]);
        expect(manifest.entries[0].relativePath).toEqual([
            '前編',
            'UB-001前編.mp3',
        ]);
        expect(manifest.entries[1].relativePath).toEqual([
            '前編',
            'UB-001前編 (2).mp3',
        ]);
    });

    it('preserves names whose lost replacement characters cannot be decoded safely', () => {
        expect(repairLegacyCp932Filename('台本\uFFFD\uFFFD.txt')).toBe('台本\uFFFD\uFFFD.txt');
        expect(repairLegacyCp932Filename('台本\uEF91O\uEF95\uEFD2.txt')).toBe('台本\uEF91O\uEF95\uEFD2.txt');
    });

    it('keeps colliding sanitized sibling folders distinct for every child', () => {
        const manifest = discoverDownloadManifest([{
            type: 'folder',
            title: 'Disc?',
            children: [
                { type: 'audio', title: 'track.mp3', url: '/first' },
                { type: 'text', title: 'notes.txt', url: '/first-notes' },
            ],
        }, {
            type: 'folder',
            title: 'Disc*',
            children: [
                { type: 'audio', title: 'track.mp3', url: '/second' },
                { type: 'text', title: 'notes.txt', url: '/second-notes' },
            ],
        }]);

        expect(manifest.entries.map(entry => entry.relativePath)).toEqual([
            ['Disc_', 'track.mp3'],
            ['Disc_', 'notes.txt'],
            ['Disc_ (2)', 'track.mp3'],
            ['Disc_ (2)', 'notes.txt'],
        ]);
    });

    it('separates file and directory destinations regardless of source order', () => {
        const manifest = discoverDownloadManifest([
            { type: 'text', title: 'foo', url: '/file' },
            {
                type: 'folder',
                title: 'foo',
                children: [{ type: 'audio', title: 'bar.mp3', url: '/nested' }],
            },
        ]);

        expect(manifest.entries.map(entry => entry.relativePath)).toEqual([
            ['foo'],
            ['foo (2)', 'bar.mp3'],
        ]);
    });
});

describe('download media classification', () => {
    it('uses a recognised extension before a conflicting host type', () => {
        expect(classifyDownloadMedia('cover.JPG', 'audio')).toBe('image');
        expect(classifyDownloadMedia('voice.opus', 'text')).toBe('audio');
        expect(classifyDownloadMedia('script.vtt', 'image')).toBe('text');
    });

    it('falls back to host type only when the extension is absent or unknown', () => {
        expect(classifyDownloadMedia('extensionless', 'video')).toBe('video');
        expect(classifyDownloadMedia('archive.bin', 'audio')).toBe('audio');
        expect(classifyDownloadMedia('archive.bin', 'folder')).toBe('unknown');
    });
});
