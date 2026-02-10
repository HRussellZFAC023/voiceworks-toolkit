import type { TrackFolder, TrackItem, TracksResponse } from '../types/api';

export const AUDIO_EXTENSIONS = ['.wav', '.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wma'];
export const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v'];

type FolderWithAlias = TrackFolder & { name?: string };

export function getFolderSegmentName(folder: TrackFolder): string {
    const alias = (folder as FolderWithAlias).name;
    return (folder.title || alias || '').trim();
}

export function findFolderBySegment(
    nodes: Array<TrackFolder | TrackItem>,
    segment: string,
): TrackFolder | undefined {
    return nodes.find(
        (node): node is TrackFolder => node.type === 'folder' && getFolderSegmentName(node) === segment,
    );
}

export function resolveNodesAtPath(
    tree: TracksResponse,
    path: string[],
    fallbackToRoot = true,
): Array<TrackFolder | TrackItem> {
    let currentNodes: Array<TrackFolder | TrackItem> = tree;
    for (const segment of path) {
        const folder = findFolderBySegment(currentNodes, segment);
        if (!folder) {
            return fallbackToRoot ? tree : [];
        }
        currentNodes = folder.children;
    }
    return currentNodes;
}

export function hasDirectPlayableMedia(nodes: Array<TrackFolder | TrackItem>): boolean {
    return nodes.some((node) => {
        if (node.type === 'audio') return true;
        const title = ((node as TrackItem).title || '').toLowerCase();
        return AUDIO_EXTENSIONS.some((ext) => title.endsWith(ext) || title.includes(ext))
            || VIDEO_EXTENSIONS.some((ext) => title.endsWith(ext));
    });
}
