/**
 * PlayerFullscreen - Expands the audio player to fill the viewport.
 *
 * Adds a fullscreen toggle button in the top-right of .audio-player.
 * Toggles a CSS class that makes the player fill the screen - no
 * backdrop or lightbox overlay.
 *
 * Exit methods: button, Escape key, swipe down.
 */

import { Logger } from '../core/Utils';
import { I18n } from '../core/Config';
import { CentralObserver } from '../core/CentralObserver';
import { EventBus } from '../core/EventBus';
import { AppStore } from '../store/AppStore';

const SWIPE_THRESHOLD = 80;  // px downward to trigger exit
const SWIPE_MAX_TIME = 400;  // ms max duration for swipe gesture

export class PlayerFullscreen {
    private static instance: PlayerFullscreen;
    private isFullscreen = false;
    private touchStartY = 0;
    private touchStartX = 0;
    private touchStartTime = 0;

    private boundEscHandler = (e: KeyboardEvent) => {
        if (e.key === 'Escape' && this.isFullscreen) {
            // Let the lightbox close first if it's open
            if (document.querySelector('.media-viewer-modal.active')) return;
            e.preventDefault();
            e.stopPropagation();
            this.exit();
        }
    };

    private boundTouchStart = (e: TouchEvent) => this.onTouchStart(e);
    private boundTouchEnd = (e: TouchEvent) => this.onTouchEnd(e);

    private constructor() { }

    public static getInstance(): PlayerFullscreen {
        if (!PlayerFullscreen.instance) {
            PlayerFullscreen.instance = new PlayerFullscreen();
        }
        return PlayerFullscreen.instance;
    }

    public enable(): void {
        CentralObserver.register('player-fullscreen', () => this.ensureButton(), 500);
        Logger.log('[PlayerFullscreen] Enabled');
    }

    private ensureButton(): void {
        const player = document.querySelector('.audio-player');
        if (!player) return;

        // Re-sync fullscreen class when Vue re-creates the player element
        if (this.isFullscreen && !player.classList.contains('asmr-player-fullscreen')) {
            player.classList.add('asmr-player-fullscreen');
            document.body.classList.add('asmr-fullscreen-active', 'asmr-lock-scroll');
            EventBus.emit('fullscreen:enter', undefined);
            Logger.debug('[PlayerFullscreen] Re-synced fullscreen class after DOM re-creation');
        }

        if (player.querySelector('.asmr-fullscreen-btn')) return;

        CentralObserver.withModification(() => {
            const btn = document.createElement('button');
            btn.className = 'asmr-fullscreen-btn';
            btn.setAttribute('aria-label', I18n.t('fullscreenToggle'));
            btn.title = I18n.t('fullscreenToggle');
            btn.innerHTML = '<i class="material-icons" role="img" aria-hidden="true">fullscreen</i>';
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.toggle();
            });
            player.appendChild(btn);

            // Re-sync icon if already fullscreen (e.g. after re-render)
            if (this.isFullscreen) {
                const icon = btn.querySelector('.material-icons');
                if (icon) icon.textContent = 'fullscreen_exit';
            }
        });
    }

    public toggle(): void {
        this.isFullscreen ? this.exit() : this.enter();
    }

    private enter(): void {
        const player = document.querySelector('.audio-player');
        if (!player) return;

        // Ensure player is expanded in the store
        if (AppStore.player.hide) {
            AppStore.commit('AudioPlayer/TOGGLE_HIDE');
        }

        player.classList.add('asmr-player-fullscreen');
        document.body.classList.add('asmr-fullscreen-active');
        document.body.classList.add('asmr-lock-scroll');
        this.isFullscreen = true;
        this.updateButton();
        document.addEventListener('keydown', this.boundEscHandler, true);
        document.addEventListener('touchstart', this.boundTouchStart, { passive: true, capture: true });
        document.addEventListener('touchend', this.boundTouchEnd, { passive: true, capture: true });
        EventBus.emit('fullscreen:enter', undefined);
        Logger.debug('[PlayerFullscreen] Entered (Mobile mode)');
    }

    public exit(): void {
        if (!this.isFullscreen) return;

        const player = document.querySelector('.audio-player');
        if (player) {
            player.classList.remove('asmr-player-fullscreen');
        }

        document.body.classList.remove('asmr-fullscreen-active');
        document.body.classList.remove('asmr-lock-scroll');
        this.isFullscreen = false;
        this.updateButton();
        document.removeEventListener('keydown', this.boundEscHandler, true);
        document.removeEventListener('touchstart', this.boundTouchStart, true);
        document.removeEventListener('touchend', this.boundTouchEnd, true);
        EventBus.emit('fullscreen:exit', undefined);
        Logger.debug('[PlayerFullscreen] Exited (Mobile mode)');
    }

    // ------------------------------------------------------------------
    // Swipe-down to exit fullscreen
    // ------------------------------------------------------------------

    private onTouchStart(e: TouchEvent): void {
        if (!this.isFullscreen || e.touches.length !== 1) return;

        // Don't track swipes on interactive controls (sliders, buttons, inputs)
        const target = e.touches[0].target as HTMLElement;
        if (this.isInteractiveElement(target)) return;

        this.touchStartY = e.touches[0].clientY;
        this.touchStartX = e.touches[0].clientX;
        this.touchStartTime = Date.now();
    }

    private onTouchEnd(e: TouchEvent): void {
        if (!this.isFullscreen || !this.touchStartTime) return;
        if (!e.changedTouches.length) return;

        const dy = e.changedTouches[0].clientY - this.touchStartY;
        const dx = e.changedTouches[0].clientX - this.touchStartX;
        const dt = Date.now() - this.touchStartTime;

        this.touchStartTime = 0;

        // Must be: downward, mostly vertical, fast enough, far enough
        if (dy > SWIPE_THRESHOLD && dt < SWIPE_MAX_TIME && Math.abs(dy) > Math.abs(dx) * 1.5) {
            this.exit();
        }
    }

    private isInteractiveElement(el: HTMLElement): boolean {
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
        // Sliders, seek bars, volume controls
        if (el.closest('.plyr__progress, .ant-slider, .asmr-speed-slider, input[type="range"]')) return true;
        return false;
    }

    // ------------------------------------------------------------------

    private updateButton(): void {
        const btn = document.querySelector('.asmr-fullscreen-btn');
        if (!btn) return;
        const icon = btn.querySelector('.material-icons');
        if (icon) icon.textContent = this.isFullscreen ? 'fullscreen_exit' : 'fullscreen';
        const label = this.isFullscreen ? I18n.t('fullscreenExit') : I18n.t('fullscreenToggle');
        btn.setAttribute('aria-label', label);
        btn.setAttribute('title', label);
    }

    public get active(): boolean {
        return this.isFullscreen;
    }
}
