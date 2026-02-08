import { CentralObserver } from '../core/CentralObserver';
import { TranslationService } from '../services/TranslationService';
import { I18n } from '../core/Utils';
import { PLAYER_BAR_SELECTOR } from '../core/DomUtils';
import { AppStore } from '../store/AppStore';
import { EventBus } from '../core/EventBus';

export class PlayerTranslator {
    private trackChangeCleanup?: () => void;
    private _enabled = false;

    public enable(): void {
        if (this._enabled) return;
        this._enabled = true;
        // Register with central observer instead of own MutationObserver
        CentralObserver.register('PlayerTranslator', () => this.checkPlayer(), 500);

        // Translate immediately on track change instead of waiting for observer debounce
        this.trackChangeCleanup = EventBus.on('track:change', () => {
            // Clear stale translation attrs so the old translation doesn't cause
            // early-return in translateTrackName/translateElement when Vue hasn't
            // re-rendered the new title yet (rawText still === old translated text).
            this.resetTranslationState();
            // Single rAF + 200ms fallback for slow Vue re-renders (was double setTimeout 50+200)
            requestAnimationFrame(() => this.checkPlayer());
            setTimeout(() => this.checkPlayer(), 200);
        });
    }

    public disable(): void {
        this._enabled = false;
        CentralObserver.unregister('PlayerTranslator');
        this.trackChangeCleanup?.();
        this.trackChangeCleanup = undefined;
    }

    /**
     * Clear stale data-asmr-* attributes from player title elements.
     * Called on track:change so that the early-return checks in
     * translateTrackName/translateElement don't match stale data.
     */
    private resetTranslationState(): void {
        const playerBar = document.querySelector(PLAYER_BAR_SELECTOR + ', .audio-player');
        if (!playerBar) return;

        const els = playerBar.querySelectorAll<HTMLElement>('[data-asmr-translated]');
        for (const el of els) {
            delete el.dataset.asmrTranslated;
            delete el.dataset.asmrSource;
            delete el.dataset.asmrTranslatedText;
        }
    }

    private async checkPlayer() {
        if (!AppStore.getConfig('translateMode')) return;
        const playerBar = document.querySelector(PLAYER_BAR_SELECTOR + ', .audio-player');
        if (!playerBar) return;

        const titleEl = playerBar.querySelector('.q-toolbar__title, .text-h6, .text-weight-bold.text-body1') as HTMLElement;
        const artistEl = playerBar.querySelector('.text-subtitle2, .text-caption, .text-grey-5') as HTMLElement;
        const trackNameEl = playerBar.querySelector('.ellipsis-2-lines') as HTMLElement;

        // Run all translations concurrently instead of sequentially
        const tasks: Promise<void>[] = [];
        if (titleEl) tasks.push(this.translateElement(titleEl, 'title'));
        if (artistEl) tasks.push(this.translateElement(artistEl, 'artist'));
        if (trackNameEl) tasks.push(this.translateTrackName(trackNameEl));
        await Promise.all(tasks);
    }

    private async translateElement(el: HTMLElement, _type: 'title' | 'artist') {
        const rawText = el.textContent?.trim() || '';
        if (!rawText) return;

        const source = el.dataset.asmrSource;
        const translatedText = el.dataset.asmrTranslatedText;
        if (el.dataset.asmrTranslated === 'true' && source && translatedText) {
            if (rawText.includes(source) && rawText.includes(translatedText)) {
                return;
            }
        }

        const text = source && rawText.includes(source) ? source : rawText;
        if (!text) return;

        const targetLang = I18n.lang === 'zh' ? 'zh-CN' : I18n.lang;
        try {
            const translated = await TranslationService.translate(text, targetLang);
            if (translated && translated !== text) {
                this.updateElement(el, text, translated);
            } else {
                this.markOriginal(el, text);
            }
        } catch {
            this.markOriginal(el, text);
        }
    }

    /**
     * Translate the track filename shown in the player.
     * Strips number prefix and file extension, translates the core text,
     * then displays English only with the original as a tooltip.
     */
    private async translateTrackName(el: HTMLElement) {
        const rawText = el.textContent?.trim() || '';
        if (!rawText) return;

        // Already translated — skip if showing our translation or source hasn't changed
        if (el.dataset.asmrTranslated === 'true') {
            const source = el.dataset.asmrSource;
            const translated = el.dataset.asmrTranslatedText;
            // Vue may re-render the original text over our translation — re-apply
            if (source && rawText === source && translated) {
                el.textContent = translated;
                el.title = source;
                return;
            }
            // Still showing our translated text
            if (translated && rawText === translated) return;
        }

        // Detect Japanese content
        if (!/[\u3040-\u30ff\u4e00-\u9faf]/.test(rawText)) return;

        // Strip track number prefix (e.g. "1," or "01." or "01 ") and file extension
        const stripped = rawText
            .replace(/^\d+[\s.,、\-_·]+/, '')   // number prefix
            .replace(/\.[a-z0-9]{2,5}$/i, '');  // file extension
        if (!stripped) return;

        const targetLang = I18n.lang === 'zh' ? 'zh-CN' : I18n.lang;
        try {
            const translated = await TranslationService.translate(stripped, targetLang);
            if (translated && translated !== stripped) {
                // Show English only, original as tooltip
                el.dataset.asmrTranslated = 'true';
                el.dataset.asmrSource = rawText;
                el.dataset.asmrTranslatedText = translated;
                el.textContent = TranslationService.cleanQuotes(translated);
                el.title = rawText;
            } else {
                el.dataset.asmrTranslated = 'false';
                el.dataset.asmrSource = rawText;
            }
        } catch {
            el.dataset.asmrTranslated = 'false';
            el.dataset.asmrSource = rawText;
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
