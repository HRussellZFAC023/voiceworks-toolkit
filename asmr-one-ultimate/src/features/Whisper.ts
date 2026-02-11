/**
 * Whisper - Real-time WebGPU transcription (rebuilt)
 *
 * - Captures audio directly from the <audio> element (no file download)
 * - Uses Transformers.js in a Web Worker (WebGPU required)
 * - Emits live segments to Learner Mode + mini player
 * - Caches transcripts per track for near-instant reloads
 */

import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { Logger, Config, I18n } from '../core/Utils';
import { EventBus } from '../core/EventBus';
import { createWhisperWorker } from './WhisperWorkerLoader';
import { getAudioElement } from '../core/DomUtils';
import { SharedCache, CacheKeys } from '../core/Cache';
import type { WhisperSegment, WhisperWord, KikoeruStoreState } from '../types';
import { AppStore } from '../store/AppStore';
import { TranslationService } from '../services/TranslationService';
import { AudioCache } from '../infrastructure/AudioCache';
import { gmRequest } from '../infrastructure/HttpClient';
import { GpuScheduler, Priority } from '../core/GpuScheduler';
import { buildLrcFromSegments, buildVttFromSegments } from './transcriptFileUtils';
import { correctWhisperText } from '../data/nsfw-glossary';

// ============================================================================
// Constants
// ============================================================================

const TARGET_SAMPLE_RATE = 16000;
const MAX_PENDING_CHUNKS = 6;
const DEFAULT_MODEL = 'onnx-community/whisper-small_timestamped';
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 90; // 90 days
const MODEL_READY_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
// No lookahead limit — transcribe the entire audio from start to finish.
// MAX_PENDING_CHUNKS provides natural backpressure (6 concurrent chunks max).
const INITIAL_BACKFILL_SEC = 30;
const SEEK_BACKFILL_SEC = 15;
const POLL_INTERVAL_MS = 250;
const TRANSLATE_AHEAD_MAX_SEGMENTS_PER_RUN = 50;

// ============================================================================
// Worker message types
// ============================================================================

type WorkerProgressMessage = {
    status: 'progress';
    file?: string;
    progress?: number;
    loaded?: number;
    total?: number;
    message?: string;
};

type ChunkWordEntry = { text: string; start: number | null; end: number | null };

type ChunkEntry = {
    text: string;
    timestamp?: [number | null, number | null];
    words?: ChunkWordEntry[];
};

type WorkerUpdateMessage = {
    status: 'update';
    data: [string, { chunks?: ChunkEntry[] }];
    chunkId?: number;
};

type WorkerCompleteMessage = {
    status: 'complete';
    data: { text?: string; chunks?: ChunkEntry[] };
    chunkId?: number;
};

type WorkerReadyMessage = { status: 'ready'; backend?: string; vendor?: string };

type WorkerInitMessage = { status: 'initiate'; backend?: string; vendor?: string };

type WorkerErrorMessage = { status: 'error'; data?: { message?: string } };

type WorkerDeviceLostMessage = { status: 'gpu-device-lost'; data?: { message?: string } };

type WorkerGpuDegradedMessage = { status: 'gpu-degraded'; data?: { message?: string } };

type WorkerFallbackMessage = { status: 'fallback'; originalModel: string; fallbackModel: string; reason?: string };

type WorkerMessage =
    | WorkerProgressMessage
    | WorkerUpdateMessage
    | WorkerCompleteMessage
    | WorkerReadyMessage
    | WorkerInitMessage
    | WorkerErrorMessage
    | WorkerDeviceLostMessage
    | WorkerGpuDegradedMessage
    | WorkerFallbackMessage;

// ============================================================================
// Whisper Controller
// ============================================================================

interface WhisperSettings {
    model: string;
    subtask: string;
    language: string;
    quantized: boolean;
    multilingual: boolean;
    chunkLengthS: number;
    strideLengthS: number;
    cacheTranscripts: boolean;
    autoWarmup: boolean;
    allowWasm: boolean;
    silenceThreshold: number;
}

interface CachedTranscript {
    text: string;
    segments: WhisperSegment[];
    model: string;
    subtask: string;
    language: string;
    createdAt: number;
    lrc?: string;
    vtt?: string;
    complete?: boolean;
    translations?: Record<string, { text: string; lrc: string; vtt?: string }>;
    /** Original identity string (pre-hash) for collision detection. Added Feb 2026. */
    sourceIdentity?: string;
}

interface TranscriptIndexEntry {
    cacheKey: string;
    trackKey: string;
    trackTitle?: string;
    workId?: string;
    model: string;
    subtask: string;
    language: string;
    updatedAt: number;
    duration?: number;
}

export class Whisper {
    private static instance: Whisper | null = null;

    public static getInstance(): Whisper {
        if (!Whisper.instance) {
            Whisper.instance = new Whisper();
        }
        return Whisper.instance;
    }
    private bridge: KikoeruBridge;
    private worker: Worker | null = null;
    private audio: HTMLAudioElement | null = null;

    // Pre-decoded PCM buffer for lookahead processing
    private pcmBuffer: Float32Array | null = null;
    private pcmSourceUrl: string | null = null; // URL the pcmBuffer was decoded from
    private pcmDuration = 0; // seconds
    private transcribedUpTo = 0; // how far we've sent chunks to worker (seconds)
    private processingLoopId: number | null = null;

    private transcribing = false;
    private pendingChunks = 0;
    private nextChunkId = 0;
    private lastSegmentEnd = 0;
    private segments: WhisperSegment[] = [];
    private currentTrackSrc: string | null = null;
    private currentCacheKey: string | null = null;
    private currentCacheIdentity: string | null = null;
    private chunkSendTimes = new Map<number, number>();
    private chunkGenerations = new Map<number, number>();

    private statusEl: HTMLElement | null = null;
    private errorDismissTimer: number | null = null;

    private modelLoadingKey = '';
    private autoWarmupStarted = false;
    private modelLoadTimer: number | null = null;
    private modelReady = false;
    private autoTranscribeWorkId: string | null = null;

    private finalizeOnIdle = false;
    private translationInFlight = new Set<string>();
    private lastTranslatedSegmentCount = 0;
    private translateAheadUpTo = 0; // seconds: segments up to this time already sent for translation
    private lastTranscribeProgressAt = 0;
    private lastPersistAt = 0;
    private transcriptionGeneration = 0;
    private static gpuRecoveryAttempts = 0;
    private static readonly MAX_GPU_RECOVERY = 3;
    private static webgpuFailed = false;
    private gpuCrashed = false; // Fatal GPU device loss — persistent crash state
    private gpuRecoveryTimer: number | null = null;
    private idleUnloadTimer: number | null = null;
    private loadLeaseRelease: (() => void) | null = null; // GpuScheduler load lease
    private static readonly IDLE_UNLOAD_MS = 10 * 60 * 1000; // 10 minutes
    private storeWatcherBound = false;
    private _audioCache: AudioCache | null = null;
    private autoStartTimer: number | null = null;
    private fetchAbortController: AbortController | null = null;

    private getAudioCache(): AudioCache | null {
        if (!AudioCache.objectUrls) return null;
        if (!this._audioCache) this._audioCache = new AudioCache();
        return this._audioCache;
    }

    constructor() {
        this.bridge = KikoeruBridge.getInstance();
        this.setupEventListeners();
        if (!Whisper.instance) {
            Whisper.instance = this;
        }
    }

    // ------------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------------

    public enable(): void {
        Logger.log('[Whisper] Enabling Whisper...');

        const settings = this.getWhisperSettings();
        if (settings.autoWarmup && !this.autoWarmupStarted) {
            this.autoWarmupStarted = true;
            this.initWorker(settings);
        }

        // Use Vuex store.watch to reactively detect playback start.
        // This fires whenever AudioPlayer.playing transitions to true —
        // covers initial load, user pressing play, and track advances.
        // Guard against double registration (enable() called multiple times).
        if (!this.storeWatcherBound) {
            this.storeWatcherBound = true;
            this.bridge.store.watch?.(
                (state: KikoeruStoreState) => !!state.AudioPlayer?.playing,
                (playing: boolean) => {
                    if (playing && Config.get('alwaysTranscribe') && !this.transcribing) {
                        this.tryAutoStartForCurrentTrack();
                    }
                }
            );
        }

        // Also try immediately in case audio is already playing at enable() time
        if (Config.get('alwaysTranscribe')) {
            this.tryAutoStartForCurrentTrack();
        }
    }

    /**
     * Try to auto-start transcription for the current track.
     * Returns true if transcription was started (or is already running).
     */
    private tryAutoStartForCurrentTrack(): boolean {
        if (this.transcribing) return true;
        const track = this.bridge.currentTrack;
        const rawSrc = track?.hash || track?.mediaStreamUrl || track?.src;
        if (!rawSrc) return false;
        const src = this.resolveOriginalUrl(rawSrc);

        Logger.debug('[Whisper] Always-transcribe: auto-starting for current track');
        this.currentTrackSrc = src;
        this.autoTranscribeWorkId = this.bridge.currentWorkId || null;
        this.scheduleAutoStart(this.autoTranscribeWorkId || '');
        return true;
    }

    public warmupModel(force = false): void {
        const settings = this.getWhisperSettings();
        if (force) {
            if (this.transcribing) {
                this.stopTranscription('model-change');
            }
            this.clearModelLoadTimer();
            this.resetWorker('model-change');
            this.modelLoadingKey = '';
            AppStore.setWhisperState({
                isTranscribing: this.transcribing,
                isLoadingModel: false,
                progress: 0,
                progressMessage: '',
                currentTrackSrc: this.currentTrackSrc,
            });
            this.clearStatus();
        }
        if (!this.autoWarmupStarted) {
            this.autoWarmupStarted = true;
        }
        // Just trigger the worker and let it report progress.
        this.initWorker(settings);
    }

    // ------------------------------------------------------------------------
    // Event wiring
    // ------------------------------------------------------------------------

    private setupEventListeners(): void {
        EventBus.on('whisper:toggle', () => this.toggleTranscription());

        // Listen for centralized track change events from KikoeruBridge
        EventBus.on('track:change', (payload) => {
            const track = payload.track;
            // Use hash as canonical ID (AudioCache mutates mediaStreamUrl/src to blob URLs,
            // which would trigger false change detections). Resolve blob URLs as fallback.
            const rawSrc = track.hash || track.mediaStreamUrl || track.src || null;
            const newSrc = rawSrc ? this.resolveOriginalUrl(rawSrc) : null;
            if (newSrc && newSrc !== this.currentTrackSrc) {
                Logger.debug('[Whisper] Track change event received via EventBus', { newSrc });
                this.handleTrackChange(newSrc);
            }
        });

        // No cross-service webgpu:failed propagation for dtype failures — Whisper independently
        // tries WebGPU. But true GPU device loss (process crash) affects ALL workers.
        EventBus.on('gpu:device-lost-broadcast', ({ source }) => {
            if (source === 'whisper') return; // Already handled by our own error path
            if (Whisper.webgpuFailed) return; // Already on WASM
            Logger.warn(`[Whisper] GPU device lost in ${source} worker — switching to WASM`);
            Whisper.webgpuFailed = true;
            if (this.worker) {
                this.worker.postMessage({ type: 'skip-webgpu' });
            }
        });
    }

    private handleTrackChange(newSrc: string): void {
        const currentWorkId = this.bridge.currentWorkId;
        const wasAutoTranscribing = this.autoTranscribeWorkId !== null;
        const sameWork = wasAutoTranscribing && currentWorkId === this.autoTranscribeWorkId;

        Logger.debug('[Whisper] Track changed.', {
            previous: this.currentTrackSrc,
            next: newSrc,
            sameWork,
            autoTranscribeWorkId: this.autoTranscribeWorkId,
            currentWorkId
        });

        // Cancel any pending auto-start from a previous track change
        this.clearAutoStartTimer();

        // Abort any in-flight audio download for the previous track
        this.abortFetch();

        // Flush stale chunks from the worker queue so they don't waste compute time
        // or delay new track's processing. Results would be generation-filtered anyway,
        // but flushing prevents the worker from decoding old audio chunks.
        if (this.worker) {
            this.worker.postMessage({ type: 'flush-queue' });
        }

        if (this.transcribing) {
            this.stopTranscription('track-change');
        }
        this.currentTrackSrc = newSrc;
        this.resetState('track-change');
        EventBus.emit('whisper:clear', undefined);

        // If we were auto-transcribing and still on the same work, restart transcription
        if (sameWork) {
            Logger.debug('[Whisper] Auto-restarting transcription for same work');
            this.scheduleAutoStart(currentWorkId);
        } else if (Config.get('alwaysTranscribe')) {
            // Always-transcribe mode: auto-start on every track change
            Logger.debug('[Whisper] Always-transcribe enabled, auto-starting for new track');
            this.autoTranscribeWorkId = currentWorkId;
            this.scheduleAutoStart(currentWorkId);
        } else if (wasAutoTranscribing && currentWorkId !== this.autoTranscribeWorkId) {
            // Work changed - clear auto-transcribe state
            Logger.debug('[Whisper] Work changed, clearing auto-transcribe state');
            this.autoTranscribeWorkId = null;
            this.setButtonsActive(false);
        }
    }

    /**
     * Schedule auto-start transcription with a cancellable timer.
     * Prevents stale starts when tracks are skipped rapidly.
     */
    private scheduleAutoStart(workId: string): void {
        this.clearAutoStartTimer();
        this.autoStartTimer = window.setTimeout(() => {
            this.autoStartTimer = null;
            // Guard: only start if we're still on the same work
            if (this.autoTranscribeWorkId === workId || Config.get('alwaysTranscribe')) {
                this.startTranscription().catch(err => Logger.error('[Whisper] Auto-start failed:', err));
            }
        }, 500);
    }

    private clearAutoStartTimer(): void {
        if (this.autoStartTimer !== null) {
            clearTimeout(this.autoStartTimer);
            this.autoStartTimer = null;
        }
    }

    private abortFetch(): void {
        if (this.fetchAbortController) {
            this.fetchAbortController.abort();
            this.fetchAbortController = null;
        }
    }

    // ------------------------------------------------------------------------
    // Transcription control
    // ------------------------------------------------------------------------

    private toggleTranscription(): void {
        if (this.transcribing) {
            // User manually turned off - clear auto-transcribe for this work
            this.autoTranscribeWorkId = null;
            this.stopTranscription('toggle');
        } else {
            this.startTranscription().catch(err => Logger.error('[Whisper] Toggle start failed:', err));
        }
    }

    private async startTranscription(): Promise<void> {
        if (this.transcribing) return;
        if (this.gpuCrashed) {
            Logger.warn('[Whisper] startTranscription blocked — GPU crashed this session');
            return;
        }
        this.clearIdleUnloadTimer();

        const audio = getAudioElement();
        if (!audio) {
            this.dispatchError(I18n.t('whisperNoAudioSource'));
            return;
        }

        // Prefer bridge track info — audio element may still have the old src after track change
        // Resolve blob URLs to original URLs (AudioCache may have mutated track properties)
        const bridgeTrack = this.bridge.currentTrack;
        const audioSrc = audio.currentSrc || audio.src || null;
        const rawSrc = bridgeTrack?.mediaStreamUrl || bridgeTrack?.src || audioSrc;
        const src = rawSrc ? this.resolveOriginalUrl(rawSrc) : null;
        if (!src) {
            this.dispatchError(I18n.t('whisperNoAudioSource'));
            return;
        }

        this.transcribing = true;
        EventBus.emit('whisper:transcribing', { active: true });
        this.setButtonsActive(true);
        this.dispatchProgress(I18n.t('whisperInit'), 0, 'loading');

        const rawTrackId = bridgeTrack?.hash || bridgeTrack?.mediaStreamUrl || src;
        this.currentTrackSrc = this.resolveOriginalUrl(rawTrackId);
        this.audio = audio;
        const workId = this.bridge.currentWorkId;
        this.autoTranscribeWorkId = workId || null;
        AppStore.setWhisperState({ currentTrackSrc: src, isTranscribing: true });
        this.segments = [];
        this.lastSegmentEnd = 0;
        this.nextChunkId = 0;
        this.pendingChunks = 0;
        this.chunkSendTimes.clear();
        this.chunkGenerations.clear();
        this.finalizeOnIdle = false;
        this.lastTranslatedSegmentCount = 0;
        this.translateAheadUpTo = 0;
        this.pcmBuffer = null;
        this.pcmDuration = 0;
        this.transcribedUpTo = 0;

        const settings = this.getWhisperSettings();
        this.currentCacheIdentity = this.buildCacheIdentity(src, settings);
        this.currentCacheKey = this.buildCacheKey(src, settings);

        if (settings.cacheTranscripts) {
            const cached = SharedCache.get<CachedTranscript>(this.currentCacheKey);
            if (cached && cached.segments?.length) {
                // Verify the cached transcript's source identity matches ours.
                // hashString is 32-bit, so collisions are theoretically possible.
                // Old cache entries (pre-Feb 2026) won't have sourceIdentity — accept them.
                if (cached.sourceIdentity && cached.sourceIdentity !== this.currentCacheIdentity) {
                    Logger.warn('[Whisper] Cache key collision detected! Ignoring stale cache.', {
                        expected: this.currentCacheIdentity,
                        cached: cached.sourceIdentity,
                    });
                } else {
                    Logger.debug('[Whisper] Using cached transcript:', { segments: cached.segments.length, complete: !!cached.complete });
                    // Apply hallucination corrections to cached segments (new corrections retroactively fix old caches)
                    for (const seg of cached.segments) {
                        const corrected = correctWhisperText(seg.text);
                        if (corrected !== seg.text) seg.text = corrected;
                    }
                    this.segments = cached.segments;
                    this.lastSegmentEnd = cached.segments[cached.segments.length - 1]?.end || 0;
                    this.updateTranscriptIndex(this.currentCacheKey, cached);
                    const latest = cached.segments[cached.segments.length - 1];
                    EventBus.emit('whisper:update', {
                        text: latest?.text || cached.text,
                        segments: cached.segments,
                        final: !!cached.complete,
                        fromCache: true,
                        live: false,
                        source: 'cache',
                    });
                    if (cached.complete) {
                        EventBus.emit('whisper:complete', { text: cached.text });
                        this.stopTranscription('cache-hit');
                        return;
                    }
                    // Incomplete cache — continue transcription from where we left off
                    Logger.debug('[Whisper] Cache incomplete, continuing transcription from', this.lastSegmentEnd.toFixed(1) + 's');
                    this.transcribedUpTo = Math.max(0, this.lastSegmentEnd - 2);
                    this.lastTranslatedSegmentCount = this.segments.length;
                    this.translateAheadUpTo = this.lastSegmentEnd;
                }
            }
        }

        // Resolve the best URL for fetching the audio file
        const trackUrl = this.resolveTrackUrl() || src;

        if (this.isHlsUrl(trackUrl)) {
            Logger.warn('[Whisper] HLS streams are not supported for transcription:', trackUrl);
            this.dispatchError(I18n.t('whisperHlsWarning'));
            this.stopTranscription('hls-not-supported');
            return;
        }

        // Fetch + decode the full audio file for lookahead processing
        const cacheTranscribedUpTo = this.transcribedUpTo; // 0 if no cache, >0 if partial
        const startGeneration = this.transcriptionGeneration;
        this.dispatchProgress(I18n.t('whisperFetchingAudio'), 0, 'loading');
        // Create a fresh AbortController so handleTrackChange can cancel this download
        this.abortFetch();
        this.fetchAbortController = new AbortController();
        try {
            this.pcmBuffer = await this.fetchAndDecodeAudio(trackUrl, this.fetchAbortController.signal);
            this.pcmSourceUrl = trackUrl;

            // Guard: if a track change happened during the async fetch/decode,
            // this startTranscription call is stale — discard the decoded audio.
            if (this.transcriptionGeneration !== startGeneration) {
                Logger.debug('[Whisper] Track changed during fetch/decode, discarding stale audio');
                this.pcmBuffer = null;
                this.pcmSourceUrl = null;
                return;
            }

            this.pcmDuration = this.pcmBuffer.length / TARGET_SAMPLE_RATE;
            // Backfill a small window so model load latency does not drop opening lines.
            this.transcribedUpTo = Math.max(0, Math.min(this.pcmDuration, audio.currentTime - INITIAL_BACKFILL_SEC));

            // Preserve cache continuation point if it's further along
            if (cacheTranscribedUpTo > this.transcribedUpTo) {
                this.transcribedUpTo = cacheTranscribedUpTo;
                Logger.debug('[Whisper] Restored cache continuation point:', cacheTranscribedUpTo.toFixed(1) + 's');
            }

            Logger.debug('[Whisper] Audio decoded:', {
                duration: this.pcmDuration.toFixed(1) + 's',
                samples: this.pcmBuffer.length,
                startFrom: this.transcribedUpTo.toFixed(1) + 's',
            });
        } catch (err) {
            // AbortError means track changed while downloading — not a real error
            if (err instanceof DOMException && err.name === 'AbortError') {
                Logger.debug('[Whisper] Audio fetch aborted (track changed)');
                this.stopTranscription('fetch-aborted');
                return;
            }
            Logger.error('[Whisper] Failed to fetch and decode audio:', err);
            this.dispatchError(I18n.format('whisperTranscriptionError', { message: String(err) }));
            this.stopTranscription('fetch-failed');
            return;
        }

        // Ensure worker + model
        this.initWorker(settings);

        audio.addEventListener('seeking', this.handleSeek);
        audio.addEventListener('pause', this.handlePause);
        audio.addEventListener('play', this.handlePlay);
        audio.addEventListener('ended', this.handleEnded);

        this.startProcessingLoop();

        this.dispatchProgress(I18n.t('whisperTranscribing'), 0, 'transcribing');
        Logger.debug('[Whisper] Transcription started.', { src, settings });
    }

    private stopTranscription(reason: string): void {
        if (!this.transcribing) return;
        Logger.debug('[Whisper] Stopping transcription:', reason);

        const shouldFinalize = this.finalizeOnIdle;
        this.transcribing = false;
        EventBus.emit('whisper:transcribing', { active: false });
        this.finalizeOnIdle = false;
        this.clearModelLoadTimer();
        this.clearAutoStartTimer();
        this.abortFetch();
        // Keep buttons active if auto-transcribe is still enabled (track change or cache hit within work)
        const keepActive = this.autoTranscribeWorkId && (reason === 'track-change' || reason === 'cache-hit');
        if (!keepActive) {
            this.setButtonsActive(false);
        }
        this.clearStatus();
        this.pendingChunks = 0;
        this.chunkSendTimes.clear();
        this.chunkGenerations.clear();
        AppStore.setWhisperState({ isTranscribing: false, isLoadingModel: false, progress: 0, progressMessage: '', currentTrackSrc: this.currentTrackSrc });

        if (this.audio) {
            this.audio.removeEventListener('seeking', this.handleSeek);
            this.audio.removeEventListener('pause', this.handlePause);
            this.audio.removeEventListener('play', this.handlePlay);
            this.audio.removeEventListener('ended', this.handleEnded);
        }

        if (this.seekDebounceTimer) {
            clearTimeout(this.seekDebounceTimer);
            this.seekDebounceTimer = null;
        }
        this.stopProcessingLoop();
        this.pcmBuffer = null;
        this.pcmSourceUrl = null;
        this.pcmDuration = 0;
        this.transcribedUpTo = 0;

        this.persistCache(shouldFinalize);
        this.scheduleIdleUnload();
    }

    private scheduleIdleUnload(): void {
        this.clearIdleUnloadTimer();
        // Don't unload if auto-transcribe is pending (will start again on next track)
        if (this.autoTranscribeWorkId) return;
        this.idleUnloadTimer = window.setTimeout(() => {
            if (!this.transcribing && this.worker) {
                Logger.log('[Whisper] Idle timeout reached, unloading model to free memory');
                this.resetWorker('idle-unload');
            }
        }, Whisper.IDLE_UNLOAD_MS);
    }

    private clearIdleUnloadTimer(): void {
        if (this.idleUnloadTimer) {
            clearTimeout(this.idleUnloadTimer);
            this.idleUnloadTimer = null;
        }
    }

    private resetState(reason: string): void {
        Logger.debug('[Whisper] Reset state:', reason);
        this.transcriptionGeneration++;
        this.pendingChunks = 0;
        this.nextChunkId = 0;
        this.lastSegmentEnd = 0;
        this.segments = [];
        this.currentCacheKey = null;
        this.currentCacheIdentity = null;
        this.chunkSendTimes.clear();
        this.chunkGenerations.clear();
        this.finalizeOnIdle = false;
        this.modelLoadingKey = '';
        this.lastTranslatedSegmentCount = 0;
        this.translateAheadUpTo = 0;
        this.pcmBuffer = null;
        this.pcmSourceUrl = null;
        this.pcmDuration = 0;
        this.transcribedUpTo = 0;
        this.stopProcessingLoop();
        this.clearStatus();
    }

    // ------------------------------------------------------------------------
    // URL resolution
    // ------------------------------------------------------------------------

    private resolveTrackUrl(): string | null {
        const track = this.bridge.currentTrack;
        if (!track) return null;
        // Prefer low-quality stream for transcription — smaller download, same Whisper accuracy
        return track.streamLowQualityUrl || track.mediaDownloadUrl || track.mediaStreamUrl || track.src || null;
    }

    private isHlsUrl(url: string): boolean {
        return /\.m3u8($|\?)/i.test(url) || /\/hls\//i.test(url);
    }

    // ------------------------------------------------------------------------
    // Fetch + decode (uses AudioCache to avoid re-downloading)
    // ------------------------------------------------------------------------

    /**
     * Resolve a blob: URL back to the original source URL via AudioCache's objectUrls map.
     * This handles the case where AudioCache has intercepted the player and replaced the
     * track's URLs with blob: URLs.
     */
    private resolveOriginalUrl(url: string): string {
        if (!url.startsWith('blob:')) return url;
        for (const [sourceUrl, blobUrl] of AudioCache.objectUrls.entries()) {
            if (blobUrl === url) {
                Logger.debug('[Whisper] Resolved blob URL to original:', sourceUrl);
                return sourceUrl;
            }
        }
        return url;
    }

    private async fetchAndDecodeAudio(url: string, signal?: AbortSignal): Promise<Float32Array> {
        let arrayBuffer: ArrayBuffer;

        // Resolve blob: URLs back to original source URLs for cache lookups and downloads
        const originalUrl = this.resolveOriginalUrl(url);
        const isBlobUrl = url.startsWith('blob:');

        // 1. Try AudioCache first (player already downloaded this)
        const audioCache = this.getAudioCache();
        let blob: Blob | null = null;
        try {
            blob = await audioCache?.getBlob(originalUrl) ?? null;
        } catch {
            // AudioCache may not be initialized yet
        }

        if (blob) {
            Logger.debug('[Whisper] Using AudioCache blob:', (blob.size / 1024 / 1024).toFixed(2) + 'MB');
            this.dispatchProgress(I18n.t('whisperDecodingAudio'), 50, 'loading');
            arrayBuffer = await blob.arrayBuffer();
        } else if (isBlobUrl) {
            // 2a. For blob URLs, fetch directly (gmRequest can't handle blob: protocol)
            Logger.debug('[Whisper] Fetching blob URL directly:', url);
            this.dispatchProgress(I18n.t('whisperDecodingAudio'), 10, 'loading');
            const res = await fetch(url, { signal });
            arrayBuffer = await res.arrayBuffer();
        } else {
            // 2b. Download audio file — try methods in order of reliability:
            //   1. bridge.axios (includes JWT auth headers the API requires)
            //   2. gmRequest (Tampermonkey CORS bypass, includes cookies)
            //   3. bare fetch (same-origin / CORS-enabled URLs only)
            Logger.debug('[Whisper] Downloading audio:', originalUrl);
            this.dispatchProgress(I18n.t('whisperDownloadingAudio'), 0, 'loading');

            const reportProgress = (loaded: number, total: number | null) => {
                const loadedMB = (loaded / 1024 / 1024).toFixed(1);
                if (total && total > 0) {
                    const totalMB = (total / 1024 / 1024).toFixed(1);
                    const pct = Math.round((loaded / total) * 100);
                    this.dispatchProgress(
                        I18n.format('whisperDownloadingAudio', { loaded: loadedMB, total: totalMB }),
                        Math.min(50, pct / 2),
                        'loading',
                    );
                } else if (loaded > 0) {
                    this.dispatchProgress(
                        I18n.format('whisperDownloadingAudio', { loaded: loadedMB, total: '?' }),
                        10,
                        'loading',
                    );
                }
            };

            try {
                // Primary: bridge.axios has JWT auth interceptor — required for asmr.one API
                // Inactivity-based timeout: abort only if no data received for 60s
                // (a fixed timeout fails for large files that are actively downloading)
                const INACTIVITY_MS = 60_000;
                const abortController = new AbortController();
                // Propagate external abort (track change) to the download's AbortController
                const onExternalAbort = () => abortController.abort();
                signal?.addEventListener('abort', onExternalAbort);
                let inactivityReject: (err: Error) => void;
                let activityTimer: ReturnType<typeof setTimeout>;
                const resetTimer = () => {
                    clearTimeout(activityTimer);
                    activityTimer = setTimeout(
                        () => {
                            abortController.abort();
                            inactivityReject(new Error(`Download stalled (no data for ${INACTIVITY_MS / 1000}s)`));
                        },
                        INACTIVITY_MS,
                    );
                };
                const inactivityGuard = new Promise<never>((_, reject) => {
                    inactivityReject = reject;
                    resetTimer();
                });
                const download = this.bridge.axios.get<ArrayBuffer>(originalUrl, {
                    responseType: 'arraybuffer',
                    timeout: 0, // disabled — we use inactivity guard instead
                    signal: abortController.signal,
                    onDownloadProgress: (e: { loaded?: number; total?: number }) => {
                        resetTimer();
                        reportProgress(e.loaded || 0, e.total || null);
                    },
                }).finally(() => {
                    clearTimeout(activityTimer);
                    signal?.removeEventListener('abort', onExternalAbort);
                });
                const response = await Promise.race([download, inactivityGuard]);
                arrayBuffer = response.data;
                Logger.debug('[Whisper] Audio downloaded via axios:', (arrayBuffer.byteLength / 1024 / 1024).toFixed(2) + 'MB');
            } catch (axiosErr) {
                // If aborted due to track change, propagate immediately — don't try fallbacks
                if (signal?.aborted) throw new DOMException('Download aborted (track changed)', 'AbortError');
                Logger.warn('[Whisper] axios download failed, trying gmRequest:', axiosErr);
                try {
                    const res = await gmRequest({
                        url: originalUrl,
                        responseType: 'arraybuffer',
                        timeout: 600_000, // 10 min — large audio files need generous total timeout
                        onprogress: (event) => {
                            reportProgress(event.loaded, event.lengthComputable ? event.total : null);
                        },
                    });
                    arrayBuffer = res.response as ArrayBuffer;
                    Logger.debug('[Whisper] Audio downloaded via gmRequest:', (arrayBuffer.byteLength / 1024 / 1024).toFixed(2) + 'MB');
                } catch {
                    if (signal?.aborted) throw new DOMException('Download aborted (track changed)', 'AbortError');
                    Logger.warn('[Whisper] gmRequest failed, trying fetch');
                    const res = await fetch(originalUrl, { signal });
                    arrayBuffer = await res.arrayBuffer();
                    Logger.debug('[Whisper] Audio downloaded via fetch:', (arrayBuffer.byteLength / 1024 / 1024).toFixed(2) + 'MB');
                }
            }

            // Store in AudioCache for future use
            try {
                await audioCache?.cacheAudio(originalUrl, new Blob([arrayBuffer]));
            } catch {
                // Non-critical
            }
        }

        // Check abort signal before starting decode — OfflineAudioContext is not cancellable
        if (signal?.aborted) {
            throw new DOMException('Decode aborted (track changed)', 'AbortError');
        }

        this.dispatchProgress(I18n.t('whisperDecodingAudio'), 55, 'loading');
        return this.decodeToPcm(arrayBuffer);
    }

    private async decodeToPcm(arrayBuffer: ArrayBuffer): Promise<Float32Array> {
        const tempCtx = new OfflineAudioContext(1, 1, TARGET_SAMPLE_RATE);
        const audioBuffer = await tempCtx.decodeAudioData(arrayBuffer);

        // Downmix to mono + resample to 16kHz in one native call
        const totalSamples = Math.ceil(audioBuffer.duration * TARGET_SAMPLE_RATE);
        const offlineCtx = new OfflineAudioContext(1, totalSamples, TARGET_SAMPLE_RATE);
        const source = offlineCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(offlineCtx.destination);
        source.start(0);
        const rendered = await offlineCtx.startRendering();

        return rendered.getChannelData(0);
    }

    // ------------------------------------------------------------------------
    // Lookahead processing loop
    // ------------------------------------------------------------------------

    private startProcessingLoop(): void {
        this.stopProcessingLoop();
        this.processingLoopId = window.setInterval(() => {
            this.maybeProcessNextChunk();
        }, POLL_INTERVAL_MS);
    }

    private stopProcessingLoop(): void {
        if (this.processingLoopId !== null) {
            clearInterval(this.processingLoopId);
            this.processingLoopId = null;
        }
    }

    private maybeProcessNextChunk(): void {
        if (!this.transcribing || !this.pcmBuffer) return;

        // Sentinel: detect track changes that EventBus missed
        // Resolve blob URLs so comparison isn't fooled by AudioCache URL mutation
        const bridgeTrack = this.bridge.currentTrack;
        const rawBridgeSrc = bridgeTrack?.hash || bridgeTrack?.mediaStreamUrl || null;
        const bridgeSrc = rawBridgeSrc ? this.resolveOriginalUrl(rawBridgeSrc) : null;
        if (bridgeSrc && this.currentTrackSrc && bridgeSrc !== this.currentTrackSrc) {
            Logger.warn('[Whisper] Stale track in processing loop, triggering reset', {
                expected: this.currentTrackSrc,
                actual: bridgeSrc,
            });
            this.handleTrackChange(bridgeSrc);
            return;
        }

        // Verify pcmBuffer belongs to the current track (sanity check against stale audio)
        if (this.pcmSourceUrl) {
            const expectedUrl = this.resolveTrackUrl();
            if (expectedUrl && expectedUrl !== this.pcmSourceUrl) {
                Logger.error('[Whisper] PCM buffer mismatch! Buffer from wrong track.', {
                    pcmSource: this.pcmSourceUrl,
                    expectedSource: expectedUrl,
                    currentTrackSrc: this.currentTrackSrc,
                });
                this.handleTrackChange(bridgeSrc || this.currentTrackSrc || '');
                return;
            }
        }

        if (this.pendingChunks >= MAX_PENDING_CHUNKS) return;

        const audio = this.audio || getAudioElement();
        if (!audio) return;

        const settings = this.getWhisperSettings();
        const chunkSamples = Math.floor(settings.chunkLengthS * TARGET_SAMPLE_RATE);
        const overlapSec = settings.strideLengthS;
        const playhead = audio.currentTime;

        // Don't process past the end of the audio
        if (this.transcribedUpTo >= this.pcmDuration) {
            if (this.pendingChunks === 0) {
                this.finalizeOnIdle = true;
                this.maybeFinalizeTranscript();
            }
            return;
        }

        // Extract chunk from PCM buffer
        const startSample = Math.floor(this.transcribedUpTo * TARGET_SAMPLE_RATE);
        const endSample = Math.min(startSample + chunkSamples, this.pcmBuffer.length);
        let chunk = this.pcmBuffer.subarray(startSample, endSample);

        // Skip silence
        if (settings.silenceThreshold > 0 && this.computeRms(chunk) < settings.silenceThreshold) {
            this.transcribedUpTo += settings.chunkLengthS - overlapSec;
            return;
        }

        // Pad final chunk if needed
        if (chunk.length < chunkSamples) {
            const padded = new Float32Array(chunkSamples);
            padded.set(chunk);
            chunk = padded;
        }

        // Chunks near the playhead get high priority for responsive scrubbing
        const distFromPlayhead = Math.abs(this.transcribedUpTo - playhead);
        const priority = distFromPlayhead <= 30 ? 1 : 0;
        this.sendChunk(chunk, this.transcribedUpTo, settings, priority);
        this.transcribedUpTo += settings.chunkLengthS - overlapSec;
    }

    private seekDebounceTimer: ReturnType<typeof setTimeout> | null = null;

    private handleSeek = (): void => {
        if (!this.audio) return;

        // Emit snapshot immediately so subtitle display tracks the scrub in real-time.
        // No debounce for the UI update — the user expects instant subtitle feedback.
        this.emitWhisperSnapshot('seek');

        if (this.seekDebounceTimer) {
            clearTimeout(this.seekDebounceTimer);
        }

        // Debounce the expensive work (queue flush, chunk processing) until scrub settles.
        this.seekDebounceTimer = setTimeout(() => {
            const seekTime = this.audio!.currentTime;
            Logger.debug('[Whisper] Seek settled:', seekTime.toFixed(2));

            // Flush stale jobs from the worker queue so new playhead chunks process immediately
            if (this.worker) this.worker.postMessage({ type: 'flush-queue' });

            // Rewind processing window on backward scrubs, jump on forward scrubs.
            // Keep all existing segments — they're already transcribed correctly.
            // Only adjust the processing cursor so new chunks fill gaps.
            if (seekTime < this.transcribedUpTo - 0.25) {
                this.transcribedUpTo = Math.max(0, seekTime - SEEK_BACKFILL_SEC);
                this.pendingChunks = 0;
                this.chunkSendTimes.clear();
                this.chunkGenerations.clear();
                this.lastSegmentEnd = Math.min(this.lastSegmentEnd, seekTime);
            }
            if (seekTime > this.transcribedUpTo) {
                this.transcribedUpTo = seekTime;
                this.pendingChunks = 0;
                this.chunkSendTimes.clear();
                this.chunkGenerations.clear();
            }

            this.emitWhisperSnapshot('seek');
            this.maybeProcessNextChunk();
            this.seekDebounceTimer = null;
        }, 100);
    };

    private handlePause = (): void => {
        this.maybeProcessNextChunk();
    };

    private handlePlay = (): void => {
        // Refresh subtitle state after resume and continue processing loop naturally.
        this.emitWhisperSnapshot('seek');
    };

    private handleEnded = (): void => {
        if (!this.transcribing) return;
        Logger.debug('[Whisper] Audio ended');
        // maybeProcessNextChunk handles finalization naturally
    };

    private emitWhisperSnapshot(source: 'seek' | 'update' | 'complete' | 'cache' = 'seek'): void {
        if (!this.transcribing || this.segments.length === 0) return;
        const audio = this.audio || getAudioElement();
        const now = audio?.currentTime ?? 0;
        const active = this.findSegmentAt(now);
        EventBus.emit('whisper:update', {
            text: active?.text || '',
            segments: [...this.segments],
            final: false,
            live: true,
            source,
        });
    }

    private findSegmentAt(timeSec: number): WhisperSegment | null {
        // Find the exact segment at timeSec, or the nearest previous segment
        // (for gaps between segments — keeps subtitle display populated during scrubbing)
        let nearest: WhisperSegment | null = null;
        for (let i = this.segments.length - 1; i >= 0; i--) {
            const seg = this.segments[i];
            if (seg.start <= timeSec) {
                // Exact match (within segment bounds)
                if (!seg.end || timeSec <= seg.end + 0.05) return seg;
                // In a gap — this is the nearest previous segment
                if (!nearest) nearest = seg;
                break;
            }
        }
        return nearest;
    }

    // ------------------------------------------------------------------------
    // Worker handling
    // ------------------------------------------------------------------------

    private ensureWorker(): void {
        if (this.worker) return;
        this.worker = createWhisperWorker();
        this.worker.onmessage = (e: MessageEvent<WorkerMessage>) => this.handleWorkerMessage(e);

        // Only skip WebGPU if it failed THIS session — don't inherit from translation's
        // cached dtype, as the issue may have been transient (driver/Chrome update).
        if (Whisper.webgpuFailed) {
            this.worker.postMessage({ type: 'skip-webgpu' });
        }
        this.worker.onerror = (e: ErrorEvent) => {
            if (this.gpuCrashed) return; // Already showing crash UI
            const errObj = (e as ErrorEvent & { error?: unknown }).error;
            const errorMsg = e.message || (errObj instanceof Error ? errObj.message : '') || 'Unknown worker error';
            const isGpuError = /createBuffer|RangeError|out of memory|OOM|allocation|device lost|GPUDevice|createComputePipeline|createShaderModule|mapAsync|Instance reference|AbortError|release session|invalid session/i.test(errorMsg);
            const isTerminalGpuFailure = /WebGPU is required|All WebGPU.*failed/i.test(errorMsg);
            const details = {
                message: errorMsg,
                filename: e.filename,
                lineno: e.lineno,
                colno: e.colno,
                error: errObj ? String(errObj) : undefined,
            };
            Logger.error('[Whisper] Worker error:', details);
            if ((isGpuError || isTerminalGpuFailure) && !Whisper.webgpuFailed) {
                Whisper.webgpuFailed = true;
                EventBus.emit('webgpu:failed', { source: 'whisper' });
                Logger.warn('[Whisper] GPU worker error — broadcasting failure:', errorMsg);
            }
            this.clearModelLoadTimer();
            this.resetWorker('error');
            const wasTranscribing = this.transcribing;
            if (wasTranscribing) {
                this.stopTranscription('worker-error');
            }

            // Terminal GPU failure: give up permanently, don't retry
            if (isTerminalGpuFailure) {
                Logger.error('[Whisper] Terminal GPU failure (onerror) — Whisper disabled for this session');
                this.gpuCrashed = true;
                const crashMsg = I18n.t('whisperGpuCrashed');
                AppStore.setWhisperState({
                    isTranscribing: false,
                    isLoadingModel: false,
                    progress: 0,
                    progressMessage: crashMsg,
                });
                this.showStatus(`<span class="whisper-error-indicator whisper-crash-persistent">${this.escapeHtml(crashMsg)}</span>`);
                return;
            }

            // Auto-recover from GPU errors: create a fresh worker on WASM
            if (isGpuError && wasTranscribing) {
                Whisper.gpuRecoveryAttempts++;
                if (Whisper.gpuRecoveryAttempts > Whisper.MAX_GPU_RECOVERY) {
                    Logger.error(`[Whisper] GPU recovery failed after ${Whisper.MAX_GPU_RECOVERY} attempts, giving up`);
                    this.gpuCrashed = true; // Prevent further retries
                    this.dispatchError(I18n.format('whisperWorkerError', { message: errorMsg }));
                    return;
                }
                Logger.warn(`[Whisper] Scheduling GPU recovery (attempt ${Whisper.gpuRecoveryAttempts}/${Whisper.MAX_GPU_RECOVERY}) in 2s...`);
                if (this.gpuRecoveryTimer) clearTimeout(this.gpuRecoveryTimer);
                this.gpuRecoveryTimer = window.setTimeout(() => {
                    this.gpuRecoveryTimer = null;
                    const audio = getAudioElement();
                    if (audio && !audio.paused) {
                        Logger.warn('[Whisper] Auto-recovery: restarting transcription on WASM backend');
                        this.showStatus(`<span class="whisper-status-text">${I18n.t('whisperRecovering')}</span>`);
                        this.startTranscription().catch(err => Logger.error('[Whisper] Recovery start failed:', err));
                    }
                }, 2000);
            } else {
                this.dispatchError(I18n.format('whisperWorkerError', { message: errorMsg }));
            }
        };
        Logger.debug('[Whisper] Worker created');
    }

    private resetWorker(reason: string): void {
        this.releaseLoadLease();
        if (this.worker) {
            // Send reset so worker can dispose GPU pipeline before we kill it
            try { this.worker.postMessage({ type: 'reset' }); } catch { /* ignore */ }
            const dyingWorker = this.worker;
            setTimeout(() => { try { dyingWorker.terminate(); } catch { /* ignore */ } }, 500);
            this.worker = null;
        }
        // Clear timers that reference the dead worker
        if (this.gpuRecoveryTimer) { clearTimeout(this.gpuRecoveryTimer); this.gpuRecoveryTimer = null; }
        if (this.errorDismissTimer) { clearTimeout(this.errorDismissTimer); this.errorDismissTimer = null; }
        this.modelLoadingKey = '';
        this.modelReady = false;
        this.pendingChunks = 0;
        this.chunkSendTimes.clear();
        this.chunkGenerations.clear();
        Logger.warn('[Whisper] Worker reset:', reason);
    }

    private initWorker(settings: WhisperSettings): void {
        if (this.gpuCrashed) {
            Logger.warn('[Whisper] initWorker blocked — GPU crashed this session');
            return;
        }
        this.ensureWorker();
        this.modelReady = false;
        this.dispatchProgress(I18n.t('whisperLoading'), 5, 'model');

        // Acquire a load lease from GpuScheduler to prevent concurrent model loading.
        // Only one worker loads a model at a time (requestAdapter + requestDevice + ONNX compile).
        // The lease is released when the worker reports 'ready' or on error/reset.
        this.releaseLoadLease(); // Release any stale lease from a previous init attempt
        GpuScheduler.acquireLoadLease('whisper').then(release => {
            this.loadLeaseRelease = release;
            if (!this.worker) {
                // Worker was terminated while waiting for lease
                release();
                this.loadLeaseRelease = null;
                return;
            }
            // No timeout - large models can take a while to download
            this.worker.postMessage({
                type: 'init',
                model: settings.model,
                multilingual: settings.multilingual,
                quantized: settings.quantized,
                subtask: settings.subtask,
                language: settings.language,
                chunkLengthS: settings.chunkLengthS,
                strideLengthS: settings.strideLengthS,
                allowWasm: settings.allowWasm,
            });
        });
    }

    private releaseLoadLease(): void {
        if (this.loadLeaseRelease) {
            this.loadLeaseRelease();
            this.loadLeaseRelease = null;
        }
    }

    private clearModelLoadTimer(): void {
        if (this.modelLoadTimer) {
            clearTimeout(this.modelLoadTimer);
            this.modelLoadTimer = null;
        }
    }

    private sendChunk(audio: Float32Array, timeOffset: number, settings: WhisperSettings, priority = 0): void {
        if (!this.worker) return;
        const chunkId = this.nextChunkId++;
        this.pendingChunks++;
        this.chunkSendTimes.set(chunkId, performance.now());
        this.chunkGenerations.set(chunkId, this.transcriptionGeneration);
        Logger.debug(`[Whisper] Sending chunk ${chunkId}, offset=${timeOffset.toFixed(2)}s, priority=${priority}, samples=${audio.length}`);
        this.worker!.postMessage({
            type: 'transcribe',
            audio,
            model: settings.model,
            multilingual: settings.multilingual,
            quantized: settings.quantized,
            subtask: settings.subtask,
            language: settings.language,
            timeOffset,
            chunkLengthS: settings.chunkLengthS,
            strideLengthS: settings.strideLengthS,
            allowWasm: settings.allowWasm,
            chunkId,
            priority,
        });
    }

    private handleWorkerMessage(e: MessageEvent<WorkerMessage>): void {
        const message = e.data;

        switch (message.status) {
            case 'initiate':
                if (message.backend) {
                    Logger.debug(`[Whisper] Worker backend: ${message.backend}${message.vendor ? ` (${message.vendor})` : ''}`);
                    if (message.backend === 'wasm') {
                        Logger.warn('[Whisper] Worker using WASM backend (WebGPU unavailable on this device)');
                    }
                }
                break;

            case 'ready':
                // Model ready - clear loading status and hide transcribing indicator
                this.releaseLoadLease();
                this.clearModelLoadTimer();
                this.modelReady = true;
                SharedCache.set(CacheKeys.whisperModelReady(this.getWhisperSettings().model), true, MODEL_READY_TTL_MS);
                EventBus.emit('whisper:progress', { percent: 100, message: I18n.t('downloadWhisperModelReady'), stage: 'ready' });
                if (this.transcribing) {
                    this.dispatchProgress(I18n.t('whisperTranscribing'), 0, 'transcribing');
                } else {
                    this.clearStatus();
                    AppStore.setWhisperState({ isTranscribing: this.transcribing, progress: 100, progressMessage: '', isLoadingModel: false });
                }
                break;

            case 'progress': {
                if (this.modelReady) return;
                const fileName = message.file?.split('/').pop() || message.file || '';
                const progress = this.normalizeModelProgress(message);
                const customMessage = (message as { message?: string }).message;
                const key = `${fileName}:${progress}`;
                if (key !== this.modelLoadingKey) {
                    this.modelLoadingKey = key;
                    let displayText: string;
                    if (customMessage) {
                        displayText = customMessage;
                    } else if (fileName) {
                        displayText = I18n.format('whisperLoadingModelFile', { file: fileName, progress });
                    } else {
                        displayText = I18n.t('whisperLoading');
                    }
                    // Scale progress: 5-100 maps to 5-80% (leave room for transcription)
                    const scaledProgress = Math.min(80, 5 + progress * 0.75);
                    this.dispatchProgress(displayText, scaledProgress, 'model');
                }
                break;
            }

            case 'fallback': {
                const fallback = message as WorkerFallbackMessage;
                const fallbackModelShort = fallback.fallbackModel.split('/').pop() || fallback.fallbackModel;
                Logger.warn('[Whisper] Falling back from', fallback.originalModel, 'to', fallback.fallbackModel, '- reason:', fallback.reason);
                // Notify user that a different model is being loaded
                const fallbackMsg = I18n.format('whisperFallbackModel', { model: fallbackModelShort });
                this.dispatchProgress(fallbackMsg, 10, 'model');
                EventBus.emit('whisper:fallback', {
                    originalModel: fallback.originalModel,
                    fallbackModel: fallback.fallbackModel,
                    reason: fallback.reason
                });
                break;
            }

            case 'update': {
                if (!this.transcribing) return;
                Whisper.gpuRecoveryAttempts = 0; // GPU is working — reset recovery counter
                GpuScheduler.onGpuSuccess('whisper');
                const update = message as WorkerUpdateMessage;
                if (typeof update.chunkId === 'number') {
                    if (!this.chunkSendTimes.has(update.chunkId)) return;
                    if (this.chunkGenerations.get(update.chunkId) !== this.transcriptionGeneration) return;
                }
                const segments = this.parseSegments(update.data?.[1]?.chunks);
                this.mergeSegments(segments, { preferNew: false });
                this.updateTranscribingProgress();
                const latest = this.segments[this.segments.length - 1];
                EventBus.emit('whisper:update', {
                    text: latest?.text || update.data?.[0] || '',
                    segments: [...this.segments],
                    final: false,
                    chunkIndex: update.chunkId,
                    live: true,
                    source: 'update',
                });
                break;
            }

            case 'complete': {
                if (!this.transcribing) return;
                const complete = message as WorkerCompleteMessage;
                if (typeof complete.chunkId === 'number') {
                    if (!this.chunkSendTimes.has(complete.chunkId)) return;
                    if (this.chunkGenerations.get(complete.chunkId) !== this.transcriptionGeneration) return;
                }
                this.pendingChunks = Math.max(0, this.pendingChunks - 1);
                if (complete.chunkId !== undefined) {
                    this.chunkSendTimes.delete(complete.chunkId);
                    this.chunkGenerations.delete(complete.chunkId);
                }
                const segments = this.parseSegments(complete.data?.chunks);
                Logger.debug(`[Whisper] Complete chunk ${complete.chunkId}: ${segments.length} segments, text="${complete.data?.text?.slice(0, 50)}"`);
                this.mergeSegments(segments, { preferNew: true });
                this.updateTranscribingProgress();
                const latest = this.segments[this.segments.length - 1];
                EventBus.emit('whisper:update', {
                    text: latest?.text || complete.data?.text || '',
                    segments: [...this.segments],
                    final: this.pendingChunks === 0,
                    chunkIndex: complete.chunkId,
                    live: true,
                    source: 'complete',
                });

                // Cache after each chunk to preserve progress
                if (this.segments.length > 0) {
                    this.persistCache();
                    void this.translateAhead();
                }
                this.maybeFinalizeTranscript();
                break;
            }

            case 'gpu-device-lost': {
                // Fatal GPU device loss — GPU is dead, transcription cannot continue.
                this.releaseLoadLease();
                const deviceLostMsg = message.data?.message || 'GPU device lost';
                Logger.error('[Whisper] Fatal GPU device loss:', deviceLostMsg);
                this.gpuCrashed = true;
                EventBus.emit('gpu:device-lost', { worker: 'whisper' as const });
                Whisper.webgpuFailed = true;
                EventBus.emit('webgpu:failed', { source: 'whisper' });

                // Stop transcription if running
                if (this.transcribing) {
                    this.stopTranscription('gpu-device-lost');
                }
                this.resetWorker('gpu-device-lost');

                // Show persistent crash status (no auto-dismiss)
                const crashMsg = I18n.t('whisperGpuCrashed');
                AppStore.setWhisperState({
                    isTranscribing: false,
                    isLoadingModel: false,
                    progress: 0,
                    progressMessage: crashMsg,
                });
                this.showStatus(`<span class="whisper-error-indicator whisper-crash-persistent">${this.escapeHtml(crashMsg)}</span>`);
                // Do NOT auto-dismiss — user must refresh
                if (this.errorDismissTimer) {
                    clearTimeout(this.errorDismissTimer);
                    this.errorDismissTimer = null;
                }
                break;
            }

            case 'gpu-degraded': {
                // GPU partially failed (e.g. createBuffer during word timestamps) but Whisper
                // recovered with segment timestamps. Keep this local to Whisper and avoid
                // escalating to global device-loss, which can unnecessarily disable other workers.
                const degradedMsg = message.data?.message || 'GPU degraded';
                Logger.warn('[Whisper] GPU degraded during inference:', degradedMsg);
                break;
            }

            case 'error': {
                this.releaseLoadLease();
                // If GPU already crashed fatally, don't overwrite the persistent crash message
                if (this.gpuCrashed) {
                    Logger.debug('[Whisper] Ignoring error after GPU crash:', message.data?.message);
                    break;
                }
                const errMsg = message.data?.message || I18n.t('whisperUnknownError');
                const isGpuError = /createBuffer|RangeError|out of memory|OOM|allocation|device lost|GPUDevice|createComputePipeline|createShaderModule|mapAsync|Instance reference|AbortError|release session|invalid session/i.test(errMsg);
                // "WebGPU is required" means worker tried WebGPU, it failed, but WASM
                // fallback is disabled. This is a terminal GPU failure — do NOT retry.
                const isWebgpuRequiredError = /WebGPU is required/i.test(errMsg);
                // "All WebGPU.*failed" means every dtype candidate was exhausted.
                const isAllGpuFailed = /All WebGPU.*failed/i.test(errMsg);
                const isTerminalGpuFailure = isWebgpuRequiredError || isAllGpuFailed;
                const isExplicitDeviceLoss = /device lost|Instance reference|release session|invalid session/i.test(errMsg);

                if ((isGpuError || isTerminalGpuFailure) && !Whisper.webgpuFailed) {
                    Whisper.webgpuFailed = true;
                    EventBus.emit('webgpu:failed', { source: 'whisper' });
                    if (isExplicitDeviceLoss || isTerminalGpuFailure) {
                        // Broadcast only on explicit/terminal device-loss class failures.
                        EventBus.emit('gpu:device-lost', { worker: 'whisper' as const });
                        Logger.warn('[Whisper] GPU failure — broadcasting device-lost:', errMsg);
                    } else {
                        Logger.warn('[Whisper] Recoverable GPU failure — keeping device-loss local:', errMsg);
                    }
                }

                Logger.error('[Whisper] Worker error:', errMsg);
                this.clearModelLoadTimer();
                this.resetWorker('error');
                // Dispatch error BEFORE stopping transcription so the UI message
                // is not immediately cleared by stopTranscription's clearStatus().
                const wasTranscribing = this.transcribing;
                if (wasTranscribing) {
                    this.stopTranscription('worker-error');
                }

                // Terminal GPU failure (WebGPU exhausted, WASM disabled): give up permanently.
                // Do NOT retry — retrying creates an infinite loop since a fresh worker will
                // try WebGPU again, fail, and end up right back here.
                if (isTerminalGpuFailure) {
                    Logger.error('[Whisper] Terminal GPU failure — Whisper disabled for this session');
                    this.gpuCrashed = true;
                    const crashMsg = I18n.t('whisperGpuCrashed');
                    AppStore.setWhisperState({
                        isTranscribing: false,
                        isLoadingModel: false,
                        progress: 0,
                        progressMessage: crashMsg,
                    });
                    this.showStatus(`<span class="whisper-error-indicator whisper-crash-persistent">${this.escapeHtml(crashMsg)}</span>`);
                    if (this.errorDismissTimer) {
                        clearTimeout(this.errorDismissTimer);
                        this.errorDismissTimer = null;
                    }
                    break;
                }

                // Auto-recover from GPU errors: create a fresh worker on WASM.
                // Cached segments are preserved by stopTranscription, and startTranscription
                // will resume from where we left off via cache continuation logic.
                if (isGpuError && wasTranscribing) {
                    Whisper.gpuRecoveryAttempts++;
                    if (Whisper.gpuRecoveryAttempts > Whisper.MAX_GPU_RECOVERY) {
                        Logger.error(`[Whisper] GPU recovery failed after ${Whisper.MAX_GPU_RECOVERY} attempts, giving up`);
                        this.gpuCrashed = true; // Prevent further retries from onerror
                        break;
                    }
                    Logger.warn(`[Whisper] Scheduling GPU recovery (attempt ${Whisper.gpuRecoveryAttempts}/${Whisper.MAX_GPU_RECOVERY}) in 2s...`);
                    if (this.gpuRecoveryTimer) clearTimeout(this.gpuRecoveryTimer);
                    this.gpuRecoveryTimer = window.setTimeout(() => {
                        this.gpuRecoveryTimer = null;
                        const audio = getAudioElement();
                        if (audio && !audio.paused) {
                            Logger.warn('[Whisper] Auto-recovery: restarting transcription on WASM backend');
                            this.showStatus(`<span class="whisper-status-text">${I18n.t('whisperRecovering')}</span>`);
                            this.startTranscription().catch(err => Logger.error('[Whisper] Recovery start failed:', err));
                        } else {
                            Logger.debug('[Whisper] Auto-recovery skipped: audio paused or unavailable');
                        }
                    }, 2000);
                    break;
                }

                // Show error after stop (dispatchError has its own AppStore update)
                const displayMsg = I18n.format('whisperTranscriptionError', { message: errMsg });
                EventBus.emit('whisper:error', { message: errMsg });
                AppStore.setWhisperState({ isTranscribing: false, isLoadingModel: false, progress: 0, progressMessage: displayMsg });
                this.showStatus(`<span class="whisper-error-indicator" aria-label="${this.escapeHtml(displayMsg)}">${this.escapeHtml(displayMsg)}</span>`);
                if (this.errorDismissTimer) clearTimeout(this.errorDismissTimer);
                this.errorDismissTimer = window.setTimeout(() => {
                    this.clearStatus();
                    this.errorDismissTimer = null;
                }, 5000);
                break;
            }

            default:
                break;
        }
    }

    private maybeFinalizeTranscript(): void {
        if (!this.finalizeOnIdle || this.pendingChunks > 0) return;
        this.finalizeOnIdle = false;
        this.persistCache(true);
        EventBus.emit('whisper:complete', { text: this.segments.map((s) => s.text).join(' ') });
        AppStore.setWhisperState({
            isTranscribing: this.transcribing,
            isLoadingModel: false,
            progress: 100,
            progressMessage: I18n.t('whisperComplete'),
            currentTrackSrc: this.currentTrackSrc,
        });
    }

    private isSignificantUpdate(oldText: string, newText: string): boolean {
        const oldTrim = oldText.trim();
        const newTrim = newText.trim();
        if (oldTrim === newTrim) return false;
        return true;
    }

    private normalizeSegmentText(text: string): string {
        return this.cleanText(text)
            .toLowerCase()
            .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, '');
    }

    private isNearDuplicateText(a: string, b: string): boolean {
        const normA = this.normalizeSegmentText(a);
        const normB = this.normalizeSegmentText(b);
        if (!normA || !normB) return false;
        if (normA === normB) return true;

        const shorter = normA.length <= normB.length ? normA : normB;
        const longer = normA.length <= normB.length ? normB : normA;
        if (shorter.length < 12) return false;

        return longer.includes(shorter) && (shorter.length / longer.length) >= 0.75;
    }

    private shouldCollapseAdjacentDuplicate(prev: WhisperSegment, next: WhisperSegment): boolean {
        if (!this.isNearDuplicateText(prev.text, next.text)) return false;
        const startDelta = Math.abs(prev.start - next.start);
        const overlaps = next.start <= prev.end + 0.3;
        return startDelta <= 0.8 || overlaps;
    }

    private mergeSegments(newSegments: WhisperSegment[], options?: { preferNew?: boolean }): void {
        if (!newSegments.length) return;

        const preferNew = options?.preferNew === true;

        for (const seg of newSegments) {
            if (!seg.text || this.isNoiseOnly(seg.text)) continue;

            const matchIdx = this.segments.findIndex(existing =>
                Math.abs(existing.start - seg.start) < 0.3
            );

            if (matchIdx >= 0) {
                const existing = this.segments[matchIdx];
                const existingText = existing.text.trim();
                const nextText = seg.text.trim();
                if ((preferNew || nextText.length >= existingText.length) && this.isSignificantUpdate(existingText, nextText)) {
                    this.segments[matchIdx] = seg;
                }
                this.lastSegmentEnd = Math.max(this.lastSegmentEnd, seg.end, existing.end);
                continue;
            }

            this.segments.push(seg);
            this.lastSegmentEnd = Math.max(this.lastSegmentEnd, seg.end);
        }

        // Sort segments by start time to ensure proper ordering
        this.segments.sort((a, b) => a.start - b.start);

        // Collapse near-duplicate segments (overlapping updates)
        if (this.segments.length > 1) {
            const deduped: WhisperSegment[] = [];
            for (const seg of this.segments) {
                const prev = deduped[deduped.length - 1];
                if (prev && Math.abs(prev.start - seg.start) < 0.25) {
                    const prevText = prev.text.trim();
                    const segText = seg.text.trim();
                    if (this.isSignificantUpdate(prevText, segText) && (segText.length > prevText.length || preferNew)) {
                        deduped[deduped.length - 1] = seg;
                    }
                    continue;
                }
                if (prev && this.shouldCollapseAdjacentDuplicate(prev, seg)) {
                    const prevText = prev.text.trim();
                    const segText = seg.text.trim();
                    if (preferNew || segText.length >= prevText.length) {
                        deduped[deduped.length - 1] = {
                            ...seg,
                            start: Math.min(prev.start, seg.start),
                            end: Math.max(prev.end, seg.end),
                        };
                    } else {
                        deduped[deduped.length - 1] = {
                            ...prev,
                            end: Math.max(prev.end, seg.end),
                        };
                    }
                    continue;
                }
                deduped.push(seg);
            }
            this.segments = deduped;
        }

        const last = this.segments[this.segments.length - 1];
        if (last) {
            this.lastSegmentEnd = Math.max(this.lastSegmentEnd, last.end);
        }
    }

    private parseSegments(raw: ChunkEntry[] | undefined): WhisperSegment[] {
        if (!raw) return [];
        const segments: WhisperSegment[] = [];
        for (const item of raw) {
            const text = correctWhisperText(this.cleanText(item.text || ''));
            const ts = item.timestamp || [null, null];
            const start = ts[0];
            const end = ts[1];
            if (!text) continue;
            if (start == null && end == null) continue;
            const safeStart = Number.isFinite(start as number) ? Number(start) : Number(end ?? 0);
            const safeEndRaw = Number.isFinite(end as number) ? Number(end) : safeStart;
            let safeEnd = Math.max(safeStart, safeEndRaw);
            if (!Number.isFinite(safeStart) || !Number.isFinite(safeEnd)) continue;
            // Fix zero-duration segments: estimate ~150ms per CJK character
            if (safeEnd === safeStart) {
                safeEnd = safeStart + text.length * 0.15;
            }

            // Prefer real word timestamps from the worker (cross-attention aligned)
            let words: WhisperWord[] | undefined;
            if (item.words && item.words.length > 0) {
                words = item.words
                    .filter(w => w.text && w.start != null)
                    .map(w => ({
                        text: w.text.trim(),
                        start: Number(w.start),
                        end: Number(w.end ?? w.start),
                    }));
                if (words.length === 0) words = undefined;
            }
            // Fallback: linear interpolation when no real word timestamps
            if (!words) {
                const fallback = this.buildWordTimings(text, safeStart, safeEnd);
                words = fallback.length ? fallback : undefined;
            }

            segments.push({ start: safeStart, end: safeEnd, text, words });
        }
        return segments;
    }

    private buildWordTimings(text: string, start: number, end: number): Array<{ start: number; end: number; text: string }> {
        const cleaned = this.cleanText(text);
        if (!cleaned) return [];
        const duration = Math.max(0.01, end - start);

        const tokens = /\s/.test(cleaned)
            ? cleaned.split(/\s+/).filter(Boolean)
            : Array.from(cleaned);

        if (tokens.length === 0) return [];

        const step = duration / tokens.length;
        const words: Array<{ start: number; end: number; text: string }> = [];
        for (let i = 0; i < tokens.length; i++) {
            const wStart = start + step * i;
            const wEnd = i === tokens.length - 1 ? end : Math.max(wStart + 0.01, start + step * (i + 1));
            words.push({ start: wStart, end: wEnd, text: tokens[i] });
        }
        return words;
    }

    // ------------------------------------------------------------------------
    // Text cleanup
    // ------------------------------------------------------------------------

    private cleanText(text: string): string {
        return String(text || '').replace(/\s+/g, ' ').trim();
    }

    private isNoiseOnly(text: string): boolean {
        const cleaned = text
            .replace(/[\[\]{}()（）「」]/g, '')
            .replace(/\s+/g, '')
            .toLowerCase();

        if (!cleaned) return true;

        // Common ASMR/Whisper hallucination patterns
        const noisePatterns = [
            /^音+$/, /^音楽+$/, /^声+$/, /^笑+$/, /^拍手+$/,
            /^効果音+$/, /^呼吸+$/, /^息+$/, /^music+$/, /^laughter+$/,
            /^silence+$/, /^inaudible+$/, /^noise+$/,
        ];

        return noisePatterns.some((re) => re.test(cleaned));
    }

    // ------------------------------------------------------------------------
    // Cache handling
    // ------------------------------------------------------------------------

    /** Build the identity string (pre-hash) for a transcript cache entry. */
    private buildCacheIdentity(src: string, settings: WhisperSettings): string {
        return `${src}|${settings.model}|${settings.subtask}|${settings.language}`;
    }

    private buildCacheKey(src: string, settings: WhisperSettings): string {
        return CacheKeys.whisperTranscript(this.buildCacheIdentity(src, settings));
    }

    private persistCache(complete = false): void {
        if (!this.currentCacheKey || !this.segments.length) return;
        // Throttle non-final writes to every 30 seconds to reduce I/O
        const now = Date.now();
        if (!complete && now - this.lastPersistAt < 30_000) return;
        this.lastPersistAt = now;
        const settings = this.getWhisperSettings();
        if (!settings.cacheTranscripts) return;

        const existing = SharedCache.get<CachedTranscript>(this.currentCacheKey);
        const payload: CachedTranscript = {
            text: this.segments.map((s) => s.text).join(' '),
            segments: this.segments,
            model: settings.model,
            subtask: settings.subtask,
            language: settings.language,
            createdAt: Date.now(),
            lrc: buildLrcFromSegments(this.segments),
            vtt: buildVttFromSegments(this.segments),
            complete: complete || existing?.complete,
            translations: existing?.translations,
            sourceIdentity: this.currentCacheIdentity || undefined,
        };

        SharedCache.set(this.currentCacheKey, payload, CACHE_TTL_MS);
        this.updateTranscriptIndex(this.currentCacheKey, payload);
        void this.ensureTranslatedTranscript(payload, settings);
        Logger.debug('[Whisper] Cached transcript:', { segments: this.segments.length });
    }


    private getTrackIdentity(): { trackKey: string; title?: string; workId?: string; duration?: number } {
        const track = this.bridge.currentTrack;
        const trackKey = track?.hash || track?.mediaStreamUrl || track?.src || this.currentTrackSrc || '';
        const title = track?.title || track?.workTitle || '';
        const workId = this.bridge.currentWorkId || undefined;
        const duration = typeof track?.duration === 'number' ? track.duration : undefined;
        return { trackKey, title, workId, duration };
    }

    private updateTranscriptIndex(cacheKey: string, payload: CachedTranscript): void {
        const { trackKey, title, workId, duration } = this.getTrackIdentity();
        if (!trackKey) return;

        const entry: TranscriptIndexEntry = {
            cacheKey,
            trackKey,
            trackTitle: title,
            workId,
            model: payload.model,
            subtask: payload.subtask,
            language: payload.language,
            updatedAt: Date.now(),
            duration,
        };

        const indexKey = CacheKeys.whisperIndex();
        const index = SharedCache.get<Record<string, TranscriptIndexEntry[]>>(indexKey) || {};
        const list = (index[trackKey] || []).filter((e) => e.cacheKey !== cacheKey);
        list.push(entry);
        index[trackKey] = list.slice(-5);
        SharedCache.set(indexKey, index, CACHE_TTL_MS);
        EventBus.emit('whisper:cache-updated', { trackKey, cacheKey });
    }

    private async ensureTranslatedTranscript(payload: CachedTranscript, settings: WhisperSettings): Promise<void> {
        if (!payload.complete) return;

        const translateMode = Config.get('translateMode') !== false;
        const cnToJp = Config.get('translateCnToJp') === true;
        const targetLang = (Config.get('subtitleLang') as string | undefined)?.toLowerCase() || 'en';
        if ((!translateMode && !cnToJp) || !targetLang || targetLang === settings.language) return;

        const cacheKey = this.currentCacheKey;
        if (!cacheKey || this.translationInFlight.has(`${cacheKey}:${targetLang}`)) return;
        if (payload.translations?.[targetLang]) return;
        this.translationInFlight.add(`${cacheKey}:${targetLang}`);
        try {
            const texts = payload.segments.map((seg) => seg.text);
            const transcriptKey = `whisper:transcript:${cacheKey}:${targetLang}`;
            const translated = await TranslationService.translateBatch(texts, targetLang, {
                priority: Priority.NORMAL,
                cancellable: true,
                cancellableKey: transcriptKey,
            });
            const translatedSegments: WhisperSegment[] = payload.segments.map((seg, idx) => ({
                ...seg,
                text: translated[idx] || seg.text,
            }));
            const translatedPayload = {
                text: translated.join(' '),
                lrc: buildLrcFromSegments(translatedSegments),
                vtt: buildVttFromSegments(translatedSegments),
            };

            payload.translations = {
                ...(payload.translations || {}),
                [targetLang]: translatedPayload,
            };

            // Also batch-translate Chinese segments to 'ja' for LearnerMode primary display
            if (targetLang !== 'ja') {
                const cnTexts = texts.filter(t =>
                    /[\u4e00-\u9fff]/.test(t) && !/[\u3040-\u309f\u30a0-\u30ff]/.test(t)
                );
                if (cnTexts.length > 0) {
                    TranslationService.translateBatch(cnTexts, 'ja', {
                        priority: Priority.NORMAL,
                        cancellable: true,
                        cancellableKey: `${transcriptKey}:ja`,
                    }).catch(() => { /* fire-and-forget */ });
                }
            }

            SharedCache.set(cacheKey, payload, CACHE_TTL_MS);
            this.updateTranscriptIndex(cacheKey, payload);
            Logger.debug('[Whisper] Cached translated transcript:', { lang: targetLang, segments: translatedSegments.length });
        } catch (err) {
            Logger.warn('[Whisper] Failed to translate transcript:', err);
        } finally {
            this.translationInFlight.delete(`${cacheKey}:${targetLang}`);
        }
    }

    // ------------------------------------------------------------------------
    // Live per-segment translation
    // ------------------------------------------------------------------------

    /**
     * Pre-translate ALL available segments so translations are ready before display.
     * Called after each whisper chunk completes. translate() deduplicates and caches,
     * so re-submitting already-translated segments is effectively free.
     */
    private async translateAhead(): Promise<void> {
        const translateMode = Config.get('translateMode') !== false;
        const cnToJp = Config.get('translateCnToJp') === true;
        const targetLang = (Config.get('subtitleLang') as string | undefined)?.toLowerCase() || 'en';
        const settings = this.getWhisperSettings();
        if ((!translateMode && !cnToJp) || !targetLang || targetLang === settings.language) return;

        // Collect untranslated segments.
        const toTranslate = this.segments.filter(
            (seg) => seg.start > this.translateAheadUpTo,
        );

        // Also include any segments not yet translated by count.
        const byCount = this.segments.slice(this.lastTranslatedSegmentCount);
        const combined = byCount.length > 0 ? byCount : toTranslate;
        if (combined.length === 0) return;
        const selected = combined.slice(0, TRANSLATE_AHEAD_MAX_SEGMENTS_PER_RUN);
        const liveKey = this.currentCacheKey || this.getTrackIdentity().trackKey || 'live';
        const aheadKey = `whisper:ahead:${liveKey}:${targetLang}`;
        const jaAheadKey = `${aheadKey}:ja`;

        // Drop stale queued/in-flight translate-ahead jobs so the newest audio context wins.
        TranslationService.cancelPending({ cancellableKey: aheadKey });
        TranslationService.cancelPending({ cancellableKey: jaAheadKey });

        // Use translateBatch() for bulk throughput — a single batch call is far faster than
        // N individual translate() calls (one GpuScheduler task vs N serialized tasks for local;
        // better request packing for remote).
        const texts = selected.map(seg => seg.text);
        const batchPromises: Promise<unknown>[] = [];

        batchPromises.push(
            TranslationService.translateBatch(texts, targetLang, {
                priority: Priority.HIGH,
                cancellable: true,
                cancellableKey: aheadKey,
            }).catch(() => null)
        );

        // Also pre-translate Chinese segments to 'ja' for LearnerMode primary display
        // (LearnerMode shows JA as primary line when source is Chinese)
        if (targetLang !== 'ja') {
            const cnTexts = selected
                .filter(seg => /[\u4e00-\u9fff]/.test(seg.text) && !/[\u3040-\u309f\u30a0-\u30ff]/.test(seg.text))
                .map(seg => seg.text);
            if (cnTexts.length > 0) {
                batchPromises.push(
                    TranslationService.translateBatch(cnTexts, 'ja', {
                        priority: Priority.HIGH,
                        cancellable: true,
                        cancellableKey: jaAheadKey,
                    }).catch(() => null)
                );
            }
        }

        await Promise.allSettled(batchPromises);
        const furthest = selected[selected.length - 1];
        const furthestIdx = this.segments.indexOf(furthest);
        if (furthestIdx >= 0) {
            this.lastTranslatedSegmentCount = Math.max(this.lastTranslatedSegmentCount, furthestIdx + 1);
        } else {
            this.lastTranslatedSegmentCount = Math.min(this.segments.length, this.lastTranslatedSegmentCount + selected.length);
        }
        this.translateAheadUpTo = Math.max(this.translateAheadUpTo, furthest.end);
        EventBus.emit('whisper:segment-translated', { count: selected.length });
    }

    // ------------------------------------------------------------------------
    // Settings
    // ------------------------------------------------------------------------

    private getWhisperSettings(): WhisperSettings {
        const primaryLang = (Config.get('primarySubtitleLang') as string | undefined) || 'ja';
        const language = primaryLang.toLowerCase() === 'ja' ? 'japanese' : primaryLang.toLowerCase();

        return {
            model: DEFAULT_MODEL,
            subtask: 'transcribe',
            language,
            quantized: true,
            multilingual: true,
            chunkLengthS: 29,
            strideLengthS: 5,
            cacheTranscripts: true,
            autoWarmup: true,
            allowWasm: false,
            silenceThreshold: 0,
        };
    }

    // ------------------------------------------------------------------------
    // UI state / status helpers
    // ------------------------------------------------------------------------

    private setButtonsActive(active: boolean): void {
        document.querySelectorAll('.asmr-whisper-btn').forEach(el => {
            if (active) {
                el.classList.add('learner-btn-active');
                el.setAttribute('data-active', 'true');
            } else {
                el.classList.remove('learner-btn-active');
                el.removeAttribute('data-active');
            }
        });
    }

    private updateTranscribingProgress(): void {
        const now = Date.now();
        if (now - this.lastTranscribeProgressAt < 400) return;
        this.lastTranscribeProgressAt = now;

        const audio = this.audio || getAudioElement();
        const duration = audio?.duration || 0;
        const current = audio?.currentTime || 0;
        const percent = duration > 0 ? Math.min(99, (current / duration) * 100) : 0;
        const segmentsText = this.segments.length
            ? I18n.format('whisperSegmentCount', { count: this.segments.length })
            : '';
        const message = I18n.format('whisperTranscribingElapsed', {
            elapsed: Math.round(current),
            segments: segmentsText,
        });

        this.dispatchProgress(message, percent, 'transcribing');
    }

    private normalizeModelProgress(message: WorkerProgressMessage): number {
        const loaded = typeof message.loaded === 'number' ? message.loaded : NaN;
        const total = typeof message.total === 'number' ? message.total : NaN;
        let progress = typeof message.progress === 'number' ? message.progress : NaN;

        if ((!Number.isFinite(progress) || progress <= 0) && Number.isFinite(loaded) && Number.isFinite(total) && total > 0) {
            progress = (loaded / total) * 100;
        }

        // Transformers progress can be either [0..1] or [0..100].
        if (Number.isFinite(progress) && progress > 0 && progress <= 1) {
            progress *= 100;
        }

        if (!Number.isFinite(progress)) {
            return 0;
        }

        return Math.round(Math.max(0, Math.min(100, progress)));
    }

    private dispatchProgress(message: string, percent: number, stage: 'loading' | 'model' | 'transcribing'): void {
        const displayMessage = message || (
            ['loading', 'model'].includes(stage) ? I18n.t('whisperLoading') : I18n.t('whisperTranscribing')
        );
        // Only append percentStr if message doesn't already contain a percentage
        const hasPercent = /\(\d+%\)/.test(displayMessage);
        const percentStr = !hasPercent && percent > 0 && percent < 100 ? ` (${Math.round(percent)}%)` : '';
        EventBus.emit('whisper:progress', { percent: Math.round(percent), message: displayMessage, stage });
        AppStore.setWhisperState({ isTranscribing: this.transcribing, progress: percent, progressMessage: displayMessage, isLoadingModel: stage !== 'transcribing' });
        if (!this.transcribing) return;

        // USER REQUEST: Hide status when transcribing starts
        if (stage === 'transcribing') {
            this.clearStatus();
            return;
        }

        const klass = 'whisper-loading-indicator';
        this.showStatus(`<span class="${klass}" aria-label="${this.escapeHtml(displayMessage)}${percentStr}">${this.escapeHtml(displayMessage)}${percentStr}</span>`);
    }

    private dispatchError(message: string): void {
        const displayMessage = I18n.format('whisperError', { message });
        EventBus.emit('whisper:error', { message });
        AppStore.setWhisperState({ isTranscribing: false, isLoadingModel: false, progress: 0, progressMessage: displayMessage });
        if (!this.transcribing) return;
        this.showStatus(`<span class="whisper-error-indicator" aria-label="${this.escapeHtml(displayMessage)}">${this.escapeHtml(displayMessage)}</span>`);

        if (this.errorDismissTimer) clearTimeout(this.errorDismissTimer);
        this.errorDismissTimer = window.setTimeout(() => {
            this.clearStatus();
            this.errorDismissTimer = null;
        }, 5000);
    }

    private ensureStatusEl(): HTMLElement {
        if (this.statusEl && this.statusEl.isConnected) return this.statusEl;

        this.statusEl = document.createElement('div');
        this.statusEl.className = 'whisper-status';
        this.statusEl.setAttribute('aria-label', I18n.t('whisperStatus') || 'Transcription status');
        this.statusEl.setAttribute('role', 'status');

        const player = document.querySelector('.audio-player');
        const albumArt = player?.querySelector('.albumart');
        if (albumArt) {
            albumArt.after(this.statusEl);
        } else if (player) {
            player.prepend(this.statusEl);
        } else {
            const bar = document.querySelector('.player-bar-container, .player-bar, .q-footer');
            if (bar) bar.insertAdjacentElement('beforebegin', this.statusEl);
        }

        return this.statusEl;
    }

    private showStatus(html: string): void {
        const el = this.ensureStatusEl();
        if (el.innerHTML === html) return;
        el.innerHTML = html;
        el.style.display = '';
    }

    private clearStatus(): void {
        if (this.statusEl) {
            this.statusEl.style.display = 'none';
            this.statusEl.innerHTML = '';
        }
    }

    private escapeHtml(text: string): string {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    private computeRms(buffer: Float32Array): number {
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) {
            const v = buffer[i];
            sum += v * v;
        }
        return Math.sqrt(sum / buffer.length);
    }
}
