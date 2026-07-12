import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { EventBus } from '../core/EventBus';
import { Logger } from '../core/Utils';
import { TranslationService } from '../services/TranslationService';
import type { TranslationSourceHint } from '../types/store';

export class PageTitleManager {
    private bridge: KikoeruBridge;
    private currentTitle: string | null = null;
    private currentSourceHint: TranslationSourceHint = 'auto';
    private appliedTitle: string | null = null;
    private observer: MutationObserver | null = null;
    private suffix = ' - ASMR Online';
    private cleanups: (() => void)[] = [];
    private titleUpdateEpoch = 0;
    private routeUnwatch: (() => void) | null = null;
    private routeRetryTimers: number[] = [];
    private enabled = false;

    constructor() {
        this.bridge = KikoeruBridge.getInstance();
    }

    public enable(): void {
        if (this.enabled) return;
        this.enabled = true;
        Logger.log('[PageTitleManager] Enabling...');

        // Listen for work and track changes
        this.cleanups.push(EventBus.on('work:change', ({ work }) => {
            if (work?.title) {
                this.updateTitle(work.title, this.getWorkSourceHint(work));
            }
        }));

        this.cleanups.push(EventBus.on('title:update', ({ title, sourceLanguageHint, translated }) => {
            if (title) {
                const target = TranslationService.getUiTargetLang();
                const targetHint: TranslationSourceHint = target === 'ja' || target === 'zh' || target === 'en'
                    ? target
                    : 'auto';
                this.updateTitle(
                    title,
                    translated
                        ? targetHint
                        : sourceLanguageHint ?? this.getWorkSourceHint(this.bridge.currentWork),
                );
            }
        }));

        this.cleanups.push(EventBus.on('track:change', ({ track }) => {
            if (track?.title) {
                // When a track is playing, we might want to include the work title too
                const work = this.bridge.currentWork;
                const title = work ? `${track.title} | ${work.title}` : track.title;
                this.updateTitle(title, this.getWorkSourceHint(work));
            }
        }));
        this.cleanups.push(EventBus.on('lang:change', () => {
            if (this.currentTitle) void this.updateTitle(this.currentTitle);
        }));
        this.cleanups.push(EventBus.on('config:change', ({ key }) => {
            if ((key === 'translateMode' || key === 'translateCnToJp') && this.currentTitle) {
                void this.updateTitle(this.currentTitle, this.currentSourceHint);
            }
        }));

        // Watch route for navigation to non-work pages
        this.routeUnwatch = this.bridge.$watch?.('$route', (to: { path: string }) => {
            if (!this.enabled) return;
            this.clearRouteRetryTimers();
            this.titleUpdateEpoch += 1;
            this.currentTitle = null;
            this.currentSourceHint = 'auto';
            this.appliedTitle = null;
            if (to.path.startsWith('/work/')) {
                this.scheduleWorkRouteRefresh(to.path);
            } else {
                this.resetTitle();
            }
        }) ?? null;

        // Start guarding against "undefined"
        this.startTitleGuard();

        // Initial title check
        const work = this.bridge.currentWork;
        if (work?.title) {
            this.updateTitle(work.title, this.getWorkSourceHint(work));
        }
    }

    public disable(): void {
        if (!this.enabled) return;
        this.enabled = false;
        this.titleUpdateEpoch += 1;
        this.currentTitle = null;
        this.currentSourceHint = 'auto';
        this.appliedTitle = null;
        this.cleanups.forEach(fn => fn());
        this.cleanups = [];
        this.routeUnwatch?.();
        this.routeUnwatch = null;
        this.clearRouteRetryTimers();
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
    }

    private async updateTitle(
        baseTitle: string,
        sourceLanguageHint: TranslationSourceHint = this.currentSourceHint,
    ) {
        if (!this.enabled || !baseTitle || baseTitle === 'undefined') return;

        const epoch = ++this.titleUpdateEpoch;
        this.currentTitle = baseTitle;
        this.currentSourceHint = sourceLanguageHint;

        // Try to translate if it contains JP/CN characters and user's lang differs
        const targetLang = TranslationService.getUiTargetLang();
        const containsCjk = /[\u3040-\u30ff\u4e00-\u9faf]/.test(baseTitle);
        const ambiguousHanForChinese = targetLang === 'zh'
            && /[\u4e00-\u9faf]/.test(baseTitle)
            && !/[\u3040-\u30ff]/.test(baseTitle);
        if (containsCjk && (ambiguousHanForChinese || !TranslationService.isUserLang(baseTitle))) {
            try {
                const display = await TranslationService.translateForDisplay(
                    baseTitle,
                    targetLang,
                    { sourceLanguageHint },
                );
                if (!this.enabled || epoch !== this.titleUpdateEpoch) return;
                if (display.primaryText !== baseTitle || display.secondaryText) {
                    const promotedChinese = display.sourceLanguage === 'zh' && display.primaryLanguage === 'ja';
                    const title = promotedChinese
                        ? (display.secondaryText
                            ? `${display.primaryText} — ${display.secondaryText}`
                            : display.primaryText)
                        : (display.secondaryText || display.primaryText);
                    this.applyTitle(title);
                    return;
                }
            } catch (e) {
                Logger.warn('[PageTitleManager] Title translation failed', e);
                if (!this.enabled || epoch !== this.titleUpdateEpoch) return;
            }
        }

        if (!this.enabled || epoch !== this.titleUpdateEpoch) return;
        this.applyTitle(baseTitle);
    }

    private applyTitle(title: string) {
        if (!this.enabled) return;
        const fullTitle = `${title}${this.suffix}`;
        this.appliedTitle = fullTitle;
        if (document.title !== fullTitle) {
            // Temporarily stop observer to avoid self-triggering if we were using one on title tag
            // But usually document.title = x is fine.
            document.title = fullTitle;
            Logger.debug('[PageTitleManager] Applied title:', fullTitle);
        }
    }

    private resetTitle() {
        this.currentTitle = null;
        this.currentSourceHint = 'auto';
        this.appliedTitle = null;
        // Let the site handle its own titles on other pages, 
        // but we might still want to guard against "undefined"
    }

    private clearRouteRetryTimers(): void {
        this.routeRetryTimers.forEach((timer) => clearTimeout(timer));
        this.routeRetryTimers = [];
    }

    private scheduleWorkRouteRefresh(path: string): void {
        const refresh = () => {
            if (!this.enabled || this.bridge.route?.path !== path) return;
            const routeId = this.normalizeWorkId(path.split('/').filter(Boolean).pop() || '');
            const work = this.bridge.currentWork as unknown as Record<string, unknown> | null;
            const workId = this.normalizeWorkId(String(work?.id ?? work?.source_id ?? work?.sourceId ?? ''));
            const workTitle = routeId && routeId === workId && typeof work?.title === 'string'
                ? work.title.trim()
                : '';
            const domTitle = document.querySelector<HTMLElement>(
                '#mainContent h1.text-h6:not(.asmr-translated-title), h1.text-h6:not(.asmr-translated-title)',
            )?.textContent?.trim() || '';
            const candidate = workTitle || domTitle;
            if (candidate && candidate !== 'undefined') {
                void this.updateTitle(candidate, workTitle ? this.getWorkSourceHint(this.bridge.currentWork) : 'auto');
            }
        };

        refresh();
        for (const delay of [200, 500, 1000, 2000]) {
            this.routeRetryTimers.push(window.setTimeout(refresh, delay));
        }
    }

    private normalizeWorkId(value: string): string {
        const digits = value.toUpperCase().replace(/^RJ/, '').replace(/\D/g, '');
        return digits.replace(/^0+/, '') || digits;
    }

    private getWorkSourceHint(work: unknown): TranslationSourceHint {
        const typed = work as { translation_info?: { lang?: string | null; is_original?: boolean } } | null | undefined;
        const lang = String(typed?.translation_info?.lang || '').toUpperCase();
        if (lang.includes('CHI') || lang.includes('ZH')) return 'zh';
        if (lang.includes('JPN') || lang.includes('JA')) return 'ja';
        if (lang.includes('ENG') || lang.includes('EN')) return 'en';
        if (typed?.translation_info?.is_original) return 'ja';
        return 'auto';
    }

    private startTitleGuard() {
        const titleEl = document.querySelector('title');
        if (!titleEl) return;

        this.observer = new MutationObserver(() => {
            if (!this.enabled) return;
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
                return;
            }

            // Vue can overwrite the translated title after a delayed host
            // render. Re-apply the latest source through the translation path
            // instead of leaving the browser tab permanently stale.
            if (this.currentTitle && this.appliedTitle && title !== this.appliedTitle) {
                void this.updateTitle(this.currentTitle);
            }
        });

        this.observer.observe(titleEl, { childList: true });
    }
}
