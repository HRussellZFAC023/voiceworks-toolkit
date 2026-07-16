import type {
    BackupTitleMode,
    BackupWorkDownloadItem,
} from './backupWorkDownloaderTypes';

type TranslateBatch = (texts: string[]) => Promise<string[]>;

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
