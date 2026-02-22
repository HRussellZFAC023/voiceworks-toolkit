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
import { calculateBottomOffset, getAudioElement, hasValidAudioSource, syncOverflowButtonState } from '../../core/DomUtils';
import { connectAudioAnalyser as connectSharedAudioAnalyser } from '../../core/AudioAnalysis';
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
const FALLBACK_MIN_LEVEL = 0.015;
const FALLBACK_MAX_LEVEL = 0.95;
const WAVE_FALLBACK_POINTS = 720;
const HOST_WAVE_RETRY_MS = 2500;

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
let hostWaveEnvelope: Float32Array | null = null;
let hostWaveEnvelopeKey = '';
let hostWaveRetryAt = 0;

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
    const currentAudio = getAudioElement();
    if (currentAudio && connectedAudioEl === currentAudio && analyser) return;

    const connected = connectSharedAudioAnalyser({
        fftSize: 256,
        smoothingTimeConstant: 0.7,
        tag: 'Visualizer',
        requireValidSource: true,
    });
    if (!connected) {
        analyserAvailable = false;
        return;
    }

    audioCtx = connected.ctx;
    sourceNode = connected.source;
    analyser = connected.analyser;
    connectedAudioEl = connected.audio;
    analyserAvailable = true;
    Logger.debug('[Visualizer] Audio analyser connected');
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

function clamp01(v: number): number {
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.min(1, v));
}

function findHostWaveCanvas(): HTMLCanvasElement | null {
    const selectors = [
        '.player-bar-container canvas',
        '.player-bar canvas',
        '.simple-progress-overlay canvas',
        'canvas#canvas',
    ];
    for (const selector of selectors) {
        const nodes = document.querySelectorAll<HTMLCanvasElement>(selector);
        for (const canvas of Array.from(nodes)) {
            if (!canvas.isConnected) continue;
            if (canvas.width < 64 || canvas.height < 12) continue;
            return canvas;
        }
    }
    return null;
}

function buildHostWaveEnvelope(audio: HTMLAudioElement): void {
    const now = Date.now();
    if (hostWaveRetryAt > now) return;
    const canvas = findHostWaveCanvas();
    if (!canvas) {
        hostWaveRetryAt = now + 700;
        return;
    }

    const src = audio.currentSrc || audio.src || '';
    if (!src) return;
    const nextKey = `${src}|${canvas.width}x${canvas.height}`;
    if (hostWaveEnvelope && hostWaveEnvelopeKey === nextKey) return;

    try {
        const ctx = canvas.getContext('2d');
        if (!ctx || canvas.width <= 0 || canvas.height <= 0) return;

        const width = canvas.width;
        const height = canvas.height;
        const image = ctx.getImageData(0, 0, width, height);
        const data = image.data;
        const points = Math.max(128, Math.min(WAVE_FALLBACK_POINTS, Math.floor(width / 2)));
        const envelope = new Float32Array(points);

        // Estimate background color from all four corners.
        const corners = [0, width - 1, (height - 1) * width, (height * width) - 1];
        let bgR = 0; let bgG = 0; let bgB = 0;
        for (const pos of corners) {
            const idx = pos * 4;
            bgR += data[idx] || 0;
            bgG += data[idx + 1] || 0;
            bgB += data[idx + 2] || 0;
        }
        bgR /= corners.length;
        bgG /= corners.length;
        bgB /= corners.length;

        for (let i = 0; i < points; i++) {
            const x = Math.round((i / Math.max(1, points - 1)) * (width - 1));
            let activePixels = 0;
            let minY = height;
            let maxY = -1;
            let maxDist = 0;
            const mid = (height - 1) / 2;

            for (let y = 0; y < height; y++) {
                const idx = (y * width + x) * 4;
                const a = data[idx + 3] || 0;
                if (a < 10) continue;

                const r = data[idx] || 0;
                const g = data[idx + 1] || 0;
                const b = data[idx + 2] || 0;
                const delta = Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB);
                if (delta <= 24) continue;
                activePixels++;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
                const dist = Math.abs(y - mid);
                if (dist > maxDist) maxDist = dist;
            }

            if (maxY >= 0) {
                const span = (maxY - minY + 1) / Math.max(1, height);
                const distNorm = maxDist / Math.max(1, height * 0.5);
                const density = activePixels / Math.max(1, height);
                // Weighted blend gives stronger correlation to waveform loudness.
                envelope[i] = clamp01((distNorm * 0.72) + (span * 0.18) + (density * 0.10));
            } else {
                envelope[i] = 0;
            }
        }

        // Smooth noisy columns and normalize.
        for (let i = 1; i < envelope.length - 1; i++) {
            envelope[i] = (envelope[i - 1] + envelope[i] * 2 + envelope[i + 1]) / 4;
        }
        let max = 0;
        for (let i = 0; i < envelope.length; i++) max = Math.max(max, envelope[i]);
        if (max <= 0.02) {
            hostWaveRetryAt = now + HOST_WAVE_RETRY_MS;
            return;
        }
        for (let i = 0; i < envelope.length; i++) {
            envelope[i] = clamp01(envelope[i] / max);
        }

        hostWaveEnvelope = envelope;
        hostWaveEnvelopeKey = nextKey;
        hostWaveRetryAt = 0;
    } catch (err) {
        // Canvas may be tainted by the host app in some browsers.
        Logger.debug('[Visualizer] Host waveform fallback unavailable:', err);
        hostWaveRetryAt = now + HOST_WAVE_RETRY_MS;
    }
}

function sampleHostWaveBuckets(audio: HTMLAudioElement): Float32Array | null {
    if (!hostWaveEnvelope || hostWaveEnvelope.length < 4) return null;
    const duration = audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) return null;

    const ratio = clamp01(audio.currentTime / duration);
    const out = new Float32Array(HALF_BARS);
    for (let i = 0; i < HALF_BARS; i++) {
        const rel = (i / Math.max(1, HALF_BARS - 1)) - 0.5; // [-0.5, 0.5]
        const pos = clamp01(ratio + rel * 0.18);
        const center = Math.round(pos * (hostWaveEnvelope.length - 1));
        let sum = 0;
        let weight = 0;

        // Sample a small local window for stability, weighted toward center.
        for (let k = -2; k <= 2; k++) {
            const idx = Math.max(0, Math.min(hostWaveEnvelope.length - 1, center + k));
            const w = 1 / (1 + Math.abs(k));
            sum += (hostWaveEnvelope[idx] || 0) * w;
            weight += w;
        }

        const base = weight > 0 ? sum / weight : 0;
        const centerBias = 1 - Math.abs(rel) * 0.22;
        const level = base * centerBias * 1.18;
        out[i] = Math.max(FALLBACK_MIN_LEVEL, Math.min(FALLBACK_MAX_LEVEL, level));
    }
    return out;
}

function samplePassiveBuckets(): Float32Array {
    const out = new Float32Array(HALF_BARS);
    for (let i = 0; i < HALF_BARS; i++) {
        out[i] = Math.max(FALLBACK_MIN_LEVEL, smoothBars[i] * 0.96);
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
        // Mobile path: use host waveform envelope (track-derived).
        // If unavailable temporarily, decay existing bars instead of synthetic patterns.
        if (!audio || audio.paused) return;
        buildHostWaveEnvelope(audio);
        raw = sampleHostWaveBuckets(audio) || samplePassiveBuckets();
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

        const allowSway = analyserAvailable;
        // Draw mirrored: center outward.  Index 0 = center, HALF_BARS-1 = edge.
        for (let i = 0; i < HALF_BARS; i++) {
            // Idle sway: gentle sine wave that ripples across bars
            const sway = allowSway ? 0.03 * Math.sin(phase + i * 0.25) : 0;
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
        const bottomOffset = calculateBottomOffset({ includeVizBar: false });
        bar.style.bottom = `${bottomOffset}px`;
    }
}

// ---------------------------------------------------------------------------
// Overflow Button Sync
// ---------------------------------------------------------------------------

function syncOverflowButton(active: boolean) {
    syncOverflowButtonState('.asmr-viz-btn', active);
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
        hostWaveEnvelope = null;
        hostWaveEnvelopeKey = '';
        hostWaveRetryAt = 0;
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
