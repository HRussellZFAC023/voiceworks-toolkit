/** E2E coverage for filtering inside the current discovery panel. */

import { test, expect, helpers } from './fixtures';

test.describe('Playlist discovery filter', () => {
    test.beforeEach(async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
        await helpers.gotoPlaylists(injectedPage);
        expect(await isScriptLoaded()).toBe(true);
        await waitForBridge();

        const panel = injectedPage.locator('#asmr-ultimate-public-playlists');
        await expect(panel).toBeVisible({ timeout: 15000 });
        const toggle = panel.locator('[data-testid="playlist-discover-toggle"]');
        if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
        await expect(panel.locator('[data-testid="playlist-discover-content"]')).toBeVisible();
    });

    test('filters loaded public cards without changing the native playlist filter', async ({ injectedPage }) => {
        const panel = injectedPage.locator('#asmr-ultimate-public-playlists');
        const filter = panel.locator('[data-testid="playlist-discover-filter"]');
        const nativeFilterCount = await injectedPage.locator('.q-page .q-select').count();

        await filter.fill('definitely-no-matching-playlist');
        await expect(panel).toContainText(/No playlists|一致|符合/i);
        expect(await injectedPage.locator('.q-page .q-select').count()).toBe(nativeFilterCount);
    });

    test('manual-add controls and discovery status remain available while filtering', async ({ injectedPage }) => {
        const panel = injectedPage.locator('#asmr-ultimate-public-playlists');
        const inputs = panel.locator('input');
        await expect(inputs).toHaveCount(2);
        await expect(panel.locator('#public-playlist-count')).toBeVisible();
        await expect(panel.locator('#public-playlist-status')).toBeVisible();
        await expect(panel.locator('#search-google-btn')).toBeVisible();
    });
});
