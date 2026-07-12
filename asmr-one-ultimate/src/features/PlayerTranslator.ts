import { CentralObserver } from '../core/CentralObserver';
import { TIMING } from '../core/Constants';
import { TranslationService } from '../services/TranslationService';
import { I18n } from '../core/Utils';
import { PLAYER_BAR_SELECTOR, isChinese, getCleanText, stripJpdbAnnotations } from '../core/DomUtils';
import { AppStore } from '../store/AppStore';
import { EventBus } from '../core/EventBus';
import { KikoeruBridge } from '../infrastructure/KikoeruBridge';

export class PlayerTranslator {
    private bridge = KikoeruBridge.getInstance();
    private trackChangeCleanup?: () => void;
    private workChangeCleanup?: () => void;
    private configChangeCleanup?: () => void;
    private langChangeCleanup?: () => void;
    private storeWatchCleanups: Array<() => void> = [];
    private _enabled = false;
    private retryTimers: ReturnType<typeof setTimeout>[] = [];
    private retryFrame: number | null = null;
    /** Incremented on every track/work change to invalidate stale async callbacks */
    private _epoch = 0;

    public enable(): void {
        if (this._enabled) return;
        this._enabled = true;
        // Register with central observer instead of own MutationObserver
        CentralObserver.register('PlayerTranslator', () => this.checkPlayer(), TIMING.OBSERVER_REGISTER_DEBOUNCE_MS);

        // Translate immediately on track change instead of waiting for observer debounce
        this.trackChangeCleanup = EventBus.on('track:change', ({ track }) => {
            this.onTrackOrWorkChange(track?.title || '', this.getCurrentWorkTitle());
        });

        // Also re-translate when the work itself changes (different RJ code).
        // Don't seed track title from work:change because currentTrack can still be stale.
        this.workChangeCleanup = EventBus.on('work:change', ({ work }) => {
            this.onTrackOrWorkChange('', work?.title || this.getCurrentWorkTitle());
        });

        const store = this.bridge.store;
        if (store?.watch) {
            const unwatchTrack = store.watch(
                (state) => state.AudioPlayer?.currentTrack?.hash
                    || state.AudioPlayer?.currentPlayingFile?.hash
                    || state.AudioPlayer?.currentTrack?.src
                    || state.AudioPlayer?.currentPlayingFile?.src
                    || state.AudioPlayer?.currentTrack?.title
                    || state.AudioPlayer?.currentPlayingFile?.title
                    || '',
                () => this.onTrackOrWorkChange(this.getCurrentTrackTitle(), this.getCurrentWorkTitle()),
            );
            if (typeof unwatchTrack === 'function') this.storeWatchCleanups.push(unwatchTrack);

            const unwatchWork = store.watch(
                (state) => state.AudioPlayer?.work?.id || '',
                () => this.onTrackOrWorkChange('', this.getCurrentWorkTitle()),
            );
            if (typeof unwatchWork === 'function') this.storeWatchCleanups.push(unwatchWork);
        }

        this.configChangeCleanup = EventBus.on('config:change', ({ key }) => {
            if (key !== 'translateMode' && key !== 'translateCnToJp') return;
            this.onTrackOrWorkChange(this.getCurrentTrackTitle(), this.getCurrentWorkTitle());
        });
        this.langChangeCleanup = EventBus.on('lang:change', () => {
            this.onTrackOrWorkChange(this.getCurrentTrackTitle(), this.getCurrentWorkTitle());
        });

        // The player may already be mounted before this feature is enabled and
        // therefore produce no subsequent mutation for CentralObserver to see.
        this.onTrackOrWorkChange(this.getCurrentTrackTitle(), this.getCurrentWorkTitle());
    }

    public disable(): void {
        this._epoch++;
        this._enabled = false;
        CentralObserver.unregister('PlayerTranslator');
        this.trackChangeCleanup?.();
        this.trackChangeCleanup = undefined;
        this.workChangeCleanup?.();
        this.workChangeCleanup = undefined;
        this.configChangeCleanup?.();
        this.configChangeCleanup = undefined;
        this.langChangeCleanup?.();
        this.langChangeCleanup = undefined;
        this.clearRetryTimers();
        for (const cleanup of this.storeWatchCleanups) cleanup();
        this.storeWatchCleanups = [];
        this.resetTranslationState();
    }

    /**
     * Handle track or work change: clear stale translation state and
     * schedule multiple retry attempts to catch Vue re-renders.
     */
    private onTrackOrWorkChange(nextTrackTitle = '', nextWorkTitle = ''): void {
        if (!this._enabled) return;
        this._epoch++;
        this.clearRetryTimers();
        // Strip jpdb ruby annotations BEFORE resetting translation state.
        // jpdb replaces Vue's tracked text nodes with <span class="jpdb-word"><ruby>...</ruby></span>.
        // Without stripping, Vue writes to detached text nodes on track change → stale DOM.
        this.stripPlayerJpdb();
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
        if (nextWorkTitle) {
            this.seedWorkTitle(nextWorkTitle);
        }
        // Multiple attempts: Vue re-renders asynchronously and may take varying time.
        // rAF catches immediate renders, 200ms/500ms/1000ms catch slower transitions.
        this.retryFrame = requestAnimationFrame(() => {
            this.retryFrame = null;
            if (!this._enabled) return;
            void this.checkPlayer();
        });
        for (const delay of [200, 500, 1000]) {
            this.retryTimers.push(setTimeout(() => this.checkPlayer(), delay));
        }
    }

    private clearRetryTimers(): void {
        if (this.retryFrame !== null) {
            cancelAnimationFrame(this.retryFrame);
            this.retryFrame = null;
        }
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
        // Cover all player surfaces: miniplayer bar, expanded player, and queue dialog
        const containers = document.querySelectorAll<HTMLElement>(
            `${PLAYER_BAR_SELECTOR}, .audio-player, .current-play-list`
        );

        for (const container of containers) {
            const els = container.querySelectorAll<HTMLElement>('[data-asmr-translated]');
            for (const el of els) {
                const source = el.dataset.asmrSource;
                const translated = el.dataset.asmrTranslatedText;
                // CN→JP mode replaces textContent rather than using the
                // translation-pair pseudo-element. Restore that exact
                // replacement when the feature is disabled or reset.
                if (source && translated && !el.classList.contains('asmr-translation-pair')
                    && (el.textContent || '').trim() === translated.trim()) {
                    el.textContent = source;
                }
                // With ::after approach we never modify textContent for translations,
                // so no need to restore — just clear our data attributes and class.
                el.title = '';
                el.classList.remove('asmr-translation-pair');
                delete el.dataset.asmrTranslated;
                delete el.dataset.asmrSource;
                delete el.dataset.asmrTranslatedText;
            }

            // Also clear TranslatedTags state in player surfaces.
            // Footer/player rows can be DOM-reused between track changes, and stale
            // data-asmrtag* attributes keep old translated titles visible via ::after.
            const translatedTagEls = container.querySelectorAll<HTMLElement>(
                '[data-asmrtag], [data-asmrtag-state], [data-asmrtag-scope], [data-asmrtag-translation], .asmr-translated, .asmr-worktree-translation'
            );
            for (const el of translatedTagEls) {
                const original = el.dataset.asmrtag;
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
            }

            const stableTitleEls = container.querySelectorAll<HTMLElement>(
                '.asmr-mini-title-ellipsis, .asmr-mini-title-ellipsis-content, .asmr-mini-title-ellipsis-container'
            );
            for (const stableTitleEl of stableTitleEls) {
                stableTitleEl.classList.remove(
                    'asmr-mini-title-ellipsis',
                    'asmr-mini-title-ellipsis-content',
                    'asmr-mini-title-ellipsis-container',
                );
            }
        }
    }

    /**
     * Strip jpdb furigana annotations from all player containers.
     * Called before Vue re-renders on track change to restore text nodes
     * that jpdb detached by injecting <ruby>/<span> wrappers.
     */
    private stripPlayerJpdb(): void {
        for (const sel of [PLAYER_BAR_SELECTOR, '.audio-player', '.current-play-list']) {
            const el = document.querySelector(sel);
            if (el) stripJpdbAnnotations(el);
        }
    }

    private async checkPlayer() {
        if (!this._enabled) return;
        const translateMode = !!AppStore.getConfig('translateMode');
        const cnToJp = !!AppStore.getConfig('translateCnToJp');
        if (!translateMode && !cnToJp) return;

        const cnOnlyMode = !translateMode && cnToJp;
        const tasks: Promise<void>[] = [];

        // Process all player surfaces (miniplayer bar + expanded player)
        const containers = document.querySelectorAll<HTMLElement>(
            `${PLAYER_BAR_SELECTOR}, .audio-player`
        );
        for (const playerBar of containers) {
            const trackNameEl = this.findTrackNameElement(playerBar);
            const titleEl = playerBar.querySelector('.q-toolbar__title, .text-h6, .text-weight-bold.text-body1') as HTMLElement;
            const artistEl = this.findSubtitleElement(playerBar, trackNameEl);

            if (titleEl) tasks.push(this.translateElement(titleEl, 'title', cnOnlyMode));
            if (artistEl) tasks.push(this.translateElement(artistEl, 'artist', cnOnlyMode));
            if (trackNameEl) tasks.push(this.translateTrackName(trackNameEl, cnOnlyMode));
        }

        // Queue dialog items (only when the dialog is visible/rendered)
        const queueList = document.querySelector('.current-play-list .q-list');
        if (queueList) {
            const queueItems = queueList.querySelectorAll<HTMLElement>('.q-item');
            for (const item of queueItems) {
                const titleLabel = item.querySelector('.q-item__label:not(.q-item__label--caption)') as HTMLElement;
                const captionLabel = item.querySelector('.q-item__label--caption') as HTMLElement;
                if (titleLabel) tasks.push(this.translateTrackName(titleLabel, cnOnlyMode));
                if (captionLabel) tasks.push(this.translateElement(captionLabel, 'title', cnOnlyMode));
            }
        }

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
            const rawText = getCleanText(el);
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

    private getCurrentWorkTitle(): string {
        try {
            return (AppStore.currentWork?.title || '').trim();
        } catch {
            return '';
        }
    }

    private seedTrackTitle(nextTrackTitle: string): void {
        // Seed track title across all player surfaces
        const containers = document.querySelectorAll<HTMLElement>(
            `${PLAYER_BAR_SELECTOR}, .audio-player`
        );
        for (const playerBar of containers) {
            const el = this.findTrackNameElement(playerBar);
            if (!el) continue;

            const rawText = getCleanText(el);
            if (!rawText || rawText === nextTrackTitle) continue;

            el.textContent = nextTrackTitle;
            el.title = '';
        }
    }

    private seedWorkTitle(nextWorkTitle: string): void {
        const containers = document.querySelectorAll<HTMLElement>(
            `${PLAYER_BAR_SELECTOR}, .audio-player`
        );
        for (const playerBar of containers) {
            const trackEl = this.findTrackNameElement(playerBar);
            const subtitleEl = this.findSubtitleElement(playerBar, trackEl);
            if (!subtitleEl) continue;
            const rawText = getCleanText(subtitleEl);
            if (!rawText || rawText === nextWorkTitle || rawText.includes(nextWorkTitle)) continue;
            subtitleEl.textContent = nextWorkTitle;
            subtitleEl.title = '';
        }
    }

    private findSubtitleElement(playerBar: Element, trackNameEl: HTMLElement | null): HTMLElement | null {
        const candidates = Array.from(
            playerBar.querySelectorAll<HTMLElement>('.text-subtitle2, .text-caption, .text-grey-5')
        ).filter((el) => !el.closest('.q-item'));
        if (candidates.length === 0) return null;

        const currentWorkTitle = this.getCurrentWorkTitle();
        let best: HTMLElement | null = null;
        let bestScore = Number.NEGATIVE_INFINITY;

        for (const el of candidates) {
            const text = getCleanText(el);
            if (!text) continue;

            let score = 0;
            const source = el.dataset.asmrSource?.trim() || '';
            if (el.dataset.asmrTranslated === 'true') score += 10;
            if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(text)) score -= 60;
            if (/^\d+(?:\.\d+)?\s*(?:MB|GB|KB|kHz|Hz|fps)?$/i.test(text)) score -= 30;

            if (currentWorkTitle) {
                if (text === currentWorkTitle || source === currentWorkTitle) {
                    score += 130;
                } else if (
                    text.includes(currentWorkTitle) ||
                    source.includes(currentWorkTitle) ||
                    currentWorkTitle.includes(text)
                ) {
                    score += 70;
                }
            }

            if (/[\u3040-\u30ff\u4e00-\u9faf]/.test(text)) score += 12;

            if (trackNameEl) {
                const sameGroup = trackNameEl.parentElement && el.parentElement === trackNameEl.parentElement;
                if (sameGroup) score += 30;
                const relation = trackNameEl.compareDocumentPosition(el);
                if (relation & Node.DOCUMENT_POSITION_FOLLOWING) score += 12;
            }

            if (score > bestScore) {
                bestScore = score;
                best = el;
            }
        }

        return best;
    }

    private async translateElement(el: HTMLElement, type: 'title' | 'artist', cnOnlyMode = false) {
        if (!this._enabled || !el.isConnected) return;
        const rawText = getCleanText(el);
        if (!rawText) return;

        // In CN-only mode, skip non-Chinese text
        if (cnOnlyMode && !isChinese(rawText)) return;

        const source = el.dataset.asmrSource;
        const translatedText = el.dataset.asmrTranslatedText;
        // With ::after, translated text is in CSS pseudo-element, not in textContent.
        // If the source text still matches, the translation is still valid.
        if (el.dataset.asmrTranslated === 'true' && source && translatedText) {
            if (rawText === source) return;
        }

        const text = source && rawText === source ? source : rawText;
        if (!text) return;

        const epoch = this._epoch;
        const targetLang = cnOnlyMode ? 'ja' : (I18n.lang === 'zh' ? 'zh-CN' : I18n.lang);
        const sourceLanguageHint = cnOnlyMode
            ? 'zh'
            : type === 'title'
                ? this.getCurrentWorkSourceHint()
                : 'auto';
        try {
            const translated = await TranslationService.translate(text, targetLang, {
                sourceLanguageHint,
            });
            if (!this._enabled || this._epoch !== epoch || !el.isConnected) return;
            const currentText = getCleanText(el);
            if (currentText !== text && currentText !== rawText) return;
            if (translated && translated !== text) {
                if (cnOnlyMode) {
                    // CN→JP: silently replace text content
                    el.textContent = translated;
                    el.dataset.asmrTranslated = 'true';
                    el.dataset.asmrSource = text;
                    el.dataset.asmrTranslatedText = translated;
                    el.title = `${text} (${translated})`;
                    this.applyStableMiniTitleLayout(el);
                } else {
                    this.updateElement(el, text, translated);
                }
            } else {
                this.markOriginal(el, text);
            }
        } catch {
            if (!this._enabled || this._epoch !== epoch || !el.isConnected) return;
            this.markOriginal(el, text);
        }
    }

    /**
     * Translate the track filename shown in the player.
     * Strips number prefix and file extension, translates the core text,
     * then displays as "Original (Translated)" using updateElement.
     */
    private async translateTrackName(el: HTMLElement, cnOnlyMode = false) {
        if (!this._enabled || !el.isConnected) return;
        const rawText = getCleanText(el);
        if (!rawText) return;

        // Already translated — skip if source text unchanged (::after handles display)
        if (el.dataset.asmrTranslated === 'true') {
            const source = el.dataset.asmrSource;
            const translated = el.dataset.asmrTranslatedText;
            if (source && translated && rawText === source) {
                // CN→JP: Vue may re-render original CN text, re-apply substitution
                if (cnOnlyMode) el.textContent = translated;
                return;
            }
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
            const translated = await TranslationService.translate(stripped, targetLang, {
                sourceLanguageHint: cnOnlyMode ? 'zh' : this.getCurrentWorkSourceHint(),
            });
            if (!this._enabled || this._epoch !== epoch || !el.isConnected) return;
            if (getCleanText(el) !== rawText) return;
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
                    el.title = `${rawText} (${el.textContent})`;
                    this.applyStableMiniTitleLayout(el);
                } else {
                    this.updateElement(el, rawText, cleaned);
                }
            } else {
                this.markOriginal(el, rawText);
            }
        } catch {
            if (!this._enabled || this._epoch !== epoch || !el.isConnected) return;
            this.markOriginal(el, rawText);
        }
    }

    private getCurrentWorkSourceHint(): 'ja' | 'zh' | 'en' | 'auto' {
        const work = this.bridge.currentWork;
        const lang = String(work?.translation_info?.lang || '').toUpperCase();
        if (lang.includes('CHI') || lang.includes('ZH')) return 'zh';
        if (lang.includes('JPN') || lang.includes('JA')) return 'ja';
        if (lang.includes('ENG') || lang.includes('EN')) return 'en';
        if (work?.translation_info?.is_original) return 'ja';
        return 'auto';
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
        el.title = `${original} (${translated})`;
        this.applyStableMiniTitleLayout(el);
    }

    /**
     * Keep translated mini-player titles on a stable single line. The host
     * marquee was measured before our ::after translation existed, which can
     * hard-clip text and move adjacent controls. A native ellipsis is stable,
     * pointer-independent, and the full pair remains available via `title`.
     */
    private applyStableMiniTitleLayout(el: HTMLElement): void {
        if (!el.closest(PLAYER_BAR_SELECTOR)) return;

        el.classList.add('asmr-mini-title-ellipsis');
        const content = el.closest('.one-line-expand') as HTMLElement | null;
        content?.classList.add('asmr-mini-title-ellipsis-content');
        const container = el.closest('.container') as HTMLElement | null;
        container?.classList.add('asmr-mini-title-ellipsis-container');
    }
}
