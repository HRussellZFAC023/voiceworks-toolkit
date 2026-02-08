import { CentralObserver } from '../core/CentralObserver';
import { TranslationService } from '../services/TranslationService';
import { I18n } from '../core/Utils';
import { PLAYER_BAR_SELECTOR } from '../core/DomUtils';
import { AppStore } from '../store/AppStore';
import { EventBus } from '../core/EventBus';

export class PlayerTranslator {
    private trackChangeCleanup?: () => void;

    public enable(): void {
        if (!AppStore.getConfig('translateMode')) {
            return;
        }
        // Register with central observer instead of own MutationObserver
        CentralObserver.register('PlayerTranslator', () => this.checkPlayer(), 500);

        // Translate immediately on track change instead of waiting for observer debounce
        this.trackChangeCleanup = EventBus.on('track:change', () => {
            setTimeout(() => this.checkPlayer(), 50);
        });
    }

    private async checkPlayer() {
        // Mini player usually at the bottom or top depending on layout
        const playerBar = document.querySelector(PLAYER_BAR_SELECTOR + ', .audio-player');
        if (!playerBar) return;

        // Selectors based on the screenshots and common structure
        // The title is usually in a text-h6 or similar, artist in text-subtitle2 or caption
        const titleEl = playerBar.querySelector('.q-toolbar__title, .text-h6, .text-weight-bold.text-body1') as HTMLElement;
        const artistEl = playerBar.querySelector('.text-subtitle2, .text-caption, .text-grey-5') as HTMLElement;

        // Track filename: "1,残業で爆睡…ダウナー系な職場の後輩が迫る….mp3"
        const trackNameEl = playerBar.querySelector('.ellipsis-2-lines') as HTMLElement;

        if (titleEl) {
            await this.translateElement(titleEl, 'title');
        }

        if (artistEl) {
            await this.translateElement(artistEl, 'artist');
        }

        if (trackNameEl) {
            await this.translateTrackName(trackNameEl);
        }
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
        el.textContent = '';

        const originalSpan = document.createElement('span');
        originalSpan.className = 'asmr-translation-original';
        originalSpan.textContent = original;

        const separator = document.createElement('span');
        separator.className = 'asmr-translation-sep';
        separator.textContent = ' · ';

        const translatedSpan = document.createElement('span');
        translatedSpan.className = 'asmr-translation-translated';
        translatedSpan.textContent = translated;

        el.appendChild(originalSpan);
        el.appendChild(separator);
        el.appendChild(translatedSpan);
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
