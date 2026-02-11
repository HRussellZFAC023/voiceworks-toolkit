<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { useConfig } from '../../composables/useConfig';
import { useEventBus } from '../../composables/useEventBus';
import { RadioMode } from '../../features/radio';
import { PlaylistMode } from '../../features/playlist';
import { KikoeruBridge } from '../../infrastructure/KikoeruBridge';
import { Config, Logger } from '../../core/Utils';
import type { RadioState } from '../../types';

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
const radioState = ref<RadioState>(RadioMode.getInstance().state);
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
// Player bar controls (mode-aware, imperative DOM)
// ============================================================================

type PlayerControlsMode = 'playlist' | 'radio' | null;
type PlayerToggleKey =
    | 'playAllInFolder'
    | 'autoFilterFolders'
    | 'shuffle'
    | 'loopPlaylist'
    | 'radioUseFlatTracks'
    | 'autoProgress'
    | 'playlistPlayAllInFolder'
    | 'playlistAutoFilterFolders'
    | 'playlistShuffle'
    | 'playlistLoopPlaylist'
    | 'playlistUseFlatTracks'
    | 'playlistAutoProgress';

interface PlayerToggleDef {
    key: PlayerToggleKey;
    icon: string;
    labelKey: string;
    subLabelKey: string;
}

const PLAYER_TOGGLE_KEYS = new Set<PlayerToggleKey>([
    'playAllInFolder',
    'autoFilterFolders',
    'shuffle',
    'loopPlaylist',
    'radioUseFlatTracks',
    'autoProgress',
    'playlistPlayAllInFolder',
    'playlistAutoFilterFolders',
    'playlistShuffle',
    'playlistLoopPlaylist',
    'playlistUseFlatTracks',
    'playlistAutoProgress',
]);

let playerControlsEl: HTMLElement | null = null;
let playerControlsMode: PlayerControlsMode = null;
let radioStatusIntervalId: number | null = null;

function getDesiredControlsMode(): PlayerControlsMode {
    if (playlistActive.value) return 'playlist';
    if (radioActive.value) return 'radio';
    return null;
}

function getToggleDefs(mode: Exclude<PlayerControlsMode, null>): PlayerToggleDef[] {
    if (mode === 'playlist') {
        return [
            { key: 'playlistPlayAllInFolder', icon: 'playlist_play', labelKey: 'playAll', subLabelKey: 'playAllSub' },
            { key: 'playlistAutoFilterFolders', icon: 'folder_open', labelKey: 'autoFilterFolders', subLabelKey: 'autoFilterFoldersSub' },
            { key: 'playlistShuffle', icon: 'shuffle', labelKey: 'shuffle', subLabelKey: 'shuffleSub' },
            { key: 'playlistLoopPlaylist', icon: 'repeat', labelKey: 'loopPlaylist', subLabelKey: 'loopPlaylistSub' },
            { key: 'playlistUseFlatTracks', icon: 'view_list', labelKey: 'radioFlatTracks', subLabelKey: 'radioFlatTracksSub' },
            { key: 'playlistAutoProgress', icon: 'fast_forward', labelKey: 'autoProgress', subLabelKey: 'autoProgressSub' },
        ];
    }

    return [
        { key: 'playAllInFolder', icon: 'playlist_play', labelKey: 'playAll', subLabelKey: 'playAllSub' },
        { key: 'autoFilterFolders', icon: 'folder_open', labelKey: 'autoFilterFolders', subLabelKey: 'autoFilterFoldersSub' },
        { key: 'shuffle', icon: 'shuffle', labelKey: 'shuffle', subLabelKey: 'shuffleSub' },
        { key: 'loopPlaylist', icon: 'repeat', labelKey: 'loopPlaylist', subLabelKey: 'loopPlaylistSub' },
        { key: 'radioUseFlatTracks', icon: 'view_list', labelKey: 'radioFlatTracks', subLabelKey: 'radioFlatTracksSub' },
        { key: 'autoProgress', icon: 'fast_forward', labelKey: 'autoProgress', subLabelKey: 'autoProgressSub' },
    ];
}

function createIcon(iconName: string): HTMLElement {
    const iconEl = document.createElement('i');
    iconEl.className = 'material-icons';
    iconEl.setAttribute('aria-hidden', 'true');
    iconEl.textContent = iconName;
    return iconEl;
}

function setPlayerButtonDisabled(btn: HTMLButtonElement | null, disabled: boolean): void {
    if (!btn) return;
    btn.disabled = disabled;
    btn.classList.toggle('disabled', disabled);
}

function getRadioStatusLabel(): string {
    if (!radioActive.value) return `${t('radioMode')}: ${t('off')}`;

    if (radioState.value === 'idle') return `${t('radioMode')}: ${t('radioStatusIdle')}`;
    if (radioState.value === 'skipping') return `${t('radioMode')}: ${t('radioStatusSkipping')}`;
    if (radioState.value === 'loading') return `${t('radioMode')}: ${t('radioStatusLoading')}`;

    let isPlaying = false;
    try {
        isPlaying = !!KikoeruBridge.getInstance().player?.playing;
    } catch {
        isPlaying = false;
    }

    return `${t('radioMode')}: ${isPlaying ? t('radioStatusPlaying') : t('radioStatusStarting')}`;
}

function removeStaleControls(): void {
    document.getElementById('asmr-playlist-player-controls')?.remove();
    document.getElementById('asmr-playlist-controls')?.remove();
    document.querySelectorAll('.asmr-playlist-player-controls').forEach(el => el.remove());
}

function createModeControls(mode: Exclude<PlayerControlsMode, null>): HTMLElement {
    const container = document.createElement('div');
    container.className = `asmr-playlist-player-controls asmr-player-controls--${mode}`;
    container.id = 'asmr-playlist-player-controls';

    const mainRow = document.createElement('div');
    mainRow.className = 'asmr-playlist-player-main';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'asmr-playlist-player-btn asmr-playlist-prev';
    prevBtn.title = t('playlistPrevWork');
    prevBtn.setAttribute('aria-label', t('playlistPrevWork'));
    prevBtn.appendChild(createIcon('skip_previous'));
    prevBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (mode === 'playlist') {
            void PlaylistMode.getInstance().previous();
        } else {
            void RadioMode.getInstance().skipToPrevious();
        }
    });

    const statusEl = document.createElement('span');
    statusEl.className = 'asmr-playlist-player-status';
    statusEl.setAttribute('aria-live', 'polite');

    const nextBtn = document.createElement('button');
    nextBtn.className = 'asmr-playlist-player-btn asmr-playlist-next';
    nextBtn.title = t('playlistNextWork');
    nextBtn.setAttribute('aria-label', t('playlistNextWork'));
    nextBtn.appendChild(createIcon('skip_next'));
    nextBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (mode === 'playlist') {
            void PlaylistMode.getInstance().next();
        } else {
            void RadioMode.getInstance().skipToNext();
        }
    });

    mainRow.append(prevBtn, statusEl, nextBtn);

    const toggleRow = document.createElement('div');
    toggleRow.className = 'asmr-playlist-player-toggles';
    for (const def of getToggleDefs(mode)) {
        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'asmr-playlist-player-toggle';
        toggleBtn.dataset.configKey = def.key;
        toggleBtn.title = `${t(def.labelKey)}: ${t(def.subLabelKey)}`;
        toggleBtn.setAttribute('aria-label', t(def.labelKey));
        toggleBtn.setAttribute('aria-pressed', 'false');
        toggleBtn.appendChild(createIcon(def.icon));

        const labelEl = document.createElement('span');
        labelEl.className = 'asmr-playlist-player-toggle-label';
        labelEl.textContent = t(def.labelKey);
        toggleBtn.appendChild(labelEl);

        toggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const key = def.key;
            const currentValue = Boolean(Config.get(key));
            Config.set(key, !currentValue);
            syncPlayerControls();
        });

        toggleRow.appendChild(toggleBtn);
    }

    container.append(mainRow, toggleRow);
    return container;
}

function ensurePlayerControls(mode: Exclude<PlayerControlsMode, null>): void {
    if (playerControlsEl && playerControlsEl.isConnected && playerControlsMode === mode) {
        playerControlsEl.style.display = 'flex';
        return;
    }

    removeStaleControls();
    playerControlsEl = createModeControls(mode);
    playerControlsMode = mode;

    // Append to body instead of host player bar: host Vue 2 re-renders would strip children.
    document.body.appendChild(playerControlsEl);
    Logger.debug('[SidebarMenu] Player controls injected', { mode });
}

function syncPlayerControls(): void {
    const mode = getDesiredControlsMode();
    if (!mode) return;

    ensurePlayerControls(mode);
    if (!playerControlsEl) return;

    const statusEl = playerControlsEl.querySelector('.asmr-playlist-player-status');
    if (statusEl) {
        statusEl.textContent = mode === 'playlist'
            ? `${playlistCurrent.value} / ${playlistTotal.value}`
            : getRadioStatusLabel();
    }

    const prevBtn = playerControlsEl.querySelector('.asmr-playlist-prev') as HTMLButtonElement | null;
    const nextBtn = playerControlsEl.querySelector('.asmr-playlist-next') as HTMLButtonElement | null;

    if (mode === 'playlist') {
        const loop = Boolean(Config.get('playlistLoopPlaylist'));
        const shuffle = Boolean(Config.get('playlistShuffle'));

        setPlayerButtonDisabled(prevBtn, !loop && !shuffle && playlistCurrent.value <= 1);
        setPlayerButtonDisabled(nextBtn, !loop && !shuffle && playlistCurrent.value >= playlistTotal.value);
    } else {
        const navigating = radioState.value === 'skipping' || radioState.value === 'loading';
        const canGoPrevious = RadioMode.getInstance().canSkipToPrevious();
        setPlayerButtonDisabled(prevBtn, navigating || !canGoPrevious);
        setPlayerButtonDisabled(nextBtn, navigating);
    }

    for (const def of getToggleDefs(mode)) {
        const toggleBtn = playerControlsEl.querySelector(`[data-config-key="${def.key}"]`) as HTMLButtonElement | null;
        if (!toggleBtn) continue;
        const enabled = Boolean(Config.get(def.key));
        toggleBtn.classList.toggle('active', enabled);
        toggleBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    }
}

function startRadioStatusPolling(): void {
    if (radioStatusIntervalId !== null) return;
    radioStatusIntervalId = window.setInterval(() => {
        if (getDesiredControlsMode() !== 'radio') return;
        syncPlayerControls();
    }, 400);
}

function stopRadioStatusPolling(): void {
    if (radioStatusIntervalId === null) return;
    clearInterval(radioStatusIntervalId);
    radioStatusIntervalId = null;
}

function updatePlayerControlsHostDOM() {
    const mode = getDesiredControlsMode();
    const controlsActive = mode !== null;

    // Adjust page container padding to prevent overlap with player bar
    const pageContainer = document.querySelector('.q-page-container') as HTMLElement | null;
    if (pageContainer) {
        pageContainer.style.paddingBottom = controlsActive
            ? 'calc(var(--q-footer-height, 64px) + 40px)'
            : '';
    }

    // Adjust sidebar padding
    const sidebar = document.querySelector('.q-drawer--left .q-list') ||
        document.querySelector('.q-drawer .q-list') ||
        document.querySelector('.q-drawer--left .q-scrollarea__content') ||
        document.querySelector('.q-drawer') as HTMLElement | null;
    if (sidebar) {
        (sidebar as HTMLElement).style.paddingBottom = controlsActive
            ? 'calc(var(--q-footer-height, 64px) + 20px)'
            : '';

        // Highlight the playlists nav item
        const playlistItem = Array.from(sidebar.querySelectorAll('a.q-item'))
            .find(el => el.getAttribute('href') === '/playlists');
        if (playlistItem) {
            playlistItem.classList.toggle('q-item--active', playlistActive.value);
            playlistItem.classList.toggle('text-primary', playlistActive.value);
        }
    }

    if (mode) {
        ensurePlayerControls(mode);
        syncPlayerControls();
    }

    if (playerControlsEl) {
        playerControlsEl.style.display = controlsActive ? 'flex' : 'none';
    }

    if (mode === 'radio') {
        startRadioStatusPolling();
    } else {
        stopRadioStatusPolling();
    }
}

// ============================================================================
// EventBus subscriptions
// ============================================================================

on('radio:toggle', (payload) => {
    radioActive.value = payload.isActive;
    if (!payload.isActive) {
        radioState.value = 'idle';
    }
    updatePlayerControlsHostDOM();
    syncPlayerControls();
});

on('radio:state', (payload) => {
    radioState.value = payload.state;
    syncPlayerControls();
});

on('playlist:active', (payload) => {
    playlistActive.value = payload.isActive;
    if (payload.isActive && payload.workIds && payload.workIds.length > 0) {
        playlistCurrent.value = 1;
        playlistTotal.value = payload.workIds.length;
    }
    updatePlayerControlsHostDOM();
    syncPlayerControls();
});

on('playlist:progress', (payload) => {
    playlistCurrent.value = payload.current;
    playlistTotal.value = payload.total;
    syncPlayerControls();
});

on('playlist:shuffleToggled', () => {
    syncPlayerControls();
});

on('playlist:loopToggled', () => {
    syncPlayerControls();
});

on('config:change', ({ key }) => {
    if (PLAYER_TOGGLE_KEYS.has(key as PlayerToggleKey)) {
        syncPlayerControls();
    }
});

// ============================================================================
// Initialize from active PlaylistMode state (handles SFC remount)
// ============================================================================

const pmInit = PlaylistMode.getInstance();
if (pmInit.isActive) {
    playlistActive.value = true;
    const progress = pmInit.getProgress();
    playlistCurrent.value = progress.current;
    playlistTotal.value = progress.total;
}

updatePlayerControlsHostDOM();
syncPlayerControls();

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
    playerControlsEl?.remove();
    playerControlsEl = null;
    playerControlsMode = null;
    stopRadioStatusPolling();
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
