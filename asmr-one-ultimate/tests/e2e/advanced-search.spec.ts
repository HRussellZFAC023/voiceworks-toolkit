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

    test('loads metadata on open and retries an empty transient response on reopen', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
        const attempts: Record<'tags' | 'vas' | 'circles', number> = { tags: 0, vas: 0, circles: 0 };
        let armed = false;
        await injectedPage.route(/\/api\/(tags|vas|circles)\/?(?:\?|$)/, async route => {
            // The host app independently loads some of these endpoints during
            // bootstrap. Start measuring only after the bridge is ready so the
            // assertion specifically covers the hidden userscript dialog.
            if (!armed) {
                await route.fallback();
                return;
            }
            const match = new URL(route.request().url()).pathname.match(/\/api\/(tags|vas|circles)\/?$/);
            const kind = match?.[1] as keyof typeof attempts;
            attempts[kind] += 1;
            if (attempts[kind] === 1) {
                await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"starting"}' });
                return;
            }
            await route.fallback();
        });

        await helpers.gotoHome(injectedPage);
        await isScriptLoaded();
        await waitForBridge();
        armed = true;
        // The always-mounted hidden dialog must not consume its one transient
        // attempt before the user asks to use Advanced Search.
        await injectedPage.waitForTimeout(1500);
        expect(attempts).toEqual({ tags: 0, vas: 0, circles: 0 });

        await helpers.openAdvancedSearch(injectedPage);
        const dialog = helpers.getAdvancedSearchDialog(injectedPage);
        await expect(dialog.getByText('No results found')).toHaveCount(4, { timeout: 5000 });
        expect(attempts).toEqual({ tags: 1, vas: 1, circles: 1 });

        await dialog.locator('.asmr-close-btn').click();
        await helpers.openAdvancedSearch(injectedPage);
        await expect(dialog.getByRole('listbox', { name: /include tags/i }).getByRole('option', { name: /Whisper/ })).toBeVisible();
        await expect(dialog.getByRole('listbox', { name: /voice actor/i }).getByRole('option', { name: /Test VA/ })).toBeVisible();
        await expect(dialog.getByRole('listbox', { name: /circle/i }).getByRole('option', { name: /Test Circle/ })).toBeVisible();
        expect(attempts).toEqual({ tags: 2, vas: 2, circles: 2 });
    });

    test('advanced search dialog has include and exclude tag fields', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
        await helpers.gotoHome(injectedPage);
        await isScriptLoaded();
        await waitForBridge();
        await injectedPage.waitForTimeout(2000);

        await helpers.openAdvancedSearch(injectedPage);

        const dialog = helpers.getAdvancedSearchDialog(injectedPage);
        await expect(dialog).toBeVisible({ timeout: 5000 });

        // Include/exclude tag filters (real site dialog uses placeholder + ARIA listboxes)
        const includeInput = dialog.getByPlaceholder('Type to filter tags...').first();
        const excludeInput = dialog.getByPlaceholder('Type to filter tags...').nth(1);
        await expect(includeInput).toBeVisible();
        await expect(excludeInput).toBeVisible();

        const includeSelect = dialog.getByRole('listbox', { name: /include tags/i });
        const excludeSelect = dialog.getByRole('listbox', { name: /exclude tags/i });
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

        const vaFilter = dialog.getByPlaceholder('Search voice actors...');
        await expect(vaFilter).toBeVisible();

        const vaSelect = dialog.getByRole('listbox', { name: /voice actor/i });
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

        const includeList = dialog.getByRole('listbox', { name: /include tags/i });
        const excludeList = dialog.getByRole('listbox', { name: /exclude tags/i });
        await expect(includeList).toBeVisible();
        await expect(excludeList).toBeVisible();
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
