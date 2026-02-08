/**
 * FuriganaRenderer — Sitewide Furigana via JPDB
 *
 * Processes visible Japanese text on the page and adds ruby annotations.
 * Registers with CentralObserver for DOM mutation tracking.
 */

import { CentralObserver } from '../core/CentralObserver';
import { Logger } from '../core/Logger';
import { AppStore } from '../store/AppStore';
import { JpdbService } from '../services/JpdbService';
import type { JPDBToken } from '../types/jpdb';

// ============================================================================
// Constants
// ============================================================================

/** CSS selectors for elements that should receive furigana */
const TARGET_SELECTORS = [
    // Work titles & headings
    '.q-card .text-subtitle1',
    'h1', 'h2', '.text-h5', '.text-h6',
    '.text-subtitle2',
    '.ellipsis-3-lines a[href*="/work/"]',
    '.ellipsis-2-lines a[href*="/work/"]',
    // Circle / VA names
    '.text-subtitle1 .text-grey.ellipsis',
    // Tags & chips
    '.q-chip__content',
    '.asmr-chip-label',
    // Work tree
    '.work-tree-item span',
    '.q-item__label',
    // Scraped metadata (descriptions, file names)
    '.asmr-meta-description-cell--original',
    '.asmr-meta-body-cell--original',
    '.asmr-meta-file-name',
    // Comments / reviews
    '.asmr-comments-review-cell--original',
    // Lightbox text/PDF lines
    '.media-viewer-text-line',
].join(', ');

/** Elements to skip entirely */
const SKIP_SELECTOR = '[data-jpdb], [data-asmritran], .learner-jp, .learner-en, script, style, input, textarea, .jpdb-popover, .asmr-settings-container, .media-viewer-text-line--translated';

/** Regex to detect Japanese text (Hiragana, Katakana, CJK) */
const HAS_JAPANESE = /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]/;

/** Regex to detect kanji (the ones that benefit from furigana) */
const HAS_KANJI = /[\u4e00-\u9faf]/;

// ============================================================================
// FuriganaRenderer
// ============================================================================

export class FuriganaRenderer {
    private _enabled = false;
    private processedElements = new WeakSet<Element>();
    private observer: IntersectionObserver | null = null;
    private pendingElements = new Set<Element>();
    private processingBatch = false;

    enable(): void {
        if (this._enabled) return;
        this._enabled = true;

        // Set up IntersectionObserver for viewport-aware processing
        this.observer = new IntersectionObserver(
            entries => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        this.pendingElements.add(entry.target);
                    }
                }
                if (this.pendingElements.size > 0) {
                    this.processVisible();
                }
            },
            { rootMargin: '200px' }, // Pre-load 200px before viewport
        );

        CentralObserver.register('FuriganaRenderer', () => this.scan(), 500);
        this.scan();
        Logger.debug('[FuriganaRenderer] Enabled');
    }

    disable(): void {
        this._enabled = false;
        CentralObserver.unregister('FuriganaRenderer');

        this.observer?.disconnect();
        this.observer = null;
        this.pendingElements.clear();

        // Remove all annotations
        this.removeAllAnnotations();
        Logger.debug('[FuriganaRenderer] Disabled');
    }

    // =========================================================================
    // Scan & Process
    // =========================================================================

    /**
     * Scan the page for unannotated Japanese text elements.
     */
    private scan(): void {
        if (!this._enabled || !AppStore.getConfig('jpdbSiteFurigana')) return;
        if (!AppStore.getConfig('jpdbShowFurigana')) return;

        const candidates = document.querySelectorAll(TARGET_SELECTORS);

        for (const el of candidates) {
            const htmlEl = el as HTMLElement;

            // Skip already processed or excluded elements
            if (this.processedElements.has(htmlEl)) continue;
            if (htmlEl.closest(SKIP_SELECTOR)) continue;
            if (htmlEl.hasAttribute('data-jpdb')) continue;

            // Must contain Japanese text with kanji
            const text = htmlEl.textContent?.trim();
            if (!text || !HAS_JAPANESE.test(text) || !HAS_KANJI.test(text)) continue;

            // Observe for viewport intersection
            this.observer?.observe(htmlEl);
        }
    }

    /**
     * Process elements that are currently visible in the viewport.
     */
    private async processVisible(): Promise<void> {
        if (this.processingBatch || this.pendingElements.size === 0) return;
        this.processingBatch = true;

        try {
            // Take a batch of up to 10 elements
            const batch: Element[] = [];
            for (const el of this.pendingElements) {
                batch.push(el);
                if (batch.length >= 10) break;
            }

            // Remove from pending
            for (const el of batch) {
                this.pendingElements.delete(el);
                this.observer?.unobserve(el);
            }

            // Collect texts and elements
            const texts: string[] = [];
            const elements: HTMLElement[] = [];

            for (const el of batch) {
                const htmlEl = el as HTMLElement;
                if (this.processedElements.has(htmlEl)) continue;
                if (htmlEl.hasAttribute('data-jpdb')) continue;

                const text = htmlEl.textContent?.trim();
                if (!text || !HAS_KANJI.test(text)) continue;

                texts.push(text);
                elements.push(htmlEl);
            }

            if (texts.length === 0) return;

            // Parse all texts in one API call
            const result = await JpdbService.parse(texts);

            // Apply annotations
            CentralObserver.withModification(() => {
                for (let i = 0; i < elements.length; i++) {
                    const el = elements[i];
                    const tokens = result.tokens[i];
                    if (!tokens || tokens.length === 0) continue;

                    this.applyTokensToElement(el, tokens, texts[i]);
                    this.processedElements.add(el);
                }
            });
        } catch (err) {
            Logger.error('[FuriganaRenderer] Error processing batch:', err);
        } finally {
            this.processingBatch = false;

            // Process next batch if pending
            if (this.pendingElements.size > 0) {
                requestAnimationFrame(() => this.processVisible());
            }
        }
    }

    // =========================================================================
    // DOM Manipulation
    // =========================================================================

    /**
     * Apply JPDB tokens with furigana to an element.
     */
    private applyTokensToElement(el: HTMLElement, tokens: JPDBToken[], originalText: string): void {
        const showPitch = AppStore.getConfig('jpdbShowPitchAccent');
        const fragment = document.createDocumentFragment();
        const chars = Array.from(originalText);

        // Build UTF-16 → char index map
        const utf16ToCharIdx = new Map<number, number>();
        let utf16Offset = 0;
        for (let i = 0; i < chars.length; i++) {
            utf16ToCharIdx.set(utf16Offset, i);
            utf16Offset += chars[i].length;
        }
        utf16ToCharIdx.set(utf16Offset, chars.length);

        const toCharIdx = (utf16Pos: number): number => {
            const idx = utf16ToCharIdx.get(utf16Pos);
            if (idx !== undefined) return idx;
            let closest = 0;
            for (const [pos, ci] of utf16ToCharIdx) {
                if (pos <= utf16Pos) closest = ci;
            }
            return closest;
        };

        let lastCharEnd = 0;

        for (const token of tokens) {
            const tokenCharStart = toCharIdx(token.start);
            const tokenCharEnd = toCharIdx(token.end);

            // Gap text before token
            if (tokenCharStart > lastCharEnd) {
                fragment.appendChild(
                    document.createTextNode(chars.slice(lastCharEnd, tokenCharStart).join('')),
                );
            }

            // Create word wrapper
            const wordSpan = document.createElement('span');
            wordSpan.className = 'jpdb-word';
            wordSpan.setAttribute('data-jpdb', 'true');
            wordSpan.setAttribute('data-vid', String(token.card.vid));
            wordSpan.setAttribute('data-sid', String(token.card.sid));

            // Card state class
            const state = token.card.cardState[0];
            if (state) wordSpan.classList.add(`jpdb-${state}`);

            // Pitch accent class
            if (showPitch && token.pitchClass) {
                wordSpan.classList.add(token.pitchClass);
            }

            // Build content (with or without ruby)
            if (token.rubies.length === 0) {
                wordSpan.textContent = chars.slice(tokenCharStart, tokenCharEnd).join('');
            } else {
                let rubyLastCharEnd = tokenCharStart;

                for (const ruby of token.rubies) {
                    const rubyCharStart = toCharIdx(ruby.start);
                    const rubyCharEnd = toCharIdx(ruby.end);

                    // Kana gap before ruby
                    if (rubyCharStart > rubyLastCharEnd) {
                        wordSpan.appendChild(
                            document.createTextNode(chars.slice(rubyLastCharEnd, rubyCharStart).join('')),
                        );
                    }

                    // Ruby element
                    const rubyEl = document.createElement('ruby');
                    rubyEl.appendChild(
                        document.createTextNode(chars.slice(rubyCharStart, rubyCharEnd).join('')),
                    );
                    const rt = document.createElement('rt');
                    rt.className = 'jpdb-furi';
                    rt.textContent = ruby.text;
                    rubyEl.appendChild(rt);
                    wordSpan.appendChild(rubyEl);

                    rubyLastCharEnd = rubyCharEnd;
                }

                // Trailing kana
                if (rubyLastCharEnd < tokenCharEnd) {
                    wordSpan.appendChild(
                        document.createTextNode(chars.slice(rubyLastCharEnd, tokenCharEnd).join('')),
                    );
                }
            }

            fragment.appendChild(wordSpan);
            lastCharEnd = tokenCharEnd;
        }

        // Trailing text
        if (lastCharEnd < chars.length) {
            fragment.appendChild(
                document.createTextNode(chars.slice(lastCharEnd).join('')),
            );
        }

        // Replace element contents
        el.textContent = '';
        el.appendChild(fragment);
        el.setAttribute('data-jpdb', 'true');
    }

    // =========================================================================
    // Cleanup
    // =========================================================================

    private removeAllAnnotations(): void {
        CentralObserver.withModification(() => {
            const annotated = document.querySelectorAll('[data-jpdb]');
            for (const el of annotated) {
                // Restore original text (strip ruby annotations)
                const text = el.textContent;
                if (text) {
                    el.textContent = text;
                }
                el.removeAttribute('data-jpdb');
            }
        });
        this.processedElements = new WeakSet();
    }
}
