import { CentralObserver } from '../core/CentralObserver';
import { TranslationService } from '../services/TranslationService';
import { I18n } from '../core/Utils';
import { PLAYER_BAR_SELECTOR, isChinese } from '../core/DomUtils';
import { AppStore } from '../store/AppStore';
import { EventBus } from '../core/EventBus';

export class PlayerTranslator {
    private trackChangeCleanup?: () => void;
    private workChangeCleanup?: () => void;
    private _enabled = false;
    private retryTimers: ReturnType<typeof setTimeout>[] = [];
    /** Incremented on every track/work change to invalidate stale async callbacks */
    private _epoch = 0;

    public enable(): void {
        if (this._enabled) return;
        this._enabled = true;
        // Register with central observer instead of own MutationObserver
        CentralObserver.register('PlayerTranslator', () => this.checkPlayer(), 500);

        // Translate immediately on track change instead of waiting for observer debounce
        this.trackChangeCleanup = EventBus.on('track:change', ({ track }) => {
            this.onTrackOrWorkChange(track?.title || '');
        });

        // Also re-translate when the work itself changes (different RJ code)
        this.workChangeCleanup = EventBus.on('work:change', () => {
            this.onTrackOrWorkChange(this.getCurrentTrackTitle());
        });
    }

    public disable(): void {
        this._enabled = false;
        CentralObserver.unregister('PlayerTranslator');
        this.trackChangeCleanup?.();
        this.trackChangeCleanup = undefined;
        this.workChangeCleanup?.();
        this.workChangeCleanup = undefined;
        this.clearRetryTimers();
    }

    /**
     * Handle track or work change: clear stale translation state and
     * schedule multiple retry attempts to catch Vue re-renders.
     */
    private onTrackOrWorkChange(nextTrackTitle = ''): void {
        this._epoch++;
        this.clearRetryTimers();
        // Clear stale translation attrs so the old translation doesn't cause
        // early-return in translateTrackName/translateElement when Vue hasn't
        // re-rendered the new title yet (rawText still === old translated text).
        // Also restore original text on elements we replaced.
        this.resetTranslationState();
        // Some host renders don't replace our injected spans reliably.
        // Seed the active title node with the fresh track title so translation
        // always runs against current content after a track change.
        if (nextTrackTitle) {
            this.seedTrackTitle(nextTrackTitle);
        }
        // Multiple attempts: Vue re-renders asynchronously and may take varying time.
        // rAF catches immediate renders, 200ms/500ms/1000ms catch slower transitions.
        requestAnimationFrame(() => this.checkPlayer());
        for (const delay of [200, 500, 1000]) {
            this.retryTimers.push(setTimeout(() => this.checkPlayer(), delay));
        }
    }

    private clearRetryTimers(): void {
        for (const t of this.retryTimers) clearTimeout(t);
        this.retryTimers = [];
    }

    /**
     * Clear stale data-asmr-* attributes from player title elements and
     * restore original text where we replaced it with our translation.
     * Called on track:change and work:change so that the early-return checks in
     * translateTrackName/translateElement don't match stale data, and so that
     * the CJK detection check sees the original text (not our English translation).
     */
    private resetTranslationState(): void {
        const playerBar = document.querySelector(PLAYER_BAR_SELECTOR + ', .audio-player');
        if (!playerBar) return;

        const els = playerBar.querySelectorAll<HTMLElement>('[data-asmr-translated]');
        for (const el of els) {
            const source = el.dataset.asmrSource;
            // Only restore source text if our translation spans are still in the DOM,
            // meaning Vue hasn't re-rendered the element yet. Vue's component render
            // watcher (lower ID) flushes before our store.watch watcher (higher ID),
            // so by the time this runs Vue has usually already set textContent to the
            // new track name. Overwriting it with the old source caused the stale-title bug.
            if (source && el.querySelector('.asmr-translation-original')) {
                el.textContent = source;
            }
            el.title = '';
            el.classList.remove('asmr-translation-pair');
            delete el.dataset.asmrTranslated;
            delete el.dataset.asmrSource;
            delete el.dataset.asmrTranslatedText;
        }
    }

    private async checkPlayer() {
        const translateMode = !!AppStore.getConfig('translateMode');
        const cnToJp = !!AppStore.getConfig('translateCnToJp');
        if (!translateMode && !cnToJp) return;
        const playerBar = document.querySelector(PLAYER_BAR_SELECTOR + ', .audio-player');
        if (!playerBar) return;

        const cnOnlyMode = !translateMode && cnToJp;
        const titleEl = playerBar.querySelector('.q-toolbar__title, .text-h6, .text-weight-bold.text-body1') as HTMLElement;
        const artistEl = playerBar.querySelector('.text-subtitle2, .text-caption, .text-grey-5') as HTMLElement;
        const trackNameEl = this.findTrackNameElement(playerBar);

        // Run all translations concurrently instead of sequentially
        const tasks: Promise<void>[] = [];
        if (titleEl) tasks.push(this.translateElement(titleEl, 'title', cnOnlyMode));
        if (artistEl) tasks.push(this.translateElement(artistEl, 'artist', cnOnlyMode));
        if (trackNameEl) tasks.push(this.translateTrackName(trackNameEl, cnOnlyMode));
        await Promise.all(tasks);
    }

    /**
     * Resolve the active track title element inside the player.
     *
     * The player can contain many .ellipsis-2-lines nodes (queue rows, cards, etc).
     * Picking the first match causes stale translations on track change when that
     * element is not the now-playing title. Use a score-based pick instead.
     */
    private findTrackNameElement(playerBar: Element): HTMLElement | null {
        const candidates = Array.from(playerBar.querySelectorAll<HTMLElement>('.ellipsis-2-lines'));
        if (candidates.length === 0) return null;

        const currentTrackTitle = this.getCurrentTrackTitle();
        let bestEl: HTMLElement | null = null;
        let bestScore = Number.NEGATIVE_INFINITY;

        for (const el of candidates) {
            let score = 0;
            const rawText = el.textContent?.trim() || '';
            const source = el.dataset.asmrSource?.trim() || '';
            const translated = el.dataset.asmrTranslatedText?.trim() || '';

            // Prefer the dedicated now-playing title block in the player card.
            if (el.classList.contains('text-bold')) score += 50;
            if (el.classList.contains('q-pb-xs')) score += 40;
            if (!el.closest('.q-item')) score += 20;

            // Prefer exact match against current track title from host state.
            if (currentTrackTitle) {
                if (rawText === currentTrackTitle || source === currentTrackTitle) {
                    score += 120;
                } else if (
                    rawText.includes(currentTrackTitle) ||
                    source.includes(currentTrackTitle) ||
                    (source && currentTrackTitle.includes(source))
                ) {
                    score += 70;
                }
            }

            // If this node currently contains a translation pair, keep it sticky
            // unless another candidate clearly scores higher for the new track.
            if (el.dataset.asmrTranslated === 'true' && source && translated) score += 10;

            if (score > bestScore) {
                bestScore = score;
                bestEl = el;
            }
        }

        return bestEl;
    }

    private getCurrentTrackTitle(): string {
        try {
            return (AppStore.currentTrack?.title || '').trim();
        } catch {
            return '';
        }
    }

    private seedTrackTitle(nextTrackTitle: string): void {
        const playerBar = document.querySelector(PLAYER_BAR_SELECTOR + ', .audio-player');
        if (!playerBar) return;

        const el = this.findTrackNameElement(playerBar);
        if (!el) return;

        const rawText = el.textContent?.trim() || '';
        if (!rawText || rawText === nextTrackTitle) return;

        el.textContent = nextTrackTitle;
        el.title = '';
    }

    private async translateElement(el: HTMLElement, _type: 'title' | 'artist', cnOnlyMode = false) {
        const rawText = el.textContent?.trim() || '';
        if (!rawText) return;

        // In CN-only mode, skip non-Chinese text
        if (cnOnlyMode && !isChinese(rawText)) return;

        const source = el.dataset.asmrSource;
        const translatedText = el.dataset.asmrTranslatedText;
        if (el.dataset.asmrTranslated === 'true' && source && translatedText) {
            if (rawText.includes(source) && rawText.includes(translatedText)) {
                return;
            }
        }

        const text = source && rawText.includes(source) ? source : rawText;
        if (!text) return;

        const epoch = this._epoch;
        const targetLang = cnOnlyMode ? 'ja' : (I18n.lang === 'zh' ? 'zh-CN' : I18n.lang);
        try {
            const translated = await TranslationService.translate(text, targetLang);
            if (this._epoch !== epoch) return; // track changed while translating
            if (translated && translated !== text) {
                if (cnOnlyMode) {
                    // CN→JP: silently replace text content
                    el.textContent = translated;
                    el.dataset.asmrTranslated = 'true';
                    el.dataset.asmrSource = text;
                    el.dataset.asmrTranslatedText = translated;
                } else {
                    this.updateElement(el, text, translated);
                }
            } else {
                this.markOriginal(el, text);
            }
        } catch {
            if (this._epoch !== epoch) return;
            this.markOriginal(el, text);
        }
    }

    /**
     * Translate the track filename shown in the player.
     * Strips number prefix and file extension, translates the core text,
     * then displays as "Original (Translated)" using updateElement.
     */
    private async translateTrackName(el: HTMLElement, cnOnlyMode = false) {
        const rawText = el.textContent?.trim() || '';
        if (!rawText) return;

        // Already translated — skip if showing our translation pair
        if (el.dataset.asmrTranslated === 'true') {
            const source = el.dataset.asmrSource;
            const translated = el.dataset.asmrTranslatedText;
            // Vue may re-render the original text over our translation — re-apply
            if (source && rawText === source && translated) {
                if (cnOnlyMode) {
                    el.textContent = translated;
                } else {
                    this.updateElement(el, source, translated);
                }
                return;
            }
            // Still showing our translation pair (textContent contains both)
            if (source && translated && rawText.includes(source) && rawText.includes(translated)) return;
        }

        // Detect CJK content
        if (!/[\u3040-\u30ff\u4e00-\u9faf]/.test(rawText)) return;

        // In CN-only mode, skip non-Chinese text
        if (cnOnlyMode && !isChinese(rawText)) return;

        // Strip track number prefix (e.g. "1," or "01." or "01 ") and file extension
        const stripped = rawText
            .replace(/^\d+[\s.,、\-_·]+/, '')   // number prefix
            .replace(/\.[a-z0-9]{2,5}$/i, '');  // file extension
        if (!stripped) return;

        const epoch = this._epoch;
        const targetLang = cnOnlyMode ? 'ja' : (I18n.lang === 'zh' ? 'zh-CN' : I18n.lang);
        try {
            const translated = await TranslationService.translate(stripped, targetLang);
            if (this._epoch !== epoch) return; // track changed while translating
            if (translated && translated !== stripped) {
                const cleaned = TranslationService.cleanQuotes(translated);
                if (cnOnlyMode) {
                    // CN→JP: reconstruct with prefix/extension but JP core text
                    const prefix = rawText.match(/^\d+[\s.,、\-_·]+/)?.[0] || '';
                    const ext = rawText.match(/\.[a-z0-9]{2,5}$/i)?.[0] || '';
                    el.textContent = prefix + cleaned + ext;
                    el.dataset.asmrTranslated = 'true';
                    el.dataset.asmrSource = rawText;
                    el.dataset.asmrTranslatedText = el.textContent;
                } else {
                    this.updateElement(el, rawText, cleaned);
                }
            } else {
                this.markOriginal(el, rawText);
            }
        } catch {
            if (this._epoch !== epoch) return;
            this.markOriginal(el, rawText);
        }
    }

    private markOriginal(el: HTMLElement, original: string) {
        el.dataset.asmrTranslated = 'false';
        el.dataset.asmrSource = original;
        el.dataset.asmrTranslatedText = '';
    }

    private updateElement(el: HTMLElement, original: string, translated: string) {
        el.dataset.asmrTranslated = 'true';
        el.dataset.asmrSource = original;
        el.dataset.asmrTranslatedText = translated;
        el.classList.add('asmr-translation-pair');

        // Build all children in a DocumentFragment (single DOM mutation instead of 5)
        const frag = document.createDocumentFragment();
        const originalSpan = document.createElement('span');
        originalSpan.className = 'asmr-translation-original';
        originalSpan.textContent = original;
        const openParen = document.createElement('span');
        openParen.className = 'asmr-translation-sep';
        openParen.textContent = ' (';
        const translatedSpan = document.createElement('span');
        translatedSpan.className = 'asmr-translation-translated';
        translatedSpan.textContent = translated;
        const closeParen = document.createElement('span');
        closeParen.className = 'asmr-translation-sep';
        closeParen.textContent = ')';
        frag.append(originalSpan, openParen, translatedSpan, closeParen);

        el.textContent = '';
        el.appendChild(frag); // single reflow
        el.title = original;

        // Recalculate marquee animation after text change
        this.recalculateMarquee(el);
    }

    /**
     * Fix marquee after translation changes text length.
     *
     * Kikoeru sets --max-scroll and animation-duration as inline styles
     * via Vue reactivity. Changing textContent outside Vue leaves those
     * values stale (typically 0). Vue will overwrite any inline style
     * changes we make, so instead we:
     *   1. Add .asmr-marquee-fix on the container (CSS kills Kikoeru's
     *      animation and applies our own @keyframes on .one-line-expand)
     *   2. Set --asmr-scroll-distance and --asmr-scroll-duration as CSS
     *      custom properties on the container (Vue doesn't touch these)
     */
    private recalculateMarquee(el: HTMLElement): void {
        const container = el.closest('.container') as HTMLElement;
        if (!container) return;

        // Wait for layout after text change
        requestAnimationFrame(() => {
            const oneLineExpand = container.querySelector('.one-line-expand') as HTMLElement;
            if (!oneLineExpand) return;

            const contentWidth = oneLineExpand.scrollWidth;
            const containerWidth = container.clientWidth;
            const overflow = contentWidth - containerWidth;

            if (overflow > 0) {
                // ~40px/s for a smooth, readable scroll; alternate direction
                const duration = Math.max(3, overflow / 40);
                container.classList.add('asmr-marquee-fix');
                container.style.setProperty('--asmr-scroll-distance', `-${overflow}px`);
                container.style.setProperty('--asmr-scroll-duration', `${duration}s`);
            } else {
                container.classList.remove('asmr-marquee-fix');
                container.style.removeProperty('--asmr-scroll-distance');
                container.style.removeProperty('--asmr-scroll-duration');
            }
        });
    }
}
