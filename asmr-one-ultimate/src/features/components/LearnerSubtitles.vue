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
import { getAudioElement, getPlayerBar } from '../../core/DomUtils';
import { Logger, Config } from '../../core/Utils';
import type { WhisperUpdatePayload, JPDBToken, AudioPlayerState, KikoeruStoreState, KikoeruApp, VueRoute, PlayerTrack, AvailableLyric } from '../../types';
import { buildSegments, sliceSegments, type FuriganaSegment } from '../../lib/jpdb-segments';
import { splitSubtitleSegments } from '../subtitleSegmentSplitter';
import { findLyricsSource as findLyricsSourceUtil, normalizeLyricLines, parseLrcContent, parseSubtitleContent } from '../learnerLyricsUtils';
import {
    buildKaraokeCharMap, computeWordKaraokeIndices, computeTimeFallbackKaraokeIndices,
    type KaraokeCharMap, type KaraokeWord,
} from '../karaokeUtils';

// ---------------------------------------------------------------------------
// Composables
// ---------------------------------------------------------------------------

const bridge = useBridge();
const { on, emit } = useEventBus();
const { t, format } = useI18n();
const learnerBlur = useConfig('learnerBlur');
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
let whisperFromCache = false;
let whisperLive = false;
let whisperLeadSec = 0;
let lastWhisperDisplayText = '';
let whisperTickerId: number | null = null;
let whisperTickerInterval = 80;

// Subtitle lead / append
const subtitleLeadSec = 1.2;
const subtitleAppendWindowSec = 1.5;
const subtitleAppendMaxChars = 140;

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
const lrcFetchAttemptedHashes = new Set<string>();
let lastNoLyricsLogHash: string | null = null;
let lastPreTranslatedKey: string | null = null;

// Ticker translation throttle
let lastTickerTranslationText = '';
let lastTickerTranslationAt = 0;
const TICKER_TRANSLATION_COOLDOWN_MS = 500;

// Drawer width tracking
let drawerResizeObserver: ResizeObserver | null = null;

// Cover height adjustment — reduce album art q-img max-height to
// accommodate injected subtitle/visualizer areas that the host app
// doesn't know about.
let coverImgObserver: MutationObserver | null = null;
let subsResizeObserver: ResizeObserver | null = null;
let lastSetCoverMaxH = '';  // Track our last-set value to distinguish from host updates

// rAF coalescing flags — prevent layout thrashing during window resize
let rafPlayerObserver = 0;
let rafCoverAdjust = 0;
let rafDrawerSync = 0;

// Host more button (for overflow proxy)
let hostMoreBtn: HTMLElement | null = null;
// Controls captured into overflow
const originalParents = new Map<HTMLElement, { parent: HTMLElement; nextSibling: Node | null }>();

// Overflow menu DOM ref (created imperatively and appended to body for z-index)
let overflowMenuEl: HTMLElement | null = null;

// Player observer (for injection race condition)
let playerObserver: MutationObserver | null = null;

// Store watchers cleanup
const storeWatcherCleanups: (() => void)[] = [];

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
const overflowToggleRef = ref<HTMLElement | null>(null);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isChinese(text: string): boolean {
    return /[\u4e00-\u9fff]/.test(text) && !/[\u3040-\u309f\u30a0-\u30ff]/.test(text);
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

function clearKaraokeState() {
    stopKaraokeRaf();
    karaokeCharMapCached = null;
    karaokeFullTextCached = '';
}


function getTrackKey(): string | null {
    const track = bridge.currentTrack;
    return track?.hash || track?.mediaStreamUrl || track?.src || track?.title || null;
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

// ---------------------------------------------------------------------------
// Blur toggle
// ---------------------------------------------------------------------------

function toggleBlur() {
    isBlurred.value = !isBlurred.value;
    learnerBlur.value = isBlurred.value;
}

// Sync blur from external config changes
on('config:change', ({ key, value }) => {
    if (key === 'learnerBlur') {
        isBlurred.value = !!value;
    } else if (key === 'showJP') {
        // showJP ref auto-syncs via useConfig
    } else if (key === 'enableWhisper' || key === 'enableJoiTool' || key === 'enableVisualizer') {
        syncOverflowItemVisibility(key, !!value);
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
    isBlurred.value = !!learnerBlur.value && !!text;
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
    hasContent.value = !!lastDisplayedText || currentLyrics.length > 0 || whisperActive;
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
    // Reset dedup state and immediately update display so subtitles track the
    // scrub position in real-time. Don't clearDisplay() — show the line at
    // the new position (or hold the previous line during gaps).
    lastText = '';
    lastDisplayedText = '';
    lastSecondaryShown = '';
    lastWhisperDisplayText = '';
    translationToken += 1;
    updateLyrics();
}

function handleAudioSeeked() {
    // Final refresh after the user releases the scrubber.
    // Reset dedup again in case seeking handler's update was stale.
    lastText = '';
    lastDisplayedText = '';
    lastSecondaryShown = '';
    lastWhisperDisplayText = '';
    translationToken += 1;
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

function findActiveLine(
    lines: Array<{ time: number; endTime?: number; text: string }>,
    now: number,
): { time: number; endTime?: number; text: string } | null {
    if (lines.length === 0) return null;
    let activeIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].time <= now) { activeIdx = i; break; }
    }
    if (activeIdx < 0) return null;
    const activeLine = lines[activeIdx];
    // If we're past this line's endTime, check if there's a next line coming soon.
    // If the gap to the next line is short (< 2s), hold the current line visible
    // to prevent blank flashes between sentences. For longer gaps, return null
    // so the display can clear (genuine silence/pause).
    if (activeLine.endTime && now >= activeLine.endTime) {
        const nextLine = lines[activeIdx + 1];
        // No next line — hold the last segment visible (during live transcription
        // the worker hasn't caught up; at end of transcript it's the final line)
        if (!nextLine) return activeLine;
        // Short gap between existing segments — hold to prevent flash
        if ((nextLine.time - activeLine.endTime) < 2.0) return activeLine;
        // Long gap between existing segments — genuine silence
        return null;
    }
    return activeLine;
}

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
        const visible = words.filter(w => w.start <= now + 0.01).map(w => (w.text || '').trim()).filter(Boolean);
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
    const activeLine = findActiveLine(lines, now);
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
}

function getWhisperDisplay(): SubtitleDisplayResult {
    const audio = getAudioElement();
    if (!audio || whisperLines.length === 0) return { displayText: '', fullText: '' };
    const audioTime = audio.currentTime;
    const now = audioTime + Math.max(0, effectiveLead(whisperLeadSec));
    const activeLine = findActiveLine(whisperLines, now);
    if (!activeLine || !activeLine.text) return { displayText: '', fullText: '' };
    return { displayText: getProgressiveText(activeLine, now), fullText: activeLine.text.trim(), activeLine, now, audioTime };
}

function getSubtitleDisplay(): SubtitleDisplayResult {
    const audio = getAudioElement();
    if (!audio || currentLyrics.length === 0) return { displayText: '', fullText: '' };
    const audioTime = audio.currentTime;
    const now = audioTime + effectiveLead(subtitleLeadSec);
    const activeLine = findActiveLine(currentLyrics, now);
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

async function fetchSubtitleFromUrl(url: string): Promise<boolean> {
    try {
        const res = await bridge.axios.get<string>(url, { responseType: 'text' });
        const content = typeof res.data === 'string' ? res.data : String(res.data);
        if (!content) return false;
        const lyrics = parseSubtitleContent(content);
        if (lyrics.length > 0) {
            const tk = getTrackKey();
            if (tk) lastTrackKey = tk;
            currentLyrics = lyrics;
            setTimeout(() => preTranslateAll(lyrics), 100);
            updateLyrics();
            return true;
        }
    } catch (err) {
        Logger.error('[LearnerMode] Error fetching subtitle:', err);
    }
    return false;
}

async function fetchLrcByHash(hash: string): Promise<boolean> {
    try {
        const res = await bridge.axios.get<string>(`/api/media/stream/${hash}`, { responseType: 'text' });
        const content = typeof res.data === 'string' ? res.data : String(res.data);
        if (!content) return false;
        const lyrics = parseLrcContent(content);
        if (lyrics.length > 0) {
            const tk = getTrackKey();
            if (tk) lastTrackKey = tk;
            currentLyrics = lyrics;
            setTimeout(() => preTranslateAll(lyrics), 100);
            updateLyrics();
            return true;
        }
    } catch (err) {
        Logger.debug('[LearnerMode] Error fetching LRC by hash:', err);
    }
    return false;
}

async function fetchLrcForCurrentTrack(): Promise<void> {
    const track = bridge.currentTrack;
    if (!track) return;
    const trackHash = track.hash || track.src || track.mediaStreamUrl || '';
    if (!trackHash || trackHash === lastLrcTrackHash) return;
    if (lrcFetchAttemptedHashes.has(trackHash)) return;
    if (lrcFetchPromise) return lrcFetchPromise;
    lrcFetchPromise = _fetchLrcInner(track, trackHash).finally(() => { lrcFetchPromise = null; });
    return lrcFetchPromise;
}

async function _fetchLrcInner(track: PlayerTrack, trackHash: string): Promise<void> {
    let fetched = false;

    // Priority 1: availableLyrics
    if (track.availableLyrics?.length) {
        const trackTitle = (track.title || '').replace(/\.[^.]+$/, '');
        const sorted = [...track.availableLyrics].sort((a: AvailableLyric, b: AvailableLyric) => {
            const aMatch = trackTitle && (a.title || '').replace(/\.[^.]+$/, '') === trackTitle ? 0 : 1;
            const bMatch = trackTitle && (b.title || '').replace(/\.[^.]+$/, '') === trackTitle ? 0 : 1;
            return aMatch - bMatch;
        });
        for (const lyricFile of sorted) {
            if (!lyricFile.mediaStreamUrl) continue;
            try { fetched = await fetchSubtitleFromUrl(lyricFile.mediaStreamUrl); if (fetched) break; }
            catch (err) { Logger.error('[LearnerMode] Error fetching subtitle:', err); }
        }
    }

    // Priority 2: /api/media/check-lrc
    if (!fetched) {
        const workId = bridge.currentWorkId;
        if (workId) {
            const queue = bridge.queue;
            const trackIndex = queue.findIndex((t: PlayerTrack) => t.hash === track.hash || t.mediaStreamUrl === track.mediaStreamUrl || t.src === track.src);
            const candidates = new Set<number>();
            if (trackIndex >= 0) candidates.add(trackIndex);
            const fallback = bridge.queueIndex;
            if (Number.isFinite(fallback) && fallback >= 0) candidates.add(fallback);

            if (candidates.size === 0) {
                fetched = await fetchLrcByHash(trackHash);
            } else {
                for (const idx of candidates) {
                    try {
                        const checkRes = await bridge.axios.get<{ result: boolean; hash?: string }>(`/api/media/check-lrc/${workId}/${idx}`);
                        if (!checkRes.data.result || !checkRes.data.hash) continue;
                        fetched = await fetchLrcByHash(checkRes.data.hash);
                        if (fetched) break;
                    } catch (err) { Logger.debug('[LearnerMode] Error fetching LRC:', err); }
                }
            }
        }
    }

    if (fetched) lastLrcTrackHash = trackHash;
    lrcFetchAttemptedHashes.add(trackHash);
}

// ---------------------------------------------------------------------------
// Pre-translation
// ---------------------------------------------------------------------------

function preTranslateAll(lyrics: Array<{ time: number; text: string }>): void {
    if (lyrics.length === 0) return;
    const targetLang = (Config.get('subtitleLang') as string || 'en').toLowerCase();
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

    const uncached = prefetchTexts.filter(t => !TranslationService.peekCached(t, targetLang));
    if (uncached.length === 0) return;

    const first = uncached[0] || '';
    const last = uncached[uncached.length - 1] || '';
    const key = `${uncached.length}:${first.slice(0, 20)}:${last.slice(0, 20)}`;
    if (key === lastPreTranslatedKey) return;
    lastPreTranslatedKey = key;

    Logger.debug(`[LearnerMode] Pre-translating ${uncached.length}/${prefetchTexts.length} uncached lines${windowedPrefetch ? ' (windowed)' : ''}...`);

    const processBatch = (batch: string[], priority: string) => {
        if (batch.length === 0) return;
        const cnTexts: string[] = [];
        const allTexts: string[] = [];
        for (const text of batch) {
            if (isChinese(text) && !TranslationService.peekCached(text, 'ja')) cnTexts.push(text);
            if (!TranslationService.peekCached(text, targetLang)) allTexts.push(text);
        }
        if (targetLang !== 'ja' && allTexts.length > 0) {
            TranslationService.translateBatch(allTexts, targetLang).catch(err => Logger.warn(`[LearnerMode] ->${targetLang} ${priority} batch failed:`, err));
        }
        if (cnTexts.length > 0) {
            const cnDelay = targetLang === 'ja' ? 0 : (priority === 'initial' ? 600 : 1200);
            setTimeout(() => {
                TranslationService.translateBatch(cnTexts, 'ja').catch(err => Logger.warn(`[LearnerMode] CN->JA ${priority} batch failed:`, err));
            }, cnDelay);
        }
    };

    const PRIORITY_BATCH_SIZE = 50;
    processBatch(uncached.slice(0, PRIORITY_BATCH_SIZE), 'initial');
    const bg = uncached.slice(PRIORITY_BATCH_SIZE);
    if (bg.length > 0) setTimeout(() => processBatch(bg, 'background'), 2000);
}

// ---------------------------------------------------------------------------
// The main updateLyrics() -- called on every timeupdate (~4Hz)
// ---------------------------------------------------------------------------

function updateLyrics() {
    const trackKey = getTrackKey();
    if (trackKey && trackKey !== lastTrackKey) {
        lastTrackKey = trackKey;
        lastText = '';
        currentLyrics = [];
        whisperLines = [];
        whisperText = '';
        whisperActive = false;
        whisperFromCache = false;
        whisperLive = false;
        whisperLeadSec = 0;
        lastWhisperDisplayText = '';
        clearWhisperTicker();
        clearDisplay();
        translationToken += 1;
    }

    const useWhisper = whisperActive;
    if (useWhisper) {
        _updateWhisperDisplay();
        return;
    }

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
                setTimeout(() => preTranslateAll(newLyrics), 100);
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
        // Between timed segments or before first line — clear stale text
        if (lastWhisperDisplayText) {
            updatePrimaryLine('');
            lastWhisperDisplayText = '';
        }
        refreshVisibility();
        return;
    }

    const targetLang = (Config.get('subtitleLang') as string || 'en').toLowerCase();
    const cn = isChinese(fullText);
    let primary: string;
    let splitIdx = -1;
    let hlStart = -1;
    if (cn) {
        const ja = TranslationService.peekCached(fullText, 'ja');
        primary = ja || fullText;
    } else if (karaokeMode.value) {
        // Karaoke ON: always show full text, control visibility via CSS
        primary = fullText;
        const karaokeTime = display.audioTime ?? display.now;
        if (display.activeLine && karaokeTime != null) {
            const indices = setKaraokeLineState(
                fullText, display.activeLine.words, display.activeLine.time,
                display.activeLine.endTime, karaokeTime,
            );
            splitIdx = indices.splitIdx;
            hlStart = segmentMode.value ? 0 : indices.hlStart;
        }
    } else {
        primary = progressiveText;
    }

    if (primary && primary !== lastWhisperDisplayText) {
        updatePrimaryLine(primary, splitIdx, hlStart);
        lastWhisperDisplayText = primary;
    } else if (karaokeMode.value && (splitIdx >= 0 || hlStart >= 0)) {
        // Text unchanged but karaoke indices advanced — rAF handles smooth updates
        karaokeSplitIndex.value = splitIdx;
        karaokeHighlightStart.value = hlStart;
    }

    if (fullText !== lastText) {
        lastText = fullText;
        const cached = TranslationService.peekCached(fullText, targetLang);
        updateSecondaryLine(cached || progressiveText, !cached);
        lastDisplayedText = fullText;
        const token = ++translationToken;

        if (!cached) {
            TranslationService.translate(fullText, targetLang).then(tr => {
                if (tr && lastText === fullText && token === translationToken) updateSecondaryLine(tr, false);
            }).catch(() => {});
        }
        if (cn && !TranslationService.peekCached(fullText, 'ja')) {
            TranslationService.translate(fullText, 'ja').then(tr => {
                if (tr && lastText === fullText && token === translationToken) {
                    updatePrimaryLine(tr);
                    lastWhisperDisplayText = tr;
                }
            }).catch(() => {});
        }
    }

    refreshVisibility();
}

// ---------------------------------------------------------------------------
// Whisper display logic (extracted to keep updateLyrics readable)
// ---------------------------------------------------------------------------

function _updateWhisperDisplay() {
    const targetLang = (Config.get('subtitleLang') as string || 'en').toLowerCase();
    const allowSecondary = !whisperLive || whisperFromCache;

    if (whisperLines.length) {
        currentLyrics = whisperLines;
        const display = getWhisperDisplay();
        const fullText = display.fullText;
        if (fullText && fullText !== lastText) lastText = fullText;

        let cachedSecondary: string | null = null;
        if (fullText) {
            cachedSecondary = TranslationService.peekCached(fullText, targetLang);
            if (!cachedSecondary && whisperLive && shouldTickerTranslate(fullText)) {
                const token = ++translationToken;
                TranslationService.translate(fullText, targetLang).then(tr => {
                    if (tr && lastDisplayedText === fullText && token === translationToken) {
                        updateSecondaryLine(tr, false);
                        lastSecondaryShown = tr;
                    }
                }).catch(() => {});
                if (isChinese(fullText) && targetLang !== 'ja') TranslationService.translate(fullText, 'ja').catch(() => {});
            }
        }
        if (fullText && fullText !== lastDisplayedText) {
            lastDisplayedText = fullText;
            lastSecondaryShown = '';
            // Always show cached translation if available; during live transcription
            // show empty placeholder (the async translate() will fill it in)
            if (cachedSecondary) {
                updateSecondaryLine(cachedSecondary, false);
                lastSecondaryShown = cachedSecondary;
            } else if (allowSecondary) {
                updateSecondaryLine('', true);
            }
        } else if (fullText && cachedSecondary && cachedSecondary !== lastSecondaryShown) {
            // Translation became available (e.g. translateAhead filled the cache)
            updateSecondaryLine(cachedSecondary, false);
            lastSecondaryShown = cachedSecondary;
        }
        if (display.displayText && display.displayText !== lastWhisperDisplayText) {
            const cn = isChinese(display.displayText);
            let prim = display.displayText;
            let splitIdx = -1;
            let hlStart = -1;
            if (cn) {
                const ja = TranslationService.peekCached(fullText, 'ja');
                prim = ja || display.displayText || fullText || '';
                if (!ja) {
                    TranslationService.translate(fullText, 'ja').then(ja2 => {
                        if (ja2 && lastDisplayedText === fullText) { updatePrimaryLine(ja2); lastWhisperDisplayText = ja2; }
                    }).catch(() => {});
                }
            } else if (karaokeMode.value && fullText) {
                // Karaoke ON: always show full text, control visibility via CSS
                prim = fullText;
                const karaokeTime = display.audioTime ?? display.now;
                if (display.activeLine && karaokeTime != null) {
                    const indices = setKaraokeLineState(
                        fullText, display.activeLine.words, display.activeLine.time,
                        display.activeLine.endTime, karaokeTime,
                    );
                    splitIdx = indices.splitIdx;
                    hlStart = segmentMode.value ? 0 : indices.hlStart;
                }
            }
            updatePrimaryLine(prim, splitIdx, hlStart);
            lastWhisperDisplayText = prim;
        } else if (display.displayText && karaokeMode.value) {
            // Karaoke: text unchanged — rAF handles smooth inter-frame updates.
            // Safety fallback: recompute if rAF isn't running (e.g. tab was hidden).
            if (!karaokeRafId && display.activeLine) {
                const ft = display.fullText || display.displayText;
                const karaokeTime = display.audioTime ?? display.now;
                if (karaokeTime != null) {
                    const indices = setKaraokeLineState(
                        ft, display.activeLine.words, display.activeLine.time,
                        display.activeLine.endTime, karaokeTime,
                    );
                    const newSplit = indices.splitIdx;
                    const newHl = segmentMode.value ? 0 : indices.hlStart;
                    if (newSplit !== karaokeSplitIndex.value) karaokeSplitIndex.value = newSplit;
                    if (newHl !== karaokeHighlightStart.value) karaokeHighlightStart.value = newHl;
                }
            }
        } else if (!display.displayText) {
            // Between segments (gap/silence) — hold previous text visible.
            // Clearing causes blank flashes and content shift. The next segment
            // will naturally replace the text when it arrives.
        }
        refreshVisibility();
        return;
    }

    // No whisperLines but whisperText exists
    if (whisperText) {
        if (whisperText !== lastText) lastText = whisperText;
        let cached: string | null = TranslationService.peekCached(whisperText, targetLang);
        if (!cached && whisperLive && shouldTickerTranslate(whisperText)) {
            const token = ++translationToken;
            TranslationService.translate(whisperText, targetLang).then(tr => {
                if (tr && lastDisplayedText === whisperText && token === translationToken) {
                    updateSecondaryLine(tr, false);
                    lastSecondaryShown = tr;
                }
            }).catch(() => {});
            if (isChinese(whisperText) && targetLang !== 'ja') TranslationService.translate(whisperText, 'ja').catch(() => {});
        }
        if (whisperText !== lastDisplayedText) {
            lastDisplayedText = whisperText;
            lastSecondaryShown = '';
            if (cached) {
                updateSecondaryLine(cached, false);
                lastSecondaryShown = cached;
            } else if (allowSecondary) {
                updateSecondaryLine('', true);
            }
        } else if (cached && cached !== lastSecondaryShown) {
            updateSecondaryLine(cached, false);
            lastSecondaryShown = cached;
        }
        if (whisperText !== lastWhisperDisplayText) {
            const cn = isChinese(whisperText);
            let prim = whisperText;
            if (cn) {
                const ja = TranslationService.peekCached(whisperText, 'ja');
                prim = ja || whisperText;
                if (!ja) TranslationService.translate(whisperText, 'ja').then(ja2 => {
                    if (ja2 && lastDisplayedText === whisperText) { updatePrimaryLine(ja2); lastWhisperDisplayText = ja2; }
                }).catch(() => {});
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

function handleWhisperUpdate(payload: WhisperUpdatePayload) {
    if (!payload) return;
    whisperActive = true;
    whisperFromCache = !!payload.fromCache;
    whisperLive = typeof payload.live === 'boolean' ? !!payload.live : false;
    whisperLeadSec = typeof payload.leadSec === 'number' ? Math.max(0, payload.leadSec) : whisperLeadSec;
    whisperText = payload.text || '';
    ensureWhisperTicker(whisperLive ? 80 : 200);
    if (Array.isArray(payload.segments) && payload.segments.length > 0) {
        const mapped = payload.segments.map(s => ({ time: s.start, endTime: s.end, text: s.text, words: s.words }));
        const newLines = splitSubtitleSegments(mapped);
        if (!whisperLive && TranslationService.canPrefetch(newLines.length)) setTimeout(() => preTranslateAll(newLines), 100);
        whisperLines = newLines;
        // Don't reset lastWhisperDisplayText here — let _updateWhisperDisplay()
        // naturally detect changes. Resetting forces re-renders that cause flashing
        // when paused and whisper reprocesses the same audio with slightly different output.
    }
    // Don't reset lastText either — let the natural dedup comparison handle it.
    // This prevents unnecessary re-translation and secondary line flicker.
    updateLyrics();
}

function handleWhisperClear() {
    whisperActive = false;
    whisperText = '';
    whisperLines = [];
    whisperFromCache = false;
    whisperLive = false;
    whisperLeadSec = 0;
    lastWhisperDisplayText = '';
    clearWhisperTicker();
    lastText = '';
    lastDisplayedText = '';
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
    lastText = '';
    lastDisplayedText = '';
    lastSecondaryShown = '';
    currentLyrics = [];
    whisperLines = [];
    whisperText = '';
    whisperActive = false;
    whisperFromCache = false;
    whisperLeadSec = 0;
    lastWhisperDisplayText = '';
    clearWhisperTicker();
    translationToken += 1;
    lastPreTranslatedKey = null;
    lastLrcTrackHash = null;
    lrcFetchAttemptedHashes.clear();
    lrcFetchPromise = null;
    lastNoLyricsLogHash = null;
    clearDisplay();
    bindAudioTimeUpdate();
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
    const targetIdx = Math.max(0, Math.min(lines.length - 1, rawTarget));
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
        lastText = '';
        lastDisplayedText = '';
        lastSecondaryShown = '';
        lastWhisperDisplayText = '';
        translationToken += 1;
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
    const width = drawer ? `${drawer.getBoundingClientRect().width}px` : '0px';
    document.documentElement.style.setProperty('--asmr-drawer-width', width);
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
    const subsRoot = player.querySelector('#asmr-learner-subs-root') as HTMLElement;
    if (subsRoot && !subsResizeObserver && typeof ResizeObserver !== 'undefined') {
        subsResizeObserver = new ResizeObserver(() => {
            if (rafCoverAdjust) return;
            rafCoverAdjust = requestAnimationFrame(() => { rafCoverAdjust = 0; adjustCoverForSubtitles(); });
        });
        subsResizeObserver.observe(subsRoot);
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
    setTimeout(() => {
        const menus = document.querySelectorAll('.q-menu');
        const menu = menus.length > 0 ? menus[menus.length - 1] : null;
        if (menu) {
            const items = Array.from(menu.querySelectorAll('.q-item'));
            const target = items.find(i => i.innerHTML.includes(iconName));
            if (target) (target as HTMLElement).click();
        }
    }, 100);
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
    setTimeout(() => captureControls(playerBar as HTMLElement, ctrl), 0);
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
        setTimeout(() => captureControls(controls, existing), 0);
        return;
    }
    const learnerCtrls = createControlsEl(false);
    controls.insertBefore(learnerCtrls, controls.firstChild);
    setTimeout(() => captureControls(controls, learnerCtrls), 0);
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
                    const onResize = () => positionOverflowMenu(b);
                    window.addEventListener('resize', onResize);
                    const close = (e: MouseEvent) => {
                        const target = e.target as Node;
                        if (!overflowMenuEl?.contains(target) && !b.contains(target)) {
                            overflowMenuEl?.classList.add('hidden');
                            document.removeEventListener('click', close, true);
                            window.removeEventListener('resize', onResize);
                        }
                    };
                    setTimeout(() => document.addEventListener('click', close, true), 0);
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
    add(store.watch((state: KikoeruStoreState) => ap(state).lrcLines, () => scheduleUpdateLyrics(), { immediate: true }));
    add(store.watch((state: KikoeruStoreState) => ap(state).lyrics, () => scheduleUpdateLyrics(), { immediate: true }));
    add(store.watch((state: KikoeruStoreState) => ap(state).lyricLines, () => scheduleUpdateLyrics(), { immediate: true }));
    add(store.watch((state: KikoeruStoreState) => ap(state).subtitleLines, () => scheduleUpdateLyrics(), { immediate: true }));
    add(store.watch((state: KikoeruStoreState) => ap(state).subtitles, () => scheduleUpdateLyrics(), { immediate: true }));
    add(store.watch((state: KikoeruStoreState) => (ap(state).subtitle as Record<string, unknown> | undefined)?.lines, () => scheduleUpdateLyrics(), { immediate: true }));
    add(store.watch((state: KikoeruStoreState) => ap(state).currentLyric, (lyric: unknown) => { if (lyric) scheduleUpdateLyrics(); }));

    // Track change via queue[queueIndex]
    add(store.watch((state: KikoeruStoreState) => {
        const player = state.AudioPlayer;
        if (!player?.queue || typeof player.queueIndex !== 'number') return null;
        const track = player.queue[player.queueIndex];
        return track?.hash || track?.mediaStreamUrl || null;
    }, (trackKey: string | null) => {
        setTimeout(() => {
            bindAudioTimeUpdate();
            if (trackKey) fetchLrcForCurrentTrack().catch(err => Logger.error('[LearnerMode] Store watcher LRC fetch failed:', err));
        }, 100);
    }, { immediate: true }));

    // Audio source
    add(store.watch((state: KikoeruStoreState) => state.AudioPlayer?.source, (src: string | undefined) => {
        if (src) setTimeout(() => fetchLrcForCurrentTrack().catch(err => Logger.error('[LearnerMode] Source watcher LRC fetch failed:', err)), 200);
    }, { immediate: true }));

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
    on('translation:progress', (payload) => {
        if (payload?.stage === 'ready') updateLyrics();
    });

    // Vue route watcher
    const app = bridge.app as KikoeruApp | undefined;
    if (app?.$watch) {
        app.$watch('$route', (to: VueRoute) => {
            lastText = '';
            currentLyrics = [];
            whisperLines = [];
            whisperText = '';
            whisperActive = false;
            const path = to?.path || '';
            if (!path.startsWith('/work/')) {
                // Clean up controls when navigating away
                restoreControls();
                clearWhisperTicker();
                unbindAudio();
            } else {
                setTimeout(() => {
                    injectExpandedControls();
                    injectCollapsedControls();
                    updateLyrics();
                }, 100);
            }
            refreshVisibility();
            bindAudioTimeUpdate();
        });
    }

    // Vuex store watchers
    setupStoreWatchers();

    // Initial injections
    injectExpandedControls();
    injectCollapsedControls();

    // Player appearance observer — coalesce via rAF to avoid layout thrashing on resize
    playerObserver = new MutationObserver(() => {
        if (rafPlayerObserver) return;
        rafPlayerObserver = requestAnimationFrame(() => {
            rafPlayerObserver = 0;
            injectExpandedControls();
            injectCollapsedControls();
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
    setTimeout(() => setupCoverAdjustment(), 200);

    // Bind audio
    bindAudioTimeUpdate();

    // Initial LRC fetch
    setTimeout(() => {
        if (bridge.currentTrack) {
            fetchLrcForCurrentTrack().catch(err => Logger.error('[LearnerMode] Initial LRC fetch failed:', err));
        }
    }, 500);

    // Outside-click listener for overflow
    document.addEventListener('click', closeOverflowOnOutsideClick, true);
});

onUnmounted(() => {
    AppStore.setLearnerState({ isActive: false });

    clearWhisperTicker();
    clearKaraokeState();
    unbindAudio();
    if (seekedDebounceTimer) { clearTimeout(seekedDebounceTimer); seekedDebounceTimer = null; }
    if (rafPlayerObserver) { cancelAnimationFrame(rafPlayerObserver); rafPlayerObserver = 0; }
    if (rafCoverAdjust) { cancelAnimationFrame(rafCoverAdjust); rafCoverAdjust = 0; }
    if (rafDrawerSync) { cancelAnimationFrame(rafDrawerSync); rafDrawerSync = 0; }
    playerObserver?.disconnect();
    playerObserver = null;
    drawerResizeObserver?.disconnect();
    drawerResizeObserver = null;
    teardownCoverAdjustment();
    restoreControls();
    storeWatcherCleanups.forEach(fn => fn());
    storeWatcherCleanups.length = 0;

    // Remove imperative controls from DOM
    document.querySelectorAll('.learner-controls, .learner-collapsed-controls').forEach(el => el.remove());

    document.removeEventListener('click', closeOverflowOnOutsideClick, true);
    document.removeEventListener('jpdb:card-graded', onJpdbCardGraded);
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
</script>

<template>
    <!-- Expanded subtitle area (rendered in-place, inside audio player via FeatureController) -->
    <div
        ref="expandedRef"
        class="learner-subs-expanded"
        :class="{ hidden: !showExpanded }"
        aria-live="polite"
    >
        <div v-show="showJP" class="learner-jp" :class="{ 'segment-fade': segmentFading }" @animationend="segmentFading = false" lang="ja" role="status">
            <!-- Karaoke with JPDB furigana -->
            <template v-if="karaokeHighlightStart >= 0 && karaokeSplitIndex >= 0 && jpdbEnabled">
                <span class="karaoke-past"><template v-for="(seg, i) in furiganaPast" :key="'p'+i"><span v-if="seg.vid !== undefined" class="jpdb-word" :class="[seg.stateClass, seg.pitchClass]" :data-vid="seg.vid" :data-sid="seg.sid" data-jpdb="true"><ruby v-if="seg.rt">{{ seg.base }}<rt class="jpdb-furi">{{ seg.rt }}</rt></ruby><template v-else>{{ seg.base }}</template></span><template v-else>{{ seg.base }}</template></template></span><span class="karaoke-spoken"><template v-for="(seg, i) in furiganaCurrent" :key="'c'+i"><span v-if="seg.vid !== undefined" class="jpdb-word" :class="[seg.stateClass, seg.pitchClass]" :data-vid="seg.vid" :data-sid="seg.sid" data-jpdb="true"><ruby v-if="seg.rt">{{ seg.base }}<rt class="jpdb-furi">{{ seg.rt }}</rt></ruby><template v-else>{{ seg.base }}</template></span><template v-else>{{ seg.base }}</template></template></span><span class="karaoke-upcoming" :class="{ 'karaoke-hidden': !segmentMode }"><template v-for="(seg, i) in furiganaUpcoming" :key="'u'+i"><span v-if="seg.vid !== undefined" class="jpdb-word" :class="[seg.stateClass, seg.pitchClass]" :data-vid="seg.vid" :data-sid="seg.sid" data-jpdb="true"><ruby v-if="seg.rt">{{ seg.base }}<rt class="jpdb-furi">{{ seg.rt }}</rt></ruby><template v-else>{{ seg.base }}</template></span><template v-else>{{ seg.base }}</template></template></span>
            </template>
            <!-- Non-karaoke with JPDB furigana -->
            <template v-else-if="jpdbEnabled && furiganaAll.length > 0">
                <template v-for="(seg, i) in furiganaAll" :key="'a'+i"><span v-if="seg.vid !== undefined" class="jpdb-word" :class="[seg.stateClass, seg.pitchClass]" :data-vid="seg.vid" :data-sid="seg.sid" data-jpdb="true"><ruby v-if="seg.rt">{{ seg.base }}<rt class="jpdb-furi">{{ seg.rt }}</rt></ruby><template v-else>{{ seg.base }}</template></span><template v-else>{{ seg.base }}</template></template>
            </template>
            <!-- Plain karaoke (no JPDB) -->
            <template v-else-if="karaokeHighlightStart >= 0 && karaokeSplitIndex >= 0">
                <span class="karaoke-past">{{ karaokePast }}</span><span class="karaoke-spoken">{{ karaokeCurrent }}</span><span class="karaoke-upcoming" :class="{ 'karaoke-hidden': !segmentMode }">{{ karaokeUpcoming }}</span>
            </template>
            <!-- Plain text -->
            <template v-else>{{ primaryText }}</template>
        </div>
        <button
            v-show="enablePlayerTranslator"
            class="learner-en"
            :class="{ blurred: isBlurred && !!secondaryText, 'translation-fallback': isFallback }"
            :aria-label="isBlurred ? t('revealTranslation') : t('hideTranslation')"
            :aria-pressed="!isBlurred"
            @click.stop="toggleBlur"
        >{{ secondaryText }}</button>
    </div>

    <!-- Collapsed subtitle bar (teleported to body for fixed positioning) -->
    <Teleport to="body">
        <div
            ref="collapsedRef"
            class="learner-subs-collapsed"
            :class="{ hidden: !showCollapsed }"
            :style="{ display: showCollapsed ? 'flex' : 'none !important' }"
            aria-live="polite"
        >
            <div v-show="showJP" class="learner-jp" :class="{ 'segment-fade': segmentFading }" @animationend="segmentFading = false" lang="ja" role="status">
                <!-- Karaoke with JPDB furigana -->
                <template v-if="karaokeHighlightStart >= 0 && karaokeSplitIndex >= 0 && jpdbEnabled">
                    <span class="karaoke-past"><template v-for="(seg, i) in furiganaPast" :key="'p'+i"><span v-if="seg.vid !== undefined" class="jpdb-word" :class="[seg.stateClass, seg.pitchClass]" :data-vid="seg.vid" :data-sid="seg.sid" data-jpdb="true"><ruby v-if="seg.rt">{{ seg.base }}<rt class="jpdb-furi">{{ seg.rt }}</rt></ruby><template v-else>{{ seg.base }}</template></span><template v-else>{{ seg.base }}</template></template></span><span class="karaoke-spoken"><template v-for="(seg, i) in furiganaCurrent" :key="'c'+i"><span v-if="seg.vid !== undefined" class="jpdb-word" :class="[seg.stateClass, seg.pitchClass]" :data-vid="seg.vid" :data-sid="seg.sid" data-jpdb="true"><ruby v-if="seg.rt">{{ seg.base }}<rt class="jpdb-furi">{{ seg.rt }}</rt></ruby><template v-else>{{ seg.base }}</template></span><template v-else>{{ seg.base }}</template></template></span><span class="karaoke-upcoming" :class="{ 'karaoke-hidden': !segmentMode }"><template v-for="(seg, i) in furiganaUpcoming" :key="'u'+i"><span v-if="seg.vid !== undefined" class="jpdb-word" :class="[seg.stateClass, seg.pitchClass]" :data-vid="seg.vid" :data-sid="seg.sid" data-jpdb="true"><ruby v-if="seg.rt">{{ seg.base }}<rt class="jpdb-furi">{{ seg.rt }}</rt></ruby><template v-else>{{ seg.base }}</template></span><template v-else>{{ seg.base }}</template></template></span>
                </template>
                <!-- Non-karaoke with JPDB furigana -->
                <template v-else-if="jpdbEnabled && furiganaAll.length > 0">
                    <template v-for="(seg, i) in furiganaAll" :key="'a'+i"><span v-if="seg.vid !== undefined" class="jpdb-word" :class="[seg.stateClass, seg.pitchClass]" :data-vid="seg.vid" :data-sid="seg.sid" data-jpdb="true"><ruby v-if="seg.rt">{{ seg.base }}<rt class="jpdb-furi">{{ seg.rt }}</rt></ruby><template v-else>{{ seg.base }}</template></span><template v-else>{{ seg.base }}</template></template>
                </template>
                <!-- Plain karaoke (no JPDB) -->
                <template v-else-if="karaokeHighlightStart >= 0 && karaokeSplitIndex >= 0">
                    <span class="karaoke-past">{{ karaokePast }}</span><span class="karaoke-spoken">{{ karaokeCurrent }}</span><span class="karaoke-upcoming" :class="{ 'karaoke-hidden': !segmentMode }">{{ karaokeUpcoming }}</span>
                </template>
                <!-- Plain text -->
                <template v-else>{{ primaryText }}</template>
            </div>
            <button
                v-show="enablePlayerTranslator"
                class="learner-en"
                :class="{ blurred: isBlurred && !!secondaryText, 'translation-fallback': isFallback }"
                :aria-label="isBlurred ? t('revealTranslation') : t('hideTranslation')"
                :aria-pressed="!isBlurred"
                @click.stop="toggleBlur"
            >{{ secondaryText }}</button>
        </div>
    </Teleport>
</template>

<style scoped>
/* No additional scoped styles needed - all styles come from _learner.css
   which is imported globally in main.ts. The component uses the same
   class names (.learner-subs-expanded, .learner-subs-collapsed, etc.)
   as the original imperative implementation. */
</style>
