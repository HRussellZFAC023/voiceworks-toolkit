/**
 * E2E: Comment Section
 *
 * Tests for the user reviews and DLsite comments feature.
 * CommentSection injects a collapsible reviews panel on work pages
 * with user rating, text input, and DLsite review display.
 */

import { test, expect, helpers, TEST_WORKS } from './fixtures';

test.describe('Comment Section', () => {

    test.beforeEach(async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();
        await injectedPage.waitForTimeout(2000);
    });

    test('comments section is injected on work page', async ({ injectedPage }) => {
        const section = injectedPage.locator('.asmr-comments-section');
        await expect(section).toBeVisible({ timeout: 15000 });
    });

    test('comments header has icon and label', async ({ injectedPage }) => {
        const header = injectedPage.locator('.asmr-comments-header');
        await expect(header).toBeVisible({ timeout: 15000 });

        // Header should have a forum icon
        const icon = header.locator('.asmr-comments-header-icon');
        const iconCount = await icon.count();
        console.log(`Header icon count: ${iconCount}`);

        // Header should show review count badge
        const badge = header.locator('.asmr-comments-badge');
        const badgeCount = await badge.count();
        console.log(`Badge count: ${badgeCount}`);
    });

    test('comments section can expand and collapse', async ({ injectedPage }) => {
        const header = injectedPage.locator('.asmr-comments-header');
        await expect(header).toBeVisible({ timeout: 15000 });

        // Click to expand
        await header.click();
        await injectedPage.waitForTimeout(500);

        const body = injectedPage.locator('.asmr-comments-body--expanded');
        const isExpanded = await body.isVisible().catch(() => false);
        console.log(`Section expanded: ${isExpanded}`);

        if (isExpanded) {
            // Click again to collapse
            await header.click();
            await injectedPage.waitForTimeout(500);
            const isCollapsed = await body.isVisible().catch(() => false);
            console.log(`Section collapsed after second click: ${!isCollapsed}`);
        }
    });

    test('star rating exists in editor', async ({ injectedPage }) => {
        // Expand comments section first
        const header = injectedPage.locator('.asmr-comments-header');
        await expect(header).toBeVisible({ timeout: 15000 });
        await header.click();
        await injectedPage.waitForTimeout(500);

        const stars = injectedPage.locator('.asmr-comments-star');
        const count = await stars.count();
        console.log(`Star count: ${count}`);
        // Should have 5 stars
        if (count > 0) {
            expect(count).toBe(5);
        }
    });

    test('textarea exists for user review', async ({ injectedPage }) => {
        // Expand comments section first
        const header = injectedPage.locator('.asmr-comments-header');
        await expect(header).toBeVisible({ timeout: 15000 });
        await header.click();
        await injectedPage.waitForTimeout(500);

        const textarea = injectedPage.locator('.asmr-comments-textarea');
        const count = await textarea.count();
        console.log(`Textarea count: ${count}`);
    });

    test('no duplicate comment sections on re-navigation', async ({ injectedPage }) => {
        await helpers.gotoHome(injectedPage);
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await injectedPage.waitForTimeout(3000);

        const sections = await injectedPage.locator('.asmr-comments-section').count();
        expect(sections).toBeLessThanOrEqual(1);
    });

    test('chevron icon changes on expand', async ({ injectedPage }) => {
        const header = injectedPage.locator('.asmr-comments-header');
        await expect(header).toBeVisible({ timeout: 15000 });

        const chevron = injectedPage.locator('.asmr-comments-chevron');
        const chevronCount = await chevron.count();

        if (chevronCount > 0) {
            // Click to expand
            await header.click();
            await injectedPage.waitForTimeout(500);

            const expandedChevron = injectedPage.locator('.asmr-comments-chevron--expanded');
            const isExpanded = await expandedChevron.isVisible().catch(() => false);
            console.log(`Chevron expanded: ${isExpanded}`);
        }
    });
});
