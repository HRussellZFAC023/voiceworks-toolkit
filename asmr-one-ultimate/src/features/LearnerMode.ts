import { Logger, Config, I18n } from '../core/Utils';
import { AppStore } from '../store/AppStore';
import { TranslationService } from '../services/TranslationService';
import { EventBus } from '../core/EventBus';
import type { WhisperUpdatePayload, VueRoute, PlayerTrack, AudioPlayerState } from '../types';
import { splitSubtitleSegments } from './subtitleSegmentSplitter';
import {
    findLyricsSource as findLyricsSourceUtil,
    normalizeLyricLines,
    parseLrcContent,
    parseSubtitleContent,
    type ExtendedAudioPlayerState,
} from './learnerLyricsUtils';

import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { getAudioElement, getPlayerBar } from '../core/DomUtils';

/** Normalized lyric line used internally */
interface LyricLine {
    time: number;
    endTime?: number;
    text: string;
    words?: Array<{ start: number; end: number; text: string }>;
}

export class LearnerMode {
    private bridge: KikoeruBridge;
    private expanded: HTMLElement | null = null;
    private collapsed: HTMLElement | null = null;
    private currentLyrics: LyricLine[] = [];
    private lastText = '';
    private lastDisplayedText = ''; // Track what's actually shown to prevent flashing
    private lastSecondaryShown = ''; // Track actual EN translation shown (vs empty placeholder)
    private lastTrackKey: string | null = null;
    private translationToken = 0;
    private whisperLines: LyricLine[] = [];
    private whisperText = '';
    private whisperActive = false;
    private whisperFromCache = false;
    private whisperLive = false;
    private whisperLeadSec = 0;
    private lastWhisperDisplayText = '';
    private whisperTickerId: number | null = null;
    private whisperTickerInterval = 80;
    private isBlurEnabled = true;
    private subtitleLeadSec = 1.2;
    private subtitleAppendWindowSec = 1.5;
    private subtitleAppendMaxChars = 140;
    private boundAudio: HTMLAudioElement | null = null;
    private boundTimeHandler: (() => void) | null = null;
    private eventCleanups: (() => void)[] = [];
    private storeWatcherCleanups: (() => void)[] = [];
    private originalParents: Map<HTMLElement, { parent: HTMLElement, nextSibling: Node | null }> = new Map();
    private overflowMenu: HTMLElement | null = null;
    private hostMoreBtn: HTMLElement | null = null;
    private lastPreTranslatedKey: string | null = null; // Track which lyrics set has been pre-translated

    // Ticker translation throttle: prevents spamming translate() every 80ms for the same text
    private lastTickerTranslationText = '';
    private lastTickerTranslationAt = 0;
    private readonly TICKER_TRANSLATION_COOLDOWN_MS = 250;

    // Playback Speed
    private playbackRate = 1.0;

    // LRC file loading state
    private lastLrcTrackHash: string | null = null;
    private lrcFetchPromise: Promise<void> | null = null;
    private lrcFetchAttemptedHashes = new Set<string>(); // Tracks hashes we've already tried (even if failed)
    private lastNoLyricsLogHash: string | null = null; // Prevent "No lyrics found" spam
    private playerObserver: MutationObserver | null = null;
    // rAF coalescing — prevent layout thrashing during window resize
    private rafPlayerObserver = 0;
    private rafDrawerSync = 0;

    // Cached DOM element references (avoid querySelectorAll in hot paths)
    private cachedJpEls: HTMLElement[] = [];
    private cachedEnEls: HTMLElement[] = [];
    private cachedElsDirty = true;

    constructor() {
        this.bridge = KikoeruBridge.getInstance();
        this.playbackRate = Number(Config.get('playbackRate')) || 1.0;
        this.isBlurEnabled = !!Config.get('learnerBlur');
    }

    public async enable(): Promise<void> {
        this.playbackRate = Number(Config.get('playbackRate')) || 1.0;
        this.isBlurEnabled = !!Config.get('learnerBlur');

        // Set active state in store
        AppStore.setLearnerState({ isActive: true });

        // Use timeupdate event for accurate subtitle sync (no polling needed)
        this.boundTimeHandler = () => this.updateLyrics();

        // Register EventBus listeners (only once)
        if (this.eventCleanups.length === 0) {
            // Whisper clear events (track change)
            this.eventCleanups.push(EventBus.on('whisper:clear', () => {
                this.handleWhisperClear();
            }));

            // Whisper update events (live transcription text)
            this.eventCleanups.push(EventBus.on('whisper:update', (payload) => {
                this.handleWhisperUpdate(payload);
            }));

            // Whisper segment-translated events (live translation completed)
            this.eventCleanups.push(EventBus.on('whisper:segment-translated', () => {
                if (this.whisperActive) this.updateLyrics();
            }));

            // React to track/work changes from Vue state (via KikoeruBridge)
            this.eventCleanups.push(EventBus.on('track:change', () => {
                this.onTrackOrWorkChange();
            }));
            this.eventCleanups.push(EventBus.on('work:change', () => {
                this.onTrackOrWorkChange();
            }));

            // Keyboard navigation listeners
            this.eventCleanups.push(EventBus.on('player:nav-prev', () => {
                if (this.currentLyrics.length > 0) {
                    this.seek(-1);
                } else {
                    try { this.bridge.commit('AudioPlayer/PREVIOUS_TRACK'); } catch { /* mutation unavailable */ }
                }
            }));
            this.eventCleanups.push(EventBus.on('player:nav-next', () => {
                if (this.currentLyrics.length > 0) {
                    this.seek(1);
                } else {
                    try { this.bridge.commit('AudioPlayer/NEXT_TRACK'); } catch { /* mutation unavailable */ }
                }
            }));

            // Playback rate sync from keyboard
            this.eventCleanups.push(EventBus.on('player:rate-change', (payload) => {
                this.playbackRate = payload.rate;
                this.syncSpeedUI();
            }));

            // Sync blur from config changes (e.g. from KeyboardManager)
            this.eventCleanups.push(EventBus.on('config:change', ({ key, value }) => {
                if (key === 'learnerBlur') {
                    this.isBlurEnabled = !!value;
                    this.applyBlurState();
                } else if (key === 'showJP') {
                    this.updateStyle();
                } else if (key === 'enablePlayerTranslator') {
                    for (const el of this.getEnEls()) {
                        el.style.display = value ? '' : 'none';
                    }
                } else if (key === 'enableWhisper' || key === 'enableJoiTool' || key === 'enableVisualizer') {
                    this.syncOverflowItemVisibility(key, !!value);
                }
            }));

            // Retry translation when a model becomes ready (fixes stuck fallback if model loaded late)
            this.eventCleanups.push(EventBus.on('translation:progress', (payload) => {
                if (payload && payload.stage === 'ready') {
                    Logger.debug('[LearnerMode] Translation model ready, refreshing lyrics...');
                    this.updateLyrics();
                }
            }));
        }

        // Watch Vue route changes
        const app = this.bridge.app;
        if (app?.$watch) {
            app.$watch('$route', (to: VueRoute) => {
                this.lastText = '';
                this.currentLyrics = [];
                this.whisperLines = [];
                this.whisperText = '';
                this.whisperActive = false;
                const path = to?.path || '';
                if (!path.startsWith('/work/')) {
                    this.cleanupInjected();
                } else {
                    // On work page - inject UI after a short delay for DOM to settle
                    setTimeout(() => {
                        this.ensureUIInjected();
                        this.updateLyrics();
                    }, 100);
                }
                this.updateVisibility();
                this.bindAudioTimeUpdate();
            });
        }

        // Watch store for lyrics changes
        this.setupStoreWatchers();

        // Initial injection
        this.ensureUIInjected();

        // Setup observer for player appearance (race condition fix)
        this.setupPlayerObserver();

        // Fetch LRC for current track on initial load (handles page refresh with track already playing)
        // Small delay to ensure KikoeruBridge has detected the current track
        setTimeout(() => {
            if (this.bridge.currentTrack) {
                Logger.debug('[LearnerMode] Initial LRC fetch for already-playing track');
                this.fetchLrcForCurrentTrack().catch(err => {
                    Logger.error('[LearnerMode] Initial LRC fetch failed:', err);
                });
            }
        }, 500);
    }

    public disable(): void {
        Logger.log('[LearnerMode] Disabling...');

        // Unsubscribe EventBus listeners
        for (const cleanup of this.eventCleanups) {
            try { cleanup(); } catch { /* ignore */ }
        }
        this.eventCleanups = [];

        // Unsubscribe Vuex store watchers
        for (const unsub of this.storeWatcherCleanups) {
            try { unsub(); } catch { /* ignore */ }
        }
        this.storeWatcherCleanups = [];

        // Clear whisper state
        this.clearWhisperTicker();
        this.whisperLines = [];
        this.whisperText = '';
        this.whisperActive = false;

        // Clear originalParents (controls reparenting map)
        this.originalParents.clear();
        this.overflowMenu?.remove();
        this.overflowMenu = null;

        // Clean up injected DOM, audio listeners, observers
        this.cleanupInjected();
    }

    private setupPlayerObserver(): void {
        this.playerObserver?.disconnect();
        this.playerObserver = new MutationObserver(() => {
            if (this.rafPlayerObserver) return;
            this.rafPlayerObserver = requestAnimationFrame(() => {
                this.rafPlayerObserver = 0;
                if (!this.expanded || !this.collapsed) {
                    this.ensureUIInjected();
                } else if (this.cachedJpEls.length > 0 && !this.cachedJpEls[0]?.isConnected) {
                    // Cached subtitle elements detached (DOM rebuilt) — force re-query
                    this.invalidateCachedEls();
                }
            });
        });
        this.playerObserver.observe(document.body, { childList: true, subtree: true });

        // Watch drawer resizes to keep subtitle bar aligned with sidebar edge — coalesce via rAF
        const drawer = document.querySelector('.q-drawer--left') as HTMLElement | null;
        if (drawer && typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver(() => {
                if (this.rafDrawerSync) return;
                this.rafDrawerSync = requestAnimationFrame(() => { this.rafDrawerSync = 0; this.syncDrawerWidth(); });
            });
            ro.observe(drawer);
            this.eventCleanups.push(() => ro.disconnect());
        }
    }


    /**
     * Setup Vuex store watchers for reactive updates
     */
    private setupStoreWatchers(): void {
        const store = this.bridge.store;
        Logger.debug('[LearnerMode] setupStoreWatchers called, store:', !!store, 'watch:', !!(store?.watch));
        if (!store?.watch) {
            Logger.warn('[LearnerMode] No store.watch available, watchers not set up');
            return;
        }

        // Guard against double registration
        if (this.storeWatcherCleanups.length > 0) return;

        const save = (unsub: (() => void) | undefined) => {
            if (unsub) this.storeWatcherCleanups.push(unsub);
        };

        // Watch for lyrics/lrcLines changes
        save(store.watch(
            (state) => state.AudioPlayer?.lrcLines,
            () => this.updateLyrics(),
            { immediate: true }
        ));
        save(store.watch(
            (state) => (state.AudioPlayer as AudioPlayerState & Record<string, unknown>)?.lyrics,
            () => this.updateLyrics(),
            { immediate: true }
        ));
        save(store.watch(
            (state) => (state.AudioPlayer as AudioPlayerState & Record<string, unknown>)?.lyricLines,
            () => this.updateLyrics(),
            { immediate: true }
        ));
        save(store.watch(
            (state) => (state.AudioPlayer as AudioPlayerState & Record<string, unknown>)?.subtitleLines,
            () => this.updateLyrics(),
            { immediate: true }
        ));
        save(store.watch(
            (state) => (state.AudioPlayer as AudioPlayerState & Record<string, unknown>)?.subtitles,
            () => this.updateLyrics(),
            { immediate: true }
        ));
        save(store.watch(
            (state) => ((state.AudioPlayer as AudioPlayerState & Record<string, unknown>)?.subtitle as Record<string, unknown> | undefined)?.lines,
            () => this.updateLyrics(),
            { immediate: true }
        ));

        // Watch for current lyric text changes
        save(store.watch(
            (state) => state.AudioPlayer?.currentLyric,
            (lyric) => {
                if (lyric) this.updateLyrics();
            }
        ));

        // Watch for track changes via queue[queueIndex] - the correct source
        save(store.watch(
            (state) => {
                const ap = state.AudioPlayer;
                if (!ap?.queue || typeof ap.queueIndex !== 'number') return null;
                const track = ap.queue[ap.queueIndex];
                return track?.hash || track?.mediaStreamUrl || null;
            },
            (trackKey) => {
                // Small delay to let audio element update
                setTimeout(() => {
                    this.bindAudioTimeUpdate();
                    // Also fetch LRC for the new track
                    if (trackKey) {
                        Logger.debug('[LearnerMode] Track change detected via store watcher, fetching LRC...');
                        this.fetchLrcForCurrentTrack().catch(err => {
                            Logger.error('[LearnerMode] Store watcher LRC fetch failed:', err);
                        });
                    }
                }, 100);
            },
            { immediate: true }
        ));

        // Also watch the audio source directly (most reliable way to detect track changes)
        save(store.watch(
            (state) => state.AudioPlayer?.source,
            (src) => {
                if (src) {
                    setTimeout(() => {
                        this.fetchLrcForCurrentTrack().catch(err => {
                            Logger.error('[LearnerMode] Source watcher LRC fetch failed:', err);
                        });
                    }, 200);
                }
            },
            { immediate: true }
        ));

        // Watch for playing state changes (backup trigger)
        save(store.watch(
            (state) => state.AudioPlayer?.playing,
            (playing) => {
                if (playing && this.currentLyrics.length === 0) {
                    this.fetchLrcForCurrentTrack().catch(err => {
                        Logger.error('[LearnerMode] Playing watcher LRC fetch failed:', err);
                    });
                }
            },
            { immediate: true }
        ));

        // Watch for player minimize/expand state
        save(store.watch(
            (state) => state.AudioPlayer?.hide,
            () => this.updateVisibility()
        ));
    }

    /**
     * Handle track or work change events
     */
    private onTrackOrWorkChange(): void {
        this.lastText = '';
        this.lastDisplayedText = '';
        this.lastSecondaryShown = '';
        this.currentLyrics = [];
        this.whisperLines = [];
        this.whisperText = '';
        this.whisperActive = false;
        this.whisperFromCache = false;
        this.whisperLeadSec = 0;
        this.lastWhisperDisplayText = '';
        this.clearWhisperTicker();
        if (this.seekedDebounceTimer) { clearTimeout(this.seekedDebounceTimer); this.seekedDebounceTimer = null; }
        this.translationToken += 1;
        this.lastPreTranslatedKey = null; // Reset so new lyrics get pre-translated
        this.lastLrcTrackHash = null; // Reset so we can fetch LRC for new track
        this.lrcFetchAttemptedHashes.clear(); // Allow new track to be fetched
        this.lrcFetchPromise = null; // Prevent stale promise from being reused
        this.lastNoLyricsLogHash = null;
        this.clearDisplay();

        this.ensureUIInjected();
        this.bindAudioTimeUpdate();

        // Try to fetch LRC file directly from API first (most reliable method)
        this.fetchLrcForCurrentTrack().catch(err => {
            Logger.error('[LearnerMode] LRC fetch failed, will try other sources:', err);
        });

        this.updateLyrics();
    }

    /**
     * Ensure UI containers are injected (called on events, not polling)
     */
    private ensureUIInjected(): void {
        let stale = false;
        if (this.expanded && !this.expanded.isConnected) { this.expanded = null; stale = true; }
        if (this.collapsed && !this.collapsed.isConnected) { this.collapsed = null; stale = true; }
        if (stale) this.invalidateCachedEls();

        const needsInject = !this.expanded || !this.collapsed;
        const player = document.querySelector('.audio-player');
        if (player && !this.expanded) this.injectExpanded(player as HTMLElement);

        const bar = getPlayerBar();
        if (bar) {
            this.injectCollapsedControls(bar as HTMLElement);
            this.injectCollapsedSubs(bar as HTMLElement);
        }

        if (needsInject) this.invalidateCachedEls();

        this.updateVisibility();
        this.updateStyle();
    }

    private bindAudioTimeUpdate(): void {
        const audio = getAudioElement();
        if (!audio) {
            Logger.debug('[LearnerMode] bindAudioTimeUpdate: no audio element found');
            return;
        }

        // Apply persisted playback rate every time bind is called (e.g. track change)
        if (this.playbackRate !== 1.0) {
            audio.playbackRate = this.playbackRate;
        }

        // Already bound to this element - but we still apply rate above
        if (this.boundAudio === audio) return;

        // Unbind from old element
        if (this.boundAudio && this.boundTimeHandler) {
            this.boundAudio.removeEventListener('timeupdate', this.boundTimeHandler);
            this.boundAudio.removeEventListener('play', this.handleAudioPlay);
            this.boundAudio.removeEventListener('seeking', this.handleAudioSeeking);
            this.boundAudio.removeEventListener('seeked', this.handleAudioSeeked);
        }

        // Bind to new element
        this.boundAudio = audio;
        if (this.boundTimeHandler) {
            audio.addEventListener('timeupdate', this.boundTimeHandler);
        }

        // Clear display immediately on seek start for instant feedback
        audio.addEventListener('seeking', this.handleAudioSeeking);
        // Re-evaluate lyrics at new position after seek completes (debounced)
        audio.addEventListener('seeked', this.handleAudioSeeked);
        // Extra robustness: re-apply rate on play in case browser reset it on src change
        audio.addEventListener('play', this.handleAudioPlay);
    }

    private handleAudioPlay = () => {
        if (this.boundAudio && this.playbackRate !== 1.0) {
            this.boundAudio.playbackRate = this.playbackRate;
        }
    };

    private handleAudioSeeking = () => {
        this.lastText = '';
        this.lastDisplayedText = '';
        this.lastSecondaryShown = '';
        this.lastWhisperDisplayText = '';
        this.translationToken += 1;
        // Immediately update display so subtitles track the scrub position in real-time
        this.updateLyrics();
    };

    private seekedDebounceTimer: number | null = null;
    private handleAudioSeeked = () => {
        // Final refresh when user releases scrubber — reset dedup for clean state
        this.lastText = '';
        this.lastDisplayedText = '';
        this.lastSecondaryShown = '';
        this.lastWhisperDisplayText = '';
        this.translationToken += 1;
        if (this.seekedDebounceTimer) clearTimeout(this.seekedDebounceTimer);
        this.seekedDebounceTimer = window.setTimeout(() => {
            this.seekedDebounceTimer = null;
            this.updateLyrics();
        }, 30);
    };


    private injectExpanded(player: HTMLElement) {
        const existing = player.querySelector('.learner-subs-expanded') as HTMLElement | null;
        this.expanded = existing || this.createSubsContainer('learner-subs-expanded');
        const albumArt = player.querySelector('.albumart');
        if (!existing) {
            albumArt ? albumArt.after(this.expanded) : player.prepend(this.expanded);
        }

        const controls = player.querySelector('.row.self-center:not(.q-py-md)') as HTMLElement | null;
        if (controls) {
            const existing = controls.querySelector('.learner-controls') as HTMLElement | null;
            if (existing) {
                // Ensure slider exists in expanded player (before overflow toggle)
                if (!existing.querySelector('.asmr-speed-slider-wrap')) {
                    const overflowToggle = existing.querySelector('.learner-overflow-toggle');
                    const slider = this.createSpeedSlider();
                    overflowToggle ? existing.insertBefore(slider, overflowToggle) : existing.appendChild(slider);
                }
                setTimeout(() => this.captureControls(controls, existing), 0);
                return;
            }
            const learnerCtrls = this.createControls();
            controls.insertBefore(learnerCtrls, controls.firstChild);

            setTimeout(() => this.captureControls(controls, learnerCtrls), 0);
        }
    }

    private captureControls(parent: HTMLElement, reference: HTMLElement) {
        // P3 FIX: Deep search for buttons to handle mini-player nesting
        const allButtons = Array.from(parent.querySelectorAll('button'));

        // Define standard controls to exclude (by icon name)
        const excludedIcons = new Set([
            'skip_previous', 'skip_next', 'play_arrow', 'pause',
            'replay_5', 'forward_30', 'volume_up', 'volume_down',
            'chevron_left', 'chevron_right', 'translate', 'record_voice_over' // Our own icons
        ]);

        const candidates = allButtons.filter(btn => {
            const htmlEl = btn as HTMLElement;
            // Don't capture valid Learner Mode controls or the overflow toggle itself
            if (htmlEl.classList.contains('learner-control-btn')) return false;
            // Don't capture the microphone/whisper button
            if (htmlEl.classList.contains('asmr-whisper-btn')) return false;

            // Check icon content to exclude main player controls
            const icon = htmlEl.querySelector('.q-icon, .material-icons');
            if (icon && icon.textContent) {
                const iconName = icon.textContent.trim();
                if (excludedIcons.has(iconName)) return false;

                // P4 FIX: Identify and store host 'more_horiz' button but don't move it
                if (iconName === 'more_horiz') {
                    this.hostMoreBtn = htmlEl;
                    this.hostMoreBtn.style.display = 'none';
                    return false; // Don't capture into overflow, we'll proxy it
                }
            }

            return true;
        }) as HTMLElement[];

        // Ensure overflow menu exists
        if (!this.overflowMenu) {
            this.overflowMenu = document.createElement('div');
            this.overflowMenu.className = 'learner-overflow-menu hidden';
            this.overflowMenu.setAttribute('role', 'menu');
            this.overflowMenu.ariaLabel = I18n.t('more') || 'More options';
            document.body.appendChild(this.overflowMenu);

            // P4 FIX: Add permanent items (Whisper + Host Proxies)
            this.addPermanentOverflowItems();
        }

        candidates.forEach(btn => {
            if (this.originalParents.has(btn)) return;

            this.originalParents.set(btn, {
                parent: btn.parentElement as HTMLElement,
                nextSibling: btn.nextSibling
            });

            this.overflowMenu?.appendChild(btn);
        });

        const toggle = reference.querySelector('.learner-overflow-toggle') as HTMLElement;
        if (toggle) toggle.classList.remove('hidden');
    }

    private addPermanentOverflowItems() {
        if (!this.overflowMenu) return;

        const createItem = (icon: string, title: string, onClick: () => void, extraClass = '') => {
            const b = document.createElement('button');
            b.className = `q-btn q-btn-item non-selectable no-outline q-btn--flat q-btn--rectangle q-btn--dense q-ma-sm q-focusable q-hoverable learner-control-btn learner-btn-normal ${extraClass}`;
            b.title = title;
            b.ariaLabel = title;
            b.innerHTML = `
                <span class="q-focus-helper"></span>
                <span class="q-btn__wrapper col row q-anchor--skip">
                    <span class="q-btn__content text-center col items-center q-anchor--skip justify-center row">
                        <i aria-hidden="true" role="img" class="q-icon material-icons">${icon}</i>
                    </span>
                </span>
            `;
            b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); onClick(); };
            return b;
        };

        // 1. Whisper Button
        const whisperBtn = createItem('record_voice_over', I18n.t('aiTranscribe'), () => {
            EventBus.emit('whisper:toggle', undefined);
        }, 'asmr-whisper-btn');
        if (!Config.get('enableWhisper')) whisperBtn.style.display = 'none';
        this.overflowMenu.appendChild(whisperBtn);

        // 2. Host "Open Work" Proxy
        const openWorkBtn = createItem('link', I18n.t('openWorkDetail'), () => {
            this.triggerHostMenuAction('link');
        });
        this.overflowMenu.appendChild(openWorkBtn);

        // 3. Host "Load Local Subtitle" Proxy
        const loadSubBtn = createItem('folder', I18n.t('loadSubtitle'), () => {
            this.triggerHostMenuAction('subtitles');
        });
        this.overflowMenu.appendChild(loadSubBtn);

        // 4. Playback Speed Toggle (with badge indicator)
        const speedBtn = createItem('speed', I18n.format('speedTitle', { rate: this.playbackRate }), () => {
            this.cyclePlaybackRate(speedBtn);
        }, 'asmr-speed-btn');
        // Add speed swatch indicator
        const swatch = document.createElement('span');
        swatch.className = 'asmr-speed-swatch';
        swatch.textContent = `${this.playbackRate}x`;
        speedBtn.appendChild(swatch);
        this.overflowMenu.appendChild(speedBtn);

        // 5. Download Current Track
        const downloadBtn = createItem('download', I18n.t('downloadTrack'), () => {
            this.downloadCurrentTrack();
        });
        this.overflowMenu.appendChild(downloadBtn);

        // 6. JOI Tool Toggle
        const joiBtn = createItem('casino', I18n.t('joiToggle'), () => {
            EventBus.emit('joi:toggle', undefined);
        }, 'asmr-joi-btn');
        if (!Config.get('enableJoiTool')) joiBtn.style.display = 'none';
        this.overflowMenu.appendChild(joiBtn);

        // 7. Visualizer Toggle
        const vizBtn = createItem('graphic_eq', I18n.t('vizToggle'), () => {
            EventBus.emit('viz:toggle', undefined);
        }, 'asmr-viz-btn');
        if (!Config.get('enableVisualizer')) vizBtn.style.display = 'none';
        this.overflowMenu.appendChild(vizBtn);
    }

    private static readonly OVERFLOW_CONFIG_MAP: Record<string, string> = {
        enableWhisper: '.asmr-whisper-btn',
        enableJoiTool: '.asmr-joi-btn',
        enableVisualizer: '.asmr-viz-btn',
    };

    private syncOverflowItemVisibility(configKey: string, enabled: boolean): void {
        const selector = LearnerMode.OVERFLOW_CONFIG_MAP[configKey];
        if (!selector || !this.overflowMenu) return;
        const btn = this.overflowMenu.querySelector(selector) as HTMLElement | null;
        if (btn) btn.style.display = enabled ? '' : 'none';
    }

    private downloadCurrentTrack() {
        const track = this.bridge.currentTrack;
        if (!track) return;

        const url = track.mediaDownloadUrl || track.media_download_url || track.file_url;
        if (!url) return;

        const a = document.createElement('a');
        a.href = url;
        a.download = track.title || '';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    private cyclePlaybackRate(btn: HTMLElement) {
        const rates = [1.0, 1.25, 1.5, 2.0, 0.5, 0.75];
        let nextIdx = (rates.indexOf(this.playbackRate) + 1) % rates.length;
        if (nextIdx < 0) nextIdx = 0;

        this.setPlaybackRate(rates[nextIdx], btn);
    }

    private syncSpeedUI(): void {
        document.querySelectorAll('.asmr-speed-swatch').forEach(el => {
            el.textContent = `${this.playbackRate}x`;
            el.classList.toggle('modified', this.playbackRate !== 1.0);
        });
        document.querySelectorAll<HTMLInputElement>('.asmr-speed-slider').forEach(slider => {
            slider.value = String(this.playbackRate);
        });
        document.querySelectorAll('.asmr-speed-slider-label').forEach(el => {
            el.textContent = `${this.playbackRate}x`;
        });
    }

    private setPlaybackRate(rate: number, triggerBtn?: HTMLElement) {
        this.playbackRate = rate;
        Config.set('playbackRate', this.playbackRate);

        // Apply to bound audio element, falling back to live DOM query
        const audio = this.boundAudio || getAudioElement();
        if (audio) {
            audio.playbackRate = this.playbackRate;
        }

        // Update speed button title and swatch
        if (triggerBtn) {
            triggerBtn.title = I18n.format('speedTitle', { rate: this.playbackRate });
        }

        this.syncSpeedUI();
        Logger.debug(`[LearnerMode] Playback speed set to ${this.playbackRate}x`);
    }

    private createSpeedSlider(): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'asmr-speed-slider-wrap';
        wrap.style.filter = 'opacity(1)';
        wrap.style.pointerEvents = 'auto';

        const label = document.createElement('span');
        label.className = 'asmr-speed-slider-label';
        label.textContent = `${this.playbackRate}x`;
        label.id = `speed-label-${Math.random().toString(36).substr(2, 9)}`;

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.className = 'asmr-speed-slider';
        slider.min = '0.5';
        slider.max = '2';
        slider.step = '0.25';
        slider.value = String(this.playbackRate);
        slider.ariaLabel = I18n.t('playbackSpeed') || 'Playback Speed';
        slider.setAttribute('aria-labelledby', label.id);

        slider.addEventListener('input', () => {
            const rate = parseFloat(slider.value);
            label.textContent = `${rate}x`;
            this.setPlaybackRate(rate);
        });

        wrap.append(label, slider);
        return wrap;
    }

    private triggerHostMenuAction(iconName: string) {
        if (!this.hostMoreBtn) {
            Logger.warn('[LearnerMode] Host More button not found, cannot proxy action.');
            return;
        }

        // click the hidden button to open menu
        this.hostMoreBtn.click();

        // Wait for menu transition
        setTimeout(() => {
            // Find the most recently added/visible q-menu
            const menus = document.querySelectorAll('.q-menu');
            // Usually the last one is the new one
            const menu = menus.length > 0 ? menus[menus.length - 1] : null;

            if (menu) {
                // Find item with the icon
                const items = Array.from(menu.querySelectorAll('.q-item'));
                const target = items.find(i => i.innerHTML.includes(iconName));
                if (target) {
                    (target as HTMLElement).click();
                } else {
                    Logger.warn('[LearnerMode] Could not find menu item with icon:', iconName);
                }
            }
        }, 100); // 100ms should be enough for Quasar transition start
    }

    /** Position the overflow menu above the toggle button */
    private positionOverflowMenu(toggleBtn: HTMLElement) {
        if (!this.overflowMenu) return;
        const EDGE_MARGIN = 8;
        const rect = toggleBtn.getBoundingClientRect();
        // Clamp left so menu doesn't overshoot into the sidebar or past right edge
        const sidebar = document.querySelector('.q-drawer--left, .q-drawer') as HTMLElement | null;
        const minLeft = sidebar ? sidebar.getBoundingClientRect().right + EDGE_MARGIN : EDGE_MARGIN;
        const menuWidth = this.overflowMenu.offsetWidth || 48;
        const maxLeft = window.innerWidth - menuWidth - EDGE_MARGIN;
        const left = Math.max(minLeft, Math.min(rect.left, maxLeft));
        this.overflowMenu.style.left = `${left}px`;
        // Position above button with breathing room, clamp to top edge
        const bottom = window.innerHeight - rect.top + 8;
        const menuHeight = this.overflowMenu.offsetHeight || 0;
        const topPos = window.innerHeight - bottom;
        if (topPos < EDGE_MARGIN && menuHeight > 0) {
            // Menu would overflow top — flip to below button
            this.overflowMenu.style.bottom = 'auto';
            this.overflowMenu.style.top = `${rect.bottom + 8}px`;
        } else {
            this.overflowMenu.style.bottom = `${bottom}px`;
            this.overflowMenu.style.top = 'auto';
        }
    }

    private restoreControls() {
        this.originalParents.forEach((loc, btn) => {
            // Restore hidden host buttons (e.g. more_horiz)
            btn.style.display = '';
            if (loc.parent && loc.parent.isConnected) {
                loc.parent.insertBefore(btn, loc.nextSibling);
            }
        });
        if (this.hostMoreBtn) {
            this.hostMoreBtn.style.display = '';
            this.hostMoreBtn = null;
        }
        this.originalParents.clear();
        this.overflowMenu?.remove();
        this.overflowMenu = null;
    }

    private injectCollapsedControls(bar: HTMLElement) {
        const playerBar = bar.matches('.player-bar, .q-footer')
            ? bar
            : bar.querySelector('.player-bar, .q-footer');
        if (!playerBar || playerBar.querySelector('[data-asmr-learner-controls]')) return;

        const ctrl = this.createControls(true);
        // Remove speed slider from player bar controls
        const slider = ctrl.querySelector('.asmr-speed-slider-wrap');
        if (slider) slider.remove();

        // Insert after the skip_next button (but not within playlist controls)
        const skipNextBtn = Array.from(playerBar.querySelectorAll('button')).find(btn => {
            // Skip buttons inside our playlist controls container
            if (btn.classList.contains('asmr-playlist-player-btn')) return false;
            if (btn.closest('.asmr-playlist-player-controls')) return false;
            if (btn.getAttribute('title')?.includes('Next Work')) return false; // Extra safety check

            const icon = btn.querySelector('.material-icons, .q-icon');
            return icon && icon.textContent?.trim() === 'skip_next';
        });
        if (skipNextBtn && skipNextBtn.parentElement) {
            skipNextBtn.parentElement.insertBefore(ctrl, skipNextBtn.nextSibling);
        } else {
            playerBar.appendChild(ctrl);
        }

        setTimeout(() => this.captureControls(playerBar as HTMLElement, ctrl), 0);
    }

    private injectCollapsedSubs(bar: HTMLElement) {
        // P1-05 FIX: Inject into body or higher level container to allow fixed positioning
        // instead of constraining inside the flex player bar.
        if (document.querySelector('body > .learner-subs-collapsed')) {
            this.collapsed = document.querySelector('body > .learner-subs-collapsed') as HTMLElement;
            this.syncDrawerWidth();
            return;
        }

        const subs = this.createSubsContainer('learner-subs-collapsed');
        // Initial state hidden
        subs.style.setProperty('display', 'none', 'important');

        // Append to body to ensure fixed positioning works relative to viewport
        document.body.appendChild(subs);

        this.collapsed = subs;
        this.syncDrawerWidth();
    }

    /** Sync --asmr-drawer-width so learner-subs-collapsed doesn't overshoot into the sidebar */
    private syncDrawerWidth() {
        const drawer = document.querySelector('.q-drawer--left') as HTMLElement | null;
        const width = drawer ? `${drawer.getBoundingClientRect().width}px` : '0px';
        document.documentElement.style.setProperty('--asmr-drawer-width', width);
    }

    private createSubsContainer(className: string): HTMLElement {
        const div = document.createElement('div');
        div.className = className;
        div.setAttribute('aria-live', 'polite');
        div.innerHTML = `<div class="learner-jp" role="status"></div><button class="learner-en"></button>`;
        const en = div.querySelector('.learner-en') as HTMLButtonElement;
        if (this.isBlurEnabled) en.classList.add('blurred');
        if (!Config.get('enablePlayerTranslator')) en.style.display = 'none';

        // Accessibility for blur toggle
        en.ariaLabel = this.isBlurEnabled
            ? (I18n.t('revealTranslation') || 'Reveal translation')
            : (I18n.t('hideTranslation') || 'Hide translation');
        en.setAttribute('aria-pressed', String(!this.isBlurEnabled));

        const toggleHandler = (e: Event) => {
            e.preventDefault();
            e.stopPropagation();
            this.toggleBlur();
        };

        en.addEventListener('click', toggleHandler);
        return div;
    }

    private toggleBlur() {
        this.isBlurEnabled = !this.isBlurEnabled;
        Config.set('learnerBlur', this.isBlurEnabled);
        this.applyBlurState();
    }

    private applyBlurState() {
        for (const e of this.getEnEls()) {
            e.classList.toggle('blurred', this.isBlurEnabled);
            e.ariaLabel = this.isBlurEnabled
                ? (I18n.t('revealTranslation') || 'Reveal translation')
                : (I18n.t('hideTranslation') || 'Hide translation');
            e.setAttribute('aria-pressed', String(!this.isBlurEnabled));
        }
    }

    private createControls(small = false): HTMLElement {
        const div = document.createElement('div');
        div.className = small ? 'learner-collapsed-controls' : 'learner-controls';
        // Sentinel to prevent double injection if called multiple times on same parent
        div.dataset.asmrLearnerControls = '1';
        // position: relative is set via CSS (.learner-controls, .learner-collapsed-controls)

        const createBtn = (icon: string, title: string, fn: (btn: HTMLElement) => void, isActive = false, extraClasses = '') => {
            const b = document.createElement('button');
            // Use standard Quasar classes to match sibling buttons perfectly
            b.className = `q-btn q-btn-item non-selectable no-outline q-btn--flat q-btn--rectangle q-btn--dense q-ma-sm q-focusable q-hoverable learner-control-btn ${isActive ? 'learner-btn-active' : ''}`;
            // font-size handled by .learner-control-btn CSS
            b.title = title;
            b.ariaLabel = title;
            b.innerHTML = `
                <span class="q-focus-helper"></span>
                <span class="q-btn__wrapper col row q-anchor--skip">
                    <span class="q-btn__content text-center col items-center q-anchor--skip justify-center row">
                        <i aria-hidden="true" role="img" class="q-icon material-icons">${icon}</i>
                    </span>
                </span>
            `;
            if (extraClasses) b.classList.add(...extraClasses.split(' '));
            b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); fn(b); };
            return b;
        };

        div.append(
            createBtn('chevron_left', I18n.t('prevLine'), () => this.seek(-1)),
            createBtn('chevron_right', I18n.t('nextLine'), () => this.seek(1)),
            createBtn('translate', I18n.t('toggleJP'), () => {
                Config.set('showJP', !Config.get('showJP'));
                this.updateStyle();
            }, !!Config.get('showJP')),
            this.createSpeedSlider(),
            // Overflow Toggle
            (() => {
                const btn = createBtn('more_vert', I18n.t('more'), (b) => {
                    if (!this.overflowMenu) return;
                    const isHidden = this.overflowMenu.classList.toggle('hidden');
                    if (!isHidden) {
                        this.positionOverflowMenu(b);
                        // Reposition on viewport resize while open
                        const onResize = () => this.positionOverflowMenu(b);
                        window.addEventListener('resize', onResize);
                        // Close on outside click
                        const close = (e: MouseEvent) => {
                            const target = e.target as Node;
                            // Fix: Use contains to check if click is inside button (e.g. icon click)
                            if (!this.overflowMenu?.contains(target) && !b.contains(target)) {
                                this.overflowMenu?.classList.add('hidden');
                                document.removeEventListener('click', close, true);
                                window.removeEventListener('resize', onResize);
                            }
                        };
                        setTimeout(() => document.addEventListener('click', close, true), 0);
                    }
                }, false, 'learner-overflow-toggle');
                btn.classList.add('hidden');
                return btn;
            })()
        );
        return div;
    }

    private updateLyrics() {
        const trackKey = this.getTrackKey();
        if (trackKey && trackKey !== this.lastTrackKey) {
            this.lastTrackKey = trackKey;
            this.lastText = '';
            this.currentLyrics = [];
            this.whisperLines = [];
            this.whisperText = '';
            this.whisperActive = false;
            this.whisperFromCache = false;
            this.whisperLive = false;
            this.whisperLeadSec = 0;
            this.lastWhisperDisplayText = '';
            this.clearWhisperTicker();
            this.clearDisplay();
            this.translationToken += 1;
        }

        // Use Whisper when active (user explicitly enabled it, so it always takes priority)
        const useWhisper = this.whisperActive;

        if (useWhisper) {
            const targetLang = (Config.get('subtitleLang') || 'en').toLowerCase();
            const allowSecondary = !this.whisperLive || this.whisperFromCache;
            if (this.whisperLines.length) {
                this.currentLyrics = this.whisperLines;
                const display = this.getWhisperDisplay();
                const fullText = display.fullText;
                if (fullText && fullText !== this.lastText) {
                    this.lastText = fullText;
                }

                let cachedSecondary: string | null = null;
                if (fullText) {
                    cachedSecondary = TranslationService.peekCached(fullText, targetLang);
                    // If not cached and live, fire async translation so it's ready next tick.
                    // Throttled to avoid spamming (translate() has in-flight dedup but we avoid the overhead).
                    if (!cachedSecondary && this.whisperLive && this.shouldTickerTranslate(fullText)) {
                        const token = ++this.translationToken;
                        TranslationService.translate(fullText, targetLang).then(translated => {
                            // Guard: text still current (lastText tracks whisper text, lastDisplayedText tracks displayed)
                            if (translated && (this.lastDisplayedText === fullText || this.lastText === fullText) && token === this.translationToken) {
                                this.updateSecondaryLine(translated, false);
                                this.lastSecondaryShown = translated;
                            }
                        }).catch(() => { });

                        // For CN text, also prefetch JA translation for primary display
                        const isCN = this.isChinese(fullText);
                        if (isCN && targetLang !== 'ja') {
                            TranslationService.translate(fullText, 'ja').catch(() => { });
                        }
                    }
                }

                if (fullText && fullText !== this.lastDisplayedText) {
                    this.lastDisplayedText = fullText;
                    this.lastSecondaryShown = '';
                    if (cachedSecondary) {
                        this.updateSecondaryLine(cachedSecondary, false);
                        this.lastSecondaryShown = cachedSecondary;
                    } else if (allowSecondary) {
                        this.updateSecondaryLine('', true);
                    }
                } else if (fullText && cachedSecondary && cachedSecondary !== this.lastSecondaryShown) {
                    // Translation became available (e.g. translateAhead filled the cache)
                    this.updateSecondaryLine(cachedSecondary, false);
                    this.lastSecondaryShown = cachedSecondary;
                }
                if (display.displayText && display.displayText !== this.lastWhisperDisplayText) {
                    const isCNPrimary = this.isChinese(display.displayText);
                    let primaryForDisplay = display.displayText;
                    let wSplitIdx = -1;
                    let wHlStart = -1;
                    const wKaraoke = !!Config.get('karaokeMode');
                    const wSegment = !!Config.get('segmentMode');
                    if (isCNPrimary) {
                        const jaCache = TranslationService.peekCached(fullText, 'ja');
                        primaryForDisplay = jaCache || display.displayText || fullText || '';
                        if (!jaCache) {
                            TranslationService.translate(fullText, 'ja').then(ja => {
                                if (ja && (this.lastDisplayedText === fullText || this.lastText === fullText)) {
                                    this.updatePrimaryLine(ja);
                                    this.lastWhisperDisplayText = ja;
                                }
                            }).catch(() => {});
                        }
                    } else if (wKaraoke && fullText) {
                        // Karaoke ON: always show full text, control visibility via CSS
                        primaryForDisplay = fullText;
                        const words = display.activeLine?.words;
                        let indices = { splitIdx: 0, hlStart: 0 };
                        const karaokeTime = display.audioTime ?? display.now;
                        if (Array.isArray(words) && words.length > 0 && karaokeTime != null) {
                            indices = this.computeWordKaraokeIndices(fullText, words, karaokeTime);
                        } else if (display.activeLine && karaokeTime != null) {
                            indices = this.computeTimeFallbackKaraokeIndices(fullText, display.activeLine, karaokeTime);
                        }
                        wSplitIdx = indices.splitIdx;
                        // Segment ON (fill-up): hlStart=0, all spoken text in accent
                        // Segment OFF (spotlight): hlStart=word start, only current word in accent
                        wHlStart = wSegment ? 0 : indices.hlStart;
                    }
                    this.updatePrimaryLine(primaryForDisplay, wSplitIdx, wHlStart);
                    this.lastWhisperDisplayText = primaryForDisplay;
                } else if (display.displayText && !!Config.get('karaokeMode')) {
                    // Karaoke: text unchanged but indices may have advanced
                    const ft = display.fullText || display.displayText;
                    const words = display.activeLine?.words;
                    let indices = { splitIdx: 0, hlStart: 0 };
                    const karaokeTime = display.audioTime ?? display.now;
                    if (Array.isArray(words) && words.length > 0 && karaokeTime != null) {
                        indices = this.computeWordKaraokeIndices(ft, words, karaokeTime);
                    } else if (display.activeLine && karaokeTime != null) {
                        indices = this.computeTimeFallbackKaraokeIndices(ft, display.activeLine, karaokeTime);
                    }
                    const newSplitIdx = indices.splitIdx;
                    const newHlStart = !!Config.get('segmentMode') ? 0 : indices.hlStart;
                    this.updatePrimaryLine(this.lastWhisperDisplayText, newSplitIdx, newHlStart);
                } else if (!display.displayText) {
                    // Between segments (gap/silence) — hold previous text visible.
                    // Clearing causes blank flashes and content shift. The next segment
                    // will naturally replace the text when it arrives.
                }
                this.updateVisibility();
                return;
            }
            if (this.whisperText) {
                if (this.whisperText !== this.lastText) {
                    this.lastText = this.whisperText;
                }
                let cachedFallback: string | null = null;
                cachedFallback = TranslationService.peekCached(this.whisperText, targetLang);
                if (!cachedFallback && this.whisperLive && this.shouldTickerTranslate(this.whisperText)) {
                    const token = ++this.translationToken;
                    TranslationService.translate(this.whisperText, targetLang).then(translated => {
                        if (translated && (this.lastDisplayedText === this.whisperText || this.lastText === this.whisperText) && token === this.translationToken) {
                            this.updateSecondaryLine(translated, false);
                            this.lastSecondaryShown = translated;
                        }
                    }).catch(() => { });

                    // For CN text, also prefetch JA translation for primary display
                    const isCN = this.isChinese(this.whisperText);
                    if (isCN && targetLang !== 'ja') {
                        TranslationService.translate(this.whisperText, 'ja').catch(() => { });
                    }
                }
                if (this.whisperText !== this.lastDisplayedText) {
                    this.lastDisplayedText = this.whisperText;
                    this.lastSecondaryShown = '';
                    if (cachedFallback) {
                        this.updateSecondaryLine(cachedFallback, false);
                        this.lastSecondaryShown = cachedFallback;
                    } else if (allowSecondary) {
                        this.updateSecondaryLine('', true);
                    }
                } else if (cachedFallback && cachedFallback !== this.lastSecondaryShown) {
                    this.updateSecondaryLine(cachedFallback, false);
                    this.lastSecondaryShown = cachedFallback;
                }
                if (this.whisperText !== this.lastWhisperDisplayText) {
                    const isCNWhisper = this.isChinese(this.whisperText);
                    let primaryWhisper = this.whisperText;
                    if (isCNWhisper) {
                        const jaCache = TranslationService.peekCached(this.whisperText, 'ja');
                        primaryWhisper = jaCache || this.whisperText || '';
                        if (!jaCache) {
                            TranslationService.translate(this.whisperText, 'ja').then(ja => {
                                if (ja && (this.lastDisplayedText === this.whisperText || this.lastText === this.whisperText)) {
                                    this.updatePrimaryLine(ja);
                                    this.lastWhisperDisplayText = ja;
                                }
                            }).catch(() => {});
                        }
                    }
                    this.updatePrimaryLine(primaryWhisper);
                    this.lastWhisperDisplayText = primaryWhisper;
                }
                this.updateVisibility();
                return;
            }
        }

        // Only try to find lyrics from other sources if we don't already have them
        // (e.g., from our direct LRC file fetch)
        if (this.currentLyrics.length === 0) {
            // Try multiple sources in order of preference:
            // 1. Vue component data (findLyricsSource)
            // 2. Vuex store lrcLines
            // 3. Audio element textTracks (VTT files)
            const data = this.findLyricsSource()
                || this.bridge.store?.state?.AudioPlayer?.lrcLines
                || this.getTextTracksAsLyrics();

            if (data?.length) {
                // Debug: Log first lyric to check format
                Logger.debug('[LearnerMode] Lyrics data found:', data.length, 'lines, sample:', JSON.stringify(data[0]));

                const newLyrics = normalizeLyricLines(data as Record<string, unknown>[]);

                // Pre-translate in background if lyrics changed
                if (newLyrics.length !== this.currentLyrics.length ||
                    (newLyrics.length > 0 && newLyrics[0]?.text !== this.currentLyrics[0]?.text)) {
                    this.preTranslateAll(newLyrics);
                }

                this.currentLyrics = newLyrics;
            } else {
                // Log once per track to avoid spam
                const logKey = this.getTrackKey();
                if (logKey !== this.lastNoLyricsLogHash) {
                    this.lastNoLyricsLogHash = logKey;
                    Logger.debug('[LearnerMode] No lyrics found');
                }
            }
        }

        // Use progressive display for word-by-word reveal (like whisper mode)
        const display = this.getSubtitleDisplay();
        const fullText = display.fullText;
        const progressiveText = display.displayText;

        if (!fullText) {
            // Don't clear between subtitle lines — keep last text visible
            // to avoid text → empty → text content shift.
            // Display is cleared on track change (line ~891) and disable.
            this.updateVisibility();
            return;
        }

        const targetLang = (Config.get('subtitleLang') || 'en').toLowerCase();
        const isCN = this.isChinese(fullText);

        // For Chinese subtitles, show JP translation as primary (never raw CN)
        let primaryText: string;
        let splitIdx = -1;
        let hlStart = -1;
        const karaokeEnabled = !!Config.get('karaokeMode');
        const segmentEnabled = !!Config.get('segmentMode');
        if (isCN) {
            const jaTranslation = TranslationService.peekCached(fullText, 'ja');
            primaryText = jaTranslation || fullText || '';
        } else if (karaokeEnabled) {
            // Karaoke ON: always show full text, control visibility via CSS
            primaryText = fullText;
            const words = display.activeLine?.words;
            let indices = { splitIdx: 0, hlStart: 0 };
            const karaokeTime = display.audioTime ?? display.now;
            if (Array.isArray(words) && words.length > 0 && karaokeTime != null) {
                indices = this.computeWordKaraokeIndices(fullText, words, karaokeTime);
            } else if (display.activeLine && karaokeTime != null) {
                indices = this.computeTimeFallbackKaraokeIndices(fullText, display.activeLine, karaokeTime);
            }
            splitIdx = indices.splitIdx;
            // Segment ON (fill-up): hlStart=0, all spoken text in accent
            // Segment OFF (spotlight): hlStart=word start, only current word in accent
            hlStart = segmentEnabled ? 0 : indices.hlStart;
        } else {
            primaryText = progressiveText;
        }

        // Update JP line
        if (primaryText && primaryText !== this.lastWhisperDisplayText) {
            this.updatePrimaryLine(primaryText, splitIdx, hlStart);
            this.lastWhisperDisplayText = primaryText;
        } else if (karaokeEnabled && (splitIdx >= 0 || hlStart >= 0)) {
            // Text unchanged but karaoke index may have advanced
            this.updatePrimaryLine(primaryText, splitIdx, hlStart);
        }

        // Update EN line with cached translation of full segment
        if (fullText !== this.lastText) {
            this.lastText = fullText;
            const cachedTranslation = TranslationService.peekCached(fullText, targetLang);
            this.updateSecondaryLine(cachedTranslation || progressiveText, !cachedTranslation);
            this.lastDisplayedText = fullText;

            const token = ++this.translationToken;

            // Fire async EN translation if not cached
            if (!cachedTranslation) {
                TranslationService.translate(fullText, targetLang).then(translated => {
                    if (translated && this.lastText === fullText && token === this.translationToken) {
                        this.updateSecondaryLine(translated, false);
                    }
                }).catch(() => { /* fire-and-forget: fallback text already shown */ });
            }

            // For CN text, fire async CN→JA translation for primary line
            if (isCN && !TranslationService.peekCached(fullText, 'ja')) {
                TranslationService.translate(fullText, 'ja').then(translated => {
                    if (translated && this.lastText === fullText && token === this.translationToken) {
                        this.updatePrimaryLine(translated);
                        this.lastWhisperDisplayText = translated;
                    }
                }).catch(() => { /* fire-and-forget: CN fallback already shown */ });
            }
        }

        this.updateVisibility();
    }

    /**
     * Throttle ticker translation requests: only fire once per unique text,
     * with a minimum gap between requests. Returns true if translation should proceed.
     */
    private shouldTickerTranslate(text: string): boolean {
        const now = Date.now();
        if (text === this.lastTickerTranslationText && now - this.lastTickerTranslationAt < this.TICKER_TRANSLATION_COOLDOWN_MS) {
            return false;
        }
        this.lastTickerTranslationText = text;
        this.lastTickerTranslationAt = now;
        return true;
    }

    /**
     * Update the secondary (EN) line directly.
     */
    private updateSecondaryLine(text: string, isFallback: boolean): void {
        for (const e of this.getEnEls()) {
            e.textContent = text;
            e.classList.toggle('blurred', this.isBlurEnabled && !!text);
            e.classList.toggle('translation-fallback', isFallback);
        }
    }

    private handleWhisperUpdate(payload: WhisperUpdatePayload): void {
        // P2 FIX: Always accept updates, let updateLyrics decide whether to show them
        if (!payload) return;

        this.whisperActive = true;
        this.whisperFromCache = !!(payload as { fromCache?: boolean }).fromCache;
        this.whisperLive = typeof (payload as { live?: boolean }).live === 'boolean'
            ? !!(payload as { live?: boolean }).live
            : false;
        this.whisperLeadSec = typeof (payload as { leadSec?: number }).leadSec === 'number'
            ? Math.max(0, (payload as { leadSec?: number }).leadSec as number)
            : this.whisperLeadSec;
        this.whisperText = payload.text || '';
        this.ensureWhisperTicker(this.whisperLive ? 80 : 200);
        if (Array.isArray(payload.segments) && payload.segments.length > 0) {
            const mapped = payload.segments.map((segment) => ({
                time: segment.start,
                endTime: segment.end,
                text: segment.text,
                words: segment.words,
            }));
            const newWhisperLines = splitSubtitleSegments(mapped);

            // Pre-translate whisper segments in background — but only for cached loads.
            // During live whisper, Whisper.translateNewSegments() handles delta translation
            // and fires whisper:segment-translated so updateLyrics() picks up cached results.
            if (!this.whisperLive && TranslationService.canPrefetch(newWhisperLines.length)) {
                this.preTranslateAll(newWhisperLines);
            }
            this.whisperLines = newWhisperLines;
            // Don't reset lastWhisperDisplayText here — let _updateWhisperDisplay()
            // naturally detect changes. Resetting forces re-renders that cause flashing
            // when paused and whisper reprocesses the same audio with slightly different output.
        }
        // Don't reset lastText either — let the natural dedup comparison handle it.

        // Immediately trigger display update — don't wait for next timeupdate event
        // This prevents progress events from overwriting before text is shown
        this.updateLyrics();
    }

    /**
     * Handle Whisper clear events - reset state on track change
     */
    private handleWhisperClear(): void {
        this.whisperActive = false;
        this.whisperText = '';
        this.whisperLines = [];
        this.whisperFromCache = false;
        this.whisperLive = false;
        this.whisperLeadSec = 0;
        this.lastWhisperDisplayText = '';
        this.clearWhisperTicker();
        this.lastText = '';
        this.lastDisplayedText = '';
        this.lastSecondaryShown = '';

        // Remove whisper-active class
        this.expanded?.classList.remove('whisper-active');

        this.clearDisplay();
        this.updateVisibility();
    }

    private ensureWhisperTicker(intervalMs = 80): void {
        if (this.whisperTickerId !== null && this.whisperTickerInterval === intervalMs) return;
        if (this.whisperTickerId !== null) {
            clearInterval(this.whisperTickerId);
        }
        this.whisperTickerInterval = intervalMs;
        this.whisperTickerId = window.setInterval(() => {
            if (this.whisperActive) this.updateLyrics();
        }, intervalMs);
    }

    private clearWhisperTicker(): void {
        if (this.whisperTickerId === null) return;
        clearInterval(this.whisperTickerId);
        this.whisperTickerId = null;
        this.whisperTickerInterval = 80;
    }

    private findLyricsSource(): Record<string, unknown>[] | null {
        const source = findLyricsSourceUtil(this.bridge.store?.state?.AudioPlayer, document);
        if (source && source.length > 0) {
            Logger.debug('[LearnerMode] Found lyrics source', source.length);
            return source as Record<string, unknown>[];
        }
        return null;
    }

    /**
     * Fetch subtitles for the current track.
     * Priority:
     * 1. track.availableLyrics[] - VTT files embedded in track metadata
     * 2. /api/media/check-lrc API - LRC files on server
     */
    private async fetchLrcForCurrentTrack(): Promise<void> {
        const track = this.bridge.currentTrack;
        if (!track) return;

        const trackHash = track.hash || track.src || track.mediaStreamUrl || '';
        if (!trackHash || trackHash === this.lastLrcTrackHash) {
            return; // Already fetched successfully for this track
        }

        // Skip if we already tried this track and it had no lyrics
        if (this.lrcFetchAttemptedHashes.has(trackHash)) return;

        // Deduplicate concurrent calls — reuse in-flight promise
        if (this.lrcFetchPromise) return this.lrcFetchPromise;

        // Timeout prevents a hung request from blocking all future LRC fetches
        const timeout = new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('LRC fetch timeout')), 15_000)
        );
        this.lrcFetchPromise = Promise.race([
            this._fetchLrcForCurrentTrackInner(track, trackHash),
            timeout,
        ]).catch(err => {
            Logger.warn('[LearnerMode] LRC fetch failed/timed out:', err);
        }).finally(() => { this.lrcFetchPromise = null; });

        return this.lrcFetchPromise;
    }

    private async _fetchLrcForCurrentTrackInner(track: PlayerTrack, trackHash: string): Promise<void> {
        Logger.debug('[LearnerMode] fetchLrcForCurrentTrack:', track.title || track.hash || 'unknown');

        let fetched = false;

        // Priority 1: Check for availableLyrics on the track (VTT/LRC files)
        // PlayerTrack.availableLyrics contains subtitle files with mediaStreamUrl
        // Note: availableLyrics may contain files for ALL tracks in the work,
        // so we first try to find the one matching our track title.
        if (track.availableLyrics && track.availableLyrics.length > 0) {
            Logger.debug(`[LearnerMode] Found ${track.availableLyrics.length} availableLyrics on track`);

            // Strip extension from track title for matching
            const trackTitle = (track.title || '').replace(/\.[^.]+$/, '');

            // Try exact match first, then fall back to iterating all
            const sorted = [...track.availableLyrics].sort((a, b) => {
                const aTitle = (a.title || '').replace(/\.[^.]+$/, '');
                const bTitle = (b.title || '').replace(/\.[^.]+$/, '');
                const aMatch = trackTitle && aTitle === trackTitle ? 0 : 1;
                const bMatch = trackTitle && bTitle === trackTitle ? 0 : 1;
                return aMatch - bMatch;
            });

            for (const lyricFile of sorted) {
                const url = lyricFile.mediaStreamUrl;
                if (!url) continue;
                Logger.debug(`[LearnerMode] Trying to fetch subtitle from: ${lyricFile.title || url}`);
                try {
                    fetched = await this.fetchSubtitleFromUrl(url);
                    if (fetched) break;
                } catch (err) {
                    Logger.error('[LearnerMode] Error fetching subtitle:', err);
                }
            }
        }

        // Priority 2: Try /api/media/check-lrc API
        if (!fetched) {
            const workId = this.bridge.currentWorkId;
            if (!workId) {
                Logger.debug('[LearnerMode] No work ID, skipping LRC API fetch');
            } else {
                // Find track index in queue
                const queue = this.bridge.queue;
                const trackIndex = queue.findIndex(t =>
                    t.hash === track.hash || t.mediaStreamUrl === track.mediaStreamUrl || t.src === track.src
                );

                const candidateIndices = new Set<number>();
                if (trackIndex >= 0) candidateIndices.add(trackIndex);
                const fallbackIndex = this.bridge.queueIndex;
                if (Number.isFinite(fallbackIndex) && fallbackIndex >= 0) candidateIndices.add(fallbackIndex);

                if (candidateIndices.size === 0) {
                    Logger.debug('[LearnerMode] Track not found in queue, trying hash-based fetch');
                    fetched = await this.fetchLrcByHash(trackHash);
                } else {
                    for (const idx of candidateIndices) {
                        Logger.debug(`[LearnerMode] Fetching LRC for work ${workId}, track ${idx}...`);
                        try {
                            // Step 1: Check if LRC exists
                            const checkUrl = `/api/media/check-lrc/${workId}/${idx}`;
                            const checkRes = await this.bridge.axios.get<{ result: boolean; hash?: string; message?: string }>(checkUrl);

                            if (!checkRes.data.result || !checkRes.data.hash) {
                                Logger.debug(`[LearnerMode] No LRC file available for track ${idx}`);
                                continue;
                            }

                            const lrcHash = checkRes.data.hash;
                            Logger.debug(`[LearnerMode] LRC found with hash: ${lrcHash}`);

                            // Step 2: Fetch the LRC content
                            fetched = await this.fetchLrcByHash(lrcHash);
                            if (fetched) break;
                        } catch (err) {
                            Logger.debug('[LearnerMode] Error fetching LRC:', err);
                        }
                    }
                }
            }
        }

        if (fetched) {
            this.lastLrcTrackHash = trackHash;
        }
        // Mark as attempted regardless of success, to prevent re-fetching
        this.lrcFetchAttemptedHashes.add(trackHash);
    }

    /**
     * Fetch subtitle content from a URL and parse it (supports VTT and LRC formats).
     */
    private async fetchSubtitleFromUrl(url: string): Promise<boolean> {
        try {
            const res = await this.bridge.axios.get<string>(url, {
                responseType: 'text'
            });

            const content = typeof res.data === 'string' ? res.data : String(res.data);
            if (!content) {
                Logger.debug('[LearnerMode] Empty subtitle content');
                return false;
            }

            Logger.debug(`[LearnerMode] Fetched subtitle content (${content.length} chars)`);

            const lyrics = parseSubtitleContent(content);

            if (lyrics.length > 0) {
                Logger.debug(`[LearnerMode] Parsed ${lyrics.length} cues from subtitle file`);
                // Set lastTrackKey FIRST to prevent updateLyrics() from clearing our lyrics
                const trackKey = this.getTrackKey();
                if (trackKey) this.lastTrackKey = trackKey;
                this.currentLyrics = lyrics;
                this.preTranslateAll(lyrics);
                this.updateLyrics();
                return true;
            }
        } catch (err) {
            Logger.error('[LearnerMode] Error fetching subtitle:', err);
        }
        return false;
    }

    /**
     * Fetch LRC content by hash and parse it into lyrics.
     */
    private async fetchLrcByHash(hash: string): Promise<boolean> {
        try {
            const streamUrl = `/api/media/stream/${hash}`;
            const res = await this.bridge.axios.get<string>(streamUrl, {
                responseType: 'text'
            });

            const lrcContent = typeof res.data === 'string' ? res.data : String(res.data);
            if (!lrcContent) {
                Logger.debug('[LearnerMode] Empty LRC content');
                return false;
            }

            Logger.debug(`[LearnerMode] Fetched LRC content (${lrcContent.length} chars)`);

            // Parse LRC format
            const lyrics = parseLrcContent(lrcContent);
            if (lyrics.length > 0) {
                Logger.debug(`[LearnerMode] Parsed ${lyrics.length} lines from LRC file`);
                // Set lastTrackKey FIRST to prevent updateLyrics() from clearing our lyrics
                const trackKey = this.getTrackKey();
                if (trackKey) this.lastTrackKey = trackKey;
                this.currentLyrics = lyrics;
                this.preTranslateAll(lyrics);
                this.updateLyrics();
                return true;
            }

        } catch (err) {
            Logger.debug('[LearnerMode] Error fetching LRC by hash:', err);
        }
        return false;
    }

    /**
     * Pre-translate all lyrics in the background so navigation is instant.
     * buffered: Translates the first batch (e.g. 50 lines) with high priority,
     * then queues the rest to run in the background.
     */
    private preTranslateAll(lyrics: { time: number; text: string }[]): void {
        if (lyrics.length === 0) return;

        const targetLang = (Config.get('subtitleLang') || 'en').toLowerCase();
        const texts = lyrics.map(l => l.text?.trim()).filter(Boolean);
        if (texts.length === 0) return;
        if (!TranslationService.canPrefetch(texts.length)) return;

        // Filter out already-cached translations to avoid redundant worker requests
        const uncachedTexts = texts.filter(t => !TranslationService.peekCached(t, targetLang));
        if (uncachedTexts.length === 0) return;

        // Dedup key based on uncached content (not total count, which changes every append)
        const first = uncachedTexts[0] || '';
        const last = uncachedTexts[uncachedTexts.length - 1] || '';
        const key = `${uncachedTexts.length}:${first.slice(0, 20)}:${last.slice(0, 20)}`;

        if (key === this.lastPreTranslatedKey) return;
        this.lastPreTranslatedKey = key;

        Logger.debug(`[LearnerMode] Pre-translating ${uncachedTexts.length}/${texts.length} uncached lines...`);

        const PRIORITY_BATCH_SIZE = 50;
        const initialBatch = uncachedTexts.slice(0, PRIORITY_BATCH_SIZE);
        const backgroundBatch = uncachedTexts.slice(PRIORITY_BATCH_SIZE);

        const processBatch = (batch: string[], priority: string) => {
            if (batch.length === 0) return;

            // Separate CN and non-CN texts, filtering cached at batch time too
            const cnTexts: string[] = [];
            const allTexts: string[] = [];

            for (const text of batch) {
                const isCN = this.isChinese(text);

                if (isCN && !TranslationService.peekCached(text, 'ja')) {
                    cnTexts.push(text);
                }
                if (!TranslationService.peekCached(text, targetLang)) {
                    allTexts.push(text);
                }
            }

            // Translate CN→JA (for primary display support)
            if (cnTexts.length > 0) {
                Logger.debug(`[LearnerMode] Buffering ${priority} CN->JA batch (${cnTexts.length} lines)`);
                TranslationService.translateBatch(cnTexts, 'ja')
                    .catch((err) => { Logger.warn(`[LearnerMode] CN->JA ${priority} batch failed:`, err); });
            }

            // Translate all→target
            if (targetLang !== 'ja' && allTexts.length > 0) {
                Logger.debug(`[LearnerMode] Buffering ${priority} ->${targetLang} batch (${allTexts.length} lines)`);
                TranslationService.translateBatch(allTexts, targetLang)
                    .catch((err) => { Logger.warn(`[LearnerMode] ->${targetLang} ${priority} batch failed:`, err); });
            }
        };

        // 1. Process initial batch immediately
        processBatch(initialBatch, 'initial');

        // 2. Queue background batch (if any)
        if (backgroundBatch.length > 0) {
            setTimeout(() => {
                processBatch(backgroundBatch, 'background');
            }, 200); // Brief delay to let initial batch start on worker
        }
    }

    private async displaySubtitle(
        text: string,
        secondaryOverride?: string,
        options?: { skipPrimary?: boolean }
    ) {
        if (!text) {
            return;
        }

        const isCN = this.isChinese(text);
        const skipPrimary = options?.skipPrimary === true;
        const target = (Config.get('subtitleLang') || 'en').toLowerCase();

        // For Chinese text, use JP translation as primary line (for JP learners)
        let primary = text;
        if (isCN) {
            const jaTranslation = TranslationService.peekCached(text, 'ja');
            if (jaTranslation) primary = jaTranslation;
        }
        let secondary = '';
        let fallbackUsed = false;

        // Check cache first for instant display
        if (secondaryOverride) {
            secondary = secondaryOverride;
        } else if (isCN && target.startsWith('zh')) {
            secondary = text;
        } else if (!isCN && target === 'ja') {
            secondary = text;
        } else {
            // Check cache for instant display
            const cached = TranslationService.peekCached(text, target);
            if (cached) {
                secondary = cached;
            } else {
                // No cache - use primary as fallback for now
                secondary = primary;
                fallbackUsed = true;
            }
        }

        // Update DOM immediately with what we have
        this.ensureUIInjected();

        if (!skipPrimary) {
            for (const e of this.getJpEls()) e.textContent = primary;
        }
        for (const e of this.getEnEls()) {
            e.textContent = secondary;
            e.classList.toggle('blurred', this.isBlurEnabled && !!secondary);
            e.classList.toggle('translation-fallback', fallbackUsed);
        }

        this.lastDisplayedText = text;
        document.querySelectorAll('.learner-subs-expanded').forEach(el => {
            (el as HTMLElement).style.visibility = '';
        });
        this.updateVisibility();
        this.updateStyle();

        // ASYNC UPDATES: Fire translations if needed
        const needsSecondaryTranslation = fallbackUsed && !secondaryOverride;
        const needsPrimaryTranslation = isCN && primary === text; // JA not cached yet

        if (needsSecondaryTranslation || needsPrimaryTranslation) {
            const token = ++this.translationToken;

            if (needsSecondaryTranslation) {
                TranslationService.translate(text, target).then(translated => {
                    if (translated && this.lastDisplayedText === text && token === this.translationToken) {
                        for (const e of this.getEnEls()) {
                            e.textContent = translated;
                            e.classList.remove('translation-fallback');
                        }
                    }
                }).catch(() => { /* fire-and-forget: fallback already shown */ });
            }

            if (needsPrimaryTranslation) {
                TranslationService.translate(text, 'ja').then(translated => {
                    if (translated && this.lastDisplayedText === text && token === this.translationToken) {
                        for (const e of this.getJpEls()) e.textContent = translated;
                    }
                }).catch(() => { /* fire-and-forget: CN fallback already shown */ });
            }
        }
    }


    private updateVisibility() {
        // Toggle visibility based on player state (expanded/minimized) and content availability
        const isPlayerMinimized = !!this.bridge.store?.state?.AudioPlayer?.hide;
        const hasContent = !!this.lastDisplayedText || this.currentLyrics.length > 0 || this.whisperActive;

        // Expanded subs: Show ONLY if player is expanded (not hidden) AND we have content
        if (this.expanded) {
            const shouldShow = !isPlayerMinimized && hasContent;
            this.expanded.style.visibility = shouldShow ? '' : 'hidden';
            this.expanded.style.display = isPlayerMinimized ? 'none' : '';
        }

        // Collapsed subs: Show ONLY if player is minimized AND we have content
        if (this.collapsed) {
            const shouldShow = isPlayerMinimized && hasContent;
            this.collapsed.style.setProperty('display', shouldShow ? 'flex' : 'none', 'important');
        }
    }

    private updateStyle() {
        const showJP = !!Config.get('showJP');
        if (this.expanded) this.expanded.classList.toggle('hide-jp', !showJP);
        if (this.collapsed) this.collapsed.classList.toggle('hide-jp', !showJP);
        // Fix: target only the button element that contains the translate icon
        document.querySelectorAll('.learner-controls button, .learner-collapsed-controls button').forEach(btn => {
            const icon = btn.querySelector('i');
            if (icon && icon.textContent?.trim() === 'translate') {
                btn.classList.toggle('learner-btn-active', showJP);
            }
        });
    }

    private seek(offset: number) {
        const audio = getAudioElement();
        if (!audio) return;

        // Prefer whisperLines when whisper is active (currentLyrics may lag one tick behind)
        const lines = this.whisperActive && this.whisperLines.length > 0 ? this.whisperLines
            : this.currentLyrics.length > 0 ? this.currentLyrics
            : this.whisperLines;

        if (!lines.length) {
            audio.currentTime = Math.max(0, audio.currentTime + (offset * 5));
            return;
        }

        const now = audio.currentTime;
        const firstAfter = lines.findIndex(l => l.time > now);
        let idx: number;
        if (firstAfter === -1) {
            idx = lines.length - 1;
        } else if (firstAfter === 0) {
            idx = 0;
        } else {
            idx = firstAfter - 1;
        }
        const rawTarget = idx + offset;
        const targetIdx = Math.max(0, Math.min(lines.length - 1, rawTarget));
        // If clamped (no more segments in this direction), fall back to time-based seek
        if (targetIdx === idx && offset !== 0) {
            audio.currentTime = Math.max(0, audio.currentTime + offset * 5);
            if (audio.paused) audio.play().catch(err => Logger.warn('[LearnerMode] Audio play after seek failed:', err));
            return;
        }
        const target = lines[targetIdx];
        if (target) {
            audio.currentTime = target.time + 0.01;
            if (audio.paused) audio.play().catch(err => Logger.warn('[LearnerMode] Audio play after seek failed:', err));
            // Immediately pre-populate display to avoid blank flash
            this.lastText = '';
            this.lastDisplayedText = '';
            this.lastSecondaryShown = '';
            this.lastWhisperDisplayText = '';
            this.translationToken += 1;
            this.updateLyrics();
        }
    }

    /** CJK chars present but no Japanese kana → likely Chinese */
    private isChinese(text: string): boolean {
        return /[\u4e00-\u9fff]/.test(text) && !/[\u3040-\u309f\u30a0-\u30ff]/.test(text);
    }

    private clearDisplay(): void {
        for (const e of this.getJpEls()) e.textContent = '';
        for (const e of this.getEnEls()) e.textContent = '';
        this.lastDisplayedText = '';
        this.lastSecondaryShown = '';
        this.updateVisibility();
    }

    private cleanupInjected(): void {
        this.restoreControls();
        this.expanded?.remove();
        this.expanded = null;
        this.collapsed?.remove();
        this.collapsed = null;
        if (this.rafPlayerObserver) { cancelAnimationFrame(this.rafPlayerObserver); this.rafPlayerObserver = 0; }
        if (this.rafDrawerSync) { cancelAnimationFrame(this.rafDrawerSync); this.rafDrawerSync = 0; }
        this.playerObserver?.disconnect();
        this.playerObserver = null;
        this.clearWhisperTicker();
        if (this.seekedDebounceTimer) { clearTimeout(this.seekedDebounceTimer); this.seekedDebounceTimer = null; }
        if (this.boundAudio) {
            if (this.boundTimeHandler) this.boundAudio.removeEventListener('timeupdate', this.boundTimeHandler);
            this.boundAudio.removeEventListener('play', this.handleAudioPlay);
            this.boundAudio.removeEventListener('seeking', this.handleAudioSeeking);
            this.boundAudio.removeEventListener('seeked', this.handleAudioSeeked);
            this.boundAudio = null;
        }
        this.invalidateCachedEls();
        // collapsed subtitle container no longer exists; controls are cleaned up via class selector below
        document.querySelectorAll('.learner-controls, .learner-collapsed-controls').forEach(el => el.remove());

        // Reset active state in store
        AppStore.setLearnerState({ isActive: false });
    }

    private getTrackKey(): string | null {
        // Use the correct source: queue[queueIndex], not currentTrack
        const track = this.bridge.currentTrack;
        return track?.hash || track?.mediaStreamUrl || track?.src || track?.title || null;
    }

    private getActiveLyricText(): string {
        const domText = document.querySelector('#lyric')?.textContent?.trim() || '';
        if (domText) return domText;

        const player = this.bridge.store?.state?.AudioPlayer as ExtendedAudioPlayerState | undefined;
        const storeText = player?.currentLyric?.trim()
            || player?.currentLyricText?.trim()
            || player?.subtitle?.current?.trim()
            || player?.subtitle?.text?.trim()
            || '';
        if (storeText) return storeText;

        const cueText = this.getActiveCueText();
        if (cueText) return cueText;

        return this.getTextFromTimeline();
    }

    private getActiveCueText(): string {
        const audio = getAudioElement();
        if (!audio?.textTracks) return '';

        for (const track of Array.from(audio.textTracks)) {
            if (!track) continue;
            // Enable the track if it's disabled so we can get cues
            if (track.mode === 'disabled') {
                track.mode = 'hidden';
            }
            const cues = track.activeCues;
            if (!cues || cues.length === 0) continue;
            const cue = cues[0] as VTTCue;
            const text = (cue?.text || '').trim();
            if (text) return text;
        }
        return '';
    }

    /**
     * Extract all cues from audio textTracks and convert to lyrics format.
     * This handles VTT files loaded by the host player.
     */
    private getTextTracksAsLyrics(): Array<{ time: number; endTime?: number; text: string }> | null {
        const audio = getAudioElement();
        if (!audio) {
            Logger.debug('[LearnerMode] getTextTracksAsLyrics: No audio element');
            return null;
        }
        if (!audio.textTracks) {
            Logger.debug('[LearnerMode] getTextTracksAsLyrics: No textTracks on audio');
            return null;
        }

        Logger.debug(`[LearnerMode] getTextTracksAsLyrics: Found ${audio.textTracks.length} text tracks`);

        for (const track of Array.from(audio.textTracks)) {
            if (!track) continue;
            Logger.debug(`[LearnerMode] Text track: mode=${track.mode}, kind=${track.kind}, label=${track.label}`);

            // Enable the track if disabled
            if (track.mode === 'disabled') {
                track.mode = 'hidden';
            }

            const cues = track.cues;
            Logger.debug(`[LearnerMode] Track cues: ${cues?.length || 0}`);
            if (!cues || cues.length === 0) continue;

            const lyrics: Array<{ time: number; endTime?: number; text: string }> = [];
            for (let i = 0; i < cues.length; i++) {
                const cue = cues[i] as VTTCue;
                if (cue?.text) {
                    lyrics.push({
                        time: cue.startTime,
                        endTime: cue.endTime,
                        text: cue.text.trim()
                    });
                }
            }

            if (lyrics.length > 0) {
                Logger.debug(`[LearnerMode] Found ${lyrics.length} cues from audio textTracks`);
                return lyrics;
            }
        }
        return null;
    }

    private findActiveLine(
        lines: LyricLine[],
        now: number
    ): LyricLine | null {
        if (lines.length === 0) return null;

        let activeIdx = -1;
        for (let i = lines.length - 1; i >= 0; i--) {
            if (lines[i].time <= now) { activeIdx = i; break; }
        }

        if (activeIdx < 0) return null;
        const activeLine = lines[activeIdx];

        if (activeLine.endTime && now >= activeLine.endTime) {
            const nextLine = lines[activeIdx + 1];
            // No next line — hold the last segment visible (during live transcription
            // the worker hasn't caught up; at end of transcript it's the final line)
            if (!nextLine) return activeLine;
            // Short gap between existing segments — hold to prevent flash
            if ((nextLine.time - activeLine.endTime) < 2.0) return activeLine;
            // Long gap between existing segments — genuine silence
            return null;
        }

        return activeLine;
    }

    private getTextFromTimelineFor(
        lines: LyricLine[],
        leadSec = 0,
        progressive = false,
        appendWindowSec = 0,
        appendMaxChars = 0
    ): string {
        const audio = getAudioElement();
        if (!audio || lines.length === 0) return '';
        const now = audio.currentTime + Math.max(0, leadSec);

        // Optimization: Binary search for the current segment could be better for very long transcripts,
        // but simple linear scan from the end or just finding the last matching one is usually fine for typical track lengths.
        // We use findLast to get the most recent start time that is <= now.

        // Find the last segment that started before or at 'now'
        // This is O(N), but N is usually small (< 1000). For massive transcripts, binary search would be needed.
        const activeLine = this.findActiveLine(lines, now);
        if (!activeLine) return '';

        if (!activeLine.text) return '';
        if (progressive && activeLine.endTime && activeLine.endTime > activeLine.time) {
            return this.getProgressiveText(activeLine, now);
        }

        const base = activeLine.text.trim();
        if (!appendWindowSec || lines.length < 2) return base;
        const idx = lines.indexOf(activeLine);
        if (idx < 0 || idx >= lines.length - 1) return base;
        const next = lines[idx + 1];
        if (!next?.text) return base;
        const nextStart = next.time ?? 0;
        if (nextStart - now > appendWindowSec) return base;
        const combined = `${base} ${next.text.trim()}`.trim();
        if (appendMaxChars > 0 && combined.length > appendMaxChars) return base;
        return combined;
    }

    /** Adjust lead time for playback rate: at 2x, we need 2x audio-seconds of lead for the same real-world reaction time */
    private effectiveLead(baseLead: number): number {
        return baseLead * this.playbackRate;
    }

    private getTextFromTimeline(): string {
        return this.getTextFromTimelineFor(
            this.currentLyrics,
            this.effectiveLead(this.subtitleLeadSec),
            false,
            this.subtitleAppendWindowSec,
            this.subtitleAppendMaxChars
        );
    }

    private getWhisperTextFromTimeline(): string {
        return this.getTextFromTimelineFor(this.whisperLines, this.effectiveLead(this.whisperLeadSec), true);
    }

    private getWhisperDisplay(): { displayText: string; fullText: string; activeLine?: LyricLine; now?: number; audioTime?: number } {
        const audio = getAudioElement();
        if (!audio || this.whisperLines.length === 0) return { displayText: '', fullText: '' };
        const audioTime = audio.currentTime;
        const now = audioTime + Math.max(0, this.effectiveLead(this.whisperLeadSec));
        const activeLine = this.findActiveLine(this.whisperLines, now);
        if (!activeLine || !activeLine.text) return { displayText: '', fullText: '' };
        const fullText = activeLine.text.trim();
        const displayText = this.getProgressiveText(activeLine, now);
        return { displayText, fullText, activeLine, now, audioTime };
    }

    /**
     * Get progressive subtitle display for regular lyrics (VTT/LRC).
     * Returns both the progressive (word-by-word) text and the full segment text.
     */
    private getSubtitleDisplay(): { displayText: string; fullText: string; activeLine?: LyricLine; now?: number; audioTime?: number } {
        const audio = getAudioElement();
        if (!audio || this.currentLyrics.length === 0) return { displayText: '', fullText: '' };
        const audioTime = audio.currentTime;
        const now = audioTime + this.effectiveLead(this.subtitleLeadSec);
        const activeLine = this.findActiveLine(this.currentLyrics, now);
        if (!activeLine || !activeLine.text) return { displayText: '', fullText: '' };
        const fullText = activeLine.text.trim();
        // Always use progressive display for word-by-word reveal
        const displayText = this.getProgressiveText(activeLine, now);
        return { displayText, fullText, activeLine, now, audioTime };
    }

    private getProgressiveText(line: { time: number; endTime?: number; text: string }, now: number): string {
        const text = line.text?.trim() || '';
        if (!text || line.endTime == null) return text;
        // Segment mode: show full text immediately, no progressive reveal
        if (Config.get('segmentMode')) return text;
        const words = (line as { words?: Array<{ start: number; end: number; text: string }> }).words;
        if (Array.isArray(words) && words.length > 0) {
            // Trim leading spaces from Whisper word outputs (e.g., " hello" → "hello")
            const visible = words.filter((w) => w.start <= now + 0.01).map((w) => (w.text || '').trim()).filter(Boolean);
            if (visible.length === 0) return '';
            return /\s/.test(text) ? visible.join(' ') : visible.join('');
        }
        const duration = Math.max(0.05, line.endTime - line.time);
        const progress = Math.max(0, Math.min(1, (now - line.time) / duration));

        // Whitespace languages: reveal per word. CJK/emoji: reveal per character.
        if (/\s/.test(text)) {
            const words = text.split(/\s+/).filter(Boolean);
            const count = Math.max(1, Math.min(words.length, Math.ceil(progress * words.length)));
            return words.slice(0, count).join(' ');
        }

        const chars = Array.from(text);
        const count = Math.max(1, Math.min(chars.length, Math.ceil(progress * chars.length)));
        return chars.slice(0, count).join('');
    }

    /**
     * Update the primary (JP) line with optional karaoke highlighting.
     * When both splitIdx >= 0 AND hlStart >= 0:
     *   Segment ON (fill-up):  past="" | spoken 0..splitIdx (accent) | upcoming splitIdx..end (dim)
     *   Segment OFF (spotlight): past 0..hlStart (normal) | current hlStart..splitIdx (accent) | upcoming splitIdx..end (hidden)
     */
    private updatePrimaryLine(text: string, splitIdx = -1, hlStart = -1): void {
        const karaokeEnabled = !!Config.get('karaokeMode');
        const segmentEnabled = !!Config.get('segmentMode');

        // Trigger JPDB parsing (async, non-blocking)
        if (Config.get('enableJpdb') && Config.get('jpdbSubtitleFurigana') && Config.get('jpdbShowFurigana') && text && text !== this.lastJpdbText) {
            this.lastJpdbText = text;
            this.parseJpdbFurigana(text);
        } else if (!text) {
            this.jpdbTokens = null;
            this.lastJpdbText = '';
        }

        for (const e of this.getJpEls()) {
            const isCollapsed = !!e.closest('.learner-subs-collapsed');
            const prevText = e.textContent || '';
            if (karaokeEnabled && !isCollapsed && splitIdx >= 0 && hlStart >= 0 && text) {
                // 3-way: past (primary) | current word (accent) | upcoming (dim or hidden)
                const chars = Array.from(text);
                const past = chars.slice(0, hlStart).join('');
                const current = chars.slice(hlStart, splitIdx).join('');
                const upcoming = chars.slice(splitIdx).join('');
                e.textContent = '';
                const pastSpan = document.createElement('span');
                pastSpan.className = 'karaoke-past';
                pastSpan.textContent = past;
                const currentSpan = document.createElement('span');
                currentSpan.className = 'karaoke-spoken';
                currentSpan.textContent = current;
                const upcomingSpan = document.createElement('span');
                upcomingSpan.className = segmentEnabled ? 'karaoke-upcoming' : 'karaoke-upcoming karaoke-hidden';
                upcomingSpan.textContent = upcoming;
                e.appendChild(pastSpan);
                e.appendChild(currentSpan);
                e.appendChild(upcomingSpan);
            } else {
                e.textContent = text;
            }
            // Smooth fade-in when segment text changes (reduces content shift)
            if (text && prevText && text !== prevText) {
                e.classList.remove('segment-fade');
                void (e as HTMLElement).offsetWidth; // force reflow to restart animation
                e.classList.add('segment-fade');
            }
        }
    }

    // JPDB furigana state
    private jpdbTokens: import('../types/jpdb').JPDBToken[] | null = null;
    private lastJpdbText = '';

    private async parseJpdbFurigana(text: string): Promise<void> {
        try {
            const { JpdbService } = await import('../services/JpdbService');
            const tokens = await JpdbService.parseSingle(text);
            if (this.lastJpdbText === text) {
                this.jpdbTokens = tokens;
            }
        } catch {
            // Silently fail
        }
    }

    /** Compute word-level karaoke indices from word timings. */
    private computeWordKaraokeIndices(
        fullText: string,
        words: Array<{ start: number; end: number; text: string }>,
        now: number,
    ): { splitIdx: number; hlStart: number } {
        const hasSpaces = /\s/.test(fullText);
        let charOffset = 0;
        let hlStart = 0;
        let splitIdx = 0;
        let foundAny = false;
        for (let i = 0; i < words.length; i++) {
            const wText = (words[i].text || '').trim();
            const wChars = Array.from(wText).length;
            if (words[i].end <= now + 0.05) {
                hlStart = charOffset;
                splitIdx = charOffset + wChars;
                foundAny = true;
            }
            charOffset += wChars;
            if (hasSpaces && i < words.length - 1) charOffset += 1;
        }
        return foundAny ? { splitIdx, hlStart } : { splitIdx: 0, hlStart: 0 };
    }

    /** Fallback karaoke indices when no word timings are available. */
    private computeTimeFallbackKaraokeIndices(
        fullText: string,
        line: { time: number; endTime?: number },
        now: number,
    ): { splitIdx: number; hlStart: number } {
        if (!line.endTime) return { splitIdx: -1, hlStart: -1 };
        const duration = Math.max(0.05, line.endTime - line.time);
        const progress = Math.max(0, Math.min(1, (now - line.time) / duration));
        if (/\s/.test(fullText)) {
            const ws = fullText.split(/\s+/).filter(Boolean);
            const count = Math.max(1, Math.min(ws.length, Math.ceil(progress * ws.length)));
            const spoken = ws.slice(0, count).join(' ');
            const spokenChars = Array.from(spoken).length;
            const prevWords = ws.slice(0, count - 1);
            const prevLen = prevWords.length > 0 ? Array.from(prevWords.join(' ')).length + 1 : 0;
            return { splitIdx: spokenChars, hlStart: prevLen };
        }
        const chars = Array.from(fullText);
        const count = Math.max(1, Math.min(chars.length, Math.ceil(progress * chars.length)));
        return { splitIdx: count, hlStart: Math.max(0, count - 1) };
    }

    /** Lazily refresh cached .learner-jp / .learner-en references */
    private refreshCachedEls(): void {
        this.cachedJpEls = Array.from(document.querySelectorAll<HTMLElement>('.learner-jp'));
        this.cachedEnEls = Array.from(document.querySelectorAll<HTMLElement>('.learner-en'));
        this.cachedElsDirty = false;
    }

    private getJpEls(): HTMLElement[] {
        if (this.cachedElsDirty) this.refreshCachedEls();
        return this.cachedJpEls;
    }

    private getEnEls(): HTMLElement[] {
        if (this.cachedElsDirty) this.refreshCachedEls();
        return this.cachedEnEls;
    }

    private invalidateCachedEls(): void {
        this.cachedElsDirty = true;
    }
}
