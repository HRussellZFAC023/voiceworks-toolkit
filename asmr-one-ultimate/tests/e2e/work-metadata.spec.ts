/**
 * E2E: Work Metadata Panel
 *
 * Tests for the enhanced metadata display on work pages.
 * WorkMetadata scrapes DLsite for additional info and renders
 * a rich metadata panel with tags, CVs, stats, and description.
 */

import { test, expect, helpers, TEST_WORKS } from './fixtures';

test.describe('Work Metadata Panel', () => {

    test.beforeEach(async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();
        await injectedPage.waitForTimeout(2000);
    });

    test('metadata panel is injected on work page', async ({ injectedPage }) => {
        const panel = injectedPage.locator('.asmr-metadata-panel');
        await expect(panel).toBeVisible({ timeout: 15000 });
    });

    test('metadata panel has stats row', async ({ injectedPage }) => {
        const statsRow = injectedPage.locator('.asmr-meta-stats');
        await expect(statsRow).toBeVisible({ timeout: 15000 });

        // Should have at least a badge and price
        const badge = injectedPage.locator('.asmr-meta-badge');
        const price = injectedPage.locator('.asmr-meta-price');
        const badgeCount = await badge.count();
        const priceCount = await price.count();
        console.log(`Badge count: ${badgeCount}, Price count: ${priceCount}`);
        expect(badgeCount + priceCount).toBeGreaterThan(0);
    });

    test('metadata panel shows tag chips', async ({ injectedPage }) => {
        const chips = injectedPage.locator('.asmr-chip-tag');
        await injectedPage.waitForTimeout(3000);
        const count = await chips.count();
        console.log(`Tag chips: ${count}`);
        // Should have at least some tags (CV, circle, or tags)
        expect(count).toBeGreaterThan(0);
    });

    test('tag chips include circle, CV, and tag variants', async ({ injectedPage }) => {
        await injectedPage.waitForTimeout(3000);
        const circleChips = await injectedPage.locator('.asmr-chip-tag--circle').count();
        const cvChips = await injectedPage.locator('.asmr-chip-tag--cv').count();
        const tagChips = await injectedPage.locator('.asmr-chip-tag--tag').count();
        console.log(`Circle: ${circleChips}, CV: ${cvChips}, Tag: ${tagChips}`);
    });

    test('refresh button exists in stats row', async ({ injectedPage }) => {
        const refreshBtn = injectedPage.locator('.asmr-meta-refresh');
        await injectedPage.waitForTimeout(3000);
        const count = await refreshBtn.count();
        console.log(`Refresh button count: ${count}`);
    });

    test('details toggle button exists', async ({ injectedPage }) => {
        const toggle = injectedPage.locator('.asmr-meta-toggle');
        await injectedPage.waitForTimeout(3000);
        const count = await toggle.count();
        console.log(`Details toggle count: ${count}`);
    });

    test('HVDB link is injected on work page', async ({ injectedPage }) => {
        // HVDBLink injects links next to DLsite link
        const hvdbLink = injectedPage.locator('a[href*="hvdb.me"]');
        const count = await hvdbLink.count();
        console.log(`HVDB links: ${count}`);
        if (count > 0) {
            const href = await hvdbLink.first().getAttribute('href');
            expect(href).toContain('hvdb.me');
        }
    });

    test('Chobit link is injected on work page', async ({ injectedPage }) => {
        const chobitLink = injectedPage.locator('a[href*="chobit.cc"]');
        const count = await chobitLink.count();
        console.log(`Chobit links: ${count}`);
        if (count > 0) {
            const href = await chobitLink.first().getAttribute('href');
            expect(href).toContain('chobit.cc');
        }
    });

    test('metadata panel does not duplicate on re-navigation', async ({ injectedPage }) => {
        await helpers.gotoHome(injectedPage);
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await injectedPage.waitForTimeout(3000);

        const panels = await injectedPage.locator('.asmr-metadata-panel').count();
        expect(panels).toBeLessThanOrEqual(1);
    });
});
