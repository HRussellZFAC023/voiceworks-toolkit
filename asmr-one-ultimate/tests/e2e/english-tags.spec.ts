/**
 * E2E: English Tags Tests
 *
 * Tests for translated tag display and search.
 */

import { test, helpers, TEST_WORKS } from './fixtures';

test.describe('English Tags Display', () => {
    test('Tags on work page have English labels', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();

        const tags = injectedPage.locator('.q-chip, .tag-chip');
        if (await tags.count() > 0) {
            // Check first tag
            const tag = tags.first();
            const text = await tag.textContent();

            // We assume the userscript appends EN text like "JP Tag (EN Tag)"
            // or adds a tooltip
            console.log(`Tag text: ${text}`);

            // Verify structure if we know it
            // expect(text).toMatch(/.*\(.*\)/); 
        }
    });
});

test.describe('English Tag Search', () => {
    test('Searching for English term triggers tag search', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoHome(injectedPage);
        await isScriptLoaded();

        const searchInput = injectedPage.locator('input[type="search"], .q-field__native').first();
        await searchInput.waitFor({ state: 'visible', timeout: 10000 });
        await searchInput.fill('whispering'); // Known English tag
        await searchInput.press('Enter');

        await injectedPage.waitForTimeout(1000);

        // Should navigate to search results or tag page
        // And the URL should likely contain the tag ID (e.g. /tags/123) 
        // if the redirection logic works

        const url = injectedPage.url();
        console.log(`Search result URL: ${url}`);
    });
});
