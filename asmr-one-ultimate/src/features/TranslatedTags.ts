import { TranslationService } from '../services/TranslationService';
import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { Logger } from '../core/Logger';
import { Config, I18n } from '../core/Config';
import { CentralObserver } from '../core/CentralObserver';
import { EventBus } from '../core/EventBus';
import type { TagEntry } from '../types/api';

declare const unsafeWindow: Window & typeof globalThis;

const TRANSLATED_TAGS_VERSION = '2026-02-03.5';
const globalWindow = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) as Window & {
    __ASMR_TRANSLATED_TAGS__?: TranslatedTags;
    __ASMR_TRANSLATED_TAGS_VERSION__?: string;
};

/**
 * TranslatedTags - Fast, on-the-fly translation for tags and UI elements.
 * 
 * Features:
 * - Ultra-fast translation using dataset state tracking
 * - Japanese language detection
 * - Support for both network and local (Browser AI) translation
 * - Integration with CentralObserver for reactive updates
 */
export class TranslatedTags {
    private static instance: TranslatedTags | null = null;
    private bridge: KikoeruBridge;
    private isEnabled = false;
    private processedElements = new WeakSet<HTMLElement>();
    private modifyingDOMCount = 0;

    private tags: any[] = [];
    private boundInputHandler: (e: Event) => void;
    private boundKeyHandler: (e: KeyboardEvent) => void;
    private configCleanup?: () => void;
    private pathChangeCleanup?: () => void;

    private constructor() {
        this.bridge = KikoeruBridge.getInstance();
        this.boundInputHandler = (e: Event) => this.handleInput(e);
        this.boundKeyHandler = (e: KeyboardEvent) => this.handleKeydown(e);
    }

    public static getInstance(): TranslatedTags {
        const existing = globalWindow.__ASMR_TRANSLATED_TAGS__;
        if (existing && globalWindow.__ASMR_TRANSLATED_TAGS_VERSION__ === TRANSLATED_TAGS_VERSION) {
            TranslatedTags.instance = existing;
            return existing;
        }

        if (existing && typeof (existing as any).disable === 'function') {
            Logger.warn('[TranslatedTags] Replacing stale instance');
            try {
                existing.disable();
            } catch (e) {
                Logger.warn('[TranslatedTags] Failed to disable stale instance:', e);
            }
        }

        const next = new TranslatedTags();
        (next as any).__asmrTranslatedTagsVersion = TRANSLATED_TAGS_VERSION;
        globalWindow.__ASMR_TRANSLATED_TAGS__ = next;
        globalWindow.__ASMR_TRANSLATED_TAGS_VERSION__ = TRANSLATED_TAGS_VERSION;
        TranslatedTags.instance = next;
        return next;
    }

    public getTagList(): TagEntry[] {
        return (this.tags || []).map((tag: any) => {
            const id = typeof tag.id === 'string' ? parseInt(tag.id, 10) : tag.id;
            const ja = tag.ja || tag.name || '';
            const en = tag.en || tag.name_en || tag.i18n?.en || '';
            return {
                id,
                name: tag.name || ja || en || '',
                ja,
                en,
                count: tag.count || 0,
            } as TagEntry;
        });
    }

    public async enable(): Promise<void> {
        if (this.isEnabled) {
            Logger.log('[TranslatedTags] Already enabled, skipping');
            return;
        }

        // Initialize tags cache
        try {
            const res = await this.bridge.api.getTags();
            this.tags = res.data || [];
        } catch (e) {
            Logger.warn('[TranslatedTags] Failed to load tags cache', e);
        }

        // Add global styles for translated elements
        this.injectStyles();

        // Listen for user input (search bars) to prevent translation interference
        document.addEventListener('input', this.boundInputHandler, true);
        document.addEventListener('keydown', this.boundKeyHandler, true);

        // Register with CentralObserver for reactive updates
        CentralObserver.register('TranslatedTags', () => {
            if (!this.isModifyingDOM) {
                this.augmentTags();
            }
        }, 300); // 300ms debounce for responsiveness

        this.configCleanup = EventBus.on('config:change', ({ key, value, oldValue }) => {
            if (key === 'preferLocalTranslation' && value !== oldValue) {
                this.resetWorkTreeTranslationState();
                this.augmentTags();
            }
        });

        // Listen for explicit path change events from WorkTreeManager
        // This ensures translation state is reset BEFORE Vue updates DOM elements
        this.pathChangeCleanup = EventBus.on('worktree:path-change', () => {
            this.resetWorkTreeTranslationState();
        });

        // Reset per-element state on folder changes so cached DOM doesn't leak across levels
        this.bridge.$watch?.(() => this.getCurrentWorkTreeKey(), (next: string, prev: string) => {
            if (next !== prev) {
                this.resetWorkTreeTranslationState();
            }
        });

        this.augmentTags();
        this.isEnabled = true;
        Logger.info('[TranslatedTags] Enabled with CentralObserver');
    }

    public disable(): void {
        this.isEnabled = false;
        document.removeEventListener('input', this.boundInputHandler, true);
        document.removeEventListener('keydown', this.boundKeyHandler, true);
        CentralObserver.unregister('TranslatedTags');
        if (this.configCleanup) {
            this.configCleanup();
            this.configCleanup = undefined;
        }
        if (this.pathChangeCleanup) {
            this.pathChangeCleanup();
            this.pathChangeCleanup = undefined;
        }
        if (globalWindow.__ASMR_TRANSLATED_TAGS__ === this) {
            delete globalWindow.__ASMR_TRANSLATED_TAGS__;
            delete globalWindow.__ASMR_TRANSLATED_TAGS_VERSION__;
        }
    }

    private get isModifyingDOM(): boolean {
        return this.modifyingDOMCount > 0;
    }

    private beginDOMModification(): void {
        this.modifyingDOMCount++;
    }

    private endDOMModification(): void {
        this.modifyingDOMCount = Math.max(0, this.modifyingDOMCount - 1);
    }

    private markTranslationPending(el: HTMLElement, original: string, scopeKey?: string): void {
        this.processedElements.add(el);
        el.dataset.asmrtag = original;
        el.dataset.asmrtagState = 'pending';
        delete el.dataset.asmrtagTranslation;
        el.classList.remove('asmr-worktree-translation');
        if (scopeKey) {
            el.dataset.asmrtagScope = scopeKey;
        } else {
            delete el.dataset.asmrtagScope;
        }
    }

    private clearTranslationPending(el: HTMLElement, restoreOriginal = false): void {
        const original = el.dataset.asmrtag;
        // Restore original text if requested and element was translated
        // This helps when Vue hasn't re-rendered and we need to show correct content
        if (restoreOriginal && original && el.classList.contains('asmr-translated')) {
            const currentText = (el.textContent || '').trim();
            // Only restore if current text is different from original (was modified by translation)
            if (currentText !== original && currentText.includes(original)) {
                el.textContent = original;
            }
        }
        this.processedElements.delete(el);
        delete el.dataset.asmrtag;
        delete el.dataset.asmrtagState;
        delete el.dataset.asmrtagUntil;
        delete el.dataset.asmrtagScope;
        delete el.dataset.asmrtagTranslation;
        el.classList.remove('asmr-translated');
        el.classList.remove('asmr-worktree-translation');
    }

    private shouldSkipTranslation(el: HTMLElement, currentText: string, scopeKey?: string): boolean {
        if (scopeKey && el.dataset.asmrtagScope && el.dataset.asmrtagScope !== scopeKey) {
            // Scope mismatch - restore original text since Vue may not have re-rendered
            this.clearTranslationPending(el, true);
            return false;
        }
        const state = el.dataset.asmrtagState;
        const tracked = el.dataset.asmrtag;

        if (state === 'pending' && tracked === currentText) return true;

        if (state === 'done' && tracked) {
            if (currentText === tracked || currentText.includes(tracked)) return true;
            // Content changed (e.g., Vue reused the element), clear stale translation state.
            this.clearTranslationPending(el);
            return false;
        }

        if (state === 'fail' && tracked === currentText) {
            const until = Number(el.dataset.asmrtagUntil || 0);
            if (until && Date.now() < until) return true;
            this.clearTranslationPending(el);
        }

        return false;
    }

    /**
     * Main translation logic. Scans the page for untranslated Japanese content.
     * Uses a two-pass approach: collect all pending translations, then batch-translate.
     */
    public augmentTags(): void {
        if (!Config.get('translateMode')) return;

        const targetLang = this.targetLang;
        // 'pair' = formatPair(original, translated), 'raw' = translated only, 'worktree' = cleaned + ext
        type PendingItem = {
            el: HTMLElement;
            originalText: string;
            translateKey: string;
            scopeKey?: string;
            format: 'pair' | 'raw' | 'worktree';
            fileExt?: string;
            apply: (value: string) => void;
        };
        const pending: PendingItem[] = [];

        this.beginDOMModification();
        try {
            // 1. Chips (Tags) — known tag matches applied immediately, rest queued
            const chips = Array.from(document.querySelectorAll('.q-chip:not(.asmr-ignore)')) as HTMLElement[];
            for (const chip of chips) {
                const content = (chip.querySelector('.q-chip__content') as HTMLElement) || chip;
                const text = (content.textContent || '').trim();
                if (!text) continue;

                if (this.processedElements.has(chip) && this.shouldSkipTranslation(chip, text)) continue;

                // Try to match with known tags first (fastest — no async needed)
                const vueTag = (chip as any).__vue__?.$attrs?.tag || (chip as any).__vue__?.tag;
                const dataId = vueTag?.id || chip.getAttribute('data-tag-id') || chip.getAttribute('data-id');
                const match = dataId
                    ? this.tags.find(tag => String(tag.id) === String(dataId))
                    : this.tags.find(tag => tag.ja === text || tag.en === text);

                if (match?.en && match.ja !== match.en) {
                    const formatted = TranslationService.formatPair(match.ja, match.en);
                    this.processedElements.add(chip);
                    chip.dataset.asmrtag = text;
                    chip.dataset.asmrtagState = 'done';
                    delete chip.dataset.asmrtagUntil;
                    chip.classList.add('asmr-translated');
                    content.textContent = formatted;
                    continue;
                }

                if (this.looksJapanese(text) && !this.shouldSkipAutoTranslate(text, targetLang)) {
                    this.markTranslationPending(chip, text);
                    pending.push({ el: chip, originalText: text, translateKey: text, format: 'pair', apply: (v) => { content.textContent = v; } });
                }
            }

            // 2. List Items (Groups, VAs, work tree files)
            const listItems = Array.from(document.querySelectorAll('.q-item__label:not(.q-item__label--caption)')) as HTMLElement[];
            for (const item of listItems) {
                const text = (item.textContent || '').trim();
                if (!text || !this.looksJapanese(text)) continue;
                const isListing = location.pathname.includes('/circles') || location.pathname.includes('/vas') || location.pathname.includes('/works');
                const isWorkTree = item.closest('#work-tree, .work-tree') !== null;
                if (!isListing && !isWorkTree) continue;
                const scopeKey = isWorkTree ? this.getCurrentWorkTreeKey() : undefined;
                if (this.processedElements.has(item) && this.shouldSkipTranslation(item, text, scopeKey)) continue;

                this.markTranslationPending(item, text, scopeKey);
                if (isWorkTree) {
                    const fileInfo = this.getFileTranslationInfo(text);
                    const translateKey = fileInfo ? fileInfo.input : text;
                    pending.push({ el: item, originalText: text, translateKey, format: 'worktree', fileExt: fileInfo?.ext || '', scopeKey, apply: (v) => { this.applyWorkTreeTranslation(item, text, v); } });
                } else if (!this.shouldSkipAutoTranslate(text, targetLang)) {
                    pending.push({ el: item, originalText: text, translateKey: text, format: 'pair', scopeKey, apply: (v) => { item.textContent = v; } });
                }
            }

            // 3. Breadcrumbs
            const breadcrumbs = Array.from(document.querySelectorAll('#work-tree .q-breadcrumbs__el span, .work-tree .q-breadcrumbs__el span')) as HTMLElement[];
            for (const span of breadcrumbs) {
                const text = (span.textContent || '').trim();
                if (!text || !this.looksJapanese(text)) continue;
                const scopeKey = this.getCurrentWorkTreeKey();
                if (this.processedElements.has(span) && this.shouldSkipTranslation(span, text, scopeKey)) continue;
                if (this.shouldSkipAutoTranslate(text, targetLang)) continue;

                this.markTranslationPending(span, text, scopeKey);
                pending.push({ el: span, originalText: text, translateKey: text, format: 'pair', scopeKey, apply: (v) => { span.textContent = v; } });
            }

            // 4. Anchors
            const anchors = Array.from(document.querySelectorAll('a[href*="/circles/"], a[href*="/authors/"], a[href*="/actors/"], a[href*="/vas/"], a[href*="/cv/"]')) as HTMLAnchorElement[];
            for (const anchor of anchors) {
                const text = (anchor.textContent || '').trim();
                if (!text || !this.looksJapanese(text)) continue;
                if (this.processedElements.has(anchor) && this.shouldSkipTranslation(anchor, text)) continue;
                if (this.shouldSkipAutoTranslate(text, targetLang)) continue;

                this.markTranslationPending(anchor, text);
                pending.push({ el: anchor, originalText: text, translateKey: text, format: 'pair', apply: (v) => { anchor.textContent = v; } });
            }

            // 5. Work Card Circles / Studios
            const cardMetaNames = Array.from(document.querySelectorAll('.text-subtitle1 .text-grey.ellipsis')) as HTMLElement[];
            for (const el of cardMetaNames) {
                const text = (el.textContent || '').trim();
                if (!text || !this.looksJapanese(text)) continue;
                if (this.processedElements.has(el) && this.shouldSkipTranslation(el, text)) continue;
                if (this.shouldSkipAutoTranslate(text, targetLang)) continue;

                this.markTranslationPending(el, text);
                pending.push({ el, originalText: text, translateKey: text, format: 'pair', apply: (v) => { el.textContent = v; } });
            }

            // 6. Work Titles
            const workTitles = Array.from(document.querySelectorAll('.ellipsis-3-lines a[href*="/work/"], .ellipsis-2-lines a[href*="/work/"], .q-card .text-h6 a[href*="/work/"], .q-card a[href*="/work/"] .text-weight-medium')) as HTMLElement[];
            for (const el of workTitles) {
                const text = (el.textContent || '').trim();
                if (!text || !this.looksJapanese(text)) continue;
                if (this.processedElements.has(el) && this.shouldSkipTranslation(el, text)) continue;

                this.markTranslationPending(el, text);
                pending.push({ el, originalText: text, translateKey: text, format: 'raw', apply: (v) => { el.textContent = v; el.title = text; } });
            }

        } finally {
            this.endDOMModification();
        }

        // Pass 2: batch-translate all collected texts in one call
        if (pending.length > 0) {
            this.batchTranslatePending(pending, targetLang);
        }
    }

    /**
     * Returns true if autoTranslate would return the text unchanged (user's own language).
     */
    private shouldSkipAutoTranslate(text: string, targetLang: string): boolean {
        return TranslationService.isUserLang(text) && targetLang === 'en';
    }

    /**
     * Batch-translate all pending items with a single translateBatch() call,
     * then apply results back to their elements with the appropriate formatting.
     */
    private batchTranslatePending(
        pending: Array<{ el: HTMLElement; originalText: string; translateKey: string; scopeKey?: string; format: 'pair' | 'raw' | 'worktree'; fileExt?: string; apply: (value: string) => void }>,
        targetLang: string
    ): void {
        // Deduplicate translation keys
        const uniqueKeys: string[] = [];
        const keySet = new Set<string>();
        for (const item of pending) {
            if (!keySet.has(item.translateKey)) {
                keySet.add(item.translateKey);
                uniqueKeys.push(item.translateKey);
            }
        }

        TranslationService.translateBatch(uniqueKeys, targetLang).then(results => {
            const translationMap = new Map<string, string>();
            for (let i = 0; i < uniqueKeys.length; i++) {
                if (results[i]) translationMap.set(uniqueKeys[i], results[i]);
            }

            for (const item of pending) {
                const translated = translationMap.get(item.translateKey);
                if (!translated) {
                    this.finalizeTranslation(item.el, item.originalText, null, item.apply, item.scopeKey);
                    continue;
                }

                let formatted: string;
                switch (item.format) {
                    case 'pair':
                        formatted = TranslationService.formatPair(item.originalText, translated);
                        break;
                    case 'worktree': {
                        const cleaned = TranslationService.cleanQuotes(translated);
                        formatted = cleaned + (item.fileExt || '');
                        break;
                    }
                    case 'raw':
                        formatted = translated;
                        break;
                }

                this.finalizeTranslation(item.el, item.originalText, formatted, item.apply, item.scopeKey);
            }
        }).catch(err => {
            Logger.debug('[TranslatedTags] Batch translation failed:', err);
        });
    }

    private finalizeTranslation(
        el: HTMLElement,
        original: string,
        translated: string | null | undefined,
        apply: (value: string) => void,
        scopeKey?: string
    ): void {
        if (!translated || translated === original) {
            const retryDelay = TranslationService.hasLocalTranslator() ? 2000
                : TranslationService.isRateLimited() ? 60000 : 15000;
            Logger.debug('[TranslatedTags] Translation unchanged or empty, will retry', {
                original: original.slice(0, 50),
                retryInMs: retryDelay,
            });
            this.processedElements.add(el);
            el.dataset.asmrtag = original;
            el.dataset.asmrtagState = 'fail';
            el.dataset.asmrtagUntil = String(Date.now() + retryDelay);
            return;
        }
        if (!el.isConnected) {
            this.clearTranslationPending(el);
            return;
        }
        if (scopeKey && el.dataset.asmrtagScope && el.dataset.asmrtagScope !== scopeKey) {
            this.clearTranslationPending(el);
            return;
        }
        if (el.dataset.asmrtag !== original) return;
        const currentText = (el.textContent || '').trim();
        if (currentText !== original) {
            this.clearTranslationPending(el);
            return;
        }

        this.beginDOMModification();
        try {
            apply(translated);
            el.dataset.asmrtag = original;
            el.dataset.asmrtagState = 'done';
            delete el.dataset.asmrtagUntil;
            if (scopeKey) {
                el.dataset.asmrtagScope = scopeKey;
            } else {
                delete el.dataset.asmrtagScope;
            }
            el.classList.add('asmr-translated');
        } finally {
            this.endDOMModification();
        }
    }

    private handleInput(e: Event): void {
        const target = e.target as HTMLInputElement;
        if (this.isSearchInput(target)) {
            target.classList.add('asmr-ignore');
        }
    }

    private handleKeydown(e: KeyboardEvent): void {
        // Prevent translation while typing
        const target = e.target as HTMLInputElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.contentEditable === 'true') {
            this.beginDOMModification();
            setTimeout(() => this.endDOMModification(), 100);
        }
    }

    private isSearchInput(target: HTMLInputElement): boolean {
        if (!target || target.tagName !== 'INPUT') return false;

        const inHeader = !!target.closest('.q-header, .q-toolbar');
        if (inHeader) return true;
        if (target.type === 'search') return true;

        const placeholder = (target.placeholder || '').toLowerCase();
        const aria = (target.getAttribute('aria-label') || '').toLowerCase();
        return placeholder.includes('search') || placeholder.includes('keyword') || aria.includes('search');
    }

    private looksJapanese(text: string): boolean {
        return /[\u3040-\u30ff\u4e00-\u9faf]/.test(text);
    }

    private getFileTranslationInfo(text: string): { original: string; input: string; ext: string } | null {
        const match = text.match(/^(.*?)(\.[a-z0-9]{2,5})$/i);
        if (!match) return null;
        const base = match[1].trim();
        const ext = match[2];
        const normalized = base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
        const input = normalized || base;
        return { original: text, input, ext };
    }

    private applyWorkTreeTranslation(el: HTMLElement, original: string, translated: string): void {
        // Keep the original text intact so Vue can safely re-render when items change.
        const currentText = (el.textContent || '').trim();
        if (currentText !== original) {
            el.textContent = original;
        }
        el.dataset.asmrtagTranslation = translated;
        el.classList.add('asmr-worktree-translation');
    }

    private get targetLang(): string {
        return I18n.lang === 'zh' ? 'zh-CN' : I18n.lang;
    }

    private resetWorkTreeTranslationState(): void {
        this.processedElements = new WeakSet<HTMLElement>();
        // Reset all translated elements - restore original text since Vue may not re-render
        // reused DOM elements when navigating between folders
        const roots = document.querySelectorAll('#work-tree, .work-tree, .q-page, .q-layout');
        roots.forEach(root => {
            root.querySelectorAll<HTMLElement>('[data-asmrtag], [data-asmrtag-state], [data-asmrtag-scope], [data-asmrtag-translation], .asmr-translated, .asmr-worktree-translation')
                .forEach(el => {
                    const original = el.dataset.asmrtag;
                    // Restore original text if element was translated
                    // This ensures correct content is shown even if Vue doesn't re-render
                    if (original && el.classList.contains('asmr-translated')) {
                        const currentText = (el.textContent || '').trim();
                        if (currentText !== original && currentText.includes(original)) {
                            el.textContent = original;
                        }
                    }
                    delete el.dataset.asmrtag;
                    delete el.dataset.asmrtagState;
                    delete el.dataset.asmrtagUntil;
                    delete el.dataset.asmrtagScope;
                    delete el.dataset.asmrtagTranslation;
                    el.classList.remove('asmr-translated');
                    el.classList.remove('asmr-worktree-translation');
                });
        });
        Logger.debug('[TranslatedTags] Reset work-tree translation state (restored originals)');
    }

    private getCurrentWorkTreeKey(): string {
        const route = this.bridge.route;
        const workId = route?.params?.id || '';
        const fullPath = route?.fullPath || route?.path || '';
        // Strip hash so anchor changes don't thrash translation state.
        const pathKey = fullPath ? fullPath.split('#')[0] : '';
        if (pathKey) return `${workId}|${pathKey}`;

        // Fallback: include path + normalized query so query-only changes still reset.
        const path = route?.path || '';
        const queryKey = this.normalizeQueryPath(route?.query);
        return `${workId}|${path}${queryKey ? `?${queryKey}` : ''}`;
    }

    private normalizeQueryPath(value: unknown): string {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            const entries = Object.keys(value as Record<string, unknown>)
                .sort()
                .map((key) => [key, (value as Record<string, unknown>)[key]]);
            try {
                return JSON.stringify(entries);
            } catch (e) {
                Logger.warn('[TranslatedTags] Failed to stringify query entries:', e);
                return String(value);
            }
        }
        if (Array.isArray(value)) {
            return JSON.stringify(value.map((item) => String(item)));
        }
        if (typeof value === 'string') return value;
        if (value == null) return '';
        try {
            return JSON.stringify(value);
        } catch (e) {
            Logger.warn('[TranslatedTags] Failed to stringify query value:', e);
            return String(value);
        }
    }

    private injectStyles(): void {
        if (document.getElementById('asmr-translated-styles')) return;
        const style = document.createElement('style');
        style.id = 'asmr-translated-styles';
        style.textContent = `
            .asmr-translated {
                transition: color 0.3s ease;
            }
            .asmr-worktree-translation::after {
                content: " (" attr(data-asmrtag-translation) ")";
            }
            .q-dark .asmr-translated {
                color: #90caf9;
            }
            .q-light .asmr-translated {
                color: #1976d2;
            }
        `;
        document.head.appendChild(style);
    }
}
