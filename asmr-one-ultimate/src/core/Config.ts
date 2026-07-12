import { AppStore } from '../store/AppStore';
import type { ConfigKey, PluginConfig } from '../types';
import { enLocale } from './locales/en';
import { zhLocale } from './locales/zh';
import { jaLocale } from './locales/ja';
import { EventBus } from './EventBus';

// ============================================================================
// Config
// ============================================================================

/**
 * Convenience wrapper for AppStore.getConfig / AppStore.setConfig.
 */
export const Config = {
    get<K extends ConfigKey>(key: K): PluginConfig[K] {
        return AppStore.getConfig(key);
    },
    set<K extends ConfigKey>(key: K, value: PluginConfig[K]): void {
        AppStore.setConfig(key, value);
    },
};

// ============================================================================
// Internationalization
// ============================================================================

type SupportedLang = 'en' | 'zh' | 'ja';

type I18nData = Record<SupportedLang, Record<string, string>>;

const i18nData: I18nData = {
    en: enLocale,
    zh: zhLocale,
    ja: jaLocale,
};

function supportedLanguage(locale: string): SupportedLang {
    const lower = String(locale || '').toLowerCase();
    if (lower.startsWith('zh') || lower === 'cn') return 'zh';
    if (lower.startsWith('ja') || lower === 'jp') return 'ja';
    return 'en';
}

let browserSeedLocale: SupportedLang | null = /^(?:zh|ja)(?:-|$)/i.test(navigator.language || '')
    ? supportedLanguage(navigator.language)
    : null;
let initialHostLocale: SupportedLang | null = null;

export const I18n = {
    lang: (navigator.language.startsWith('zh') ? 'zh' : navigator.language.startsWith('ja') ? 'ja' : 'en') as SupportedLang,
    data: i18nData,

    /** Detect and sync language from the host Kikoeru app */
    syncFromHost(): void {
        // Priority 1: an explicit persisted host language choice.
        for (const key of ['locale', 'lang', 'language', 'i18n-locale']) {
            const stored = localStorage.getItem(key);
            if (stored) {
                browserSeedLocale = null;
                this.setLang(stored);
                return;
            }
        }

        // Read the Kikoeru Vue app's live locale. A CJK browser seed wins over
        // the host's first observed fallback, but a subsequent host-locale
        // change becomes authoritative (for example, the user selecting EN).
        let liveHostLocale = '';
        try {
            const root = document.getElementById('q-app') as HTMLElement & { __vue__?: Record<string, unknown> } | null;
            const vueApp = root?.__vue__;
            const i18nLocale = (vueApp?.$i18n as Record<string, unknown> | undefined)?.locale as string | undefined;
            if (i18nLocale) liveHostLocale = i18nLocale;
        } catch {
            // Ignore if Vue app not accessible
        }

        if (browserSeedLocale) {
            if (liveHostLocale) {
                const normalizedHost = supportedLanguage(liveHostLocale);
                if (initialHostLocale === null) initialHostLocale = normalizedHost;
                if (normalizedHost !== initialHostLocale) {
                    browserSeedLocale = null;
                    this.setLang(liveHostLocale);
                    return;
                }
            }
            this.setLang(browserSeedLocale);
            return;
        }

        if (liveHostLocale) {
            this.setLang(liveHostLocale);
            return;
        }

        // Next: navigator.language.
        if (navigator.language) {
            this.setLang(navigator.language);
            return;
        }

        // Last: <html lang="..."> (often set to 'en' by default, least reliable)
        const htmlLang = document.documentElement.lang;
        if (htmlLang) {
            this.setLang(htmlLang);
            return;
        }
    },

    /** Set language from a locale string like 'en', 'zh-CN', 'ja', 'cn' */
    setLang(locale: string): void {
        const previous = this.lang;
        this.lang = supportedLanguage(locale);
        if (this.lang !== previous) EventBus.emit('lang:change', { lang: this.lang });
    },

    /** Re-run first-install locale seeding (also useful after clearing settings). */
    resetAutoDetection(): void {
        browserSeedLocale = /^(?:zh|ja)(?:-|$)/i.test(navigator.language || '')
            ? supportedLanguage(navigator.language)
            : null;
        initialHostLocale = null;
    },

    t(key: string): string {
        return this.data[this.lang]?.[key] || this.data.en[key] || key;
    },

    format(key: string, params: Record<string, string | number>): string {
        let text = this.t(key);
        for (const [k, v] of Object.entries(params)) {
            text = text.replace(`{${k}}`, String(v));
        }
        return text;
    },
};

