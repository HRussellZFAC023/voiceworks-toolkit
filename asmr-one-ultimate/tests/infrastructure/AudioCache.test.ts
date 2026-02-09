import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AudioCache } from '../../src/infrastructure/AudioCache';

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
        vi.clearAllMocks();
        AudioCache.objectUrls.clear();
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
