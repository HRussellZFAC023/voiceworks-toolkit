import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchCachedCommunityPlaylist } from '../../src/features/playlist/CommunityPlaylistDetailsService';

afterEach(() => vi.restoreAllMocks());

describe('fetchCachedCommunityPlaylist', () => {
    it('validates and returns the bounded server expansion', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
            version: 1,
            fetchedAt: new Date().toISOString(),
            works: [{ rjCode: 'RJ123456', title: 'Work', durationSeconds: 60, sizeBytes: 1234 }],
        }), { headers: { 'Content-Type': 'application/json' } }));

        await expect(fetchCachedCommunityPlaylist('11111111-1111-4111-8111-111111111111')).resolves.toMatchObject({
            works: [{ rjCode: 'RJ123456', durationSeconds: 60, sizeBytes: 1234 }],
        });
    });

    it('rejects invalid ids before network access', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        await expect(fetchCachedCommunityPlaylist('not-a-playlist')).rejects.toThrow('Invalid playlist id');
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
