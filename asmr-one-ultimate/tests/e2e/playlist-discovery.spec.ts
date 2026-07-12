/** E2E coverage for the append-only public playlist discovery panel. */

import { test, expect, helpers } from './fixtures';

async function openDiscovery(page: import('@playwright/test').Page) {
    const panel = page.locator('#asmr-ultimate-public-playlists');
    await expect(panel).toBeVisible({ timeout: 15000 });
    const toggle = panel.locator('[data-testid="playlist-discover-toggle"]');
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    await expect(panel.locator('[data-testid="playlist-discover-content"]')).toBeVisible();
    return panel;
}

test.describe('Playlist Discovery panel', () => {
    test.beforeEach(async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
        await helpers.gotoPlaylists(injectedPage);
        expect(await isScriptLoaded()).toBe(true);
        await waitForBridge();
    });

    test('appends one discovery panel without replacing native playlist content', async ({ injectedPage }) => {
        const panel = injectedPage.locator('#asmr-ultimate-public-playlists');
        await expect(panel).toHaveCount(1, { timeout: 15000 });
        await expect(injectedPage.locator('.q-page')).toBeVisible();
        await expect(panel.locator('[data-testid="playlist-discover-toggle"]')).toHaveAttribute('aria-expanded', 'false');
    });

    test('expands to localized discovery controls and grid', async ({ injectedPage }) => {
        const panel = await openDiscovery(injectedPage);
        await expect(panel.locator('[data-testid="playlist-discover-filter"]')).toBeVisible();
        await expect(panel.locator('#search-google-btn')).toBeVisible();
        await expect(panel.locator('#playlists-randomize-btn')).toBeVisible();
        await expect(panel.locator('#public-playlists-grid')).toBeVisible();
        await expect(panel.locator('#public-playlist-status')).toBeVisible();
    });

    test('supports keyboard expansion and does not duplicate after navigation', async ({ injectedPage }) => {
        const panel = injectedPage.locator('#asmr-ultimate-public-playlists');
        await expect(panel).toBeVisible({ timeout: 15000 });
        const toggle = panel.locator('[data-testid="playlist-discover-toggle"]');
        await toggle.focus();
        await injectedPage.keyboard.press('Enter');
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');

        await helpers.gotoHome(injectedPage);
        await helpers.gotoPlaylists(injectedPage);
        await expect(injectedPage.locator('#asmr-ultimate-public-playlists')).toHaveCount(1, { timeout: 15000 });
    });
});
