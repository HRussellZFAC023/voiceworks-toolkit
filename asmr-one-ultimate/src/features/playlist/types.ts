import type { PlaylistEntry, PlaylistMetadata } from '../../api/Playlist';

export interface DiscoveredPlaylist {
    id: string;
    name?: string;
    user_name?: string;
    works_count?: number;
    discovered_at: number;
    source: 'scraped' | 'manual' | 'google' | 'user';
}

/** Result from fetching playlist metadata and works */
export interface FetchedPlaylist extends PlaylistMetadata {
    worksCount: number;
    coverUrl: string;
    discovered: DiscoveredPlaylist;
}

export type PlaylistFetchResult =
    | { ok: true; playlist: FetchedPlaylist }
    | { ok: false; id: string };

export interface GoogleSearchCache {
    timestamp: number;
    playlistIds: string[];
}

export interface CachedPlaylistMetadata {
    id: string;
    name: string;
    user_name: string;
    worksCount: number;
    tags: string[];
    latestWorkId?: string | number;
    coverUrl: string;
    coverUrlResolved?: boolean;
    cachedAt: number;
}

export interface CachedUserPlaylists {
    playlists: PlaylistEntry[];
    userName: string | null;
    cachedAt: number;
}

export interface PlaylistListResponse {
    playlists: PlaylistEntry[];
    pagination?: { currentPage: number; pageSize: number; totalCount: number };
}
