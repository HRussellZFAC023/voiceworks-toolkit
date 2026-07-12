/**
 * Whisper - Real-time WebGPU transcription (rebuilt)
 *
 * - Captures bounded live audio directly from the <audio> element
 * - Uses a size-capped compatibility decode only when live capture is unavailable
 * - Uses Transformers.js in a Web Worker (WebGPU required)
 * - Emits live segments to Learner Mode + mini player
 * - Caches transcripts per track for near-instant reloads
 */

import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { Logger, Config, I18n } from '../core/Utils';
import { EventBus } from '../core/EventBus';
import { createWhisperWorker } from './WhisperWorkerLoader';
import { processRawChunks } from './whisperProcessing';
import type { RawChunk, ProcessedSegment } from './whisperProcessing';
import { getAudioElement, isChinese } from '../core/DomUtils';
import { SharedCache, CacheKeys } from '../core/Cache';
import { MLCrashGuard } from '../core/MLCrashGuard';
import type { WhisperSegment, WhisperWord, KikoeruStoreState, PlayerTrack, TranslationSourceHint } from '../types';
import { AppStore } from '../store/AppStore';
import { TranslationService } from '../services/TranslationService';
import { AudioCache } from '../infrastructure/AudioCache';
import { gmRequest } from '../infrastructure/HttpClient';
import { GpuScheduler, Priority } from '../core/GpuScheduler';
import { DeviceCapabilities, shouldUseTinyWhisperModel } from '../core/DeviceCapabilities';
import { CentralObserver } from '../core/CentralObserver';
import { buildLrcFromSegments, buildVttFromSegments } from './transcriptFileUtils';
import { correctWhisperText } from '../data/nsfw-glossary';
import { connectAudioPcmTap, hasSharedSourceNode } from '../core/AudioAnalysis';

// ============================================================================
// Constants
// ============================================================================

const TARGET_SAMPLE_RATE = 16000;
const DEFAULT_MAX_PENDING_CHUNKS = 6;
const DEFAULT_MODEL = 'onnx-community/whisper-small_timestamped';
const FALLBACK_MODEL = 'onnx-community/whisper-tiny';
const MODEL_LOAD_STALL_TIMEOUT_MS = 120_000;
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 90; // 90 days
const MODEL_READY_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
// No lookahead limit — transcribe the entire audio from start to finish.
// DEFAULT_MAX_PENDING_CHUNKS provides natural backpressure (6 concurrent chunks max).
const INITIAL_BACKFILL_SEC = 30;
const SEEK_BACKFILL_SEC = 15;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_WORKER_UPDATE_INTERVAL_MS = 200;
const DEFAULT_MIN_WEBGPU_BUFFER_BYTES = 256 * 1024 * 1024;
const CHUNK_STALL_TIMEOUT_FLOOR_MS = 25_000;
const CHUNK_STALL_TIMEOUT_MULTIPLIER = 3;
const AUDIO_DECODE_TIMEOUT_MIN_MS = 90_000;
const AUDIO_DECODE_TIMEOUT_MAX_MS = 600_000;
const AUDIO_DECODE_TIMEOUT_PER_MIB_MS = 3_000;
const INITIAL_BOOTSTRAP_CHUNK_LENGTH_S = 6;
const MAX_LIVE_PCM_SECONDS = 180;
const LIVE_PCM_TRIM_SECONDS = 30;
const INITIAL_LIVE_PCM_SECONDS = 12;
const MAX_FALLBACK_AUDIO_BYTES = 32 * 1024 * 1024;
const BOUNDED_AUDIO_STREAM_INACTIVITY_MS = 30_000;
const BOUNDED_AUDIO_STREAM_TOTAL_MS = 120_000;
const TRANSLATE_AHEAD_MAX_SEGMENTS_PER_RUN = 50;
const GPU_ERROR_PATTERN =
    /createBuffer|RangeError|out of memory|OOM|allocation|device lost|GPUDevice|createComputePipeline|createShaderModule|mapAsync|mapping webgpu buffer|invalid buffer|Instance reference|AbortError|release session|invalid session|index out of bounds|reading 'destroy'|reading 'dispose'/i;
const EXPLICIT_DEVICE_LOSS_PATTERN = /device lost|Instance reference|release session|invalid session|reading 'destroy'|reading 'dispose'/i;

function normalizeLanguageCode(language: string): 'ja' | 'zh' | 'en' | '' {
    const normalized = String(language || '').trim().toLowerCase().split('-')[0];
    if (normalized === 'japanese' || normalized === 'ja' || normalized === 'jp') return 'ja';
    if (normalized === 'chinese' || normalized === 'zh' || normalized === 'cn' || normalized === 'cmn') return 'zh';
    if (normalized === 'english' || normalized === 'en') return 'en';
    return '';
}

type WhisperWorkLanguageContext = {
    id?: number | string;
    source_id?: string;
    original_workno?: string | null;
    translation_info?: {
        lang?: string | null;
        is_original?: boolean;
    } | null;
} | null | undefined;

/**
 * Resolve the model's spoken-language constraint. `auto` is content-aware and
 * Japanese-first because very short live chunks are otherwise frequently
 * misdetected as English. `detect` remains available for unconstrained model
 * detection.
 */
export function resolveWhisperLanguage(
    configuredLanguage: string,
    work?: WhisperWorkLanguageContext,
): string {
    const configured = String(configuredLanguage || 'auto').trim().toLowerCase();
    if (configured === 'detect') return '';

    const base = configured.split('-')[0];
    if (configured && configured !== 'auto') {
        if (base === 'ja' || base === 'jp') return 'japanese';
        if (base === 'zh' || base === 'cn' || base === 'cmn') return 'chinese';
        if (base === 'en') return 'english';
        return base;
    }

    // A translated catalogue edition describes page text, not necessarily the
    // spoken audio. RJ01503719, for example, is tagged CHI_HANS with
    // is_original=false but retains the Japanese source audio. Only constrain
    // from catalogue metadata when it explicitly describes an original work.
    if (work?.translation_info?.is_original === true) {
        const workLang = String(work.translation_info.lang || '').toUpperCase();
        if (workLang.includes('CHI') || workLang.includes('ZH')) return 'chinese';
        if (workLang.includes('ENG') || workLang.includes('EN')) return 'english';
        if (workLang.includes('JPN') || workLang.includes('JA')) return 'japanese';
    }
    return 'japanese';
}

class AudioFallbackLimitError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AudioFallbackLimitError';
    }
}

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
    data: { rawChunks?: RawChunk[] };
    chunkId?: number;
};

type WorkerCompleteMessage = {
    status: 'complete';
    data: { text?: string; rawChunks?: RawChunk[] };
    chunkId?: number;
};

type WorkerReadyMessage = { status: 'ready'; backend?: string; vendor?: string };

type WorkerInitMessage = { status: 'initiate'; backend?: string; vendor?: string };

type WorkerErrorMessage = { status: 'error'; data?: { message?: string; gpuFallback?: boolean }; chunkId?: number };

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
    multilingual: boolean;
    chunkLengthS: number;
    strideLengthS: number;
    cacheTranscripts: boolean;
    autoWarmup: boolean;
    silenceThreshold: number;
    maxPendingChunks: number;
    pollIntervalMs: number;
    workerUpdateIntervalMs: number;
    idleUnloadMs: number;
    forceWasm: boolean;
    preferLowPowerAdapter: boolean;
    minWebgpuBufferBytes: number;
}

function getWhisperSourceLanguageHint(language: string): TranslationSourceHint {
    return normalizeLanguageCode(language) || 'auto';
}

interface WhisperAudioFallbackSource {
    url: string;
    knownSizeBytes: number | null;
    allowUnknownSize: boolean;
    preferBoundedStreaming: boolean;
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

    // Pre-decoded or live-captured PCM used by the chunk scheduler.
    private pcmBuffer: Float32Array | null = null;
    private pcmSourceUrl: string | null = null; // URL the pcmBuffer was decoded from
    private pcmDuration = 0; // seconds
    private pcmBufferStartTime = 0; // absolute media time represented by sample 0
    private pcmSampleLength = 0; // valid samples when live buffer has spare capacity
    private liveCaptureCleanup: (() => void) | null = null;
    private liveCaptureActive = false;
    private liveCaptureEnded = false;
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
    private chunkOffsets = new Map<number, number>();
    private chunkLastActivity = new Map<number, number>();

    private statusEl: HTMLElement | null = null;
    private errorDismissTimer: number | null = null;

    private modelLoadingKey = '';
    private autoWarmupStarted = false;
    private modelLoadTimer: number | null = null;
    private modelReady = false;
    private workerBackend: 'webgpu' | 'wasm' | null = null;
    private modelOverride: string | null = null;
    private autoTranscribeWorkId: string | null = null;

    private finalizeOnIdle = false;
    private translationInFlight = new Set<string>();
    private lastTranslatedSegmentCount = 0;
    private translateAheadUpTo = 0; // seconds: segments up to this time already sent for translation
    private lastTranslateAheadAt = 0; // throttle translateAhead calls from update messages
    private translationGeneration = 0;
    private activeTranslationQueueKeys = new Set<string>();
    private lastTranscribeProgressAt = 0;
    private lastPersistAt = 0;
    private transcriptionGeneration = 0;
    private workerInitGeneration = 0;
    private workerInitPending: { worker: Worker; generation: number } | null = null;
    private static gpuRecoveryAttempts = 0;
    private static readonly MAX_GPU_RECOVERY = 3;
    private static webgpuFailed = false;
    private static readonly CHUNK_STALL_RECOVERY_COOLDOWN_MS = 10_000;
    private static readonly MAX_CHUNK_STALL_RECOVERIES = 4;
    private gpuCrashed = false; // GPU device loss — cleared on next transcription attempt
    private static crashRecoveries = 0;
    private static readonly MAX_CRASH_RECOVERIES = 10;
    private gpuRecoveryTimer: number | null = null;
    private idleUnloadTimer: number | null = null;
    private loadLeaseRelease: (() => void) | null = null; // GpuScheduler load lease
    private enabled = false;
    private eventCleanups: Array<() => void> = [];
    private storeUnwatch: (() => void) | null = null;
    private loggedTranscriptKeys = new Set<string>();
    private _audioCache: AudioCache | null = null;
    private autoStartTimer: number | null = null;
    private fetchAbortController: AbortController | null = null;
    private chunkStallRecoveryCount = 0;
    private lastChunkStallRecoveryAt = 0;
    private hasWorkerChunkActivity = false;

    private getAudioCache(): AudioCache | null {
        if (!AudioCache.objectUrls) return null;
        if (!this._audioCache) this._audioCache = new AudioCache();
        return this._audioCache;
    }

    constructor() {
        this.bridge = KikoeruBridge.getInstance();
        if (!Whisper.instance) {
            Whisper.instance = this;
        }
    }

    // ------------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------------

    public enable(): void {
        if (this.enabled) return;
        this.enabled = true;
        Logger.log('[Whisper] Enabling Whisper...');

        // Mount the no-flow status overlay as soon as the host player exists,
        // not when model loading begins.
        this.reserveStatusSlot();
        CentralObserver.register('whisper-status-slot', () => this.reserveStatusSlot(), 100);
        this.setupEventListeners();

        const settings = this.getWhisperSettings();
        if (settings.autoWarmup && !this.autoWarmupStarted) {
            this.autoWarmupStarted = true;
            this.initWorker(settings);
        }

        // Use Vuex store.watch to reactively detect playback start.
        // This fires whenever AudioPlayer.playing transitions to true —
        // covers initial load, user pressing play, and track advances.
        // Guard against double registration (enable() called multiple times).
        if (!this.storeUnwatch) {
            this.storeUnwatch = this.bridge.store.watch?.(
                (state: KikoeruStoreState) => !!state.AudioPlayer?.playing,
                (playing: boolean) => {
                    if (this.enabled && playing && Config.get('alwaysTranscribe') && !this.transcribing) {
                        this.tryAutoStartForCurrentTrack();
                    }
                }
            ) || null;
        }

        // Also try immediately in case audio is already playing at enable() time
        if (Config.get('alwaysTranscribe')) {
            this.tryAutoStartForCurrentTrack();
        }
    }

    public disable(): void {
        if (!this.enabled) return;
        this.enabled = false;
        Logger.log('[Whisper] Disabling Whisper...');

        this.storeUnwatch?.();
        this.storeUnwatch = null;
        CentralObserver.unregister('whisper-status-slot');
        this.eventCleanups.splice(0).forEach((cleanup) => cleanup());

        // Clear auto mode before stopping so stopTranscription cannot preserve
        // active UI or schedule work for the next track.
        this.autoTranscribeWorkId = null;
        if (this.transcribing) {
            this.stopTranscription('disable');
        }

        this.clearAutoStartTimer();
        this.clearIdleUnloadTimer();
        this.clearModelLoadTimer();
        this.abortFetch();
        this.stopProcessingLoop();
        this.detachAudioListeners();
        this.resetWorker('disable');
        this.resetState('disable');
        this.statusEl?.parentElement?.classList.remove('asmr-whisper-status-host');
        this.statusEl?.remove();
        this.statusEl = null;
        this.audio = null;
        this.currentTrackSrc = null;
        this.autoWarmupStarted = false;
        this.setButtonsActive(false);
        AppStore.setWhisperState({
            isTranscribing: false,
            isLoadingModel: false,
            progress: 0,
            progressMessage: '',
            currentTrackSrc: null,
        });
    }

    /**
     * Try to auto-start transcription for the current track.
     * Returns true if transcription was started (or is already running).
     */
    private tryAutoStartForCurrentTrack(): boolean {
        if (this.transcribing) return true;
        const track = this.bridge.currentTrack;
        const rawSrc = track?.hash || this.resolveTrackUrl(track);
        if (!rawSrc) return false;
        const src = this.resolveOriginalUrl(rawSrc);

        Logger.debug('[Whisper] Always-transcribe: auto-starting for current track');
        this.currentTrackSrc = src;
        this.autoTranscribeWorkId = this.bridge.currentWorkId || null;
        this.scheduleAutoStart(this.autoTranscribeWorkId || '');
        return true;
    }

    public warmupModel(force = false): void {
        if (force) {
            this.modelOverride = null;
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
        const settings = this.getWhisperSettings();
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
        if (this.eventCleanups.length > 0) return;
        this.eventCleanups.push(EventBus.on('whisper:toggle', () => {
            this.reserveStatusSlot();
            this.toggleTranscription();
        }));

        // Listen for centralized track change events from KikoeruBridge
        this.eventCleanups.push(EventBus.on('track:change', (payload) => {
            this.reserveStatusSlot();
            const track = payload.track;
            // Use hash as canonical ID (AudioCache mutates mediaStreamUrl/src to blob URLs,
            // which would trigger false change detections). Resolve blob URLs as fallback.
            const rawSrc = track.hash || this.resolveTrackUrl(track);
            const newSrc = rawSrc ? this.resolveOriginalUrl(rawSrc) : null;
            if (newSrc && newSrc !== this.currentTrackSrc) {
                Logger.debug('[Whisper] Track change event received via EventBus', { newSrc });
                this.handleTrackChange(newSrc);
            }
        }));

        // No cross-service webgpu:failed propagation for dtype failures — Whisper independently
        // tries WebGPU. But true GPU device loss (process crash) affects ALL workers.
        this.eventCleanups.push(EventBus.on('gpu:device-lost-broadcast', ({ source }) => {
            if (source === 'whisper') return; // Already handled by our own error path
            if (Whisper.webgpuFailed) return; // Already on WASM
            Logger.warn(`[Whisper] GPU device lost in ${source} worker — switching to WASM`);
            this.markWebgpuFailed(`device-lost-broadcast:${source}`);
            if (this.worker) {
                this.worker.postMessage({ type: 'skip-webgpu' });
            }
        }));

        this.eventCleanups.push(EventBus.on('config:change', ({ key, value }) => {
            if (key === 'subtitleLang' || key === 'translateMode' || key === 'translateCnToJp') {
                this.resetTranslationAheadState();
                if (this.segments.length > 0) void this.translateAhead();
                return;
            }
            if (key !== 'forceWhisperWasm' && key !== 'whisperModel' && key !== 'whisperLanguage') return;
            const forceWasmEnabled = key === 'forceWhisperWasm' && value === true;
            if (key === 'forceWhisperWasm') {
                Logger.log(`[Whisper] Force WASM ${forceWasmEnabled ? 'enabled' : 'disabled'} via settings`);
                if (!forceWasmEnabled) this.clearWebgpuFailure('force-wasm-disabled');
            }
            if (key === 'whisperModel') this.modelOverride = null;

            if (!this.worker) return;
            const wasTranscribing = this.transcribing;
            if (wasTranscribing) {
                this.stopTranscription('whisper-config-change');
            }
            this.resetWorker(`config-change-${key}`);

            if (wasTranscribing) {
                const audio = getAudioElement();
                if (audio && !audio.paused) {
                    this.startTranscription().catch(err => Logger.error('[Whisper] Restart after settings change failed:', err));
                }
            }
        }));
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

        // Immediately check cache and emit snapshot so LearnerSubtitles can render
        // without waiting for the 500ms scheduleAutoStart delay.
        this.emitCachedSnapshotIfAvailable(newSrc);

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

    private isGpuErrorMessage(message: string): boolean {
        return GPU_ERROR_PATTERN.test(message);
    }

    private isExplicitDeviceLossMessage(message: string): boolean {
        return EXPLICIT_DEVICE_LOSS_PATTERN.test(message);
    }

    private getWasmPolicyReason(): string | null {
        if (Config.get('forceWhisperWasm') === true) return 'forceWhisperWasm';
        return null;
    }

    private shouldForceWasm(): boolean {
        return this.getWasmPolicyReason() !== null;
    }

    private markWebgpuFailed(reason: string): void {
        Whisper.webgpuFailed = true;
        Logger.warn(`[Whisper] WebGPU permanently disabled for this session (${reason}). Refresh page to retry.`);
    }

    /**
     * No longer re-enables WebGPU after a crash. Once dead, stays dead until page refresh.
     * Kept as a no-op so callers don't need restructuring.
     */
    private maybeReenableWebgpu(_reason: string): boolean {
        return false;
    }

    private clearWebgpuFailure(reason: string): void {
        Whisper.webgpuFailed = false;
        this.gpuCrashed = false;
        Logger.debug(`[Whisper] Cleared WebGPU failure lock (${reason})`);
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
        if (!this.enabled || this.transcribing) return;
        this.reserveStatusSlot();
        const reopenedWebgpu = this.maybeReenableWebgpu('start-transcription');
        if (reopenedWebgpu && this.worker) {
            this.resetWorker('webgpu-retry');
        }
        if (this.gpuCrashed) {
            if (Whisper.crashRecoveries >= Whisper.MAX_CRASH_RECOVERIES) {
                Logger.warn('[Whisper] startTranscription blocked — too many GPU crash recoveries this session');
                return;
            }
            Whisper.crashRecoveries++;
            Logger.warn(`[Whisper] Clearing GPU crash state for recovery (attempt ${Whisper.crashRecoveries}/${Whisper.MAX_CRASH_RECOVERIES})`);
            this.gpuCrashed = false;
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
        const rawSrc = this.resolveTrackUrl(bridgeTrack) || audioSrc;
        const src = rawSrc ? this.resolveOriginalUrl(rawSrc) : null;
        if (!src) {
            this.dispatchError(I18n.t('whisperNoAudioSource'));
            return;
        }

        // Each start owns a unique generation. A superseded download or decode
        // may still settle after abort (not every userscript transport can be
        // cancelled), but it must never mutate or stop the newer run.
        const startGeneration = ++this.transcriptionGeneration;
        this.transcribing = true;
        EventBus.emit('whisper:transcribing', { active: true });
        this.setButtonsActive(true);
        this.dispatchProgress(I18n.t('whisperInit'), 0, 'loading');

        const rawTrackId = bridgeTrack?.hash || this.resolveTrackUrl(bridgeTrack) || src;
        this.currentTrackSrc = this.resolveOriginalUrl(rawTrackId);
        this.audio = audio;
        const workId = this.bridge.currentWorkId;
        this.autoTranscribeWorkId = workId || null;
        AppStore.setWhisperState({ currentTrackSrc: src, isTranscribing: true });
        this.segments = [];
        this.loggedTranscriptKeys.clear();
        this.lastSegmentEnd = 0;
        this.clearChunkTracking({ resetRecovery: true, resetChunkCounter: true });
        this.finalizeOnIdle = false;
        this.resetTranslationAheadState();
        this.pcmBuffer = null;
        this.pcmSourceUrl = null;
        this.pcmDuration = 0;
        this.pcmBufferStartTime = 0;
        this.pcmSampleLength = 0;
        this.liveCaptureEnded = false;
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
                        const corrected = this.applyLanguageAwareCorrections(seg.text);
                        if (corrected !== seg.text) seg.text = corrected;
                    }
                    this.segments = cached.segments;
                    this.logNewTranscriptSegments('cache');
                    this.lastSegmentEnd = cached.segments[cached.segments.length - 1]?.end || 0;
                    this.updateTranscriptIndex(this.currentCacheKey, cached);
                    const latest = cached.segments[cached.segments.length - 1];
                    EventBus.emit('whisper:update', {
                        text: latest?.text || cached.text,
                        segments: cached.segments,
                        final: !!cached.complete,
                        sourceLanguageHint: getWhisperSourceLanguageHint(settings.language),
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

        const cacheTranscribedUpTo = this.transcribedUpTo; // 0 if no cache, >0 if partial

        // Load the model while audio becomes available. Previously model startup
        // waited behind a full-file download/decode, which looked permanently stuck
        // on long tracks and low-resource machines.
        this.initWorker(settings);

        audio.addEventListener('seeking', this.handleSeek);
        audio.addEventListener('pause', this.handlePause);
        audio.addEventListener('play', this.handlePlay);
        audio.addEventListener('ended', this.handleEnded);

        // Prefer bounded live PCM from the already-playing element. This avoids a
        // second download entirely and begins transcription after the first short
        // chunk is captured. Cross-origin elements without an existing CORS-safe
        // Web Audio route are intentionally excluded so playback is never silenced.
        if (this.startLiveAudioCapture(audio, startGeneration, cacheTranscribedUpTo)) {
            this.startProcessingLoop();
            this.dispatchProgress(I18n.t('whisperTranscribing'), 0, 'transcribing');
            Logger.debug('[Whisper] Live transcription started.', { src, settings });
            return;
        }

        // Live capture is unavailable. A compatibility decode is allowed only for
        // an existing small cache entry or a host-reported small file; unknown and
        // large files never trigger an unbounded background download.
        const fallbackSource = this.resolveFallbackAudioSource(bridgeTrack, src);
        const trackUrl = fallbackSource.url;

        if (this.isHlsUrl(trackUrl)) {
            Logger.warn('[Whisper] HLS streams are not supported for transcription:', trackUrl);
            this.stopTranscription('hls-not-supported');
            this.dispatchError(I18n.t('whisperHlsWarning'));
            return;
        }

        this.dispatchProgress(I18n.t('whisperFetchingAudio'), 0, 'loading');
        // Create a fresh AbortController so handleTrackChange can cancel this download
        this.abortFetch();
        const fetchController = new AbortController();
        this.fetchAbortController = fetchController;
        try {
            const pcmBuffer = await this.fetchAndDecodeAudio(
                trackUrl,
                fetchController.signal,
                fallbackSource.knownSizeBytes,
                fallbackSource.allowUnknownSize,
                fallbackSource.preferBoundedStreaming,
            );

            if (!this.isCurrentFetch(startGeneration, fetchController)) {
                Logger.debug('[Whisper] Ignoring decoded audio from a superseded transcription');
                return;
            }

            this.pcmBuffer = pcmBuffer;
            this.pcmSourceUrl = trackUrl;
            this.pcmBufferStartTime = 0;
            this.pcmSampleLength = pcmBuffer.length;
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
            if (!this.isCurrentFetch(startGeneration, fetchController)) {
                Logger.debug('[Whisper] Ignoring fetch/decode failure from a superseded transcription');
                return;
            }
            // AbortError means track changed while downloading — not a real error
            if (err instanceof DOMException && err.name === 'AbortError') {
                Logger.debug('[Whisper] Audio fetch aborted (track changed)');
                this.stopTranscription('fetch-aborted');
                return;
            }
            Logger.error('[Whisper] Failed to fetch and decode audio:', err);
            this.stopTranscription('fetch-failed');
            const message = err instanceof Error ? err.message : String(err);
            this.dispatchError(I18n.format('whisperTranscriptionError', { message }));
            return;
        } finally {
            if (this.fetchAbortController === fetchController) {
                this.fetchAbortController = null;
            }
        }

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
        // A Web Worker cannot cancel an already-running Transformers.js
        // pipeline call. Terminate it when a user stop/track change happens
        // during model load or inference so a slow WASM job cannot keep the
        // CPU busy and block the next transcription forever.
        if (this.workerInitPending || this.pendingChunks > 0) {
            this.resetWorker(`cancel-active-${reason}`);
        }
        this.clearChunkTracking({ resetRecovery: true, resetChunkCounter: false });
        this.loggedTranscriptKeys.clear();
        AppStore.setWhisperState({ isTranscribing: false, isLoadingModel: false, progress: 0, progressMessage: '', currentTrackSrc: this.currentTrackSrc });

        this.detachAudioListeners();

        if (this.seekDebounceTimer) {
            clearTimeout(this.seekDebounceTimer);
            this.seekDebounceTimer = null;
        }
        if (this.seekingRafId) {
            cancelAnimationFrame(this.seekingRafId);
            this.seekingRafId = 0;
        }
        this.stopProcessingLoop();
        this.stopLiveAudioCapture();
        this.pcmBuffer = null;
        this.pcmSourceUrl = null;
        this.pcmDuration = 0;
        this.pcmBufferStartTime = 0;
        this.pcmSampleLength = 0;
        this.transcribedUpTo = 0;

        this.persistCache(shouldFinalize);
        this.scheduleIdleUnload();
    }

    private isCurrentFetch(generation: number, controller: AbortController): boolean {
        return this.transcribing
            && this.transcriptionGeneration === generation
            && this.fetchAbortController === controller;
    }

    private detachAudioListeners(): void {
        if (!this.audio) return;
        this.audio.removeEventListener('seeking', this.handleSeek);
        this.audio.removeEventListener('pause', this.handlePause);
        this.audio.removeEventListener('play', this.handlePlay);
        this.audio.removeEventListener('ended', this.handleEnded);
    }

    private scheduleIdleUnload(): void {
        this.clearIdleUnloadTimer();
        // Don't unload if auto-transcribe is pending (will start again on next track)
        if (this.autoTranscribeWorkId) return;
        const settings = this.getWhisperSettings();
        this.idleUnloadTimer = window.setTimeout(() => {
            if (!this.transcribing && this.worker) {
                Logger.log('[Whisper] Idle timeout reached, unloading model to free memory');
                this.resetWorker('idle-unload');
            }
        }, settings.idleUnloadMs);
    }

    private clearIdleUnloadTimer(): void {
        if (this.idleUnloadTimer) {
            clearTimeout(this.idleUnloadTimer);
            this.idleUnloadTimer = null;
        }
    }

    private clearChunkTracking(options?: { resetRecovery?: boolean; resetChunkCounter?: boolean }): void {
        const resetRecovery = options?.resetRecovery ?? true;
        const resetChunkCounter = options?.resetChunkCounter ?? false;
        this.pendingChunks = 0;
        this.chunkSendTimes.clear();
        this.chunkGenerations.clear();
        this.chunkOffsets.clear();
        this.chunkLastActivity.clear();
        this.hasWorkerChunkActivity = false;
        if (resetRecovery) {
            this.chunkStallRecoveryCount = 0;
            this.lastChunkStallRecoveryAt = 0;
        }
        if (resetChunkCounter) {
            this.nextChunkId = 0;
        }
    }

    private isCurrentChunkMessage(chunkId?: number): boolean {
        if (typeof chunkId !== 'number') return true;
        if (!this.chunkSendTimes.has(chunkId)) return false;
        return this.chunkGenerations.get(chunkId) === this.transcriptionGeneration;
    }

    private markChunkActivity(chunkId?: number): void {
        if (typeof chunkId === 'number') {
            this.chunkLastActivity.set(chunkId, performance.now());
        }
        this.hasWorkerChunkActivity = true;
        this.chunkStallRecoveryCount = 0;
    }

    private dropChunk(chunkId?: number): void {
        this.pendingChunks = Math.max(0, this.pendingChunks - 1);
        if (typeof chunkId !== 'number') return;
        this.chunkSendTimes.delete(chunkId);
        this.chunkGenerations.delete(chunkId);
        this.chunkOffsets.delete(chunkId);
        this.chunkLastActivity.delete(chunkId);
    }

    private resetState(reason: string): void {
        Logger.debug('[Whisper] Reset state:', reason);
        this.transcriptionGeneration++;
        this.clearChunkTracking({ resetRecovery: true, resetChunkCounter: true });
        this.lastSegmentEnd = 0;
        this.segments = [];
        this.loggedTranscriptKeys.clear();
        this.currentCacheKey = null;
        this.currentCacheIdentity = null;
        this.finalizeOnIdle = false;
        this.modelLoadingKey = '';
        this.resetTranslationAheadState();
        this.stopLiveAudioCapture();
        this.pcmBuffer = null;
        this.pcmSourceUrl = null;
        this.pcmDuration = 0;
        this.pcmBufferStartTime = 0;
        this.pcmSampleLength = 0;
        this.transcribedUpTo = 0;
        this.stopProcessingLoop();
        this.clearStatus();
    }

    // ------------------------------------------------------------------------
    // URL resolution
    // ------------------------------------------------------------------------

    private resolveLowQualityTrackUrl(track?: PlayerTrack): string | null {
        if (!track) return null;
        return track.streamLowQualityUrl || track.stream_low_quality_url || null;
    }

    private resolveFullQualityTrackUrl(track?: PlayerTrack): string | null {
        if (!track) return null;
        return track.mediaStreamUrl
            || track.media_stream_url
            || track.stream_url
            || track.src
            || track.url
            || track.mediaDownloadUrl
            || track.media_download_url
            || track.file_url
            || null;
    }

    private resolveTrackUrl(track: PlayerTrack | undefined = this.bridge.currentTrack): string | null {
        if (!track) return null;
        // Playback/stream URLs must win over download URLs. Runtime hosts use
        // both camelCase and snake_case shapes depending on deployment/version.
        return this.resolveLowQualityTrackUrl(track) || this.resolveFullQualityTrackUrl(track);
    }

    private getKnownTrackSize(track?: PlayerTrack): number | null {
        const size = Number(track?.size);
        return Number.isFinite(size) && size > 0 ? size : null;
    }

    private resolveFallbackAudioSource(track: PlayerTrack | undefined, defaultUrl: string): WhisperAudioFallbackSource {
        const lowQualityUrl = this.resolveLowQualityTrackUrl(track);
        if (lowQualityUrl) {
            return {
                url: lowQualityUrl,
                knownSizeBytes: null,
                allowUnknownSize: true,
                preferBoundedStreaming: true,
            };
        }
        return {
            url: this.resolveFullQualityTrackUrl(track) || defaultUrl,
            knownSizeBytes: this.getKnownTrackSize(track),
            allowUnknownSize: false,
            preferBoundedStreaming: false,
        };
    }

    private canUseLiveAudioCapture(audio: HTMLAudioElement): boolean {
        if (DeviceCapabilities.profile.isMobile || typeof AudioContext === 'undefined') return false;
        if (hasSharedSourceNode(audio)) return true;
        if (AudioCache.hasTrustedCorsPlayback(audio)) return true;

        const currentSource = audio.currentSrc || audio.src;
        if (!currentSource) return false;
        try {
            const parsed = new URL(currentSource, window.location.href);
            if (parsed.protocol === 'blob:') return true;
            if ((parsed.protocol === 'http:' || parsed.protocol === 'https:')
                && parsed.origin === window.location.origin) return true;
            // crossOrigin="anonymous" requests CORS but does not prove the
            // response supplied ACAO. Creating a new MediaElementSource for a
            // tainted response can mandate silence, so only reuse a source that
            // another feature has already established (handled above).
            return false;
        } catch {
            return false;
        }
    }

    private startLiveAudioCapture(
        audio: HTMLAudioElement,
        generation: number,
        cacheContinuationTime: number,
    ): boolean {
        this.stopLiveAudioCapture();
        if (!this.canUseLiveAudioCapture(audio)) return false;

        const startTime = Math.max(0, Number.isFinite(audio.currentTime) ? audio.currentTime : 0);
        this.liveCaptureActive = true;
        this.liveCaptureEnded = audio.ended;
        this.resetLivePcmBuffer(startTime, Math.max(startTime, cacheContinuationTime));

        const tap = connectAudioPcmTap(audio, {
            tag: 'Whisper',
            targetSampleRate: TARGET_SAMPLE_RATE,
            onData: (samples) => this.handleLivePcm(samples, audio, generation),
        });

        if (!tap) {
            this.liveCaptureActive = false;
            this.pcmBuffer = null;
            this.pcmDuration = 0;
            this.pcmSampleLength = 0;
            return false;
        }

        this.liveCaptureCleanup = tap.disconnect;
        Logger.debug('[Whisper] Attached bounded live PCM capture', {
            startTime,
            sampleRate: TARGET_SAMPLE_RATE,
            maxBufferedSeconds: MAX_LIVE_PCM_SECONDS,
        });
        return true;
    }

    private handleLivePcm(samples: Float32Array, audio: HTMLAudioElement, generation: number): void {
        if (!this.liveCaptureActive
            || !this.transcribing
            || this.transcriptionGeneration !== generation
            || this.audio !== audio
            || audio.paused
            || audio.ended
            || audio.seeking) return;
        this.appendLivePcm(samples);
    }

    private stopLiveAudioCapture(): void {
        const cleanup = this.liveCaptureCleanup;
        this.liveCaptureCleanup = null;
        this.liveCaptureActive = false;
        this.liveCaptureEnded = false;
        if (cleanup) {
            try { cleanup(); } catch { /* already detached */ }
        }
    }

    private resetLivePcmBuffer(startTime: number, cursorTime = startTime): void {
        this.pcmBufferStartTime = Math.max(0, startTime);
        this.pcmDuration = this.pcmBufferStartTime;
        this.pcmSampleLength = 0;
        this.pcmBuffer = new Float32Array(INITIAL_LIVE_PCM_SECONDS * TARGET_SAMPLE_RATE);
        this.pcmSourceUrl = null;
        this.transcribedUpTo = Math.max(this.pcmBufferStartTime, cursorTime);
        this.finalizeOnIdle = false;
        this.liveCaptureEnded = false;
    }

    private appendLivePcm(samples: Float32Array): void {
        if (!this.liveCaptureActive || samples.length === 0 || !this.pcmBuffer) return;

        const maxSamples = MAX_LIVE_PCM_SECONDS * TARGET_SAMPLE_RATE;
        let incoming = samples;
        if (incoming.length > maxSamples) incoming = incoming.subarray(incoming.length - maxSamples);

        const requiredDrop = Math.max(0, this.pcmSampleLength + incoming.length - maxSamples);
        if (requiredDrop > 0) {
            // Trim in batches so a full buffer does not shift ~11 MB on every
            // 4096-sample callback.
            const trimBatch = LIVE_PCM_TRIM_SECONDS * TARGET_SAMPLE_RATE;
            const droppedSamples = Math.min(this.pcmSampleLength, Math.max(requiredDrop, trimBatch));
            this.pcmBuffer.copyWithin(0, droppedSamples, this.pcmSampleLength);
            this.pcmSampleLength -= droppedSamples;
            this.pcmBufferStartTime += droppedSamples / TARGET_SAMPLE_RATE;
            // A slow CPU must not accumulate unbounded work. Stay near live
            // playback after the capped window is exhausted.
            this.transcribedUpTo = Math.max(this.transcribedUpTo, this.pcmBufferStartTime);
        }

        const required = this.pcmSampleLength + incoming.length;
        if (this.pcmBuffer.length < required) {
            let capacity = Math.max(this.pcmBuffer.length, TARGET_SAMPLE_RATE);
            while (capacity < required) capacity = Math.min(maxSamples, capacity * 2);
            const expanded = new Float32Array(capacity);
            expanded.set(this.pcmBuffer.subarray(0, this.pcmSampleLength));
            this.pcmBuffer = expanded;
        }

        this.pcmBuffer.set(incoming, this.pcmSampleLength);
        this.pcmSampleLength += incoming.length;
        this.pcmDuration = this.pcmBufferStartTime + this.pcmSampleLength / TARGET_SAMPLE_RATE;
    }

    private isHlsUrl(url: string): boolean {
        return /\.m3u8($|\?)/i.test(url) || /\/hls\//i.test(url);
    }

    private isTrustedPlaybackHost(hostname: string): boolean {
        const host = hostname.toLowerCase();
        return host === 'asmr.one'
            || host === 'www.asmr.one'
            || host.endsWith('.asmr.one')
            || host === 'asmr-100.com'
            || host === 'asmr-200.com'
            || host === 'asmr-300.com'
            || host === 'api.asmr.one'
            || host === 'api.asmr-100.com'
            || host === 'api.asmr-200.com'
            || host === 'api.asmr-300.com';
    }

    private shouldPreferGmRequestForAudio(url: string): boolean {
        try {
            const parsed = new URL(url, window.location.href);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

            const crossOrigin = parsed.origin !== window.location.origin;
            if (!crossOrigin) return false;

            const path = parsed.pathname.toLowerCase();
            const hasMediaExtension = /\.(mp3|wav|m4a|flac|ogg|aac|opus)(?:$|\?)/i.test(path);
            const looksStaticDownload = path.includes('/download/') || hasMediaExtension;
            const trustedHost = this.isTrustedPlaybackHost(parsed.hostname);

            return looksStaticDownload || !trustedHost;
        } catch {
            return false;
        }
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

    private assertFallbackAudioSize(size: number | null | undefined): void {
        if (!Number.isFinite(size) || Number(size) <= 0 || Number(size) > MAX_FALLBACK_AUDIO_BYTES) {
            throw new AudioFallbackLimitError(I18n.format('whisperLiveCaptureFallbackLimit', {
                max: Math.round(MAX_FALLBACK_AUDIO_BYTES / 1024 / 1024),
            }));
        }
    }

    private async readResponseArrayBufferBounded(response: Response, signal?: AbortSignal): Promise<ArrayBuffer> {
        const contentLengthHeader = response.headers.get('content-length');
        const contentLength = contentLengthHeader === null ? null : Number(contentLengthHeader);
        if (contentLength !== null && Number.isFinite(contentLength) && contentLength > 0) {
            this.assertFallbackAudioSize(contentLength);
        }

        if (!response.body) {
            // Without a streaming body there is no way to abort at the byte
            // cap, so require a trustworthy Content-Length before allocating.
            this.assertFallbackAudioSize(contentLength);
            const blob = await response.blob();
            this.assertFallbackAudioSize(blob.size);
            return blob.arrayBuffer();
        }

        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        const startedAt = performance.now();
        try {
            while (true) {
                if (signal?.aborted) throw new DOMException('Download aborted (track changed)', 'AbortError');
                const totalRemainingMs = BOUNDED_AUDIO_STREAM_TOTAL_MS - (performance.now() - startedAt);
                if (totalRemainingMs <= 0) throw new Error(I18n.t('whisperFetchAudioFailed'));
                const readTimeoutMs = Math.min(BOUNDED_AUDIO_STREAM_INACTIVITY_MS, totalRemainingMs);
                const { done, value } = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
                    const timer = window.setTimeout(
                        () => reject(new Error(I18n.t('whisperFetchAudioFailed'))),
                        readTimeoutMs,
                    );
                    reader.read().then(
                        (result) => {
                            clearTimeout(timer);
                            resolve(result);
                        },
                        (error) => {
                            clearTimeout(timer);
                            reject(error);
                        },
                    );
                });
                if (done) break;
                if (!value || value.byteLength === 0) continue;
                total += value.byteLength;
                this.assertFallbackAudioSize(total);
                chunks.push(value);
            }
        } catch (error) {
            try { await reader.cancel(); } catch { /* already closed */ }
            throw error;
        }

        const combined = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            combined.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return combined.buffer;
    }

    private async fetchAndDecodeAudio(
        url: string,
        signal?: AbortSignal,
        knownSizeBytes?: number | null,
        allowUnknownSize = false,
        preferBoundedStreaming = false,
    ): Promise<Float32Array> {
        let arrayBuffer: ArrayBuffer | null = null;

        // Resolve blob: URLs back to original source URLs for cache lookups and downloads
        const originalUrl = this.resolveOriginalUrl(url);
        const isBlobUrl = url.startsWith('blob:');
        if (!isBlobUrl) {
            let protocol = '';
            try {
                protocol = new URL(originalUrl, window.location.href).protocol;
            } catch {
                throw new Error('Invalid audio URL');
            }
            if (protocol !== 'http:' && protocol !== 'https:') {
                throw new Error(`Unsupported audio URL protocol: ${protocol || 'unknown'}`);
            }
        }

        // 1. Try AudioCache first (player already downloaded this)
        // Timeout: getBlob can hang if StorageManager eviction holds a readwrite
        // transaction on the same IDB object store. Skip cache after 3s.
        const audioCache = this.getAudioCache();
        let blob: Blob | null = null;
        try {
            const getBlobPromise = audioCache?.getBlob(originalUrl);
            if (getBlobPromise) {
                blob = await Promise.race([
                    getBlobPromise,
                    new Promise<null>(resolve => setTimeout(() => resolve(null), 3000)),
                ]);
            }
        } catch {
            // AudioCache may not be initialized yet
        }

        if (blob) {
            this.assertFallbackAudioSize(blob.size);
            Logger.debug('[Whisper] Using AudioCache blob:', (blob.size / 1024 / 1024).toFixed(2) + 'MB');
            this.dispatchProgress(I18n.t('whisperDecodingAudio'), 50, 'loading');
            arrayBuffer = await blob.arrayBuffer();
        } else {
            // Never begin a compatibility download whose size is unknown or
            // exceeds the explicit small-file cap. The lower-quality source is
            // the sole exception to the preflight-size requirement: it is read
            // through the strictly bounded streaming reader below, which aborts
            // as soon as the same hard byte cap is exceeded.
            if (!allowUnknownSize || (knownSizeBytes !== null && knownSizeBytes !== undefined)) {
                this.assertFallbackAudioSize(knownSizeBytes);
            }
        }

        if (blob) {
            // Filled from AudioCache above.
        } else if (isBlobUrl) {
            // 2a. For blob URLs, fetch directly (gmRequest can't handle blob: protocol)
            Logger.debug('[Whisper] Fetching blob URL directly:', url);
            this.dispatchProgress(I18n.t('whisperDecodingAudio'), 10, 'loading');
            const res = await fetch(url, { signal });
            arrayBuffer = await this.readResponseArrayBufferBounded(res, signal);
        } else if (preferBoundedStreaming) {
            // The low-quality CDN response is CORS-enabled. Stream it directly
            // so an absent/misreported Content-Length can never turn into an
            // unbounded full-file allocation or a fallback to mediaDownloadUrl.
            Logger.debug('[Whisper] Streaming bounded low-quality audio:', originalUrl);
            this.dispatchProgress(I18n.t('whisperFetchingAudio'), 0, 'loading');
            const res = await fetch(originalUrl, { signal });
            if (!res.ok) throw new Error(I18n.t('whisperFetchAudioFailed'));
            arrayBuffer = await this.readResponseArrayBufferBounded(res, signal);
        } else {
            // 2b. Download audio file — try methods in order of reliability:
            //   1. bridge.axios OR gmRequest, selected by URL characteristics
            //   2. fallback to the other transport
            //   3. bare fetch (same-origin / CORS-enabled URLs only)
            Logger.debug('[Whisper] Downloading audio:', originalUrl);
            this.dispatchProgress(I18n.t('whisperDownloadingAudio'), 0, 'loading');
            const preferGmRequest = this.shouldPreferGmRequestForAudio(originalUrl);
            if (preferGmRequest) {
                Logger.debug('[Whisper] Using gmRequest-first strategy for cross-origin/static media URL');
            }

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

            const tryAxiosDownload = async (): Promise<ArrayBuffer> => {
                // Inactivity-based timeout: abort only if no data received for 60s
                // (a fixed timeout fails for large files that are actively downloading)
                const INACTIVITY_MS = 60_000;
                const abortController = new AbortController();
                // Propagate external abort (track change) to the download's AbortController
                const onExternalAbort = () => abortController.abort();
                signal?.addEventListener('abort', onExternalAbort);
                let inactivityReject: (err: Error) => void;
                let activityTimer: ReturnType<typeof setTimeout>;
                let limitError: AudioFallbackLimitError | null = null;
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
                        try {
                            if (e.total) this.assertFallbackAudioSize(e.total);
                            if (e.loaded) this.assertFallbackAudioSize(e.loaded);
                        } catch (error) {
                            limitError = error as AudioFallbackLimitError;
                            abortController.abort();
                            inactivityReject(limitError);
                            return;
                        }
                        resetTimer();
                        reportProgress(e.loaded || 0, e.total || null);
                    },
                }).finally(() => {
                    clearTimeout(activityTimer);
                    signal?.removeEventListener('abort', onExternalAbort);
                });
                try {
                    const response = await Promise.race([download, inactivityGuard]);
                    this.assertFallbackAudioSize(response.data.byteLength);
                    return response.data;
                } catch (error) {
                    if (limitError) throw limitError;
                    throw error;
                }
            };

            const tryGmRequestDownload = async (): Promise<ArrayBuffer> => {
                const abortController = new AbortController();
                const onExternalAbort = () => abortController.abort();
                signal?.addEventListener('abort', onExternalAbort);
                let limitError: AudioFallbackLimitError | null = null;
                try {
                    const res = await gmRequest({
                        url: originalUrl,
                        responseType: 'arraybuffer',
                        timeout: 120_000,
                        signal: abortController.signal,
                        onprogress: (event) => {
                            try {
                                if (event.lengthComputable && event.total > 0) {
                                    this.assertFallbackAudioSize(event.total);
                                }
                                if (event.loaded > 0) this.assertFallbackAudioSize(event.loaded);
                            } catch (error) {
                                limitError = error as AudioFallbackLimitError;
                                abortController.abort();
                                return;
                            }
                            reportProgress(event.loaded, event.lengthComputable ? event.total : null);
                        },
                    });
                    const response = res.response as ArrayBuffer;
                    this.assertFallbackAudioSize(response.byteLength);
                    return response;
                } catch (error) {
                    if (limitError) throw limitError;
                    throw error;
                } finally {
                    signal?.removeEventListener('abort', onExternalAbort);
                }
            };

            try {
                if (preferGmRequest) {
                    arrayBuffer = await tryGmRequestDownload();
                    Logger.debug('[Whisper] Audio downloaded via gmRequest:', (arrayBuffer.byteLength / 1024 / 1024).toFixed(2) + 'MB');
                } else {
                    arrayBuffer = await tryAxiosDownload();
                    Logger.debug('[Whisper] Audio downloaded via axios:', (arrayBuffer.byteLength / 1024 / 1024).toFixed(2) + 'MB');
                }
            } catch (primaryErr) {
                // If aborted due to track change, propagate immediately — don't try fallbacks
                if (signal?.aborted) throw new DOMException('Download aborted (track changed)', 'AbortError');
                if (primaryErr instanceof AudioFallbackLimitError) throw primaryErr;
                Logger.warn(
                    `[Whisper] ${preferGmRequest ? 'gmRequest' : 'axios'} download failed, trying ${preferGmRequest ? 'axios' : 'gmRequest'}:`,
                    primaryErr,
                );
                try {
                    if (preferGmRequest) {
                        arrayBuffer = await tryAxiosDownload();
                        Logger.debug('[Whisper] Audio downloaded via axios:', (arrayBuffer.byteLength / 1024 / 1024).toFixed(2) + 'MB');
                    } else {
                        arrayBuffer = await tryGmRequestDownload();
                        Logger.debug('[Whisper] Audio downloaded via gmRequest:', (arrayBuffer.byteLength / 1024 / 1024).toFixed(2) + 'MB');
                    }
                } catch (secondaryErr) {
                    if (signal?.aborted) throw new DOMException('Download aborted (track changed)', 'AbortError');
                    if (secondaryErr instanceof AudioFallbackLimitError) throw secondaryErr;
                    Logger.warn('[Whisper] Secondary download transport failed, trying fetch');
                    const res = await fetch(originalUrl, { signal });
                    arrayBuffer = await this.readResponseArrayBufferBounded(res, signal);
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

        if (!arrayBuffer) throw new Error(I18n.t('whisperFetchAudioFailed'));
        this.assertFallbackAudioSize(arrayBuffer.byteLength);

        // Check abort signal before starting decode — OfflineAudioContext is not cancellable
        if (signal?.aborted) {
            throw new DOMException('Decode aborted (track changed)', 'AbortError');
        }

        this.dispatchProgress(I18n.t('whisperDecodingAudio'), 55, 'loading');
        return this.decodeToPcm(arrayBuffer, signal);
    }

    private getAudioDecodeTimeoutMs(byteLength: number): number {
        const sizeMiB = Math.max(1, byteLength / (1024 * 1024));
        return Math.min(
            AUDIO_DECODE_TIMEOUT_MAX_MS,
            Math.max(AUDIO_DECODE_TIMEOUT_MIN_MS, Math.round(sizeMiB * AUDIO_DECODE_TIMEOUT_PER_MIB_MS)),
        );
    }

    private waitForAudioOperation<T>(operation: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
            };
            const finish = (callback: () => void) => {
                if (settled) return;
                settled = true;
                cleanup();
                callback();
            };
            const onAbort = () => finish(() => reject(new DOMException('Decode aborted (track changed)', 'AbortError')));
            const timer = window.setTimeout(() => {
                finish(() => reject(new Error(I18n.format('whisperDecodeTimeout', {
                    seconds: Math.round(timeoutMs / 1000),
                }))));
            }, timeoutMs);

            if (signal?.aborted) {
                onAbort();
                return;
            }
            signal?.addEventListener('abort', onAbort, { once: true });
            operation.then(
                (value) => finish(() => resolve(value)),
                (error) => finish(() => reject(error)),
            );
        });
    }

    private async decodeToPcm(arrayBuffer: ArrayBuffer, signal?: AbortSignal): Promise<Float32Array> {
        const timeoutMs = this.getAudioDecodeTimeoutMs(arrayBuffer.byteLength);
        // Offline contexts do not consume Chrome's small live-AudioContext
        // quota, so rapid track changes cannot exhaust the six-context cap.
        const decoderContext = new OfflineAudioContext(1, 1, TARGET_SAMPLE_RATE);
        const audioBuffer = await this.waitForAudioOperation(
            decoderContext.decodeAudioData(arrayBuffer),
            timeoutMs,
            signal,
        );

        // Downmix to mono + resample to 16kHz in one native call
        const totalSamples = Math.ceil(audioBuffer.duration * TARGET_SAMPLE_RATE);
        if (!Number.isFinite(totalSamples) || totalSamples <= 0) {
            throw new Error(I18n.t('whisperDecodeInvalidAudio'));
        }
        const offlineCtx = new OfflineAudioContext(1, totalSamples, TARGET_SAMPLE_RATE);
        const source = offlineCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(offlineCtx.destination);
        source.start(0);
        const rendered = await this.waitForAudioOperation(offlineCtx.startRendering(), timeoutMs, signal);

        return rendered.getChannelData(0);
    }

    // ------------------------------------------------------------------------
    // Lookahead processing loop
    // ------------------------------------------------------------------------

    private startProcessingLoop(): void {
        this.stopProcessingLoop();
        const settings = this.getWhisperSettings();
        this.processingLoopId = window.setInterval(() => {
            this.maybeProcessNextChunk();
        }, settings.pollIntervalMs);
    }

    private stopProcessingLoop(): void {
        if (this.processingLoopId !== null) {
            clearInterval(this.processingLoopId);
            this.processingLoopId = null;
        }
    }

    private maybeProcessNextChunk(): void {
        if (!this.transcribing || !this.pcmBuffer) return;
        if (!this.modelReady) return;

        // Guard: if the cursor is below lastSegmentEnd AND within the contiguous
        // segment range, clamp it forward to avoid re-processing already-transcribed
        // regions. But if it's before the first segment, the cursor was intentionally
        // placed there to fill an untranscribed gap — leave it alone.
        if (this.transcribedUpTo < this.lastSegmentEnd && this.segments.length > 0) {
            const coverageStart = this.segments[0].start;
            if (this.transcribedUpTo >= coverageStart - 2) {
                Logger.debug('[Whisper] transcribedUpTo regression detected, clamping', {
                    was: this.transcribedUpTo.toFixed(2),
                    clampTo: this.lastSegmentEnd.toFixed(2),
                });
                this.transcribedUpTo = this.lastSegmentEnd;
            }
        }

        // Sentinel: detect track changes that EventBus missed
        // Resolve blob URLs so comparison isn't fooled by AudioCache URL mutation
        const bridgeTrack = this.bridge.currentTrack;
        const rawBridgeSrc = bridgeTrack?.hash || this.resolveTrackUrl(bridgeTrack);
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

        const audio = this.audio || getAudioElement();
        if (!audio) return;

        const settings = this.getWhisperSettings();
        this.checkForStalledChunks(settings);
        const maxPending = this.hasWorkerChunkActivity ? settings.maxPendingChunks : 1;
        if (this.pendingChunks >= maxPending) return;
        const bootstrapMode = !this.hasWorkerChunkActivity;
        const chunkLengthS = bootstrapMode
            ? Math.min(settings.chunkLengthS, INITIAL_BOOTSTRAP_CHUNK_LENGTH_S)
            : settings.chunkLengthS;
        const overlapSec = bootstrapMode
            ? 0
            : Math.min(settings.strideLengthS, Math.max(1, chunkLengthS - 1));
        const chunkSamples = Math.floor(chunkLengthS * TARGET_SAMPLE_RATE);
        const playhead = audio.currentTime;

        if (this.transcribedUpTo < this.pcmBufferStartTime) {
            this.transcribedUpTo = this.pcmBufferStartTime;
        }

        // Don't process past currently available audio. A live buffer is not
        // complete until the media element actually ends.
        if (this.transcribedUpTo >= this.pcmDuration) {
            if ((!this.liveCaptureActive || this.liveCaptureEnded) && this.pendingChunks === 0) {
                this.finalizeOnIdle = true;
                this.maybeFinalizeTranscript();
            }
            return;
        }

        // Extract chunk from PCM buffer
        const availableSamples = this.liveCaptureActive ? this.pcmSampleLength : this.pcmBuffer.length;
        const relativeStartTime = Math.max(0, this.transcribedUpTo - this.pcmBufferStartTime);
        const startSample = Math.floor(relativeStartTime * TARGET_SAMPLE_RATE);
        const endSample = Math.min(startSample + chunkSamples, availableSamples);
        if (endSample <= startSample) return;
        let chunk = this.pcmBuffer.subarray(startSample, endSample);

        // Wait for a complete live chunk. At end-of-track the final partial
        // chunk is padded below so short tracks are still transcribed.
        if (this.liveCaptureActive && !this.liveCaptureEnded && chunk.length < chunkSamples) return;

        // Skip silence
        if (settings.silenceThreshold > 0 && this.computeRms(chunk) < settings.silenceThreshold) {
            const availableSeconds = chunk.length / TARGET_SAMPLE_RATE;
            const isFinalAvailableChunk = endSample >= availableSamples
                && (!this.liveCaptureActive || this.liveCaptureEnded);
            if (isFinalAvailableChunk) this.transcribedUpTo = this.pcmDuration;
            else this.transcribedUpTo += Math.max(0.01, availableSeconds - overlapSec);
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
        this.sendChunk(chunk, this.transcribedUpTo, settings, priority, chunkLengthS, overlapSec);
        this.transcribedUpTo += chunkLengthS - overlapSec;
    }

    private getChunkStallTimeoutMs(settings: WhisperSettings): number {
        const scaledTimeout = Math.round(settings.chunkLengthS * 1000 * CHUNK_STALL_TIMEOUT_MULTIPLIER);
        const floorTimeout = DeviceCapabilities.profile.isMobile
            ? CHUNK_STALL_TIMEOUT_FLOOR_MS * 2
            : CHUNK_STALL_TIMEOUT_FLOOR_MS;
        const backendFloor = this.workerBackend === 'wasm' ? 130_000 : floorTimeout;
        return Math.max(backendFloor, scaledTimeout);
    }

    private checkForStalledChunks(settings: WhisperSettings): void {
        if (!this.transcribing || this.pendingChunks <= 0 || this.chunkSendTimes.size === 0) return;
        const timeoutMs = this.getChunkStallTimeoutMs(settings);
        const now = performance.now();
        let stalledChunkId: number | null = null;
        let stalledForMs = 0;

        for (const [chunkId, sentAt] of this.chunkSendTimes.entries()) {
            const lastActivity = this.chunkLastActivity.get(chunkId) ?? sentAt;
            const ageMs = now - lastActivity;
            if (ageMs > stalledForMs) {
                stalledForMs = ageMs;
                stalledChunkId = chunkId;
            }
        }

        if (stalledChunkId === null || stalledForMs < timeoutMs) return;
        this.recoverFromStalledChunks(settings, stalledChunkId, stalledForMs);
    }

    private recoverFromStalledChunks(settings: WhisperSettings, stalledChunkId: number, stalledForMs: number): void {
        const now = performance.now();
        if (now - this.lastChunkStallRecoveryAt < Whisper.CHUNK_STALL_RECOVERY_COOLDOWN_MS) return;
        this.lastChunkStallRecoveryAt = now;
        this.chunkStallRecoveryCount += 1;

        const queuedOffsets = Array.from(this.chunkOffsets.values());
        const earliestOffset = queuedOffsets.length > 0
            ? Math.min(...queuedOffsets)
            : Math.max(0, this.transcribedUpTo - SEEK_BACKFILL_SEC);
        const resumeFrom = Math.max(0, earliestOffset - SEEK_BACKFILL_SEC);

        Logger.warn('[Whisper] Chunk processing stalled; resetting worker', {
            stalledChunkId,
            stalledForMs: Math.round(stalledForMs),
            pendingChunks: this.pendingChunks,
            recoveries: this.chunkStallRecoveryCount,
            resumeFrom,
        });
        this.dispatchProgress(I18n.t('whisperRecovering'), 0, 'transcribing');

        if (this.chunkStallRecoveryCount > Whisper.MAX_CHUNK_STALL_RECOVERIES) {
            const message = I18n.t('whisperProcessingStalled');
            this.resetWorker('chunk-stall-terminal');
            this.stopTranscription('chunk-stall-terminal');
            AppStore.setWhisperState({
                isTranscribing: false,
                isLoadingModel: false,
                progress: 0,
                progressMessage: message,
            });
            this.showStatus(`<span class="whisper-error-indicator">${this.escapeHtml(message)}</span>`);
            return;
        }

        if (settings.model !== FALLBACK_MODEL) {
            this.modelOverride = FALLBACK_MODEL;
            EventBus.emit('whisper:fallback', {
                originalModel: settings.model,
                fallbackModel: FALLBACK_MODEL,
                reason: 'chunk-stall',
            });
        } else if (this.workerBackend !== 'wasm' && !this.shouldForceWasm()) {
            this.markWebgpuFailed('chunk-stall');
            EventBus.emit('webgpu:failed', { source: 'whisper' });
        }

        this.resetWorker('chunk-stall-timeout');
        this.clearChunkTracking({ resetRecovery: false, resetChunkCounter: false });
        // Don't rewind into regions we've already transcribed — existing segments
        // are still valid and re-processing creates duplicates.
        this.transcribedUpTo = Math.max(resumeFrom, this.lastSegmentEnd);
        this.modelReady = false;
        this.initWorker(this.getWhisperSettings());
    }

    private seekDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    private seekingRafId = 0;

    private handleSeek = (): void => {
        if (!this.audio) return;

        // Cancel any pending RAF to avoid stale updates
        if (this.seekingRafId) {
            cancelAnimationFrame(this.seekingRafId);
            this.seekingRafId = 0;
        }

        // Defer snapshot to next frame so audio.currentTime has synchronized with seek target.
        // During rapid scrubbing, the seeking event fires before currentTime updates, causing
        // subtitles to lag behind the scrubber position.
        this.seekingRafId = requestAnimationFrame(() => {
            this.seekingRafId = 0;
            this.emitWhisperSnapshot('seek');
        });

        if (this.seekDebounceTimer) {
            clearTimeout(this.seekDebounceTimer);
        }

        // Debounce the expensive work (queue flush, chunk processing) until scrub settles.
        this.seekDebounceTimer = setTimeout(() => {
            const seekTime = this.audio!.currentTime;
            Logger.debug('[Whisper] Seek settled:', seekTime.toFixed(2));

            if (this.liveCaptureActive) {
                // Captured PCM cannot bridge a discontinuous media timeline.
                // Drop the bounded window and generation-filter all queued work
                // before accepting samples from the seek destination.
                this.clearChunkTracking({ resetRecovery: true, resetChunkCounter: false });
                if (this.worker) this.worker.postMessage({ type: 'flush-queue' });
                this.resetLivePcmBuffer(seekTime);
                this.emitWhisperSnapshot('seek');
                this.maybeProcessNextChunk();
                this.seekDebounceTimer = null;
                return;
            }

            // Rewind processing window on backward scrubs, jump on forward scrubs.
            // Keep all existing segments — they're already transcribed correctly.
            // Only adjust the processing cursor so new chunks fill gaps.
            let cursorChanged = false;
            if (seekTime < this.transcribedUpTo - 0.25) {
                const newTarget = Math.max(0, seekTime - SEEK_BACKFILL_SEC);
                // Check if the seek lands in an untranscribed gap before the first segment.
                // If segments start at, say, 270s but user seeks to 10s, we must rewind
                // transcribedUpTo so the processing loop fills the 0-270s gap.
                const coverageStart = this.segments.length > 0 ? this.segments[0].start : Infinity;
                const isWithinCoverage = newTarget >= coverageStart - 2 && newTarget < this.lastSegmentEnd;
                if (isWithinCoverage) {
                    // Seek is within existing transcription coverage — no cursor change,
                    // no flush needed. Ahead-of-playhead chunks are still useful for LRC.
                } else {
                    // Gap detected — either before the first segment or past lastSegmentEnd.
                    // Rewind cursor to fill the untranscribed region.
                    this.transcribedUpTo = newTarget;
                    this.clearChunkTracking({ resetRecovery: true, resetChunkCounter: false });
                    // Flush stale jobs since queued chunks are from the old cursor position.
                    if (this.worker) this.worker.postMessage({ type: 'flush-queue' });
                    cursorChanged = true;
                    Logger.debug('[Whisper] Seek to untranscribed gap, rewinding cursor', {
                        seekTime: seekTime.toFixed(2),
                        newTarget: newTarget.toFixed(2),
                        coverageStart: coverageStart.toFixed(2),
                        lastSegmentEnd: this.lastSegmentEnd.toFixed(2),
                    });
                }
            } else if (seekTime > this.transcribedUpTo) {
                // Forward seek past processed territory — flush stale jobs so the
                // worker can start on chunks near the new playhead immediately.
                this.transcribedUpTo = seekTime;
                this.clearChunkTracking({ resetRecovery: true, resetChunkCounter: false });
                if (this.worker) this.worker.postMessage({ type: 'flush-queue' });
                cursorChanged = true;
            }

            // Only re-emit snapshot if cursor changed — for within-transcript seeks
            // the RAF already emitted the correct snapshot at the new playhead.
            if (cursorChanged) this.emitWhisperSnapshot('seek');
            this.maybeProcessNextChunk();
            this.seekDebounceTimer = null;
        }, 100);
    };

    private handlePause = (): void => {
        this.maybeProcessNextChunk();
    };

    private handlePlay = (): void => {
        // Refresh subtitle state after resume and continue processing loop naturally.
        if (this.liveCaptureActive) this.liveCaptureEnded = false;
        this.emitWhisperSnapshot('seek');
    };

    private handleEnded = (): void => {
        if (!this.transcribing) return;
        Logger.debug('[Whisper] Audio ended');
        if (this.liveCaptureActive) this.liveCaptureEnded = true;
        this.maybeProcessNextChunk();
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
            sourceLanguageHint: getWhisperSourceLanguageHint(this.getWhisperSettings().language),
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
        const worker = createWhisperWorker();
        this.worker = worker;
        worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
            if (this.worker !== worker) return;
            this.handleWorkerMessage(e);
        };
        this.maybeReenableWebgpu('ensure-worker');

        // Only skip WebGPU if it failed THIS session — don't inherit from translation's
        // cached dtype, as the issue may have been transient (driver/Chrome update).
        if (Whisper.webgpuFailed || this.shouldForceWasm()) {
            if (this.shouldForceWasm()) {
                Logger.debug('[Whisper] WebGPU disabled by policy (' + this.getWasmPolicyReason() + ')');
            }
            worker.postMessage({ type: 'skip-webgpu' });
        }
        worker.onerror = (e: ErrorEvent) => {
            if (this.worker !== worker) return;
            if (this.gpuCrashed) return; // Already showing crash UI
            const errObj = (e as ErrorEvent & { error?: unknown }).error;
            const errorMsg = e.message || (errObj instanceof Error ? errObj.message : '') || 'Unknown worker error';
            const isGpuError = this.isGpuErrorMessage(errorMsg);
            const isTerminalGpuFailure = /WebGPU is required|All WebGPU.*failed/i.test(errorMsg);
            const details = {
                message: errorMsg,
                filename: e.filename,
                lineno: e.lineno,
                colno: e.colno,
                error: errObj ? String(errObj) : undefined,
            };
            Logger.error('[Whisper] Worker error:', details);
            if (isGpuError || isTerminalGpuFailure) {
                const firstFailure = !Whisper.webgpuFailed;
                this.markWebgpuFailed(isTerminalGpuFailure ? 'terminal-worker-error' : 'worker-error');
                if (firstFailure) {
                    EventBus.emit('webgpu:failed', { source: 'whisper' });
                }
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

            // Count all GPU errors toward recovery limit
            if (isGpuError) {
                Whisper.gpuRecoveryAttempts++;
                if (Whisper.gpuRecoveryAttempts > Whisper.MAX_GPU_RECOVERY) {
                    Logger.error(`[Whisper] GPU recovery failed after ${Whisper.MAX_GPU_RECOVERY} attempts, giving up`);
                    this.gpuCrashed = true;
                    const crashMsg = I18n.t('whisperGpuCrashed');
                    AppStore.setWhisperState({ isTranscribing: false, isLoadingModel: false, progress: 0, progressMessage: crashMsg });
                    this.showStatus(`<span class="whisper-error-indicator whisper-crash-persistent">${this.escapeHtml(crashMsg)}</span>`);
                    return;
                }
            }

            // Auto-recover from GPU errors: create a fresh worker on WASM
            if (isGpuError && wasTranscribing) {
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
                        Logger.warn('[Whisper] Auto-recovery skipped (audio paused) — showing crash message');
                        this.gpuCrashed = true;
                        const crashMsg = I18n.t('whisperGpuCrashed');
                        AppStore.setWhisperState({ isTranscribing: false, isLoadingModel: false, progress: 0, progressMessage: crashMsg });
                        this.showStatus(`<span class="whisper-error-indicator whisper-crash-persistent">${this.escapeHtml(crashMsg)}</span>`);
                    }
                }, 2000);
            } else {
                this.dispatchError(I18n.format('whisperWorkerError', { message: errorMsg }));
            }
        };
        Logger.debug('[Whisper] Worker created');
    }

    private settleWorkerInitSentinel(): void {
        if (!this.workerInitPending) return;
        // CrashGuard's negative sentinel is only meant to survive a hard page/
        // process crash. Any reset reached in this process is a handled outcome
        // and must not accumulate toward a future false auto-disable.
        MLCrashGuard.initComplete('whisper');
        this.workerInitPending = null;
    }

    private resetWorker(reason: string): void {
        this.releaseLoadLease();
        this.clearModelLoadTimer();
        this.workerInitGeneration++;
        this.settleWorkerInitSentinel();
        if (this.worker) {
            const dyingWorker = this.worker;
            // Invalidate and detach synchronously. The reset message is allowed
            // a short cleanup window, but late ready/error events from this
            // worker must not affect a replacement worker or a re-enabled run.
            this.worker = null;
            dyingWorker.onmessage = null;
            dyingWorker.onerror = null;
            // Send reset so worker can dispose GPU pipeline before we kill it
            try { dyingWorker.postMessage({ type: 'reset' }); } catch { /* ignore */ }
            setTimeout(() => { try { dyingWorker.terminate(); } catch { /* ignore */ } }, 500);
        }
        // Clear timers that reference the dead worker
        if (this.gpuRecoveryTimer) { clearTimeout(this.gpuRecoveryTimer); this.gpuRecoveryTimer = null; }
        if (this.errorDismissTimer) { clearTimeout(this.errorDismissTimer); this.errorDismissTimer = null; }
        this.modelLoadingKey = '';
        this.modelReady = false;
        this.workerBackend = null;
        this.clearChunkTracking({ resetRecovery: false, resetChunkCounter: false });
        Logger.warn('[Whisper] Worker reset:', reason);
    }

    private initWorker(settings: WhisperSettings): void {
        if (this.gpuCrashed) {
            if (Whisper.crashRecoveries >= Whisper.MAX_CRASH_RECOVERIES) {
                Logger.warn('[Whisper] initWorker blocked — too many GPU crash recoveries this session');
                return;
            }
            Whisper.crashRecoveries++;
            Logger.warn(`[Whisper] Clearing GPU crash state for worker init (attempt ${Whisper.crashRecoveries}/${Whisper.MAX_CRASH_RECOVERIES})`);
            this.gpuCrashed = false;
            this.maybeReenableWebgpu('init-worker');
        }
        this.ensureWorker();
        const worker = this.worker;
        if (!worker) return;
        if (this.modelReady) {
            Logger.debug('[Whisper] Reusing ready model on current worker');
            return;
        }
        if (this.workerInitPending?.worker === worker) {
            Logger.debug('[Whisper] Reusing in-flight model initialization');
            return;
        }

        MLCrashGuard.initStarted('whisper');
        const initGeneration = ++this.workerInitGeneration;
        this.workerInitPending = { worker, generation: initGeneration };
        this.modelReady = false;
        this.dispatchProgress(I18n.t('whisperLoading'), 5, 'model');

        // Acquire a load lease from GpuScheduler to prevent concurrent model loading.
        // Only one worker loads a model at a time (requestAdapter + requestDevice + ONNX compile).
        // The lease is released when the worker reports 'ready' or on error/reset.
        this.releaseLoadLease(); // Release any stale lease from a previous init attempt
        GpuScheduler.acquireLoadLease('whisper').then(release => {
            if (!this.enabled || this.worker !== worker || this.workerInitGeneration !== initGeneration) {
                // Worker was terminated while waiting for lease
                release();
                if (this.workerInitPending?.generation === initGeneration) {
                    this.settleWorkerInitSentinel();
                }
                return;
            }
            this.loadLeaseRelease = release;
            // No timeout - large models can take a while to download
            worker.postMessage({
                type: 'init',
                model: settings.model,
                multilingual: settings.multilingual,
                subtask: settings.subtask,
                language: settings.language,
                chunkLengthS: settings.chunkLengthS,
                strideLengthS: settings.strideLengthS,
                preferLowPowerAdapter: settings.preferLowPowerAdapter,
                minWebgpuBufferBytes: settings.minWebgpuBufferBytes,
                gpuVendorHint: DeviceCapabilities.profile.gpuVendor,
            });
            this.armModelLoadTimer(settings, initGeneration);
        }).catch(error => {
            if (this.workerInitPending?.generation === initGeneration) {
                this.settleWorkerInitSentinel();
            }
            Logger.error('[Whisper] Failed to acquire model load lease:', error);
            if (this.worker === worker) {
                this.releaseLoadLease();
                this.dispatchError(I18n.format('whisperWorkerError', {
                    message: error instanceof Error ? error.message : String(error),
                }));
            }
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

    private armModelLoadTimer(settings: WhisperSettings, initGeneration = this.workerInitGeneration): void {
        this.clearModelLoadTimer();
        this.modelLoadTimer = window.setTimeout(() => {
            if (this.modelReady || !this.worker || initGeneration !== this.workerInitGeneration) return;
            this.handleModelLoadStall(settings);
        }, MODEL_LOAD_STALL_TIMEOUT_MS);
    }

    private handleModelLoadStall(settings: WhisperSettings): void {
        Logger.warn('[Whisper] Model load stalled; applying bounded fallback', {
            model: settings.model,
            backend: this.workerBackend,
        });

        if (settings.model !== FALLBACK_MODEL) {
            this.modelOverride = FALLBACK_MODEL;
            EventBus.emit('whisper:fallback', {
                originalModel: settings.model,
                fallbackModel: FALLBACK_MODEL,
                reason: 'model-load-timeout',
            });
            this.dispatchProgress(I18n.format('whisperFallbackModel', {
                model: FALLBACK_MODEL.split('/').pop() || FALLBACK_MODEL,
            }), 10, 'model');
            this.resetWorker('model-load-timeout-smaller-model');
            this.initWorker(this.getWhisperSettings());
            return;
        }

        if (this.workerBackend !== 'wasm' && !this.shouldForceWasm()) {
            this.markWebgpuFailed('model-load-timeout');
            EventBus.emit('webgpu:failed', { source: 'whisper' });
            this.resetWorker('model-load-timeout-wasm');
            this.initWorker(this.getWhisperSettings());
            return;
        }

        const message = I18n.t('whisperModelLoadStalled');
        const wasTranscribing = this.transcribing;
        this.resetWorker('model-load-timeout-terminal');
        if (wasTranscribing) this.stopTranscription('model-load-timeout');
        AppStore.setWhisperState({
            isTranscribing: false,
            isLoadingModel: false,
            progress: 0,
            progressMessage: message,
        });
        this.showStatus(`<span class="whisper-error-indicator">${this.escapeHtml(message)}</span>`);
    }

    private sendChunk(
        audio: Float32Array,
        timeOffset: number,
        settings: WhisperSettings,
        priority = 0,
        chunkLengthS = settings.chunkLengthS,
        strideLengthS = settings.strideLengthS,
    ): void {
        if (!this.worker) return;
        const chunkId = this.nextChunkId++;
        this.pendingChunks++;
        const sentAt = performance.now();
        this.chunkSendTimes.set(chunkId, sentAt);
        this.chunkLastActivity.set(chunkId, sentAt);
        this.chunkOffsets.set(chunkId, timeOffset);
        this.chunkGenerations.set(chunkId, this.transcriptionGeneration);
        Logger.debug(`[Whisper] Sending chunk ${chunkId}, offset=${timeOffset.toFixed(2)}s, priority=${priority}, samples=${audio.length}`);
        this.worker!.postMessage({
            type: 'transcribe',
            audio,
            model: settings.model,
            multilingual: settings.multilingual,
            subtask: settings.subtask,
            language: settings.language,
            timeOffset,
            chunkLengthS,
            strideLengthS,
            chunkId,
            priority,
            updateIntervalMs: settings.workerUpdateIntervalMs,
        });
    }

    private handleWorkerMessage(e: MessageEvent<WorkerMessage>): void {
        const message = e.data;

        switch (message.status) {
            case 'initiate':
                if (message.backend) {
                    this.workerBackend = message.backend === 'wasm' ? 'wasm' : 'webgpu';
                    this.armModelLoadTimer(this.getWhisperSettings());
                    Logger.debug(`[Whisper] Worker backend: ${message.backend}${message.vendor ? ` (${message.vendor})` : ''}`);
                    if (message.backend === 'wasm') {
                        Logger.warn('[Whisper] Worker using WASM backend (WebGPU unavailable on this device)');
                    }
                }
                break;

            case 'ready':
                // Model ready - clear loading status and hide transcribing indicator
                this.settleWorkerInitSentinel();
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
                if (this.transcribing && this.pcmBuffer) {
                    this.maybeProcessNextChunk();
                }
                break;

            case 'progress': {
                if (this.modelReady) return;
                this.armModelLoadTimer(this.getWhisperSettings());
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
                this.modelOverride = fallback.fallbackModel;
                this.armModelLoadTimer(this.getWhisperSettings());
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
                Whisper.crashRecoveries = 0;
                GpuScheduler.onGpuSuccess('whisper');
                const update = message as WorkerUpdateMessage;
                if (!this.isCurrentChunkMessage(update.chunkId)) return;
                this.markChunkActivity(update.chunkId);
                // Worker sends raw chunks; host does hallucination filtering + grouping
                const processed = processRawChunks(update.data?.rawChunks);
                const segments = this.parseSegments(processed);
                this.mergeSegments(segments, { preferNew: false });
                this.logNewTranscriptSegments('update');
                this.updateTranscribingProgress();
                const latest = this.segments[this.segments.length - 1];
                EventBus.emit('whisper:update', {
                    text: latest?.text || '',
                    segments: [...this.segments],
                    final: false,
                    sourceLanguageHint: getWhisperSourceLanguageHint(this.getWhisperSettings().language),
                    chunkIndex: update.chunkId,
                    live: true,
                    source: 'update',
                });
                // Pre-translate new segments during progressive updates (throttled to 5s).
                // Without this, translations only fire on 'complete' (every ~30s chunk),
                // leaving live subtitles untranslated until the chunk finishes.
                if (this.segments.length > 0) {
                    const now = Date.now();
                    if (now - this.lastTranslateAheadAt > 5000) {
                        this.lastTranslateAheadAt = now;
                        void this.translateAhead();
                    }
                }
                break;
            }

            case 'complete': {
                if (!this.transcribing) return;
                const complete = message as WorkerCompleteMessage;
                if (!this.isCurrentChunkMessage(complete.chunkId)) return;
                this.dropChunk(complete.chunkId);
                this.markChunkActivity();
                // Worker sends raw chunks + fullText; host processes
                const fullText = complete.data?.text;
                const processed = processRawChunks(complete.data?.rawChunks, fullText);
                const segments = this.parseSegments(processed);
                Logger.debug(`[Whisper] Complete chunk ${complete.chunkId}: ${segments.length} segments, text="${fullText?.slice(0, 50)}"`);
                const chunkText = String(fullText || '').trim();
                if (chunkText) {
                    Logger.log(`[Whisper][Chunk ${complete.chunkId}] ${chunkText}`);
                }
                this.mergeSegments(segments, { preferNew: true });
                this.logNewTranscriptSegments('complete');
                this.updateTranscribingProgress();
                const latest = this.segments[this.segments.length - 1];
                EventBus.emit('whisper:update', {
                    text: latest?.text || fullText || '',
                    segments: [...this.segments],
                    final: this.pendingChunks === 0,
                    sourceLanguageHint: getWhisperSourceLanguageHint(this.getWhisperSettings().language),
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
                // The WebGPU device is dead, but a fresh worker can continue on
                // the bounded WASM/smaller-model path.
                this.releaseLoadLease();
                const deviceLostMsg = message.data?.message || 'GPU device lost';
                Logger.error('[Whisper] Fatal GPU device loss:', deviceLostMsg);
                this.gpuCrashed = true;
                EventBus.emit('gpu:device-lost', { worker: 'whisper' as const });
                const firstFailure = !Whisper.webgpuFailed;
                this.markWebgpuFailed('gpu-device-lost');
                if (firstFailure) {
                    EventBus.emit('webgpu:failed', { source: 'whisper' });
                }

                const wasTranscribing = this.transcribing;
                if (wasTranscribing) this.stopTranscription('gpu-device-lost');
                this.resetWorker('gpu-device-lost');

                const audio = getAudioElement();
                if (wasTranscribing && audio && !audio.paused) {
                    this.modelOverride = FALLBACK_MODEL;
                    this.showStatus(`<span class="whisper-status-text">${this.escapeHtml(I18n.t('whisperRecovering'))}</span>`);
                    window.setTimeout(() => {
                        this.startTranscription().catch((error) => {
                            Logger.error('[Whisper] WASM recovery after device loss failed', error);
                        });
                    }, 250);
                } else {
                    const crashMsg = I18n.t('whisperGpuCrashed');
                    AppStore.setWhisperState({
                        isTranscribing: false,
                        isLoadingModel: false,
                        progress: 0,
                        progressMessage: crashMsg,
                    });
                    this.showStatus(`<span class="whisper-error-indicator">${this.escapeHtml(crashMsg)}</span>`);
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
                const errorChunkId = (message as WorkerErrorMessage).chunkId;
                if (typeof errorChunkId === 'number') {
                    this.dropChunk(errorChunkId);
                }
                const requestedGpuFallback = (message as WorkerErrorMessage).data?.gpuFallback === true;
                const isInferenceTimeout = /inference timed out/i.test(errMsg);
                const isGpuError = this.isGpuErrorMessage(errMsg) || requestedGpuFallback;
                const isWebgpuInferenceTimeout = isInferenceTimeout
                    && requestedGpuFallback
                    && this.workerBackend !== 'wasm';
                // "WebGPU is required" means worker tried WebGPU, it failed, but WASM
                // fallback is disabled. This is a terminal GPU failure — do NOT retry.
                const isWebgpuRequiredError = /WebGPU is required/i.test(errMsg);
                // "All WebGPU.*failed" means every dtype candidate was exhausted.
                const isAllGpuFailed = /All WebGPU.*failed/i.test(errMsg);
                const isTerminalGpuFailure = isWebgpuRequiredError || isAllGpuFailed;
                const isExplicitDeviceLoss = this.isExplicitDeviceLossMessage(errMsg);

                if (isGpuError || isTerminalGpuFailure) {
                    // An uncancellable WebGPU inference timeout leaves that
                    // worker/pipeline wedged. Restart once on tiny/WASM instead
                    // of immediately retrying the same backend.
                    if (!isInferenceTimeout || isWebgpuInferenceTimeout) {
                        const firstFailure = !Whisper.webgpuFailed;
                        this.markWebgpuFailed(isTerminalGpuFailure
                            ? 'terminal-worker-message'
                            : isWebgpuInferenceTimeout ? 'webgpu-inference-timeout' : 'worker-message');
                        if (isWebgpuInferenceTimeout) this.modelOverride = FALLBACK_MODEL;
                        if (firstFailure) {
                            EventBus.emit('webgpu:failed', { source: 'whisper' });
                        }
                        if (isExplicitDeviceLoss || isTerminalGpuFailure) {
                            // Broadcast only on explicit/terminal device-loss class failures.
                            EventBus.emit('gpu:device-lost', { worker: 'whisper' as const });
                            Logger.warn('[Whisper] GPU failure — broadcasting device-lost:', errMsg);
                        } else {
                            Logger.warn('[Whisper] Recoverable GPU failure — keeping device-loss local:', errMsg);
                        }
                    } else {
                        Logger.warn('[Whisper] Inference timeout on bounded fallback backend:', errMsg);
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

                // Count all GPU errors toward recovery limit — queued messages from
                // a terminated worker arrive with wasTranscribing=false, but still
                // indicate the GPU is dead and should count toward the limit.
                if (isGpuError) {
                    Whisper.gpuRecoveryAttempts++;
                    if (Whisper.gpuRecoveryAttempts > Whisper.MAX_GPU_RECOVERY) {
                        Logger.error(`[Whisper] GPU recovery failed after ${Whisper.MAX_GPU_RECOVERY} attempts, giving up`);
                        this.gpuCrashed = true;
                        if (this.gpuRecoveryTimer) { clearTimeout(this.gpuRecoveryTimer); this.gpuRecoveryTimer = null; }
                        const crashMsg = I18n.t('whisperGpuCrashed');
                        AppStore.setWhisperState({ isTranscribing: false, isLoadingModel: false, progress: 0, progressMessage: crashMsg });
                        this.showStatus(`<span class="whisper-error-indicator whisper-crash-persistent">${this.escapeHtml(crashMsg)}</span>`);
                        if (this.errorDismissTimer) { clearTimeout(this.errorDismissTimer); this.errorDismissTimer = null; }
                        break;
                    }
                }

                // Auto-recover from GPU errors: create a fresh worker on WASM.
                // Cached segments are preserved by stopTranscription, and startTranscription
                // will resume from where we left off via cache continuation logic.
                if (isGpuError && wasTranscribing) {
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
                            // Audio paused — show persistent crash message instead of silently giving up
                            Logger.warn('[Whisper] Auto-recovery skipped (audio paused) — showing crash message');
                            this.gpuCrashed = true;
                            const crashMsg = I18n.t('whisperGpuCrashed');
                            AppStore.setWhisperState({ isTranscribing: false, isLoadingModel: false, progress: 0, progressMessage: crashMsg });
                            this.showStatus(`<span class="whisper-error-indicator whisper-crash-persistent">${this.escapeHtml(crashMsg)}</span>`);
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
        this.logNewTranscriptSegments('final');
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

    private transcriptLogKey(seg: WhisperSegment): string {
        const start = Number.isFinite(seg.start) ? Math.round(seg.start * 100) : -1;
        const end = Number.isFinite(seg.end) ? Math.round(seg.end * 100) : -1;
        return `${start}|${end}|${seg.text}`;
    }

    private logNewTranscriptSegments(source: 'update' | 'complete' | 'final' | 'cache'): void {
        for (const seg of this.segments) {
            const key = this.transcriptLogKey(seg);
            if (this.loggedTranscriptKeys.has(key)) continue;
            this.loggedTranscriptKeys.add(key);

            const start = Number.isFinite(seg.start) ? seg.start.toFixed(2) : '?';
            const end = Number.isFinite(seg.end) ? seg.end.toFixed(2) : '?';
            const line = `[Whisper][Transcript][${source}] [${start}-${end}s] ${seg.text}`;
            Logger.log(line);
            // Keep transcript visibility even when debug logging is disabled.
            console.log(line);

            // Log word timings if available
            if (seg.words && seg.words.length > 0) {
                const wordTimings = seg.words.map(w =>
                    `${w.text}(${w.start.toFixed(1)}-${w.end.toFixed(1)})`
                ).join(' ');
                Logger.debug(`[Whisper][Words] ${wordTimings}`);
            }
        }
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

        for (const rawSeg of newSegments) {
            if (!rawSeg.text || this.isNoiseOnly(rawSeg.text)) continue;

            // Match by start time first (same-chunk update → complete).
            // A short chunk-boundary fragment (e.g. 0.5s "はい") must not match
            // and replace a long cached segment (e.g. 8s full sentence).
            const matchIdx = this.segments.findIndex(existing => {
                if (Math.abs(existing.start - rawSeg.start) >= 0.3) return false;
                const eDur = existing.end - existing.start;
                const nDur = rawSeg.end - rawSeg.start;
                if (eDur > 1 && nDur > 0 && nDur / eDur < 0.3) return false;
                return true;
            });

            if (matchIdx >= 0) {
                const existing = this.segments[matchIdx];
                const existingText = existing.text.trim();
                const nextText = rawSeg.text.trim();
                if ((preferNew || nextText.length >= existingText.length) && this.isSignificantUpdate(existingText, nextText)) {
                    // Guard: don't replace a long segment with much shorter text
                    // (chunk-boundary overlap can produce truncated re-transcriptions)
                    if (existingText.length <= 4 || nextText.length >= existingText.length * 0.5) {
                        this.segments[matchIdx] = rawSeg;
                    }
                }
                this.lastSegmentEnd = Math.max(this.lastSegmentEnd, rawSeg.end, existing.end);
                continue;
            }

            // ── Clip new segment to avoid overlapping with existing segments ──
            // Whisper chunks overlap by design (stride); the overlap region gets
            // re-transcribed with different text.  Prefer the earlier chunk's text
            // (already displayed) and only keep the non-overlapping portion.
            let seg: WhisperSegment = rawSeg;
            let clipTo = rawSeg.start;
            for (const existing of this.segments) {
                if (existing.start < rawSeg.end && existing.end > rawSeg.start) {
                    clipTo = Math.max(clipTo, existing.end);
                }
            }
            if (clipTo > rawSeg.start) {
                const clipped = this.clipSegmentStart(rawSeg, clipTo);
                if (!clipped) {
                    this.lastSegmentEnd = Math.max(this.lastSegmentEnd, rawSeg.end);
                    continue; // fully overlapped — skip
                }
                seg = clipped;
            }

            // Don't push fragments that are temporally contained within a
            // much longer existing segment (chunk-boundary overlap artifacts).
            const isContained = this.segments.some(existing => {
                const eDur = existing.end - existing.start;
                const nDur = seg.end - seg.start;
                return eDur > nDur * 2
                    && seg.start >= existing.start - 0.5
                    && seg.end <= existing.end + 0.5;
            });
            if (isContained) {
                this.lastSegmentEnd = Math.max(this.lastSegmentEnd, seg.end);
                continue;
            }

            // Reverse containment: remove existing shorter segments that the
            // new (longer) segment fully contains. This handles the case where
            // a short fragment was added first, then a longer chunk arrives later
            // covering the same audio region.
            const nDur = seg.end - seg.start;
            if (nDur > 2) {
                for (let i = this.segments.length - 1; i >= 0; i--) {
                    const existing = this.segments[i];
                    const eDur = existing.end - existing.start;
                    if (nDur > eDur * 2
                        && existing.start >= seg.start - 0.5
                        && existing.end <= seg.end + 0.5) {
                        this.segments.splice(i, 1);
                    }
                }
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
                    const prevDur = prev.end - prev.start;
                    const segDur = seg.end - seg.start;
                    // Duration mismatch: keep the longer segment (drop the fragment)
                    if (prevDur > 1 && segDur > 0 && segDur / prevDur < 0.3) {
                        continue; // drop seg (fragment), keep prev
                    }
                    if (segDur > 1 && prevDur > 0 && prevDur / segDur < 0.3) {
                        deduped[deduped.length - 1] = seg; // replace prev (fragment) with seg
                        continue;
                    }
                    const prevText = prev.text.trim();
                    const segText = seg.text.trim();
                    if (this.isSignificantUpdate(prevText, segText) && (segText.length > prevText.length || preferNew)) {
                        // Guard: don't replace with much shorter text (chunk-boundary artifact)
                        if (prevText.length <= 4 || segText.length >= prevText.length * 0.5) {
                            deduped[deduped.length - 1] = seg;
                        }
                    }
                    continue;
                }
                if (prev && this.shouldCollapseAdjacentDuplicate(prev, seg)) {
                    const prevText = prev.text.trim();
                    const segText = seg.text.trim();
                    if ((preferNew || segText.length >= prevText.length) && (prevText.length <= 4 || segText.length >= prevText.length * 0.5)) {
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

        // Final summary
        if (newSegments.length > 0) {
            Logger.debug(
                `[Whisper] Merge complete: ${this.segments.length} total segments, ` +
                `${this.lastSegmentEnd.toFixed(1)}s transcribed`
            );
        }
    }

    /**
     * Clip a segment's start to `clipTo`, removing words that fall before
     * the clip point.  Returns null if the entire segment is clipped away.
     */
    private clipSegmentStart(seg: WhisperSegment, clipTo: number): WhisperSegment | null {
        if (clipTo >= seg.end) return null;

        if (seg.words && seg.words.length > 0) {
            // Keep words whose end extends past the clip point
            const keptWords = seg.words.filter(w => w.end > clipTo);
            if (keptWords.length === 0) return null;

            const isCJK = /[\u3040-\u30ff\u4e00-\u9fff]/.test(keptWords[0].text);
            const joinChar = isCJK ? '' : ' ';
            return {
                ...seg,
                start: Math.max(clipTo, keptWords[0].start),
                text: keptWords.map(w => w.text).join(joinChar).trim(),
                words: keptWords,
            };
        }

        // No word timestamps — just adjust start time
        return { ...seg, start: clipTo };
    }

    private wordTimestampDiagLogged = false;

    private applyLanguageAwareCorrections(text: string): string {
        const language = this.getWhisperSettings().language;
        // The glossary is Japanese-specific and contains replacements that are
        // valid Chinese vocabulary. Never run it for explicit Chinese/other
        // sources, or for auto-detected Han-only Chinese output.
        if (language && language !== 'japanese') return text;
        if (!language && isChinese(text)) return text;
        return correctWhisperText(text);
    }

    private parseSegments(raw: ChunkEntry[] | ProcessedSegment[] | undefined): WhisperSegment[] {
        if (!raw) return [];
        const segments: WhisperSegment[] = [];
        let realWordCount = 0;
        let fallbackWordCount = 0;
        for (const item of raw) {
            const text = this.applyLanguageAwareCorrections(this.cleanText(item.text || ''));
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
            const rawWords = item.words as ChunkWordEntry[] | undefined;
            if (rawWords && rawWords.length > 0) {
                words = rawWords
                    .filter(w => w.text && w.start != null)
                    .map(w => ({
                        text: w.text.trim(),
                        start: Number(w.start),
                        end: Number(w.end ?? w.start),
                    }));
                if (words.length === 0) words = undefined;
                else realWordCount++;
            }
            // Fallback: linear interpolation when no real word timestamps
            if (!words) {
                fallbackWordCount++;
                const fallback = this.buildWordTimings(text, safeStart, safeEnd);
                words = fallback.length ? fallback : undefined;
            }

            segments.push({ start: safeStart, end: safeEnd, text, words });
        }
        if (!this.wordTimestampDiagLogged && segments.length > 0) {
            this.wordTimestampDiagLogged = true;
            Logger.log(`[Whisper] Word timestamps: ${realWordCount} real, ${fallbackWordCount} fallback (of ${segments.length} segments)`);
            if (realWordCount > 0) {
                const sample = segments.find(s => s.words && s.words.length > 1);
                if (sample) {
                    Logger.log(`[Whisper] Sample word timestamps: "${sample.text.slice(0, 30)}" → ${sample.words!.slice(0, 3).map(w => `"${w.text}"@${w.start.toFixed(2)}-${w.end.toFixed(2)}`).join(', ')}`);
                }
            }
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

    /** Whisper-generated non-speech annotations that should be dropped. */
    private static readonly NOISE_RE = /^\s*[\[\]()（）「」]*\s*(?:音楽|音乐|音樂|拍手|掌声|掌聲|笑声|笑聲|哭声|哭聲|叹气|嘆氣|静音|靜音|効果音|music|laughter|applause|silence|inaudible|noise|ドラゴンの音|スタッフ|谢谢观看|謝謝觀看|请订阅|請訂閱|下次见|下次見)\s*[\[\]()（）「」.!。！]*\s*$/i;

    private isNoiseOnly(text: string): boolean {
        return Whisper.NOISE_RE.test(text);
    }

    // ------------------------------------------------------------------------
    // Cache handling
    // ------------------------------------------------------------------------

    /**
     * Check cache for a track and emit whisper:update immediately if found.
     * Called from handleTrackChange() to avoid the 500ms scheduleAutoStart delay
     * for cached transcripts — LearnerSubtitles can render in the same microtask.
     */
    private emitCachedSnapshotIfAvailable(src: string): void {
        const settings = this.getWhisperSettings();
        if (!settings.cacheTranscripts) return;

        const identity = this.buildCacheIdentity(src, settings);
        const key = this.buildCacheKey(src, settings);
        const cached = SharedCache.get<CachedTranscript>(key);
        if (!cached?.segments?.length) return;

        // Verify identity (collision check) — old entries without sourceIdentity are accepted
        if (cached.sourceIdentity && cached.sourceIdentity !== identity) return;

        // Apply hallucination corrections (same as startTranscription cache path)
        for (const seg of cached.segments) {
            const corrected = this.applyLanguageAwareCorrections(seg.text);
            if (corrected !== seg.text) seg.text = corrected;
        }

        // Pre-populate Whisper state so startTranscription() finds segments ready
        this.segments = cached.segments;
        this.lastSegmentEnd = cached.segments[cached.segments.length - 1]?.end || 0;
        this.currentCacheKey = key;
        this.currentCacheIdentity = identity;

        const latest = cached.segments[cached.segments.length - 1];
        EventBus.emit('whisper:update', {
            text: latest?.text || cached.text,
            segments: cached.segments,
            final: !!cached.complete,
            sourceLanguageHint: getWhisperSourceLanguageHint(settings.language),
            fromCache: true,
            live: false,
            source: 'cache',
        });
        Logger.debug('[Whisper] Emitted cached snapshot immediately on track change');
    }

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
        const trackKey = track?.hash || this.resolveTrackUrl(track) || this.currentTrackSrc || '';
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
        const sourceLang = normalizeLanguageCode(settings.language);
        if ((!translateMode && !cnToJp) || !targetLang || targetLang === sourceLang) return;

        const cacheKey = this.currentCacheKey;
        if (!cacheKey || this.translationInFlight.has(`${cacheKey}:${targetLang}`)) return;
        if (payload.translations?.[targetLang]) return;
        this.translationInFlight.add(`${cacheKey}:${targetLang}`);
        try {
            const texts = payload.segments.map((seg) => seg.text);
            const translatable = payload.segments
                .map((seg, index) => ({ text: seg.text, index }))
                .filter(({ text }) => this.shouldTranslateText(text, targetLang, settings));
            if (translatable.length === 0) return;
            const transcriptKey = `whisper:transcript:${cacheKey}:${targetLang}`;
            const translatedSubset = await TranslationService.translateBatch(translatable.map(item => item.text), targetLang, {
                preserveRequestedTarget: true,
                priority: Priority.NORMAL,
                cancellable: true,
                cancellableKey: transcriptKey,
                sourceLanguageHint: sourceLang || 'auto',
            });
            const translated = [...texts];
            translatable.forEach((item, index) => {
                translated[item.index] = translatedSubset[index] || item.text;
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
            if (targetLang !== 'ja' && (sourceLang === '' || sourceLang === 'zh')) {
                const cnTexts = texts.filter(t =>
                    /[\u4e00-\u9fff]/.test(t) && !/[\u3040-\u309f\u30a0-\u30ff]/.test(t)
                );
                if (cnTexts.length > 0) {
                    TranslationService.translateBatch(cnTexts, 'ja', {
                        priority: Priority.NORMAL,
                        cancellable: true,
                        cancellableKey: `${transcriptKey}:ja`,
                        sourceLanguageHint: 'zh',
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
        const sourceLang = normalizeLanguageCode(settings.language);
        if ((!translateMode && !cnToJp) || !targetLang || targetLang === sourceLang) return;
        const generation = ++this.translationGeneration;
        const cacheIdentity = this.currentCacheIdentity;

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
        for (const key of this.activeTranslationQueueKeys) {
            TranslationService.cancelPending({ cancellableKey: key });
        }
        this.activeTranslationQueueKeys = new Set([aheadKey, jaAheadKey]);

        // Use translateBatch() for bulk throughput — a single batch call is far faster than
        // N individual translate() calls (one GpuScheduler task vs N serialized tasks for local;
        // better request packing for remote).
        const primarySegments = selected.filter(seg => this.shouldTranslateText(seg.text, targetLang, settings));
        const texts = primarySegments.map(seg => seg.text);
        let primaryPromise: Promise<string[]> | null = null;

        if (texts.length > 0) {
            primaryPromise = TranslationService.translateBatch(texts, targetLang, {
                preserveRequestedTarget: true,
                priority: Priority.HIGH,
                cancellable: true,
                cancellableKey: aheadKey,
                sourceLanguageHint: sourceLang || 'auto',
            });
        }

        // Also pre-translate Chinese segments to 'ja' for LearnerMode primary display
        // (LearnerMode shows JA as primary line when source is Chinese)
        let jaPromise: Promise<string[]> | null = null;
        if (targetLang !== 'ja' && (sourceLang === '' || sourceLang === 'zh')) {
            const cnTexts = selected
                .filter(seg => /[\u4e00-\u9fff]/.test(seg.text) && !/[\u3040-\u309f\u30a0-\u30ff]/.test(seg.text))
                .map(seg => seg.text);
            if (cnTexts.length > 0) {
                jaPromise = TranslationService.translateBatch(cnTexts, 'ja', {
                        priority: Priority.HIGH,
                        cancellable: true,
                        cancellableKey: jaAheadKey,
                        sourceLanguageHint: 'zh',
                    });
            }
        }

        const [primaryResult, jaResult] = await Promise.all([
            primaryPromise ? primaryPromise.catch(() => null) : Promise.resolve<string[] | null>([]),
            jaPromise ? jaPromise.catch(() => null) : Promise.resolve<string[] | null>([]),
        ]);
        if (generation !== this.translationGeneration || cacheIdentity !== this.currentCacheIdentity) return;

        const primarySucceeded = primaryPromise === null || (
            primaryResult !== null
            && primaryResult.length === texts.length
            && primaryResult.every((translated, index) => !!translated && translated !== texts[index])
        );
        const jaTexts = sourceLang === '' || sourceLang === 'zh'
            ? selected
                .filter(seg => /[\u4e00-\u9fff]/.test(seg.text) && !/[\u3040-\u309f\u30a0-\u30ff]/.test(seg.text))
                .map(seg => seg.text)
            : [];
        const jaSucceeded = jaPromise === null || (
            jaResult !== null
            && jaResult.length === jaTexts.length
            && jaResult.every((translated, index) => !!translated && translated !== jaTexts[index])
        );
        // Do not advance the retry cursor when either requested translation lane
        // fell back to source text. This is especially important for Chinese
        // source + Chinese UI, where only the auxiliary CN->JA lane is needed.
        if (!primarySucceeded || !jaSucceeded) return;

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

    private shouldTranslateText(text: string, targetLang: string, settings: WhisperSettings): boolean {
        const target = normalizeLanguageCode(targetLang);
        const configuredSource = normalizeLanguageCode(settings.language);
        if (configuredSource) return configuredSource !== target;
        if (target === 'zh' && isChinese(text)) return false;
        if (target === 'ja' && /[\u3040-\u30ff]/.test(text)) return false;
        if (target === 'en' && /[a-z]/i.test(text) && !/[\u3040-\u30ff\u4e00-\u9fff]/.test(text)) return false;
        return true;
    }

    private resetTranslationAheadState(): void {
        this.translationGeneration++;
        for (const key of this.activeTranslationQueueKeys) {
            TranslationService.cancelPending({ cancellableKey: key });
        }
        this.activeTranslationQueueKeys.clear();
        this.lastTranslatedSegmentCount = 0;
        this.translateAheadUpTo = 0;
        this.lastTranslateAheadAt = 0;
    }

    // ------------------------------------------------------------------------
    // Settings
    // ------------------------------------------------------------------------

    private getWhisperSettings(): WhisperSettings {
        const profile = DeviceCapabilities.profile;
        const memoryPressure = GpuScheduler.getMemoryPressure();
        const forceWasm = this.shouldForceWasm();

        let maxPendingChunks = DEFAULT_MAX_PENDING_CHUNKS;
        let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
        let workerUpdateIntervalMs = DEFAULT_WORKER_UPDATE_INTERVAL_MS;
        let preferLowPowerAdapter = false;
        let minWebgpuBufferBytes = DEFAULT_MIN_WEBGPU_BUFFER_BYTES;

        const isIntelMacProfile = /\bintel-mac\b/i.test(profile.reason || '');

        if (profile.tier === 'limited') {
            maxPendingChunks = 4;
            pollIntervalMs = 325;
            workerUpdateIntervalMs = 260;
            // Limited-tier mobile and Intel-mac profiles perform better with
            // low-power adapters for sustained real-time Whisper.
            preferLowPowerAdapter = profile.isMobile || isIntelMacProfile;
            minWebgpuBufferBytes = 384 * 1024 * 1024;
        } else if (profile.tier === 'constrained') {
            maxPendingChunks = 2;
            pollIntervalMs = 450;
            workerUpdateIntervalMs = 320;
            preferLowPowerAdapter = true;
            minWebgpuBufferBytes = 512 * 1024 * 1024;
        }

        if (memoryPressure === 'high') {
            maxPendingChunks = Math.max(1, maxPendingChunks - 2);
            pollIntervalMs = Math.max(pollIntervalMs, 500);
            workerUpdateIntervalMs = Math.max(workerUpdateIntervalMs, 350);
        } else if (memoryPressure === 'medium' && profile.tier !== 'full') {
            maxPendingChunks = Math.max(2, maxPendingChunks - 1);
        }

        if (forceWasm) {
            // CPU/WASM path: keep queue shallow to avoid pegging low-spec machines.
            maxPendingChunks = Math.min(maxPendingChunks, profile.tier === 'full' ? 3 : 2);
            pollIntervalMs = Math.max(pollIntervalMs, 400);
            workerUpdateIntervalMs = Math.max(workerUpdateIntervalMs, 350);
            preferLowPowerAdapter = true;
        }

        const configuredModel = String(Config.get('whisperModel') || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
        // A desktop without WebGPU (including Apple Silicon in browsers that do
        // not expose navigator.gpu) must start on the bounded tiny/WASM path.
        // Loading whisper-small on CPU first can otherwise look permanently hung.
        const useConservativeModel = forceWasm
            || !profile.hasGpu
            || profile.tier === 'constrained'
            || shouldUseTinyWhisperModel(profile);
        const model = this.modelOverride || (useConservativeModel ? FALLBACK_MODEL : configuredModel);
        const configuredLanguage = String(Config.get('whisperLanguage') || 'auto');
        let currentWork: WhisperWorkLanguageContext;
        try {
            currentWork = this.bridge.currentWork;
        } catch {
            currentWork = undefined;
        }
        const language = resolveWhisperLanguage(configuredLanguage, currentWork);
        const configuredTask = String(Config.get('whisperTask') || 'transcribe').toLowerCase();
        const subtask = configuredTask === 'translate' ? 'translate' : 'transcribe';
        const autoWarmupConfigured = Config.get('whisperAutoWarmup') !== false;
        const cacheTranscripts = Config.get('whisperCacheTranscripts') !== false;
        const idleUnloadMs = DeviceCapabilities.budget.whisperIdleMs;

        return {
            model,
            subtask,
            language,
            multilingual: true,
            chunkLengthS: 29,
            strideLengthS: 5,
            cacheTranscripts,
            autoWarmup: autoWarmupConfigured && DeviceCapabilities.shouldWarmup && !forceWasm,
            silenceThreshold: 0,
            maxPendingChunks,
            pollIntervalMs,
            workerUpdateIntervalMs,
            idleUnloadMs,
            forceWasm,
            preferLowPowerAdapter,
            minWebgpuBufferBytes,
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
        if (!this.enabled) return;
        this.showStatus(`<span class="whisper-error-indicator" aria-label="${this.escapeHtml(displayMessage)}">${this.escapeHtml(displayMessage)}</span>`);

        if (this.errorDismissTimer) clearTimeout(this.errorDismissTimer);
        this.errorDismissTimer = window.setTimeout(() => {
            this.clearStatus();
            this.errorDismissTimer = null;
        }, 5000);
    }

    private reserveStatusSlot(): void {
        if (!this.enabled || this.statusEl?.isConnected) return;
        // Reserve only inside the expanded player. Reserving against the global
        // footer would leave a permanent blank 72px strip on unrelated routes.
        const mount = document.querySelector('.audio-player');
        if (!mount) return;

        // Preserve an active message if the host re-render detached the old
        // node while a model was loading.
        const previousHtml = this.statusEl?.innerHTML || '';
        const wasVisible = !!previousHtml && this.statusEl?.style.visibility !== 'hidden';
        this.ensureStatusEl();
        if (wasVisible) this.showStatus(previousHtml);
        else this.clearStatus();
    }

    private ensureStatusEl(): HTMLElement {
        if (this.statusEl && this.statusEl.isConnected) return this.statusEl;

        document.querySelectorAll('.asmr-whisper-status-host').forEach((el) => {
            el.classList.remove('asmr-whisper-status-host');
        });
        this.statusEl = document.createElement('div');
        this.statusEl.className = 'whisper-status';
        this.statusEl.setAttribute('aria-label', I18n.t('whisperStatus') || 'Transcription status');
        this.statusEl.setAttribute('role', 'status');

        const player = document.querySelector('.audio-player');
        const albumArt = player?.querySelector('.albumart');
        if (albumArt) {
            // Overlay the transient model status on the cover. This removes the
            // status from document flow, so neither initial insertion nor later
            // show/hide transitions move the player content.
            this.statusEl.classList.add('whisper-status--overlay');
            albumArt.classList.add('asmr-whisper-status-host');
            albumArt.appendChild(this.statusEl);
        } else if (player) {
            this.statusEl.classList.add('whisper-status--inline');
            player.prepend(this.statusEl);
        } else {
            const bar = document.querySelector('.player-bar-container, .player-bar, .q-footer');
            if (bar) {
                this.statusEl.classList.add('whisper-status--inline');
                bar.insertAdjacentElement('beforebegin', this.statusEl);
            }
        }

        return this.statusEl;
    }

    private showStatus(html: string): void {
        const el = this.ensureStatusEl();
        if (el.innerHTML === html) return;
        el.innerHTML = html;
        el.style.display = '';
        el.style.visibility = 'visible';
    }

    private clearStatus(): void {
        if (this.statusEl) {
            // Inline fallback keeps its reserved slot; the normal cover overlay
            // has no layout footprint and can be removed from paint entirely.
            this.statusEl.style.display = this.statusEl.classList.contains('whisper-status--overlay') ? 'none' : '';
            this.statusEl.style.visibility = 'hidden';
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
