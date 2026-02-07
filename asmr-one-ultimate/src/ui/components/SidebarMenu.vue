<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { useConfig } from '../../composables/useConfig';
import { useEventBus } from '../../composables/useEventBus';
import { RadioMode } from '../../features/radio';
import { PlaylistMode } from '../../features/playlist';
import { PLAYER_BAR_SELECTOR } from '../../core/DomUtils';
import { Logger } from '../../core/Utils';

// ============================================================================
// Props
// ============================================================================

const props = defineProps<{
    onRadioToggle: () => void;
}>();

// ============================================================================
// Composables
// ============================================================================

const { t } = useI18n();
const { on } = useEventBus();

// ============================================================================
// Reactive config bindings
// ============================================================================

const sfwMode = useConfig('sfwMode');
const translateMode = useConfig('translateMode');

// ============================================================================
// Local reactive state
// ============================================================================

const radioActive = ref(RadioMode.isActive);
const playlistActive = ref(false);
const playlistCurrent = ref(1);
const playlistTotal = ref(1);

// ============================================================================
// Computed
// ============================================================================

const radioStatusText = computed(() => radioActive.value ? t('on') : t('off'));
const sfwStatusText = computed(() => sfwMode.value ? t('on') : t('off'));
const translateStatusText = computed(() => translateMode.value ? t('on') : t('off'));

// ============================================================================
// Handlers
// ============================================================================

function handleRadioToggle() {
    props.onRadioToggle();
}

function handleRadioKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleRadioToggle();
    }
}

function handleSfwToggle() {
    sfwMode.value = !sfwMode.value;
}

function handleSfwKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleSfwToggle();
    }
}

function handleTranslateToggle() {
    translateMode.value = !translateMode.value;
    // Reload to apply/remove translations cleanly
    location.reload();
}

function handleTranslateKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleTranslateToggle();
    }
}

// ============================================================================
// Playlist player bar controls (imperative DOM - separate injection point)
// ============================================================================

let playlistControlsEl: HTMLElement | null = null;

function ensurePlaylistControls() {
    if (playlistControlsEl && playlistControlsEl.isConnected) {
        playlistControlsEl.style.display = 'flex';
        return;
    }

    // Remove stale instances
    const existing = document.getElementById('asmr-playlist-player-controls');
    if (existing) existing.remove();

    const playerBar = document.querySelector(PLAYER_BAR_SELECTOR);
    if (!playerBar) {
        Logger.warn('[SidebarMenu] Player bar not found, retrying in 1s');
        setTimeout(() => ensurePlaylistControls(), 1000);
        return;
    }

    const container = document.createElement('div');
    container.className = 'asmr-playlist-player-controls';
    container.id = 'asmr-playlist-player-controls';

    container.innerHTML = `
        <button class="asmr-playlist-player-btn asmr-playlist-prev" title="${t('playlistPrevWork')}" aria-label="${t('playlistPrevWork')}">
            <i class="material-icons" aria-hidden="true">skip_previous</i>
        </button>
        <span class="asmr-playlist-player-progress" aria-live="polite">${playlistCurrent.value} / ${playlistTotal.value}</span>
        <button class="asmr-playlist-player-btn asmr-playlist-next" title="${t('playlistNextWork')}" aria-label="${t('playlistNextWork')}">
            <i class="material-icons" aria-hidden="true">skip_next</i>
        </button>
        <button class="asmr-playlist-player-btn asmr-playlist-shuffle" title="${t('shuffle') || 'Shuffle'}" aria-label="${t('shuffle') || 'Shuffle'}">
            <i class="material-icons" aria-hidden="true">shuffle</i>
        </button>
    `;

    playerBar.insertBefore(container, playerBar.firstChild);
    playlistControlsEl = container;

    // Bind click handlers
    container.querySelector('.asmr-playlist-prev')?.addEventListener('click', (e) => {
        e.stopPropagation();
        PlaylistMode.getInstance().previous();
    });
    container.querySelector('.asmr-playlist-next')?.addEventListener('click', (e) => {
        e.stopPropagation();
        PlaylistMode.getInstance().next();
    });
    container.querySelector('.asmr-playlist-shuffle')?.addEventListener('click', (e) => {
        e.stopPropagation();
        PlaylistMode.getInstance().shuffle();
        const icon = container.querySelector('.asmr-playlist-shuffle .material-icons');
        if (icon) {
            icon.classList.add('asmr-accent');
            setTimeout(() => icon.classList.remove('asmr-accent'), 1000);
        }
    });

    // Get current progress
    const pm = PlaylistMode.getInstance();
    if (pm.isActive) {
        const progress = pm.getProgress();
        updatePlayerBarProgress(progress.current, progress.total);
    }

    Logger.debug('[SidebarMenu] Playlist controls injected into player bar');
}

function updatePlayerBarProgress(current: number, total: number) {
    if (!playlistControlsEl) return;
    const progressEl = playlistControlsEl.querySelector('.asmr-playlist-player-progress');
    if (progressEl) {
        progressEl.textContent = `${current} / ${total}`;
    }

    const prevBtn = playlistControlsEl.querySelector('.asmr-playlist-prev') as HTMLButtonElement | null;
    if (prevBtn) {
        const disabled = current <= 1;
        prevBtn.disabled = disabled;
        prevBtn.classList.toggle('disabled', disabled);
    }

    const nextBtn = playlistControlsEl.querySelector('.asmr-playlist-next') as HTMLButtonElement | null;
    if (nextBtn) {
        const disabled = current >= total;
        nextBtn.disabled = disabled;
        nextBtn.classList.toggle('disabled', disabled);
    }
}

function updatePlaylistHostDOM(isActive: boolean) {
    // Adjust page container padding to prevent overlap with player bar
    const pageContainer = document.querySelector('.q-page-container') as HTMLElement | null;
    if (pageContainer) {
        pageContainer.style.paddingBottom = isActive
            ? 'calc(var(--q-footer-height, 64px) + 40px)'
            : '';
    }

    // Adjust sidebar padding
    const sidebar = document.querySelector('.q-drawer--left .q-list') ||
        document.querySelector('.q-drawer .q-list') ||
        document.querySelector('.q-drawer--left .q-scrollarea__content') ||
        document.querySelector('.q-drawer') as HTMLElement | null;
    if (sidebar) {
        (sidebar as HTMLElement).style.paddingBottom = isActive
            ? 'calc(var(--q-footer-height, 64px) + 20px)'
            : '';

        // Highlight the playlists nav item
        const playlistItem = Array.from(sidebar.querySelectorAll('a.q-item'))
            .find(el => el.getAttribute('href') === '/playlists');
        if (playlistItem) {
            playlistItem.classList.toggle('q-item--active', isActive);
            playlistItem.classList.toggle('text-primary', isActive);
        }
    }

    // Show/hide playlist player bar controls
    if (isActive) {
        ensurePlaylistControls();
    }
    if (playlistControlsEl) {
        playlistControlsEl.style.display = isActive ? 'flex' : 'none';
    }
}

// ============================================================================
// EventBus subscriptions
// ============================================================================

on('radio:toggle', (payload) => {
    radioActive.value = payload.isActive;
});

on('playlist:active', (payload) => {
    playlistActive.value = payload.isActive;
    if (payload.isActive && payload.workIds && payload.workIds.length > 0) {
        playlistCurrent.value = 1;
        playlistTotal.value = payload.workIds.length;
    }
    updatePlaylistHostDOM(payload.isActive);
    updatePlayerBarProgress(playlistCurrent.value, playlistTotal.value);
});

on('playlist:progress', (payload) => {
    playlistCurrent.value = payload.current;
    playlistTotal.value = payload.total;
    updatePlayerBarProgress(payload.current, payload.total);
});

on('playlist:shuffled', (payload) => {
    playlistCurrent.value = payload.currentWorkIndex + 1;
    playlistTotal.value = payload.workIds.length;
    updatePlayerBarProgress(playlistCurrent.value, playlistTotal.value);
});

// ============================================================================
// Lifecycle
// ============================================================================

onUnmounted(() => {
    // Clean up host DOM modifications
    const pageContainer = document.querySelector('.q-page-container') as HTMLElement | null;
    if (pageContainer) {
        pageContainer.style.paddingBottom = '';
    }
    // Remove player bar controls
    playlistControlsEl?.remove();
    playlistControlsEl = null;
});
</script>

<template>
    <!-- Radio Mode Toggle -->
    <div
        v-show="!playlistActive"
        id="asmr-radio-toggle"
        class="q-item q-item-type row no-wrap q-item--clickable q-link cursor-pointer"
        :class="{
            'q-item--active': radioActive,
            'text-primary': radioActive
        }"
        role="button"
        tabindex="0"
        :aria-label="t('radioMode')"
        @click="handleRadioToggle"
        @keydown="handleRadioKeydown"
    >
        <div class="q-item__section column q-item__section--avatar q-item__section--side justify-center">
            <i
                class="q-icon notranslate material-icons"
                :class="{ 'asmr-accent': radioActive }"
                aria-hidden="true"
            >radio</i>
        </div>
        <div class="q-item__section column q-item__section--main justify-center">
            <div class="q-item__label text-subtitle1">{{ t('radioMode') }}</div>
            <div
                class="q-item__label text-caption"
                :class="{ 'asmr-accent': radioActive }"
            >{{ radioStatusText }}</div>
        </div>
    </div>

    <!-- SFW Mode Toggle -->
    <div
        id="asmr-sfw-toggle"
        class="q-item q-item-type row no-wrap q-item--clickable q-link cursor-pointer"
        :class="{
            'q-item--active': sfwMode,
            'text-primary': sfwMode
        }"
        role="button"
        tabindex="0"
        :aria-label="t('sfwMode')"
        @click="handleSfwToggle"
        @keydown="handleSfwKeydown"
    >
        <div class="q-item__section column q-item__section--avatar q-item__section--side justify-center">
            <i
                class="q-icon notranslate material-icons"
                :class="{ 'asmr-accent': sfwMode }"
                aria-hidden="true"
            >visibility_off</i>
        </div>
        <div class="q-item__section column q-item__section--main justify-center">
            <div class="q-item__label text-subtitle1">{{ t('sfwMode') }}</div>
            <div
                class="q-item__label text-caption"
                :class="{ 'asmr-accent': sfwMode }"
            >{{ sfwStatusText }}</div>
        </div>
    </div>

    <!-- Translate Mode Toggle -->
    <div
        id="asmr-translate-toggle"
        class="q-item q-item-type row no-wrap q-item--clickable q-link cursor-pointer"
        :class="{
            'q-item--active': translateMode,
            'text-primary': translateMode
        }"
        role="button"
        tabindex="0"
        :aria-label="t('translateMode')"
        @click="handleTranslateToggle"
        @keydown="handleTranslateKeydown"
    >
        <div class="q-item__section column q-item__section--avatar q-item__section--side justify-center">
            <i
                class="q-icon notranslate material-icons"
                :class="{ 'asmr-accent': translateMode }"
                aria-hidden="true"
            >translate</i>
        </div>
        <div class="q-item__section column q-item__section--main justify-center">
            <div class="q-item__label text-subtitle1">{{ t('translateMode') }}</div>
            <div
                class="q-item__label text-caption"
                :class="{ 'asmr-accent': translateMode }"
            >{{ translateStatusText }}</div>
        </div>
    </div>
</template>

<style scoped>
/* Sidebar toggle items inherit host Quasar styles via unscoped class names.
   Scoped styles here only cover our additions/overrides. */

.q-item {
    transition: background 0.15s ease;
}

.q-item:hover {
    background: rgba(255, 255, 255, 0.05);
}

.asmr-accent {
    color: var(--asmr-accent, #f06292) !important;
}
</style>
