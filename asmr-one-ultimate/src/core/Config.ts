import { AppStore } from '../store/AppStore';
import type { ConfigKey, PluginConfig } from '../types';
import { enLocale } from './locales/en';
import { zhLocale } from './locales/zh';
import { jaLocale } from './locales/ja';

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

export const I18n = {
    lang: (navigator.language.startsWith('zh') ? 'zh' : navigator.language.startsWith('ja') ? 'ja' : 'en') as SupportedLang,
    data: i18nData,

    /** Detect and sync language from the host Kikoeru app */
    syncFromHost(): void {
        // Priority 1: Kikoeru Vue app's $i18n locale (reads from the live Vue instance)
        try {
            const root = document.getElementById('q-app') as HTMLElement & { __vue__?: Record<string, unknown> } | null;
            const vueApp = root?.__vue__;
            const i18nLocale = (vueApp?.$i18n as Record<string, unknown> | undefined)?.locale as string | undefined;
            if (i18nLocale) {
                this.setLang(i18nLocale);
                return;
            }
        } catch {
            // Ignore if Vue app not accessible
        }

        // Priority 2: localStorage keys used by Kikoeru/asmr.one
        for (const key of ['locale', 'lang', 'language', 'i18n-locale']) {
            const stored = localStorage.getItem(key);
            if (stored) {
                this.setLang(stored);
                return;
            }
        }

        // Priority 3: navigator.language (browser locale - more reliable than <html lang>)
        if (navigator.language) {
            this.setLang(navigator.language);
            return;
        }

        // Priority 4: <html lang="..."> (often set to 'en' by default, least reliable)
        const htmlLang = document.documentElement.lang;
        if (htmlLang) {
            this.setLang(htmlLang);
            return;
        }
    },

    /** Set language from a locale string like 'en', 'zh-CN', 'ja', 'cn' */
    setLang(locale: string): void {
        const lower = locale.toLowerCase();
        if (lower.startsWith('zh') || lower === 'cn') {
            this.lang = 'zh';
        } else if (lower.startsWith('ja') || lower === 'jp') {
            this.lang = 'ja';
        } else {
            this.lang = 'en';
        }
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



