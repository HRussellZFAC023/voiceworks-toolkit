import { describe, expect, it } from 'vitest';
import {
    learnerSubtitleLayout,
    normalizeLearnerSubtitleMode,
    resolveLearnerSecondaryLanguage,
    subtitleLanguageAttribute,
} from '../../src/features/learnerSubtitleMode';

describe('learner subtitle mode routing', () => {
    it('preserves the existing configured language in auto mode', () => {
        expect(resolveLearnerSecondaryLanguage('auto', 'en')).toBe('en');
        expect(resolveLearnerSecondaryLanguage('auto', 'zh-CN')).toBe('zh-CN');
        expect(learnerSubtitleLayout('auto', 'en')).toBe('jp-en');
    });

    it('routes explicit English and Chinese layouts independently of legacy config', () => {
        expect(resolveLearnerSecondaryLanguage('jp-en', 'zh-CN')).toBe('en');
        expect(resolveLearnerSecondaryLanguage('jp-zh', 'en')).toBe('zh-CN');
        expect(learnerSubtitleLayout('jp-zh', 'en')).toBe('jp-zh');
        expect(subtitleLanguageAttribute('zh')).toBe('zh-CN');
    });

    it('keeps custom languages and fails unknown saved modes back to auto', () => {
        expect(resolveLearnerSecondaryLanguage('custom', 'fr')).toBe('fr');
        expect(learnerSubtitleLayout('custom', 'fr')).toBe('jp-custom');
        expect(normalizeLearnerSubtitleMode('removed-mode')).toBe('auto');
    });
});
