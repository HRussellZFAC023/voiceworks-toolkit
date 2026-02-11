import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CacheStore, CacheKeys } from '../../src/core/Cache';

describe('CacheStore', () => {
    beforeEach(() => {
        (globalThis as any).GM_getValue = vi.fn();
        (globalThis as any).GM_setValue = vi.fn();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('get / set with TTL', () => {
        it('expires cached entries based on TTL', () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));
            const cache = new CacheStore();
            cache.set('key', 'value', 1000);

            expect(cache.get('key')).toBe('value');

            vi.advanceTimersByTime(1001);
            expect(cache.get('key')).toBeNull();
        });

        it('should return null for missing keys', () => {
            const cache = new CacheStore();
            expect(cache.get('nonexistent')).toBeNull();
        });

        it('should persist to GM storage on set', () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));
            const cache = new CacheStore();
            cache.set('key', { data: 1 }, 5000);

            expect((globalThis as any).GM_setValue).toHaveBeenCalledWith(
                'key',
                expect.stringContaining('"data":1')
            );
        });

        it('should read from GM storage when not in memory', () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));

            const envelope = JSON.stringify({
                value: 'from-gm',
                expiresAt: Date.now() + 60000,
            });
            (globalThis as any).GM_getValue = vi.fn(() => envelope);

            const cache = new CacheStore();
            expect(cache.get('gm-key')).toBe('from-gm');
        });

        it('should return null for expired GM entries', () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));

            const envelope = JSON.stringify({
                value: 'expired',
                expiresAt: Date.now() - 1000,
            });
            (globalThis as any).GM_getValue = vi.fn(() => envelope);

            const cache = new CacheStore();
            expect(cache.get('expired-key')).toBeNull();
        });

        it('should handle corrupted GM data gracefully', () => {
            (globalThis as any).GM_getValue = vi.fn(() => 'not-json{{{');
            const cache = new CacheStore();
            expect(cache.get('bad-data')).toBeNull();
        });

        it('should store complex objects', () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));
            const cache = new CacheStore();
            const obj = { nested: { array: [1, 2, 3] }, flag: true };
            cache.set('complex', obj, 10000);
            expect(cache.get('complex')).toEqual(obj);
        });
    });

    describe('getOrFetch', () => {
        it('dedupes inflight fetches for the same key', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));
            const cache = new CacheStore();
            const fetcher = vi.fn(() => new Promise<string>((resolve) => {
                setTimeout(() => resolve('result'), 10);
            }));

            const taskA = cache.getOrFetch('key', 1000, fetcher);
            const taskB = cache.getOrFetch('key', 1000, fetcher);

            vi.advanceTimersByTime(10);
            const [a, b] = await Promise.all([taskA, taskB]);

            expect(a).toBe('result');
            expect(b).toBe('result');
            expect(fetcher).toHaveBeenCalledTimes(1);
        });

        it('should return cached value without calling fetcher', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));
            const cache = new CacheStore();
            cache.set('pre-cached', 'existing', 10000);

            const fetcher = vi.fn(() => Promise.resolve('new'));
            const result = await cache.getOrFetch('pre-cached', 10000, fetcher);

            expect(result).toBe('existing');
            expect(fetcher).not.toHaveBeenCalled();
        });

        it('should cache the fetched result', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));
            const cache = new CacheStore();
            const fetcher = vi.fn(() => Promise.resolve('fetched'));

            await cache.getOrFetch('key', 5000, fetcher);
            expect(cache.get('key')).toBe('fetched');
        });

        it('should clean up inflight entry after completion', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));
            const cache = new CacheStore();
            let resolvePromise: (v: string) => void;
            const fetcher1 = vi.fn(() => new Promise<string>(r => { resolvePromise = r; }));

            const task = cache.getOrFetch('key', 5000, fetcher1);
            resolvePromise!('done');
            await task;

            // After completion, a new fetch should call the fetcher again
            // (because inflight was cleaned up, but cache has the value)
            const fetcher2 = vi.fn(() => Promise.resolve('new'));
            const result = await cache.getOrFetch('key', 5000, fetcher2);
            // Should return cached value, not call fetcher2
            expect(result).toBe('done');
            expect(fetcher2).not.toHaveBeenCalled();
        });
    });

    describe('memory-only caching', () => {
        it('should store and retrieve from memory only', () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));
            const cache = new CacheStore();
            cache.setMemory('mem-key', { large: 'data' }, 5000);

            expect(cache.getMemory('mem-key')).toEqual({ large: 'data' });
            // Should NOT persist to GM
            expect((globalThis as any).GM_setValue).not.toHaveBeenCalledWith(
                'mem-key',
                expect.anything()
            );
        });

        it('should expire memory entries', () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));
            const cache = new CacheStore();
            cache.setMemory('mem-key', 'data', 1000);

            vi.advanceTimersByTime(1001);
            expect(cache.getMemory('mem-key')).toBeNull();
        });

        it('should return null for missing memory keys', () => {
            const cache = new CacheStore();
            expect(cache.getMemory('missing')).toBeNull();
        });
    });

    describe('getOrFetchMemory', () => {
        it('should fetch and cache in memory only', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));
            const cache = new CacheStore();
            const fetcher = vi.fn(() => Promise.resolve([1, 2, 3]));

            const result = await cache.getOrFetchMemory('embeddings', 60000, fetcher);
            expect(result).toEqual([1, 2, 3]);
            expect(cache.getMemory('embeddings')).toEqual([1, 2, 3]);
            expect((globalThis as any).GM_setValue).not.toHaveBeenCalledWith(
                'embeddings',
                expect.anything()
            );
        });

        it('should dedupe inflight memory fetches', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));
            const cache = new CacheStore();
            const fetcher = vi.fn(() => new Promise<string>(r => setTimeout(() => r('ok'), 10)));

            const a = cache.getOrFetchMemory('k', 5000, fetcher);
            const b = cache.getOrFetchMemory('k', 5000, fetcher);
            vi.advanceTimersByTime(10);

            const [ra, rb] = await Promise.all([a, b]);
            expect(ra).toBe('ok');
            expect(rb).toBe('ok');
            expect(fetcher).toHaveBeenCalledTimes(1);
        });
    });

    describe('eviction', () => {
        it('should evict expired entries', () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));
            const cache = new CacheStore();

            cache.set('expired', 'old', 100);
            cache.set('valid', 'new', 10000);

            vi.advanceTimersByTime(200);
            cache.evictExpired();

            expect(cache.get('expired')).toBeNull();
            expect(cache.get('valid')).toBe('new');
        });

        it('should evict oldest entries when over MAX_SIZE (5000)', () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));
            const cache = new CacheStore();

            // Fill cache past MAX_SIZE
            for (let i = 0; i < 5005; i++) {
                cache.set(`key-${i}`, `value-${i}`, 60000);
            }

            // The oldest keys should have been evicted
            // (exact eviction count depends on implementation, but the
            //  important thing is it doesn't grow unbounded)
            let validCount = 0;
            for (let i = 0; i < 5005; i++) {
                if (cache.get(`key-${i}`) !== null) validCount++;
            }
            expect(validCount).toBeLessThanOrEqual(5000);
        });
    });

    describe('clear', () => {
        it('should clear all entries', () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));
            const cache = new CacheStore();
            cache.set('a', 1, 10000);
            cache.set('b', 2, 10000);

            cache.clear();

            expect(cache.get('a')).toBeNull();
            expect(cache.get('b')).toBeNull();
        });
    });
});

describe('CacheKeys', () => {
    it('should generate dlsite key', () => {
        expect(CacheKeys.dlsite('RJ123456')).toBe('asmr-ult:dlsite:RJ123456');
    });

    it('should generate work key', () => {
        expect(CacheKeys.work('12345')).toBe('asmr-ult:work:12345');
        expect(CacheKeys.work(12345)).toBe('asmr-ult:work:12345');
    });

    it('should generate translation key with hash', () => {
        const key = CacheKeys.translation('こんにちは', 'en');
        expect(key).toMatch(/^asmr-ult:trans:remote:en:/);
    });

    it('should generate different keys for different source types', () => {
        const auto = CacheKeys.translation('text', 'en', 'auto');
        const remote = CacheKeys.translation('text', 'en', 'remote');
        expect(auto).not.toBe(remote);
    });

    it('should generate consistent hashes for same input', () => {
        const key1 = CacheKeys.translation('same text', 'en');
        const key2 = CacheKeys.translation('same text', 'en');
        expect(key1).toBe(key2);
    });

    it('should generate different hashes for different input', () => {
        const key1 = CacheKeys.translation('text A', 'en');
        const key2 = CacheKeys.translation('text B', 'en');
        expect(key1).not.toBe(key2);
    });

    it('should generate tag translation key', () => {
        const key = CacheKeys.tagTranslation('耳かき');
        expect(key).toMatch(/^asmr-ult:tag:en:/);
    });

    it('should generate entity key', () => {
        const key = CacheKeys.entity('サークル名');
        expect(key).toMatch(/^asmr-ult:entity:en:/);
    });

    it('should generate whisper transcript key', () => {
        const key = CacheKeys.whisperTranscript('file-identity');
        expect(key).toMatch(/^asmr-ult:whisper:/);
    });

    it('should generate whisper index key', () => {
        expect(CacheKeys.whisperIndex()).toBe('asmr-ult:whisper-index');
    });

    it('should generate rate limit key', () => {
        expect(CacheKeys.translationRateLimit()).toBe('asmr-ult:trans:ratelimit');
    });
});
