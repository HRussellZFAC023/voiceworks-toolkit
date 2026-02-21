import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { Logger } from '../core/Utils';
import { EventBus } from '../core/EventBus';
import { getAudioElement, getCleanText, PLAYER_BAR_SELECTOR } from '../core/DomUtils';
import { gmRequest } from '../infrastructure/HttpClient';
import { buildCoverUrl } from '../types/api';
import type { KikoeruStoreState } from '../types';
import type { PlayerTrack, WorkDetail } from '../types';

const ARTWORK_MAX_EDGE = 512;
const ARTWORK_DATA_URL_TARGET_LEN = 420_000;

/**
 * Ensure a URL is absolute.  Relative paths (e.g. `/api/cover/…`) are
 * resolved against the current page origin so the Media Session API
 * (and lock-screen artwork on mobile) can fetch them.
 */
function toAbsoluteUrl(url: string): string {
    if (!url) return url;
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:')) {
        return url;
    }
    // Relative path — resolve against origin
    return new URL(url, window.location.origin).href;
}

function guessImageType(url: string): string | undefined {
    if (!url) return undefined;

    if (url.startsWith('data:')) {
        const mime = url.slice(5, url.indexOf(';'));
        return mime || undefined;
    }

    const path = url.split('?')[0].toLowerCase();
    if (path.endsWith('.png')) return 'image/png';
    if (path.endsWith('.webp')) return 'image/webp';
    if (path.endsWith('.gif')) return 'image/gif';
    if (path.endsWith('.avif')) return 'image/avif';
    if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
    return undefined;
}

function parseCssUrl(input: string): string {
    if (!input) return '';
    const match = input.match(/url\((['"]?)(.*?)\1\)/i);
    return match?.[2] || '';
}

export class MediaSessionManager {
    private bridge: KikoeruBridge;
    private unwatch: (() => void) | null = null;
    private lastMetadata: string | null = null;
    private timeupdateHandler: (() => void) | null = null;
    private connectedAudio: HTMLAudioElement | null = null;
    private lastTrack: PlayerTrack | undefined;
    private lastWork: WorkDetail | undefined;
    private artworkDataUrlCache = new Map<string, string>();
    private artworkPrefetching = new Map<string, Promise<string | null>>();
    private artworkFailed = new Set<string>();
    private artworkRefreshTimers: number[] = [];
    private artworkRefreshKey: string | null = null;
    private eventCleanups: Array<() => void> = [];
    private metadataRefreshHandler: (() => void) | null = null;
    private visibilityHandler: (() => void) | null = null;

    constructor() {
        this.bridge = KikoeruBridge.getInstance();
    }

    public enable(): void {
        if (!('mediaSession' in navigator)) {
            Logger.log('[MediaSession] API not supported in this browser');
            return;
        }

        Logger.log('[MediaSession] Enabling media session controls');
        const store = this.bridge.store;
        if (store.watch) {
            // Watch current track specifically for metadata updates
            this.unwatch = store.watch(
                (state: KikoeruStoreState) => ({
                    track: state.AudioPlayer?.currentTrack || state.AudioPlayer?.currentPlayingFile,
                    playing: state.AudioPlayer?.playing,
                    work: state.AudioPlayer?.work
                }),
                (val: { track: PlayerTrack | undefined; playing: boolean | undefined; work: WorkDetail | undefined }) => this.update(val)
            );
        }

        this.setHandlers();
        this.eventCleanups.push(
            EventBus.on('track:change', (payload) => this.onTrackChange(payload as { track?: PlayerTrack; workId?: string })),
            EventBus.on('work:change', () => this.forceMetadataRefresh('work:change')),
        );

        this.visibilityHandler = () => this.forceMetadataRefresh('visibilitychange');
        document.addEventListener('visibilitychange', this.visibilityHandler);
        window.addEventListener('pageshow', this.visibilityHandler);

        this.attachPositionSync();

        // Initial sync
        const state = this.readCurrentStoreState();
        this.update({
            track: state.track,
            playing: state.playing || false,
            work: state.work,
        });
    }

    private update(state: { track: PlayerTrack | undefined; playing: boolean | undefined; work: WorkDetail | undefined }): void {
        const current = this.readCurrentStoreState();
        const track = state.track || current.track || this.lastTrack;
        const work = state.work || current.work || this.lastWork;
        if (track) this.lastTrack = track;
        if (work) this.lastWork = work;

        this.updateMetadata(track, work);
        this.updatePlaybackState(!!(state.playing ?? current.playing));
        // Re-attach position sync in case the audio element changed (new track)
        this.attachPositionSync();
    }

    private updateMetadata(track: PlayerTrack | undefined, work: WorkDetail | undefined): void {
        const { title, artist, album } = this.resolveMetadataText(track, work);

        const coverCandidates = this.resolveCoverCandidates(track, work);
        const primaryRemoteCover = coverCandidates[0];
        const inlineCover = primaryRemoteCover ? this.artworkDataUrlCache.get(primaryRemoteCover) : undefined;
        const artwork = this.buildArtwork(coverCandidates, inlineCover);

        // Avoid spamming updates if metadata hasn't changed.
        // Include whether we upgraded to an inline (data URL) artwork source.
        const key = `${title}|${artist}|${album}|${coverCandidates.join(',')}|${inlineCover ? 'inline' : 'remote'}`;
        if (this.lastMetadata === key) return;
        this.lastMetadata = key;

        if (navigator.mediaSession) {
            navigator.mediaSession.metadata = new MediaMetadata({
                title,
                artist,
                album,
                artwork,
            });
            Logger.debug('[MediaSession] Updated metadata:', {
                title,
                artist,
                hasCover: coverCandidates.length > 0,
                inlineArtwork: !!inlineCover,
            });
        }

        // iOS lock screen / Dynamic Island may fail to fetch authenticated remote artwork.
        // Prefetch and cache a data URL so the system UI can always render artwork.
        if (primaryRemoteCover && !inlineCover) {
            this.prefetchArtworkDataUrl(primaryRemoteCover);
            this.scheduleArtworkRefresh(primaryRemoteCover);
        } else {
            this.clearArtworkRefreshTimers();
        }
    }

    private readCurrentStoreState(): {
        track: PlayerTrack | undefined;
        playing: boolean | undefined;
        work: WorkDetail | undefined;
    } {
        const ap = this.bridge.store.state.AudioPlayer;
        if (!ap) return { track: undefined, playing: undefined, work: undefined };
        return {
            track: ap.currentTrack || ap.currentPlayingFile,
            playing: ap.playing,
            work: ap.work,
        };
    }

    private onTrackChange(payload: { track?: PlayerTrack; workId?: string }): void {
        if (payload?.track) {
            this.lastTrack = payload.track;
        }
        if (payload?.workId) {
            const currentId = this.lastWork?.id ? String(this.lastWork.id) : '';
            if (currentId !== payload.workId) {
                const inferredTitle = this.textOrEmpty(payload.track?.workTitle);
                if (inferredTitle) {
                    this.lastWork = { id: payload.workId, title: inferredTitle } as unknown as WorkDetail;
                }
            }
        }
        this.forceMetadataRefresh('track:change');
    }

    private forceMetadataRefresh(reason: string): void {
        const current = this.readCurrentStoreState();
        const track = current.track || this.lastTrack;
        const work = current.work || this.lastWork;
        if (track) this.lastTrack = track;
        if (work) this.lastWork = work;
        this.lastMetadata = null;
        this.updateMetadata(track, work);
        this.updatePlaybackState(!!current.playing);
        this.attachPositionSync();
        Logger.debug('[MediaSession] Forced metadata refresh:', reason);
    }

    private textOrEmpty(value: unknown): string {
        if (typeof value !== 'string') return '';
        return value.replace(/\s+/g, ' ').trim();
    }

    private resolveMetadataText(track: PlayerTrack | undefined, work: WorkDetail | undefined): {
        title: string;
        artist: string;
        album: string;
    } {
        const trackTitle = this.textOrEmpty(track?.title);
        const trackWorkTitle = this.textOrEmpty(track?.workTitle);
        const workTitle = this.textOrEmpty(work?.title);
        const workName = this.textOrEmpty(work?.name);
        const circleName = this.textOrEmpty(work?.circle?.name);

        const dom = this.resolveNowPlayingTextFromDom(
            trackTitle || trackWorkTitle,
            workTitle || workName || trackWorkTitle,
        );

        const title = trackTitle || dom.trackTitle || workTitle || trackWorkTitle || 'No Track';
        const resolvedWorkTitle = workTitle || dom.workTitle || trackWorkTitle || workName;
        const artist = resolvedWorkTitle || circleName || workName || 'ASMR.one';
        const album = circleName || workName || resolvedWorkTitle || 'Unknown Album';

        return { title, artist, album };
    }

    private resolveNowPlayingTextFromDom(trackHint: string, workHint: string): {
        trackTitle: string;
        workTitle: string;
    } {
        const roots = Array.from(
            document.querySelectorAll<HTMLElement>(`${PLAYER_BAR_SELECTOR}, .audio-player, .current-play-list`)
        );

        let trackTitle = '';
        let workTitle = '';

        for (const root of roots) {
            const trackEl = this.findTrackTitleElement(root, trackHint);
            if (!trackTitle && trackEl) {
                trackTitle = this.textOrEmpty(getCleanText(trackEl));
            }

            const workEl = this.findWorkTitleElement(root, trackEl, workHint);
            if (!workTitle && workEl) {
                workTitle = this.textOrEmpty(getCleanText(workEl));
            }

            if (trackTitle && workTitle) break;
        }

        return { trackTitle, workTitle };
    }

    private findTrackTitleElement(root: HTMLElement, trackHint: string): HTMLElement | null {
        const candidates = Array.from(root.querySelectorAll<HTMLElement>(
            '.ellipsis-2-lines, .text-bold, .q-item__label:not(.q-item__label--caption)'
        ));

        let best: HTMLElement | null = null;
        let bestScore = Number.NEGATIVE_INFINITY;

        for (const el of candidates) {
            const text = this.textOrEmpty(getCleanText(el));
            if (!text) continue;

            let score = 0;
            if (el.classList.contains('text-bold')) score += 35;
            if (el.classList.contains('ellipsis-2-lines')) score += 30;
            if (!el.closest('.q-item')) score += 20;
            if (el.closest('.audio-player')) score += 10;
            if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(text)) score -= 70;

            if (trackHint) {
                if (text === trackHint) score += 120;
                else if (text.includes(trackHint) || trackHint.includes(text)) score += 60;
            }

            if (score > bestScore) {
                bestScore = score;
                best = el;
            }
        }

        return best;
    }

    private findWorkTitleElement(root: HTMLElement, trackEl: HTMLElement | null, workHint: string): HTMLElement | null {
        const candidates = Array.from(root.querySelectorAll<HTMLElement>(
            '.text-caption, .text-subtitle2, .text-grey-5, .q-item__label--caption'
        ));

        const trackText = trackEl ? this.textOrEmpty(getCleanText(trackEl)) : '';
        let best: HTMLElement | null = null;
        let bestScore = Number.NEGATIVE_INFINITY;

        for (const el of candidates) {
            const text = this.textOrEmpty(getCleanText(el));
            if (!text || text === trackText) continue;

            let score = 0;
            if (!el.closest('.q-item')) score += 25;
            if (el.closest('.audio-player')) score += 10;
            if (trackEl && trackEl.parentElement && el.parentElement === trackEl.parentElement) score += 15;
            if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(text)) score -= 70;
            if (/^\d+(?:\.\d+)?\s*(?:MB|GB|KB|kHz|Hz|fps)?$/i.test(text)) score -= 40;

            if (workHint) {
                if (text === workHint) score += 120;
                else if (text.includes(workHint) || workHint.includes(text)) score += 60;
            }

            if (score > bestScore) {
                bestScore = score;
                best = el;
            }
        }

        return best;
    }

    private resolveCoverCandidates(track: PlayerTrack | undefined, work: WorkDetail | undefined): string[] {
        const w = work as (WorkDetail & Record<string, unknown>) | undefined;
        const candidates: string[] = [];
        const push = (value: unknown) => {
            if (typeof value !== 'string') return;
            const trimmed = value.trim();
            if (!trimmed) return;
            candidates.push(toAbsoluteUrl(trimmed));
        };

        push(w?.mainCoverUrl);
        push(track?.cover);
        push((w?.main_cover as string | undefined));
        push((w?.cover as string | undefined));
        push((w?.thumbnail as string | undefined));
        push((w?.image_main as { url?: string } | undefined)?.url);
        push((w?.image_thum as { url?: string } | undefined)?.url);

        if (w?.id) {
            push(buildCoverUrl(w.id, 'main'));
        }

        // DOM fallback (works even when store metadata is incomplete).
        push(this.getCoverUrlFromDom());
        push(this.getFaviconUrl());

        const deduped: string[] = [];
        const seen = new Set<string>();
        for (const src of candidates) {
            if (!src || seen.has(src)) continue;
            seen.add(src);
            deduped.push(src);
        }
        return deduped;
    }

    private getCoverUrlFromDom(): string | undefined {
        const img = document.querySelector('.audio-player .albumart img, .audio-player .q-img img') as HTMLImageElement | null;
        if (img?.src) return img.src;

        const qimg = document.querySelector('.audio-player .albumart .q-img__image, .audio-player .q-img__image') as HTMLElement | null;
        if (qimg) {
            const bg = qimg.style.backgroundImage || getComputedStyle(qimg).backgroundImage || '';
            const parsed = parseCssUrl(bg);
            if (parsed) return parsed;
        }
        return undefined;
    }

    private getFaviconUrl(): string | undefined {
        const icon = document.querySelector('link[rel*="icon"]') as HTMLLinkElement | null;
        if (!icon?.href) return undefined;
        return toAbsoluteUrl(icon.href);
    }

    private buildArtwork(coverCandidates: string[], inlineCover?: string): MediaImage[] {
        const preferred: string[] = [];
        if (inlineCover) preferred.push(inlineCover);
        for (const src of coverCandidates) {
            if (preferred.includes(src)) continue;
            preferred.push(src);
            if (preferred.length >= 2) break;
        }

        const sizes = ['96x96', '128x128', '192x192', '256x256', '384x384', '512x512'];
        const artwork: MediaImage[] = [];
        for (const src of preferred) {
            const type = guessImageType(src);
            for (const size of sizes) {
                const entry: MediaImage = { src, sizes: size };
                if (type) entry.type = type;
                artwork.push(entry);
            }
        }
        return artwork;
    }

    private prefetchArtworkDataUrl(coverUrl: string): void {
        if (!coverUrl) return;
        if (this.artworkDataUrlCache.has(coverUrl)) return;
        if (this.artworkFailed.has(coverUrl)) return;
        if (this.artworkPrefetching.has(coverUrl)) return;

        const task = this.fetchArtworkDataUrl(coverUrl)
            .then((dataUrl) => {
                if (!dataUrl) {
                    this.artworkFailed.add(coverUrl);
                    Logger.warn('[MediaSession] Artwork prefetch failed:', coverUrl);
                    return null;
                }
                this.artworkDataUrlCache.set(coverUrl, dataUrl);
                Logger.debug('[MediaSession] Cached inline artwork data URL:', {
                    source: coverUrl,
                    length: dataUrl.length,
                });
                // Bound cache growth in long sessions.
                if (this.artworkDataUrlCache.size > 24) {
                    const oldest = this.artworkDataUrlCache.keys().next().value as string | undefined;
                    if (oldest) this.artworkDataUrlCache.delete(oldest);
                }
                // Re-emit metadata so lock-screen/Dynamic Island can switch to inline artwork.
                this.lastMetadata = null;
                this.updateMetadata(this.lastTrack, this.lastWork);
                return dataUrl;
            })
            .catch(() => {
                this.artworkFailed.add(coverUrl);
                return null;
            })
            .finally(() => {
                this.artworkPrefetching.delete(coverUrl);
            });

        this.artworkPrefetching.set(coverUrl, task);
    }

    private async fetchArtworkDataUrl(coverUrl: string): Promise<string | null> {
        try {
            const gmRes = await gmRequest({
                url: coverUrl,
                responseType: 'blob',
                timeout: 15000,
            });
            const blob = gmRes.response as Blob | undefined;
            if (blob instanceof Blob && blob.size > 0) {
                return await this.blobToOptimizedDataUrl(blob);
            }
        } catch {
            // Fall through to fetch() fallback.
        }

        try {
            const res = await fetch(coverUrl, { credentials: 'include' });
            if (!res.ok) return null;
            const blob = await res.blob();
            if (!(blob instanceof Blob) || blob.size <= 0) return null;
            return await this.blobToOptimizedDataUrl(blob);
        } catch {
            return null;
        }
    }

    private async blobToOptimizedDataUrl(blob: Blob): Promise<string> {
        // Non-image payloads: preserve old behavior.
        if (!blob.type || !blob.type.startsWith('image/')) {
            return this.blobToDataUrl(blob);
        }

        try {
            const img = await this.loadImageFromBlob(blob);
            const srcW = img.naturalWidth || img.width || ARTWORK_MAX_EDGE;
            const srcH = img.naturalHeight || img.height || ARTWORK_MAX_EDGE;
            const scale = Math.min(1, ARTWORK_MAX_EDGE / Math.max(srcW, srcH));
            const dstW = Math.max(1, Math.round(srcW * scale));
            const dstH = Math.max(1, Math.round(srcH * scale));

            const canvas = document.createElement('canvas');
            canvas.width = dstW;
            canvas.height = dstH;
            const ctx = canvas.getContext('2d');
            if (!ctx) return this.blobToDataUrl(blob);
            ctx.drawImage(img, 0, 0, dstW, dstH);

            let quality = 0.9;
            let dataUrl = canvas.toDataURL('image/jpeg', quality);
            while (dataUrl.length > ARTWORK_DATA_URL_TARGET_LEN && quality > 0.55) {
                quality -= 0.1;
                dataUrl = canvas.toDataURL('image/jpeg', quality);
            }
            return dataUrl;
        } catch {
            return this.blobToDataUrl(blob);
        }
    }

    private loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(blob);
            const img = new Image();
            img.decoding = 'async';
            img.onload = () => {
                URL.revokeObjectURL(url);
                resolve(img);
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error('Failed to decode artwork blob'));
            };
            img.src = url;
        });
    }

    private blobToDataUrl(blob: Blob): Promise<string> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(reader.error || new Error('Failed to read blob as data URL'));
            reader.readAsDataURL(blob);
        });
    }

    private scheduleArtworkRefresh(coverUrl: string): void {
        if (this.artworkDataUrlCache.has(coverUrl)) return;
        if (this.artworkRefreshKey === coverUrl && this.artworkRefreshTimers.length > 0) return;

        this.clearArtworkRefreshTimers();
        this.artworkRefreshKey = coverUrl;
        for (const delay of [900, 2600, 5200]) {
            const timer = window.setTimeout(() => {
                // If cached meanwhile, no refresh needed.
                if (this.artworkDataUrlCache.has(coverUrl)) {
                    this.clearArtworkRefreshTimers();
                    return;
                }
                this.lastMetadata = null;
                this.updateMetadata(this.lastTrack, this.lastWork);
            }, delay);
            this.artworkRefreshTimers.push(timer);
        }
    }

    private clearArtworkRefreshTimers(): void {
        for (const timer of this.artworkRefreshTimers) {
            clearTimeout(timer);
        }
        this.artworkRefreshTimers = [];
        this.artworkRefreshKey = null;
    }

    private updatePlaybackState(playing: boolean): void {
        if (navigator.mediaSession) {
            navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
        }
    }

    // ------------------------------------------------------------------
    // Position state — enables the lock-screen progress bar / scrubber
    // ------------------------------------------------------------------

    private attachPositionSync(): void {
        const audio = getAudioElement();
        if (!audio || audio === this.connectedAudio) return;

        // Detach from previous element
        this.detachPositionSync();

        this.connectedAudio = audio;
        this.timeupdateHandler = () => {
            this.syncPositionState(audio);
            this.updatePlaybackState(!audio.paused);
        };
        this.metadataRefreshHandler = () => this.forceMetadataRefresh('audio-event');
        audio.addEventListener('timeupdate', this.timeupdateHandler);

        // Keep lock screen state in sync across seeks, play/pause, and metadata load.
        audio.addEventListener('seeked', this.timeupdateHandler);
        audio.addEventListener('play', this.timeupdateHandler);
        audio.addEventListener('pause', this.timeupdateHandler);
        audio.addEventListener('loadedmetadata', this.timeupdateHandler);
        audio.addEventListener('ratechange', this.timeupdateHandler);
        audio.addEventListener('loadedmetadata', this.metadataRefreshHandler);
        audio.addEventListener('canplay', this.metadataRefreshHandler);
        audio.addEventListener('playing', this.metadataRefreshHandler);
        // Initial state sync for newly connected audio element.
        this.timeupdateHandler();
    }

    private detachPositionSync(): void {
        if (this.connectedAudio && this.timeupdateHandler) {
            this.connectedAudio.removeEventListener('timeupdate', this.timeupdateHandler);
            this.connectedAudio.removeEventListener('seeked', this.timeupdateHandler);
            this.connectedAudio.removeEventListener('play', this.timeupdateHandler);
            this.connectedAudio.removeEventListener('pause', this.timeupdateHandler);
            this.connectedAudio.removeEventListener('loadedmetadata', this.timeupdateHandler);
            this.connectedAudio.removeEventListener('ratechange', this.timeupdateHandler);
            if (this.metadataRefreshHandler) {
                this.connectedAudio.removeEventListener('loadedmetadata', this.metadataRefreshHandler);
                this.connectedAudio.removeEventListener('canplay', this.metadataRefreshHandler);
                this.connectedAudio.removeEventListener('playing', this.metadataRefreshHandler);
            }
        }
        this.connectedAudio = null;
        this.timeupdateHandler = null;
        this.metadataRefreshHandler = null;
    }

    private syncPositionState(audio: HTMLAudioElement): void {
        if (!navigator.mediaSession) return;
        const duration = audio.duration;
        // duration must be a valid positive finite number
        if (!duration || !isFinite(duration) || duration <= 0) return;

        try {
            navigator.mediaSession.setPositionState({
                duration,
                playbackRate: audio.playbackRate || 1,
                position: Math.min(audio.currentTime, duration),
            });
        } catch {
            // Some browsers throw if position > duration (race condition)
        }
    }

    // ------------------------------------------------------------------
    // Action handlers (lock-screen / headphone buttons)
    // ------------------------------------------------------------------

    private setHandlers(): void {
        if (!navigator.mediaSession) return;
        const ms = navigator.mediaSession;
        const store = this.bridge.store;

        const safeDispatch = (action: string, payload?: unknown) => {
            Logger.debug(`[MediaSession] Action triggered: ${action}`);
            if (store.dispatch) {
                store.dispatch(action, payload).catch((err: unknown) =>
                    Logger.warn(`[MediaSession] Action ${action} failed:`, err)
                );
            }
        };

        // Play
        ms.setActionHandler('play', () => {
            safeDispatch('AudioPlayer/play');
        });

        // Pause
        ms.setActionHandler('pause', () => {
            safeDispatch('AudioPlayer/pause');
        });

        // Previous Track
        ms.setActionHandler('previoustrack', () => {
            safeDispatch('AudioPlayer/prev');
        });

        // Next Track
        ms.setActionHandler('nexttrack', () => {
            safeDispatch('AudioPlayer/next');
        });

        // Seek Backward (typically 10 seconds)
        ms.setActionHandler('seekbackward', (details) => {
            const skipTime = details.seekOffset || 10;
            const audio = getAudioElement();
            if (audio) {
                audio.currentTime = Math.max(audio.currentTime - skipTime, 0);
                Logger.debug(`[MediaSession] Seeked backward ${skipTime}s`);
            }
        });

        // Seek Forward (typically 10 seconds)
        ms.setActionHandler('seekforward', (details) => {
            const skipTime = details.seekOffset || 10;
            const audio = getAudioElement();
            if (audio) {
                audio.currentTime = Math.min(audio.currentTime + skipTime, audio.duration);
                Logger.debug(`[MediaSession] Seeked forward ${skipTime}s`);
            }
        });

        // Seek To (scrubbing on lock screen)
        ms.setActionHandler('seekto', (details) => {
            const audio = getAudioElement();
            if (audio && details.seekTime !== undefined) {
                audio.currentTime = details.seekTime;
                Logger.debug(`[MediaSession] Seeked to ${details.seekTime}s`);
            }
        });

        Logger.log('[MediaSession] All action handlers registered');
    }

    public disable(): void {
        if (this.unwatch) {
            this.unwatch();
            this.unwatch = null;
        }
        for (const cleanup of this.eventCleanups) {
            try { cleanup(); } catch { /* no-op */ }
        }
        this.eventCleanups = [];
        if (this.visibilityHandler) {
            document.removeEventListener('visibilitychange', this.visibilityHandler);
            window.removeEventListener('pageshow', this.visibilityHandler);
            this.visibilityHandler = null;
        }
        this.detachPositionSync();
        this.clearArtworkRefreshTimers();
        if (navigator.mediaSession) {
            navigator.mediaSession.metadata = null;
            navigator.mediaSession.setActionHandler('play', null);
            navigator.mediaSession.setActionHandler('pause', null);
            navigator.mediaSession.setActionHandler('previoustrack', null);
            navigator.mediaSession.setActionHandler('nexttrack', null);
            navigator.mediaSession.setActionHandler('seekbackward', null);
            navigator.mediaSession.setActionHandler('seekforward', null);
            navigator.mediaSession.setActionHandler('seekto', null);
        }
    }
}
