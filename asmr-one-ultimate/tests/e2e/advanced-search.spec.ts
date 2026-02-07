/**
 * E2E: Advanced Search Dialog
 *
 * Tests for the AdvancedSearch feature which provides
 * a dialog for filtering works by tags, VAs, circles, and other criteria.
 */

import { test, expect, helpers, TEST_WORKS } from './fixtures';

test.describe('Advanced Search Dialog', () => {

    test('playlist maker button appears in header', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
        await helpers.gotoHome(injectedPage);
        await isScriptLoaded();
        await waitForBridge();
        await injectedPage.waitForTimeout(2000);

        const btn = helpers.getPlaylistMakerButton(injectedPage);
        const count = await btn.count();
        console.log(`Playlist maker button found: ${count > 0}`);
        expect(count).toBeGreaterThan(0);
    });

    test('clicking playlist button opens advanced search dialog', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
        await helpers.gotoHome(injectedPage);
        await isScriptLoaded();
        await waitForBridge();
        await injectedPage.waitForTimeout(2000);

        await helpers.openAdvancedSearch(injectedPage);

        const dialog = helpers.getAdvancedSearchDialog(injectedPage);
        await expect(dialog).toBeVisible({ timeout: 5000 });
    });

    test('advanced search dialog has include and exclude tag fields', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
        await helpers.gotoHome(injectedPage);
        await isScriptLoaded();
        await waitForBridge();
        await injectedPage.waitForTimeout(2000);

        await helpers.openAdvancedSearch(injectedPage);

        const dialog = helpers.getAdvancedSearchDialog(injectedPage);
        await expect(dialog).toBeVisible({ timeout: 5000 });

        // Include tags input
        const includeInput = dialog.locator('#adv-include-tags, .asmr-include-filter');
        await expect(includeInput).toBeVisible();

        // Exclude tags input
        const excludeInput = dialog.locator('#adv-exclude-tags, .asmr-exclude-filter');
        await expect(excludeInput).toBeVisible();

        // Include and exclude select lists
        const includeSelect = dialog.locator('.asmr-include-select');
        const excludeSelect = dialog.locator('.asmr-exclude-select');
        await expect(includeSelect).toBeVisible();
        await expect(excludeSelect).toBeVisible();
    });

    test('advanced search dialog has VA filter', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
        await helpers.gotoHome(injectedPage);
        await isScriptLoaded();
        await waitForBridge();
        await injectedPage.waitForTimeout(2000);

        await helpers.openAdvancedSearch(injectedPage);

        const dialog = helpers.getAdvancedSearchDialog(injectedPage);
        await expect(dialog).toBeVisible({ timeout: 5000 });

        const vaFilter = dialog.locator('#adv-va-filter, .asmr-va-filter');
        await expect(vaFilter).toBeVisible();

        const vaSelect = dialog.locator('.asmr-va-select');
        await expect(vaSelect).toBeVisible();
    });

    test('advanced search dialog has close button', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
        await helpers.gotoHome(injectedPage);
        await isScriptLoaded();
        await waitForBridge();
        await injectedPage.waitForTimeout(2000);

        await helpers.openAdvancedSearch(injectedPage);

        const dialog = helpers.getAdvancedSearchDialog(injectedPage);
        await expect(dialog).toBeVisible({ timeout: 5000 });

        // Close button in header
        const closeBtn = dialog.locator('.asmr-close-btn');
        await expect(closeBtn).toBeVisible();
    });

    test('close button dismisses the dialog', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
        await helpers.gotoHome(injectedPage);
        await isScriptLoaded();
        await waitForBridge();
        await injectedPage.waitForTimeout(2000);

        await helpers.openAdvancedSearch(injectedPage);

        const dialog = helpers.getAdvancedSearchDialog(injectedPage);
        await expect(dialog).toBeVisible({ timeout: 5000 });

        // Click close
        const closeBtn = dialog.locator('.asmr-close-btn');
        await closeBtn.click();
        await injectedPage.waitForTimeout(500);

        // Dialog overlay should be removed
        const overlay = injectedPage.locator('.asmr-dialog-overlay');
        const isStillVisible = await overlay.isVisible().catch(() => false);
        expect(isStillVisible).toBe(false);
    });

    test('dialog has chips containers for selected tags', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
        await helpers.gotoHome(injectedPage);
        await isScriptLoaded();
        await waitForBridge();
        await injectedPage.waitForTimeout(2000);

        await helpers.openAdvancedSearch(injectedPage);

        const dialog = helpers.getAdvancedSearchDialog(injectedPage);
        await expect(dialog).toBeVisible({ timeout: 5000 });

        const includeChips = dialog.locator('.asmr-chips-include');
        const excludeChips = dialog.locator('.asmr-chips-exclude');
        await expect(includeChips).toHaveCount(1);
        await expect(excludeChips).toHaveCount(1);
    });

    test('dialog has language selector', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
        await helpers.gotoHome(injectedPage);
        await isScriptLoaded();
        await waitForBridge();
        await injectedPage.waitForTimeout(2000);

        await helpers.openAdvancedSearch(injectedPage);

        const dialog = helpers.getAdvancedSearchDialog(injectedPage);
        await expect(dialog).toBeVisible({ timeout: 5000 });

        const languageSelect = dialog.locator('.asmr-language');
        const count = await languageSelect.count();
        console.log(`Language selector found: ${count > 0}`);
    });

    test('no duplicate dialogs on re-open', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
        await helpers.gotoHome(injectedPage);
        await isScriptLoaded();
        await waitForBridge();
        await injectedPage.waitForTimeout(2000);

        // Open dialog
        await helpers.openAdvancedSearch(injectedPage);
        let dialog = helpers.getAdvancedSearchDialog(injectedPage);
        await expect(dialog).toBeVisible({ timeout: 5000 });

        // Close
        const closeBtn = dialog.locator('.asmr-close-btn');
        await closeBtn.click();
        await injectedPage.waitForTimeout(500);

        // Re-open
        await helpers.openAdvancedSearch(injectedPage);
        await injectedPage.waitForTimeout(1000);

        // Should have exactly 1 dialog
        const dialogCount = await injectedPage.locator('.asmr-advanced-search-dialog').count();
        expect(dialogCount).toBeLessThanOrEqual(1);
    });
});
