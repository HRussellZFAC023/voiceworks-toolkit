/**
 * Visualizer - Real-time audio frequency visualization bar
 *
 * Renders frequency bars via Web Audio API AnalyserNode on a <canvas>.
 * Follows the same dual-bar pattern as JoiTool (collapsed fixed bar +
 * expanded bar inside .audio-player).
 */

import { Logger, I18n } from '../core/Utils';
import { EventBus } from '../core/EventBus';
import { CentralObserver } from '../core/CentralObserver';
import { getAudioElement } from '../core/DomUtils';
import { getOrCreateSourceNode } from '../core/AudioAnalysis';
import { AppStore } from '../store/AppStore';

// ============================================================================
// Constants
// ============================================================================

const POSITION_POLL_MS = 500;
const BAR_COUNT = 40;
const BAR_GAP = 2;
const BAR_RADIUS = 2;

// ============================================================================
// Visualizer
// ============================================================================

export class Visualizer {
    private static instance: Visualizer;

    private isActive = false;
    private barEl: HTMLElement | null = null;
    private expandedBarEl: HTMLElement | null = null;
    private eventCleanups: (() => void)[] = [];
    private positionPollId: number | null = null;
    private animFrameId: number | null = null;
    private isPaused = false;

    // Audio analysis
    private audioCtx: AudioContext | null = null;
    private analyser: AnalyserNode | null = null;
    private sourceNode: MediaElementAudioSourceNode | null = null;
    private connectedAudioEl: HTMLAudioElement | null = null;
    private analyserAvailable = false;

    private constructor() {}

    public static getInstance(): Visualizer {
        if (!Visualizer.instance) {
            Visualizer.instance = new Visualizer();
        }
        return Visualizer.instance;
    }

    // ------------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------------

    public enable(): void {
        this.setupEventListeners();
        CentralObserver.register('visualizer', () => {
            if (this.isActive) this.ensureUI();
        }, 800);
        Logger.log('[Visualizer] Enabled');
    }

    public toggle(): void {
        if (this.isActive) {
            this.deactivate();
        } else {
            this.activate();
        }
    }

    public get active(): boolean {
        return this.isActive;
    }

    // ------------------------------------------------------------------------
    // Activation / Deactivation
    // ------------------------------------------------------------------------

    private activate(): void {
        this.isActive = true;
        this.isPaused = false;

        this.ensureUI();
        this.showBar();
        this.startPositionPolling();
        this.syncPauseState();
        this.connectAudioAnalyser();
        this.startRendering();

        this.syncOverflowButton(true);
        Logger.log('[Visualizer] Activated');
    }

    private deactivate(): void {
        this.isActive = false;
        this.stopRendering();
        this.stopPositionPolling();
        this.hideBar();
        this.syncOverflowButton(false);
        CentralObserver.unregister('visualizer');
        this.eventCleanups.forEach(fn => fn());
        this.eventCleanups = [];
        Logger.log('[Visualizer] Deactivated');
    }

    // ------------------------------------------------------------------------
    // Event Listeners
    // ------------------------------------------------------------------------

    private setupEventListeners(): void {
        // Reset on track change
        this.eventCleanups.push(EventBus.on('track:change', () => {
            if (this.isActive) {
                this.connectAudioAnalyser();
            }
        }));

        // Toggle event from overflow menu
        this.eventCleanups.push(EventBus.on('viz:toggle', () => {
            this.toggle();
        }));
    }

    // ------------------------------------------------------------------------
    // Audio Analysis
    // ------------------------------------------------------------------------

    private connectAudioAnalyser(): void {
        const audio = getAudioElement();
        if (!audio) {
            Logger.debug('[Visualizer] No audio element found');
            this.analyserAvailable = false;
            return;
        }

        if (this.connectedAudioEl === audio && this.analyser) return;

        const result = getOrCreateSourceNode(audio);
        if (!result) {
            Logger.debug('[Visualizer] Audio analyser failed (cross-origin?)');
            this.analyserAvailable = false;
            return;
        }

        try {
            this.audioCtx = result.ctx;
            this.sourceNode = result.source;

            this.analyser = this.audioCtx.createAnalyser();
            this.analyser.fftSize = 256;
            this.analyser.smoothingTimeConstant = 0.7;
            this.sourceNode.connect(this.analyser);

            this.connectedAudioEl = audio;
            this.analyserAvailable = true;
            Logger.debug('[Visualizer] Audio analyser connected');
        } catch (err) {
            Logger.debug('[Visualizer] Audio analyser failed:', err);
            this.analyserAvailable = false;
        }
    }

    // ------------------------------------------------------------------------
    // Canvas Rendering
    // ------------------------------------------------------------------------

    private startRendering(): void {
        this.stopRendering();
        const draw = () => {
            if (!this.isActive) return;
            this.animFrameId = requestAnimationFrame(draw);
            if (this.isPaused) return;
            this.renderFrame();
        };
        this.animFrameId = requestAnimationFrame(draw);
    }

    private stopRendering(): void {
        if (this.animFrameId !== null) {
            cancelAnimationFrame(this.animFrameId);
            this.animFrameId = null;
        }
    }

    private renderFrame(): void {
        if (!this.analyser || !this.analyserAvailable) return;

        const data = new Uint8Array(this.analyser.frequencyBinCount);
        this.analyser.getByteFrequencyData(data);

        for (const bar of this.getBars()) {
            const canvas = bar.querySelector('canvas') as HTMLCanvasElement | null;
            if (!canvas) continue;

            const ctx = canvas.getContext('2d');
            if (!ctx) continue;

            // Ensure canvas dimensions match layout
            const rect = canvas.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            const w = Math.round(rect.width * dpr);
            const h = Math.round(rect.height * dpr);
            if (canvas.width !== w || canvas.height !== h) {
                canvas.width = w;
                canvas.height = h;
            }

            ctx.clearRect(0, 0, w, h);

            // Draw frequency bars
            const step = Math.floor(data.length / BAR_COUNT);
            const barWidth = Math.max(1, (w - BAR_GAP * (BAR_COUNT - 1)) / BAR_COUNT);
            const accentRGB = this.getAccentColor();

            for (let i = 0; i < BAR_COUNT; i++) {
                // Average a range of bins for smoother look
                let sum = 0;
                for (let j = 0; j < step; j++) {
                    sum += data[i * step + j] || 0;
                }
                const avg = sum / step;
                const normalised = avg / 255;
                const barHeight = Math.max(2 * dpr, normalised * h * 0.9);

                const x = i * (barWidth + BAR_GAP);
                const y = h - barHeight;

                // Gradient opacity based on frequency position
                const alpha = 0.4 + normalised * 0.6;
                ctx.fillStyle = `rgba(${accentRGB}, ${alpha})`;

                // Rounded top
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

    private getAccentColor(): string {
        // Read --asmr-accent from CSS and convert to RGB components
        const el = this.barEl || document.documentElement;
        const accent = getComputedStyle(el).getPropertyValue('--asmr-accent').trim();
        if (accent.startsWith('#') && accent.length >= 7) {
            const r = parseInt(accent.slice(1, 3), 16);
            const g = parseInt(accent.slice(3, 5), 16);
            const b = parseInt(accent.slice(5, 7), 16);
            return `${r}, ${g}, ${b}`;
        }
        // Fallback: purple
        return '124, 77, 255';
    }

    // ------------------------------------------------------------------------
    // Pause Awareness
    // ------------------------------------------------------------------------

    private syncPauseState(): void {
        const audio = getAudioElement();
        if (!audio) return;

        const onPause = () => {
            this.isPaused = true;
            for (const bar of this.getBars()) bar.classList.add('asmr-viz-paused');
        };
        const onPlay = () => {
            this.isPaused = false;
            for (const bar of this.getBars()) bar.classList.remove('asmr-viz-paused');
            if (this.audioCtx?.state === 'suspended') {
                this.audioCtx.resume().catch(() => {});
            }
        };

        audio.addEventListener('pause', onPause);
        audio.addEventListener('play', onPlay);
        this.eventCleanups.push(() => {
            audio.removeEventListener('pause', onPause);
            audio.removeEventListener('play', onPlay);
        });

        // Initial state
        if (audio.paused) onPause(); else onPlay();
    }

    // ------------------------------------------------------------------------
    // Positioning
    // ------------------------------------------------------------------------

    private startPositionPolling(): void {
        this.stopPositionPolling();
        this.updatePosition();
        this.positionPollId = window.setInterval(() => this.updatePosition(), POSITION_POLL_MS);
    }

    private stopPositionPolling(): void {
        if (this.positionPollId !== null) {
            clearInterval(this.positionPollId);
            this.positionPollId = null;
        }
    }

    private updatePosition(): void {
        if (!this.barEl?.isConnected) return;

        const isPlayerMinimized = !!AppStore.state?.player?.hide ||
            !!AppStore.player?.hide;

        if (isPlayerMinimized) {
            this.barEl.style.display = '';

            const playerBar = document.querySelector('.q-footer, .player-bar-container') as HTMLElement | null;
            const subsBar = document.querySelector('body > .learner-subs-collapsed') as HTMLElement | null;
            const joiBar = document.querySelector('body > .asmr-joi-bar-collapsed') as HTMLElement | null;

            let bottomOffset = playerBar?.offsetHeight || 60;

            // Stack above collapsed subs if visible
            if (subsBar && subsBar.style.display !== 'none' && !subsBar.classList.contains('hidden') && subsBar.offsetHeight > 0) {
                bottomOffset += subsBar.offsetHeight;
            }

            // Stack above JOI bar if visible
            if (joiBar && joiBar.style.display !== 'none' && !joiBar.classList.contains('hidden') && joiBar.offsetHeight > 0) {
                bottomOffset += joiBar.offsetHeight;
            }

            this.barEl.style.bottom = `${bottomOffset}px`;

            if (this.expandedBarEl?.isConnected) {
                this.expandedBarEl.style.display = 'none';
            }
        } else {
            // Expanded player
            const audioPlayer = document.querySelector('.audio-player') as HTMLElement | null;
            const expandedSubs = audioPlayer?.querySelector('.learner-subs-expanded') as HTMLElement | null;
            const hasVisibleSubs = !!expandedSubs &&
                expandedSubs.style.visibility !== 'hidden' &&
                expandedSubs.offsetHeight > 0;

            if (hasVisibleSubs) {
                // Inside expanded player
                this.barEl.style.display = 'none';
                if (this.expandedBarEl?.isConnected) {
                    this.expandedBarEl.style.display = '';
                }
            } else {
                // Collapsed bar above expanded player
                this.barEl.style.display = '';
                if (audioPlayer) {
                    const rect = audioPlayer.getBoundingClientRect();
                    let bottom = window.innerHeight - rect.top;
                    // Stack above JOI bar if it's also outside the player
                    const joiBar = document.querySelector('body > .asmr-joi-bar-collapsed') as HTMLElement | null;
                    if (joiBar && joiBar.style.display !== 'none' && !joiBar.classList.contains('hidden') && joiBar.offsetHeight > 0) {
                        bottom += joiBar.offsetHeight;
                    }
                    this.barEl.style.bottom = `${bottom}px`;
                }
                if (this.expandedBarEl?.isConnected) {
                    this.expandedBarEl.style.display = 'none';
                }
            }
        }
    }

    // ------------------------------------------------------------------------
    // Overflow Button State
    // ------------------------------------------------------------------------

    private syncOverflowButton(active: boolean): void {
        const btns = document.querySelectorAll('.asmr-viz-btn');
        btns.forEach(btn => {
            const icon = btn.querySelector('.material-icons');
            if (icon) {
                icon.classList.toggle('asmr-accent', active);
            }
            btn.classList.toggle('learner-btn-active', active);
        });
    }

    // ------------------------------------------------------------------------
    // UI
    // ------------------------------------------------------------------------

    private ensureUI(): void {
        if (!this.barEl || !this.barEl.isConnected) {
            this.barEl?.remove();
            this.barEl = this.createBar('asmr-viz-bar-collapsed');
            document.body.appendChild(this.barEl);
            if (this.isActive) {
                this.barEl.classList.remove('hidden');
            }
        }

        const player = document.querySelector('.audio-player');
        if (player && (!this.expandedBarEl || !this.expandedBarEl.isConnected)) {
            this.expandedBarEl?.remove();
            this.expandedBarEl = this.createBar('asmr-viz-bar-expanded');

            CentralObserver.withModification(() => {
                // Insert before JOI bar or subs root, or after album art
                const joiExpanded = player.querySelector('.asmr-joi-bar-expanded');
                const subsRoot = player.querySelector('#asmr-learner-subs-root');
                if (joiExpanded) {
                    joiExpanded.before(this.expandedBarEl!);
                } else if (subsRoot) {
                    subsRoot.before(this.expandedBarEl!);
                } else {
                    const albumArt = player.querySelector('.albumart');
                    if (albumArt) {
                        albumArt.after(this.expandedBarEl!);
                    } else {
                        player.prepend(this.expandedBarEl!);
                    }
                }
            });

            if (this.isActive) {
                this.expandedBarEl.classList.remove('hidden');
            }
        }

        if (this.isActive) this.updatePosition();
    }

    private createBar(extraClass: string): HTMLElement {
        const bar = document.createElement('div');
        bar.className = `asmr-viz-bar hidden ${extraClass}`;
        bar.setAttribute('role', 'region');
        bar.setAttribute('aria-label', I18n.t('enableVisualizer'));

        bar.innerHTML = `
            <canvas class="asmr-viz-canvas"></canvas>
            <button class="asmr-viz-close" title="${I18n.t('vizToggle')}">
                <i class="material-icons" aria-hidden="true">close</i>
            </button>
        `;

        bar.querySelector('.asmr-viz-close')?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.deactivate();
        });

        return bar;
    }

    private showBar(): void {
        for (const bar of this.getBars()) {
            bar.classList.remove('hidden');
        }
    }

    private hideBar(): void {
        for (const bar of this.getBars()) {
            bar.classList.add('hidden');
        }
    }

    private getBars(): HTMLElement[] {
        const bars: HTMLElement[] = [];
        if (this.barEl?.isConnected) bars.push(this.barEl);
        if (this.expandedBarEl?.isConnected) bars.push(this.expandedBarEl);
        return bars;
    }
}
