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
import { getAudioElement, getPlayerBar } from '../../core/DomUtils';
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

const BAR_COUNT = 40;
const BAR_GAP = 2;
const BAR_RADIUS = 2;
const POSITION_POLL_MS = 500;

// ---------------------------------------------------------------------------
// Reactive state
// ---------------------------------------------------------------------------

const isActive = ref(false);
const isPaused = ref(false);

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

// ---------------------------------------------------------------------------
// Computed
// ---------------------------------------------------------------------------

const isPlayerMinimized = computed(() =>
    !!AppStore.state?.player?.hide || !!AppStore.player?.hide,
);

const showExpanded = computed(() => isActive.value && !isPlayerMinimized.value);
const showCollapsed = computed(() => isActive.value && isPlayerMinimized.value);

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
    if (!audio) {
        Logger.debug('[Visualizer] No audio element found');
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

function renderFrame() {
    if (!analyser || !analyserAvailable) return;

    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);

    const canvases: (HTMLCanvasElement | null)[] = [expandedCanvas.value, collapsedCanvas.value];
    for (const canvas of canvases) {
        if (!canvas || !canvas.isConnected) continue;
        // Skip if parent is hidden
        const parent = canvas.closest('.asmr-viz-bar') as HTMLElement | null;
        if (parent && (parent.style.display === 'none' || parent.classList.contains('hidden'))) continue;

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

        const step = Math.floor(data.length / BAR_COUNT);
        const barWidth = Math.max(1, (w - BAR_GAP * (BAR_COUNT - 1)) / BAR_COUNT);
        const accentRGB = getAccentColor(canvas);

        for (let i = 0; i < BAR_COUNT; i++) {
            let sum = 0;
            for (let j = 0; j < step; j++) {
                sum += data[i * step + j] || 0;
            }
            const avg = sum / step;
            const normalised = avg / 255;
            const barHeight = Math.max(2 * dpr, normalised * h * 0.9);

            const x = i * (barWidth + BAR_GAP);
            const y = h - barHeight;

            const alpha = 0.4 + normalised * 0.6;
            ctx.fillStyle = `rgba(${accentRGB}, ${alpha})`;

            const r = Math.min(BAR_RADIUS * dpr, barWidth / 2, barHeight / 2);
            ctx.beginPath();
            ctx.moveTo(x, y + barHeight);
            ctx.lineTo(x, y + r);
            ctx.quadraticCurveTo(x, y, x + r, y);
            ctx.lineTo(x + barWidth - r, y);
            ctx.quadraticCurveTo(x + barWidth, y, x + barWidth, y + r);
            ctx.lineTo(x + barWidth, y + barHeight);
            ctx.closePath();
            ctx.fill();
        }
    }
}

let cachedAccentRGB: string | null = null;
function getAccentColor(el: HTMLElement): string {
    if (cachedAccentRGB) return cachedAccentRGB;
    const accent = getComputedStyle(el).getPropertyValue('--asmr-accent').trim();
    if (accent.startsWith('#') && accent.length >= 7) {
        const r = parseInt(accent.slice(1, 3), 16);
        const g = parseInt(accent.slice(3, 5), 16);
        const b = parseInt(accent.slice(5, 7), 16);
        cachedAccentRGB = `${r}, ${g}, ${b}`;
        return cachedAccentRGB;
    }
    return '124, 77, 255';
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
        connectedAudioEl = null;
        analyser = null;
        connectAudioAnalyser();
        syncPauseState();
    }
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

onMounted(() => {
    Logger.debug('[Visualizer] Mounted');
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
