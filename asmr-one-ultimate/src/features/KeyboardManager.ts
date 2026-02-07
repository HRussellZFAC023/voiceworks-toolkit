import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { Logger, Config } from '../core/Utils';
import { EventBus } from '../core/EventBus';
import { getAudioElement } from '../core/DomUtils';
import { PlayerFullscreenController } from './PlayerFullscreenController';

/**
 * KeyboardManager - Centralized keyboard shortcut handler
 * 
 * Implements standard player shortcuts (Space, M, F, Arrows, [ ], 0-9)
 * and feature-specific shortcuts (B for Blur, J for Japanese subs).
 * 
 * Short-circuits when typing in inputs/textareas.
 */
export class KeyboardManager {
    private bridge: KikoeruBridge;
    private static instance: KeyboardManager;

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
        document.addEventListener('keydown', (e) => this.handleKeydown(e), true);
        Logger.log('[KeyboardManager] Keyboard shortcuts enabled');
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
        const hasShift = e.shiftKey;
        const hasAlt = e.altKey;

        // Player Actions
        switch (e.key) {
            // Play / Pause
            case ' ':
            case 'k':
            case 'K':
                e.preventDefault();
                e.stopPropagation();
                if (this.bridge.isPlaying) {
                    this.bridge.dispatch('AudioPlayer/pause');
                } else {
                    this.bridge.dispatch('AudioPlayer/play');
                }
                break;

            // Mute
            case 'm':
            case 'M':
                e.preventDefault();
                e.stopPropagation();
                this.toggleMute();
                break;

            // Fullscreen (Works on Work page where the player/content is)
            case 'f':
            case 'F':
                if (!hasCtrl && !hasAlt) {
                    this.toggleFullscreen();
                }
                break;

            // Seeking (Short)
            case 'ArrowLeft':
                e.preventDefault();
                e.stopPropagation();
                this.seekRelative(-5);
                break;
            case 'ArrowRight':
                e.preventDefault();
                e.stopPropagation();
                this.seekRelative(5);
                break;
            case 'j':
            case 'J':
                if (!hasShift && !hasCtrl) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.seekRelative(-10);
                } else if (!hasCtrl) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.toggleJP();
                }
                break;
            case 'l':
            case 'L':
                if (!hasShift && !hasCtrl) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.seekRelative(10);
                }
                break;

            // Volume
            case 'ArrowUp':
                e.preventDefault();
                e.stopPropagation();
                this.adjustVolume(0.05);
                break;
            case 'ArrowDown':
                e.preventDefault();
                e.stopPropagation();
                this.adjustVolume(-0.05);
                break;

            // Track Navigation
            case '[':
                e.preventDefault();
                e.stopPropagation();
                this.navigatePrev();
                break;
            case ']':
                e.preventDefault();
                e.stopPropagation();
                this.navigateNext();
                break;
            case 'p':
            case 'P':
                e.preventDefault();
                e.stopPropagation();
                this.bridge.dispatch('AudioPlayer/playPrev');
                break;
            case 'n':
            case 'N':
                e.preventDefault();
                e.stopPropagation();
                this.bridge.dispatch('AudioPlayer/playNext');
                break;

            // Percentage Seek (0-9)
            case '0': case '1': case '2': case '3': case '4':
            case '5': case '6': case '7': case '8': case '9':
                if (!hasCtrl && !hasAlt) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.seekToPercentage(parseInt(e.key) * 10);
                }
                break;

            // Playback Rate
            case '>':
            case '.':
                if (hasShift || e.key === '>') {
                    e.preventDefault();
                    e.stopPropagation();
                    this.adjustPlaybackRate(0.25);
                }
                break;
            case '<':
            case ',':
                if (hasShift || e.key === '<') {
                    e.preventDefault();
                    e.stopPropagation();
                    this.adjustPlaybackRate(-0.25);
                }
                break;

            // Feature Specific
            case 'b':
            case 'B':
                e.preventDefault();
                e.stopPropagation();
                this.toggleBlur();
                break;
        }
    }

    private toggleMute(): void {
        const isMuted = this.bridge.store.state.AudioPlayer.muted;
        this.bridge.dispatch('AudioPlayer/setMuted', !isMuted);
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
        const current = this.bridge.currentTime;
        this.bridge.dispatch('AudioPlayer/seek', Math.max(0, current + seconds));
    }

    private seekToPercentage(percent: number): void {
        const duration = this.bridge.duration;
        if (duration > 0) {
            this.bridge.dispatch('AudioPlayer/seek', (percent / 100) * duration);
        }
    }

    private adjustVolume(delta: number): void {
        const current = this.bridge.store.state.AudioPlayer.volume || 1;
        const newVal = Math.max(0, Math.min(1, current + delta));
        this.bridge.dispatch('AudioPlayer/setVolume', newVal);
        // Show a temporary indicator if possible?
    }

    private adjustPlaybackRate(delta: number): void {
        const audio = getAudioElement();
        if (!audio) return;
        const current = audio.playbackRate;
        const newVal = Math.max(0.25, Math.min(4, current + delta));
        audio.playbackRate = newVal;
        Config.set('playbackRate', newVal);
        // Notify UI
        EventBus.emit('player:rate-change', { rate: newVal });
    }

    private toggleBlur(): void {
        const current = Config.get('learnerBlur');
        Config.set('learnerBlur', !current);
        // EventBus will handle the rest if LearnerMode is listening
    }

    private toggleJP(): void {
        const current = Config.get('showJP');
        Config.set('showJP', !current);
    }

    private navigatePrev(): void {
        // If LearnerMode is active and has lyrics, seek to prev line
        // Otherwise, play previous track
        EventBus.emit('player:nav-prev', {});
    }

    private navigateNext(): void {
        EventBus.emit('player:nav-next', {});
    }
}
