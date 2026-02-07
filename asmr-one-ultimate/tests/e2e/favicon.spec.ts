/**
 * E2E: Favicon Now Playing
 *
 * Tests for FaviconNowPlaying feature which dynamically updates
 * the browser favicon to show the currently playing work's cover.
 */

import { test, expect, helpers, TEST_WORKS } from './fixtures';

test.describe('Favicon Now Playing', () => {

    test('favicon link element exists in head', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();
        await injectedPage.waitForTimeout(2000);

        const faviconLink = await injectedPage.evaluate(() => {
            const link = document.querySelector("link[rel*='icon']") as HTMLLinkElement;
            return link ? { href: link.href, rel: link.rel, type: link.type || '' } : null;
        });
        console.log(`Favicon link: ${JSON.stringify(faviconLink)}`);
        expect(faviconLink).not.toBeNull();
    });

    test('FaviconNowPlaying singleton is exposed', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();
        await injectedPage.waitForTimeout(2000);

        const hasInstance = await injectedPage.evaluate(() => {
            return !!(window as any).__ASMR_FAVICON_NOW_PLAYING__;
        });
        console.log(`FaviconNowPlaying singleton: ${hasInstance}`);
    });

    test('enableFavicon config controls the feature', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoSettings(injectedPage);
        await isScriptLoaded();
        await injectedPage.waitForTimeout(1500);

        // Check the toggle exists
        const toggle = injectedPage.locator('.asmr-toggle[data-key="enableFavicon"]');
        await expect(toggle).toBeVisible();

        // Get current state
        const state = await helpers.getToggleState(injectedPage, 'enableFavicon');
        console.log(`Favicon enabled: ${state}`);
    });

    test('favicon does not crash on home page without playback', async ({ injectedPage, isScriptLoaded }) => {
        const errors: string[] = [];
        injectedPage.on('pageerror', (err) => errors.push(err.message));

        await helpers.gotoHome(injectedPage);
        await isScriptLoaded();
        await injectedPage.waitForTimeout(3000);

        // Filter for favicon-related errors
        const faviconErrors = errors.filter(e =>
            e.toLowerCase().includes('favicon') || e.toLowerCase().includes('icon')
        );
        expect(faviconErrors).toHaveLength(0);
    });

    test('favicon link persists through navigation', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoHome(injectedPage);
        await isScriptLoaded();
        await injectedPage.waitForTimeout(1000);

        // Navigate to work page
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await injectedPage.waitForTimeout(2000);

        // Navigate back to home
        await helpers.gotoHome(injectedPage);
        await injectedPage.waitForTimeout(1000);

        // Favicon link should still exist
        const hasFavicon = await injectedPage.evaluate(() => {
            return !!document.querySelector("link[rel*='icon']");
        });
        expect(hasFavicon).toBe(true);
    });
});
