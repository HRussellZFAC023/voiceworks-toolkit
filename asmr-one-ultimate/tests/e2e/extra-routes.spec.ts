/**
 * E2E: Additional route coverage
 */

import { test, expect, helpers } from './fixtures';

test.describe('Additional Routes', () => {
    test('playlists page injects playlist discovery container', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
        await helpers.gotoPlaylists(injectedPage);
        expect(await isScriptLoaded()).toBe(true);
        await waitForBridge();
        await injectedPage.waitForTimeout(1500);

        const container = injectedPage.locator('#asmr-ultimate-public-playlists');
        await expect(container).toBeVisible({ timeout: 10000 });
    });

    test('circles page loads with header actions', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
        await helpers.gotoCircles(injectedPage);
        expect(await isScriptLoaded()).toBe(true);
        await waitForBridge();
        await injectedPage.waitForTimeout(1500);

        const headerActions = helpers.getHeaderActions(injectedPage);
        await expect(headerActions).toBeVisible({ timeout: 10000 });
    });

    test('VAs page loads with header actions', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
        await helpers.gotoVAs(injectedPage);
        expect(await isScriptLoaded()).toBe(true);
        await waitForBridge();
        await injectedPage.waitForTimeout(1500);

        const headerActions = helpers.getHeaderActions(injectedPage);
        await expect(headerActions).toBeVisible({ timeout: 10000 });
    });
});
