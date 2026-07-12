import { TranslationService, type DisplayTranslationResult } from '../services/TranslationService';
import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { Logger } from '../core/Logger';
import { Config, I18n } from '../core/Config';
import { CentralObserver } from '../core/CentralObserver';
import { EventBus } from '../core/EventBus';
import { Priority } from '../core/GpuScheduler';
import { isChinese } from '../core/DomUtils';
import type { TagEntry, TagI18n } from '../types/api';

/** Raw tag from the /api/tags endpoint — superset of TagEntry with i18n info */
interface RawTag extends TagEntry {
    name_en?: string;
    i18n?: TagI18n;
}

type ContentSourceHint = 'ja' | 'zh' | 'auto';

interface PendingTranslationItem {
    el: HTMLElement;
    originalText: string;
    translateKey: string;
    scopeKey?: string;
    format: 'pair' | 'raw' | 'worktree';
    fileExt?: string;
    apply: (value: string, display?: DisplayTranslationResult) => void;
}

declare const unsafeWindow: Window & typeof globalThis;

const TRANSLATED_TAGS_VERSION = '2026-07-11.1';
const TAG_TRANSLATION_PRIORITY = Priority.NORMAL;
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

    private tags: RawTag[] = [];
    private boundInputHandler: (e: Event) => void;
    private boundKeyHandler: (e: KeyboardEvent) => void;
    private configCleanup?: () => void;
    private pathChangeCleanup?: () => void;
    private routeKeyCleanup?: () => void;
    private jpdbGuardCleanup?: () => void;
    private workChangeCleanup?: () => void;
    private trackChangeCleanup?: () => void;
    private langChangeCleanup?: () => void;
    private activeQueueKey = '';
    private translationGeneration = 0;
    private lifecycleGeneration = 0;
    private augmentFrame: number | null = null;

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

        if (existing && typeof existing.disable === 'function') {
            Logger.warn('[TranslatedTags] Replacing stale instance');
            try {
                existing.disable();
            } catch (e) {
                Logger.warn('[TranslatedTags] Failed to disable stale instance:', e);
            }
        }

        const next = new TranslatedTags();
        globalWindow.__ASMR_TRANSLATED_TAGS__ = next;
        globalWindow.__ASMR_TRANSLATED_TAGS_VERSION__ = TRANSLATED_TAGS_VERSION;
        TranslatedTags.instance = next;
        return next;
    }

    public getTagList(): TagEntry[] {
        return (this.tags || []).map((tag) => {
            const id = typeof tag.id === 'string' ? parseInt(tag.id, 10) : tag.id;
            const ja = tag.ja || tag.name || '';
            const en = tag.en || tag.name_en || tag.i18n?.['en-us']?.name || '';
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
        this.isEnabled = true;
        const generation = ++this.lifecycleGeneration;

        // Initialize tags cache
        try {
            const res = await this.bridge.api.getTags();
            this.tags = (res.data || []) as RawTag[];
        } catch (e) {
            Logger.warn('[TranslatedTags] Failed to load tags cache', e);
        }
        if (!this.isEnabled || generation !== this.lifecycleGeneration) return;

        // Add global styles for translated elements
        this.injectStyles();

        // Listen for user input (search bars) to prevent translation interference
        document.addEventListener('input', this.boundInputHandler, true);
        document.addEventListener('keydown', this.boundKeyHandler, true);

        // Register with CentralObserver for reactive updates
        CentralObserver.register('TranslatedTags', () => {
            if (this.isEnabled && !this.isModifyingDOM) {
                this.augmentTags();
            }
        }, 300); // 300ms debounce for responsiveness

        this.configCleanup = EventBus.on('config:change', ({ key, value, oldValue }) => {
            if ((key === 'translateMode' || key === 'translateCnToJp') && value !== oldValue) {
                this.cancelActiveTranslationQueue();
                this.resetAllTranslationState();
                this.scheduleAugment();
            }
        });

        // Listen for explicit path change events from WorkTreeManager
        // This ensures translation state is reset BEFORE Vue updates DOM elements
        this.pathChangeCleanup = EventBus.on('worktree:path-change', () => {
            if (!this.isEnabled) return;
            this.cancelActiveTranslationQueue();
            this.resetWorkTreeTranslationState();
        });

        // Work/track transitions can reuse DOM nodes across pages and player surfaces.
        // Proactively clear stale translation attributes to avoid sticky labels.
        this.workChangeCleanup = EventBus.on('work:change', () => {
            if (!this.isEnabled) return;
            this.cancelActiveTranslationQueue();
            this.resetWorkTreeTranslationState();
            this.resetPlayerTranslationState();
        });
        this.trackChangeCleanup = EventBus.on('track:change', () => {
            if (!this.isEnabled) return;
            // Track switches can reuse player DOM while prior translation batches are
            // still in flight. Cancel the active queue first to avoid stale apply().
            this.cancelActiveTranslationQueue();
            this.resetPlayerTranslationState();
            this.scheduleAugment();
        });
        this.langChangeCleanup = EventBus.on('lang:change', () => {
            if (!this.isEnabled) return;
            this.cancelActiveTranslationQueue();
            this.resetAllTranslationState();
            this.scheduleAugment();
        });

        // Reset per-element state on folder changes so cached DOM doesn't leak across levels
        const unwatch = this.bridge.$watch?.(() => this.getCurrentWorkTreeKey(), (next: string, prev: string) => {
            if (!this.isEnabled) return;
            if (next !== prev) {
                this.cancelTranslationQueueForRouteKey(prev);
                this.cancelTranslationQueueForRouteKey(next);
                this.resetWorkTreeTranslationState();
            }
        });
        if (typeof unwatch === 'function') {
            this.routeKeyCleanup = unwatch;
        }

        // Strip JPDB annotations from elements with chips before each route change.
        // JPDB wraps text in spans that break Vue's DOM patching, causing stale
        // search text to persist. Cleaning in beforeEach ensures Vue finds clean
        // text nodes before it patches the DOM for the new route.
        const router = this.bridge.router;
        if (router?.beforeEach) {
            this.jpdbGuardCleanup = router.beforeEach((_to: unknown, _from: unknown, next: () => void) => {
                if (this.isEnabled) this.stripJpdbFromChipContainers();
                next();
            });
        }

        this.augmentTags();
        Logger.info('[TranslatedTags] Enabled with CentralObserver');
    }

    public disable(): void {
        this.lifecycleGeneration++;
        this.isEnabled = false;
        if (this.augmentFrame !== null) {
            cancelAnimationFrame(this.augmentFrame);
            this.augmentFrame = null;
        }
        this.modifyingDOMCount = 0;
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
        if (this.jpdbGuardCleanup) {
            this.jpdbGuardCleanup();
            this.jpdbGuardCleanup = undefined;
        }
        if (this.routeKeyCleanup) {
            this.routeKeyCleanup();
            this.routeKeyCleanup = undefined;
        }
        if (this.workChangeCleanup) {
            this.workChangeCleanup();
            this.workChangeCleanup = undefined;
        }
        if (this.trackChangeCleanup) {
            this.trackChangeCleanup();
            this.trackChangeCleanup = undefined;
        }
        if (this.langChangeCleanup) {
            this.langChangeCleanup();
            this.langChangeCleanup = undefined;
        }
        this.cancelActiveTranslationQueue();
        this.resetAllTranslationState();
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

    private scheduleAugment(): void {
        if (!this.isEnabled || this.augmentFrame !== null) return;
        const generation = this.lifecycleGeneration;
        this.augmentFrame = requestAnimationFrame(() => {
            this.augmentFrame = null;
            if (!this.isEnabled || generation !== this.lifecycleGeneration) return;
            this.augmentTags();
        });
    }

    private markTranslationPending(el: HTMLElement, original: string, scopeKey?: string): void {
        this.processedElements.add(el);
        el.dataset.asmrtag = original;
        el.dataset.asmrtagState = 'pending';
        delete el.dataset.asmrtagTranslation;
        delete el.dataset.asmrtagPrimary;
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
            const applied = el.dataset.asmrtagTranslation?.trim();
            const primary = el.dataset.asmrtagPrimary?.trim();
            // Only restore if current text is different from original (was modified by translation)
            if (currentText !== original && (
                currentText.includes(original)
                || (!!applied && currentText === applied)
                || (!!primary && currentText === primary)
            )) {
                el.textContent = original;
            }
        }
        this.processedElements.delete(el);
        delete el.dataset.asmrtag;
        delete el.dataset.asmrtagState;
        delete el.dataset.asmrtagUntil;
        delete el.dataset.asmrtagScope;
        delete el.dataset.asmrtagTranslation;
        delete el.dataset.asmrtagPrimary;
        el.classList.remove('asmr-translated');
        el.classList.remove('asmr-worktree-translation');
        // Clean up card/list translation subtitle if present
        const container = el.closest('.ellipsis-3-lines, .ellipsis-2-lines, .text-h6')
            || (el.matches('.q-item__label.text-body2') ? el : null);
        if (container) {
            const sub = container.nextElementSibling;
            if (sub instanceof HTMLElement && sub.classList.contains('asmr-card-translation')) {
                sub.remove();
            }
        }
    }

    private setExpandableCardTranslation(sub: HTMLElement, value: string): void {
        const expanded = sub.classList.contains('asmr-card-translation--expanded');
        const text = document.createElement('span');
        text.className = 'asmr-card-translation-text';
        text.textContent = value;
        const icon = document.createElement('span');
        icon.className = 'material-icons asmr-card-translation-toggle';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = expanded ? 'expand_less' : 'expand_more';

        sub.replaceChildren(text, icon);
        sub.title = value;
        sub.setAttribute('aria-expanded', String(expanded));
        sub.setAttribute('aria-label', I18n.t(expanded ? 'collapseFullTranslation' : 'expandFullTranslation'));

        if (sub.dataset.asmrExpansionBound === 'true') return;
        sub.dataset.asmrExpansionBound = 'true';
        sub.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const isExpanded = sub.classList.toggle('asmr-card-translation--expanded');
            sub.setAttribute('aria-expanded', String(isExpanded));
            sub.setAttribute('aria-label', I18n.t(isExpanded ? 'collapseFullTranslation' : 'expandFullTranslation'));
            const toggle = sub.querySelector<HTMLElement>('.asmr-card-translation-toggle');
            if (toggle) toggle.textContent = isExpanded ? 'expand_less' : 'expand_more';
        });
    }

    private shouldSkipTranslation(el: HTMLElement, currentText: string, scopeKey?: string): boolean {
        if (scopeKey && el.dataset.asmrtagScope && el.dataset.asmrtagScope !== scopeKey) {
            // Scope mismatch - restore original text since Vue may not have re-rendered
            this.clearTranslationPending(el, true);
            return false;
        }
        const state = el.dataset.asmrtagState;
        const tracked = el.dataset.asmrtag;

        // Don't skip pending items: batchTranslatePending() cancels the previous
        // in-flight batch via cancelPending(). If we skip pending items here, they
        // won't be re-queued in the new batch and stay stuck in 'pending' forever.
        // This race is triggered by external DOM mutations (e.g. JPDB annotations)
        // causing CentralObserver to re-run augmentTags() while a batch is in flight.
        if (state === 'pending' && tracked === currentText) return false;

        if (state === 'done' && tracked) {
            if (currentText === tracked || currentText.includes(tracked)) {
                // Worktree translations survive via CSS ::after (data-attribute based)
                if (el.classList.contains('asmr-worktree-translation') && el.dataset.asmrtagTranslation) {
                    return true;
                }
                // Work titles: translation lives in a sibling <div class="asmr-card-translation">.
                // Vue re-render can destroy the sibling while the <a>'s data attributes survive.
                const container = el.closest('.ellipsis-3-lines, .ellipsis-2-lines, .text-h6')
                    || (el.matches('.q-item__label.text-body2') ? el : null);
                if (container) {
                    const sub = container.nextElementSibling;
                    if (sub instanceof HTMLElement && sub.classList.contains('asmr-card-translation') && sub.textContent) {
                        return true;
                    }
                    // Subtitle was removed by Vue re-render — re-translate
                    this.clearTranslationPending(el);
                    return false;
                }
                // Inline translations (chips, anchors, list items):
                // 'done' means a different translation was applied inline (e.g. "original (translation)").
                // If text is exactly the original, Vue's DOM patching stripped the inline suffix.
                if (currentText === tracked) {
                    this.clearTranslationPending(el);
                    return false;
                }
                return true;
            }
            // Content completely changed (Vue reused the element for different data)
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
        if (!this.isEnabled) return;
        const translateMode = !!Config.get('translateMode');
        const cnToJp = !!Config.get('translateCnToJp');
        if (!translateMode && !cnToJp) return;

        // CN-only mode: translateMode off but cnToJp on — only replace Chinese text with Japanese
        const cnOnlyMode = !translateMode && cnToJp;
        const targetLang = cnOnlyMode ? 'ja' : this.targetLang;
        // 'pair' = formatPair(original, translated), 'raw' = translated only, 'worktree' = cleaned + ext
        const pending: PendingTranslationItem[] = [];

        this.beginDOMModification();
        try {
            // 1. Chips (Tags) — known tag matches applied immediately, rest queued
            const chips = Array.from(document.querySelectorAll('.q-chip:not(.asmr-ignore)')) as HTMLElement[];
            for (const chip of chips) {
                // Skip chips in the header search bar — they show raw keyword syntax
                // ($va:NAME$, $tag:NAME$) and modifying their DOM causes duplication
                // and stale text bugs because Vue's vDOM gets out of sync.
                if (chip.closest('.q-header')) continue;

                const content = (chip.querySelector('.q-chip__content') as HTMLElement) || chip;
                const text = this.extractBaseText(content);
                if (!text) continue;

                // Skip if already has a site-provided romanization (e.g. "佐倉江美 (Sakura Emi)")
                if (this.hasExistingRomanization(text)) continue;

                if (this.processedElements.has(chip) && this.shouldSkipTranslation(chip, text)) continue;

                // Try to match with known tags first (fastest — no async needed)
                const vueTag = (chip as HTMLElement & { __vue__?: Record<string, unknown> & { $attrs?: Record<string, unknown> } }).__vue__?.$attrs?.tag as TagEntry | undefined || ((chip as HTMLElement & { __vue__?: Record<string, unknown> }).__vue__?.tag as TagEntry | undefined);
                const dataId = vueTag?.id || chip.getAttribute('data-tag-id') || chip.getAttribute('data-id');
                const match = dataId
                    ? this.tags.find(tag => String(tag.id) === String(dataId))
                    : this.tags.find(tag => tag.ja === text || tag.en === text);

                if (!cnOnlyMode && targetLang === 'en' && match?.en && match.ja !== match.en) {
                    const original = match.ja || match.name || text;
                    const translated = match.en;
                    const formatted = TranslationService.formatPair(original, translated);
                    this.processedElements.add(chip);
                    chip.dataset.asmrtag = text;
                    chip.dataset.asmrtagState = 'done';
                    delete chip.dataset.asmrtagUntil;
                    chip.classList.add('asmr-translated');
                    const chipIcons = Array.from(content.querySelectorAll('i.material-icons, .q-chip__icon'));
                    content.textContent = formatted;
                    for (const icon of chipIcons) content.appendChild(icon);
                    continue;
                }

                // Extract base text (strip ruby furigana) for cleaner translation
                const baseText = this.extractBaseText(content);
                if (this.looksJapanese(baseText) && !this.shouldSkipAutoTranslate(baseText, targetLang)) {
                    if (cnOnlyMode && !isChinese(baseText)) continue;
                    this.markTranslationPending(chip, text);
                    pending.push({ el: chip, originalText: text, translateKey: baseText, format: cnOnlyMode ? 'raw' : 'pair', apply: (v) => {
                        const icons = Array.from(content.querySelectorAll('i.material-icons, .q-chip__icon'));
                        content.textContent = v;
                        for (const icon of icons) content.appendChild(icon);
                    } });
                }
            }

            // 2. List Items (Groups, VAs, work tree files)
            const listItems = Array.from(document.querySelectorAll('.q-item__label:not(.q-item__label--caption)')) as HTMLElement[];
            for (const item of listItems) {
                const text = this.extractBaseText(item);
                if (!text || !this.looksJapanese(text)) continue;
                if (cnOnlyMode && !isChinese(text)) continue;
                const isListing = location.pathname.includes('/circles') || location.pathname.includes('/vas') || location.pathname.includes('/works') || location.pathname.includes('/tags');
                const isWorkTree = item.closest('#work-tree, .work-tree') !== null;
                if (!isListing && !isWorkTree) continue;
                // On /circles and /vas, ListSearchEnhancer handles translations via Vue data exclusively.
                // Skip to avoid race where cancelled batches leave items in permanent "pending" state.
                if (!isWorkTree && (location.pathname === '/circles' || location.pathname === '/vas')) continue;
                // On other listing pages, skip items already augmented by ListSearchEnhancer
                if (isListing && !isWorkTree && this.hasExistingRomanization(text)) continue;
                const scopeKey = isWorkTree ? this.getCurrentWorkTreeKey() : undefined;
                if (this.processedElements.has(item) && this.shouldSkipTranslation(item, text, scopeKey)) continue;

                this.markTranslationPending(item, text, scopeKey);
                if (isWorkTree) {
                    const fileInfo = this.getFileTranslationInfo(text);
                    const translateKey = fileInfo ? fileInfo.input : text;
                    pending.push({ el: item, originalText: text, translateKey, format: 'worktree', fileExt: fileInfo?.ext || '', scopeKey, apply: (v, display) => {
                        if (display?.sourceLanguage === 'zh' && display.primaryLanguage === 'ja') {
                            item.textContent = v;
                            item.title = `${text} (${v})`;
                            item.classList.remove('asmr-worktree-translation');
                            delete item.dataset.asmrtagTranslation;
                        } else {
                            this.applyWorkTreeTranslation(item, text, v);
                        }
                    } });
                } else if (!this.shouldSkipAutoTranslate(text, targetLang)) {
                    pending.push({ el: item, originalText: text, translateKey: text, format: cnOnlyMode ? 'raw' : 'pair', scopeKey, apply: (v) => { item.textContent = v; } });
                }
            }

            // 3. Breadcrumbs
            const breadcrumbs = Array.from(document.querySelectorAll('#work-tree .q-breadcrumbs__el span, .work-tree .q-breadcrumbs__el span')) as HTMLElement[];
            for (const span of breadcrumbs) {
                const rawText = this.extractBaseText(span);
                const text = this.stripLegacyInlineTranslationSuffix(rawText);
                if (text !== rawText) {
                    // Legacy behavior translated breadcrumb text inline.
                    // Restore clean base text before applying worktree-style suffix translation.
                    this.clearTranslationPending(span);
                    span.textContent = text;
                }
                if (!text || !this.looksJapanese(text)) continue;
                if (cnOnlyMode && !isChinese(text)) continue;
                const scopeKey = this.getCurrentWorkTreeKey();
                if (this.processedElements.has(span) && this.shouldSkipTranslation(span, text, scopeKey)) continue;
                if (this.shouldSkipAutoTranslate(text, targetLang)) continue;

                this.markTranslationPending(span, text, scopeKey);
                if (cnOnlyMode) {
                    pending.push({ el: span, originalText: text, translateKey: text, format: 'raw', scopeKey, apply: (v) => { span.textContent = v; } });
                } else {
                    pending.push({ el: span, originalText: text, translateKey: text, format: 'worktree', scopeKey, apply: (v, display) => {
                        if (display?.sourceLanguage === 'zh' && display.primaryLanguage === 'ja') {
                            span.textContent = v;
                            span.title = `${text} (${v})`;
                            span.classList.remove('asmr-worktree-translation');
                            delete span.dataset.asmrtagTranslation;
                        } else {
                            this.applyWorkTreeTranslation(span, text, v);
                        }
                    } });
                }
            }

            // 4. Anchors
            const anchors = Array.from(document.querySelectorAll('a[href*="/circles/"], a[href*="/authors/"], a[href*="/actors/"], a[href*="/vas/"], a[href*="/cv/"]')) as HTMLAnchorElement[];
            for (const anchor of anchors) {
                const text = this.extractBaseText(anchor);
                if (!text) continue;
                if (this.hasExistingRomanization(text)) continue;
                if (!this.looksJapanese(text)) continue;
                if (cnOnlyMode && !isChinese(text)) continue;
                if (this.processedElements.has(anchor) && this.shouldSkipTranslation(anchor, text)) continue;
                if (this.shouldSkipAutoTranslate(text, targetLang)) continue;

                this.markTranslationPending(anchor, text);
                pending.push({ el: anchor, originalText: text, translateKey: text, format: cnOnlyMode ? 'raw' : 'pair', apply: (v) => { anchor.textContent = v; } });
            }

            // 5. Work Card Circles / Studios
            const cardMetaNames = Array.from(document.querySelectorAll('.text-subtitle1 .text-grey.ellipsis')) as HTMLElement[];
            for (const el of cardMetaNames) {
                const text = this.extractBaseText(el);
                if (!text) continue;
                if (this.hasExistingRomanization(text)) continue;
                if (!this.looksJapanese(text)) continue;
                if (cnOnlyMode && !isChinese(text)) continue;
                if (this.processedElements.has(el) && this.shouldSkipTranslation(el, text)) continue;
                if (this.shouldSkipAutoTranslate(text, targetLang)) continue;

                this.markTranslationPending(el, text);
                pending.push({ el, originalText: text, translateKey: text, format: cnOnlyMode ? 'raw' : 'pair', apply: (v) => { el.textContent = v; } });
            }

            // 6. Work Titles — keep original, show translated subtitle below
            const workTitles = Array.from(document.querySelectorAll('.ellipsis-3-lines a[href*="/work/"], .ellipsis-2-lines a[href*="/work/"], .q-card .text-h6 a[href*="/work/"], .q-card a[href*="/work/"] .text-weight-medium')) as HTMLElement[];
            for (const el of workTitles) {
                // Use extractBaseText to ignore JPDB furigana <rt> annotations —
                // raw textContent includes interleaved readings (e.g. "生せい耳みみ")
                // which would mismatch against the tracked original.
                const text = this.extractBaseText(el);
                if (!text || !this.looksJapanese(text)) continue;
                if (cnOnlyMode && !isChinese(text)) continue;
                if (this.processedElements.has(el) && this.shouldSkipTranslation(el, text)) continue;

                this.markTranslationPending(el, text);
                if (cnOnlyMode) {
                    // CN→JP: silently replace title text with Japanese
                    pending.push({ el, originalText: text, translateKey: text, format: 'raw', apply: (v) => { el.textContent = v; } });
                } else {
                    pending.push({ el, originalText: text, translateKey: text, format: 'raw', apply: (v, display) => {
                        const promotedChinese = display?.sourceLanguage === 'zh' && display.primaryLanguage === 'ja';
                        if (promotedChinese) el.textContent = display.primaryText;
                        const container = el.closest('.ellipsis-3-lines, .ellipsis-2-lines, .text-h6') as HTMLElement;
                        if (container && container.parentElement) {
                            let sub = container.nextElementSibling as HTMLElement;
                            if (!sub || !sub.classList.contains('asmr-card-translation')) {
                                sub = document.createElement('button');
                                (sub as HTMLButtonElement).type = 'button';
                                sub.className = 'asmr-card-translation';
                                container.after(sub);
                            }
                            const secondary = promotedChinese ? display.secondaryText : v;
                            if (secondary) this.setExpandableCardTranslation(sub, secondary);
                            else sub.remove();
                        }
                        el.title = promotedChinese
                            ? `${text} (${display.primaryText}${display.secondaryText ? ` — ${display.secondaryText}` : ''})`
                            : v;
                    } });
                }
            }

            // 6b. Work Titles in list view (favourites, reviews, playlists, etc.)
            // List view uses .q-item layout with .q-item__label.text-body2 instead of card layout
            const listWorkLabels = document.querySelectorAll('.q-list .q-item__label.text-body2') as NodeListOf<HTMLElement>;
            for (const el of listWorkLabels) {
                // Only process work items — verify parent .q-item has a work link
                const qItem = el.closest('.q-item');
                if (!qItem || !qItem.querySelector('a[href*="/work/"]')) continue;
                if (this.processedElements.has(el)) {
                    if (this.shouldSkipTranslation(el, this.extractBaseText(el))) continue;
                }

                const text = this.extractBaseText(el);
                if (!text || !this.looksJapanese(text)) continue;
                if (cnOnlyMode && !isChinese(text)) continue;
                if (this.shouldSkipAutoTranslate(text, targetLang)) continue;

                this.markTranslationPending(el, text);
                if (cnOnlyMode) {
                    pending.push({ el, originalText: text, translateKey: text, format: 'raw', apply: (v) => { el.textContent = v; } });
                } else {
                    pending.push({ el, originalText: text, translateKey: text, format: 'raw', apply: (v, display) => {
                        const promotedChinese = display?.sourceLanguage === 'zh' && display.primaryLanguage === 'ja';
                        if (promotedChinese) el.textContent = display.primaryText;
                        let sub = el.nextElementSibling as HTMLElement;
                        if (!sub || !sub.classList.contains('asmr-card-translation')) {
                            sub = document.createElement('button');
                            (sub as HTMLButtonElement).type = 'button';
                            sub.className = 'asmr-card-translation';
                            el.after(sub);
                        }
                        const secondary = promotedChinese ? display.secondaryText : v;
                        if (secondary) this.setExpandableCardTranslation(sub, secondary);
                        else sub.remove();
                        el.title = promotedChinese
                            ? `${text} (${display.primaryText}${display.secondaryText ? ` — ${display.secondaryText}` : ''})`
                            : v;
                    } });
                }
            }

        } finally {
            this.endDOMModification();
        }

        // Pass 2: batch-translate all collected texts in one call
        if (pending.length > 0) {
            const queueKey = this.buildTranslationQueueKey();
            const generation = ++this.translationGeneration;
            this.activeQueueKey = queueKey;
            this.batchTranslatePending(
                pending,
                targetLang,
                queueKey,
                generation,
                cnOnlyMode ? 'zh' : 'auto',
            );
        }
    }

    /**
     * Returns true if autoTranslate would return the text unchanged (user's own language).
     */
    private shouldSkipAutoTranslate(text: string, targetLang: string): boolean {
        // Han-only Japanese titles/tags are ambiguous to a generic language
        // detector. On ASMR.one these content surfaces are Japanese-first, so
        // still send them through JP→ZH instead of silently treating them as
        // already-Chinese and leaving them untranslated.
        if (targetLang.toLowerCase().startsWith('zh')
            && /[\u4e00-\u9fff]/.test(text)
            && !/[\u3040-\u30ff]/.test(text)) {
            return false;
        }
        return TranslationService.isTargetLanguage(text, targetLang);
    }

    /**
     * Batch-translate all pending items with a single translateBatch() call,
     * then apply results back to their elements with the appropriate formatting.
     */
    private batchTranslatePending(
        pending: PendingTranslationItem[],
        targetLang: string,
        queueKey: string,
        generation: number,
        sourceLanguageHint: ContentSourceHint,
    ): void {
        const grouped = new Map<Exclude<ContentSourceHint, 'auto'>, PendingTranslationItem[]>();
        for (const item of pending) {
            const hint = this.resolveContentSourceHint(item, sourceLanguageHint);
            const items = grouped.get(hint) || [];
            items.push(item);
            grouped.set(hint, items);
        }

        TranslationService.cancelPending({ cancellableKey: queueKey });
        for (const [hint, sourceItems] of grouped) {
            const uniqueKeys: string[] = [];
            const keySet = new Set<string>();
            for (const item of sourceItems) {
                if (!keySet.has(item.translateKey)) {
                    keySet.add(item.translateKey);
                    uniqueKeys.push(item.translateKey);
                }
            }

            TranslationService.translateForDisplayBatch(uniqueKeys, targetLang, {
                priority: TAG_TRANSLATION_PRIORITY,
                cancellable: true,
                cancellableKey: queueKey,
                sourceLanguageHint: hint,
            }).then(results => {
                if (!this.isEnabled || generation !== this.translationGeneration || this.activeQueueKey !== queueKey) {
                    return;
                }
                const translationMap = new Map<string, DisplayTranslationResult>();
                for (let i = 0; i < uniqueKeys.length; i++) {
                    if (results[i]) translationMap.set(uniqueKeys[i], results[i]);
                }

                for (const item of sourceItems) {
                    const display = translationMap.get(item.translateKey);
                    if (!display) {
                        this.finalizeTranslation(item.el, item.originalText, null, item.apply, item.scopeKey);
                        continue;
                    }

                    const promotedChinese = display.sourceLanguage === 'zh'
                        && display.primaryLanguage === 'ja'
                        && display.primaryText !== item.translateKey;
                    const translated = display.secondaryText || display.primaryText;

                    let formatted: string;
                    switch (item.format) {
                        case 'pair':
                            formatted = promotedChinese
                                ? (display.secondaryText
                                    ? TranslationService.formatPair(display.primaryText, display.secondaryText)
                                    : display.primaryText)
                                : TranslationService.formatPair(item.translateKey, translated);
                            break;
                        case 'worktree': {
                            const cleaned = TranslationService.cleanQuotes(
                                promotedChinese ? display.primaryText : translated,
                            ) + (item.fileExt || '');
                            formatted = promotedChinese && display.secondaryText
                                ? TranslationService.formatPair(cleaned, display.secondaryText)
                                : cleaned;
                            break;
                        }
                        case 'raw':
                            formatted = promotedChinese ? display.primaryText : translated;
                            break;
                    }

                    this.finalizeTranslation(
                        item.el,
                        item.originalText,
                        formatted,
                        (value) => item.apply(value, display),
                        item.scopeKey,
                        promotedChinese ? display.primaryText : undefined,
                    );
                }
            }).catch(err => {
                if (!this.isEnabled || generation !== this.translationGeneration || this.activeQueueKey !== queueKey) {
                    return;
                }
                Logger.debug('[TranslatedTags] Batch translation failed:', err);
                for (const item of sourceItems) {
                    if (item.el.dataset.asmrtagState === 'pending') {
                        this.clearTranslationPending(item.el);
                    }
                }
            });
        }
    }

    /**
     * ASMR.one content is Japanese-first, so an unannotated Han-only title is
     * Japanese rather than Chinese by default. Respect explicit edition/DOM
     * metadata so known Chinese editions still take the CN -> JP path.
     */
    private resolveContentSourceHint(
        item: PendingTranslationItem,
        fallback: ContentSourceHint,
    ): Exclude<ContentSourceHint, 'auto'> {
        if (fallback !== 'auto') return fallback;

        const metadataBoundary = item.el.closest<HTMLElement>(
            '.q-card, .q-item, #work-tree, .work-tree',
        ) || item.el;
        let annotated: HTMLElement | null = item.el;
        while (annotated) {
            const annotatedHint = this.normalizeContentLanguage(
                annotated.getAttribute('lang')
                || annotated.dataset.sourceLanguage
                || annotated.dataset.language
                || annotated.dataset.lang,
            );
            if (annotatedHint !== 'auto') return annotatedHint;
            if (annotated === metadataBoundary) break;
            annotated = annotated.parentElement;
        }

        const host = item.el.closest<HTMLElement>('.q-card, .q-item');
        const vm = (host as (HTMLElement & { __vue__?: Record<string, unknown> }) | null)?.__vue__;
        if (vm) {
            const candidates = [vm.work, vm.item, vm.$props, vm.$attrs, vm.$data];
            for (const candidate of candidates) {
                const hint = this.readWorkLanguageHint(candidate);
                if (hint !== 'auto') return hint;
            }
        }

        if (location.pathname.includes('/work/')) {
            const hint = this.readWorkLanguageHint(this.bridge.currentWork);
            if (hint !== 'auto') return hint;
        }

        return 'ja';
    }

    private readWorkLanguageHint(value: unknown): ContentSourceHint {
        if (!value || typeof value !== 'object') return 'auto';
        const record = value as Record<string, unknown>;
        const nestedWork = record.work;
        if (nestedWork && nestedWork !== value) {
            const nestedHint = this.readWorkLanguageHint(nestedWork);
            if (nestedHint !== 'auto') return nestedHint;
        }
        const translationInfo = record.translation_info;
        if (translationInfo && typeof translationInfo === 'object') {
            const info = translationInfo as Record<string, unknown>;
            const hint = this.normalizeContentLanguage(info.lang);
            if (hint !== 'auto') return hint;
            if (info.is_original === true) return 'ja';
        }
        return this.normalizeContentLanguage(
            record.source_language || record.sourceLanguage || record.language || record.lang,
        );
    }

    private normalizeContentLanguage(value: unknown): ContentSourceHint {
        const normalized = String(value || '').trim().toUpperCase();
        if (!normalized) return 'auto';
        if (normalized.includes('CHI') || normalized.includes('ZH') || normalized === 'CN') return 'zh';
        if (normalized.includes('JPN') || normalized.includes('JA') || normalized === 'JP') return 'ja';
        return 'auto';
    }

    private finalizeTranslation(
        el: HTMLElement,
        original: string,
        translated: string | null | undefined,
        apply: (value: string) => void,
        scopeKey?: string,
        primaryText?: string,
    ): void {
        if (!translated || translated === original) {
            const retryDelay = TranslationService.isRateLimited() ? 60000 : 15000;
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
        // Use extractBaseText to ignore ruby annotations (from FuriganaRenderer)
        // and icon ligatures when comparing — the underlying text is unchanged.
        const currentText = this.extractBaseText(el);
        if (currentText !== original) {
            this.clearTranslationPending(el);
            return;
        }

        this.beginDOMModification();
        try {
            apply(translated);
            el.dataset.asmrtag = original;
            el.dataset.asmrtagTranslation = translated;
            if (primaryText) el.dataset.asmrtagPrimary = primaryText;
            else delete el.dataset.asmrtagPrimary;
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
        if (!this.isEnabled) return;
        const target = e.target as HTMLInputElement;
        if (this.isSearchInput(target)) {
            target.classList.add('asmr-ignore');
        }
    }

    private handleKeydown(e: KeyboardEvent): void {
        if (!this.isEnabled) return;
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

    /**
     * Extract base text from element, removing ruby annotation content (rt/rp).
     * VA/circle names use <ruby>佐<rt>さ</rt></ruby> — textContent gives
     * garbled "佐さ倉くら江え美み", this returns clean "佐倉江美".
     */
    private extractBaseText(el: HTMLElement): string {
        if (!el.querySelector('rt, i.material-icons, .q-chip__icon')) {
            return (el.textContent || '').trim();
        }
        const clone = el.cloneNode(true) as HTMLElement;
        for (const node of clone.querySelectorAll('rt, rp, i.material-icons, .q-chip__icon')) node.remove();
        return (clone.textContent || '').trim();
    }

    /**
     * Strip JPDB browser extension's DOM annotations from elements containing
     * Vue-managed chips. JPDB wraps CJK text in
     * `<span class="jpdb-word"><ruby>...<rt>furigana</rt></ruby></span>`,
     * which breaks Vue's virtual DOM patching — Vue can't diff through foreign
     * DOM nodes, causing stale text from previous searches to persist across
     * route changes.
     *
     * Must run BEFORE Vue patches (e.g. in a beforeEach guard) so Vue finds
     * clean text nodes to reconcile against its virtual DOM.
     */
    private stripJpdbFromChipContainers(): void {
        const containers = document.querySelectorAll<HTMLElement>('[data-jpdb]');
        for (const el of containers) {
            if (!el.querySelector('.q-chip')) continue;
            const jpdbWords = el.querySelectorAll<HTMLElement>('.jpdb-word');
            if (jpdbWords.length === 0) continue;

            this.beginDOMModification();
            try {
                for (const span of jpdbWords) {
                    const text = this.extractBaseText(span);
                    span.replaceWith(text);
                }
                el.removeAttribute('data-jpdb');
                el.removeAttribute('data-jpdb-original');
            } finally {
                this.endDOMModification();
            }
        }
    }

    /**
     * Check if text already includes a parenthesized Latin romanization.
     * Site-provided: "佐倉江美 (Sakura Emi)" — skip to avoid double translation.
     */
    private hasExistingRomanization(text: string): boolean {
        return /\([A-Za-z][-A-Za-z\s.,!?;:'"…()]*\)\s*$/.test(text);
    }

    /**
     * Removes trailing inline translation payloads from legacy pair format:
     * "Japanese (...English...)" => "Japanese".
     *
     * This is intentionally conservative:
     * - Only strips trailing parenthesized chunks that contain Latin letters.
     * - Leaves chunks that still contain CJK (e.g. "(CV: 田中)") untouched.
     */
    private stripLegacyInlineTranslationSuffix(text: string): string {
        let next = text.trim();
        while (next.length > 0) {
            const match = next.match(/^(.*)\s+\(([^()]*)\)\s*$/);
            if (!match) break;
            const body = match[2].trim();
            if (!body || !/[A-Za-z]/.test(body)) break;
            if (/[\u3040-\u30ff\u4e00-\u9faf]/.test(body)) break;
            next = match[1].trim();
        }
        return next;
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
        // Use extractBaseText to ignore furigana ruby annotations when comparing.
        const currentText = this.extractBaseText(el);
        if (currentText !== original) {
            el.textContent = original;
        }
        el.dataset.asmrtagTranslation = translated;
        el.classList.add('asmr-worktree-translation');
    }

    private get targetLang(): string {
        return I18n.lang === 'zh' ? 'zh-CN' : I18n.lang;
    }

    private resetAllTranslationState(): void {
        const translated = document.querySelectorAll<HTMLElement>(
            '[data-asmrtag], [data-asmrtag-state], [data-asmrtag-scope], [data-asmrtag-translation], .asmr-translated, .asmr-worktree-translation',
        );
        for (const el of translated) this.clearTranslationPending(el, true);
        document.querySelectorAll('.asmr-card-translation').forEach((el) => el.remove());
    }

    private resetWorkTreeTranslationState(): void {
        this.processedElements = new WeakSet<HTMLElement>();
        // Reset all translated elements - restore original text since Vue may not re-render
        // reused DOM elements when navigating between folders
        const roots = document.querySelectorAll('#work-tree, .work-tree, .q-page, .q-layout');
        roots.forEach(root => {
            root.querySelectorAll<HTMLElement>('[data-asmrtag], [data-asmrtag-state], [data-asmrtag-scope], [data-asmrtag-translation], .asmr-translated, .asmr-worktree-translation')
                .forEach(el => this.clearTranslationPending(el, true));
        });
        Logger.debug('[TranslatedTags] Reset work-tree translation state (restored originals)');
    }

    private resetPlayerTranslationState(): void {
        const roots = document.querySelectorAll('.audio-player, .player-bar, .player-bar-container, .current-play-list');
        roots.forEach(root => {
            root.querySelectorAll<HTMLElement>('[data-asmrtag], [data-asmrtag-state], [data-asmrtag-scope], [data-asmrtag-translation], .asmr-translated, .asmr-worktree-translation')
                .forEach(el => this.clearTranslationPending(el, true));
        });
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

    private buildTranslationQueueKey(routeKey?: string): string {
        const key = routeKey || this.getCurrentWorkTreeKey() || 'global';
        return `translated-tags:${key}`;
    }

    private cancelTranslationQueueForRouteKey(routeKey?: string): void {
        if (!routeKey) return;
        TranslationService.cancelPending({ cancellableKey: this.buildTranslationQueueKey(routeKey) });
    }

    private cancelActiveTranslationQueue(): void {
        this.translationGeneration++;
        if (!this.activeQueueKey) return;
        TranslationService.cancelPending({ cancellableKey: this.activeQueueKey });
        this.activeQueueKey = '';
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
