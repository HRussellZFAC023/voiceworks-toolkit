<script setup lang="ts">
/**
 * PlayerFullscreen.vue - Expands the audio player to fill the viewport.
 *
 * Renders one stable fullscreen control inside the injected feature root. The
 * host control is not present in every player build, so relying on it left the
 * keyboard shortcut as the only discoverable entry point.
 *
 * Entry: the `f` keyboard shortcut (KeyboardManager -> controller.toggle()) or
 * any other caller of the exposed `toggleFullscreen`. Exit: the same shortcut,
 * Escape, or a downward swipe.
 */

import { ref, onMounted, onUnmounted } from 'vue';
import { useEventBus } from '../../composables/useEventBus';
import { useAppStore } from '../../composables/useAppStore';
import { useI18n } from '../../composables/useI18n';
import { AppStore } from '../../store/AppStore';
import { Logger } from '../../core/Utils';

const SWIPE_THRESHOLD = 80;   // px downward to trigger exit
const SWIPE_MAX_TIME = 400;   // ms max duration for swipe gesture
const IDLE_TIMEOUT = 4000;    // ms before auto-hiding controls on touch devices

// -- Composables --
const { emit } = useEventBus();
const appStore = useAppStore();
const { t } = useI18n();

// -- Reactive state --
const isFullscreen = ref(false);

// Touch tracking (non-reactive, internal only)
let touchStartY = 0;
let touchStartX = 0;
let touchStartTime = 0;

// Idle auto-hide for touch devices
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const isTouchDevice = window.matchMedia('(hover: none)').matches;

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
        type="button"
        class="asmr-fullscreen-btn"
        :aria-label="isFullscreen ? t('fullscreenExit') : t('fullscreenToggle')"
        :title="isFullscreen ? t('fullscreenExit') : t('fullscreenToggle')"
        :aria-pressed="isFullscreen"
        @click.stop="toggleFullscreen"
    >
        <i class="material-icons" aria-hidden="true">
            {{ isFullscreen ? 'fullscreen_exit' : 'fullscreen' }}
        </i>
    </button>
</template>
