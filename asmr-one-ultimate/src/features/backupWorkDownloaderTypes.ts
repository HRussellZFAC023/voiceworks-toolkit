import type { WorkTitleMode } from './downloads/DownloadDomain';

export type BackupTitleMode = WorkTitleMode;
export type BackupMetadataMode = 'additive' | 'overwrite';
export type BackupFileFilter = 'audio' | 'video' | 'image' | 'text' | 'other';
export type BackupPlaylistSource = 'own' | 'public';
export type BackupPlaylistSourceFilter = 'all' | BackupPlaylistSource;

export interface BackupWorkDownloadItem {
    id: string | number;
    title: string;
    translatedTitle?: string;
    sizeBytes?: number;
    playlistIds?: Array<string | number>;
}

export interface BackupPlaylistDownloadItem {
    id: string | number;
    title: string;
    source: BackupPlaylistSource;
    translatedTitle?: string;
    workIds?: Array<string | number>;
}

export interface BackupDownloaderLabels {
    dialogTitle: string;
    close: string;
    search: string;
    searchPlaceholder: string;
    playlistSource: string;
    sourceAll: string;
    sourceOwn: string;
    sourcePublic: string;
    expandPlaylist: string;
    collapsePlaylist: string;
    selectedSummary: string;
    unknownSize: string;
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
