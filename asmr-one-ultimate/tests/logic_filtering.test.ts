
import { describe, it, expect } from 'vitest';

// Copied logic from DLsiteService.ts for isolation testing
const AGE_GATE_MARKERS = [
    'あなたは18歳以上ですか',
    '18歳未満の方は閲覧できない',
    'age_verification',
    '成人向け入室確認',
];

const INVALID_CONTENT_MARKERS = [
    ...AGE_GATE_MARKERS,
    '一般的な作品に加えて暴力表現・性描写など',
    'In addition to general works, violence and sexual depictions etc.'
];

function isValidReview(review: { rating: number; text: string; username: string }): boolean {
    if (!review.rating || review.rating <= 0) return false;
    if (INVALID_CONTENT_MARKERS.some(m => review.text.includes(m) || review.username.includes(m))) {
        return false;
    }
    if (/^\d+\s*[_]*円[_]*$/.test(review.text)) return false;
    if (/^\d{1,3}(,\d{3})*\s*JPY$/.test(review.text)) return false;
    return true;
}

describe('DLsite Review Filtering Logic', () => {
    it('should filter out reviews with 0 rating', () => {
        expect(isValidReview({ rating: 0, text: 'Valid text', username: 'User' })).toBe(false);
        expect(isValidReview({ rating: 5, text: 'Valid text', username: 'User' })).toBe(true);
    });

    it('should filter out age gate text', () => {
        expect(isValidReview({ rating: 5, text: 'あなたは18歳以上ですか？', username: 'User' })).toBe(false);
    });

    it('should filter out content warnings', () => {
        expect(isValidReview({ rating: 5, text: '一般的な作品に加えて暴力表現・性描写など', username: 'User' })).toBe(false);
        expect(isValidReview({ rating: 5, text: 'In addition to general works, violence and sexual depictions etc.', username: 'User' })).toBe(false);
    });

    it('should filter out prices', () => {
        expect(isValidReview({ rating: 5, text: '660 円', username: 'User' })).toBe(false);
        expect(isValidReview({ rating: 5, text: '660_円_', username: 'User' })).toBe(false);
        // "660 _円_"
        expect(isValidReview({ rating: 5, text: '660 _円_', username: 'User' })).toBe(false);
        expect(isValidReview({ rating: 5, text: '1210 円', username: 'User' })).toBe(false);
    });

    it('should accept valid reviews', () => {
        expect(isValidReview({ rating: 5, text: 'This is a great work!', username: 'User' })).toBe(true);
    });
});
