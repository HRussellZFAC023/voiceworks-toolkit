import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { EventBus } from '../core/EventBus';
import { Logger } from '../core/Utils';
import { TranslationService } from '../services/TranslationService';

export class PageTitleManager {
    private bridge: KikoeruBridge;
    private currentTitle: string | null = null;
    private observer: MutationObserver | null = null;
    private suffix = ' - ASMR Online';
    private cleanups: (() => void)[] = [];
    private titleUpdateEpoch = 0;

    constructor() {
        this.bridge = KikoeruBridge.getInstance();
    }

    public enable(): void {
        Logger.log('[PageTitleManager] Enabling...');

        // Listen for work and track changes
        this.cleanups.push(EventBus.on('work:change', ({ work }) => {
            if (work?.title) {
                this.updateTitle(work.title);
            }
        }));

        this.cleanups.push(EventBus.on('title:update', ({ title }) => {
            if (title) {
                this.updateTitle(title);
            }
        }));

        this.cleanups.push(EventBus.on('track:change', ({ track }) => {
            if (track?.title) {
                // When a track is playing, we might want to include the work title too
                const work = this.bridge.currentWork;
                const title = work ? `${track.title} | ${work.title}` : track.title;
                this.updateTitle(title);
            }
        }));

        // Watch route for navigation to non-work pages
        this.bridge.$watch?.('$route', (to: { path: string }) => {
            if (!to.path.startsWith('/work/')) {
                this.resetTitle();
            }
        });

        // Start guarding against "undefined"
        this.startTitleGuard();

        // Initial title check
        const work = this.bridge.currentWork;
        if (work?.title) {
            this.updateTitle(work.title);
        }
    }

    public disable(): void {
        this.cleanups.forEach(fn => fn());
        this.cleanups = [];
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
    }

    private async updateTitle(baseTitle: string) {
        if (!baseTitle || baseTitle === 'undefined') return;

        const epoch = ++this.titleUpdateEpoch;
        this.currentTitle = baseTitle;

        // Try to translate if it contains JP/CN characters and user's lang differs
        if (/[\u3040-\u30ff\u4e00-\u9faf]/.test(baseTitle) && !TranslationService.isUserLang(baseTitle)) {
            try {
                const translated = await TranslationService.translate(baseTitle);
                if (epoch !== this.titleUpdateEpoch) return;
                if (translated && translated !== baseTitle) {
                    this.applyTitle(translated);
                    return;
                }
            } catch (e) {
                Logger.warn('[PageTitleManager] Title translation failed', e);
                if (epoch !== this.titleUpdateEpoch) return;
            }
        }

        if (epoch !== this.titleUpdateEpoch) return;
        this.applyTitle(baseTitle);
    }

    private applyTitle(title: string) {
        const fullTitle = `${title}${this.suffix}`;
        if (document.title !== fullTitle) {
            // Temporarily stop observer to avoid self-triggering if we were using one on title tag
            // But usually document.title = x is fine.
            document.title = fullTitle;
            Logger.debug('[PageTitleManager] Applied title:', fullTitle);
        }
    }

    private resetTitle() {
        this.currentTitle = null;
        // Let the site handle its own titles on other pages, 
        // but we might still want to guard against "undefined"
    }

    private startTitleGuard() {
        const titleEl = document.querySelector('title');
        if (!titleEl) return;

        this.observer = new MutationObserver(() => {
            const title = document.title;
            if (title.includes('undefined')) {
                Logger.debug('[PageTitleManager] Detected "undefined" in title, fixing...');
                if (this.currentTitle) {
                    this.updateTitle(this.currentTitle);
                } else {
                    // Try to scrape from H1 before falling back to generic "ASMR"
                    const h1 = document.querySelector('h1.text-h6, .asmr-translated-title');
                    const scraped = h1?.textContent?.trim();
                    if (scraped && scraped !== 'undefined') {
                        this.updateTitle(scraped);
                    } else {
                        // Generic fix if we don't know the work title
                        document.title = title.replace('undefined', 'ASMR').replace(' - ASMR Online', '') + this.suffix;
                    }
                }
            }
        });

        this.observer.observe(titleEl, { childList: true });
    }
}
