import { I18n, SafeUtils, Logger, Config } from '../core/Utils';
import { EventBus } from '../core/EventBus';
import { PlaylistMode } from '../features/playlist';
import { PLAYER_BAR_SELECTOR } from '../core/DomUtils';
import { AppStore } from '../store/AppStore';

const INJECT_INTERVAL_MS = 5000; // Reduced frequency
const INJECT_DEBOUNCE_MS = 100;

export class SidebarMenu {
    private statusEl: HTMLElement | null = null;
    private rootEl: HTMLElement | null = null;
    private iconEl: HTMLElement | null = null;
    private miniToggleEl: HTMLElement | null = null;
    private intervalId: number | null = null;
    private onToggle: () => void;
    private observer: MutationObserver | null = null;
    private injectDebounceTimer: number | null = null;
    private isInjecting = false;

    // SFW Mode toggle
    private sfwRootEl: HTMLElement | null = null;
    private sfwStatusEl: HTMLElement | null = null;
    private sfwIconEl: HTMLElement | null = null;

    // Translate Mode toggle
    private translateRootEl: HTMLElement | null = null;
    private translateStatusEl: HTMLElement | null = null;
    private translateIconEl: HTMLElement | null = null;

    // Playlist controls (injected into the player bar)
    private playlistControlsEl: HTMLElement | null = null;
    private playlistPrevBtn: HTMLElement | null = null;
    private playlistNextBtn: HTMLElement | null = null;
    private playlistShuffleBtn: HTMLElement | null = null;
    private playlistLoopBtn: HTMLElement | null = null;
    private playlistProgressEl: HTMLElement | null = null;

    constructor(onToggle: () => void) {
        this.onToggle = onToggle;
    }

    public async enable(): Promise<void> {
        Logger.log('[SidebarMenu] Enabling...');
        await SafeUtils.waitForElement('.q-drawer--left .q-list, .q-drawer .q-list');

        // Setup a targeted observer on just the drawer, not the whole document
        this.setupObserver();

        // Use a less frequent interval as backup
        this.intervalId = window.setInterval(() => {
            this.scheduleInject();
        }, INJECT_INTERVAL_MS);

        this.inject();

        // Listen for radio toggle events
        EventBus.on('radio:toggle', (payload) => {
            this.updateRadioStatus(payload.isActive);
        });

        // Listen for playlist mode events
        EventBus.on('playlist:active', (payload) => {
            this.updatePlaylistStatus(payload.isActive, payload.workIds);
        });

        // Listen for playlist progress updates
        EventBus.on('playlist:progress', (payload) => {
            this.updatePlaylistProgress(payload.current, payload.total);
        });

        // Listen for shuffle toggle
        EventBus.on('playlist:shuffleToggled', (payload) => {
            this.updateShuffleButton(payload.enabled);
        });

        // Listen for loop toggle
        EventBus.on('playlist:loopToggled', (payload) => {
            this.updateLoopButton(payload.enabled);
        });

        Logger.log('[SidebarMenu] Enabled');
    }

    public disable(): void {
        const pageContainer = document.querySelector('.q-page-container') as HTMLElement | null;
        if (pageContainer) {
            pageContainer.style.paddingBottom = '';
        }
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
        if (this.intervalId !== null) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        if (this.injectDebounceTimer !== null) {
            clearTimeout(this.injectDebounceTimer);
            this.injectDebounceTimer = null;
        }
    }

    public updateRadioStatus(isActive: boolean): void {
        // Update sidebar toggle
        if (this.rootEl) {
            this.rootEl.classList.toggle('q-item--active', isActive);
            this.rootEl.classList.toggle('text-primary', isActive);
        }

        if (this.statusEl) {
            this.statusEl.textContent = isActive ? I18n.t('on') : I18n.t('off');
            this.statusEl.classList.toggle('asmr-accent', isActive);
        }
        if (this.iconEl) {
            this.iconEl.classList.toggle('asmr-accent', isActive);
        }

        // Update mini toggle in player bar
        if (this.miniToggleEl) {
            const icon = this.miniToggleEl.querySelector('.q-icon');
            if (icon) {
                icon.classList.toggle('asmr-accent', isActive);
            }
            this.miniToggleEl.title = `${I18n.t('radioMode')}: ${isActive ? I18n.t('on') : I18n.t('off')}`;
        }
    }

    public updateSfwStatus(isActive: boolean): void {
        if (this.sfwRootEl) {
            this.sfwRootEl.classList.toggle('q-item--active', isActive);
            this.sfwRootEl.classList.toggle('text-primary', isActive);
        }
        if (this.sfwStatusEl) {
            this.sfwStatusEl.textContent = isActive ? I18n.t('on') : I18n.t('off');
            this.sfwStatusEl.classList.toggle('asmr-accent', isActive);
        }
        if (this.sfwIconEl) {
            this.sfwIconEl.classList.toggle('asmr-accent', isActive);
        }
    }

    public updateTranslateStatus(isActive: boolean): void {
        if (this.translateRootEl) {
            this.translateRootEl.classList.toggle('q-item--active', isActive);
            this.translateRootEl.classList.toggle('text-primary', isActive);
        }
        if (this.translateStatusEl) {
            this.translateStatusEl.textContent = isActive ? I18n.t('on') : I18n.t('off');
            this.translateStatusEl.classList.toggle('asmr-accent', isActive);
        }
        if (this.translateIconEl) {
            this.translateIconEl.classList.toggle('asmr-accent', isActive);
        }
    }

    public updatePlaylistStatus(isActive: boolean, workIds?: string[]): void {
        // Hide the radio/playlist toggle button entirely when playlist is active
        // (auto-advance is assumed in playlist mode, no toggle needed)
        if (this.rootEl) {
            this.rootEl.style.display = isActive ? 'none' : '';
        }

        // Show/hide playlist controls in the player bar
        if (isActive) {
            this.ensurePlaylistControls();
            // Update progress immediately if workIds provided
            if (workIds && workIds.length > 0) {
                this.updatePlaylistProgress(1, workIds.length);
            }
            // P5: Adjust page container to prevent overlap
            const pageContainer = document.querySelector('.q-page-container') as HTMLElement | null;
            if (pageContainer) {
                pageContainer.style.paddingBottom = 'calc(var(--q-footer-height, 64px) + 40px)';
            }
        } else {
            const pageContainer = document.querySelector('.q-page-container') as HTMLElement | null;
            if (pageContainer) {
                pageContainer.style.paddingBottom = '';
            }
        }
        if (this.playlistControlsEl) {
            this.playlistControlsEl.style.display = isActive ? 'flex' : 'none';
        }

        const sidebar = this.findSidebar();
        if (sidebar) {
            const playlistItem = Array.from(sidebar.querySelectorAll('a.q-item'))
                .find(el => el.getAttribute('href') === '/playlists');

            if (playlistItem) {
                if (isActive) {
                    playlistItem.classList.add('q-item--active', 'text-primary');
                } else {
                    playlistItem.classList.remove('q-item--active', 'text-primary');
                }
            }
        }
    }

    public updatePlaylistProgress(current: number, total: number): void {
        if (this.playlistProgressEl) {
            this.playlistProgressEl.textContent = `${current} / ${total}`;
        }

        const loop = Config.get('loopPlaylist');
        const shuffle = Config.get('shuffle');

        // Update button states
        // When loop or shuffle is on, prev/next are never disabled
        if (this.playlistPrevBtn) {
            const disabled = !loop && !shuffle && current <= 1;
            (this.playlistPrevBtn as HTMLButtonElement).disabled = disabled;
            this.playlistPrevBtn.classList.toggle('disabled', disabled);
        }
        if (this.playlistNextBtn) {
            const disabled = !loop && !shuffle && current >= total;
            (this.playlistNextBtn as HTMLButtonElement).disabled = disabled;
            this.playlistNextBtn.classList.toggle('disabled', disabled);
        }
    }

    public updateShuffleButton(isActive: boolean): void {
        if (this.playlistShuffleBtn) {
            this.playlistShuffleBtn.classList.toggle('asmr-playlist-shuffle-active', isActive);
        }
    }

    public updateLoopButton(isActive: boolean): void {
        if (this.playlistLoopBtn) {
            this.playlistLoopBtn.classList.toggle('asmr-playlist-loop-active', isActive);
        }
    }

    /**
     * Inject playlist controls into the player bar (footer).
     * Controls appear next to the existing player transport buttons.
     */
    private ensurePlaylistControls(): void {
        if (this.playlistControlsEl && this.playlistControlsEl.isConnected) return;

        // Remove any stale instances
        const existing = document.getElementById('asmr-playlist-controls');
        if (existing) existing.remove();

        // Find the player bar
        const playerBar = document.querySelector(PLAYER_BAR_SELECTOR);
        if (!playerBar) {
            Logger.warn('[SidebarMenu] Player bar not found, retrying in 1s');
            setTimeout(() => this.ensurePlaylistControls(), 1000);
            return;
        }

        const controlsContainer = document.createElement('div');
        controlsContainer.className = 'asmr-playlist-player-controls';
        controlsContainer.id = 'asmr-playlist-controls';

        controlsContainer.innerHTML = `
            <button class="asmr-playlist-player-btn asmr-playlist-prev" title="${I18n.t('playlistPrevWork')}" aria-label="${I18n.t('playlistPrevWork')}">
                <i class="material-icons" aria-hidden="true">skip_previous</i>
            </button>
            <span class="asmr-playlist-player-progress" aria-live="polite">1 / 1</span>
            <button class="asmr-playlist-player-btn asmr-playlist-next" title="${I18n.t('playlistNextWork')}" aria-label="${I18n.t('playlistNextWork')}">
                <i class="material-icons" aria-hidden="true">skip_next</i>
            </button>
            <button class="asmr-playlist-player-btn asmr-playlist-shuffle" title="${I18n.t('shuffle') || 'Shuffle'}" aria-label="${I18n.t('shuffle') || 'Shuffle'}">
                <i class="material-icons" aria-hidden="true">shuffle</i>
            </button>
            <button class="asmr-playlist-player-btn asmr-playlist-loop" title="${I18n.t('loopPlaylist') || 'Loop'}" aria-label="${I18n.t('loopPlaylist') || 'Loop'}">
                <i class="material-icons" aria-hidden="true">repeat</i>
            </button>
        `;

        // Insert at the beginning of the player bar so it appears on the left
        playerBar.insertBefore(controlsContainer, playerBar.firstChild);

        this.playlistControlsEl = controlsContainer;
        this.playlistPrevBtn = controlsContainer.querySelector('.asmr-playlist-prev');
        this.playlistNextBtn = controlsContainer.querySelector('.asmr-playlist-next');
        this.playlistShuffleBtn = controlsContainer.querySelector('.asmr-playlist-shuffle');
        this.playlistLoopBtn = controlsContainer.querySelector('.asmr-playlist-loop');
        this.playlistProgressEl = controlsContainer.querySelector('.asmr-playlist-player-progress');

        // P5: Adjust page container to prevent overlap
        const pageContainer = document.querySelector('.q-page-container') as HTMLElement | null;
        if (pageContainer) {
            pageContainer.style.paddingBottom = 'calc(var(--q-footer-height, 64px) + 40px)';
        }

        // Bind click handlers
        this.playlistPrevBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            const pm = PlaylistMode.getInstance();
            pm.previous();
        });

        this.playlistNextBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            const pm = PlaylistMode.getInstance();
            pm.next();
        });

        this.playlistShuffleBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            const pm = PlaylistMode.getInstance();
            pm.shuffle();
        });

        this.playlistLoopBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            const pm = PlaylistMode.getInstance();
            pm.toggleLoop();
        });

        // Initialize shuffle and loop button active states from config
        this.updateShuffleButton(Config.get('shuffle'));
        this.updateLoopButton(Config.get('loopPlaylist'));

        // Get current progress
        const pm = PlaylistMode.getInstance();
        if (pm.isActive) {
            const progress = pm.getProgress();
            this.updatePlaylistProgress(progress.current, progress.total);
        }

        Logger.log('[SidebarMenu] Playlist controls injected into player bar');
    }

    private injectSfwToggle(sidebar: HTMLElement): void {
        const existingSfw = document.getElementById('asmr-sfw-toggle');
        if (existingSfw && existingSfw.isConnected) {
            this.sfwRootEl = existingSfw;
            this.sfwStatusEl = existingSfw.querySelector('#asmr-sfw-status') as HTMLElement | null;
            this.sfwIconEl = existingSfw.querySelector('#asmr-sfw-icon') as HTMLElement | null;
            return;
        }

        const sfwEl = document.createElement('div');
        sfwEl.id = 'asmr-sfw-toggle';
        sfwEl.className = 'q-item q-item-type row no-wrap q-item--clickable q-link cursor-pointer';
        sfwEl.setAttribute('role', 'button');
        sfwEl.setAttribute('tabindex', '0');
        sfwEl.ariaLabel = I18n.t('sfwMode');
        sfwEl.innerHTML = `
            <div class="q-item__section column q-item__section--avatar q-item__section--side justify-center">
                <i class="q-icon notranslate material-icons" id="asmr-sfw-icon" aria-hidden="true">visibility_off</i>
            </div>
            <div class="q-item__section column q-item__section--main justify-center">
                <div class="q-item__label text-subtitle1">${I18n.t('sfwMode')}</div>
                <div class="q-item__label text-caption" id="asmr-sfw-status">${I18n.t('off')}</div>
            </div>
        `;

        const sfwHandler = () => {
            const current = AppStore.getConfig('sfwMode');
            AppStore.setConfig('sfwMode', !current);
            this.updateSfwStatus(!current);
        };
        sfwEl.addEventListener('click', sfwHandler);
        sfwEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                sfwHandler();
            }
        });
        sidebar.appendChild(sfwEl);

        this.sfwRootEl = sfwEl;
        this.sfwStatusEl = sfwEl.querySelector('#asmr-sfw-status') as HTMLElement | null;
        this.sfwIconEl = sfwEl.querySelector('#asmr-sfw-icon') as HTMLElement | null;

        // Sync initial state
        this.updateSfwStatus(AppStore.getConfig('sfwMode'));

        Logger.log('[SidebarMenu] SFW toggle injected');
    }

    private injectTranslateToggle(sidebar: HTMLElement): void {
        const existingTl = document.getElementById('asmr-translate-toggle');
        if (existingTl && existingTl.isConnected) {
            this.translateRootEl = existingTl;
            this.translateStatusEl = existingTl.querySelector('#asmr-translate-status') as HTMLElement | null;
            this.translateIconEl = existingTl.querySelector('#asmr-translate-icon') as HTMLElement | null;
            return;
        }

        const tlEl = document.createElement('div');
        tlEl.id = 'asmr-translate-toggle';
        tlEl.className = 'q-item q-item-type row no-wrap q-item--clickable q-link cursor-pointer';
        tlEl.setAttribute('role', 'button');
        tlEl.setAttribute('tabindex', '0');
        tlEl.ariaLabel = I18n.t('translateMode');
        tlEl.innerHTML = `
            <div class="q-item__section column q-item__section--avatar q-item__section--side justify-center">
                <i class="q-icon notranslate material-icons" id="asmr-translate-icon" aria-hidden="true">translate</i>
            </div>
            <div class="q-item__section column q-item__section--main justify-center">
                <div class="q-item__label text-subtitle1">${I18n.t('translateMode')}</div>
                <div class="q-item__label text-caption" id="asmr-translate-status">${I18n.t('off')}</div>
            </div>
        `;

        const tlHandler = () => {
            const current = AppStore.getConfig('translateMode');
            AppStore.setConfig('translateMode', !current);
            // Reload to apply/remove translations cleanly
            location.reload();
        };
        tlEl.addEventListener('click', tlHandler);
        tlEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                tlHandler();
            }
        });
        sidebar.appendChild(tlEl);

        this.translateRootEl = tlEl;
        this.translateStatusEl = tlEl.querySelector('#asmr-translate-status') as HTMLElement | null;
        this.translateIconEl = tlEl.querySelector('#asmr-translate-icon') as HTMLElement | null;

        // Sync initial state
        this.updateTranslateStatus(AppStore.getConfig('translateMode'));

        Logger.log('[SidebarMenu] Translate toggle injected');
    }

    private setupObserver(): void {
        if (this.observer) return;

        // broader selector for the drawer itself
        const drawerContainer = document.querySelector('.q-drawer--left') ||
            document.querySelector('.q-drawer') ||
            document.querySelector('.q-layout-drawer');

        if (!drawerContainer) {
            Logger.warn('[SidebarMenu] Could not find sidebar drawer for observer, relying on interval');
            return;
        }

        this.observer = new MutationObserver(() => {
            this.scheduleInject();
        });

        this.observer.observe(drawerContainer, {
            childList: true,
            subtree: true,
        });

        Logger.log('[SidebarMenu] Observer set up on:', drawerContainer.className);
    }

    private scheduleInject(): void {
        // Debounce inject calls to prevent rapid-fire
        if (this.injectDebounceTimer !== null) {
            return; // Already scheduled
        }

        this.injectDebounceTimer = window.setTimeout(() => {
            this.injectDebounceTimer = null;
            this.inject();
        }, INJECT_DEBOUNCE_MS);
    }

    private findSidebar(): HTMLElement | null {
        // Try multiple common Quasar selectors for the sidebar list
        return (document.querySelector('.q-drawer--left .q-list') ||
            document.querySelector('.q-drawer .q-list') ||
            document.querySelector('.q-drawer--left .q-scrollarea__content') || // Fallback to scroll area
            document.querySelector('.q-drawer')) as HTMLElement | null;
    }

    private inject(): void {
        // Prevent re-entrant inject
        if (this.isInjecting) return;
        this.isInjecting = true;

        try {
            const sidebar = this.findSidebar();
            if (!sidebar) return;

            const existing = document.getElementById('asmr-radio-toggle');
            if (existing && existing.isConnected) {
                this.rootEl = existing;
                this.statusEl = existing.querySelector('#asmr-radio-status') as HTMLElement | null;
                this.iconEl = existing.querySelector('#asmr-radio-icon') as HTMLElement | null;

                // Also re-attach SFW toggle references if present
                const existingSfw = document.getElementById('asmr-sfw-toggle');
                if (existingSfw && existingSfw.isConnected) {
                    this.sfwRootEl = existingSfw;
                    this.sfwStatusEl = existingSfw.querySelector('#asmr-sfw-status') as HTMLElement | null;
                    this.sfwIconEl = existingSfw.querySelector('#asmr-sfw-icon') as HTMLElement | null;
                }
                // Also re-attach Translate toggle references if present
                const existingTl = document.getElementById('asmr-translate-toggle');
                if (existingTl && existingTl.isConnected) {
                    this.translateRootEl = existingTl;
                    this.translateStatusEl = existingTl.querySelector('#asmr-translate-status') as HTMLElement | null;
                    this.translateIconEl = existingTl.querySelector('#asmr-translate-icon') as HTMLElement | null;
                }
                return;
            }

            const el = document.createElement('div');
            el.id = 'asmr-radio-toggle';
            el.className = 'q-item q-item-type row no-wrap q-item--clickable q-link cursor-pointer';
            el.setAttribute('role', 'button');
            el.setAttribute('tabindex', '0');
            el.ariaLabel = I18n.t('radioMode');
            el.innerHTML = `
                <div class="q-item__section column q-item__section--avatar q-item__section--side justify-center">
                    <i class="q-icon notranslate material-icons" id="asmr-radio-icon" aria-hidden="true">radio</i>
                </div>
                <div class="q-item__section column q-item__section--main justify-center">
                    <div class="q-item__label text-subtitle1">${I18n.t('radioMode')}</div>
                    <div class="q-item__label text-caption" id="asmr-radio-status">${I18n.t('off')}</div>
                    <div class="q-item__label text-caption text-primary hidden" id="asmr-playlist-status"></div>
                </div>
            `;
            const toggleHandler = () => this.onToggle();
            el.addEventListener('click', toggleHandler);
            el.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleHandler();
                }
            });
            sidebar.appendChild(el);

            this.rootEl = el;
            this.statusEl = el.querySelector('#asmr-radio-status') as HTMLElement | null;
            this.iconEl = el.querySelector('#asmr-radio-icon') as HTMLElement | null;

            Logger.log('[SidebarMenu] Radio toggle injected');

            // Inject SFW Mode toggle
            this.injectSfwToggle(sidebar);

            // Inject Translate Mode toggle
            this.injectTranslateToggle(sidebar);
        } finally {
            this.isInjecting = false;
        }
    }
}
