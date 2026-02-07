/**
 * FlatView utility functions - shared between FlatViewPanel.vue and tests.
 */

import type { TrackFolder, TrackItem, TracksResponse } from '../types/api';

/** A flattened item with folder path context */
export interface FlatItem {
    type: 'audio' | 'image' | 'text' | 'other';
    hash: string;
    title: string;
    folderPath: string;
    mediaStreamUrl?: string;
    mediaDownloadUrl?: string;
    workTitle?: string;
    duration?: number;
    /** Original item reference for Vuex dispatch */
    raw: TrackItem;
}

/**
 * Recursively flatten a TracksResponse tree into a flat list of items,
 * recording each item's folder path for display.
 */
export function flattenTree(nodes: TracksResponse, parentPath = ''): FlatItem[] {
    const result: FlatItem[] = [];
    for (const node of nodes) {
        if (node.type === 'folder') {
            const folder = node as TrackFolder;
            const folderPath = parentPath ? `${parentPath} / ${folder.title}` : folder.title;
            result.push(...flattenTree(folder.children, folderPath));
        } else {
            const item = node as TrackItem;
            result.push({
                type: item.type,
                hash: item.hash,
                title: item.title,
                folderPath: parentPath,
                mediaStreamUrl: item.mediaStreamUrl,
                mediaDownloadUrl: item.mediaDownloadUrl,
                workTitle: item.workTitle,
                duration: (item as any).duration,
                raw: item,
            });
        }
    }
    return result;
}
