import { describe, expect, it } from 'vitest';
import { mapBackupPlaylistSources, resolveDownloadWorkTranslations } from '../../src/features/backupWorkDownloaderUtils';

describe('mapBackupPlaylistSources', () => {
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

    it('maps own and public playlists to typed sources and deduplicates shared works', () => {
        const mapped = mapBackupPlaylistSources({
            ownPlaylists: [{ id: 'mine', name: 'Mine', works: [
                { rjCode: 'RJ1', title: 'One' }, { rjCode: 'RJ2', title: 'Two' },
            ] }],
            publicPlaylists: [{ id: 'community', name: 'Community', works: [
                { rjCode: 'RJ2', title: 'Two elsewhere' }, { rjCode: 'RJ3', title: 'Three' },
            ] }],
        });

        expect(mapped.playlists).toEqual([
            { id: 'mine', title: 'Mine', source: 'own', workIds: ['RJ1', 'RJ2'] },
            { id: 'community', title: 'Community', source: 'public', workIds: ['RJ2', 'RJ3'] },
        ]);
        expect(mapped.works).toHaveLength(3);
        expect(mapped.works.find(work => work.id === 'RJ2')?.playlistIds).toEqual(['mine', 'community']);
    });
});
