import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { Logger, Config } from '../core/Utils';
import { EventBus } from '../core/EventBus';
import { getAudioElement } from '../core/DomUtils';
import { PlayerFullscreenController } from './PlayerFullscreenController';
import type { ConfigKey } from '../types';

/** Helper: get audio element or log a warning */
function requireAudio(): HTMLAudioElement | null {
    const audio = getAudioElement();
    if (!audio) Logger.debug('[KeyboardManager] No audio element found');
    return audio;
}

/**
 * Match a keyboard event against a configured hotkey value.
 * Handles special names (Space, ArrowLeft, etc.) and case-insensitive letter matching.
 */
export function matchesHotkey(e: KeyboardEvent, configKey: ConfigKey): boolean {
    const binding = String(Config.get(configKey) || '');
    if (!binding) return false;
    // Normalize: "Space" matches " ", letter keys case-insensitive
    if (binding === 'Space') return e.key === ' ';
    if (binding.length === 1) return e.key.toLowerCase() === binding.toLowerCase();
    return e.key === binding;
}

/**
 * KeyboardManager - Centralized keyboard shortcut handler
 *
 * All shortcuts are configurable via the Keyboard Shortcuts settings section.
 * Short-circuits when typing in inputs/textareas.
 *
 * Gallery-aware: when the fullscreen gallery is active, arrow keys and
 * gallery-specific hotkeys dispatch gallery events instead of seek.
 */
export class KeyboardManager {
    private bridge: KikoeruBridge;
    private static instance: KeyboardManager;
    private galleryActive = false;
    private boundHandler: ((e: KeyboardEvent) => void) | null = null;
    private enterCleanup: (() => void) | null = null;
    private exitCleanup: (() => void) | null = null;
    private lastTrackSkipTime = 0;
    private static readonly TRACK_SKIP_THROTTLE = 300; // ms — prevent rapid next/prev flooding

    private constructor() {
        this.bridge = KikoeruBridge.getInstance();
    }

    public static getInstance(): KeyboardManager {
        if (!KeyboardManager.instance) {
            KeyboardManager.instance = new KeyboardManager();
        }
        return KeyboardManager.instance;
    }

    public enable(): void {
        if (this.boundHandler) return; // Already enabled
        this.boundHandler = (e: KeyboardEvent) => this.handleKeydown(e);
        document.addEventListener('keydown', this.boundHandler, true);
        this.enterCleanup = EventBus.on('fullscreen:enter', () => { this.galleryActive = true; });
        this.exitCleanup = EventBus.on('fullscreen:exit', () => { this.galleryActive = false; });
        Logger.log('[KeyboardManager] Keyboard shortcuts enabled');
    }

    public disable(): void {
        if (this.boundHandler) {
            document.removeEventListener('keydown', this.boundHandler, true);
            this.boundHandler = null;
        }
        this.enterCleanup?.();
        this.enterCleanup = null;
        this.exitCleanup?.();
        this.exitCleanup = null;
        this.galleryActive = false;
    }

    public isGalleryActive(): boolean {
        return this.galleryActive;
    }

    private handleKeydown(e: KeyboardEvent): void {
        // Ignore if typing in an input, textarea, or contentEditable
        const target = e.target as HTMLElement;
        const isInput = target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.isContentEditable ||
            target.closest('.q-field'); // Quasar inputs

        if (isInput) return;

        // Modifier keys
        const hasCtrl = e.ctrlKey || e.metaKey;
        const hasAlt = e.altKey;

        // ── Gallery mode shortcuts (take priority when gallery is fullscreen) ──

        if (this.galleryActive) {
            if (matchesHotkey(e, 'hotkeyGalleryPrev')) {
                e.preventDefault();
                e.stopPropagation();
                EventBus.emit('gallery:nav', { direction: -1 });
                return;
            }
            if (matchesHotkey(e, 'hotkeyGalleryNext')) {
                e.preventDefault();
                e.stopPropagation();
                EventBus.emit('gallery:nav', { direction: 1 });
                return;
            }
            if (matchesHotkey(e, 'hotkeyGalleryExclude')) {
                e.preventDefault();
                e.stopPropagation();
                EventBus.emit('gallery:exclude', {});
                return;
            }
        }

        // ── Media shortcuts ──

        // Play / Pause (Space or configured key)
        if (matchesHotkey(e, 'hotkeyPlayPause')) {
            e.preventDefault();
            e.stopPropagation();
            this.togglePlayPause();
            return;
        }

        // Mute
        if (matchesHotkey(e, 'hotkeyMute')) {
            e.preventDefault();
            e.stopPropagation();
            this.toggleMute();
            return;
        }

        // Fullscreen
        if (!hasCtrl && !hasAlt && matchesHotkey(e, 'hotkeyFullscreen')) {
            this.toggleFullscreen();
            return;
        }

        // Seeking (Short)
        if (matchesHotkey(e, 'hotkeySeekBack')) {
            e.preventDefault();
            e.stopPropagation();
            this.seekRelative(-5);
            return;
        }
        if (matchesHotkey(e, 'hotkeySeekForward')) {
            e.preventDefault();
            e.stopPropagation();
            this.seekRelative(5);
            return;
        }

        // Seeking (Long)
        if (matchesHotkey(e, 'hotkeySeekBackLong')) {
            e.preventDefault();
            e.stopPropagation();
            this.seekRelative(-10);
            return;
        }
        if (matchesHotkey(e, 'hotkeySeekForwardLong')) {
            e.preventDefault();
            e.stopPropagation();
            this.seekRelative(10);
            return;
        }

        // Volume
        if (matchesHotkey(e, 'hotkeyVolumeUp')) {
            e.preventDefault();
            e.stopPropagation();
            this.adjustVolume(0.05);
            return;
        }
        if (matchesHotkey(e, 'hotkeyVolumeDown')) {
            e.preventDefault();
            e.stopPropagation();
            this.adjustVolume(-0.05);
            return;
        }

        // Track/Line Navigation
        if (matchesHotkey(e, 'hotkeyPrevLine')) {
            e.preventDefault();
            e.stopPropagation();
            this.navigatePrev();
            return;
        }
        if (matchesHotkey(e, 'hotkeyNextLine')) {
            e.preventDefault();
            e.stopPropagation();
            this.navigateNext();
            return;
        }
        if (matchesHotkey(e, 'hotkeyPrevTrack')) {
            e.preventDefault();
            e.stopPropagation();
            if (!this.throttleTrackSkip()) return;
            try { this.bridge.commit('AudioPlayer/PREVIOUS_TRACK'); } catch { /* mutation unavailable */ }
            return;
        }
        if (matchesHotkey(e, 'hotkeyNextTrack')) {
            e.preventDefault();
            e.stopPropagation();
            if (!this.throttleTrackSkip()) return;
            try { this.bridge.commit('AudioPlayer/NEXT_TRACK'); } catch { /* mutation unavailable */ }
            return;
        }

        // Percentage Seek (0-9) — always hardcoded, not configurable
        if (/^[0-9]$/.test(e.key) && !hasCtrl && !hasAlt) {
            e.preventDefault();
            e.stopPropagation();
            this.seekToPercentage(parseInt(e.key) * 10);
            return;
        }

        // Playback Rate
        if (matchesHotkey(e, 'hotkeySpeedUp')) {
            e.preventDefault();
            e.stopPropagation();
            this.adjustPlaybackRate(0.25);
            return;
        }
        if (matchesHotkey(e, 'hotkeySpeedDown')) {
            e.preventDefault();
            e.stopPropagation();
            this.adjustPlaybackRate(-0.25);
            return;
        }
        if (matchesHotkey(e, 'hotkeySpeedReset')) {
            e.preventDefault();
            e.stopPropagation();
            this.resetPlaybackRate();
            return;
        }

        // Feature Specific
        if (matchesHotkey(e, 'hotkeyToggleBlur')) {
            e.preventDefault();
            e.stopPropagation();
            this.toggleBlur();
            return;
        }
        if (matchesHotkey(e, 'hotkeyToggleJP')) {
            e.preventDefault();
            e.stopPropagation();
            this.toggleJP();
            return;
        }
    }

    /** Returns true if the skip is allowed, false if throttled. */
    private throttleTrackSkip(): boolean {
        const now = Date.now();
        if (now - this.lastTrackSkipTime < KeyboardManager.TRACK_SKIP_THROTTLE) return false;
        this.lastTrackSkipTime = now;
        return true;
    }

    private togglePlayPause(): void {
        const audio = requireAudio();
        if (!audio) return;
        if (audio.paused) {
            audio.play().catch(() => { });
        } else {
            audio.pause();
        }
    }

    private toggleMute(): void {
        const audio = requireAudio();
        if (!audio) return;
        audio.muted = !audio.muted;
        // Sync store for UI update
        try { this.bridge.commit('AudioPlayer/TOGGLE_MUTED'); } catch { /* mutation unavailable */ }
    }

    private toggleFullscreen(): void {
        // Use PlayerFullscreen if enabled, otherwise fall back to browser Fullscreen API
        if (Config.get('enablePlayerFullscreen')) {
            PlayerFullscreenController.getInstance().toggle();
        } else {
            const main = document.querySelector('.q-page-container') || document.body;
            if (!document.fullscreenElement) {
                main.requestFullscreen().catch(() => { });
            } else {
                document.exitFullscreen().catch(() => { });
            }
        }
    }

    private seekRelative(seconds: number): void {
        const audio = requireAudio();
        if (!audio) return;
        audio.currentTime = Math.max(0, Math.min(audio.duration || Infinity, audio.currentTime + seconds));
    }

    private seekToPercentage(percent: number): void {
        const audio = requireAudio();
        if (!audio || !audio.duration) return;
        audio.currentTime = (percent / 100) * audio.duration;
    }

    private adjustVolume(delta: number): void {
        const audio = requireAudio();
        if (!audio) return;
        const newVal = Math.max(0, Math.min(1, audio.volume + delta));
        audio.volume = newVal;
        // Sync store for UI slider update
        try { this.bridge.commit('AudioPlayer/SET_VOLUME', newVal); } catch { /* mutation unavailable */ }
    }

    private adjustPlaybackRate(delta: number): void {
        const audio = requireAudio();
        if (!audio) return;
        const current = audio.playbackRate;
        const newVal = Math.max(0.25, Math.min(4, current + delta));
        audio.playbackRate = newVal;
        Config.set('playbackRate', newVal);
        EventBus.emit('player:rate-change', { rate: newVal });
    }

    private resetPlaybackRate(): void {
        const audio = requireAudio();
        if (!audio) return;
        audio.playbackRate = 1;
        Config.set('playbackRate', 1);
        EventBus.emit('player:rate-change', { rate: 1 });
    }

    private toggleBlur(): void {
        EventBus.emit('blur:toggle', undefined);
    }

    private toggleJP(): void {
        const current = Config.get('showJP');
        Config.set('showJP', !current);
    }

    private navigatePrev(): void {
        EventBus.emit('player:nav-prev', {});
    }

    private navigateNext(): void {
        EventBus.emit('player:nav-next', {});
    }
}
