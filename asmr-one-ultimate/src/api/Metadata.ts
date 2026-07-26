import { getAxios } from './Client';
import { TagEntry, VAEntry, CircleEntry } from '../types/api';

export interface LabelSearchResult<T> {
    items: T[];
    hasMore: boolean;
    total: number;
}

export type LabelField = 'tags' | 'circles' | 'vas';

/**
 * Explicit outcome of a label fetch.
 *
 * `getLabels()` collapses every outcome to an array, which makes a failed
 * request indistinguishable from a genuinely empty one. Callers that need to
 * render an error state (and offer a retry) must use `fetchLabels()` instead.
 */
export interface LabelFetchResult<T> {
    items: T[];
    /** Non-null when the request failed (network error, timeout, abort, bridge missing). */
    error: Error | null;
    /** True when `items` came from the in-memory cache rather than a fresh response. */
    fromCache: boolean;
}

/** Raised when a label request does not settle within the allotted budget. */
export class MetadataRequestTimeoutError extends Error {
    constructor(public readonly field: LabelField, public readonly timeoutMs: number) {
        super(`Metadata request for "${field}" timed out after ${timeoutMs}ms`);
        this.name = 'MetadataRequestTimeoutError';
    }
}

// Cache for labels to avoid repeated API calls
const labelCache: {
    tags?: TagEntry[];
    circles?: CircleEntry[];
    vas?: VAEntry[];
    timestamps: { [key: string]: number };
} = { timestamps: {} };

/**
 * Shared in-flight requests, keyed by field. Without this, two components
 * opening at once each issue their own `/api/tags/` request.
 */
const inFlight = new Map<LabelField, Promise<LabelFetchResult<never>>>();

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Hard ceiling for a single label request. The host axios instance has no
 * default timeout, so a stalled connection would otherwise leave the caller's
 * promise pending forever (and any "loading" flag bound to it stuck on screen).
 */
export const METADATA_REQUEST_TIMEOUT_MS = 20000;

function readCache<T>(field: LabelField): { items: T[]; fresh: boolean } | null {
    const cached = labelCache[field] as T[] | undefined;
    if (!cached || !cached.length) return null;
    const timestamp = labelCache.timestamps[field] || 0;
    return { items: cached, fresh: (Date.now() - timestamp) < CACHE_TTL };
}

function writeCache<T>(field: LabelField, items: T[]): void {
    (labelCache as Record<string, unknown>)[field] = items;
    labelCache.timestamps[field] = Date.now();
}

/**
 * Issue the request, racing it against a timeout so it always settles.
 * Aborts the underlying request when the timeout wins, where supported.
 */
async function requestLabels<T>(field: LabelField, timeoutMs: number): Promise<T[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                try { controller?.abort(); } catch { /* abort is best-effort */ }
                reject(new MetadataRequestTimeoutError(field, timeoutMs));
            }, timeoutMs);
        });

        // `getAxios()` throws when the host bridge is not initialised yet; being
        // inside this async function turns that into a rejection, not a throw.
        const request = Promise.resolve(
            getAxios().get(`/api/${field}/`, controller ? { signal: controller.signal } : {})
        );
        // Keep a late rejection (after the timeout already won) from surfacing
        // as an unhandled promise rejection.
        request.catch(() => { /* handled by the race below or discarded */ });

        const res = await Promise.race([request, timeout]);
        const data = (res as { data?: unknown } | undefined)?.data;
        // Ensure we always return an array
        return Array.isArray(data) ? data as T[] : [];
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

async function runFetch<T>(
    field: LabelField,
    staleItems: T[] | null,
    timeoutMs: number,
): Promise<LabelFetchResult<T>> {
    try {
        const items = await requestLabels<T>(field, timeoutMs);
        if (items.length) {
            writeCache(field, items);
            return { items, error: null, fromCache: false };
        }
        // An empty success is never cached: caching it would make every retry
        // for the next CACHE_TTL a no-op, which is indistinguishable from a
        // permanently broken list. Prefer previously known-good data.
        if (staleItems && staleItems.length) {
            return { items: staleItems, error: null, fromCache: true };
        }
        return { items: [], error: null, fromCache: false };
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        // Degrade to cached data when we have some; otherwise report the failure
        // so the caller can render a retryable error instead of a blank list.
        if (staleItems && staleItems.length) {
            return { items: staleItems, error: null, fromCache: true };
        }
        return { items: [], error: err, fromCache: false };
    }
}

export const MetadataApi = {
    /**
     * Fetch labels for a field, reporting the terminal outcome explicitly.
     *
     * Always settles: success, empty, cache hit, error and timeout all resolve.
     */
    fetchLabels<T extends TagEntry | VAEntry | CircleEntry>(
        field: LabelField,
        options: { force?: boolean; timeoutMs?: number } = {},
    ): Promise<LabelFetchResult<T>> {
        const cached = readCache<T>(field);

        if (!options.force && cached?.fresh) {
            return Promise.resolve({ items: cached.items, error: null, fromCache: true });
        }

        if (!options.force) {
            const existing = inFlight.get(field);
            if (existing) return existing as unknown as Promise<LabelFetchResult<T>>;
        }

        const pending = runFetch<T>(
            field,
            cached ? cached.items : null,
            options.timeoutMs ?? METADATA_REQUEST_TIMEOUT_MS,
        );
        const stored = pending as unknown as Promise<LabelFetchResult<never>>;
        inFlight.set(field, stored);
        const release = (): void => {
            if (inFlight.get(field) === stored) inFlight.delete(field);
        };
        void pending.then(release, release);
        return pending;
    },

    /**
     * Get all labels for a field (with caching).
     *
     * Legacy shape: never rejects, and collapses errors to an empty array.
     * Prefer `fetchLabels` when the caller needs to distinguish failure.
     */
    async getLabels<T extends TagEntry | VAEntry | CircleEntry>(field: LabelField): Promise<T[]> {
        const result = await this.fetchLabels<T>(field);
        return result.items;
    },

    async getTagList(): Promise<TagEntry[]> {
        return this.getLabels<TagEntry>('tags');
    },

    /**
     * Get all VAs (voice actors)
     */
    async getVAList(): Promise<VAEntry[]> {
        return this.getLabels<VAEntry>('vas');
    },

    /**
     * Get all circles
     */
    async getCircleList(): Promise<CircleEntry[]> {
        return this.getLabels<CircleEntry>('circles');
    },

    fetchTagList(options?: { force?: boolean; timeoutMs?: number }): Promise<LabelFetchResult<TagEntry>> {
        return this.fetchLabels<TagEntry>('tags', options);
    },

    fetchVAList(options?: { force?: boolean; timeoutMs?: number }): Promise<LabelFetchResult<VAEntry>> {
        return this.fetchLabels<VAEntry>('vas', options);
    },

    fetchCircleList(options?: { force?: boolean; timeoutMs?: number }): Promise<LabelFetchResult<CircleEntry>> {
        return this.fetchLabels<CircleEntry>('circles', options);
    },

    /**
     * Search VAs with filtering and pagination
     */
    async searchVAs(query: string, page = 1, pageSize = 50): Promise<LabelSearchResult<VAEntry>> {
        const allVAs = await this.getVAList();
        const needle = query.toLowerCase().trim();

        const filtered = needle
            ? allVAs.filter(va => va.name.toLowerCase().includes(needle))
            : allVAs;

        const offset = (page - 1) * pageSize;
        return {
            items: filtered.slice(offset, offset + pageSize),
            hasMore: filtered.length > offset + pageSize,
            total: filtered.length,
        };
    },

    /**
     * Search circles with filtering and pagination
     */
    async searchCircles(query: string, page = 1, pageSize = 50): Promise<LabelSearchResult<CircleEntry>> {
        const allCircles = await this.getCircleList();
        const needle = query.toLowerCase().trim();

        const filtered = needle
            ? allCircles.filter(c => c.name.toLowerCase().includes(needle))
            : allCircles;

        const offset = (page - 1) * pageSize;
        return {
            items: filtered.slice(offset, offset + pageSize),
            hasMore: filtered.length > offset + pageSize,
            total: filtered.length,
        };
    },

    /**
     * Clear the label cache (useful after data updates, or for a manual retry).
     * Also drops in-flight requests so the next call issues a fresh one.
     */
    clearCache(field?: LabelField): void {
        const fields: LabelField[] = field ? [field] : ['tags', 'circles', 'vas'];
        for (const key of fields) {
            delete labelCache[key];
            delete labelCache.timestamps[key];
            inFlight.delete(key);
        }
    },
};
