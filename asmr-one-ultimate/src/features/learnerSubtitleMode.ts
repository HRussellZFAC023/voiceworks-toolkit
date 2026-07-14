export const LEARNER_SUBTITLE_MODES = ['auto', 'jp-en', 'jp-zh', 'custom'] as const;

export type LearnerSubtitleMode = typeof LEARNER_SUBTITLE_MODES[number];

export function normalizeLearnerSubtitleMode(value: unknown): LearnerSubtitleMode {
    return LEARNER_SUBTITLE_MODES.includes(value as LearnerSubtitleMode)
        ? value as LearnerSubtitleMode
        : 'auto';
}

/** Resolve only the learner/Whisper secondary lane; the primary lane remains Japanese. */
export function resolveLearnerSecondaryLanguage(mode: unknown, configuredLanguage: unknown): string {
    switch (normalizeLearnerSubtitleMode(mode)) {
        case 'jp-en': return 'en';
        case 'jp-zh': return 'zh-CN';
        case 'custom': {
            const configured = String(configuredLanguage || '').trim();
            return configured || 'en';
        }
        case 'auto':
        default: {
            // Auto preserves the pre-mode behavior, including the Chinese
            // browser default already represented by subtitleLang.
            const configured = String(configuredLanguage || '').trim();
            return configured || 'en';
        }
    }
}

export function learnerSubtitleLayout(mode: unknown, configuredLanguage: unknown): 'jp-en' | 'jp-zh' | 'jp-custom' {
    const target = resolveLearnerSecondaryLanguage(mode, configuredLanguage).toLowerCase();
    if (target === 'zh' || target === 'cn' || target.startsWith('zh-')) return 'jp-zh';
    if (target === 'en' || target.startsWith('en-')) return 'jp-en';
    return 'jp-custom';
}

export function subtitleLanguageAttribute(language: string): string {
    const normalized = language.trim().toLowerCase();
    if (normalized === 'zh' || normalized === 'cn' || normalized.startsWith('zh-')) return 'zh-CN';
    if (normalized === 'en' || normalized.startsWith('en-')) return 'en';
    return language.trim() || 'en';
}
