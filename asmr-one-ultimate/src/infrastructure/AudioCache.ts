import { openDB, DBSchema } from 'idb';
import { Logger } from '../core/Utils';
import { findIconButton, getAudioElement } from '../core/DomUtils';
import { KikoeruBridge } from './KikoeruBridge';
import { EventBus } from '../core/EventBus';

import { gmRequest, retryWithBackoff } from './HttpClient';

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
            db.put('blobs', entry); // Fire and forget update
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
                } catch (retryErr) {
                    Logger.error('[AudioCache] Cache write failed after eviction:', retryErr);
                }
            } else {
                Logger.error('[AudioCache] Cache write failed:', err);
            }
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

    public async interceptPlay(track: any): Promise<void> {
        if (!track) return;
        Logger.debug('[AudioCache] interceptPlay called with track:', track);
        // P13 FIX: Support multiple URL naming conventions
        const downloadUrl = track.mediaDownloadUrl || track.media_download_url || track.file_url;
        const streamUrl = track.mediaStreamUrl || track.media_stream_url || track.stream_url || track.src || track.url;

        // Try download URL first (cacheable), fall back to stream URL
        let url = downloadUrl && !this.isStream(downloadUrl) ? downloadUrl : streamUrl;
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
            if (track.src) track.src = blobUrl;
            if (track.mediaStreamUrl) track.mediaStreamUrl = blobUrl;
            if (track.mediaDownloadUrl) track.mediaDownloadUrl = blobUrl;
            const audio = getAudioElement();
            const player = this.bridge.store.state.AudioPlayer;
            if (audio && !player.playing && (audio.currentSrc === url || audio.src === url)) {
                audio.src = blobUrl;
                audio.load();
            }
            AudioCache.cacheHits++;
            Logger.debug('[AudioCache] Cache hit for', url);
            return;
        }

        Logger.debug('[AudioCache] Cache miss. Background download:', url);
        this.backgroundDownload(url);
    }

    private backgroundDownload(url: string): void {
        if (this.inFlight.has(url)) {
            Logger.debug('[AudioCache] Already downloading:', url);
            return;
        }
        Logger.debug('[AudioCache] Starting background download:', url);
        const cleanup = this.showSpinner();

        const promise = (async () => {
            try {
                const res = await retryWithBackoff(
                    () => gmRequest({ url, responseType: 'blob' }),
                    { attempts: 2, backoffMs: 500 },
                );
                const blob = res.response as Blob;
                if (blob?.size > 0) await this.cacheAudio(url, blob);
            } catch {
                // Fallback to fetch
                try {
                    const res = await fetch(url);
                    const blob = await res.blob();
                    if (blob.size > 0) await this.cacheAudio(url, blob);
                } catch (err) {
                    Logger.warn('[AudioCache] Download failed:', err);
                }
            }
        })();

        this.inFlight.set(url, promise);
        promise.finally(() => {
            this.inFlight.delete(url);
            cleanup();
        });
    }

    private showSpinner(): () => void {
        const btn = this.findPlayButton();
        if (!btn) return () => { };

        let spinner = btn.querySelector('.asmr-cache-spinner') as HTMLElement | null;
        if (!spinner) {
            spinner = document.createElement('span');
            spinner.className = 'asmr-cache-spinner';
            spinner.style.display = 'inline-block';
            spinner.style.width = '12px';
            spinner.style.height = '12px';
            spinner.style.marginLeft = '6px';
            spinner.style.border = '2px solid rgba(255, 255, 255, 0.4)';
            spinner.style.borderTopColor = 'rgba(255, 255, 255, 0.9)';
            spinner.style.borderRadius = '50%';
            spinner.style.animation = 'asmr-spin 1s linear infinite';
            btn.appendChild(spinner);
        }

        return () => {
            spinner?.remove();
        };
    }

    private findPlayButton(): HTMLElement | null {
        return findIconButton('play_arrow', '.audio-player')
            || findIconButton('play_arrow', '.player-bar');
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

    private handleTrackChange(track: any): void {
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
