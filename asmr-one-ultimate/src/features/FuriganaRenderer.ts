/**
 * FuriganaRenderer — Sitewide Furigana via JPDB
 *
 * Processes visible Japanese text on the page and adds ruby annotations.
 * Registers with CentralObserver for DOM mutation tracking.
 */

import { CentralObserver } from '../core/CentralObserver';
import { TIMING } from '../core/Constants';
import { Logger } from '../core/Logger';
import { EventBus } from '../core/EventBus';
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
    '.text-subtitle1 .text-grey',
    // Tags & chips
    '.q-chip__content',
    '.asmr-chip-label',
    // Work tree
    '.work-tree-item span',
    '.q-item__label',
    // Original title (shown below translated h1)
    '.asmr-original-title',
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
    private pathChangeCleanup: (() => void) | null = null;

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

        CentralObserver.register('FuriganaRenderer', () => this.scan(), TIMING.OBSERVER_REGISTER_DEBOUNCE_MS);

        // Strip furigana from work tree items BEFORE Vue renders on path change.
        // FuriganaRenderer's innerHTML replacement detaches Vue's tracked text nodes;
        // restoring original text allows Vue to patch correctly even if _vnode=null fails.
        this.pathChangeCleanup = EventBus.on('worktree:path-change', () => {
            const workTree = document.getElementById('work-tree');
            if (workTree) {
                const annotated = workTree.querySelectorAll('[data-jpdb]');
                if (annotated.length > 0) {
                    CentralObserver.withModification(() => {
                        for (const el of annotated) {
                            const original = el.getAttribute('data-jpdb-original');
                            if (original) {
                                el.textContent = original;
                            }
                            el.removeAttribute('data-jpdb');
                            el.removeAttribute('data-jpdb-original');
                        }
                    });
                }
            }
            this.processedElements = new WeakSet();
        });

        this.scan();
        Logger.debug('[FuriganaRenderer] Enabled');
    }

    disable(): void {
        this._enabled = false;
        CentralObserver.unregister('FuriganaRenderer');

        this.pathChangeCleanup?.();
        this.pathChangeCleanup = null;

        this.observer?.disconnect();
        this.observer = null;
        this.pendingElements.clear();

        // Remove all annotations
        this.removeAllAnnotations();
        Logger.debug('[FuriganaRenderer] Disabled');
    }

    // =========================================================================
    // Text Extraction
    // =========================================================================

    /**
     * Get text content excluding Material icon ligatures and ruby readings.
     * Icon elements use font ligatures (e.g. "close" renders as ×) so their
     * textContent must not be sent to JPDB for annotation.
     */
    private getAnnotatableText(el: HTMLElement): string {
        if (!el.querySelector('i.material-icons, .q-chip__icon, rt')) {
            return (el.textContent || '').trim();
        }
        const clone = el.cloneNode(true) as HTMLElement;
        for (const node of clone.querySelectorAll('i.material-icons, .q-chip__icon, rt, rp')) {
            node.remove();
        }
        return (clone.textContent || '').trim();
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

            // Skip work tree items — applyTokensToElement() destructively replaces
            // innerHTML with <ruby> fragments, detaching Vue 2's tracked text nodes.
            // fixWorkTreeText() corrects stale text on render, but FuriganaRenderer
            // re-corrupts ~500ms later via CentralObserver, creating an endless cycle.
            // Work tree items get translations via TranslatedTags CSS ::after instead.
            if (htmlEl.closest('#work-tree')) continue;

            // Skip containers with interactive children (buttons, chips, selects, icons).
            // Their textContent includes button labels, icon ligatures, count badges, etc.
            // The Japanese text inside these containers is already targeted via more
            // specific selectors (e.g. .q-chip__content).
            if (htmlEl.querySelector('.q-chip, .q-btn, .q-select, button, select, [role="button"]')) continue;

            // Must contain Japanese text with kanji
            const text = this.getAnnotatableText(htmlEl);
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

                const text = this.getAnnotatableText(htmlEl);
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

        // Save icon elements before replacing content (e.g., chip close button).
        // Icon text (font ligatures like "close" → ×) was excluded from originalText
        // by getAnnotatableText(), so icons must be re-appended separately.
        const savedIcons = Array.from(el.querySelectorAll('i.material-icons, .q-chip__icon'));

        // Replace element contents (store original for clean retrieval)
        el.setAttribute('data-jpdb-original', originalText);
        el.textContent = '';
        el.appendChild(fragment);
        for (const icon of savedIcons) el.appendChild(icon);
        el.setAttribute('data-jpdb', 'true');
    }

    // =========================================================================
    // Cleanup
    // =========================================================================

    private removeAllAnnotations(): void {
        CentralObserver.withModification(() => {
            const annotated = document.querySelectorAll('[data-jpdb]');
            for (const el of annotated) {
                // Restore original text from stored attribute (excludes furigana)
                const original = el.getAttribute('data-jpdb-original');
                if (original) {
                    el.textContent = original;
                } else {
                    // Fallback: strip <rt>/<rp> text from ruby annotations
                    const clone = el.cloneNode(true) as Element;
                    clone.querySelectorAll('rt, rp').forEach(e => e.remove());
                    const text = clone.textContent;
                    if (text) el.textContent = text;
                }
                el.removeAttribute('data-jpdb');
                el.removeAttribute('data-jpdb-original');
            }
        });
        this.processedElements = new WeakSet();
    }
}
