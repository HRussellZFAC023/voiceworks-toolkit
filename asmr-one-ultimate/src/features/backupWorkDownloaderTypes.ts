import type { WorkTitleMode } from './downloads/DownloadDomain';

export type BackupTitleMode = WorkTitleMode;
export type BackupMetadataMode = 'additive' | 'overwrite';
export type BackupFileFilter = 'audio' | 'video' | 'image' | 'text' | 'other';
export type BackupPlaylistSource = 'own' | 'public';
export type BackupPlaylistSourceFilter = 'site' | BackupPlaylistSource;

export interface BackupWorkDownloadItem {
    id: string | number;
    title: string;
    translatedTitle?: string;
    coverUrl?: string;
    sizeBytes?: number;
    sizeBytesByType?: Partial<Record<BackupFileFilter, number>>;
    unknownSizeCountByType?: Partial<Record<BackupFileFilter, number>>;
    sizeState?: 'loading' | 'resolved' | 'partial' | 'unavailable';
    /** Total playable duration when the upstream response omits byte size. */
    durationSeconds?: number;
    tags?: string[];
    playlistIds?: Array<string | number>;
    /** Render in the direct-search section even when also present in a playlist. */
    directSearchResult?: boolean;
}

export interface BackupPlaylistDownloadItem {
    id: string | number;
    title: string;
    source: BackupPlaylistSource;
    translatedTitle?: string;
    workIds?: Array<string | number>;
    owner?: string;
    worksCount?: number;
    coverUrl?: string;
    tags?: string[];
    loading?: boolean;
    error?: string;
}

export interface BackupDownloadProgress {
    phase: 'recovering' | 'discovering' | 'translating' | 'downloading' | 'converting' | 'paused' | 'complete' | 'failed';
    current: number;
    total: number;
    completedBytes?: number;
    totalBytes?: number;
    conversionRatio?: number;
    label?: string;
}

export interface BackupDownloaderLabels {
    dialogTitle: string;
    close: string;
    search: string;
    searchPlaceholder: string;
    searchAll: string;
    searchAllLoading: string;
    searchResults: string;
    searchFailed: string;
    playlistSource: string;
    sourceAll: string;
    sourceOwn: string;
    sourcePublic: string;
    selectAll: string;
    clearAll: string;
    filterTags: string;
    allTags: string;
    playlistOwner: string;
    playlistWorks: string;
    loading: string;
    loadFailed: string;
    options: string;
    progress: string;
    pause: string;
    resume: string;
    alreadyRunning: string;
    resumableDownloads: string;
    expandPlaylist: string;
    collapsePlaylist: string;
    selectedSummary: string;
    unknownSize: string;
    partialSize: string;
    estimatedOpusSize: string;
    noResults: string;
    fileTypes: string;
    audio: string;
    video: string;
    images: string;
    text: string;
    other: string;
    filenameTitle: string;
    titleOriginal: string;
    titleTranslated: string;
    titleOriginalTranslated: string;
    titleNone: string;
    convertToOpus: string;
    opusBitrate: string;
    metadata: string;
    metadataAdditive: string;
    metadataOverwrite: string;
    metadataAdditiveHint: string;
    metadataOverwriteHint: string;
    includeArtwork: string;
    includeArtworkHint: string;
    cancel: string;
    start: string;
}

export interface BackupDownloadProfile {
    labels: BackupDownloaderLabels;
    selectedWorkIds?: Array<string | number>;
    filters: Record<BackupFileFilter, boolean>;
    titleMode: BackupTitleMode;
    convertToOpus: boolean;
    opusBitrate: number;
    metadataMode: BackupMetadataMode;
    includeArtwork: boolean;
}

export interface BackupDownloadState {
    selectedWorkIds: Array<string | number>;
    filters: Record<BackupFileFilter, boolean>;
    titleMode: BackupTitleMode;
    convertToOpus: boolean;
    opusBitrate: number;
    metadataMode: BackupMetadataMode;
    includeArtwork: boolean;
}
