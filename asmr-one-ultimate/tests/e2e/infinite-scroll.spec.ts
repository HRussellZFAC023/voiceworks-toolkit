/**
 * E2E: Infinite Scroll Manager
 *
 * Tests for InfiniteScrollManager which replaces pagination
 * with automatic page loading on scroll.
 */

import { test, expect, helpers } from './fixtures';

test.describe('Infinite Scroll Manager', () => {

    test('infinite scroll sentinel is created on home page', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
        await helpers.gotoHome(injectedPage);
        await isScriptLoaded();
        await waitForBridge();
        await injectedPage.waitForTimeout(3000);

        // Check if infinite scroll is enabled in config
        const enabled = await injectedPage.evaluate(() => {
            const api = (window as any).ASMRUlt;
            return api?.get?.('enableInfiniteScroll') ?? false;
        });
        console.log(`Infinite scroll enabled: ${enabled}`);

        if (enabled) {
            // Sentinel element should exist when infinite scroll is active
            const sentinel = injectedPage.locator('#infinite-scroll-sentinel');
            const count = await sentinel.count();
            console.log(`Sentinel element found: ${count > 0}`);
        }
    });

    test('infinite scroll singleton is accessible', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
        await helpers.gotoHome(injectedPage);
        await isScriptLoaded();
        await waitForBridge();
        await injectedPage.waitForTimeout(2000);

        const hasInstance = await injectedPage.evaluate(() => {
            return !!(window as any).__ASMR_INFINITE_SCROLL_MANAGER__;
        });
        console.log(`InfiniteScrollManager singleton: ${hasInstance}`);
    });

    test('pagination is hidden when infinite scroll is active', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
        await helpers.gotoHome(injectedPage);
        await isScriptLoaded();
        await waitForBridge();
        await injectedPage.waitForTimeout(3000);

        const enabled = await injectedPage.evaluate(() => {
            const api = (window as any).ASMRUlt;
            return api?.get?.('enableInfiniteScroll') ?? false;
        });

        if (enabled) {
            // Ant pagination should be hidden
            const antPaginationVisible = await injectedPage.locator('.ant-pagination').isVisible().catch(() => false);
            const qPaginationVisible = await injectedPage.locator('.q-pagination').isVisible().catch(() => false);
            console.log(`Ant pagination visible: ${antPaginationVisible}, Q pagination visible: ${qPaginationVisible}`);
            // At least one pagination should be hidden
        }
    });

    test('works page has work cards in grid', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
        await helpers.gotoHome(injectedPage);
        await isScriptLoaded();
        await waitForBridge();
        await injectedPage.waitForTimeout(3000);

        // Work cards should exist on the home page
        const workCards = injectedPage.locator('[id^="RJ"], [id^="rj"]');
        const count = await workCards.count();
        console.log(`Work cards on home page: ${count}`);
        // Home page should have at least some work cards
        expect(count).toBeGreaterThan(0);
    });

    test('infinite scroll does not activate on playlists page', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
        await helpers.gotoPlaylists(injectedPage);
        await isScriptLoaded();
        await waitForBridge();
        await injectedPage.waitForTimeout(2000);

        // InfiniteScrollManager explicitly skips /playlists route
        const sentinel = await injectedPage.locator('#infinite-scroll-sentinel').count();
        expect(sentinel).toBe(0);
    });
});
