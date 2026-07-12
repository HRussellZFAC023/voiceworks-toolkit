import { describe, expect, it } from 'vitest';
import { isCurrentWhisperTextRequest } from '../../src/features/learnerWhisperRequestUtils';

describe('learnerWhisperRequestUtils', () => {
    const current = {
        text: 'new line',
        generation: 2,
        trackKey: 'track-b',
        sourceLanguageHint: 'ja' as const,
        targetLanguage: 'en',
    };

    it('accepts only the exact current live-text translation context', () => {
        expect(isCurrentWhisperTextRequest(current, { ...current })).toBe(true);
        expect(isCurrentWhisperTextRequest({ ...current, text: 'old line' }, current)).toBe(false);
        expect(isCurrentWhisperTextRequest({ ...current, generation: 1 }, current)).toBe(false);
        expect(isCurrentWhisperTextRequest({ ...current, trackKey: 'track-a' }, current)).toBe(false);
        expect(isCurrentWhisperTextRequest({ ...current, sourceLanguageHint: 'zh' }, current)).toBe(false);
        expect(isCurrentWhisperTextRequest({ ...current, targetLanguage: 'ja' }, current)).toBe(false);
    });
});
