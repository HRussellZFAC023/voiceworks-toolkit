import { describe, expect, it } from 'vitest';
import { mapBackupPlaylistSources } from '../../src/features/backupWorkDownloaderUtils';

describe('mapBackupPlaylistSources', () => {
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
