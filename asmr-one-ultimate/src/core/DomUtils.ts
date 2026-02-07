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
 * Find a button by icon name
 */
export function findIconButton(iconName: string, scope?: string): HTMLElement | null {
    const root = scope ? document.querySelector(scope) : document;
    if (!root) return null;

    const icons = Array.from(root.querySelectorAll('.q-icon, .material-icons')) as HTMLElement[];
    const match = icons.find(el => el.textContent?.trim() === iconName);
    return (match?.closest('.q-btn') as HTMLElement) ?? null;
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

/**
 * Check if an element contains audio file text
 */
export function isAudioFileElement(element: Element): boolean {
    const audioExtensions = ['.wav', '.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wma'];
    const text = element.textContent?.toLowerCase() || '';
    return audioExtensions.some(ext => text.includes(ext));
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
// Mutation Observer Helpers
// ============================================================================

/**
 * Create a mutation observer that watches for element additions
 */
export function observeElementAdditions(
    callback: (addedNodes: Node[]) => void,
    options?: {
        root?: Element;
        subtree?: boolean;
    }
): MutationObserver {
    const observer = new MutationObserver(mutations => {
        const addedNodes: Node[] = [];
        for (const mutation of mutations) {
            if (mutation.addedNodes.length) {
                addedNodes.push(...Array.from(mutation.addedNodes));
            }
        }
        if (addedNodes.length) {
            callback(addedNodes);
        }
    });

    observer.observe(options?.root || document.body, {
        childList: true,
        subtree: options?.subtree ?? true,
    });

    return observer;
}

/**
 * Watch for an element and call callback when it appears
 */
export function watchForElement(
    selector: string,
    callback: (element: Element) => void,
    options?: { once?: boolean }
): MutationObserver {
    // Check if already exists
    const existing = document.querySelector(selector);
    if (existing) {
        callback(existing);
        if (options?.once) {
            return new MutationObserver(() => {}); // Return no-op observer
        }
    }

    const observer = new MutationObserver(() => {
        const element = document.querySelector(selector);
        if (element) {
            callback(element);
            if (options?.once) {
                observer.disconnect();
            }
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
    });

    return observer;
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

/**
 * Get current audio source URL
 */
export function getAudioSource(): string | null {
    const audio = getAudioElement();
    return audio?.currentSrc || audio?.src || null;
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

/**
 * Get appropriate colors based on current theme
 */
export function getThemeColors(): { bg: string; text: string; accent: string } {
    const dark = isDarkMode();
    return {
        bg: dark ? '#1d1d1d' : '#ffffff',
        text: dark ? '#ffffff' : '#000000',
        accent: 'var(--asmr-accent, #f06292)',
    };
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

/**
 * Check if an element is in the viewport
 */
export function isInViewport(element: Element): boolean {
    const rect = element.getBoundingClientRect();
    return (
        rect.top >= 0 &&
        rect.left >= 0 &&
        rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
        rect.right <= (window.innerWidth || document.documentElement.clientWidth)
    );
}
