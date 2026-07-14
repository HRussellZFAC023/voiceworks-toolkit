import { describe, expect, it } from 'vitest';
import {
    discoverDownloadManifest,
    type DownloadTreeNode,
} from '../../src/features/downloads/DownloadManifest';
import { classifyDownloadMedia } from '../../src/features/downloads/DownloadMediaClassifier';

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
