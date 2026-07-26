/**
 * DomUtils - Shared DOM utilities and helpers
 *
 * Consolidates DOM query patterns used across features.
 */

// ============================================================================
// Element Finding
// ============================================================================

/**
 * Find a button by text content
 */
export function findButtonByText(labels: string[], root?: Element): HTMLElement | null {
    const container = root || document;
    const buttons = Array.from(container.querySelectorAll('.q-btn')) as HTMLElement[];
    return buttons.find(btn =>
        labels.some(label => btn.textContent?.includes(label))
    ) || null;
}

/**
 * Find all play buttons in a container
 */
export function findPlayButtons(container?: Element): HTMLElement[] {
    const root = container || document;
    const buttons = Array.from(root.querySelectorAll('button, .q-btn')) as HTMLElement[];
    return buttons.filter(btn => btn.textContent?.includes('play_arrow'));
}

/**
 * Find audio file items in a list
 */
export function findAudioItems(container?: Element): HTMLElement[] {
    const root = container || document;
    const audioExtensions = ['.wav', '.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wma'];

    const items = Array.from(root.querySelectorAll('.file-list-item, .q-item')) as HTMLElement[];
    return items.filter(el => {
        const text = el.textContent?.toLowerCase() || '';
        return audioExtensions.some(ext => text.includes(ext));
    });
}

// ============================================================================
// Element Waiting
// ============================================================================

/**
 * Wait for an element to appear in the DOM
 */
export function waitForElement(
    selector: string,
    timeoutMs = 10000,
    intervalMs = 200
): Promise<Element | null> {
    return new Promise(resolve => {
        const existing = document.querySelector(selector);
        if (existing) {
            resolve(existing);
            return;
        }

        const start = Date.now();
        const timer = setInterval(() => {
            const element = document.querySelector(selector);
            if (element) {
                clearInterval(timer);
                resolve(element);
            } else if (Date.now() - start > timeoutMs) {
                clearInterval(timer);
                resolve(null);
            }
        }, intervalMs);
    });
}

/**
 * Wait for a condition to be true
 */
export function waitFor(
    predicate: () => boolean | unknown,
    timeoutMs = 10000,
    intervalMs = 200
): Promise<boolean> {
    return new Promise(resolve => {
        if (predicate()) {
            resolve(true);
            return;
        }

        const start = Date.now();
        const timer = setInterval(() => {
            if (predicate()) {
                clearInterval(timer);
                resolve(true);
            } else if (Date.now() - start > timeoutMs) {
                clearInterval(timer);
                resolve(false);
            }
        }, intervalMs);
    });
}

// ============================================================================
// Style Injection
// ============================================================================

/**
 * Inject a CSS stylesheet
 */
export function injectStyles(id: string, css: string): HTMLStyleElement {
    let style = document.getElementById(id) as HTMLStyleElement | null;
    if (style) {
        style.textContent = css;
        return style;
    }

    style = document.createElement('style');
    style.id = id;
    style.textContent = css;
    document.head.appendChild(style);
    return style;
}

/**
 * Remove an injected stylesheet
 */
export function removeStyles(id: string): void {
    const style = document.getElementById(id);
    style?.remove();
}

// ============================================================================
// Audio Element Helpers
// ============================================================================

/**
 * Get the page's audio element
 */
export function getAudioElement(): HTMLAudioElement | null {
    return document.querySelector('audio');
}

/**
 * Canonical selector for the player bar container.
 * Kikoeru uses `.player-bar-container`, `.player-bar`, or `.q-footer` depending on version.
 */
export const PLAYER_BAR_SELECTOR = '.player-bar-container, .player-bar, .q-footer';

/**
 * Get the player bar element
 */
export function getPlayerBar(): HTMLElement | null {
    return document.querySelector(PLAYER_BAR_SELECTOR);
}

/**
 * Check if the player bar is visible
 */
export function hasPlayerBar(): boolean {
    return !!getPlayerBar();
}

// ============================================================================
// Stacked Bottom Bar Height
// ============================================================================

let _stackedPollId: ReturnType<typeof setInterval> | null = null;

function isBarVisible(el: HTMLElement | null): boolean {
    return !!el && el.style.display !== 'none' && !el.classList.contains('hidden') && el.offsetHeight > 0;
}

/**
 * Escape HTML special characters for safe text interpolation into HTML strings.
 */
export function escapeHtml(value: string): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Measure the total height of fixed bars stacked above the q-footer
 * (collapsed subs, JOI bar, visualizer) and publish the result as
 * `--asmr-stacked-bottom-height` so page content can add padding.
 */
export function syncStackedBottomHeight(): void {
    const subsBar = document.querySelector('body > .learner-subs-collapsed') as HTMLElement | null;
    const joiBar = document.querySelector('body > .asmr-joi-bar-collapsed') as HTMLElement | null;
    const vizBar = document.querySelector('body > .asmr-viz-bar') as HTMLElement | null;

    let extra = 0;
    if (isBarVisible(subsBar)) extra += subsBar!.offsetHeight;
    if (isBarVisible(joiBar)) extra += joiBar!.offsetHeight;
    if (isBarVisible(vizBar)) extra += vizBar!.offsetHeight;

    document.documentElement.style.setProperty('--asmr-stacked-bottom-height', `${extra}px`);
}

interface BottomOffsetOptions {
    includePlayerBar?: boolean;
    includeSubsBar?: boolean;
    includeJoiBar?: boolean;
    includeVizBar?: boolean;
    playerFallbackPx?: number;
}

/**
 * Calculate stacked bottom offset for floating UI bars.
 */
export function calculateBottomOffset(options: BottomOffsetOptions = {}): number {
    const {
        includePlayerBar = true,
        includeSubsBar = true,
        includeJoiBar = true,
        includeVizBar = true,
        playerFallbackPx = 60,
    } = options;

    let bottomOffset = 0;

    if (includePlayerBar) {
        const playerBar = getPlayerBar();
        bottomOffset += playerBar?.offsetHeight || playerFallbackPx;
    }

    if (includeSubsBar) {
        const subsBar = document.querySelector('body > .learner-subs-collapsed') as HTMLElement | null;
        if (isBarVisible(subsBar)) bottomOffset += subsBar!.offsetHeight;
    }

    if (includeJoiBar) {
        const joiBar = document.querySelector('body > .asmr-joi-bar-collapsed') as HTMLElement | null;
        if (isBarVisible(joiBar)) bottomOffset += joiBar!.offsetHeight;
    }

    if (includeVizBar) {
        const vizBar = document.querySelector('body > .asmr-viz-bar') as HTMLElement | null;
        if (isBarVisible(vizBar)) bottomOffset += vizBar!.offsetHeight;
    }

    return bottomOffset;
}

/**
 * Toggle active visual state for overflow menu buttons.
 */
export function syncOverflowButtonState(selector: string, active: boolean): void {
    document.querySelectorAll(selector).forEach((btn) => {
        const icon = btn.querySelector('.material-icons');
        if (icon) {
            icon.classList.toggle('asmr-accent', active);
        }
        btn.classList.toggle('learner-btn-active', active);
    });
}

/** Start a 500ms poll that keeps --asmr-stacked-bottom-height in sync. */
export function startStackedBottomHeightWatch(): void {
    stopStackedBottomHeightWatch();
    syncStackedBottomHeight();
    _stackedPollId = setInterval(syncStackedBottomHeight, 500);
}

export function stopStackedBottomHeightWatch(): void {
    if (_stackedPollId) {
        clearInterval(_stackedPollId);
        _stackedPollId = null;
    }
}

/**
 * Get current audio source URL
 */
export function getAudioSource(): string | null {
    const audio = getAudioElement();
    return audio?.currentSrc || audio?.src || null;
}

/**
 * Validate that a source string points to an actual media URL.
 * Rejects empty values and bare origins (e.g. "https://asmr.one/").
 */
export function isValidAudioSource(src: string | null | undefined): boolean {
    if (!src) return false;
    const trimmed = src.trim();
    if (!trimmed) return false;

    try {
        const url = new URL(trimmed, window.location.href);
        if ((url.protocol === 'http:' || url.protocol === 'https:') && url.pathname.length <= 1) {
            return false;
        }
        return true;
    } catch {
        return false;
    }
}

/**
 * Check whether the current audio element has a valid source URL.
 */
export function hasValidAudioSource(audio: HTMLAudioElement | null = getAudioElement()): boolean {
    if (!audio) return false;
    const src = audio.currentSrc || audio.getAttribute('src') || audio.src || '';
    return isValidAudioSource(src);
}

/**
 * Check if audio is currently playing
 */
export function isAudioPlaying(): boolean {
    const audio = getAudioElement();
    return audio ? !audio.paused : false;
}

// ============================================================================
// Vue 2 Element Accessors
// ============================================================================

interface VueElement extends HTMLElement {
    __vue__?: {
        $attrs?: Record<string, unknown>;
        $props?: Record<string, unknown>;
        $data?: Record<string, unknown>;
        item?: unknown;
        fatherFolder?: unknown[];
        [key: string]: unknown;
    };
}

/**
 * Extract the data item bound to a Vue 2 element.
 * Checks $attrs.item, direct .item, $props.item in order.
 */
export function getVueItem(el: Element): unknown {
    const vm = (el as VueElement).__vue__;
    if (!vm) return null;
    return vm.$attrs?.item ?? vm.item ?? vm.$props?.item ?? null;
}

/**
 * Extract the fatherFolder array from a Vue 2 work tree component.
 */
export function getFatherFolder(treeVm: unknown): unknown[] {
    if (!treeVm || typeof treeVm !== 'object') return [];
    const vm = treeVm as Record<string, unknown>;
    return (vm.fatherFolder ?? (vm as any).$data?.fatherFolder ?? (vm as any)._data?.fatherFolder ?? []) as unknown[];
}

// ============================================================================
// Theme Detection
// ============================================================================

/**
 * Check if dark mode is active
 */
export function isDarkMode(): boolean {
    return document.body.classList.contains('body--dark') ||
        document.body.classList.contains('q-dark');
}

// ============================================================================
// Scroll Utilities
// ============================================================================

/**
 * Scroll an element into view smoothly
 */
export function scrollIntoView(element: Element, options?: ScrollIntoViewOptions): void {
    element.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
        ...options,
    });
}

// ============================================================================
// Text Extraction
// ============================================================================

/**
 * Keep only the innermost element of every ancestor/descendant pair that carries
 * identical text.
 *
 * Framework wrappers routinely wrap a label in several nested elements that all
 * match the same CSS selector — a Quasar button, for example, renders
 * `<span class="q-btn__content"><span class="block">LABEL</span></span>`, so
 * `.q-breadcrumbs__el span` matches twice for one visible label. Annotating both
 * makes any per-element decoration (a `::after` suffix, an appended node) render
 * once per match, which reads as duplicated output.
 *
 * Only exact text matches are collapsed: an ancestor holding extra text of its
 * own still owns content the descendant does not cover, so it is left alone.
 */
export function dropNestedDuplicateTargets<T extends Element>(
    elements: T[],
    getText: (el: T) => string,
): T[] {
    if (elements.length < 2) return elements;

    const candidates = new Set<Element>(elements);
    const textCache = new Map<Element, string>();
    const textOf = (el: Element): string => {
        let text = textCache.get(el);
        if (text === undefined) {
            text = getText(el as unknown as T);
            textCache.set(el, text);
        }
        return text;
    };

    const shadowed = new Set<Element>();
    for (const el of elements) {
        let parent = el.parentElement;
        while (parent) {
            if (candidates.has(parent)) {
                if (textOf(parent) !== textOf(el)) break;
                shadowed.add(parent);
            }
            parent = parent.parentElement;
        }
    }

    if (shadowed.size === 0) return elements;
    return elements.filter((el) => !shadowed.has(el));
}

/**
 * Get clean text from an element, stripping JPDB furigana annotations.
 * Checks data-jpdb-original attribute first, then falls back to stripping
 * <rt>/<rp> elements from ruby annotations.
 */
export function getCleanText(el: Element): string {
    const original = el.getAttribute('data-jpdb-original');
    if (original) return original.trim();

    if (el.querySelector('rt')) {
        const clone = el.cloneNode(true) as Element;
        clone.querySelectorAll('rt, rp').forEach(e => e.remove());
        return clone.textContent?.trim() || '';
    }

    return el.textContent?.trim() || '';
}

/**
 * Strip JPDB furigana annotations within a root element, restoring plain text.
 * For each annotated descendant, restores the original text from data-jpdb-original
 * and removes jpdb tracking attributes so Vue can patch text nodes correctly.
 */
export function stripJpdbAnnotations(root: Element): void {
    const annotated = root.querySelectorAll<HTMLElement>('[data-jpdb]');
    for (const el of annotated) {
        const original = el.getAttribute('data-jpdb-original');
        if (original) el.textContent = original;
        el.removeAttribute('data-jpdb');
        el.removeAttribute('data-jpdb-original');
    }
}

/** CJK ideographs present but no Japanese kana → likely Chinese */
export function isChinese(text: string): boolean {
    return /[\u4e00-\u9fff]/.test(text) && !/[\u3040-\u309f\u30a0-\u30ff]/.test(text);
}

/** Text has at least one letter/CJK character worth translating (not pure punctuation/symbols) */
export function isTranslatable(text: string): boolean {
    return /[\p{L}\p{N}]/u.test(text);
}
