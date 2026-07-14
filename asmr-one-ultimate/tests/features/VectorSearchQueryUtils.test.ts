import { describe, expect, it } from 'vitest';
import {
    containsCjkForResultTranslation,
    detectSearchQueryScript,
    extractSearchTokens,
} from '../../src/features/vectorSearchQueryUtils';

describe('vector search query language preparation', () => {
    it('distinguishes kana Japanese from Han-only Chinese', () => {
        expect(detectSearchQueryScript('耳かきボイス')).toBe('japanese');
        expect(detectSearchQueryScript('温柔耳语')).toBe('chinese');
        expect(detectSearchQueryScript('ear cleaning')).toBe('other');
    });

    it('keeps mixed Japanese and English on the Japanese path', () => {
        expect(detectSearchQueryScript('ASMR 耳かき relaxing')).toBe('japanese');
    });

    it('keeps Han-only Chinese and kanji-only Japanese titles eligible for result translation', () => {
        expect(containsCjkForResultTranslation('温柔耳语')).toBe(true);
        expect(containsCjkForResultTranslation('催眠音声')).toBe(true);
        expect(containsCjkForResultTranslation('ear cleaning')).toBe(false);
    });

    it('adds overlapping bigrams for spaceless Chinese recall', () => {
        expect(extractSearchTokens('温柔耳语')).toEqual(['温柔耳语', '温柔', '柔耳', '耳语']);
    });

    it('preserves existing Latin and Japanese token behavior', () => {
        expect(extractSearchTokens('Ear cleaning / 耳かき')).toEqual(['ear', 'cleaning', '耳かき']);
    });
});
