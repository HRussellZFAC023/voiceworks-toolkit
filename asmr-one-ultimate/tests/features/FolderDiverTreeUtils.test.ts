import { describe, expect, it } from 'vitest';
import {
    findFolderBySegment,
    getFolderSegmentName,
    hasDirectPlayableMedia,
    resolveNodesAtPath,
} from '../../src/features/folderDiverTreeUtils';
import type { TrackFolder, TrackItem, TracksResponse } from '../../src/types/api';

function folder(title: string, children: Array<TrackFolder | TrackItem> = []): TrackFolder {
    return { type: 'folder', title, children };
}

function audio(title: string): TrackItem {
    return { type: 'audio', hash: title, title };
}

function other(title: string): TrackItem {
    return { type: 'other', hash: title, title };
}

describe('folderDiverTreeUtils', () => {
    it('resolves path segments to child nodes', () => {
        const tree: TracksResponse = [folder('Root', [folder('Child', [audio('track.mp3')])])];
        const nodes = resolveNodesAtPath(tree, ['Root', 'Child']);
        expect(nodes).toHaveLength(1);
        expect(nodes[0].type).toBe('audio');
    });

    it('returns root by default when segment is missing', () => {
        const tree: TracksResponse = [folder('Root', [audio('track.mp3')])];
        const nodes = resolveNodesAtPath(tree, ['Missing']);
        expect(nodes).toBe(tree);
    });

    it('returns empty array when segment is missing and fallback is disabled', () => {
        const tree: TracksResponse = [folder('Root', [audio('track.mp3')])];
        const nodes = resolveNodesAtPath(tree, ['Missing'], false);
        expect(nodes).toEqual([]);
    });

    it('finds folder by segment title', () => {
        const nodes: Array<TrackFolder | TrackItem> = [folder('Drama CD'), audio('track.mp3')];
        const found = findFolderBySegment(nodes, 'Drama CD');
        expect(found?.title).toBe('Drama CD');
        expect(getFolderSegmentName(found!)).toBe('Drama CD');
    });

    it('detects direct playable media from audio type and media extensions', () => {
        expect(hasDirectPlayableMedia([audio('track.flac')])).toBe(true);
        expect(hasDirectPlayableMedia([other('movie.mp4')])).toBe(true);
        expect(hasDirectPlayableMedia([other('cover.jpg')])).toBe(false);
    });
});
