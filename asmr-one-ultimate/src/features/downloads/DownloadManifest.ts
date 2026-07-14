import type { DownloadMediaCategory } from './DownloadDomain';
import { classifyDownloadMedia } from './DownloadMediaClassifier';
import { reserveCollisionFreePath, sanitizeRelativePath } from './DownloadPathUtils';

export type DownloadSourceUrlKind =
    | 'download'
    | 'stream'
    | 'low-quality-stream'
    | 'file'
    | 'source'
    | 'url';

export interface DownloadSourceUrl {
    kind: DownloadSourceUrlKind;
    url: string;
}

/** Typed superset of current v2 and legacy asmr.one work-tree node variants. */
export interface DownloadTreeNode {
    type?: string;
    title?: string;
    name?: string;
    hash?: string;
    size?: number | string;
    fileSize?: number | string;
    file_size?: number | string;
    children?: readonly DownloadTreeNode[];
    dirs?: readonly DownloadTreeNode[];
    tracks?: readonly DownloadTreeNode[];
    mediaDownloadUrl?: string;
    media_download_url?: string;
    mediaStreamUrl?: string;
    media_stream_url?: string;
    streamLowQualityUrl?: string;
    stream_low_quality_url?: string;
    stream_url?: string;
    file_url?: string;
    src?: string;
    url?: string;
}

export interface DownloadManifestEntry {
    id: string;
    hash?: string;
    sourceTitle: string;
    declaredType?: string;
    category: DownloadMediaCategory;
    size?: number;
    /** Original host path, retained for display and metadata decisions. */
    sourcePath: string[];
    /** Portable, collision-free destination path. */
    relativePath: string[];
    sourceUrls: DownloadSourceUrl[];
    primaryUrl?: string;
}

export interface DownloadManifest {
    entries: DownloadManifestEntry[];
    totalKnownBytes: number;
    unknownSizeCount: number;
}

const URL_FIELDS: ReadonlyArray<readonly [keyof DownloadTreeNode, DownloadSourceUrlKind]> = [
    ['mediaDownloadUrl', 'download'],
    ['media_download_url', 'download'],
    ['mediaStreamUrl', 'stream'],
    ['media_stream_url', 'stream'],
    ['stream_url', 'stream'],
    ['streamLowQualityUrl', 'low-quality-stream'],
    ['stream_low_quality_url', 'low-quality-stream'],
    ['file_url', 'file'],
    ['src', 'source'],
    ['url', 'url'],
];

function nodeTitle(node: DownloadTreeNode): string {
    return (node.title || node.name || node.hash || 'untitled').trim() || 'untitled';
}

function childrenOf(node: DownloadTreeNode): readonly DownloadTreeNode[] {
    const result: DownloadTreeNode[] = [];
    const seen = new Set<DownloadTreeNode>();
    for (const group of [node.children, node.dirs, node.tracks]) {
        for (const child of group ?? []) {
            if (seen.has(child)) continue;
            seen.add(child);
            result.push(child);
        }
    }
    return result;
}

function isFolder(node: DownloadTreeNode): boolean {
    const type = node.type?.toLowerCase();
    return type === 'folder' || type === 'directory'
        || childrenOf(node).length > 0;
}

function sourceUrlsOf(node: DownloadTreeNode): DownloadSourceUrl[] {
    const seen = new Set<string>();
    const urls: DownloadSourceUrl[] = [];
    for (const [field, kind] of URL_FIELDS) {
        const value = node[field];
        if (typeof value !== 'string') continue;
        const url = value.trim();
        if (!url || seen.has(url)) continue;
        seen.add(url);
        urls.push({ kind, url });
    }
    return urls;
}

function declaredSize(node: DownloadTreeNode): number | undefined {
    const raw = node.size ?? node.fileSize ?? node.file_size;
    if (raw === undefined || raw === null || raw === '') return undefined;
    const size = Number(raw);
    return Number.isFinite(size) && size >= 0 ? size : undefined;
}

function stableFallbackId(sourcePath: readonly string[], urls: readonly DownloadSourceUrl[]): string {
    const input = `${sourcePath.join('\u001f')}\u001e${urls.map((item) => item.url).join('\u001f')}`;
    let hash = 0x811c9dc5;
    for (let index = 0; index < input.length; index += 1) {
        hash ^= input.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return `path-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function discoverDownloadManifest(tree: readonly DownloadTreeNode[]): DownloadManifest {
    const entries: DownloadManifestEntry[] = [];
    const occupied = new Set<string>();

    const visit = (node: DownloadTreeNode, folders: readonly string[]): void => {
        const title = nodeTitle(node);
        if (isFolder(node)) {
            const nextFolders = [...folders, title];
            for (const child of childrenOf(node)) visit(child, nextFolders);
            return;
        }

        const sourcePath = [...folders, title];
        const sourceUrls = sourceUrlsOf(node);
        const size = declaredSize(node);
        entries.push({
            id: node.hash?.trim() || stableFallbackId(sourcePath, sourceUrls),
            hash: node.hash?.trim() || undefined,
            sourceTitle: title,
            declaredType: node.type,
            category: classifyDownloadMedia(title, node.type),
            size,
            sourcePath,
            relativePath: reserveCollisionFreePath(sanitizeRelativePath(sourcePath), occupied),
            sourceUrls,
            primaryUrl: sourceUrls[0]?.url,
        });
    };

    for (const node of tree) visit(node, []);
    return {
        entries,
        totalKnownBytes: entries.reduce((total, entry) => total + (entry.size ?? 0), 0),
        unknownSizeCount: entries.filter((entry) => entry.size === undefined).length,
    };
}
