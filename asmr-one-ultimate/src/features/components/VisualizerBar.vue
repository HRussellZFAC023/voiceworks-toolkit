<script setup lang="ts">
/**
 * VisualizerBar.vue - Real-time audio frequency visualization
 *
 * Renders frequency bars via Web Audio API AnalyserNode on a <canvas>.
 * Expanded bar renders in-place (inside .audio-player); collapsed bar
 * is teleported to <body> for fixed positioning above the mini player.
 */

import {
    ref, computed, watch, onMounted, onUnmounted, nextTick, Teleport,
} from 'vue';

import { useEventBus } from '../../composables/useEventBus';
import { useI18n } from '../../composables/useI18n';
import { getAudioElement, getPlayerBar, hasValidAudioSource } from '../../core/DomUtils';
import { getOrCreateSourceNode } from '../../core/AudioAnalysis';
import { AppStore } from '../../store/AppStore';
import { Logger } from '../../core/Utils';

// ---------------------------------------------------------------------------
// Composables
// ---------------------------------------------------------------------------

const { on, emit } = useEventBus();
const { t } = useI18n();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HALF_BARS = 24;          // bars per side (mirrored = 48 total)
const BAR_GAP = 2;
const BAR_RADIUS = 2;
const POSITION_POLL_MS = 500;
const SMOOTHING = 0.35;        // lerp factor toward new value (lower = smoother)
const FALLBACK_MIN_LEVEL = 0.05;
const FALLBACK_MAX_LEVEL = 0.95;

// ---------------------------------------------------------------------------
// Reactive state
// ---------------------------------------------------------------------------

const isActive = ref(false);
const isPaused = ref(false);
const hasAudioSource = ref(false);

// Template refs
const expandedCanvas = ref<HTMLCanvasElement | null>(null);
const collapsedCanvas = ref<HTMLCanvasElement | null>(null);
const collapsedBar = ref<HTMLElement | null>(null);

// ---------------------------------------------------------------------------
// Non-reactive state
// ---------------------------------------------------------------------------

let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let sourceNode: MediaElementAudioSourceNode | null = null;
let connectedAudioEl: HTMLAudioElement | null = null;
let analyserAvailable = false;
let animFrameId: number | null = null;
let positionPollId: number | null = null;
let audioCleanups: (() => void)[] = [];
let smoothBars = new Float32Array(HALF_BARS);  // smoothed bar heights [0..1]
let phase = 0;                                  // slow phase for idle sway

// ---------------------------------------------------------------------------
// Computed
// ---------------------------------------------------------------------------

const isPlayerMinimized = ref(false);

const showExpanded = computed(() => isActive.value && hasAudioSource.value && !isPlayerMinimized.value);
const showCollapsed = computed(() => isActive.value && hasAudioSource.value && isPlayerMinimized.value);

function refreshMinimizedState() {
    isPlayerMinimized.value = !!AppStore.state?.player?.hide || !!AppStore.player?.hide;
}

function refreshAudioSourceState(): boolean {
    hasAudioSource.value = hasValidAudioSource();
    return hasAudioSource.value;
}

// ---------------------------------------------------------------------------
// Toggle
// ---------------------------------------------------------------------------

function toggle() {
    if (isActive.value) {
        deactivate();
    } else {
        activate();
    }
}

function activate() {
    isActive.value = true;
    isPaused.value = false;
    refreshMinimizedState();
    refreshAudioSourceState();
    connectAudioAnalyser();
    syncPauseState();
    startRendering();
    startPositionPolling();
    syncOverflowButton(true);
    Logger.log('[Visualizer] Activated');
}

function deactivate() {
    isActive.value = false;
    stopRendering();
    stopPositionPolling();
    cleanupAudioListeners();
    syncOverflowButton(false);
    Logger.log('[Visualizer] Deactivated');
}

// ---------------------------------------------------------------------------
// Audio Analysis
// ---------------------------------------------------------------------------

function connectAudioAnalyser() {
    const audio = getAudioElement();
    if (!audio || !hasValidAudioSource(audio)) {
        Logger.debug('[Visualizer] No valid audio source found');
        analyserAvailable = false;
        return;
    }

    if (connectedAudioEl === audio && analyser) return;

    const result = getOrCreateSourceNode(audio);
    if (!result) {
        Logger.debug('[Visualizer] Audio analyser failed (cross-origin?)');
        analyserAvailable = false;
        return;
    }

    try {
        audioCtx = result.ctx;
        sourceNode = result.source;

        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.7;
        sourceNode.connect(analyser);

        connectedAudioEl = audio;
        analyserAvailable = true;
        Logger.debug('[Visualizer] Audio analyser connected');
    } catch (err) {
        Logger.debug('[Visualizer] Audio analyser failed:', err);
        analyserAvailable = false;
    }
}

// ---------------------------------------------------------------------------
// Canvas Rendering
// ---------------------------------------------------------------------------

function startRendering() {
    stopRendering();
    const draw = () => {
        if (!isActive.value) return;
        animFrameId = requestAnimationFrame(draw);
        if (isPaused.value) return;
        renderFrame();
    };
    animFrameId = requestAnimationFrame(draw);
}

function stopRendering() {
    if (animFrameId !== null) {
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
    }
}

/**
 * Sample frequency data into HALF_BARS buckets using logarithmic scaling.
 * Low frequencies get fewer bins (they're spaced wider in log-space),
 * high frequencies get more — this balances the visual energy across bars.
 */
function sampleLogBuckets(data: Uint8Array): Float32Array {
    const n = data.length;
    const out = new Float32Array(HALF_BARS);
    // Map each bar to a logarithmically-spaced frequency range
    for (let i = 0; i < HALF_BARS; i++) {
        const loFrac = i / HALF_BARS;
        const hiFrac = (i + 1) / HALF_BARS;
        // Exponential mapping: bin = n^(frac)  scaled to [1..n]
        const lo = Math.floor(Math.pow(n, loFrac));
        const hi = Math.max(lo + 1, Math.floor(Math.pow(n, hiFrac)));
        let sum = 0;
        let count = 0;
        for (let j = lo; j < hi && j < n; j++) {
            sum += data[j];
            count++;
        }
        out[i] = count > 0 ? (sum / count) / 255 : 0;
    }
    return out;
}

/**
 * Mobile-safe fallback (no analyser): synthesize lively bars from playback time.
 * This keeps the visualizer usable on iOS Safari where we intentionally avoid
 * createMediaElementSource() to preserve lock-screen/background audio playback.
 */
function sampleFallbackBuckets(timeSec: number, playbackRate: number): Float32Array {
    const out = new Float32Array(HALF_BARS);
    const speed = Math.max(0.6, Math.min(2.5, Number.isFinite(playbackRate) ? playbackRate : 1));

    for (let i = 0; i < HALF_BARS; i++) {
        const centerBias = 1 - (i / Math.max(1, HALF_BARS - 1)) * 0.55;
        const waveA = 0.52 + 0.34 * Math.sin(timeSec * (2.2 * speed) + i * 0.42);
        const waveB = 0.20 * Math.sin(timeSec * (0.9 * speed) + i * 0.18 + phase * 0.7);
        const ripple = 0.10 * Math.sin(phase * 4.0 + i * 1.3);
        const level = (waveA + waveB + ripple) * centerBias;
        out[i] = Math.max(FALLBACK_MIN_LEVEL, Math.min(FALLBACK_MAX_LEVEL, level));
    }

    return out;
}

function renderFrame() {
    const audio = getAudioElement();
    let raw: Float32Array;
    if (analyser && analyserAvailable) {
        const data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(data);
        raw = sampleLogBuckets(data);
    } else {
        // Fallback path for mobile Safari (no analyser by design in AudioAnalysis.ts).
        if (!audio || audio.paused) return;
        raw = sampleFallbackBuckets(audio.currentTime || phase, audio.playbackRate || 1);
    }

    // Smooth toward new values + advance idle sway phase
    phase += 0.015;
    for (let i = 0; i < HALF_BARS; i++) {
        smoothBars[i] += (raw[i] - smoothBars[i]) * SMOOTHING;
    }

    const canvases: (HTMLCanvasElement | null)[] = [expandedCanvas.value, collapsedCanvas.value];
    for (const canvas of canvases) {
        if (!canvas || !canvas.isConnected) continue;
        const parentEl = canvas.closest('.asmr-viz-bar') as HTMLElement | null;
        if (parentEl && (parentEl.style.display === 'none' || parentEl.classList.contains('hidden'))) continue;

        const ctx = canvas.getContext('2d');
        if (!ctx) continue;

        const rect = canvas.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;

        const dpr = window.devicePixelRatio || 1;
        const w = Math.round(rect.width * dpr);
        const h = Math.round(rect.height * dpr);
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }

        ctx.clearRect(0, 0, w, h);

        const totalBars = HALF_BARS * 2;
        const barWidth = Math.max(1, (w - BAR_GAP * (totalBars - 1)) / totalBars);
        const [r1, g1, b1] = getAccentRGB(canvas);    // primary accent
        const [r2, g2, b2] = [r1 + 60, g1 - 20, b1];  // shifted hue for gradient

        // Soft glow behind bars
        ctx.shadowColor = `rgba(${r1}, ${g1}, ${b1}, 0.35)`;
        ctx.shadowBlur = 8 * dpr;

        // Draw mirrored: center outward.  Index 0 = center, HALF_BARS-1 = edge.
        for (let i = 0; i < HALF_BARS; i++) {
            // Idle sway: gentle sine wave that ripples across bars
            const sway = 0.03 * Math.sin(phase + i * 0.25);
            const val = Math.min(1, Math.max(0, smoothBars[i] + sway));
            const barH = Math.max(2 * dpr, val * h * 0.92);

            // Lerp colour from accent → shifted based on distance from center
            const t = i / (HALF_BARS - 1);
            const cr = Math.round(r1 + (r2 - r1) * t);
            const cg = Math.round(g1 + (g2 - g1) * t);
            const cb = Math.round(b1 + (b2 - b1) * t);
            const alpha = 0.45 + val * 0.55;

            ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${alpha})`;

            // Right half: center → right
            const xR = (HALF_BARS + i) * (barWidth + BAR_GAP);
            drawRoundedBar(ctx, xR, h - barH, barWidth, barH, BAR_RADIUS * dpr);

            // Left half: center → left  (mirror)
            const xL = (HALF_BARS - 1 - i) * (barWidth + BAR_GAP);
            drawRoundedBar(ctx, xL, h - barH, barWidth, barH, BAR_RADIUS * dpr);
        }

        // Reset shadow so it doesn't leak
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
    }
}

function drawRoundedBar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: number) {
    const r = Math.min(radius, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h);
    ctx.closePath();
    ctx.fill();
}

let cachedAccentRGB: [number, number, number] | null = null;
function getAccentRGB(el: HTMLElement): [number, number, number] {
    if (cachedAccentRGB) return cachedAccentRGB;
    const accent = getComputedStyle(el).getPropertyValue('--asmr-accent').trim();
    if (accent.startsWith('#') && accent.length >= 7) {
        cachedAccentRGB = [
            parseInt(accent.slice(1, 3), 16),
            parseInt(accent.slice(3, 5), 16),
            parseInt(accent.slice(5, 7), 16),
        ];
        return cachedAccentRGB;
    }
    return [124, 77, 255];
}

// ---------------------------------------------------------------------------
// Pause Awareness
// ---------------------------------------------------------------------------

function cleanupAudioListeners() {
    audioCleanups.forEach(fn => fn());
    audioCleanups = [];
}

function syncPauseState() {
    cleanupAudioListeners();
    const audio = getAudioElement();
    if (!audio) return;

    const onPause = () => { isPaused.value = true; };
    const onPlay = () => {
        isPaused.value = false;
        if (audioCtx?.state === 'suspended') audioCtx.resume().catch(() => {});
    };

    audio.addEventListener('pause', onPause);
    audio.addEventListener('play', onPlay);
    audioCleanups.push(
        () => audio.removeEventListener('pause', onPause),
        () => audio.removeEventListener('play', onPlay),
    );

    isPaused.value = audio.paused;
}

// ---------------------------------------------------------------------------
// Collapsed Bar Positioning
// ---------------------------------------------------------------------------

function startPositionPolling() {
    stopPositionPolling();
    updatePosition();
    positionPollId = window.setInterval(updatePosition, POSITION_POLL_MS);
}

function stopPositionPolling() {
    if (positionPollId !== null) {
        clearInterval(positionPollId);
        positionPollId = null;
    }
}

function updatePosition() {
    refreshMinimizedState();
    const hadAudioSource = hasAudioSource.value;
    const hasSource = refreshAudioSourceState();

    if (isActive.value && hasSource && (!hadAudioSource || !analyserAvailable)) {
        connectedAudioEl = null;
        analyser = null;
        connectAudioAnalyser();
        syncPauseState();
    }

    const bar = collapsedBar.value;
    if (!bar?.isConnected || !isActive.value) return;

    if (isPlayerMinimized.value) {
        const playerBar = getPlayerBar();
        const subsBar = document.querySelector('body > .learner-subs-collapsed') as HTMLElement | null;
        const joiBar = document.querySelector('body > .asmr-joi-bar-collapsed') as HTMLElement | null;

        let bottomOffset = playerBar?.offsetHeight || 60;

        if (subsBar && subsBar.style.display !== 'none' && !subsBar.classList.contains('hidden') && subsBar.offsetHeight > 0) {
            bottomOffset += subsBar.offsetHeight;
        }
        if (joiBar && joiBar.style.display !== 'none' && !joiBar.classList.contains('hidden') && joiBar.offsetHeight > 0) {
            bottomOffset += joiBar.offsetHeight;
        }

        bar.style.bottom = `${bottomOffset}px`;
    }
}

// ---------------------------------------------------------------------------
// Overflow Button Sync
// ---------------------------------------------------------------------------

function syncOverflowButton(active: boolean) {
    document.querySelectorAll('.asmr-viz-btn').forEach(btn => {
        const icon = btn.querySelector('.material-icons');
        if (icon) icon.classList.toggle('asmr-accent', active);
        btn.classList.toggle('learner-btn-active', active);
    });
}

// ---------------------------------------------------------------------------
// Event Listeners
// ---------------------------------------------------------------------------

on('viz:toggle', () => toggle());

on('track:change', () => {
    if (isActive.value) {
        refreshAudioSourceState();
        connectedAudioEl = null;
        analyser = null;
        connectAudioAnalyser();
        syncPauseState();
    } else if (AppStore.getConfig('alwaysShowVisualizer')) {
        activate();
    }
});

on('config:change', ({ key, value }) => {
    if (key === 'alwaysShowVisualizer') {
        if (value && !isActive.value) activate();
        else if (!value && isActive.value) deactivate();
    }
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

onMounted(() => {
    Logger.debug('[Visualizer] Mounted');
    if (AppStore.getConfig('alwaysShowVisualizer') && !isActive.value) {
        activate();
    }
});

onUnmounted(() => {
    stopRendering();
    stopPositionPolling();
    cleanupAudioListeners();
    syncOverflowButton(false);
    Logger.debug('[Visualizer] Unmounted');
});
</script>

<template>
    <!-- Expanded bar (rendered in-place, inside audio player via controller) -->
    <div
        class="asmr-viz-bar"
        :class="{ hidden: !showExpanded, 'asmr-viz-paused': isPaused }"
        role="region"
        :aria-label="t('enableVisualizer')"
    >
        <canvas ref="expandedCanvas" class="asmr-viz-canvas"></canvas>
        <button class="asmr-viz-close" :title="t('vizToggle')" @click.prevent.stop="deactivate">
            <i class="material-icons" aria-hidden="true">close</i>
        </button>
    </div>

    <!-- Collapsed bar (teleported to body for fixed positioning) -->
    <Teleport to="body">
        <div
            ref="collapsedBar"
            class="asmr-viz-bar asmr-viz-bar-collapsed"
            :class="{ hidden: !showCollapsed, 'asmr-viz-paused': isPaused }"
            role="region"
            :aria-label="t('enableVisualizer')"
        >
            <canvas ref="collapsedCanvas" class="asmr-viz-canvas"></canvas>
            <button class="asmr-viz-close" :title="t('vizToggle')" @click.prevent.stop="deactivate">
                <i class="material-icons" aria-hidden="true">close</i>
            </button>
        </div>
    </Teleport>
</template>
