
import { describe, it, expect } from 'vitest';
import { DLsiteService } from '../src/services/DLsiteService';

describe('DLsiteService Review Filtering', () => {
    it('should include reviews even if star extraction fails', () => {
        // Reviews with meaningful text should be included even if the HTML
        // doesn't contain recognizable star markup (rating defaults to 0).
        // Filtering by rating was too aggressive and caused comments to not load.
        const html = `
            <div class="review_list">
                <li class="review_item">
                    <span class="reviewer">Reviewer1</span>
                    <span class="review_date">2023-01-01</span>
                    <div class="review_body">This is a comment but it has no rating stars.</div>
                </li>
                 <li class="review_item">
                    <span class="reviewer">GoodReviewer</span>
                    <span class="star_5"></span>
                    <div class="review_body">This is a valid review.</div>
                </li>
            </div>
        `;

        const service = DLsiteService as any;
        const reviews = service.extractReviewsFromHtml(html);

        const noStars = reviews.find((r: any) => r.username === 'Reviewer1');
        const withStars = reviews.find((r: any) => r.username === 'GoodReviewer' || r.text === 'This is a valid review.');

        // Both should be included — don't filter by rating
        expect(noStars).toBeDefined();
        expect(withStars).toBeDefined();
    });

    it('should filter out specific unwanted strings (price, age gate)', () => {
        const html = `
            <div class="review_list">
                 <li class="review_item">
                    <span class="reviewer">System</span>
                    <div class="review_body">660 円</div>
                </li>
                <li class="review_item">
                    <span class="reviewer">System</span>
                    <div class="review_body">あなたは18歳以上ですか？</div>
                </li>
                <li class="review_item">
                    <span class="reviewer">System</span>
                     <div class="review_body">一般的な作品に加えて暴力表現・性描写など</div>
                </li>
                 <li class="review_item">
                    <span class="reviewer">System</span>
                     <div class="review_body">In addition to general works, violence and sexual depictions etc.</div>
                </li>
            </div>
        `;

        const service = DLsiteService as any;
        const reviews = service.extractReviewsFromHtml(html);

        expect(reviews.length).toBe(0);
    });
});
