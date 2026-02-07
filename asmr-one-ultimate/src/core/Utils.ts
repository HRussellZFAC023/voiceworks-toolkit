/**
 * Core Utilities
 *
 * Re-exports commonly used utilities from centralized modules.
 * New code should import directly from specific modules:
 * - DomUtils for DOM operations
 * - WorkUtils for work/track utilities
 * - EventBus for events
 * - AppStore for config/state
 */

// ============================================================================
// Config & I18n
// ============================================================================

export { Config, I18n } from './Config';

// ============================================================================
// Logger
// ============================================================================

export { Logger } from './Logger';

// ============================================================================
// Safe Utils
// ============================================================================

export const SafeUtils = {
    waitFor(predicate: () => unknown, timeoutMs = 10000, intervalMs = 200): Promise<boolean> {
        return new Promise((resolve) => {
            if (predicate()) return resolve(true);
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
    },

    async waitForElement(selector: string, timeoutMs = 10000): Promise<Element | null> {
        const found = await this.waitFor(() => document.querySelector(selector), timeoutMs);
        return found ? document.querySelector(selector) : null;
    },

    debounce<T extends (...args: any[]) => void>(fn: T, delayMs: number): (...args: Parameters<T>) => void {
        let timeout: number | null = null;
        return (...args: Parameters<T>) => {
            if (timeout !== null) window.clearTimeout(timeout);
            timeout = window.setTimeout(() => {
                fn(...args);
                timeout = null;
            }, delayMs);
        };
    },
};

// ============================================================================
// Dialog Styles
// ============================================================================

export const DialogStyles = {
    injectSizing(): void {
        if (document.getElementById('asmr-dialog-sizing-style')) return;

        const width = '60vw';
        const height = '55vh';
        const style = document.createElement('style');
        style.id = 'asmr-dialog-sizing-style';
        style.textContent = `
            .q-gutter-y-sm .q-scrollarea {
                height: ${height} !important;
            }
            .q-dialog-plugin {
                width: ${width} !important;
                max-width: ${width} !important;
            }
        `;
        document.head.appendChild(style);
    },
};
