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
    const result = works.map(work => ({ ...work }));
    const missing = result
        .map((work, index) => ({ work, index }))
        .filter(({ work }) => !work.translatedTitle || work.translatedTitle === work.title);
    if (!missing.length) return result;
    const translated = await translateBatch(missing.map(({ work }) => work.title));
    missing.forEach(({ work, index }, translatedIndex) => {
        result[index] = {
            ...work,
            translatedTitle: translated[translatedIndex] || work.translatedTitle,
        };
    });
    return result;
}
