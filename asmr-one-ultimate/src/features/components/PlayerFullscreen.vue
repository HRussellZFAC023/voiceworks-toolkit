<script setup lang="ts">
/**
 * PlayerFullscreen.vue - Expands the audio player to fill the viewport.
 *
 * Renders a fullscreen toggle button inside the audio player.
 * Toggles a CSS class that makes the player fill the screen.
 *
 * Exit methods: button click, Escape key, swipe down.
 */

import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { useEventBus } from '../../composables/useEventBus';
import { useAppStore } from '../../composables/useAppStore';
import { AppStore } from '../../store/AppStore';
import { Logger } from '../../core/Utils';

const SWIPE_THRESHOLD = 80;   // px downward to trigger exit
const SWIPE_MAX_TIME = 400;   // ms max duration for swipe gesture
const IDLE_TIMEOUT = 4000;    // ms before auto-hiding controls on touch devices

// -- Composables --
const { t } = useI18n();
const { emit } = useEventBus();
const appStore = useAppStore();

// -- Reactive state --
const isFullscreen = ref(false);

// Touch tracking (non-reactive, internal only)
let touchStartY = 0;
let touchStartX = 0;
let touchStartTime = 0;

// Idle auto-hide for touch devices
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const isTouchDevice = window.matchMedia('(hover: none)').matches;

// -- Computed --
const iconName = computed(() => isFullscreen.value ? 'fullscreen_exit' : 'fullscreen');
const buttonLabel = computed(() =>
    isFullscreen.value ? t('fullscreenExit') : t('fullscreenToggle')
);

// -- Idle auto-hide (touch devices only) --

function startIdleTimer(): void {
    if (!isTouchDevice) return;
    clearIdleTimer();
    idleTimer = setTimeout(hideControls, IDLE_TIMEOUT);
}

function clearIdleTimer(): void {
    if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
}

function showControls(): void {
    const player = document.querySelector('.audio-player');
    if (player) player.classList.remove('asmr-controls-idle');
    startIdleTimer();
}

function hideControls(): void {
    const player = document.querySelector('.audio-player');
    if (player && isFullscreen.value) player.classList.add('asmr-controls-idle');
}

// -- Actions --

let lastToggleTime = 0;
const TOGGLE_COOLDOWN = 300; // ms - prevent rapid toggling

function toggleFullscreen(): void {
    const now = Date.now();
    if (now - lastToggleTime < TOGGLE_COOLDOWN) return;
    lastToggleTime = now;
    isFullscreen.value ? exit() : enter();
}

function onToggleClick(e: Event): void {
    e.preventDefault();
    e.stopPropagation();
    toggleFullscreen();
}

function enter(): void {
    const player = document.querySelector('.audio-player');
    if (!player) return;

    // Ensure player is expanded in the host store
    if (appStore.state.player?.hide) {
        try {
            AppStore.commit('AudioPlayer/TOGGLE_HIDE');
        } catch { /* host store may not be ready */ }
    }

    player.classList.add('asmr-player-fullscreen');
    document.body.classList.add('asmr-fullscreen-active', 'asmr-lock-scroll');
    isFullscreen.value = true;

    document.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
    document.addEventListener('touchend', onTouchEnd, { passive: true, capture: true });

    startIdleTimer();

    emit('fullscreen:enter', undefined);
    Logger.debug('[PlayerFullscreen] Entered fullscreen');
}

function exit(): void {
    if (!isFullscreen.value) return;

    clearIdleTimer();
    const player = document.querySelector('.audio-player');
    if (player) {
        player.classList.remove('asmr-player-fullscreen', 'asmr-controls-idle');
    }

    document.body.classList.remove('asmr-fullscreen-active', 'asmr-lock-scroll');
    isFullscreen.value = false;

    document.removeEventListener('touchstart', onTouchStart, true);
    document.removeEventListener('touchend', onTouchEnd, true);

    emit('fullscreen:exit', undefined);
    Logger.debug('[PlayerFullscreen] Exited fullscreen');
}

// -- Escape key handler --

function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && isFullscreen.value) {
        // Let the lightbox close first if it's open
        if (document.querySelector('.media-viewer-modal.active')) return;
        e.preventDefault();
        e.stopPropagation();
        exit();
    }
}

// -- Swipe-down to exit fullscreen --

function onTouchStart(e: TouchEvent): void {
    if (!isFullscreen.value || e.touches.length !== 1) return;

    // Any touch resets idle timer (keeps controls visible while interacting)
    showControls();

    // Don't track swipes on interactive controls (sliders, buttons, inputs)
    const target = e.touches[0].target as HTMLElement;
    if (isInteractiveElement(target)) return;

    touchStartY = e.touches[0].clientY;
    touchStartX = e.touches[0].clientX;
    touchStartTime = Date.now();
}

function onTouchEnd(e: TouchEvent): void {
    if (!isFullscreen.value || !touchStartTime) return;
    if (!e.changedTouches.length) return;

    const dy = e.changedTouches[0].clientY - touchStartY;
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dt = Date.now() - touchStartTime;

    touchStartTime = 0;

    // Must be: downward, mostly vertical, fast enough, far enough
    if (dy > SWIPE_THRESHOLD && dt < SWIPE_MAX_TIME && Math.abs(dy) > Math.abs(dx) * 1.5) {
        exit();
    }
}

function isInteractiveElement(el: HTMLElement): boolean {
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    // Sliders, seek bars, volume controls
    if (el.closest('.plyr__progress, .ant-slider, .asmr-speed-slider, input[type="range"]')) return true;
    return false;
}

// -- Re-sync fullscreen class when Vue re-creates the player element --

function syncFullscreenClass(): void {
    if (!isFullscreen.value) return;
    const player = document.querySelector('.audio-player');
    if (player && !player.classList.contains('asmr-player-fullscreen')) {
        player.classList.add('asmr-player-fullscreen');
        document.body.classList.add('asmr-fullscreen-active', 'asmr-lock-scroll');
        emit('fullscreen:enter', undefined);
        Logger.debug('[PlayerFullscreen] Re-synced fullscreen class after DOM re-creation');
    }
}

// -- Lifecycle --

onMounted(() => {
    document.addEventListener('keydown', onKeydown, true);
    Logger.log('[PlayerFullscreen] Mounted');
});

onUnmounted(() => {
    clearIdleTimer();
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('touchstart', onTouchStart, true);
    document.removeEventListener('touchend', onTouchEnd, true);

    // Clean up fullscreen state if component is unmounted while active
    if (isFullscreen.value) {
        const player = document.querySelector('.audio-player');
        if (player) player.classList.remove('asmr-player-fullscreen', 'asmr-controls-idle');
        document.body.classList.remove('asmr-fullscreen-active', 'asmr-lock-scroll');
    }

    Logger.log('[PlayerFullscreen] Unmounted');
});

// Expose for controller to call syncFullscreenClass from CentralObserver
defineExpose({ syncFullscreenClass, toggleFullscreen, exit, isFullscreen });
</script>

<template>
    <button
        class="asmr-fullscreen-btn"
        :aria-label="buttonLabel"
        :title="buttonLabel"
        @click="onToggleClick"
    >
        <i class="material-icons" role="img" aria-hidden="true">{{ iconName }}</i>
    </button>
</template>

<style scoped>
.asmr-fullscreen-btn {
    position: absolute !important;
    top: 8px !important;
    right: 8px !important;
    z-index: 1000000 !important;
    width: 44px !important;
    height: 44px !important;
    background: transparent !important;
    backdrop-filter: none !important;
    border: 1px solid transparent !important;
    border-radius: 50% !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    color: #111827 !important;
    opacity: 0.28 !important;
    cursor: pointer !important;
    box-shadow: none !important;
    transition: background-color 0.18s ease, border-color 0.18s ease, opacity 0.18s ease, transform 0.18s ease !important;
}

.asmr-fullscreen-btn:hover {
    background: rgba(255, 255, 255, 0.78) !important;
    border-color: rgba(17, 24, 39, 0.45) !important;
    opacity: 1 !important;
    transform: scale(1.05) !important;
}

.asmr-fullscreen-btn:focus-visible {
    background: rgba(255, 255, 255, 0.78) !important;
    opacity: 1 !important;
    outline: 3px solid #1976d2 !important;
    outline-offset: 2px !important;
}

.asmr-fullscreen-btn :deep(.material-icons) {
    font-size: 22px !important;
}
</style>
