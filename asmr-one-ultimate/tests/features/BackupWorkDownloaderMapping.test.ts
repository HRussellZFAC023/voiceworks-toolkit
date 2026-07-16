import { describe, expect, it } from 'vitest';
import { resolveDownloadWorkTranslations } from '../../src/features/backupWorkDownloaderUtils';

describe('resolveDownloadWorkTranslations', () => {
    it('waits for selected title translations before returning translated naming data', async () => {
        let release!: (value: string[]) => void;
        const translations = new Promise<string[]>(resolve => { release = resolve; });
        let settled = false;
        const pending = resolveDownloadWorkTranslations(
            [{ id: 'RJ1', title: '作品' }],
            'original-bracketed-translation',
            () => translations,
        ).then(value => { settled = true; return value; });

        await Promise.resolve();
        expect(settled).toBe(false);
        release(['Translated work']);
        await expect(pending).resolves.toEqual([{ id: 'RJ1', title: '作品', translatedTitle: 'Translated work' }]);
    });
});
