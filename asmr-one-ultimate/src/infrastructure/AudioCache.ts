import { openDB, DBSchema } from 'idb';
import { Logger, Config } from '../core/Utils';
import { getAudioElement } from '../core/DomUtils';
import { KikoeruBridge } from './KikoeruBridge';
import { EventBus } from '../core/EventBus';
import { DeviceCapabilities } from '../core/DeviceCapabilities';

import { gmRequest, retryWithBackoff } from './HttpClient';
import type { KikoeruStore, PlayerTrack } from '../types';

interface AudioDB extends DBSchema {
    blobs: {
        key: string; // URL
        value: {
            url: string;
            blob: Blob;
            lastPlayed: number;
            size: number;
        };
        indexes: { 'by-lastPlayed': number };
    };
}

const MAX_OBJECT_URLS = 5;
const ONE_GIB = 1024 * 1024 * 1024;
const TRUSTED_CORS_MEDIA_HOSTS = new Set([
    'raw.kiko-play-niptan.one',
    'fast.kiko-play-niptan.one',
]);
const TRUSTED_CORS_SOURCE_DATASET_KEY = 'asmrTrustedCorsSource';
const trustedCorsPreloads = new WeakMap<HTMLAudioElement, string>();
const ORIGINAL_MEDIA_URLS_KEY = '__asmrOriginalMediaUrls';

type OriginalMediaUrls = Partial<Record<
    'mediaDownloadUrl' | 'media_download_url' | 'file_url'
    | 'streamLowQualityUrl' | 'stream_low_quality_url'
    | 'mediaStreamUrl' | 'media_stream_url' | 'stream_url' | 'src' | 'url',
    string
>>;

type CacheAwareTrack = PlayerTrack & { [ORIGINAL_MEDIA_URLS_KEY]?: OriginalMediaUrls };

type PlaybackHookStore = KikoeruStore & {
    __asmrAudioPlaybackHook?: {
        cache: AudioCache;
        originalCommit?: NonNullable<KikoeruStore['commit']>;
        originalDispatch?: NonNullable<KikoeruStore['dispatch']>;
    };
};

function normalizeMediaUrl(url: string): string | null {
    try {
        return new URL(url, window.location.href).href;
    } catch {
        return null;
    }
}

function isTrustedCorsMediaUrl(url: string): boolean {
    try {
        const parsed = new URL(url, window.location.href);
        return parsed.protocol === 'https:' && TRUSTED_CORS_MEDIA_HOSTS.has(parsed.hostname.toLowerCase());
    } catch {
        return false;
    }
}

function getOriginalMediaUrls(track: PlayerTrack): OriginalMediaUrls {
    const existing = (track as CacheAwareTrack)[ORIGINAL_MEDIA_URLS_KEY];
    if (existing) return existing;
    const record = track as unknown as Record<string, unknown>;
    const urls: OriginalMediaUrls = {};
    for (const key of [
        'mediaDownloadUrl', 'media_download_url', 'file_url',
        'streamLowQualityUrl', 'stream_low_quality_url',
        'mediaStreamUrl', 'media_stream_url', 'stream_url', 'src', 'url',
    ] as const) {
        const value = record[key];
        if (typeof value === 'string' && value && !value.startsWith('blob:')) urls[key] = value;
    }
    return urls;
}

export class AudioCache {
    public static objectUrls = new Map<string, string>();
    private static hlsSkippedCount = 0; // Track skipped HLS streams this session
    private static cacheHits = 0; // Track cache hits this session
    private dbPromise;
    private bridge: KikoeruBridge;
    private inFlight = new Map<string, Promise<void>>();
    private lastUrl: string | null = null;
    /** Serializes eviction so concurrent quota-exceeded callers share one eviction pass */
    private evictionPromise: Promise<void> | null = null;

    constructor() {
        this.bridge = KikoeruBridge.getInstance();
        this.dbPromise = openDB<AudioDB>('asmr-one-audio-cache', 1, {
            upgrade(db) {
                const store = db.createObjectStore('blobs', { keyPath: 'url' });
                store.createIndex('by-lastPlayed', 'lastPlayed');
            },
        });
    }

    private isStream(url: string): boolean {
        return /\.m3u8($|\?)/i.test(url) || /\/hls\//i.test(url);
    }

    private resolvePlaybackStreamUrl(track: PlayerTrack): string | null {
        // Match the host player's source ladder exactly. Current Kikoeru builds
        // select the fast/smaller M4A when it coexists with a raw full-quality
        // stream; marking the raw URL would make our CORS proof disagree with
        // audio.currentSrc and disable Firefox live capture.
        return track.streamLowQualityUrl
            || track.stream_low_quality_url
            || track.mediaStreamUrl
            || track.media_stream_url
            || track.stream_url
            || track.src
            || track.url
            || null;
    }

    private resolveCacheableUrl(track: PlayerTrack): string | null {
        const originals = getOriginalMediaUrls(track);
        const downloadUrl = originals.mediaDownloadUrl
            || originals.media_download_url
            || originals.file_url
            || track.mediaDownloadUrl
            || track.media_download_url
            || track.file_url;
        const streamUrl = originals.mediaStreamUrl
            || originals.media_stream_url
            || originals.stream_url
            || originals.src
            || originals.url
            || this.resolvePlaybackStreamUrl(track);
        return (downloadUrl && !this.isStream(downloadUrl) ? downloadUrl : streamUrl) || null;
    }

    private static isLiveCachedObjectUrl(url: string): boolean {
        return url.startsWith('blob:')
            && Array.from(AudioCache.objectUrls.values()).includes(url);
    }

    /** Remove only the CORS state installed by this script for a prior track. */
    private clearTrustedCorsPreparation(audio: HTMLAudioElement): void {
        if (!trustedCorsPreloads.has(audio)) return;
        trustedCorsPreloads.delete(audio);
        delete audio.dataset[TRUSTED_CORS_SOURCE_DATASET_KEY];
        audio.removeAttribute('crossorigin');
    }

    /**
     * Prepare the shared player element for verified media-CDN or script-cache
     * sources. This must run before the host's
     * playTrack dispatch begins loading the target URL.
     */
    public prepareTrustedCorsPlayback(track: PlayerTrack | null): boolean {
        if (!track) return false;
        const streamUrl = this.resolvePlaybackStreamUrl(track);
        const audio = getAudioElement();
        if (!audio) return false;
        const normalizedSource = streamUrl ? normalizeMediaUrl(streamUrl) : null;
        const trustedSource = !!normalizedSource && (
            isTrustedCorsMediaUrl(normalizedSource)
            || AudioCache.isLiveCachedObjectUrl(normalizedSource)
        );
        if (!trustedSource) {
            // The CORS attribute changes how the browser fetches media. Never
            // leak the setting we installed for the verified CDN into an
            // unrelated host whose response policy is unknown.
            this.clearTrustedCorsPreparation(audio);
            return false;
        }

        if (!normalizedSource) return false;

        const currentSource = normalizeMediaUrl(audio.currentSrc || audio.src || '');
        if (currentSource === normalizedSource
            && (audio.readyState > HTMLMediaElement.HAVE_NOTHING
                || audio.networkState !== HTMLMediaElement.NETWORK_EMPTY)) {
            // The target resource has already started loading. Setting CORS now
            // cannot make its response origin-clean, so do not claim otherwise.
            Logger.debug('[AudioCache] Trusted CORS preparation skipped after load began');
            return false;
        }

        audio.crossOrigin = 'anonymous';
        audio.dataset[TRUSTED_CORS_SOURCE_DATASET_KEY] = normalizedSource;
        trustedCorsPreloads.set(audio, normalizedSource);
        Logger.debug('[AudioCache] Prepared trusted media CDN before playback load:', normalizedSource);
        return true;
    }

    /** Proves this script set CORS before the currently selected trusted URL loaded. */
    public static hasTrustedCorsPlayback(audio: HTMLAudioElement): boolean {
        if (audio.crossOrigin !== 'anonymous') return false;
        const currentSource = normalizeMediaUrl(audio.currentSrc || audio.src || '');
        if (!currentSource || (
            !isTrustedCorsMediaUrl(currentSource)
            && !AudioCache.isLiveCachedObjectUrl(currentSource)
        )) return false;
        return trustedCorsPreloads.get(audio) === currentSource
            && audio.dataset[TRUSTED_CORS_SOURCE_DATASET_KEY] === currentSource;
    }

    /**
     * Return a cloned track that points at a still-live session object URL.
     * The original URLs travel with the clone, so an evicted/revoked object URL
     * can always be recreated from IndexedDB on a later replay.
     */
    public getCachedPlaybackTrack(track: PlayerTrack): PlayerTrack {
        const sourceUrl = this.resolveCacheableUrl(track);
        if (!sourceUrl) return track;
        const objectUrl = AudioCache.objectUrls.get(sourceUrl);
        if (!objectUrl) return track;

        const originals = getOriginalMediaUrls(track);
        const clone = {
            ...track,
            [ORIGINAL_MEDIA_URLS_KEY]: { ...originals },
        } as CacheAwareTrack;
        const record = clone as unknown as Record<string, unknown>;
        for (const key of [
            'mediaDownloadUrl', 'media_download_url', 'file_url',
            'streamLowQualityUrl', 'stream_low_quality_url',
            'mediaStreamUrl', 'media_stream_url', 'stream_url', 'src', 'url',
        ] as const) {
            if (originals[key]) record[key] = objectUrl;
        }
        return clone;
    }

    private getTrackForMutation(store: KikoeruStore, type: string, payload: unknown): {
        track: PlayerTrack | null;
        index: number;
        queue: PlayerTrack[] | null;
    } {
        if (type === 'AudioPlayer/SET_QUEUE') {
            const payloadRecord = payload as { queue?: PlayerTrack[]; index?: number } | null;
            const queue = Array.isArray(payload) ? payload as PlayerTrack[]
                : Array.isArray(payloadRecord?.queue) ? payloadRecord.queue
                    : null;
            const index = Number.isInteger(payloadRecord?.index)
                ? Number(payloadRecord?.index)
                : (store.state.AudioPlayer?.queueIndex ?? 0);
            return { track: queue?.[index] || null, index, queue };
        }

        if (type === 'AudioPlayer/SET_TRACK') {
            if (payload && typeof payload === 'object') {
                return { track: payload as PlayerTrack, index: store.state.AudioPlayer?.queueIndex ?? 0, queue: null };
            }
            const index = Number(payload);
            const queue = store.state.AudioPlayer?.queue || store.state.AudioPlayer?.playlist || null;
            return {
                track: Number.isInteger(index) ? queue?.[index] || null : null,
                index: Number.isInteger(index) ? index : 0,
                queue,
            };
        }

        return { track: null, index: 0, queue: null };
    }

    private applyCachedTrackToMutation(
        store: KikoeruStore,
        type: string,
        payload: unknown,
        queue: PlayerTrack[] | null,
        index: number,
        cachedTrack: PlayerTrack,
    ): unknown {
        if (type === 'AudioPlayer/SET_QUEUE' && queue) {
            const nextQueue = [...queue];
            nextQueue[index] = cachedTrack;
            if (Array.isArray(payload)) return nextQueue;
            return { ...(payload as Record<string, unknown>), queue: nextQueue };
        }

        if (type === 'AudioPlayer/SET_TRACK') {
            if (payload && typeof payload === 'object') return cachedTrack;
            const activeQueue = store.state.AudioPlayer?.queue || store.state.AudioPlayer?.playlist;
            if (Array.isArray(activeQueue) && activeQueue[index]) {
                // Replace the slot, not the caller's track object. The cached
                // clone retains original URL provenance for future recreation.
                activeQueue.splice(index, 1, cachedTrack);
            }
        }
        return payload;
    }

    /**
     * Hook the actual current-host source-selection seam. The production host
     * uses SET_QUEUE/SET_TRACK rather than AudioPlayer/playTrack. All cache work
     * is fail-open and asynchronous; only the synchronous CORS marker and an
     * already-live in-session object URL are applied before the host mutation.
     */
    public installPlaybackInterceptors(store: KikoeruStore): void {
        const hookedStore = store as PlaybackHookStore;
        if (hookedStore.__asmrAudioPlaybackHook) {
            hookedStore.__asmrAudioPlaybackHook.cache = this;
            return;
        }

        const hook = {
            cache: this,
            originalCommit: store.commit?.bind(store),
            originalDispatch: store.dispatch?.bind(store),
        };
        hookedStore.__asmrAudioPlaybackHook = hook;

        if (hook.originalCommit) {
            store.commit = (type, payload, options) => {
                const cache = hook.cache;
                let nextPayload = payload;
                try {
                    const selected = cache.getTrackForMutation(store, type, payload);
                    if (selected.track) {
                        const cachedTrack = cache.getCachedPlaybackTrack(selected.track);
                        nextPayload = cache.applyCachedTrackToMutation(
                            store, type, payload, selected.queue, selected.index, cachedTrack,
                        );
                        cache.prepareTrustedCorsPlayback(cachedTrack);
                        void cache.interceptPlay(selected.track).catch(error =>
                            Logger.warn('[AudioCache] Preload cache lookup failed open:', error));
                    }
                } catch (error) {
                    Logger.warn('[AudioCache] Playback mutation hook failed open:', error);
                }
                hook.originalCommit?.(type, nextPayload, options);
            };
        }

        if (hook.originalDispatch) {
            store.dispatch = <T = unknown>(type: string, payload?: unknown, options?: unknown): Promise<T> => {
                if (type === 'AudioPlayer/playTrack') {
                    try {
                        const track = payload as PlayerTrack | null;
                        if (track) {
                            const cachedTrack = hook.cache.getCachedPlaybackTrack(track);
                            hook.cache.prepareTrustedCorsPlayback(cachedTrack);
                            void hook.cache.interceptPlay(track).catch(error =>
                                Logger.warn('[AudioCache] Dispatch cache lookup failed open:', error));
                            return hook.originalDispatch?.<T>(type, cachedTrack, options) as Promise<T>;
                        }
                    } catch (error) {
                        Logger.warn('[AudioCache] Playback dispatch hook failed open:', error);
                    }
                }
                return hook.originalDispatch?.<T>(type, payload, options) as Promise<T>;
            };
        }
    }

    public enable(): void {
        Logger.log('[AudioCache] Enabling audio cache');
        // Use centralized track:change events from KikoeruBridge instead of polling
        EventBus.on('track:change', ({ track }) => {
            this.handleTrackChange(track);
        });
    }

    public async getBlob(url: string): Promise<Blob | null> {
        const db = await this.dbPromise;
        const entry = await db.get('blobs', url);
        if (entry) {
            // Update lastPlayed
            entry.lastPlayed = Date.now();
            db.put('blobs', entry).catch(err => {
                Logger.warn('[AudioCache] Failed to update lastPlayed:', err);
            });
            return entry.blob;
        }
        return null;
    }

    public async cacheAudio(url: string, blob: Blob): Promise<void> {
        Logger.debug(`[AudioCache] Caching audio: ${url}, size: ${(blob.size / 1024 / 1024).toFixed(2)}MB`);
        const db = await this.dbPromise;
        try {
            await db.put('blobs', {
                url,
                blob,
                lastPlayed: Date.now(),
                size: blob.size
            });
            await this.enforceSoftCacheLimit(db);
            EventBus.emit('cache:added', { url, size: blob.size });
        } catch (err) {
            if ((err as DOMException).name === 'QuotaExceededError' || (err as DOMException).name === 'QuotaExceeded') {
                Logger.warn('[AudioCache] Quota exceeded. Evicting old entries...');
                // Serialize eviction: if another cacheAudio already triggered eviction, reuse it
                if (!this.evictionPromise) {
                    this.evictionPromise = this.evictOldEntries().finally(() => {
                        this.evictionPromise = null;
                    });
                }
                await this.evictionPromise;
                try {
                    await db.put('blobs', {
                        url,
                        blob,
                        lastPlayed: Date.now(),
                        size: blob.size
                    });
                    await this.enforceSoftCacheLimit(db);
                } catch (retryErr) {
                    Logger.error('[AudioCache] Cache write failed after eviction:', retryErr);
                }
            } else {
                Logger.error('[AudioCache] Cache write failed:', err);
            }
        }
    }

    private getEffectiveCacheLimitBytes(): number {
        const deviceLimit = DeviceCapabilities.budget.audioCacheLimit;
        const configuredGb = Number(Config.get('cacheLimitGB'));
        const configuredBytes = Number.isFinite(configuredGb) && configuredGb > 0
            ? Math.floor(configuredGb * ONE_GIB)
            : deviceLimit;
        return Math.max(64 * 1024 * 1024, Math.min(deviceLimit, configuredBytes));
    }

    private async getTotalCachedBytes(db: Awaited<ReturnType<typeof openDB<AudioDB>>>): Promise<number> {
        const tx = db.transaction('blobs', 'readonly');
        let cursor = await tx.store.openCursor();
        let total = 0;
        while (cursor) {
            total += cursor.value.size || 0;
            cursor = await cursor.continue();
        }
        return total;
    }

    private async enforceSoftCacheLimit(db: Awaited<ReturnType<typeof openDB<AudioDB>>>): Promise<void> {
        const limitBytes = this.getEffectiveCacheLimitBytes();
        if (limitBytes <= 0) return;
        try {
            const totalBytes = await this.getTotalCachedBytes(db);
            if (totalBytes <= limitBytes) return;
            const overflowBytes = totalBytes - limitBytes;
            Logger.debug(
                `[AudioCache] Soft cache limit exceeded by ~${Math.round(overflowBytes / 1024 / 1024)}MB. Evicting old entries...`,
            );
            await this.evictOldEntries(overflowBytes);
        } catch (err) {
            Logger.warn('[AudioCache] Soft limit enforcement failed:', err);
        }
    }

    /**
     * P13 FIX: Improved LRU eviction with configurable target.
     * Evicts oldest entries until we free up enough space.
     * Handles IDB errors gracefully to prevent crashes.
     */
    private async evictOldEntries(targetBytes = 0): Promise<void> {
        try {
            const db = await this.dbPromise;
            // Evict oldest entries - at least 20 or until targetBytes freed
            const tx = db.transaction('blobs', 'readwrite');
            let cursor = await tx.store.index('by-lastPlayed').openCursor();
            let count = 0;
            let freedBytes = 0;
            const MIN_EVICT = 20;

            while (cursor && (count < MIN_EVICT || (targetBytes > 0 && freedBytes < targetBytes))) {
                freedBytes += cursor.value.size || 0;
                await cursor.delete();
                cursor = await cursor.continue();
                count++;
            }
            await tx.done;
            Logger.log(`[AudioCache] Evicted ${count} entries, freed ~${Math.round(freedBytes / 1024 / 1024)}MB.`);

            // Dispatch event so UI can update
            EventBus.emit('cache:evicted', { count, freedBytes });
        } catch (err) {
            // Handle IDB errors during eviction gracefully
            const errName = (err as DOMException)?.name || 'Unknown';
            Logger.error(`[AudioCache] Eviction failed (${errName}):`, err);
            // Don't throw - let the caller continue without crashing
        }
    }

    /**
     * P13: Clear all cached audio entries.
     * Called from settings UI "Clear Cache" button.
     * Returns zeros if clearing fails.
     */
    public async clearAll(): Promise<{ count: number; freedBytes: number }> {
        try {
            const db = await this.dbPromise;
            const tx = db.transaction('blobs', 'readwrite');
            let cursor = await tx.store.openCursor();
            let count = 0;
            let freedBytes = 0;

            while (cursor) {
                freedBytes += cursor.value.size || 0;
                await cursor.delete();
                cursor = await cursor.continue();
                count++;
            }
            await tx.done;

            // Clear all object URLs
            AudioCache.objectUrls.forEach((objUrl) => URL.revokeObjectURL(objUrl));
            AudioCache.objectUrls.clear();

            Logger.log(`[AudioCache] Cleared all cache: ${count} entries, ~${Math.round(freedBytes / 1024 / 1024)}MB.`);

            // Dispatch event so UI can update
            EventBus.emit('cache:cleared', { count, freedBytes });

            return { count, freedBytes };
        } catch (err) {
            Logger.error('[AudioCache] Failed to clear cache:', err);
            // Still clear object URLs even if IDB failed
            AudioCache.objectUrls.forEach((objUrl) => URL.revokeObjectURL(objUrl));
            AudioCache.objectUrls.clear();
            throw err; // Re-throw so UI can show error
        }
    }

    /**
     * P13: Get cache statistics for display in settings.
     * Returns zeros if IDB access fails.
     * Also includes session stats for HLS skips.
     */
    public async getStats(): Promise<{ count: number; totalSize: number; hlsSkipped: number; cacheHits: number }> {
        try {
            const db = await this.dbPromise;
            const tx = db.transaction('blobs', 'readonly');
            let cursor = await tx.store.openCursor();
            let count = 0;
            let totalSize = 0;

            while (cursor) {
                count++;
                totalSize += cursor.value.size || 0;
                cursor = await cursor.continue();
            }

            return {
                count,
                totalSize,
                hlsSkipped: AudioCache.hlsSkippedCount,
                cacheHits: AudioCache.cacheHits
            };
        } catch (err) {
            Logger.warn('[AudioCache] Failed to get stats:', err);
            return { count: 0, totalSize: 0, hlsSkipped: AudioCache.hlsSkippedCount, cacheHits: AudioCache.cacheHits };
        }
    }

    public async interceptPlay(track: PlayerTrack | null): Promise<void> {
        if (!track) return;
        Logger.debug('[AudioCache] interceptPlay called with track:', track);
        const originals = getOriginalMediaUrls(track);
        const downloadUrl = originals.mediaDownloadUrl || originals.media_download_url || originals.file_url;
        const streamUrl = originals.mediaStreamUrl || originals.media_stream_url
            || originals.stream_url || originals.src || originals.url;
        const url = this.resolveCacheableUrl(track);
        Logger.debug('[AudioCache] URL resolution:', { downloadUrl, streamUrl, chosen: url, isStreamDownload: downloadUrl ? this.isStream(downloadUrl) : 'N/A' });

        // Debug logging to help identify why caching might fail
        if (!url) {
            Logger.warn('[AudioCache] No URL found for track. Available keys:', Object.keys(track), track);
            return;
        }

        // P1 FIX: Skip HLS streams (native player handles them better, caching manifests breaks playback)
        if (this.isStream(url)) {
            AudioCache.hlsSkippedCount++;
            Logger.debug('[AudioCache] Skipping HLS stream:', url);
            return;
        }

        Logger.debug('[AudioCache] Processing cacheable URL:', url);

        const blob = await this.getBlob(url);
        if (blob) {
            const blobUrl = URL.createObjectURL(blob);
            AudioCache.trackObjectUrl(url, blobUrl);
            const audio = getAudioElement();
            const player = this.bridge.store.state.AudioPlayer;
            const playbackUrls = Object.values(originals);
            if (audio && !player.playing && playbackUrls.some(source =>
                normalizeMediaUrl(audio.currentSrc || audio.src || '') === normalizeMediaUrl(source || '')
            )) {
                audio.src = blobUrl;
                audio.crossOrigin = 'anonymous';
                audio.dataset[TRUSTED_CORS_SOURCE_DATASET_KEY] = normalizeMediaUrl(blobUrl) || blobUrl;
                trustedCorsPreloads.set(audio, normalizeMediaUrl(blobUrl) || blobUrl);
                audio.load();
            }
            AudioCache.cacheHits++;
            Logger.debug('[AudioCache] Cache hit for', url);
            return;
        }

        Logger.debug('[AudioCache] Cache miss. Background download:', url);
        if (!Config.get('autoCacheAudio')) {
            Logger.debug('[AudioCache] Automatic full-track caching is disabled; leaving playback on the stream');
            return;
        }
        this.backgroundDownload(url);
    }

    private backgroundDownload(url: string): void {
        if (this.inFlight.has(url)) {
            Logger.debug('[AudioCache] Already downloading:', url);
            return;
        }
        Logger.debug('[AudioCache] Starting background download:', url);

        const promise = (async () => {
            try {
                const res = await retryWithBackoff(
                    () => gmRequest({ url, responseType: 'blob' }),
                    { attempts: 2, backoffMs: 500 },
                );
                const blob = res.response as Blob;
                if (blob?.size > 0) await this.cacheAudio(url, blob);
            } catch {
                // gmRequest unavailable or failed — try native fetch
                const res = await fetch(url).catch(() => null);
                const blob = await res?.blob().catch(() => null);
                if (blob && blob.size > 0) await this.cacheAudio(url, blob);
            }
        })();

        this.inFlight.set(url, promise);
        promise.finally(() => {
            this.inFlight.delete(url);
        });
    }

    private static trackObjectUrl(sourceUrl: string, objectUrl: string): void {
        const existing = AudioCache.objectUrls.get(sourceUrl);
        if (existing && existing !== objectUrl) {
            URL.revokeObjectURL(existing);
        }
        AudioCache.objectUrls.set(sourceUrl, objectUrl);
        // Evict oldest blob URLs when over limit
        while (AudioCache.objectUrls.size > MAX_OBJECT_URLS) {
            const oldest = AudioCache.objectUrls.keys().next().value;
            if (oldest === undefined || oldest === sourceUrl) break;
            const oldUrl = AudioCache.objectUrls.get(oldest)!;
            URL.revokeObjectURL(oldUrl);
            AudioCache.objectUrls.delete(oldest);
        }
    }

    public static releaseUrl(sourceUrl: string): void {
        const existing = AudioCache.objectUrls.get(sourceUrl);
        if (existing) {
            URL.revokeObjectURL(existing);
            AudioCache.objectUrls.delete(sourceUrl);
        }
    }

    private handleTrackChange(track: PlayerTrack): void {
        if (!track) return;

        // Prefer direct download URL over streaming URL
        const downloadUrl = track.mediaDownloadUrl || track.media_download_url || track.file_url;
        const streamUrl = track.mediaStreamUrl || track.media_stream_url || track.stream_url || track.src || track.url;
        const url = downloadUrl || streamUrl;

        if (!url || url === this.lastUrl) return;
        Logger.debug('[AudioCache] Track change detected:', { title: track.title, url, downloadUrl, streamUrl });
        this.lastUrl = url;

        // Let interceptPlay handle the URL selection and HLS detection
        this.interceptPlay(track).catch(err => Logger.warn('[AudioCache] intercept failed:', err));
    }
}
