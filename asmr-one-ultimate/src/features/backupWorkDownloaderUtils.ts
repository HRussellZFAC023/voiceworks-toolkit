import type {
    BackupTitleMode,
    BackupPlaylistDownloadItem,
    BackupPlaylistSource,
    BackupWorkDownloadItem,
} from './backupWorkDownloaderTypes';

type TranslateBatch = (texts: string[]) => Promise<string[]>;

interface BackupSourceWork {
    rjCode: string;
    title: string;
}

interface BackupSourcePlaylist {
    id: string | number;
    name: string;
    works: BackupSourceWork[];
}

export interface BackupPlaylistSourceDocument {
    ownPlaylists?: BackupSourcePlaylist[];
    publicPlaylists?: BackupSourcePlaylist[];
}

export interface MappedBackupPlaylistSources {
    playlists: BackupPlaylistDownloadItem[];
    works: BackupWorkDownloadItem[];
}

/** Preserve own/community provenance while deduplicating works shared by playlists. */
export function mapBackupPlaylistSources(doc: BackupPlaylistSourceDocument): MappedBackupPlaylistSources {
    const workMap = new Map<string, BackupWorkDownloadItem>();
    const playlists: BackupPlaylistDownloadItem[] = [];

    const append = (sourcePlaylists: BackupSourcePlaylist[], source: BackupPlaylistSource): void => {
        for (const playlist of sourcePlaylists) {
            const workIds = [...new Set(playlist.works.map(work => work.rjCode).filter(Boolean))];
            for (const work of playlist.works) {
                if (!work.rjCode) continue;
                const existing = workMap.get(work.rjCode);
                if (existing) {
                    existing.playlistIds = [...new Set([...(existing.playlistIds || []), playlist.id])];
                } else {
                    workMap.set(work.rjCode, {
                        id: work.rjCode,
                        title: work.title || work.rjCode,
                        playlistIds: [playlist.id],
                    });
                }
            }
            playlists.push({ id: playlist.id, title: playlist.name, source, workIds });
        }
    };

    append(doc.ownPlaylists || [], 'own');
    append(doc.publicPlaylists || [], 'public');
    return { playlists, works: [...workMap.values()] };
}

/** Resolve only the works a persisted download needs before naming folders/tags. */
export async function resolveDownloadWorkTranslations(
    works: readonly BackupWorkDownloadItem[],
    titleMode: BackupTitleMode,
    translateBatch: TranslateBatch,
): Promise<BackupWorkDownloadItem[]> {
    if (titleMode !== 'translated' && titleMode !== 'original-bracketed-translation') return works.map(work => ({ ...work }));
    const translated = await translateBatch(works.map(work => work.title));
    return works.map((work, index) => ({
        ...work,
        translatedTitle: translated[index] || work.translatedTitle,
    }));
}
