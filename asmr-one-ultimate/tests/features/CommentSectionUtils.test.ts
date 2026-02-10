import { describe, expect, it } from 'vitest';
import type { DLsiteUserReview } from '../../src/types/dlsite';
import {
    extractAllRjCodes,
    extractRjCode,
    getAllRelatedWorkIds,
    getReviewParagraphs,
    htmlToPlainText,
    sanitizeReviewText,
    type CommentSectionWorkLike,
} from '../../src/features/commentSectionUtils';

function review(text: string): DLsiteUserReview {
    return {
        username: 'user',
        rating: 5,
        text,
        date: '2026-02-09',
        source: 'dlsite',
    };
}

describe('commentSectionUtils', () => {
    describe('sanitizeReviewText', () => {
        it('removes scripts and truncates at stop markers', () => {
            const input = 'Useful review text<script>alert(1)</script>\nSelect Language\nfooter noise';
            const output = sanitizeReviewText(input);
            expect(output).toContain('Useful review text');
            expect(output).not.toContain('<script>');
            expect(output).not.toContain('footer noise');
        });

        it('converts markdown links and emphasis into safe HTML', () => {
            const input = '[site](https://example.com)\n\n**bold** __text__';
            const output = sanitizeReviewText(input);
            expect(output).toContain('<a href="https://example.com"');
            expect(output).toContain('<strong>bold</strong>');
            expect(output).toContain('<strong>text</strong>');
        });

        it('drops very short strings and URL-only noise', () => {
            expect(sanitizeReviewText('too short')).toBe('');
            expect(
                sanitizeReviewText('https://a.com\nhttps://b.com\nhttps://c.com\nline')
            ).toBe('');
        });
    });

    describe('paragraph and plain text helpers', () => {
        it('splits sanitized text into display paragraphs', () => {
            const paragraphs = getReviewParagraphs(review('line1\nline2\n\nline3'));
            expect(paragraphs).toEqual(['line1<br>line2', 'line3']);
        });

        it('strips HTML tags to plain text', () => {
            const plain = htmlToPlainText('Hello <strong>world</strong> <a href="#">link</a>');
            expect(plain).toContain('Hello');
            expect(plain).toContain('world');
            expect(plain).toContain('link');
            expect(plain).not.toContain('<strong>');
        });
    });

    describe('RJ/work id extraction', () => {
        it('extracts primary RJ code from source id, numeric id, or title fallback', () => {
            expect(extractRjCode({ source_id: 'RJ123456' }, null)).toBe('RJ123456');
            expect(extractRjCode({ sourceId: 'work-87654321' }, null)).toBe('RJ87654321');
            expect(extractRjCode({ source_id: 'invalid', title: 'Title RJ765432' }, null)).toBe('RJ765432');
            expect(extractRjCode({ source_id: 'invalid' }, '123456')).toBe('RJ123456');
        });

        it('collects and deduplicates related RJ codes across editions', () => {
            const work: CommentSectionWorkLike = {
                source_id: 'RJ111111',
                language_editions: [{ workno: 'RJ222222' }, { workno: 'RJ222222' }],
                translation_info: {
                    original_workno: 'RJ333333',
                    parent_workno: 'RJ444444',
                    child_worknos: ['RJ555555', 'RJ555555'],
                },
                other_language_editions_in_db: [
                    { source_id: 'RJ666666' },
                    { sourceId: 'RJ111111' },
                ],
            };

            const codes = extractAllRjCodes(work, '100');
            expect(codes).toEqual(expect.arrayContaining([
                'RJ111111',
                'RJ222222',
                'RJ333333',
                'RJ444444',
                'RJ555555',
                'RJ666666',
            ]));
            expect(new Set(codes).size).toBe(codes.length);
        });

        it('collects primary and related work ids', () => {
            const ids = getAllRelatedWorkIds('100', {
                other_language_editions_in_db: [
                    { id: 200 },
                    { id: '200' },
                    { id: 'invalid' },
                    { id: 300 },
                ],
            });
            expect(ids).toEqual(expect.arrayContaining([100, 200, 300]));
            expect(ids.length).toBe(3);
        });
    });
});
