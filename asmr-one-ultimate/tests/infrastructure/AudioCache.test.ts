import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AudioCache } from '../../src/infrastructure/AudioCache';
import { Config } from '../../src/core/Utils';

// Mock IDB
const mockDB = {
    get: vi.fn(),
    put: vi.fn().mockResolvedValue(undefined),
    createObjectStore: vi.fn(() => ({ createIndex: vi.fn() })),
};

vi.mock('idb', () => ({
    openDB: vi.fn(() => Promise.resolve(mockDB))
}));

describe('AudioCache', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.clearAllMocks();
        mockDB.put.mockResolvedValue(undefined);
        AudioCache.objectUrls.clear();
        document.body.innerHTML = '';
    });

    // =========================================================================
    // getBlob
    // =========================================================================
    it('should return null on cache miss', async () => {
        const cache = new AudioCache();
        mockDB.get.mockResolvedValue(undefined);

        const result = await cache.getBlob('http://example.com/audio.mp3');
        expect(result).toBeNull();
    });

    it('should return blob on cache hit and update lastPlayed', async () => {
        const cache = new AudioCache();
        const mockEntry = { blob: new Blob(['data']), lastPlayed: 0 };
        mockDB.get.mockResolvedValue(mockEntry);

        const result = await cache.getBlob('http://example.com/audio.mp3');
        expect(result).toBe(mockEntry.blob);
        expect(mockDB.put).toHaveBeenCalled(); // Update lastPlayed
    });

    // =========================================================================
    // cacheAudio
    // =========================================================================
    it('should cache audio', async () => {
        const cache = new AudioCache();
        const blob = new Blob(['data']);

        await cache.cacheAudio('url', blob);
        expect(mockDB.put).toHaveBeenCalledWith('blobs', expect.objectContaining({
            url: 'url',
            blob: blob
        }));
    });

    describe('automatic caching policy', () => {
        const track = {
            type: 'audio' as const,
            hash: 'track-a',
            title: 'Track A',
            mediaStreamUrl: 'https://raw.kiko-play-niptan.one/audio/track-a.mp3',
            mediaDownloadUrl: 'https://api.asmr.one/api/media/download/track-a',
        };

        it('does not start a full-track background download by default', async () => {
            vi.spyOn(Config, 'get').mockImplementation((key) => key === 'autoCacheAudio' ? false : 5 as any);
            mockDB.get.mockResolvedValue(undefined);
            const cache = new AudioCache();
            const backgroundDownload = vi.spyOn(cache as any, 'backgroundDownload').mockImplementation(() => {});

            await cache.interceptPlay({ ...track });

            expect(backgroundDownload).not.toHaveBeenCalled();
        });

        it('starts a background download only after explicit opt-in', async () => {
            vi.spyOn(Config, 'get').mockImplementation((key) => key === 'autoCacheAudio' ? true : 5 as any);
            mockDB.get.mockResolvedValue(undefined);
            const cache = new AudioCache();
            const backgroundDownload = vi.spyOn(cache as any, 'backgroundDownload').mockImplementation(() => {});

            await cache.interceptPlay({ ...track });

            expect(backgroundDownload).toHaveBeenCalledTimes(1);
            expect(backgroundDownload).toHaveBeenCalledWith(track.mediaDownloadUrl);
        });
    });

    describe('trusted media CORS preparation', () => {
        it('marks the verified CDN source before load and proves the matching current source', () => {
            const audio = document.createElement('audio');
            document.body.appendChild(audio);
            const cache = new AudioCache();
            const source = 'https://raw.kiko-play-niptan.one/audio/track-a.mp3';
            const track = {
                type: 'audio' as const,
                hash: 'track-a',
                title: 'Track A',
                mediaStreamUrl: source,
            };

            expect(cache.prepareTrustedCorsPlayback(track)).toBe(true);
            expect(audio.crossOrigin).toBe('anonymous');
            expect(audio.dataset.asmrTrustedCorsSource).toBe(source);

            // Simulate the host dispatch selecting the prepared source.
            audio.src = source;
            expect(AudioCache.hasTrustedCorsPlayback(audio)).toBe(true);

            audio.src = 'https://raw.kiko-play-niptan.one/audio/different.mp3';
            expect(AudioCache.hasTrustedCorsPlayback(audio)).toBe(false);
        });

        it('prepares the live fast CDN used by RJ01503719', () => {
            const audio = document.createElement('audio');
            document.body.appendChild(audio);
            const cache = new AudioCache();
            const source = 'https://fast.kiko-play-niptan.one/media/stream/1503719/track.m4a';
            const rawSource = 'https://raw.kiko-play-niptan.one/media/stream/1503719/track.wav';

            expect(cache.prepareTrustedCorsPlayback({
                type: 'audio',
                hash: 'rj01503719-track',
                title: 'RJ01503719 Track',
                streamLowQualityUrl: source,
                mediaStreamUrl: rawSource,
            })).toBe(true);

            audio.src = source;
            expect(audio.crossOrigin).toBe('anonymous');
            expect(audio.dataset.asmrTrustedCorsSource).toBe(source);
            expect(AudioCache.hasTrustedCorsPlayback(audio)).toBe(true);
        });

        it('does not mark an unverified cross-origin host', () => {
            const audio = document.createElement('audio');
            document.body.appendChild(audio);
            const cache = new AudioCache();

            expect(cache.prepareTrustedCorsPlayback({
                type: 'audio',
                hash: 'track-b',
                title: 'Track B',
                mediaStreamUrl: 'https://media.example.net/track-b.mp3',
            })).toBe(false);
            expect(audio.crossOrigin).toBeNull();
            expect(audio.dataset.asmrTrustedCorsSource).toBeUndefined();
        });

        it('clears script-owned CORS state before an unverified next track', () => {
            const audio = document.createElement('audio');
            document.body.appendChild(audio);
            const cache = new AudioCache();
            const trustedSource = 'https://raw.kiko-play-niptan.one/audio/trusted.mp3';

            expect(cache.prepareTrustedCorsPlayback({
                type: 'audio',
                hash: 'trusted',
                title: 'Trusted',
                mediaStreamUrl: trustedSource,
            })).toBe(true);
            expect(audio.crossOrigin).toBe('anonymous');

            expect(cache.prepareTrustedCorsPlayback({
                type: 'audio',
                hash: 'unverified',
                title: 'Unverified',
                mediaStreamUrl: 'https://media.example.net/unverified.mp3',
            })).toBe(false);

            expect(audio.crossOrigin).toBeNull();
            expect(audio.dataset.asmrTrustedCorsSource).toBeUndefined();
            audio.src = trustedSource;
            expect(AudioCache.hasTrustedCorsPlayback(audio)).toBe(false);
        });

        it('rejects a dataset-only marker that was not recorded before load', () => {
            const audio = document.createElement('audio');
            const source = 'https://raw.kiko-play-niptan.one/audio/spoofed.mp3';
            audio.crossOrigin = 'anonymous';
            audio.dataset.asmrTrustedCorsSource = source;
            audio.src = source;

            expect(AudioCache.hasTrustedCorsPlayback(audio)).toBe(false);
        });

        it('refuses to claim pre-load trust after the target has started loading', () => {
            const audio = document.createElement('audio');
            const source = 'https://raw.kiko-play-niptan.one/audio/already-loading.mp3';
            audio.src = source;
            Object.defineProperty(audio, 'readyState', { configurable: true, value: 1 });
            Object.defineProperty(audio, 'networkState', { configurable: true, value: 1 });
            document.body.appendChild(audio);

            const cache = new AudioCache();
            expect(cache.prepareTrustedCorsPlayback({
                type: 'audio',
                hash: 'track-c',
                title: 'Track C',
                mediaStreamUrl: source,
            })).toBe(false);
            expect(AudioCache.hasTrustedCorsPlayback(audio)).toBe(false);
        });

        it('hooks SET_QUEUE before the current host starts loading the selected fast-CDN track', () => {
            const audio = document.createElement('audio');
            document.body.appendChild(audio);
            const cache = new AudioCache();
            const order: string[] = [];
            const prepare = vi.spyOn(cache, 'prepareTrustedCorsPlayback').mockImplementation(() => {
                order.push('prepare');
                return true;
            });
            vi.spyOn(cache, 'interceptPlay').mockResolvedValue(undefined);
            const store = {
                state: { AudioPlayer: { currentTime: 0, duration: 0, queue: [], queueIndex: 0 }, User: {} },
                commit: vi.fn(() => { order.push('commit'); }),
                dispatch: vi.fn(() => Promise.resolve()),
            };
            const track = {
                type: 'audio' as const,
                hash: 'rj01503719',
                title: 'Live track',
                streamLowQualityUrl: 'https://fast.kiko-play-niptan.one/media/stream/track.m4a',
                mediaStreamUrl: 'https://raw.kiko-play-niptan.one/media/stream/track.wav',
            };

            cache.installPlaybackInterceptors(store as any);
            (store.commit as any)('AudioPlayer/SET_QUEUE', { queue: [track], index: 0 });

            expect(order).toEqual(['prepare', 'commit']);
            expect(prepare).toHaveBeenCalledWith(track);
        });

        it('records the same low-quality URL that the host selects when raw and fast sources coexist', () => {
            const audio = document.createElement('audio');
            document.body.appendChild(audio);
            const cache = new AudioCache();
            const fastSource = 'https://fast.kiko-play-niptan.one/media/stream/track.m4a';
            const track = {
                type: 'audio' as const,
                hash: 'rj01503719',
                title: 'Live track',
                streamLowQualityUrl: fastSource,
                mediaStreamUrl: 'https://raw.kiko-play-niptan.one/media/stream/track.wav',
            };

            expect(cache.prepareTrustedCorsPlayback(track)).toBe(true);
            audio.src = fastSource;

            expect(audio.dataset.asmrTrustedCorsSource).toBe(fastSource);
            expect(AudioCache.hasTrustedCorsPlayback(audio)).toBe(true);
        });

        it('always reaches the legacy host dispatch when cache lookup rejects', async () => {
            const audio = document.createElement('audio');
            document.body.appendChild(audio);
            const cache = new AudioCache();
            vi.spyOn(cache, 'interceptPlay').mockRejectedValue(new Error('IndexedDB unavailable'));
            const originalDispatch = vi.fn(() => Promise.resolve('played'));
            const store = {
                state: { AudioPlayer: { currentTime: 0, duration: 0 }, User: {} },
                commit: vi.fn(),
                dispatch: originalDispatch,
            };
            const track = {
                type: 'audio' as const,
                hash: 'track',
                title: 'Track',
                mediaStreamUrl: 'https://fast.kiko-play-niptan.one/media/stream/track.m4a',
            };

            cache.installPlaybackInterceptors(store as any);
            await expect((store.dispatch as any)('AudioPlayer/playTrack', track)).resolves.toBe('played');

            expect(originalDispatch).toHaveBeenCalledTimes(1);
            expect(originalDispatch).toHaveBeenCalledWith('AudioPlayer/playTrack', track, undefined);
        });
    });

    it('preserves original queue URLs and recreates an evicted blob on replay', async () => {
        const originalCreateObjectURL = URL.createObjectURL;
        const originalRevokeObjectURL = URL.revokeObjectURL;
        let objectUrlId = 0;
        URL.createObjectURL = vi.fn(() => `blob:https://asmr.one/${++objectUrlId}`);
        URL.revokeObjectURL = vi.fn();
        mockDB.get.mockResolvedValue({
            url: '',
            blob: new Blob(['cached audio'], { type: 'audio/mp4' }),
            lastPlayed: 0,
            size: 12,
        });

        const cache = new AudioCache();
        (cache as any).bridge = { store: { state: { AudioPlayer: { playing: true } } } };
        const tracks = Array.from({ length: 6 }, (_, index) => ({
            type: 'audio' as const,
            hash: `track-${index}`,
            title: `Track ${index}`,
            mediaStreamUrl: `https://raw.kiko-play-niptan.one/stream/${index}.m4a`,
            mediaDownloadUrl: `https://raw.kiko-play-niptan.one/download/${index}.m4a`,
        }));

        try {
            for (const track of tracks) await cache.interceptPlay(track);

            expect(AudioCache.objectUrls.size).toBe(5);
            expect(AudioCache.objectUrls.has(tracks[0].mediaDownloadUrl)).toBe(false);
            for (let index = 0; index < tracks.length; index++) {
                expect(tracks[index].mediaStreamUrl).toContain(`/stream/${index}.m4a`);
                expect(tracks[index].mediaDownloadUrl).toContain(`/download/${index}.m4a`);
            }

            await cache.interceptPlay(tracks[0]);
            expect(AudioCache.objectUrls.has(tracks[0].mediaDownloadUrl)).toBe(true);
            expect(tracks[0].mediaStreamUrl).toBe('https://raw.kiko-play-niptan.one/stream/0.m4a');
            expect(URL.revokeObjectURL).toHaveBeenCalled();
        } finally {
            URL.createObjectURL = originalCreateObjectURL;
            URL.revokeObjectURL = originalRevokeObjectURL;
        }
    });

    // =========================================================================
    // isStream (private, tested via as any)
    // =========================================================================
    describe('isStream', () => {
        let cache: any;
        beforeEach(() => {
            cache = new AudioCache();
        });

        it('should detect .m3u8 URLs', () => {
            expect(cache.isStream('https://cdn.example.com/audio/index.m3u8')).toBe(true);
        });

        it('should detect .m3u8 with query params', () => {
            expect(cache.isStream('https://cdn.example.com/audio/index.m3u8?token=abc')).toBe(true);
        });

        it('should detect /hls/ path URLs', () => {
            expect(cache.isStream('https://cdn.example.com/hls/stream/001.ts')).toBe(true);
        });

        it('should detect /HLS/ case-insensitive', () => {
            expect(cache.isStream('https://cdn.example.com/HLS/stream.ts')).toBe(true);
        });

        it('should NOT detect regular mp3 URLs', () => {
            expect(cache.isStream('https://cdn.example.com/audio/track01.mp3')).toBe(false);
        });

        it('should NOT detect regular wav URLs', () => {
            expect(cache.isStream('https://cdn.example.com/audio/track01.wav')).toBe(false);
        });

        it('should NOT detect URLs with m3u8 in path but not as extension', () => {
            expect(cache.isStream('https://cdn.example.com/m3u8-converter/audio.mp3')).toBe(false);
        });
    });

    // =========================================================================
    // trackObjectUrl (static private)
    // =========================================================================
    describe('trackObjectUrl', () => {
        // Mock URL.createObjectURL and URL.revokeObjectURL
        const originalCreateObjectURL = URL.createObjectURL;
        const originalRevokeObjectURL = URL.revokeObjectURL;

        beforeEach(() => {
            URL.revokeObjectURL = vi.fn();
            AudioCache.objectUrls.clear();
        });

        afterEach(() => {
            URL.createObjectURL = originalCreateObjectURL;
            URL.revokeObjectURL = originalRevokeObjectURL;
        });

        it('should store source → object URL mapping', () => {
            (AudioCache as any).trackObjectUrl('source1', 'blob:1');
            expect(AudioCache.objectUrls.get('source1')).toBe('blob:1');
        });

        it('should revoke old URL when updating same source', () => {
            (AudioCache as any).trackObjectUrl('source1', 'blob:old');
            (AudioCache as any).trackObjectUrl('source1', 'blob:new');

            expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:old');
            expect(AudioCache.objectUrls.get('source1')).toBe('blob:new');
        });

        it('should NOT revoke when setting same URL', () => {
            (AudioCache as any).trackObjectUrl('source1', 'blob:same');
            (AudioCache as any).trackObjectUrl('source1', 'blob:same');

            expect(URL.revokeObjectURL).not.toHaveBeenCalled();
        });

        it('should evict oldest entries when over MAX_OBJECT_URLS (5)', () => {
            // Fill up to 5
            for (let i = 0; i < 5; i++) {
                (AudioCache as any).trackObjectUrl(`src-${i}`, `blob:${i}`);
            }
            expect(AudioCache.objectUrls.size).toBe(5);

            // Adding 6th should evict oldest
            (AudioCache as any).trackObjectUrl('src-new', 'blob:new');
            expect(AudioCache.objectUrls.size).toBe(5);
            expect(AudioCache.objectUrls.has('src-0')).toBe(false); // oldest evicted
            expect(AudioCache.objectUrls.has('src-new')).toBe(true);
            expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:0');
        });
    });

    // =========================================================================
    // releaseUrl (static public)
    // =========================================================================
    describe('releaseUrl', () => {
        beforeEach(() => {
            URL.revokeObjectURL = vi.fn();
            AudioCache.objectUrls.clear();
        });

        it('should revoke and remove tracked URL', () => {
            AudioCache.objectUrls.set('src1', 'blob:1');
            AudioCache.releaseUrl('src1');

            expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:1');
            expect(AudioCache.objectUrls.has('src1')).toBe(false);
        });

        it('should do nothing for untracked URL', () => {
            AudioCache.releaseUrl('unknown');
            expect(URL.revokeObjectURL).not.toHaveBeenCalled();
        });
    });
});
