import { ref, onUnmounted, inject } from 'vue';
import { INJECT_KEYS } from '../core/MountApp';
import { I18n as I18nSingleton } from '../core/Config';
import { EventBus } from '../core/EventBus';

type I18nType = typeof I18nSingleton;

export function useI18n() {
    const i18n = inject<I18nType>(INJECT_KEYS.i18n) ?? I18nSingleton;

    // Reactive lang ref that updates on lang:change events
    const lang = ref<string>(i18n.lang as string);

    const unsub = EventBus.on('lang:change', ({ lang: newLang }) => {
        lang.value = String(newLang);
    });

    onUnmounted(unsub);

    function t(key: string): string {
        // Access lang.value to create a reactive dependency
        void lang.value;
        return i18n.t(key);
    }

    function format(key: string, params: Record<string, string | number>): string {
        void lang.value;
        return i18n.format(key, params);
    }

    return { t, format, lang };
}
