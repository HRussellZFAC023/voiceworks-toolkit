<script setup lang="ts">
/**
 * LearnerSubtitles.vue - Vue 3 SFC for Learner Mode subtitle display
 *
 * Renders both the expanded (inside audio player) and collapsed (fixed bar
 * teleported to <body>) subtitle areas.  All audio sync, whisper handling,
 * lyrics fetching, pre-translation, and control logic lives here.
 */

import {
    ref, computed, watch, onMounted, onUnmounted, nextTick, type Ref,
    Teleport,
} from 'vue';

import { useBridge } from '../../composables/useBridge';
import { useConfig } from '../../composables/useConfig';
import { useEventBus } from '../../composables/useEventBus';
import { useI18n } from '../../composables/useI18n';
import { TranslationService } from '../../services/TranslationService';
import { AppStore } from '../../store/AppStore';
import { AudioCache } from '../../infrastructure/AudioCache';
import { getAudioElement, getPlayerBar, isChinese, isTranslatable } from '../../core/DomUtils';
import { Logger, Config } from '../../core/Utils';
import { Priority } from '../../core/GpuScheduler';
import type { WhisperUpdatePayload, WhisperState, JPDBToken, AudioPlayerState, KikoeruStoreState, KikoeruApp, VueRoute, PlayerTrack, AvailableLyric, TranslationSourceHint } from '../../types';
import { buildSegments, sliceSegments, type FuriganaSegment } from '../../lib/jpdb-segments';
import { sanitizeWhisperText } from '../whisperProcessing';
import {
    isCurrentWhisperTextRequest,
    type WhisperTextRequestContext,
} from '../learnerWhisperRequestUtils';
import {
    findActiveLyricLine,
    findLyricsSource as findLyricsSourceUtil,
    normalizeLyricLines,
    normalizeWhisperSubtitleLines,
    parseLrcContent,
    parseSubtitleContent,
    type LyricLine,
} from '../learnerLyricsUtils';
import {
    buildKaraokeCharMap, computeWordKaraokeIndices, computeTimeFallbackKaraokeIndices,
    type KaraokeCharMap, type KaraokeWord,
} from '../karaokeUtils';
import {
    LearnerTaskScheduler,
    allTranslationLanesSucceeded,
    type TranslationLaneResult,
} from '../learnerTaskScheduler';
import SubtitleContent from './SubtitleContent.vue';
import LearnerSecondarySubtitle from './LearnerSecondarySubtitle.vue';
import {
    learnerSubtitleLayout,
    resolveLearnerSecondaryLanguage,
    subtitleLanguageAttribute,
} from '../learnerSubtitleMode';
import { resolveWhisperListenerStatusKey } from '../whisperProgressPolicy';
import { fetchSafeMediaText } from '../media/safeMediaTransport';
import { buildMediaPathFromHash } from '../media/mediaStreamUrlUtils';

// ---------------------------------------------------------------------------
// Composables
// ---------------------------------------------------------------------------

const bridge = useBridge();
const { on, emit } = useEventBus();
const { t, format } = useI18n();
const learnerBlur = useConfig('learnerBlur');
const learnerSubtitleMode = useConfig('learnerSubtitleMode');
const subtitleLang = useConfig('subtitleLang');
const showJP = useConfig('showJP');
const karaokeMode = useConfig('karaokeMode');
const segmentMode = useConfig('segmentMode');
const enablePlayerTranslator = useConfig('enablePlayerTranslator');
const enableJpdb = useConfig('enableJpdb');
const jpdbSubtitleFurigana = useConfig('jpdbSubtitleFurigana');
const jpdbShowFurigana = useConfig('jpdbShowFurigana');

// ---------------------------------------------------------------------------
// Reactive subtitle state
// ---------------------------------------------------------------------------

const primaryText = ref('');   // JP / primary line
const secondaryText = ref(''); // EN / secondary line (blurred)
const isBlurred = ref(!!learnerBlur.value);
const isFallback = ref(false); // true when secondary is the untranslated fallback
const karaokeSplitIndex = ref(-1); // Character index split for karaoke highlighting (-1 = no karaoke)
const karaokeHighlightStart = ref(-1); // Char index where current word starts (karaoke-only mode, -1 = inactive)

// Segment transition animation
const segmentFading = ref(false);
let prevPrimaryForFade = '';

// JPDB Furigana state
const jpdbTokens = ref<JPDBToken[] | null>(null);
let lastJpdbText = '';  // Track which text was parsed to avoid re-parsing

// Visibility
const isPlayerMinimized = ref(false);
const hasContent = ref(false);
const hasClampedSubtitle = ref(false);
const fullSubtitleOpen = ref(false);
const whisperCaptionDelayed = ref(false);
const whisperUiState = ref<WhisperState>({ ...AppStore.state.whisper });
const whisperStatusSessionActive = ref(false);

// Playback speed
const playbackRate = ref(Number(Config.get('playbackRate')) || 1.0);

// Overflow menu
const overflowOpen = ref(false);
const overflowStyle = ref<Record<string, string>>({});

// ---------------------------------------------------------------------------
// Non-reactive internal state (imperative, not triggering re-renders)
// ---------------------------------------------------------------------------

let currentLyrics: Array<{ time: number; endTime?: number; text: string; words?: Array<{ start: number; end: number; text: string }> }> = [];
let lastText = '';
let lastDisplayedText = '';
let lastSecondaryShown = '';  // tracks the actual EN translation text shown (vs empty placeholder)
let lastTrackKey: string | null = null;
let translationToken = 0;

// Whisper state
let whisperLines: Array<{ time: number; endTime?: number; text: string; words?: Array<{ start: number; end: number; text: string }> }> = [];
let whisperText = '';
let whisperActive = false;
let whisperRunning = false;
let whisperFromCache = false;
let whisperLive = false;
let whisperLeadSec = 0;
let whisperSourceLanguageHint: TranslationSourceHint = 'auto';
let whisperTimingQuality: 'word' | 'segment' = 'segment';
let whisperTextGeneration = 0;
let lastWhisperDisplayText = '';
let whisperTickerId: number | null = null;
let whisperTickerInterval = 80;
let laggedWhisperLine: LyricLine | null = null;
let laggedWhisperUntilMs = 0;
const seenWhisperArrivalSignatures = new Set<string>();

// Subtitle lead / append
const subtitleLeadSec = 1.2;
const subtitleAppendWindowSec = 1.5;
const subtitleAppendMaxChars = 140;
const WORD_REVEAL_DELAY_SEC = 0.002;
const LAGGED_WHISPER_DWELL_MS = 3_500;
const LEARNER_SECONDARY_TARGET = { preserveRequestedTarget: true } as const;

/** Adjust lead time for playback rate: at 2x, need 2x audio-seconds of lead for same real-world reaction time */
function effectiveLead(baseLead: number): number {
    return baseLead * playbackRate.value;
}

// Audio binding
let boundAudio: HTMLAudioElement | null = null;
let boundTimeHandler: (() => void) | null = null;
let seekedDebounceTimer: number | null = null;

// LRC fetch state
let lastLrcTrackHash: string | null = null;
let lrcFetchPromise: Promise<void> | null = null;
let lrcFetchAbortController: AbortController | null = null;
let queuedAvailableLyricsHash: string | null = null;
const lrcFetchAttemptedHashes = new Set<string>();
const lrcApiDeniedHashes = new Set<string>();
const lrcRetryAttempts = new Map<string, number>();
const LRC_RETRY_DELAYS_MS = [250, 1_000, 3_000] as const;
const MAX_SUBTITLE_BYTES = 4 * 1024 * 1024;
const SUBTITLE_FETCH_TIMEOUT_MS = 20_000;
let lastNoLyricsLogHash: string | null = null;
let lastPreTranslatedKey: string | null = null;
let pretranslateInFlightKey: string | null = null;
const pretranslationTasks = new LearnerTaskScheduler();
const trackTasks = new LearnerTaskScheduler();
const lifecycleTasks = new LearnerTaskScheduler();
let realtimeQueueKey = '';
let realtimeJaQueueKey = '';
let lookaheadQueueKey = '';
let lookaheadJaQueueKey = '';
let pretranslateQueueKey = '';
let pretranslateJaQueueKey = '';

// Ticker translation throttle
let lastTickerTranslationText = '';
let lastTickerTranslationAt = 0;
const TICKER_TRANSLATION_COOLDOWN_MS = 50;

// Drawer width tracking
let drawerResizeObserver: ResizeObserver | null = null;

// Cover height adjustment — reduce album art q-img max-height to
// accommodate injected subtitle/visualizer areas that the host app
// doesn't know about.
let coverImgObserver: MutationObserver | null = null;
let subsResizeObserver: ResizeObserver | null = null;
let subtitleOverflowResizeObserver: ResizeObserver | null = null;
let lastSetCoverMaxH = '';  // Track our last-set value to distinguish from host updates

// rAF coalescing flags — prevent layout thrashing during window resize
let rafPlayerObserver = 0;
let rafCoverAdjust = 0;
let rafDrawerSync = 0;
let seekingRafId = 0;

// Host more button (for overflow proxy)
let hostMoreBtn: HTMLElement | null = null;
// Controls captured into overflow
const originalParents = new Map<HTMLElement, { parent: HTMLElement; nextSibling: Node | null }>();

// Overflow menu DOM ref (created imperatively and appended to body for z-index)
let overflowMenuEl: HTMLElement | null = null;
let overflowTransientCleanup: (() => void) | null = null;

// Player observer (for injection race condition)
let playerObserver: MutationObserver | null = null;

// Store watchers cleanup
const storeWatcherCleanups: (() => void)[] = [];
let routeUnwatch: (() => void) | null = null;

// Microtask-debounced updateLyrics to coalesce multiple store watchers firing in the same tick
let lyricsUpdateScheduled = false;
function scheduleUpdateLyrics() {
    if (lyricsUpdateScheduled) return;
    lyricsUpdateScheduled = true;
    queueMicrotask(() => {
        lyricsUpdateScheduled = false;
        updateLyrics();
    });
}

// ---------------------------------------------------------------------------
// Computed visibility
// ---------------------------------------------------------------------------

const showExpanded = computed(() => !isPlayerMinimized.value && hasContent.value);
const showCollapsed = computed(() => isPlayerMinimized.value && hasContent.value);
const whisperPlaceholderText = computed(() => {
    if (primaryText.value || secondaryText.value || !whisperStatusSessionActive.value) return '';
    const state = whisperUiState.value;
    if (state.stage === 'error') {
        return state.progressMessage || t('whisperUnknownError');
    }
    const listenerKey = resolveWhisperListenerStatusKey(state.stage);
    return listenerKey ? t(listenerKey) : '';
});
const secondaryLanguage = computed(() => resolveLearnerSecondaryLanguage(
    learnerSubtitleMode.value,
    subtitleLang.value,
));
const subtitleLayout = computed(() => learnerSubtitleLayout(learnerSubtitleMode.value, secondaryLanguage.value));
const secondaryLangAttribute = computed(() => subtitleLanguageAttribute(secondaryLanguage.value));
const karaokeUpcoming = computed(() => {
    if (karaokeSplitIndex.value < 0 || !primaryText.value) return '';
    return Array.from(primaryText.value).slice(karaokeSplitIndex.value).join('');
});
const karaokePast = computed(() => {
    if (karaokeHighlightStart.value < 0 || !primaryText.value) return '';
    return Array.from(primaryText.value).slice(0, karaokeHighlightStart.value).join('');
});
const karaokeCurrent = computed(() => {
    if (karaokeHighlightStart.value < 0 || !primaryText.value) return '';
    const chars = Array.from(primaryText.value);
    // When splitIdx is also set (karaoke+segment 3-way), current word ends at splitIdx
    if (karaokeSplitIndex.value >= 0) {
        return chars.slice(karaokeHighlightStart.value, karaokeSplitIndex.value).join('');
    }
    return chars.slice(karaokeHighlightStart.value).join('');
});

// ---------------------------------------------------------------------------
// JPDB Furigana computed properties
// ---------------------------------------------------------------------------

const jpdbEnabled = computed(() =>
    enableJpdb.value && jpdbSubtitleFurigana.value && jpdbShowFurigana.value && jpdbTokens.value !== null,
);

const furiganaSegments = computed<FuriganaSegment[] | null>(() => {
    if (!jpdbTokens.value || !primaryText.value) return null;
    return buildSegments(primaryText.value, jpdbTokens.value);
});

const furiganaPast = computed(() =>
    sliceSegments(furiganaSegments.value, 0, karaokeHighlightStart.value),
);

const furiganaCurrent = computed(() =>
    sliceSegments(furiganaSegments.value, karaokeHighlightStart.value, karaokeSplitIndex.value),
);

const furiganaUpcoming = computed(() =>
    sliceSegments(furiganaSegments.value, karaokeSplitIndex.value, Infinity),
);

// Non-karaoke: all segments (when no karaoke active)
const furiganaAll = computed(() =>
    sliceSegments(furiganaSegments.value, 0, Infinity),
);

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const expandedRef = ref<HTMLElement | null>(null);
const collapsedRef = ref<HTMLElement | null>(null);
const fullSubtitleDialogRef = ref<HTMLElement | null>(null);
const overflowToggleRef = ref<HTMLElement | null>(null);
let fullSubtitleTrigger: HTMLElement | null = null;
let subtitleOverflowMeasureGeneration = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetDedupState(options: { includeWhisperDisplay?: boolean; bumpTranslationToken?: boolean } = {}) {
    lastText = '';
    lastDisplayedText = '';
    lastSecondaryShown = '';
    lastLookaheadText = '';
    if (options.includeWhisperDisplay) {
        lastWhisperDisplayText = '';
    }
    if (options.bumpTranslationToken) {
        translationToken += 1;
    }
}

function activeSubtitlePanels(): HTMLElement[] {
    return [expandedRef.value, collapsedRef.value].filter((panel): panel is HTMLElement => {
        if (!panel || panel.classList.contains('hidden')) return false;
        return panel.getClientRects().length > 0;
    });
}

function subtitleLaneIsClamped(lane: HTMLElement): boolean {
    if (!lane.textContent?.trim()) return false;
    if (lane.scrollHeight > lane.clientHeight + 1) return true;

    // Some line-clamp implementations report the clipped height as
    // scrollHeight. A DOM Range still spans the hidden line boxes and avoids
    // a clone whose inherited host typography can differ across browsers.
    if (lane.clientHeight <= 0) return false;
    const contentRange = document.createRange();
    contentRange.selectNodeContents(lane);
    return contentRange.getBoundingClientRect().height > lane.clientHeight + 1;
}

function measureClampedSubtitles(): void {
    hasClampedSubtitle.value = activeSubtitlePanels().some(panel => (
        Array.from(panel.querySelectorAll<HTMLElement>('.learner-jp, .learner-en'))
            .some(subtitleLaneIsClamped)
    ));

    if (!hasClampedSubtitle.value) closeFullSubtitles(false);
}

function scheduleSubtitleOverflowMeasure(): void {
    const generation = ++subtitleOverflowMeasureGeneration;
    void nextTick(() => {
        if (generation === subtitleOverflowMeasureGeneration) measureClampedSubtitles();
    });
}

function setupSubtitleOverflowObserver(): void {
    if (typeof ResizeObserver === 'undefined') return;
    subtitleOverflowResizeObserver ??= new ResizeObserver(
        scheduleSubtitleOverflowMeasure,
    );
    for (const panel of [expandedRef.value, collapsedRef.value]) {
        if (panel) subtitleOverflowResizeObserver.observe(panel);
    }
}

function openFullSubtitles(event: MouseEvent): void {
    fullSubtitleTrigger = event.currentTarget as HTMLElement;
    fullSubtitleOpen.value = true;
    void nextTick(() => fullSubtitleDialogRef.value?.focus());
}

function closeFullSubtitles(restoreFocus = true): void {
    if (!fullSubtitleOpen.value) return;
    fullSubtitleOpen.value = false;
    if (!restoreFocus) {
        fullSubtitleTrigger = null;
        return;
    }
    void nextTick(() => {
        const visibleTrigger = fullSubtitleTrigger?.isConnected
            && fullSubtitleTrigger.getClientRects().length > 0
            ? fullSubtitleTrigger
            : Array.from(document.querySelectorAll<HTMLElement>('.learner-subtitle-expand'))
                .find(element => element.getClientRects().length > 0);
        visibleTrigger?.focus();
        fullSubtitleTrigger = null;
    });
}

function trapFullSubtitleDialogFocus(event: KeyboardEvent): void {
    const dialog = fullSubtitleDialogRef.value;
    if (!dialog) return;

    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    )).filter(element => !element.hidden);
    if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    const wrapsBackward = event.shiftKey && (active === first || active === dialog);
    const wrapsForward = !event.shiftKey && active === last;
    if (!wrapsBackward && !wrapsForward) return;

    event.preventDefault();
    (event.shiftKey ? last : first).focus();
}

function handleFullSubtitleDialogKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
        event.preventDefault();
        closeFullSubtitles();
        return;
    }
    if (event.key === 'Tab') trapFullSubtitleDialogFocus(event);
}

// Karaoke rAF state — cached per active line for smooth 60fps updates
let karaokeCharMapCached: KaraokeCharMap | null = null;
let karaokeFullTextCached = '';
let karaokeLineTimeCached = 0;
let karaokeLineEndTimeCached: number | undefined;
let karaokeTotalCharsCached = 0;
let karaokeRafId = 0;

/** rAF tick: recompute karaoke indices from live audio.currentTime */
function karaokeRafTick() {
    karaokeRafId = 0; // cleared — will re-schedule at end if needed
    const audio = getAudioElement();
    if (!audio || !karaokeMode.value || !karaokeFullTextCached) return;

    const now = audio.currentTime;
    let indices: { splitIdx: number; hlStart: number };

    if (karaokeCharMapCached && karaokeCharMapCached.entries.length > 0) {
        indices = computeWordKaraokeIndices(karaokeCharMapCached, now);
    } else if (karaokeLineEndTimeCached != null) {
        indices = computeTimeFallbackKaraokeIndices(
            karaokeFullTextCached, karaokeTotalCharsCached,
            karaokeLineTimeCached, karaokeLineEndTimeCached, now,
        );
    } else {
        return;
    }

    const newSplit = indices.splitIdx;
    const newHl = segmentMode.value ? 0 : indices.hlStart;
    if (newSplit !== karaokeSplitIndex.value) karaokeSplitIndex.value = newSplit;
    if (newHl !== karaokeHighlightStart.value) karaokeHighlightStart.value = newHl;

    // Keep looping while playing
    if (!audio.paused) karaokeRafId = requestAnimationFrame(karaokeRafTick);
}

function startKaraokeRaf() {
    if (karaokeRafId) return;
    const audio = getAudioElement();
    if (!audio || audio.paused || !karaokeMode.value) return;
    karaokeRafId = requestAnimationFrame(karaokeRafTick);
}

function stopKaraokeRaf() {
    if (karaokeRafId) { cancelAnimationFrame(karaokeRafId); karaokeRafId = 0; }
}

/** Store active line data for rAF and compute immediate indices. */
function setKaraokeLineState(
    fullText: string,
    words: KaraokeWord[] | null | undefined,
    lineTime: number,
    lineEndTime: number | undefined,
    now: number,
): { splitIdx: number; hlStart: number } {
    karaokeFullTextCached = fullText;
    karaokeLineTimeCached = lineTime;
    karaokeLineEndTimeCached = lineEndTime;

    if (words && words.length > 0) {
        karaokeCharMapCached = buildKaraokeCharMap(fullText, words);
        karaokeTotalCharsCached = karaokeCharMapCached.totalChars;
        startKaraokeRaf();
        return computeWordKaraokeIndices(karaokeCharMapCached, now);
    }
    karaokeCharMapCached = null;
    karaokeTotalCharsCached = Array.from(fullText).length;
    startKaraokeRaf();
    return computeTimeFallbackKaraokeIndices(fullText, karaokeTotalCharsCached, lineTime, lineEndTime, now);
}

function getKaraokeLineIndices(
    fullText: string,
    display: SubtitleDisplayResult,
    requireWordTiming = false,
): { splitIdx: number; hlStart: number } | null {
    const activeLine = display.activeLine;
    const karaokeTime = display.audioTime ?? display.now;
    if (!activeLine || karaokeTime == null) return null;
    if (requireWordTiming && !activeLine.words?.length) return null;

    const indices = setKaraokeLineState(
        fullText,
        activeLine.words,
        activeLine.time,
        activeLine.endTime,
        karaokeTime,
    );
    return {
        splitIdx: indices.splitIdx,
        hlStart: segmentMode.value ? 0 : indices.hlStart,
    };
}

function clearKaraokeState() {
    stopKaraokeRaf();
    karaokeCharMapCached = null;
    karaokeFullTextCached = '';
}

function resetLaggedWhisperCaption(clearArrivalSignatures = true): void {
    laggedWhisperLine = null;
    laggedWhisperUntilMs = 0;
    if (clearArrivalSignatures) seenWhisperArrivalSignatures.clear();
    whisperCaptionDelayed.value = false;
}


function getTrackKey(): string | null {
    const track = bridge.currentTrack;
    const candidates = [
        track?.hash,
        track?.mediaStreamUrl,
        track?.media_stream_url,
        track?.src,
        track?.title,
    ];
    return candidates.find((value): value is string => typeof value === 'string' && value.length > 0) ?? null;
}

function cancelQueue(cancellableKey: string): void {
    if (!cancellableKey) return;
    TranslationService.cancelPending({ cancellableKey });
}

function updateQueueKey(currentKey: string, nextKey: string): string {
    // A key identifies a UI lane, not one immutable request. Cancel queued
    // work from the previous line even when track/target (and thus key) match.
    if (currentKey) cancelQueue(currentKey);
    return nextKey;
}

function buildTranslationQueueKey(scope: string, targetLang: string): string {
    return `${scope}:${getTrackKey() || 'unknown'}:${targetLang}`;
}

/** Cancel realtime + lookahead queues only (for seeks within the same track). */
function resetRealtimeQueues(): void {
    cancelQueue(realtimeQueueKey);
    cancelQueue(realtimeJaQueueKey);
    cancelQueue(lookaheadQueueKey);
    cancelQueue(lookaheadJaQueueKey);
    realtimeQueueKey = '';
    realtimeJaQueueKey = '';
    lookaheadQueueKey = '';
    lookaheadJaQueueKey = '';
}

/** Cancel ALL translation queues (for track changes / navigation / cleanup). */
function resetLearnerTranslationQueues(): void {
    pretranslationTasks.cancelAll();
    pretranslateInFlightKey = null;
    lastPreTranslatedKey = null;
    resetRealtimeQueues();
    cancelQueue(pretranslateQueueKey);
    cancelQueue(pretranslateJaQueueKey);
    pretranslateQueueKey = '';
    pretranslateJaQueueKey = '';
}

function resetTrackTasks(): void {
    trackTasks.cancelAll();
    lrcFetchAbortController?.abort(new DOMException('Subtitle track changed', 'AbortError'));
    lrcFetchAbortController = null;
    lrcFetchPromise = null;
    queuedAvailableLyricsHash = null;
}

function resetTrackRuntimeState(): void {
    resetTrackTasks();
    resetDedupState({ includeWhisperDisplay: true, bumpTranslationToken: true });
    currentLyrics = [];
    whisperLines = [];
    whisperText = '';
    whisperActive = false;
    whisperFromCache = false;
    whisperLive = false;
    whisperLeadSec = 0;
    whisperSourceLanguageHint = 'auto';
    whisperTimingQuality = 'segment';
    // A component/host remount can rebuild the player while the same canonical
    // run is still active. Preserve its status reservation; an ensuing idle
    // state or explicit clear will release it.
    whisperStatusSessionActive.value = whisperRunning;
    resetLaggedWhisperCaption();
    clearWhisperTicker();
    resetLearnerTranslationQueues();
    lastPreTranslatedKey = null;
    lastLrcTrackHash = null;
    lrcFetchAttemptedHashes.clear();
    lrcApiDeniedHashes.clear();
    lrcRetryAttempts.clear();
    lastNoLyricsLogHash = null;
    clearDisplay();
}

function enterTrack(trackKey: string | null): boolean {
    if (!trackKey || trackKey === lastTrackKey) return false;
    lastTrackKey = trackKey;
    resetTrackRuntimeState();
    return true;
}

function schedulePreTranslation(
    lyrics: Array<{ time: number; text: string }>,
    delayMs: number,
    sourceLanguageHint: TranslationSourceHint = 'auto',
): void {
    const expectedTrackKey = getTrackKey();
    pretranslationTasks.schedule(
        () => preTranslateAll(lyrics, sourceLanguageHint),
        delayMs,
        () => getTrackKey() === expectedTrackKey,
    );
}

function normalizeLanguageHint(language: string): TranslationSourceHint {
    const normalized = String(language || '').toLowerCase().split('-')[0];
    if (normalized === 'ja' || normalized === 'jp' || normalized === 'japanese') return 'ja';
    if (normalized === 'zh' || normalized === 'cn' || normalized === 'cmn' || normalized === 'chinese') return 'zh';
    if (normalized === 'en' || normalized === 'english') return 'en';
    return 'auto';
}

function isAlreadyTargetLanguage(
    text: string,
    targetLang: string,
    sourceLanguageHint: TranslationSourceHint = 'auto',
): boolean {
    const target = targetLang.toLowerCase().split('-')[0];
    if (sourceLanguageHint !== 'auto') {
        return normalizeLanguageHint(target) === sourceLanguageHint;
    }
    if (target === 'zh' || target === 'cn') return isChinese(text);
    if (target === 'ja' || target === 'jp') return /[\u3040-\u30ff]/.test(text);
    if (target === 'en') return /[a-z]/i.test(text) && !/[\u3040-\u30ff\u4e00-\u9fff]/.test(text);
    return TranslationService.isTargetLanguage(text, targetLang);
}

function shouldTickerTranslate(text: string): boolean {
    const now = Date.now();
    if (text === lastTickerTranslationText && now - lastTickerTranslationAt < TICKER_TRANSLATION_COOLDOWN_MS) {
        return false;
    }
    lastTickerTranslationText = text;
    lastTickerTranslationAt = now;
    return true;
}

function getSecondaryTargetLanguage(): string {
    return resolveLearnerSecondaryLanguage(learnerSubtitleMode.value, subtitleLang.value).toLowerCase();
}

/** Look-ahead: fire translations for the next N lines after the current one. */
let lastLookaheadText = '';
function translateLookahead(
    currentText: string,
    targetLang: string,
    sourceLanguageHint: TranslationSourceHint = whisperActive ? whisperSourceLanguageHint : 'auto',
): void {
    if (currentText === lastLookaheadText) return;
    // Supersede the previous playhead window even if the new text has not yet
    // been inserted into the reactive line list.
    cancelQueue(lookaheadQueueKey);
    cancelQueue(lookaheadJaQueueKey);
    lookaheadQueueKey = '';
    lookaheadJaQueueKey = '';

    const lines = whisperActive ? whisperLines : currentLyrics;
    const idx = lines.findIndex(l => l.text?.trim() === currentText);
    if (idx < 0) return;
    lastLookaheadText = currentText;

    const LOOKAHEAD = 10;
    const end = Math.min(lines.length, idx + 1 + LOOKAHEAD);
    const targetTexts = new Set<string>();
    const cnTexts = new Set<string>();
    for (let i = idx + 1; i < end; i++) {
        const t = lines[i].text?.trim();
        if (t && !isAlreadyTargetLanguage(t, targetLang, sourceLanguageHint)
            && !TranslationService.peekCached(t, targetLang, sourceLanguageHint, LEARNER_SECONDARY_TARGET)) {
            targetTexts.add(t);
        }
        const chineseSource = sourceLanguageHint === 'zh'
            || (sourceLanguageHint === 'auto' && isChinese(t));
        if (t && chineseSource && targetLang !== 'ja' && !TranslationService.peekCached(t, 'ja', 'zh')) {
            cnTexts.add(t);
        }
    }

    if (targetTexts.size > 0) {
        const queueKey = buildTranslationQueueKey('learner:lookahead', targetLang);
        lookaheadQueueKey = queueKey;
        TranslationService.translateBatch(Array.from(targetTexts), targetLang, {
            ...LEARNER_SECONDARY_TARGET,
            priority: Priority.HIGH,
            cancellable: true,
            cancellableKey: lookaheadQueueKey,
            sourceLanguageHint,
        }).catch(() => {});
    }

    if (cnTexts.size > 0) {
        const queueKey = buildTranslationQueueKey('learner:lookahead:ja', 'ja');
        lookaheadJaQueueKey = queueKey;
        TranslationService.translateBatch(Array.from(cnTexts), 'ja', {
            priority: Priority.HIGH,
            cancellable: true,
            cancellableKey: lookaheadJaQueueKey,
            sourceLanguageHint: 'zh',
        }).catch(() => {});
    }
}

// ---------------------------------------------------------------------------
// Blur toggle
// ---------------------------------------------------------------------------

function toggleBlur() {
    isBlurred.value = !isBlurred.value;
}

// Blur toggle from keyboard shortcut (ephemeral, does not persist to config)
on('blur:toggle', () => toggleBlur());

// Sync blur from config changes (e.g. from settings panel)
on('config:change', ({ key, value }) => {
    if (key === 'learnerBlur') {
        isBlurred.value = !!value;
    } else if (key === 'showJP') {
        // showJP ref auto-syncs via useConfig
    } else if (key === 'enableWhisper' || key === 'enableJoiTool' || key === 'enableVisualizer') {
        syncOverflowItemVisibility(key, !!value);
    } else if (key === 'subtitleLang' || key === 'learnerSubtitleMode' || key === 'translateMode' || key === 'translateCnToJp'
        || key === 'translationApiEndpoint' || key === 'translationApiKey' || key === 'translationApiModel') {
        resetLearnerTranslationQueues();
        lastPreTranslatedKey = null;
        resetDedupState({ includeWhisperDisplay: true, bumpTranslationToken: true });
        updateLyrics();
    }
});

// ---------------------------------------------------------------------------
// Primary / secondary line updates
// ---------------------------------------------------------------------------

function updatePrimaryLine(text: string, splitIdx = -1, hlStart = -1) {
    primaryText.value = text;
    karaokeSplitIndex.value = karaokeMode.value ? splitIdx : -1;
    karaokeHighlightStart.value = karaokeMode.value ? hlStart : -1;

    // Parse with JPDB for furigana (async, non-blocking)
    if (enableJpdb.value && jpdbSubtitleFurigana.value && jpdbShowFurigana.value && text && text !== lastJpdbText) {
        lastJpdbText = text;
        parseForFurigana(text);
    } else if (!text) {
        jpdbTokens.value = null;
        lastJpdbText = '';
    }
}

async function parseForFurigana(text: string): Promise<void> {
    try {
        const { JpdbService } = await import('../../services/JpdbService');
        const tokens = await JpdbService.parseSingle(text);
        // Only update if text hasn't changed while we were parsing
        if (primaryText.value === text) {
            jpdbTokens.value = tokens;
        }
    } catch {
        // Silently fail — furigana is optional enhancement
    }
}

/**
 * Handle JPDB card state change (grading, mining, etc.).
 * Updates the reactive jpdbTokens so Vue recomputes segment classes.
 */
function onJpdbCardGraded(e: Event): void {
    const { vid, sid, cardState } = (e as CustomEvent).detail;
    if (!jpdbTokens.value) return;
    for (const token of jpdbTokens.value) {
        if (token.card.vid === vid && token.card.sid === sid) {
            token.card.cardState = cardState;
        }
    }
}

function updateSecondaryLine(text: string, fallback: boolean) {
    secondaryText.value = text;
    isFallback.value = fallback;
}

function clearDisplay() {
    primaryText.value = '';
    secondaryText.value = '';
    karaokeSplitIndex.value = -1;
    karaokeHighlightStart.value = -1;
    clearKaraokeState();
    jpdbTokens.value = null;
    lastJpdbText = '';
    lastDisplayedText = '';
    lastSecondaryShown = '';
    refreshVisibility();
}

function refreshVisibility() {
    isPlayerMinimized.value = !!bridge.store?.state?.AudioPlayer?.hide;
    const reservedStatus = whisperStatusSessionActive.value
        && (whisperUiState.value.stage === 'error' || whisperUiState.value.stage === 'recovering');
    hasContent.value = !!lastDisplayedText || currentLyrics.length > 0
        || whisperActive || whisperRunning || reservedStatus;
}

// ---------------------------------------------------------------------------
// Audio time-update binding
// ---------------------------------------------------------------------------

function handleAudioPlay() {
    if (boundAudio && playbackRate.value !== 1.0) {
        boundAudio.playbackRate = playbackRate.value;
    }
    // Restart karaoke rAF on play
    if (karaokeMode.value && karaokeFullTextCached) startKaraokeRaf();
}

function handleAudioPause() {
    stopKaraokeRaf();
}

function handleAudioSeeking() {
    // Cancel any pending seeking RAF to avoid stale updates
    if (seekingRafId) {
        cancelAnimationFrame(seekingRafId);
        seekingRafId = 0;
    }

    // Reset dedup state and defer subtitle update to next frame so audio.currentTime
    // has synchronized with the seek target. During rapid scrubbing, the seeking event
    // fires before currentTime is fully updated, causing subtitles to lag behind.
    // A deliberately delayed live result belongs to the old playhead and must
    // never survive a manual seek into an uncovered part of the timeline.
    resetLaggedWhisperCaption(false);
    resetDedupState({ includeWhisperDisplay: true, bumpTranslationToken: true });
    resetRealtimeQueues();

    // Defer to next frame when currentTime will have synchronized
    seekingRafId = requestAnimationFrame(() => {
        seekingRafId = 0;
        updateLyrics();
    });
}

function handleAudioSeeked() {
    // Cancel any pending seeking RAF since seeked is the final event
    if (seekingRafId) {
        cancelAnimationFrame(seekingRafId);
        seekingRafId = 0;
    }

    // Final refresh after the user releases the scrubber.
    // Reset dedup again in case seeking handler's update was stale.
    resetDedupState({ includeWhisperDisplay: true, bumpTranslationToken: true });
    resetRealtimeQueues();
    if (seekedDebounceTimer) clearTimeout(seekedDebounceTimer);
    seekedDebounceTimer = window.setTimeout(() => {
        seekedDebounceTimer = null;
        updateLyrics();
    }, 30);
}

function bindAudioTimeUpdate() {
    const audio = getAudioElement();
    if (!audio) return;

    if (playbackRate.value !== 1.0) {
        audio.playbackRate = playbackRate.value;
    }

    if (boundAudio === audio) return;

    // Unbind from old element
    if (boundAudio && boundTimeHandler) {
        boundAudio.removeEventListener('timeupdate', boundTimeHandler);
        boundAudio.removeEventListener('play', handleAudioPlay);
        boundAudio.removeEventListener('pause', handleAudioPause);
        boundAudio.removeEventListener('seeking', handleAudioSeeking);
        boundAudio.removeEventListener('seeked', handleAudioSeeked);
    }

    boundAudio = audio;
    if (boundTimeHandler) {
        audio.addEventListener('timeupdate', boundTimeHandler);
    }
    audio.addEventListener('seeking', handleAudioSeeking);
    audio.addEventListener('seeked', handleAudioSeeked);
    audio.addEventListener('play', handleAudioPlay);
    audio.addEventListener('pause', handleAudioPause);
}

function unbindAudio() {
    if (boundAudio) {
        if (boundTimeHandler) boundAudio.removeEventListener('timeupdate', boundTimeHandler);
        boundAudio.removeEventListener('play', handleAudioPlay);
        boundAudio.removeEventListener('pause', handleAudioPause);
        boundAudio.removeEventListener('seeking', handleAudioSeeking);
        boundAudio.removeEventListener('seeked', handleAudioSeeked);
        boundAudio = null;
    }
}

// ---------------------------------------------------------------------------
// Timeline helpers
// ---------------------------------------------------------------------------

function getProgressiveText(
    line: { time: number; endTime?: number; text: string },
    now: number,
): string {
    const text = line.text?.trim() || '';
    if (!text || line.endTime == null) return text;
    // Segment mode: show full text at once, no progressive reveal
    if (segmentMode.value) return text;

    const words = (line as { words?: Array<{ start: number; end: number; text: string }> }).words;
    if (Array.isArray(words) && words.length > 0) {
        // Never reveal the next word early: use a tiny negative cutoff so
        // float jitter doesn't advance highlighting before speech starts.
        const revealCutoff = Math.max(0, now - WORD_REVEAL_DELAY_SEC);
        const visible = words.filter(w => w.start <= revealCutoff).map(w => (w.text || '').trim()).filter(Boolean);
        if (visible.length === 0) return '';
        return /\s/.test(text) ? visible.join(' ') : visible.join('');
    }

    const duration = Math.max(0.05, line.endTime - line.time);
    const progress = Math.max(0, Math.min(1, (now - line.time) / duration));
    if (/\s/.test(text)) {
        const ws = text.split(/\s+/).filter(Boolean);
        const count = Math.max(1, Math.min(ws.length, Math.ceil(progress * ws.length)));
        return ws.slice(0, count).join(' ');
    }
    const chars = Array.from(text);
    const count = Math.max(1, Math.min(chars.length, Math.ceil(progress * chars.length)));
    return chars.slice(0, count).join('');
}

function getTextFromTimelineFor(
    lines: Array<{ time: number; endTime?: number; text: string; words?: Array<{ start: number; end: number; text: string }> }>,
    leadSec = 0,
    progressive = false,
    appendWindowSec = 0,
    appendMaxChars = 0,
): string {
    const audio = getAudioElement();
    if (!audio || lines.length === 0) return '';
    const now = audio.currentTime + Math.max(0, leadSec);
    const activeLine = findActiveLyricLine(lines, now);
    if (!activeLine || !activeLine.text) return '';
    if (progressive && activeLine.endTime && activeLine.endTime > activeLine.time) {
        return getProgressiveText(activeLine, now);
    }
    const base = activeLine.text.trim();
    if (!appendWindowSec || lines.length < 2) return base;
    const idx = lines.indexOf(activeLine);
    if (idx < 0 || idx >= lines.length - 1) return base;
    const next = lines[idx + 1];
    if (!next?.text) return base;
    const nextStart = next.time ?? 0;
    if (nextStart - now > appendWindowSec) return base;
    const combined = `${base} ${next.text.trim()}`.trim();
    if (appendMaxChars > 0 && combined.length > appendMaxChars) return base;
    return combined;
}

interface SubtitleDisplayResult {
    displayText: string;
    fullText: string;
    activeLine?: { time: number; endTime?: number; text: string; words?: Array<{ start: number; end: number; text: string }> };
    now?: number;
    audioTime?: number;
    delayed?: boolean;
}

function getWhisperDisplay(): SubtitleDisplayResult {
    const audio = getAudioElement();
    if (!audio || whisperLines.length === 0) return { displayText: '', fullText: '' };
    const audioTime = audio.currentTime;
    const now = audioTime + Math.max(0, effectiveLead(whisperLeadSec));
    const activeLine = findActiveLyricLine(whisperLines, now, { expiredGraceSeconds: 0.75 });
    if (!activeLine || !activeLine.text) {
        if (laggedWhisperLine?.text && performance.now() < laggedWhisperUntilMs) {
            const text = laggedWhisperLine.text.trim();
            return {
                displayText: text,
                fullText: text,
                activeLine: laggedWhisperLine,
                now: laggedWhisperLine.endTime ?? laggedWhisperLine.time,
                audioTime,
                delayed: true,
            };
        }
        return { displayText: '', fullText: '' };
    }
    // Once a current cue wins, an older backfill must never reappear after it
    // ends, even if the delayed-caption dwell window is still open.
    laggedWhisperLine = null;
    laggedWhisperUntilMs = 0;
    return { displayText: getProgressiveText(activeLine, now), fullText: activeLine.text.trim(), activeLine, now, audioTime };
}

function getSubtitleDisplay(): SubtitleDisplayResult {
    const audio = getAudioElement();
    if (!audio || currentLyrics.length === 0) return { displayText: '', fullText: '' };
    const audioTime = audio.currentTime;
    const now = audioTime + effectiveLead(subtitleLeadSec);
    const activeLine = findActiveLyricLine(currentLyrics, now);
    if (!activeLine || !activeLine.text) return { displayText: '', fullText: '' };
    return { displayText: getProgressiveText(activeLine, now), fullText: activeLine.text.trim(), activeLine, now, audioTime };
}

// ---------------------------------------------------------------------------
// Lyrics source finding
// ---------------------------------------------------------------------------

function getTextTracksAsLyrics(): Array<{ time: number; endTime?: number; text: string }> | null {
    const audio = getAudioElement();
    if (!audio?.textTracks) return null;
    for (const track of Array.from(audio.textTracks)) {
        if (!track) continue;
        if (track.mode === 'disabled') track.mode = 'hidden';
        const cues = track.cues;
        if (!cues || cues.length === 0) continue;
        const lyrics: Array<{ time: number; endTime?: number; text: string }> = [];
        for (let i = 0; i < cues.length; i++) {
            const cue = cues[i] as VTTCue;
            if (cue?.text) lyrics.push({ time: cue.startTime, endTime: cue.endTime, text: cue.text.trim() });
        }
        if (lyrics.length > 0) return lyrics;
    }
    return null;
}

function findLyricsSource(): Record<string, unknown>[] | null {
    const source = findLyricsSourceUtil(bridge.store?.state?.AudioPlayer, document);
    return source as Record<string, unknown>[] | null;
}

// ---------------------------------------------------------------------------
// VTT / LRC parsing
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// LRC / subtitle fetching
// ---------------------------------------------------------------------------

function isCurrentTrackRequest(generation: number, expectedTrackKey: string): boolean {
    return trackTasks.isCurrent(generation) && getTrackKey() === expectedTrackKey;
}

function resolveHostApiSubtitleUrl(rawUrl: string): string | null {
    // Backslashes and encoded path separators have browser/HTTP-client
    // normalization differences. Native subtitle paths are opaque hashes, so
    // reject those ambiguous forms before attaching host authorization.
    if (/\\|%(?:2f|5c)/i.test(rawUrl)) return null;
    try {
        const locationHref = globalThis.location?.href;
        if (!locationHref) return null;
        const baseUrl = bridge.axios.defaults?.baseURL;
        const base = new URL(baseUrl || locationHref, locationHref);
        const parsed = new URL(rawUrl, base);
        const trustedOrigins = new Set<string>();
        if (globalThis.location?.origin) trustedOrigins.add(globalThis.location.origin);
        trustedOrigins.add(base.origin);
        if (!trustedOrigins.has(parsed.origin) || parsed.username || parsed.password) return null;
        parsed.hash = '';
        return parsed.href;
    } catch {
        return null;
    }
}

async function fetchHostSubtitleText(url: string, signal: AbortSignal): Promise<string> {
    const controller = new AbortController();
    let exceededByteLimit = false;
    const forwardAbort = () => controller.abort(signal.reason);
    if (signal.aborted) forwardAbort();
    else signal.addEventListener('abort', forwardAbort, { once: true });
    try {
        const res = await bridge.axios.get<string>(url, {
            responseType: 'text',
            signal: controller.signal,
            timeout: SUBTITLE_FETCH_TIMEOUT_MS,
            onDownloadProgress: (event: { loaded?: number; total?: number }) => {
                const loaded = Number(event.loaded) || 0;
                const total = Number(event.total) || 0;
                if (loaded <= MAX_SUBTITLE_BYTES && total <= MAX_SUBTITLE_BYTES) return;
                exceededByteLimit = true;
                controller.abort(new DOMException('Subtitle response exceeded byte limit', 'AbortError'));
            },
        });
        const content = typeof res.data === 'string' ? res.data : String(res.data);
        if (new TextEncoder().encode(content).byteLength > MAX_SUBTITLE_BYTES) {
            throw new Error('Native subtitle response exceeded byte limit');
        }
        return content;
    } catch (error) {
        if (exceededByteLimit) throw new Error('Native subtitle response exceeded byte limit');
        throw error;
    } finally {
        signal.removeEventListener('abort', forwardAbort);
    }
}

async function fetchSubtitleText(url: string, signal: AbortSignal): Promise<string> {
    const hostApiUrl = resolveHostApiSubtitleUrl(url);
    if (hostApiUrl) {
        return fetchHostSubtitleText(hostApiUrl, signal);
    }

    if (!/^https:\/\//i.test(url) || /\\|%(?:2f|5c)/i.test(url.split(/[?#]/, 1)[0] || '')) {
        throw new Error('Blocked ambiguous external subtitle URL');
    }
    const result = await fetchSafeMediaText(url, {
        maxBytes: MAX_SUBTITLE_BYTES,
        timeoutMs: SUBTITLE_FETCH_TIMEOUT_MS,
        signal,
        headers: {
            Accept: 'text/vtt, application/x-subrip, text/plain;q=0.9',
        },
    });
    if (!result) throw new Error('External subtitle request failed');
    return result.text;
}

async function fetchSubtitleFromUrl(
    url: string,
    generation: number,
    expectedTrackKey: string,
    signal: AbortSignal,
): Promise<boolean> {
    try {
        const content = await fetchSubtitleText(url, signal);
        if (!isCurrentTrackRequest(generation, expectedTrackKey)) return false;
        if (!content) return false;
        const lyrics = parseSubtitleContent(content);
        if (lyrics.length > 0) {
            const tk = getTrackKey();
            if (tk) lastTrackKey = tk;
            currentLyrics = lyrics;
            schedulePreTranslation(lyrics, 100);
            updateLyrics();
            return true;
        }
    } catch (err) {
        if (signal.aborted) return false;
        Logger.error('[LearnerMode] Error fetching subtitle:', err);
    }
    return false;
}

async function fetchLrcByHash(
    hash: string,
    generation: number,
    expectedTrackKey: string,
    signal: AbortSignal,
): Promise<boolean> {
    // Media hashes are `<workId>/<trackIndex>` (see src/api/Media.ts). Encoding
    // the whole hash would turn the separator into `%2F`, which the host-API URL
    // guard rejects as an ambiguous path — so every native LRC lookup threw and
    // works without `availableLyrics` showed no subtitles at all. The shared
    // builder encodes each segment while preserving the `/` separators.
    const streamPath = buildMediaPathFromHash(hash, 'stream');
    if (!streamPath) {
        Logger.debug('[LearnerMode] Skipping unsafe native LRC hash:', hash);
        return false;
    }

    try {
        const content = await fetchSubtitleText(streamPath, signal);
        if (!isCurrentTrackRequest(generation, expectedTrackKey)) return false;
        if (!content) return false;
        const lyrics = parseLrcContent(content);
        if (lyrics.length > 0) {
            const tk = getTrackKey();
            if (tk) lastTrackKey = tk;
            currentLyrics = lyrics;
            schedulePreTranslation(lyrics, 100);
            updateLyrics();
            return true;
        }
    } catch (err) {
        if (signal.aborted) return false;
        Logger.debug('[LearnerMode] Error fetching LRC by hash:', err);
    }
    return false;
}

async function fetchLrcForCurrentTrack(): Promise<void> {
    const track = bridge.currentTrack;
    if (!track) return;
    const trackHash = track.hash || track.src || track.mediaStreamUrl || track.media_stream_url || '';
    if (!trackHash || trackHash === lastLrcTrackHash) return;
    if (lrcFetchAttemptedHashes.has(trackHash)) return;
    if (lrcFetchPromise) return lrcFetchPromise;
    const generation = trackTasks.token;
    const expectedTrackKey = getTrackKey() || trackHash;
    const requestController = new AbortController();
    lrcFetchAbortController = requestController;
    const request = _fetchLrcInner(
        track,
        trackHash,
        generation,
        expectedTrackKey,
        requestController.signal,
    ).then((fetched) => {
        if (!isCurrentTrackRequest(generation, expectedTrackKey)) return;
        if (fetched) {
            lrcFetchAttemptedHashes.add(trackHash);
            lrcRetryAttempts.delete(trackHash);
            return;
        }
        // Authentication failures are deterministic for the current host
        // session. Do not hammer check-lrc, but leave availableLyrics discovery
        // eligible so late track metadata can still supply a native subtitle.
        if (lrcApiDeniedHashes.has(trackHash)) {
            lrcRetryAttempts.delete(trackHash);
            return;
        }
        const attempt = lrcRetryAttempts.get(trackHash) || 0;
        const delay = LRC_RETRY_DELAYS_MS[attempt];
        if (delay == null) return;
        lrcRetryAttempts.set(trackHash, attempt + 1);
        trackTasks.schedule(
            () => fetchLrcForCurrentTrack().catch(err => Logger.error('[LearnerMode] LRC retry failed:', err)),
            delay,
            () => getTrackKey() === expectedTrackKey && currentLyrics.length === 0,
        );
    });
    lrcFetchPromise = request;
    const finalizeRequest = () => {
        if (lrcFetchPromise !== request) return;
        lrcFetchPromise = null;
        if (lrcFetchAbortController === requestController) lrcFetchAbortController = null;

        // Some host builds attach availableLyrics while check-lrc is already
        // in flight. Its watcher deliberately shares the active request, then
        // queues one post-flight discovery so a 401/403 response cannot swallow
        // the newly arrived native subtitle.
        const shouldRefreshAvailableLyrics = queuedAvailableLyricsHash === trackHash
            && isCurrentTrackRequest(generation, expectedTrackKey)
            && currentLyrics.length === 0;
        if (queuedAvailableLyricsHash === trackHash) queuedAvailableLyricsHash = null;
        if (shouldRefreshAvailableLyrics) {
            fetchLrcForCurrentTrack().catch(err => (
                Logger.error('[LearnerMode] Queued availableLyrics fetch failed:', err)
            ));
        }
    };
    // A two-branch continuation performs cleanup without creating the rejected
    // derivative that an ignored Promise.finally() would leave behind.
    void request.then(finalizeRequest, finalizeRequest);
    return request;
}

async function _fetchLrcInner(
    track: PlayerTrack,
    trackHash: string,
    generation: number,
    expectedTrackKey: string,
    signal: AbortSignal,
): Promise<boolean> {
    let fetched = false;
    if (signal.aborted || !isCurrentTrackRequest(generation, expectedTrackKey)) return false;

    // Priority 1: availableLyrics
    if (track.availableLyrics?.length) {
        const trackTitle = (track.title || '').replace(/\.[^.]+$/, '');
        const sorted = [...track.availableLyrics].sort((a: AvailableLyric, b: AvailableLyric) => {
            const aMatch = trackTitle && (a.title || '').replace(/\.[^.]+$/, '') === trackTitle ? 0 : 1;
            const bMatch = trackTitle && (b.title || '').replace(/\.[^.]+$/, '') === trackTitle ? 0 : 1;
            return aMatch - bMatch;
        });
        for (const lyricFile of sorted) {
            const lyricUrl = lyricFile.mediaStreamUrl
                || lyricFile.media_stream_url
                || lyricFile.mediaDownloadUrl
                || lyricFile.media_download_url;
            if (!lyricUrl) continue;
            try {
                fetched = await fetchSubtitleFromUrl(lyricUrl, generation, expectedTrackKey, signal);
                if (fetched) break;
            }
            catch (err) { Logger.error('[LearnerMode] Error fetching subtitle:', err); }
        }
    }

    // Priority 2: /api/media/check-lrc
    if (!fetched && !lrcApiDeniedHashes.has(trackHash)) {
        const workId = bridge.currentWorkId;
        if (workId) {
            const queue = bridge.queue;
            const trackIndex = queue.findIndex((t: PlayerTrack) => t.hash === track.hash || t.mediaStreamUrl === track.mediaStreamUrl || t.src === track.src);
            const candidates = new Set<number>();
            if (trackIndex >= 0) candidates.add(trackIndex);
            const fallback = bridge.queueIndex;
            if (Number.isFinite(fallback) && fallback >= 0) candidates.add(fallback);

            if (candidates.size === 0) {
                fetched = await fetchLrcByHash(trackHash, generation, expectedTrackKey, signal);
            } else {
                for (const idx of candidates) {
                    try {
                        const checkRes = await bridge.axios.get<{ result: boolean; hash?: string }>(
                            `/api/media/check-lrc/${workId}/${idx}`,
                            { signal, timeout: SUBTITLE_FETCH_TIMEOUT_MS },
                        );
                        if (!isCurrentTrackRequest(generation, expectedTrackKey)) return false;
                        if (!checkRes.data.result || !checkRes.data.hash) continue;
                        fetched = await fetchLrcByHash(
                            checkRes.data.hash,
                            generation,
                            expectedTrackKey,
                            signal,
                        );
                        if (fetched) break;
                    } catch (err) {
                        const status = (err as { response?: { status?: unknown }; status?: unknown })?.response?.status
                            ?? (err as { status?: unknown })?.status;
                        if (status === 401 || status === 403) {
                            lrcApiDeniedHashes.add(trackHash);
                            Logger.debug('[LearnerMode] Native LRC API unavailable for this host session');
                            break;
                        }
                        Logger.debug('[LearnerMode] Error fetching LRC:', err);
                    }
                }
            }
        }
    }

    if (signal.aborted || !isCurrentTrackRequest(generation, expectedTrackKey)) return false;
    if (fetched) lastLrcTrackHash = trackHash;
    return fetched;
}

// ---------------------------------------------------------------------------
// Pre-translation
// ---------------------------------------------------------------------------

function preTranslateAll(
    lyrics: Array<{ time: number; text: string }>,
    sourceLanguageHint: TranslationSourceHint = 'auto',
): void {
    if (lyrics.length === 0) return;
    const targetLang = getSecondaryTargetLanguage();
    const texts = lyrics.map(l => l.text?.trim()).filter(Boolean);
    if (texts.length === 0) return;

    // Very large subtitle files can exceed prefetch limits; still pre-translate
    // an initial window so early playback lines appear translated quickly.
    let prefetchTexts = texts;
    let windowedPrefetch = false;
    if (!TranslationService.canPrefetch(texts.length)) {
        prefetchTexts = texts.slice(0, 240);
        windowedPrefetch = true;
    }

    const uncached = prefetchTexts.filter(t =>
        (!isAlreadyTargetLanguage(t, targetLang, sourceLanguageHint)
            && !TranslationService.peekCached(t, targetLang, sourceLanguageHint, LEARNER_SECONDARY_TARGET))
        || ((sourceLanguageHint === 'zh' || (sourceLanguageHint === 'auto' && isChinese(t)))
            && !TranslationService.peekCached(t, 'ja', 'zh'))
    );
    if (uncached.length === 0) return;

    const first = uncached[0] || '';
    const last = uncached[uncached.length - 1] || '';
    const key = `${uncached.length}:${first.slice(0, 20)}:${last.slice(0, 20)}`;
    if (key === lastPreTranslatedKey || key === pretranslateInFlightKey) return;
    pretranslateInFlightKey = key;
    const generation = pretranslationTasks.token;
    const expectedTrackKey = getTrackKey();

    Logger.debug(`[LearnerMode] Pre-translating ${uncached.length}/${prefetchTexts.length} uncached lines${windowedPrefetch ? ' (windowed)' : ''}...`);

    pretranslateQueueKey = updateQueueKey(
        pretranslateQueueKey,
        buildTranslationQueueKey('learner:pretranslate', targetLang),
    );
    pretranslateJaQueueKey = updateQueueKey(
        pretranslateJaQueueKey,
        buildTranslationQueueKey('learner:pretranslate:ja', 'ja'),
    );

    const processBatch = async (
        batch: string[],
        priorityLabel: string,
        priority: Priority,
    ): Promise<boolean> => {
        if (batch.length === 0 || !pretranslationTasks.isCurrent(generation)) return false;
        const cnTexts: string[] = [];
        const allTexts: string[] = [];
        for (const text of batch) {
            const cn = sourceLanguageHint === 'zh'
                || (sourceLanguageHint === 'auto' && isChinese(text));
            if (cn && !TranslationService.peekCached(text, 'ja', 'zh')) cnTexts.push(text);
            // Chinese->Japanese is handled by the source-hinted lane below.
            if (!(cn && targetLang === 'ja')
                && !isAlreadyTargetLanguage(text, targetLang, sourceLanguageHint)
                && !TranslationService.peekCached(text, targetLang, sourceLanguageHint, LEARNER_SECONDARY_TARGET)) {
                allTexts.push(text);
            }
        }
        const tasks: Array<Promise<TranslationLaneResult>> = [];
        if (allTexts.length > 0) {
            tasks.push(TranslationService.translateBatch(allTexts, targetLang, {
                ...LEARNER_SECONDARY_TARGET,
                priority,
                cancellable: true,
                cancellableKey: pretranslateQueueKey,
                sourceLanguageHint,
            }).then(results => ({ inputs: allTexts, results })).catch(err => {
                Logger.warn(`[LearnerMode] ->${targetLang} ${priorityLabel} batch failed:`, err);
                return { inputs: allTexts, results: [] };
            }));
        }
        if (cnTexts.length > 0) {
            tasks.push(TranslationService.translateBatch(cnTexts, 'ja', {
                priority,
                cancellable: true,
                cancellableKey: pretranslateJaQueueKey,
                sourceLanguageHint: 'zh',
            }).then(results => ({ inputs: cnTexts, results })).catch(err => {
                Logger.warn(`[LearnerMode] CN->JA ${priorityLabel} batch failed:`, err);
                return { inputs: cnTexts, results: [] };
            }));
        }
        const completed = await Promise.all(tasks);
        if (!pretranslationTasks.isCurrent(generation)) return false;
        return allTranslationLanesSucceeded(completed);
    };

    const PRIORITY_BATCH_SIZE = 150;
    const finish = (succeeded: boolean) => {
        if (!pretranslationTasks.isCurrent(generation) || pretranslateInFlightKey !== key) return;
        pretranslateInFlightKey = null;
        lastPreTranslatedKey = succeeded ? key : null;
    };

    const bg = uncached.slice(PRIORITY_BATCH_SIZE);
    void processBatch(uncached.slice(0, PRIORITY_BATCH_SIZE), 'initial', Priority.NORMAL).then((succeeded) => {
        if (!pretranslationTasks.isCurrent(generation) || pretranslateInFlightKey !== key) return;
        if (!succeeded || bg.length === 0) {
            finish(succeeded);
            return;
        }
        pretranslationTasks.schedule(
            () => void processBatch(bg, 'background', Priority.LOW).then(finish),
            50,
            () => getTrackKey() === expectedTrackKey,
        );
    }).catch(() => finish(false));
}

// ---------------------------------------------------------------------------
// The main updateLyrics() -- called on every timeupdate (~4Hz)
// ---------------------------------------------------------------------------

function updateLyrics() {
    const trackKey = getTrackKey();
    enterTrack(trackKey);

    const useWhisper = whisperActive;
    if (useWhisper) {
        _updateWhisperDisplay();
        return;
    }
    whisperCaptionDelayed.value = false;

    // Only try to find lyrics from other sources if we don't already have them
    if (currentLyrics.length === 0) {
        const data = findLyricsSource()
            || bridge.store?.state?.AudioPlayer?.lrcLines
            || getTextTracksAsLyrics();
        if (data?.length) {
            const newLyrics = normalizeLyricLines(data as Record<string, unknown>[]);
            if (newLyrics.length !== currentLyrics.length ||
                (newLyrics.length > 0 && newLyrics[0]?.text !== currentLyrics[0]?.text)) {
                // Defer batch pre-translation so the REALTIME translate() for the
                // current line fires first and gets the GpuScheduler fast-path
                // (worker idle → immediate execution, no queueing).
                schedulePreTranslation(newLyrics, 20);
            }
            currentLyrics = newLyrics;
        } else {
            const logKey = getTrackKey();
            if (logKey !== lastNoLyricsLogHash) {
                lastNoLyricsLogHash = logKey;
                Logger.debug('[LearnerMode] No lyrics found');
            }
        }
    }

    const display = getSubtitleDisplay();
    const fullText = display.fullText;
    const progressiveText = display.displayText;
    if (!fullText) {
        // Explicitly timed native cues expire. Clear both lanes while the fixed
        // subtitle container keeps player geometry stable.
        if (lastWhisperDisplayText || lastDisplayedText || secondaryText.value) {
            clearDisplay();
            lastText = '';
            lastWhisperDisplayText = '';
        }
        refreshVisibility();
        return;
    }

    const targetLang = getSecondaryTargetLanguage();
    const cn = isChinese(fullText);
    let primary: string;
    let hasUsableCachedJa = false;
    let splitIdx = -1;
    let hlStart = -1;
    if (cn) {
        const ja = TranslationService.peekCached(fullText, 'ja', 'zh');
        // This container is always lang="ja". Never put the Chinese source (or
        // an echo response) in it while CN -> JA is still pending. In JP+ZH the
        // source remains available in the secondary zh-CN lane.
        primary = ja?.trim() && ja.trim() !== fullText.trim() ? ja : '';
        hasUsableCachedJa = !!primary;
    } else if (karaokeMode.value) {
        // Karaoke ON: always show full text, control visibility via CSS
        primary = fullText;
        const indices = getKaraokeLineIndices(fullText, display);
        if (indices) {
            splitIdx = indices.splitIdx;
            hlStart = indices.hlStart;
        }
    } else {
        primary = progressiveText;
    }

    if ((cn || primary) && primary !== lastWhisperDisplayText) {
        updatePrimaryLine(primary, splitIdx, hlStart);
        lastWhisperDisplayText = primary;
    } else if (karaokeMode.value && (splitIdx >= 0 || hlStart >= 0)) {
        // Text unchanged but karaoke indices advanced — rAF handles smooth updates
        karaokeSplitIndex.value = splitIdx;
        karaokeHighlightStart.value = hlStart;
    }

    if (fullText !== lastText) {
        lastText = fullText;
        const alreadyTarget = isAlreadyTargetLanguage(fullText, targetLang);
        const cached = alreadyTarget
            ? fullText
            : TranslationService.peekCached(fullText, targetLang, 'auto', LEARNER_SECONDARY_TARGET);
        updateSecondaryLine(cached || progressiveText, !cached);
        lastDisplayedText = fullText;
        const token = ++translationToken;

        if (!cached && !alreadyTarget) {
            realtimeQueueKey = updateQueueKey(
                realtimeQueueKey,
                buildTranslationQueueKey('learner:realtime', targetLang),
            );
            TranslationService.translate(fullText, targetLang, {
                ...LEARNER_SECONDARY_TARGET,
                priority: Priority.REALTIME,
                cancellable: true,
                cancellableKey: realtimeQueueKey,
                sourceLanguageHint: 'auto',
            }).then(tr => {
                if (tr && lastText === fullText && token === translationToken) updateSecondaryLine(tr, false);
            }).catch(() => {});
        }
        if (cn && !hasUsableCachedJa) {
            realtimeJaQueueKey = updateQueueKey(
                realtimeJaQueueKey,
                buildTranslationQueueKey('learner:realtime:ja', 'ja'),
            );
            TranslationService.translate(fullText, 'ja', {
                priority: Priority.REALTIME,
                cancellable: true,
                cancellableKey: realtimeJaQueueKey,
                sourceLanguageHint: 'zh',
            }).then(tr => {
                if (tr?.trim() && tr.trim() !== fullText.trim()
                    && lastText === fullText && token === translationToken) {
                    updatePrimaryLine(tr);
                    lastWhisperDisplayText = tr;
                }
            }).catch(() => {});
        }
        // Look-ahead in non-whisper path too
        translateLookahead(fullText, targetLang);
    }

    refreshVisibility();
}

// ---------------------------------------------------------------------------
// Whisper display logic (extracted to keep updateLyrics readable)
// ---------------------------------------------------------------------------

function _updateWhisperDisplay() {
    const targetLang = getSecondaryTargetLanguage();
    const sourceLanguageHint = whisperSourceLanguageHint;

    if (whisperLines.length) {
        currentLyrics = whisperLines;
        const display = getWhisperDisplay();
        whisperCaptionDelayed.value = display.delayed === true;
        const fullText = display.fullText;
        if (fullText && fullText !== lastText) lastText = fullText;
        const secondaryRequestContext: WhisperTextRequestContext = {
            text: fullText,
            generation: translationToken,
            trackKey: getTrackKey(),
            sourceLanguageHint,
            targetLanguage: targetLang,
        };
        const secondaryRequestIsCurrent = () => isCurrentWhisperTextRequest(secondaryRequestContext, {
            text: lastDisplayedText,
            generation: translationToken,
            trackKey: getTrackKey(),
            sourceLanguageHint: whisperSourceLanguageHint,
            targetLanguage: getSecondaryTargetLanguage(),
        });

        let cachedSecondary: string | null = null;
        const translatable = fullText && isTranslatable(fullText);
        if (translatable) {
            const alreadyTarget = isAlreadyTargetLanguage(fullText, targetLang, sourceLanguageHint);
            cachedSecondary = alreadyTarget
                ? fullText
                : TranslationService.peekCached(
                    fullText,
                    targetLang,
                    sourceLanguageHint,
                    LEARNER_SECONDARY_TARGET,
                );
            if (!alreadyTarget && cachedSecondary?.trim() === fullText.trim()) cachedSecondary = null;
            // If not cached, fire async translation so it's ready next tick.
            if (!alreadyTarget && !cachedSecondary && shouldTickerTranslate(fullText)) {
                realtimeQueueKey = updateQueueKey(
                    realtimeQueueKey,
                    buildTranslationQueueKey('learner:whisper-live', targetLang),
                );
                TranslationService.translate(fullText, targetLang, {
                    ...LEARNER_SECONDARY_TARGET,
                    priority: Priority.REALTIME,
                    cancellable: true,
                    cancellableKey: realtimeQueueKey,
                    sourceLanguageHint,
                }).then(tr => {
                    if (tr && tr.trim() !== fullText.trim() && secondaryRequestIsCurrent()) {
                        updateSecondaryLine(tr, false);
                        lastSecondaryShown = tr;
                    }
                }).catch(() => {});
            }
            const chineseSource = sourceLanguageHint === 'zh'
                || (sourceLanguageHint === 'auto' && isChinese(fullText));
            if (chineseSource && targetLang !== 'ja' && !TranslationService.peekCached(fullText, 'ja', 'zh')) {
                realtimeJaQueueKey = updateQueueKey(
                    realtimeJaQueueKey,
                    buildTranslationQueueKey('learner:whisper-live:ja', 'ja'),
                );
                TranslationService.translate(fullText, 'ja', {
                    priority: Priority.REALTIME,
                    cancellable: true,
                    cancellableKey: realtimeJaQueueKey,
                    sourceLanguageHint: 'zh',
                }).catch(() => {});
            }
            // Look-ahead: pre-translate next 10 upcoming lines
            translateLookahead(fullText, targetLang, sourceLanguageHint);
        }
        if (fullText && fullText !== lastDisplayedText) {
            lastDisplayedText = fullText;
            lastSecondaryShown = '';
            if (!translatable) {
                // Pure punctuation/symbols — clear secondary, nothing to translate
                updateSecondaryLine('', false);
            } else if (cachedSecondary) {
                updateSecondaryLine(cachedSecondary, false);
                lastSecondaryShown = cachedSecondary;
            } else {
                // No cached translation yet — show empty placeholder (prevents stale
                // text from previous segment). Async callback or cache-fill on next tick
                // will populate when translation arrives.
                updateSecondaryLine('', true);
            }
        } else if (translatable && cachedSecondary && cachedSecondary !== lastSecondaryShown) {
            // Translation became available (e.g. translateAhead filled the cache)
            updateSecondaryLine(cachedSecondary, false);
            lastSecondaryShown = cachedSecondary;
        }
        // In karaoke mode, dedup against fullText (not progressive displayText) so
        // the rAF 60fps path can take over once the segment is established.
        const karaokeDedup = karaokeMode.value ? (fullText || display.displayText) : display.displayText;
        if (display.displayText && karaokeDedup !== lastWhisperDisplayText) {
            const cn = sourceLanguageHint === 'zh'
                || (sourceLanguageHint === 'auto' && isChinese(display.displayText));
            let prim = display.displayText;
            let splitIdx = -1;
            let hlStart = -1;
            if (cn) {
                const ja = TranslationService.peekCached(fullText, 'ja', 'zh');
                const usableJa = ja?.trim() && ja.trim() !== fullText.trim() ? ja : null;
                // The primary container is explicitly Japanese. Keep it empty
                // until CN->JA completes instead of temporarily labelling raw
                // Chinese as lang="ja". The raw source remains visible in the
                // Chinese secondary lane throughout this transition.
                prim = usableJa || '';
                if (!usableJa) {
                    realtimeJaQueueKey = updateQueueKey(
                        realtimeJaQueueKey,
                        buildTranslationQueueKey('learner:whisper-live:ja', 'ja'),
                    );
                    TranslationService.translate(fullText, 'ja', {
                        priority: Priority.REALTIME,
                        cancellable: true,
                        cancellableKey: realtimeJaQueueKey,
                        sourceLanguageHint: 'zh',
                    }).then(ja2 => {
                        const jaRequestIsCurrent = isCurrentWhisperTextRequest(
                            { ...secondaryRequestContext, targetLanguage: 'ja' },
                            {
                                text: lastDisplayedText,
                                generation: translationToken,
                                trackKey: getTrackKey(),
                                sourceLanguageHint: whisperSourceLanguageHint,
                                targetLanguage: 'ja',
                            },
                        );
                        if (ja2 && ja2.trim() !== fullText.trim() && jaRequestIsCurrent) {
                            updatePrimaryLine(ja2);
                            lastWhisperDisplayText = ja2;
                        }
                    }).catch(() => {});
                }
            } else if (karaokeMode.value && fullText) {
                // Only exact worker-provided word timestamps may drive
                // word/character karaoke. Segment-only Whisper output remains
                // a stable full line instead of presenting uniform estimates
                // as if they were aligned to speech.
                prim = fullText;
                const indices = whisperTimingQuality === 'word'
                    ? getKaraokeLineIndices(fullText, display, true)
                    : null;
                if (indices) {
                    splitIdx = indices.splitIdx;
                    hlStart = indices.hlStart;
                } else {
                    clearKaraokeState();
                }
            }
            updatePrimaryLine(prim, splitIdx, hlStart);
            lastWhisperDisplayText = karaokeMode.value ? (fullText || prim) : prim;
        } else if (display.displayText && karaokeMode.value) {
            // Karaoke: same segment — rAF handles smooth 60fps inter-frame updates.
            // Also recompute on every tick for responsive scrubbing (even while paused).
            if (whisperTimingQuality === 'word') {
                const ft = display.fullText || display.displayText;
                const indices = getKaraokeLineIndices(ft, display, true);
                if (indices) {
                    const newSplit = indices.splitIdx;
                    const newHl = indices.hlStart;
                    if (newSplit !== karaokeSplitIndex.value) karaokeSplitIndex.value = newSplit;
                    if (newHl !== karaokeHighlightStart.value) karaokeHighlightStart.value = newHl;
                    // Ensure rAF is running for smooth playback updates
                    startKaraokeRaf();
                }
            } else {
                clearKaraokeState();
                karaokeSplitIndex.value = -1;
                karaokeHighlightStart.value = -1;
            }
        } else if (!display.displayText) {
            // Never present an expired ASR cue as current speech. The container
            // has fixed geometry, so clearing does not shift the player.
            clearDisplay();
            lastText = '';
            lastWhisperDisplayText = '';
        }
        refreshVisibility();
        return;
    }

    // No whisperLines but whisperText exists
    whisperCaptionDelayed.value = false;
    if (whisperText) {
        const requestedText = whisperText;
        const requestContext: WhisperTextRequestContext = {
            text: requestedText,
            generation: whisperTextGeneration,
            trackKey: getTrackKey(),
            sourceLanguageHint,
            targetLanguage: targetLang,
        };
        const requestIsCurrent = () => isCurrentWhisperTextRequest(requestContext, {
            text: whisperText,
            generation: whisperTextGeneration,
            trackKey: getTrackKey(),
            sourceLanguageHint: whisperSourceLanguageHint,
            targetLanguage: getSecondaryTargetLanguage(),
        });
        if (requestedText !== lastText) lastText = requestedText;
        const wtTranslatable = isTranslatable(requestedText);
        const alreadyTarget = wtTranslatable
            && isAlreadyTargetLanguage(requestedText, targetLang, sourceLanguageHint);
        const cachedCandidate: string | null = wtTranslatable
            ? alreadyTarget ? requestedText : TranslationService.peekCached(
                requestedText,
                targetLang,
                sourceLanguageHint,
                LEARNER_SECONDARY_TARGET,
            )
            : null;
        const cached = !alreadyTarget && cachedCandidate?.trim() === requestedText.trim()
            ? null
            : cachedCandidate;
        if (wtTranslatable && !alreadyTarget && !cached && shouldTickerTranslate(requestedText)) {
            realtimeQueueKey = updateQueueKey(
                realtimeQueueKey,
                buildTranslationQueueKey('learner:whisper-live', targetLang),
            );
            TranslationService.translate(requestedText, targetLang, {
                ...LEARNER_SECONDARY_TARGET,
                priority: Priority.REALTIME,
                cancellable: true,
                cancellableKey: realtimeQueueKey,
                sourceLanguageHint,
            }).then(tr => {
                if (tr && tr.trim() !== requestedText.trim() && requestIsCurrent()
                    && (lastDisplayedText === requestedText || lastText === requestedText)) {
                    updateSecondaryLine(tr, false);
                    lastSecondaryShown = tr;
                }
            }).catch(() => {});
            const chineseSource = sourceLanguageHint === 'zh'
                || (sourceLanguageHint === 'auto' && isChinese(requestedText));
            if (chineseSource && targetLang !== 'ja') {
                realtimeJaQueueKey = updateQueueKey(
                    realtimeJaQueueKey,
                    buildTranslationQueueKey('learner:whisper-live:ja', 'ja'),
                );
                TranslationService.translate(requestedText, 'ja', {
                    priority: Priority.REALTIME,
                    cancellable: true,
                    cancellableKey: realtimeJaQueueKey,
                    sourceLanguageHint: 'zh',
                }).catch(() => {});
            }
        }
        if (requestedText !== lastDisplayedText) {
            lastDisplayedText = requestedText;
            lastSecondaryShown = '';
            if (!wtTranslatable) {
                updateSecondaryLine('', false);
            } else if (cached) {
                updateSecondaryLine(cached, false);
                lastSecondaryShown = cached;
            } else {
                updateSecondaryLine('', true);
            }
        } else if (wtTranslatable && cached && cached !== lastSecondaryShown) {
            updateSecondaryLine(cached, false);
            lastSecondaryShown = cached;
        }
        if (requestedText !== lastWhisperDisplayText) {
            const cn = sourceLanguageHint === 'zh'
                || (sourceLanguageHint === 'auto' && isChinese(requestedText));
            let prim = requestedText;
            if (cn) {
                const ja = TranslationService.peekCached(requestedText, 'ja', 'zh');
                const usableJa = ja?.trim() && ja.trim() !== requestedText.trim() ? ja : null;
                prim = usableJa || '';
                if (!usableJa) {
                    realtimeJaQueueKey = updateQueueKey(
                        realtimeJaQueueKey,
                        buildTranslationQueueKey('learner:whisper-live:ja', 'ja'),
                    );
                    TranslationService.translate(requestedText, 'ja', {
                        priority: Priority.REALTIME,
                        cancellable: true,
                        cancellableKey: realtimeJaQueueKey,
                        sourceLanguageHint: 'zh',
                    }).then(ja2 => {
                        if (ja2 && ja2.trim() !== requestedText.trim()
                            && requestIsCurrent() && lastDisplayedText === requestedText) {
                            updatePrimaryLine(ja2);
                            lastWhisperDisplayText = ja2;
                        }
                    }).catch(() => {});
                }
            }
            updatePrimaryLine(prim);
            lastWhisperDisplayText = prim;
        }
    }
    refreshVisibility();
}

// ---------------------------------------------------------------------------
// Whisper event handlers
// ---------------------------------------------------------------------------

function applyWhisperRuntimeMetadata(payload: WhisperUpdatePayload) {
    whisperFromCache = !!payload.fromCache;
    whisperLive = typeof payload.live === 'boolean' ? payload.live : false;
    if (typeof payload.leadSec === 'number') {
        whisperLeadSec = Math.max(0, payload.leadSec);
    }
    whisperSourceLanguageHint = payload.sourceLanguageHint || 'auto';
    whisperTimingQuality = payload.timingQuality || 'segment';
    whisperText = sanitizeWhisperText(payload.text);
}

function applyWhisperSegments(payload: WhisperUpdatePayload) {
    const segments = Array.isArray(payload.segments) ? payload.segments : [];
    if (segments.length === 0) {
        if (payload.source === 'complete' || payload.final) {
            whisperLines = [];
            resetLaggedWhisperCaption();
            resetDedupState({ includeWhisperDisplay: true, bumpTranslationToken: true });
            clearDisplay();
        }
        return;
    }
    const newLines = normalizeWhisperSubtitleLines(segments);
    if (newLines.length > 0) {
        schedulePreTranslation(newLines, 20, whisperSourceLanguageHint);
        const newlyArrived = newLines.filter((line) => {
            const signature = `${line.time}:${line.endTime ?? ''}:${line.text}`;
            if (seenWhisperArrivalSignatures.has(signature)) return false;
            seenWhisperArrivalSignatures.add(signature);
            return true;
        });
        if (newlyArrived.length > 0) {
            const audioTime = getAudioElement()?.currentTime;
            const latestExpiredArrival = payload.live === true && typeof audioTime === 'number'
                ? newlyArrived.filter(line => (
                    typeof line.endTime === 'number'
                    && audioTime >= line.endTime + 0.75
                )).at(-1)
                : undefined;
            if (latestExpiredArrival) {
                laggedWhisperLine = latestExpiredArrival;
                laggedWhisperUntilMs = performance.now() + LAGGED_WHISPER_DWELL_MS;
            } else {
                laggedWhisperLine = null;
                laggedWhisperUntilMs = 0;
            }
        }
    }
    whisperLines = newLines;
}

function handleWhisperUpdate(payload: WhisperUpdatePayload) {
    if (!payload) return;
    whisperTextGeneration++;
    whisperActive = true;
    whisperStatusSessionActive.value = true;
    applyWhisperRuntimeMetadata(payload);
    ensureWhisperTicker(whisperLive ? 80 : 200);
    applyWhisperSegments(payload);
    // Don't reset lastWhisperDisplayText here — let _updateWhisperDisplay()
    // naturally detect changes. Resetting forces re-renders that cause flashing
    // when paused and whisper reprocesses the same audio with slightly different output.
    // Don't reset lastText either — let the natural dedup comparison handle it.
    // This prevents unnecessary re-translation and secondary line flicker.
    updateLyrics();
}

function handleWhisperClear() {
    whisperTextGeneration++;
    whisperActive = false;
    whisperStatusSessionActive.value = false;
    whisperText = '';
    whisperLines = [];
    whisperFromCache = false;
    whisperLive = false;
    whisperLeadSec = 0;
    whisperSourceLanguageHint = 'auto';
    whisperTimingQuality = 'segment';
    resetLaggedWhisperCaption();
    resetDedupState({ includeWhisperDisplay: true });
    clearWhisperTicker();
    resetLearnerTranslationQueues();
    clearDisplay();
    refreshVisibility();
}

function ensureWhisperTicker(intervalMs = 80) {
    if (whisperTickerId !== null && whisperTickerInterval === intervalMs) return;
    if (whisperTickerId !== null) clearInterval(whisperTickerId);
    whisperTickerInterval = intervalMs;
    whisperTickerId = window.setInterval(() => { if (whisperActive) updateLyrics(); }, intervalMs);
}

function clearWhisperTicker() {
    if (whisperTickerId === null) return;
    clearInterval(whisperTickerId);
    whisperTickerId = null;
    whisperTickerInterval = 80;
}

// ---------------------------------------------------------------------------
// Track / work change
// ---------------------------------------------------------------------------

function onTrackOrWorkChange() {
    // Reset blur to default from settings
    isBlurred.value = !!learnerBlur.value;

    // Host events can arrive before currentTrack/queue switches over. Always
    // clear the outgoing track immediately, but only fetch/render when the
    // bridge already exposes a genuinely new track key. Store watchers handle
    // the common event-first, state-second ordering.
    const enteredTrack = enterTrack(getTrackKey());
    if (!enteredTrack) resetTrackRuntimeState();
    bindAudioTimeUpdate();
    if (!enteredTrack) return;
    fetchLrcForCurrentTrack().catch(err => Logger.error('[LearnerMode] LRC fetch failed:', err));
    updateLyrics();
}

// ---------------------------------------------------------------------------
// Controls: seek, speed
// ---------------------------------------------------------------------------

function seek(offset: number) {
    const audio = getAudioElement();
    if (!audio) return;
    // Prefer whisperLines when whisper is active (currentLyrics may lag one tick behind)
    const lines = whisperActive && whisperLines.length > 0 ? whisperLines
        : currentLyrics.length > 0 ? currentLyrics
        : whisperLines;
    if (!lines.length) {
        audio.currentTime = Math.max(0, audio.currentTime + offset * 5);
        return;
    }
    const now = audio.currentTime;
    const firstAfter = lines.findIndex(l => l.time > now);
    let idx: number;
    if (firstAfter === -1) {
        // Past all lines — current is the last line
        idx = lines.length - 1;
    } else if (firstAfter === 0) {
        // Before or exactly at the first line
        idx = 0;
    } else {
        idx = firstAfter - 1;
    }
    const rawTarget = idx + offset;
    let targetIdx = Math.max(0, Math.min(lines.length - 1, rawTarget));
    // Ensure backward seek reaches a meaningfully earlier time position.
    // Handles near-duplicate timestamps from word-level grouping and
    // floating-point precision after seeking to line.time + 0.01.
    if (offset < 0) {
        while (targetIdx > 0 && lines[targetIdx].time > now - 0.05) {
            targetIdx--;
        }
    }
    // If clamped (no more segments in this direction), fall back to time-based seek
    if (targetIdx === idx && offset !== 0) {
        audio.currentTime = Math.max(0, audio.currentTime + offset * 5);
        if (audio.paused) audio.play().catch(err => Logger.warn('[LearnerMode] Audio play after seek failed:', err));
        return;
    }
    const target = lines[targetIdx];
    if (target) {
        Logger.debug(`[LearnerMode] seek(${offset}): now=${now.toFixed(2)}, idx=${idx}, target=${targetIdx}/${lines.length}, time=${target.time.toFixed(2)}`);
        audio.currentTime = target.time + 0.01;
        if (audio.paused) audio.play().catch(err => Logger.warn('[LearnerMode] Audio play after seek failed:', err));
        // Immediately pre-populate display so the user doesn't see a blank flash.
        // Reset dedup state so updateLyrics() will process the new position.
        resetDedupState({ includeWhisperDisplay: true, bumpTranslationToken: true });
        resetRealtimeQueues();
        updateLyrics();
    }
}

function syncSpeedUI(rate: number) {
    document.querySelectorAll('.asmr-speed-swatch').forEach(el => {
        el.textContent = `${rate}x`;
        el.classList.toggle('modified', rate !== 1.0);
    });
    document.querySelectorAll<HTMLInputElement>('.asmr-speed-slider').forEach(s => { s.value = String(rate); });
    document.querySelectorAll('.asmr-speed-slider-label').forEach(el => { el.textContent = `${rate}x`; });
}

function setPlaybackRate(rate: number) {
    playbackRate.value = rate;
    Config.set('playbackRate', rate);
    const audio = boundAudio || getAudioElement();
    if (audio) audio.playbackRate = rate;
    syncSpeedUI(rate);
}

function cyclePlaybackRate() {
    const rates = [1.0, 1.25, 1.5, 2.0, 0.5, 0.75];
    let idx = (rates.indexOf(playbackRate.value) + 1) % rates.length;
    if (idx < 0) idx = 0;
    setPlaybackRate(rates[idx]);
}

// ---------------------------------------------------------------------------
// Drawer width sync
// ---------------------------------------------------------------------------

function syncDrawerWidth() {
    const drawer = document.querySelector('.q-drawer--left') as HTMLElement | null;
    const isDesktop = typeof window.matchMedia === 'function'
        ? window.matchMedia('(min-width: 601px)').matches
        : window.innerWidth >= 601;
    const isOverlayDrawer = !!drawer && (
        drawer.classList.contains('q-drawer--on-top')
        || drawer.classList.contains('q-drawer--mobile')
    );
    const drawerVisible = !!drawer && (() => {
        const style = window.getComputedStyle(drawer);
        return style.display !== 'none' && style.visibility !== 'hidden';
    })();
    const width = drawer && isDesktop && drawerVisible && !isOverlayDrawer
        ? `${Math.round(drawer.getBoundingClientRect().width)}px`
        : '0px';
    document.documentElement.style.setProperty('--asmr-drawer-width', width);

    // Keep collapsed subtitles on the same stacking layer as the mini-player.
    const bar = getPlayerBar();
    const playerBar = bar?.matches('.player-bar, .q-footer, .player-bar-container')
        ? bar
        : bar?.querySelector('.player-bar, .q-footer, .player-bar-container') as HTMLElement | null;
    const zIndex = Number.parseInt(playerBar ? window.getComputedStyle(playerBar).zIndex : '', 10);
    if (Number.isFinite(zIndex) && zIndex > 0) {
        document.documentElement.style.setProperty('--asmr-player-bar-z-index', String(zIndex));
    } else {
        document.documentElement.style.removeProperty('--asmr-player-bar-z-index');
    }
}

// ---------------------------------------------------------------------------
// Cover height adjustment
// ---------------------------------------------------------------------------
// The host app sets the album art q-img max-height to
//   calc(playerH - 395px - safeArea)
// but doesn't account for injected elements (subtitles, visualizer).
// We wrap the host's calc() expression and subtract the injected height.

function adjustCoverForSubtitles() {
    const player = document.querySelector('.audio-player:not(.asmr-player-fullscreen)') as HTMLElement;
    if (!player) return;

    const qImg = player.querySelector('.albumart .q-img') as HTMLElement;
    if (!qImg) return;

    const subsRoot = player.querySelector('#asmr-learner-subs-root') as HTMLElement;
    const vizRoot = player.querySelector('#asmr-visualizer-root') as HTMLElement;
    const injectedH = (subsRoot?.offsetHeight || 0) + (vizRoot?.offsetHeight || 0);

    const current = qImg.style.maxHeight;

    // If the current value differs from what we last set, the host updated it
    if (current && current !== lastSetCoverMaxH) {
        qImg.dataset.asmrOrigMaxH = current;
    }

    const base = qImg.dataset.asmrOrigMaxH || current;
    if (!base) return;

    let newVal: string;
    if (injectedH <= 0) {
        newVal = base;
    } else {
        newVal = `calc(${base} - ${injectedH}px)`;
    }

    if (newVal === current) return; // No change needed — prevents infinite loop
    qImg.style.maxHeight = newVal;
    lastSetCoverMaxH = newVal;
}

function setupCoverAdjustment() {
    const player = document.querySelector('.audio-player') as HTMLElement;
    if (!player) return;

    // Observe the q-img style for host recalculations (e.g. on resize) — coalesce via rAF
    const qImg = player.querySelector('.albumart .q-img') as HTMLElement;
    if (qImg && !coverImgObserver) {
        coverImgObserver = new MutationObserver(() => {
            if (rafCoverAdjust) return;
            rafCoverAdjust = requestAnimationFrame(() => { rafCoverAdjust = 0; adjustCoverForSubtitles(); });
        });
        coverImgObserver.observe(qImg, { attributes: true, attributeFilter: ['style'] });
    }

    // Observe our subtitle container for size changes — coalesce via rAF
    const subsRoot = player.querySelector('#asmr-learner-subs-root') as HTMLElement | null;
    if (typeof ResizeObserver !== 'undefined') {
        subsResizeObserver ??= new ResizeObserver(() => {
            scheduleSubtitleOverflowMeasure();
            if (rafCoverAdjust) return;
            rafCoverAdjust = requestAnimationFrame(() => { rafCoverAdjust = 0; adjustCoverForSubtitles(); });
        });
        // Observe the rendered panel itself as well as its mount root. The host
        // can move the same Vue root between player shells without resizing the
        // root synchronously, while the panel width changes immediately.
        for (const target of [player, subsRoot, expandedRef.value, collapsedRef.value]) {
            if (target) subsResizeObserver.observe(target);
        }
    }

    adjustCoverForSubtitles();
}

function teardownCoverAdjustment() {
    coverImgObserver?.disconnect();
    coverImgObserver = null;
    subsResizeObserver?.disconnect();
    subsResizeObserver = null;
    lastSetCoverMaxH = '';

    // Restore the host's original max-height
    const qImg = document.querySelector('.audio-player .albumart .q-img') as HTMLElement;
    if (qImg?.dataset.asmrOrigMaxH) {
        qImg.style.maxHeight = qImg.dataset.asmrOrigMaxH;
        delete qImg.dataset.asmrOrigMaxH;
    }
}

// ---------------------------------------------------------------------------
// Overflow menu helpers (imperative, for host button capture)
// ---------------------------------------------------------------------------

function triggerHostMenuAction(iconName: string) {
    if (!hostMoreBtn) return;
    hostMoreBtn.click();
    lifecycleTasks.schedule(() => {
        const menus = document.querySelectorAll('.q-menu');
        const menu = menus.length > 0 ? menus[menus.length - 1] : null;
        if (menu) {
            const items = Array.from(menu.querySelectorAll('.q-item'));
            const target = items.find(i => i.innerHTML.includes(iconName));
            if (target) (target as HTMLElement).click();
        }
    }, 100);
}

function clearOverflowTransientListeners(): void {
    overflowTransientCleanup?.();
    overflowTransientCleanup = null;
}

function downloadCurrentTrack() {
    const track = bridge.currentTrack;
    if (!track) return;
    const url = track.mediaDownloadUrl || track.media_download_url || track.file_url;
    if (!url) return;
    // Use cached blob URL if already in AudioCache (avoids re-downloading)
    const href = AudioCache.objectUrls.get(url) || url;
    const a = document.createElement('a');
    a.href = href; a.download = track.title || ''; a.style.display = 'none';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

function toggleOverflow(event: Event) {
    const btn = (event.currentTarget || event.target) as HTMLElement;
    overflowOpen.value = !overflowOpen.value;
    if (overflowOpen.value) {
        const rect = btn.getBoundingClientRect();
        const sidebar = document.querySelector('.q-drawer--left, .q-drawer') as HTMLElement | null;
        const minLeft = sidebar ? sidebar.getBoundingClientRect().right : 0;
        overflowStyle.value = {
            left: `${Math.max(minLeft, rect.left)}px`,
            bottom: `${window.innerHeight - rect.top + 8}px`,
            top: 'auto',
        };
    }
}

function closeOverflowOnOutsideClick(e: MouseEvent) {
    if (!overflowOpen.value) return;
    const target = e.target as Node;
    const overflowEl = document.getElementById('asmr-learner-overflow');
    const toggleEl = overflowToggleRef.value;
    if (overflowEl?.contains(target) || toggleEl?.contains(target)) return;
    overflowOpen.value = false;
}

// ---------------------------------------------------------------------------
// Imperative controls injection (captures host buttons into overflow menu)
// ---------------------------------------------------------------------------

/**
 * Inject learner controls into the player bar (for the collapsed/minibar view).
 * This is imperative because we're inserting Quasar-style buttons into the
 * host's player bar alongside its own buttons.
 */
function injectCollapsedControls() {
    const bar = getPlayerBar();
    if (!bar) return;
    const playerBar = bar.matches('.player-bar, .q-footer') ? bar : bar.querySelector('.player-bar, .q-footer');
    if (!playerBar || playerBar.querySelector('[data-asmr-learner-controls]')) return;

    const ctrl = createControlsEl(true);
    // Remove speed slider from bar controls
    const slider = ctrl.querySelector('.asmr-speed-slider-wrap');
    if (slider) slider.remove();

    const skipNextBtn = Array.from(playerBar.querySelectorAll('button')).find(btn => {
        if (btn.classList.contains('asmr-playlist-player-btn')) return false;
        if (btn.closest('.asmr-playlist-player-controls')) return false;
        if (btn.getAttribute('title')?.includes('Next Work')) return false;
        const icon = btn.querySelector('.material-icons, .q-icon');
        return icon && icon.textContent?.trim() === 'skip_next';
    });
    if (skipNextBtn?.parentElement) {
        skipNextBtn.parentElement.insertBefore(ctrl, skipNextBtn.nextSibling);
    } else {
        playerBar.appendChild(ctrl);
    }
    lifecycleTasks.schedule(() => captureControls(playerBar as HTMLElement, ctrl), 0);
}

/**
 * Inject learner controls into the expanded audio player view.
 */
function injectExpandedControls() {
    const player = document.querySelector('.audio-player') as HTMLElement | null;
    if (!player) return;
    const controls = player.querySelector('.row.self-center:not(.q-py-md)') as HTMLElement | null;
    if (!controls) return;
    const existing = controls.querySelector('.learner-controls') as HTMLElement | null;
    if (existing) {
        if (!existing.querySelector('.asmr-speed-slider-wrap')) {
            const overflowToggle = existing.querySelector('.learner-overflow-toggle');
            const slider = createSpeedSliderEl();
            overflowToggle ? existing.insertBefore(slider, overflowToggle) : existing.appendChild(slider);
        }
        lifecycleTasks.schedule(() => captureControls(controls, existing), 0);
        return;
    }
    const learnerCtrls = createControlsEl(false);
    controls.insertBefore(learnerCtrls, controls.firstChild);
    lifecycleTasks.schedule(() => captureControls(controls, learnerCtrls), 0);
}

/**
 * Playback can start while the host only renders its collapsed footer. The
 * controller mounts beside that footer so controls are immediately available;
 * move the live Vue root beside album art if the expanded player appears.
 */
function syncExpandedMountPoint() {
    const root = document.getElementById('asmr-learner-subs-root');
    const albumArt = document.querySelector('.audio-player .albumart');
    if (!root || !albumArt || root.previousElementSibling === albumArt) return;
    albumArt.after(root);
}

function createControlsEl(small: boolean): HTMLElement {
    const div = document.createElement('div');
    div.className = small ? 'learner-collapsed-controls' : 'learner-controls';
    div.dataset.asmrLearnerControls = '1';

    const createBtn = (icon: string, title: string, fn: (btn: HTMLElement) => void, isActive = false, extraClasses = '') => {
        const b = document.createElement('button');
        b.className = `q-btn q-btn-item non-selectable no-outline q-btn--flat q-btn--rectangle q-btn--dense q-ma-sm q-focusable q-hoverable learner-control-btn ${isActive ? 'learner-btn-active' : ''}`;
        b.title = title;
        b.ariaLabel = title;
        b.innerHTML = `<span class="q-focus-helper"></span><span class="q-btn__wrapper col row q-anchor--skip"><span class="q-btn__content text-center col items-center q-anchor--skip justify-center row"><i aria-hidden="true" role="img" class="q-icon material-icons">${icon}</i></span></span>`;
        if (extraClasses) b.classList.add(...extraClasses.split(' '));
        b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); fn(b); };
        return b;
    };

    div.append(
        createBtn('chevron_left', t('prevLine'), () => seek(-1)),
        createBtn('chevron_right', t('nextLine'), () => seek(1)),
        createBtn('translate', t('toggleJP'), () => {
            showJP.value = !showJP.value;
        }, !!showJP.value),
        createSpeedSliderEl(),
        // Overflow Toggle — must be last
        (() => {
            const btn = createBtn('more_vert', t('more'), (b) => {
                if (!overflowMenuEl) return;
                const isHidden = overflowMenuEl.classList.toggle('hidden');
                if (!isHidden) {
                    positionOverflowMenu(b);
                    clearOverflowTransientListeners();
                    const onResize = () => positionOverflowMenu(b);
                    window.addEventListener('resize', onResize);
                    const close = (e: MouseEvent) => {
                        const target = e.target as Node;
                        if (!overflowMenuEl?.contains(target) && !b.contains(target)) {
                            overflowMenuEl?.classList.add('hidden');
                            clearOverflowTransientListeners();
                        }
                    };
                    overflowTransientCleanup = () => {
                        document.removeEventListener('click', close, true);
                        window.removeEventListener('resize', onResize);
                    };
                    lifecycleTasks.schedule(() => document.addEventListener('click', close, true), 0);
                }
            }, false, 'learner-overflow-toggle');
            btn.classList.add('hidden');
            return btn;
        })(),
    );
    return div;
}

function createSpeedSliderEl(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'asmr-speed-slider-wrap';
    wrap.style.filter = 'opacity(1)';
    wrap.style.pointerEvents = 'auto';

    const label = document.createElement('span');
    label.className = 'asmr-speed-slider-label';
    label.textContent = `${playbackRate.value}x`;
    label.id = `speed-label-${Math.random().toString(36).substr(2, 9)}`;

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'asmr-speed-slider';
    slider.min = '0.5'; slider.max = '2'; slider.step = '0.25';
    slider.value = String(playbackRate.value);
    slider.ariaLabel = t('playbackSpeed') || 'Playback Speed';
    slider.setAttribute('aria-labelledby', label.id);
    slider.addEventListener('input', () => {
        const rate = parseFloat(slider.value);
        label.textContent = `${rate}x`;
        setPlaybackRate(rate);
    });

    wrap.append(label, slider);
    return wrap;
}

function positionOverflowMenu(toggleBtn: HTMLElement) {
    if (!overflowMenuEl) return;
    const EDGE = 8;
    const rect = toggleBtn.getBoundingClientRect();
    const sidebar = document.querySelector('.q-drawer--left, .q-drawer') as HTMLElement | null;
    const minLeft = sidebar ? sidebar.getBoundingClientRect().right + EDGE : EDGE;
    const menuW = overflowMenuEl.offsetWidth || 48;
    const maxLeft = window.innerWidth - menuW - EDGE;
    overflowMenuEl.style.left = `${Math.max(minLeft, Math.min(rect.left, maxLeft))}px`;
    const bottom = window.innerHeight - rect.top + 8;
    const menuH = overflowMenuEl.offsetHeight || 0;
    if (window.innerHeight - bottom < EDGE && menuH > 0) {
        overflowMenuEl.style.bottom = 'auto';
        overflowMenuEl.style.top = `${rect.bottom + 8}px`;
    } else {
        overflowMenuEl.style.bottom = `${bottom}px`;
        overflowMenuEl.style.top = 'auto';
    }
}

function captureControls(parent: HTMLElement, reference: HTMLElement) {
    const allButtons = Array.from(parent.querySelectorAll('button'));
    const excludedIcons = new Set([
        'skip_previous', 'skip_next', 'play_arrow', 'pause',
        'replay_5', 'forward_30', 'volume_up', 'volume_down',
        'chevron_left', 'chevron_right', 'translate', 'record_voice_over',
    ]);
    const candidates = allButtons.filter(btn => {
        if (btn.classList.contains('learner-control-btn')) return false;
        if (btn.classList.contains('asmr-whisper-btn')) return false;
        const icon = btn.querySelector('.q-icon, .material-icons');
        if (icon?.textContent) {
            const iconName = icon.textContent.trim();
            if (excludedIcons.has(iconName)) return false;
            if (iconName === 'more_horiz') {
                hostMoreBtn = btn;
                hostMoreBtn.style.display = 'none';
                return false;
            }
        }
        return true;
    }) as HTMLElement[];

    if (!overflowMenuEl) {
        overflowMenuEl = document.createElement('div');
        overflowMenuEl.className = 'learner-overflow-menu hidden';
        document.body.appendChild(overflowMenuEl);
        addPermanentOverflowItems();
    }

    candidates.forEach(btn => {
        if (originalParents.has(btn)) return;
        originalParents.set(btn, { parent: btn.parentElement as HTMLElement, nextSibling: btn.nextSibling });
        overflowMenuEl?.appendChild(btn);
    });

    const toggle = reference.querySelector('.learner-overflow-toggle') as HTMLElement;
    if (toggle) toggle.classList.remove('hidden');
}

function addPermanentOverflowItems() {
    if (!overflowMenuEl) return;
    const createItem = (icon: string, title: string, onClick: () => void, extraClass = '') => {
        const b = document.createElement('button');
        b.className = `q-btn q-btn-item non-selectable no-outline q-btn--flat q-btn--rectangle q-btn--dense q-ma-sm q-focusable q-hoverable learner-control-btn learner-btn-normal ${extraClass}`;
        b.title = title; b.ariaLabel = title;
        b.innerHTML = `<span class="q-focus-helper"></span><span class="q-btn__wrapper col row q-anchor--skip"><span class="q-btn__content text-center col items-center q-anchor--skip justify-center row"><i aria-hidden="true" role="img" class="q-icon material-icons">${icon}</i></span></span>`;
        b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); onClick(); };
        return b;
    };

    const whisperBtn = createItem('record_voice_over', t('aiTranscribe'), () => emit('whisper:toggle', undefined as never), 'asmr-whisper-btn');
    if (!Config.get('enableWhisper')) whisperBtn.style.display = 'none';
    overflowMenuEl.appendChild(whisperBtn);
    overflowMenuEl.appendChild(createItem('link', t('openWorkDetail'), () => triggerHostMenuAction('link')));
    overflowMenuEl.appendChild(createItem('folder', t('loadSubtitle'), () => triggerHostMenuAction('subtitles')));

    const speedBtn = createItem('speed', format('speedTitle', { rate: playbackRate.value }), () => cyclePlaybackRate(), 'asmr-speed-btn');
    const swatch = document.createElement('span');
    swatch.className = 'asmr-speed-swatch';
    swatch.textContent = `${playbackRate.value}x`;
    speedBtn.appendChild(swatch);
    overflowMenuEl.appendChild(speedBtn);

    overflowMenuEl.appendChild(createItem('download', t('downloadTrack'), () => downloadCurrentTrack()));
    const joiBtn = createItem('casino', t('joiToggle'), () => emit('joi:toggle', undefined as never), 'asmr-joi-btn');
    if (!Config.get('enableJoiTool')) joiBtn.style.display = 'none';
    overflowMenuEl.appendChild(joiBtn);

    const vizBtn = createItem('equalizer', t('vizToggle'), () => emit('viz:toggle', undefined as never), 'asmr-viz-btn');
    if (!Config.get('enableVisualizer')) vizBtn.style.display = 'none';
    overflowMenuEl.appendChild(vizBtn);
}

const OVERFLOW_CONFIG_MAP: Record<string, string> = {
    enableWhisper: '.asmr-whisper-btn',
    enableJoiTool: '.asmr-joi-btn',
    enableVisualizer: '.asmr-viz-btn',
};

function syncOverflowItemVisibility(configKey: string, enabled: boolean) {
    const selector = OVERFLOW_CONFIG_MAP[configKey];
    if (!selector || !overflowMenuEl) return;
    const btn = overflowMenuEl.querySelector(selector) as HTMLElement | null;
    if (btn) btn.style.display = enabled ? '' : 'none';
}

function restoreControls() {
    clearOverflowTransientListeners();
    originalParents.forEach((loc, btn) => {
        btn.style.display = '';
        if (loc.parent?.isConnected) {
            // nextSibling may no longer be a child of parent (Vue rebuilt the DOM)
            const ref = loc.nextSibling?.parentNode === loc.parent ? loc.nextSibling : null;
            try { loc.parent.insertBefore(btn, ref); } catch { /* DOM already torn down */ }
        }
    });
    if (hostMoreBtn) { hostMoreBtn.style.display = ''; hostMoreBtn = null; }
    originalParents.clear();
    overflowMenuEl?.remove();
    overflowMenuEl = null;
}

// Update style for translate button active state
function syncToggleJpBtn() {
    document.querySelectorAll('.learner-controls button, .learner-collapsed-controls button').forEach(btn => {
        const icon = btn.querySelector('i');
        if (icon && icon.textContent?.trim() === 'translate') {
            btn.classList.toggle('learner-btn-active', !!showJP.value);
        }
    });
}

// ---------------------------------------------------------------------------
// Vuex store watchers
// ---------------------------------------------------------------------------

function setupStoreWatchers() {
    const store = bridge.store;
    if (!store?.watch) return;

    const add = (fn: () => void) => storeWatcherCleanups.push(fn);

    // Helper to access AudioPlayer with extra host fields beyond our typed interface
    type APExtended = AudioPlayerState & Record<string, unknown>;
    const ap = (state: KikoeruStoreState) => state.AudioPlayer as APExtended;

    // Lyrics watchers — debounced so multiple field changes in one tick trigger a single updateLyrics()
    add(store.watch((state: KikoeruStoreState) => ap(state)?.lrcLines, () => scheduleUpdateLyrics(), { immediate: true }));
    add(store.watch((state: KikoeruStoreState) => ap(state)?.lyrics, () => scheduleUpdateLyrics(), { immediate: true }));
    add(store.watch((state: KikoeruStoreState) => ap(state)?.lyricLines, () => scheduleUpdateLyrics(), { immediate: true }));
    add(store.watch((state: KikoeruStoreState) => ap(state)?.subtitleLines, () => scheduleUpdateLyrics(), { immediate: true }));
    add(store.watch((state: KikoeruStoreState) => ap(state)?.subtitles, () => scheduleUpdateLyrics(), { immediate: true }));
    add(store.watch((state: KikoeruStoreState) => (ap(state)?.subtitle as Record<string, unknown> | undefined)?.lines, () => scheduleUpdateLyrics(), { immediate: true }));
    add(store.watch((state: KikoeruStoreState) => ap(state)?.currentLyric, (lyric: unknown) => { if (lyric) scheduleUpdateLyrics(); }));

    // Track change via queue[queueIndex]
    add(store.watch((state: KikoeruStoreState) => {
        const player = state.AudioPlayer;
        if (!player?.queue || typeof player.queueIndex !== 'number') return null;
        const track = player.queue[player.queueIndex];
        return track?.hash || track?.mediaStreamUrl || null;
    }, (trackKey: string | null) => {
        enterTrack(trackKey);
        trackTasks.schedule(() => {
            bindAudioTimeUpdate();
            if (trackKey) fetchLrcForCurrentTrack().catch(err => Logger.error('[LearnerMode] Store watcher LRC fetch failed:', err));
        }, 100, () => !trackKey || getTrackKey() === trackKey);
    }, { immediate: true }));

    // Audio source
    add(store.watch((state: KikoeruStoreState) => state.AudioPlayer?.source, (src: string | undefined) => {
        if (!src) return;
        trackTasks.schedule(
            () => fetchLrcForCurrentTrack().catch(err => Logger.error('[LearnerMode] Source watcher LRC fetch failed:', err)),
            200,
            () => bridge.store?.state?.AudioPlayer?.source === src,
        );
    }, { immediate: true }));

    // availableLyrics is populated asynchronously by some host builds. A late
    // native subtitle must wake discovery without invalidating an in-flight
    // request for the same track.
    add(store.watch((state: KikoeruStoreState) => {
        const player = state.AudioPlayer;
        if (!player?.queue || typeof player.queueIndex !== 'number') return '';
        const track = player.queue[player.queueIndex];
        return (track?.availableLyrics || []).map((lyric: AvailableLyric) => [
            lyric.hash,
            lyric.mediaStreamUrl,
            lyric.media_stream_url,
            lyric.mediaDownloadUrl,
            lyric.media_download_url,
        ].filter(Boolean).join(':')).join('|');
    }, (signature: string) => {
        if (!signature) return;
        const trackHash = bridge.currentTrack?.hash || bridge.currentTrack?.mediaStreamUrl || '';
        if (trackHash) lrcFetchAttemptedHashes.delete(trackHash);
        if (trackHash && lrcFetchPromise) queuedAvailableLyricsHash = trackHash;
        fetchLrcForCurrentTrack().catch(err => Logger.error('[LearnerMode] availableLyrics fetch failed:', err));
    }));

    // Playing state
    add(store.watch((state: KikoeruStoreState) => state.AudioPlayer?.playing, (playing: boolean | undefined) => {
        if (playing && currentLyrics.length === 0) fetchLrcForCurrentTrack().catch(err => Logger.error('[LearnerMode] Playing watcher LRC fetch failed:', err));
    }, { immediate: true }));

    // Player minimize/expand
    add(store.watch((state: KikoeruStoreState) => state.AudioPlayer?.hide, () => refreshVisibility()));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

onMounted(() => {
    storeWatcherCleanups.push(AppStore.subscribeWhisperState((state) => {
        whisperUiState.value = { ...state };
        whisperRunning = state.isTranscribing || state.isLoadingModel;
        if (whisperRunning || state.stage === 'recovering' || state.stage === 'error') {
            whisperStatusSessionActive.value = true;
        } else if (state.stage === 'idle' || state.stage === 'partial' || state.stage === 'complete') {
            whisperStatusSessionActive.value = false;
        }
        refreshVisibility();
    }));

    AppStore.setLearnerState({ isActive: true });

    boundTimeHandler = () => updateLyrics();

    // JPDB card state change listener (grading / mining updates)
    document.addEventListener('jpdb:card-graded', onJpdbCardGraded);

    // EventBus listeners
    on('whisper:clear', () => handleWhisperClear());
    on('whisper:update', (payload) => handleWhisperUpdate(payload));
    on('whisper:segment-translated', () => { if (whisperActive) updateLyrics(); });
    on('track:change', () => onTrackOrWorkChange());
    on('work:change', () => onTrackOrWorkChange());
    on('player:nav-prev', () => {
        if (currentLyrics.length > 0 || whisperLines.length > 0) seek(-1);
        else try { bridge.commit('AudioPlayer/PREVIOUS_TRACK'); } catch { /* mutation unavailable */ }
    });
    on('player:nav-next', () => {
        if (currentLyrics.length > 0 || whisperLines.length > 0) seek(1);
        else try { bridge.commit('AudioPlayer/NEXT_TRACK'); } catch { /* mutation unavailable */ }
    });
    on('player:rate-change', (payload) => {
        playbackRate.value = payload.rate;
        syncSpeedUI(payload.rate);
        syncToggleJpBtn();
    });

    // Vue route watcher
    const app = bridge.app as KikoeruApp | undefined;
    if (app?.$watch) {
        routeUnwatch = app.$watch('$route', (to: VueRoute) => {
            lifecycleTasks.cancelAll();
            resetTrackRuntimeState();
            const path = to?.path || '';
            if (!path.startsWith('/work/')) {
                // Clean up controls when navigating away
                restoreControls();
                clearWhisperTicker();
                unbindAudio();
            } else {
                lifecycleTasks.schedule(() => {
                    syncExpandedMountPoint();
                    injectExpandedControls();
                    injectCollapsedControls();
                    setupCoverAdjustment();
                    updateLyrics();
                    fetchLrcForCurrentTrack().catch(err => Logger.error('[LearnerMode] Route watcher LRC fetch failed:', err));
                }, 100);
            }
            refreshVisibility();
            bindAudioTimeUpdate();
        });
    }

    // Vuex store watchers
    setupStoreWatchers();

    // Initial injections
    syncExpandedMountPoint();
    injectExpandedControls();
    injectCollapsedControls();

    // Player appearance observer — coalesce via rAF to avoid layout thrashing on resize
    playerObserver = new MutationObserver(() => {
        if (rafPlayerObserver) return;
        rafPlayerObserver = requestAnimationFrame(() => {
            rafPlayerObserver = 0;
            syncExpandedMountPoint();
            injectExpandedControls();
            injectCollapsedControls();
            syncDrawerWidth();
        });
    });
    playerObserver.observe(document.body, { childList: true, subtree: true });

    // Drawer resize tracking — coalesce via rAF
    const drawer = document.querySelector('.q-drawer--left') as HTMLElement | null;
    if (drawer && typeof ResizeObserver !== 'undefined') {
        drawerResizeObserver = new ResizeObserver(() => {
            if (rafDrawerSync) return;
            rafDrawerSync = requestAnimationFrame(() => { rafDrawerSync = 0; syncDrawerWidth(); });
        });
        drawerResizeObserver.observe(drawer);
    }
    syncDrawerWidth();

    // Cover height adjustment — reduce album art to fit injected subtitles/visualizer
    lifecycleTasks.schedule(() => setupCoverAdjustment(), 200);

    // Bind audio
    bindAudioTimeUpdate();

    // Initial LRC fetch — immediate if track is already known, otherwise store
    // watchers (100ms/200ms delays) handle the case where the track appears later.
    if (bridge.currentTrack) {
        enterTrack(getTrackKey());
        fetchLrcForCurrentTrack().catch(err => Logger.error('[LearnerMode] Initial LRC fetch failed:', err));
    }

    // Outside-click listener for overflow
    document.addEventListener('click', closeOverflowOnOutsideClick, true);
    window.addEventListener('resize', scheduleSubtitleOverflowMeasure);
    void nextTick(setupSubtitleOverflowObserver);
    scheduleSubtitleOverflowMeasure();
});

onUnmounted(() => {
    AppStore.setLearnerState({ isActive: false });

    clearWhisperTicker();
    lifecycleTasks.cancelAll();
    resetTrackTasks();
    resetLearnerTranslationQueues();
    clearKaraokeState();
    unbindAudio();
    if (seekedDebounceTimer) { clearTimeout(seekedDebounceTimer); seekedDebounceTimer = null; }
    if (seekingRafId) { cancelAnimationFrame(seekingRafId); seekingRafId = 0; }
    if (rafPlayerObserver) { cancelAnimationFrame(rafPlayerObserver); rafPlayerObserver = 0; }
    if (rafCoverAdjust) { cancelAnimationFrame(rafCoverAdjust); rafCoverAdjust = 0; }
    if (rafDrawerSync) { cancelAnimationFrame(rafDrawerSync); rafDrawerSync = 0; }
    playerObserver?.disconnect();
    playerObserver = null;
    drawerResizeObserver?.disconnect();
    drawerResizeObserver = null;
    subtitleOverflowResizeObserver?.disconnect();
    subtitleOverflowResizeObserver = null;
    document.documentElement.style.removeProperty('--asmr-player-bar-z-index');
    teardownCoverAdjustment();
    restoreControls();
    storeWatcherCleanups.forEach(fn => fn());
    storeWatcherCleanups.length = 0;
    routeUnwatch?.();
    routeUnwatch = null;

    // Remove imperative controls from DOM
    document.querySelectorAll('.learner-controls, .learner-collapsed-controls').forEach(el => el.remove());

    document.removeEventListener('click', closeOverflowOnOutsideClick, true);
    document.removeEventListener('jpdb:card-graded', onJpdbCardGraded);
    window.removeEventListener('resize', scheduleSubtitleOverflowMeasure);
    fullSubtitleOpen.value = false;
    fullSubtitleTrigger = null;
});

// Watch showJP to sync the translate button active state
watch(showJP, () => syncToggleJpBtn());

// Segment transition: fade-in when primary text changes to a new segment
watch(primaryText, (val) => {
    if (val && prevPrimaryForFade && val !== prevPrimaryForFade) {
        segmentFading.value = true;
    }
    prevPrimaryForFade = val;
});

watch(
    [primaryText, secondaryText, showJP, enablePlayerTranslator, showExpanded, showCollapsed],
    scheduleSubtitleOverflowMeasure,
    { flush: 'post' },
);
</script>

<template>
    <!-- Expanded subtitle area (rendered in-place, inside audio player via FeatureController) -->
    <div
        ref="expandedRef"
        class="learner-subs-expanded"
        :class="[{ hidden: !showExpanded }, `learner-layout-${subtitleLayout}`]"
        :data-subtitle-layout="subtitleLayout"
        aria-live="polite"
    >
        <div v-show="showJP" class="learner-jp" :class="{ 'segment-fade': segmentFading }" :title="primaryText || undefined" @animationend="segmentFading = false" lang="ja" role="status">
            <SubtitleContent
                :karaoke-highlight-start="karaokeHighlightStart"
                :karaoke-split-index="karaokeSplitIndex"
                :jpdb-enabled="jpdbEnabled"
                :segment-mode="segmentMode"
                :primary-text="primaryText"
                :karaoke-past="karaokePast"
                :karaoke-current="karaokeCurrent"
                :karaoke-upcoming="karaokeUpcoming"
                :furigana-past="furiganaPast"
                :furigana-current="furiganaCurrent"
                :furigana-upcoming="furiganaUpcoming"
                :furigana-all="furiganaAll"
            />
        </div>
        <p v-if="whisperPlaceholderText" class="learner-whisper-placeholder">
            {{ whisperPlaceholderText }}
        </p>
        <span v-if="whisperCaptionDelayed" class="learner-whisper-delayed">
            {{ t('whisperCaptionDelayed') }}
        </span>
        <LearnerSecondarySubtitle
            v-show="enablePlayerTranslator"
            :text="secondaryText"
            :blurred="isBlurred"
            :fallback="isFallback"
            :language="secondaryLangAttribute"
            :chinese-layout="subtitleLayout === 'jp-zh'"
            :aria-label="isBlurred ? t('revealTranslation') : t('hideTranslation')"
            @toggle="toggleBlur"
        />
        <button
            v-if="hasClampedSubtitle"
            type="button"
            class="learner-subtitle-expand"
            :aria-label="t('showFullSubtitles')"
            aria-haspopup="dialog"
            :aria-expanded="fullSubtitleOpen"
            :title="t('showFullSubtitles')"
            @click.stop="openFullSubtitles"
        >
            <span class="material-icons" aria-hidden="true">open_in_full</span>
        </button>
    </div>

    <!-- Collapsed subtitle bar (teleported to body for fixed positioning) -->
    <Teleport to="body">
        <div
            ref="collapsedRef"
            class="learner-subs-collapsed"
            :class="[{ hidden: !showCollapsed }, `learner-layout-${subtitleLayout}`]"
            :data-subtitle-layout="subtitleLayout"
            :style="{ display: showCollapsed ? 'flex' : 'none !important' }"
            aria-live="polite"
        >
            <div v-show="showJP" class="learner-jp" :class="{ 'segment-fade': segmentFading }" :title="primaryText || undefined" @animationend="segmentFading = false" lang="ja" role="status">
                <SubtitleContent
                    :karaoke-highlight-start="karaokeHighlightStart"
                    :karaoke-split-index="karaokeSplitIndex"
                    :jpdb-enabled="jpdbEnabled"
                    :segment-mode="segmentMode"
                    :primary-text="primaryText"
                    :karaoke-past="karaokePast"
                    :karaoke-current="karaokeCurrent"
                    :karaoke-upcoming="karaokeUpcoming"
                    :furigana-past="furiganaPast"
                    :furigana-current="furiganaCurrent"
                    :furigana-upcoming="furiganaUpcoming"
                    :furigana-all="furiganaAll"
                />
            </div>
            <p v-if="whisperPlaceholderText" class="learner-whisper-placeholder">
                {{ whisperPlaceholderText }}
            </p>
            <span v-if="whisperCaptionDelayed" class="learner-whisper-delayed">
                {{ t('whisperCaptionDelayed') }}
            </span>
            <LearnerSecondarySubtitle
                v-show="enablePlayerTranslator"
                :text="secondaryText"
                :blurred="isBlurred"
                :fallback="isFallback"
                :language="secondaryLangAttribute"
                :chinese-layout="subtitleLayout === 'jp-zh'"
                :aria-label="isBlurred ? t('revealTranslation') : t('hideTranslation')"
                @toggle="toggleBlur"
            />
            <button
                v-if="hasClampedSubtitle"
                type="button"
                class="learner-subtitle-expand"
                :aria-label="t('showFullSubtitles')"
                aria-haspopup="dialog"
                :aria-expanded="fullSubtitleOpen"
                :title="t('showFullSubtitles')"
                @click.stop="openFullSubtitles"
            >
                <span class="material-icons" aria-hidden="true">open_in_full</span>
            </button>
        </div>
    </Teleport>

    <Teleport to="body">
        <div
            v-if="fullSubtitleOpen"
            class="learner-subtitle-dialog-backdrop"
            @click.self="closeFullSubtitles()"
        >
            <section
                ref="fullSubtitleDialogRef"
                class="learner-subtitle-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="asmr-full-subtitle-title"
                tabindex="-1"
                @keydown="handleFullSubtitleDialogKeydown"
            >
                <header class="learner-subtitle-dialog-header">
                    <h2 id="asmr-full-subtitle-title">{{ t('fullSubtitles') }}</h2>
                    <button
                        type="button"
                        class="learner-subtitle-dialog-close"
                        :aria-label="t('closeFullSubtitles')"
                        :title="t('closeFullSubtitles')"
                        @click="closeFullSubtitles()"
                    >
                        <span class="material-icons" aria-hidden="true">close</span>
                    </button>
                </header>
                <div class="learner-subtitle-dialog-content" aria-live="polite">
                    <p v-if="showJP && primaryText" class="learner-subtitle-dialog-primary" lang="ja">
                        {{ primaryText }}
                    </p>
                    <p
                        v-if="enablePlayerTranslator && secondaryText && !isBlurred"
                        class="learner-subtitle-dialog-secondary"
                        :lang="secondaryLangAttribute"
                    >
                        {{ secondaryText }}
                    </p>
                    <button
                        v-else-if="enablePlayerTranslator && secondaryText"
                        type="button"
                        class="learner-subtitle-dialog-reveal"
                        @click="toggleBlur"
                    >
                        {{ t('revealTranslation') }}
                    </button>
                </div>
            </section>
        </div>
    </Teleport>
</template>

<style scoped>
/* No additional scoped styles needed - all styles come from _learner.css
   which is imported globally in main.ts. The component uses the same
   class names (.learner-subs-expanded, .learner-subs-collapsed, etc.)
   as the original imperative implementation. */
</style>
