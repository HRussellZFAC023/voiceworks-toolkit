import { CentralObserver } from '../core/CentralObserver';
import { TranslationService } from '../services/TranslationService';
import { CacheKeys, SharedCache } from '../core/Cache';
import { I18n } from '../core/Utils';
import { PLAYER_BAR_SELECTOR } from '../core/DomUtils';
import { AppStore } from '../store/AppStore';

const PLAYER_TRANSLATION_TTL = 1000 * 60 * 60 * 24 * 7; // 7 days

export class PlayerTranslator {
    public enable(): void {
        if (!AppStore.getConfig('translateMode')) {
            return;
        }
        // Register with central observer instead of own MutationObserver
        CentralObserver.register('PlayerTranslator', () => this.checkPlayer(), 500);
    }

    private async checkPlayer() {
        // Mini player usually at the bottom or top depending on layout
        const playerBar = document.querySelector(PLAYER_BAR_SELECTOR + ', .audio-player');
        if (!playerBar) return;

        // Selectors based on the screenshots and common structure
        // The title is usually in a text-h6 or similar, artist in text-subtitle2 or caption
        const titleEl = playerBar.querySelector('.q-toolbar__title, .text-h6, .text-weight-bold.text-body1') as HTMLElement;
        const artistEl = playerBar.querySelector('.text-subtitle2, .text-caption, .text-grey-5') as HTMLElement;

        // Specific selector for the mini player shown in screenshot 2
        // It seems to be formatted as "01 . Title.mp3"

        if (titleEl) {
            await this.translateElement(titleEl, 'title');
        }

        if (artistEl) {
            await this.translateElement(artistEl, 'artist');
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
