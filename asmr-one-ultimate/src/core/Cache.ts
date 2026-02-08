import { GM_getValue, GM_setValue } from '$';

type CacheEnvelope<T> = {
    expiresAt: number;
    value: T;
};

const hashString = (input: string): string => {
    if (!input) return '0';
    let hash = 2166136261;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(36);
};

export const CacheKeys = {
    dlsite: (rjCode: string) => `asmr-ult:dlsite:${rjCode}`,
    work: (workId: string | number) => `asmr-ult:work:${workId}`,
    translation: (text: string, lang: string, source: 'local' | 'remote' | 'auto' = 'auto') =>
        `asmr-ult:trans:${source}:${lang}:${hashString(text)}`,
    translationRateLimit: () => 'asmr-ult:trans:ratelimit',
    translationModelReady: (model: string) => `asmr-ult:trans:model:${hashString(model)}`,
    translationPreferredDtype: () => 'asmr-ult:trans:preferred-dtype',
    tagTranslation: (text: string, lang = 'en') => `asmr-ult:tag:${lang}:${hashString(text)}`,
    // Unified cache keys for consolidated caching
    entity: (name: string, lang = 'en') => `asmr-ult:entity:${lang}:${hashString(name)}`,
    playerTranslation: (text: string, lang = 'en') => `asmr-ult:player:${lang}:${hashString(text)}`,
    dlsiteReviews: (rjCode: string) => `asmr-ult:dlsite-reviews:${rjCode}`,
    whisperTranscript: (identity: string) => `asmr-ult:whisper:${hashString(identity)}`,
    whisperIndex: () => 'asmr-ult:whisper-index',
    whisperModelReady: (model: string) => `asmr-ult:whisper:model:${hashString(model)}`,
};

const MAX_SIZE = 1000;

export class CacheStore {
    private memory = new Map<string, CacheEnvelope<any>>();
    private inflight = new Map<string, Promise<any>>();

    public get<T>(key: string): T | null {
        const now = Date.now();
        const memoryEntry = this.memory.get(key);
        if (memoryEntry && memoryEntry.expiresAt > now) return memoryEntry.value as T;
        if (memoryEntry) this.memory.delete(key);

        const raw = GM_getValue(key, '');
        if (!raw || typeof raw !== 'string') return null;
        try {
            const parsed = JSON.parse(raw) as CacheEnvelope<T>;
            if (!parsed?.expiresAt || parsed.expiresAt <= now) return null;
            this.memory.set(key, parsed);
            return parsed.value as T;
        } catch {
            return null;
        }
    }

    public set<T>(key: string, value: T, ttlMs: number): void {
        const entry: CacheEnvelope<T> = { value, expiresAt: Date.now() + ttlMs };
        this.memory.set(key, entry);
        this.evictIfOverSize();
        try {
            GM_setValue(key, JSON.stringify(entry));
        } catch {
            // Ignore storage errors.
        }
    }

    public getOrFetch<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
        const cached = this.get<T>(key);
        if (cached !== null && cached !== undefined) return Promise.resolve(cached);
        if (this.inflight.has(key)) return this.inflight.get(key)!;

        const task = fetcher()
            .then((value) => {
                this.set(key, value, ttlMs);
                return value;
            })
            .finally(() => {
                this.inflight.delete(key);
            });
        this.inflight.set(key, task);
        return task;
    }

    /** Remove oldest entries (by Map insertion order) when over MAX_SIZE */
    private evictIfOverSize(): void {
        if (this.memory.size <= MAX_SIZE) return;
        // First pass: remove expired entries
        this.evictExpired();
        // If still over limit, delete oldest by insertion order
        const iter = this.memory.keys();
        while (this.memory.size > MAX_SIZE) {
            const oldest = iter.next();
            if (oldest.done) break;
            this.memory.delete(oldest.value);
        }
    }

    /** Remove all expired entries from the memory map */
    public evictExpired(): void {
        const now = Date.now();
        for (const [key, envelope] of this.memory) {
            if (envelope.expiresAt <= now) {
                this.memory.delete(key);
            }
        }
    }

    public clear(): void {
        this.memory.clear();
        this.inflight.clear();
    }

    // =========================================================================
    // Memory-only caching (no GM persistence)
    // Use for large data like embeddings that shouldn't go to GM_* storage
    // =========================================================================

    /**
     * Get from L1 memory cache only (no GM persistence).
     * Use for large data like embedding vectors.
     */
    public getMemory<T>(key: string): T | null {
        const entry = this.memory.get(key);
        if (entry && entry.expiresAt > Date.now()) return entry.value as T;
        if (entry) this.memory.delete(key);
        return null;
    }

    /**
     * Set in L1 memory cache only (no GM persistence).
     * Use for large data like embedding vectors.
     */
    public setMemory<T>(key: string, value: T, ttlMs: number): void {
        this.memory.set(key, { value, expiresAt: Date.now() + ttlMs });
        this.evictIfOverSize();
    }

    /**
     * Get or fetch with L1-only caching (no GM persistence).
     */
    public getOrFetchMemory<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
        const cached = this.getMemory<T>(key);
        if (cached !== null && cached !== undefined) return Promise.resolve(cached);
        if (this.inflight.has(key)) return this.inflight.get(key)!;

        const task = fetcher()
            .then((value) => {
                this.setMemory(key, value, ttlMs);
                return value;
            })
            .finally(() => {
                this.inflight.delete(key);
            });
        this.inflight.set(key, task);
        return task;
    }
}

export const SharedCache = new CacheStore();

// Periodically evict expired entries to free memory (every 5 minutes)
if (typeof setInterval !== 'undefined') {
    setInterval(() => SharedCache.evictExpired(), 5 * 60 * 1000);
}
