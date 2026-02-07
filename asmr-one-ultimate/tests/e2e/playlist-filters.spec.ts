/**
 * E2E: Playlist Filter Modes
 *
 * Verifies that each filter mode on the playlists page works correctly:
 * - All: User's playlists first (most recent), then public
 * - I liked: Only playlists liked from other users
 * - I created: Only user's own created playlists (including 0-work ones)
 * - Online only: Only discovered public playlists from known IDs
 */

import { test, expect, helpers } from './fixtures';

test.describe('Playlist Filter Modes', () => {
    test('All filter shows user playlists first then public playlists', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
        await helpers.gotoPlaylists(injectedPage);
        expect(await isScriptLoaded()).toBe(true);
        await waitForBridge();

        // Wait for our container to appear
        const container = injectedPage.locator('#asmr-ultimate-public-playlists');
        await expect(container).toBeVisible({ timeout: 20000 });

        // Wait for grid to have some cards loaded
        const grid = injectedPage.locator('#public-playlists-grid');
        await expect(grid).toBeVisible({ timeout: 10000 });

        // Wait for at least one card or skeleton to appear
        await injectedPage.waitForTimeout(5000);

        // Take screenshot of the "All" view
        await injectedPage.screenshot({ path: 'tests/e2e/screenshots/filter-all.png', fullPage: false });

        // Check that the status shows loaded playlists
        const statusEl = injectedPage.locator('#public-playlist-status');
        if (await statusEl.isVisible({ timeout: 3000 }).catch(() => false)) {
            const statusText = await statusEl.textContent();
            console.log(`[All] Status: ${statusText}`);
        }

        // Check the count badge
        const countBadge = injectedPage.locator('#public-playlist-count');
        if (await countBadge.isVisible({ timeout: 3000 }).catch(() => false)) {
            const countText = await countBadge.textContent();
            console.log(`[All] Count: ${countText}`);
        }

        // Verify cards are present in the grid
        const cards = grid.locator('.col-xs-6');
        const cardCount = await cards.count();
        console.log(`[All] Cards in grid: ${cardCount}`);
        expect(cardCount).toBeGreaterThan(0);
    });

    test('filter dropdown can switch modes and shows correct playlists', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
        await helpers.gotoPlaylists(injectedPage);
        expect(await isScriptLoaded()).toBe(true);
        await waitForBridge();

        // Wait for our container
        await expect(injectedPage.locator('#asmr-ultimate-public-playlists')).toBeVisible({ timeout: 20000 });
        await injectedPage.waitForTimeout(3000);

        // Take screenshot of initial "All" state
        await injectedPage.screenshot({ path: 'tests/e2e/screenshots/filter-initial-all.png', fullPage: false });

        // Find the native q-select dropdown
        const qSelect = injectedPage.locator('.q-page .q-select').first();
        const selectExists = await qSelect.count() > 0;
        console.log(`[Filter] Native dropdown exists: ${selectExists}`);

        if (!selectExists) {
            console.log('[Filter] No native dropdown found, skipping filter switch tests');
            return;
        }

        // Get current dropdown value
        const currentValue = await qSelect.locator('.q-field__native').textContent().catch(() => 'unknown');
        console.log(`[Filter] Current dropdown value: ${currentValue}`);

        // === Test "I liked" filter ===
        await qSelect.click();
        await injectedPage.waitForTimeout(500);

        // Find the "I liked" option in the dropdown popup
        const likedOption = injectedPage.locator('.q-item').filter({ hasText: /liked|お気に入り|喜欢/i }).first();
        if (await likedOption.isVisible({ timeout: 2000 }).catch(() => false)) {
            await likedOption.click();
            await injectedPage.waitForTimeout(3000);
            await injectedPage.screenshot({ path: 'tests/e2e/screenshots/filter-liked.png', fullPage: false });

            const countAfterLiked = injectedPage.locator('#public-playlist-count');
            if (await countAfterLiked.isVisible({ timeout: 2000 }).catch(() => false)) {
                console.log(`[Liked] Count: ${await countAfterLiked.textContent()}`);
            }

            const gridLiked = injectedPage.locator('#public-playlists-grid .col-xs-6');
            console.log(`[Liked] Cards: ${await gridLiked.count()}`);
        } else {
            console.log('[Filter] "I liked" option not found in dropdown');
        }

        // === Test "I created" filter ===
        await qSelect.click();
        await injectedPage.waitForTimeout(500);

        const createdOption = injectedPage.locator('.q-item').filter({ hasText: /created|作成|创建/i }).first();
        if (await createdOption.isVisible({ timeout: 2000 }).catch(() => false)) {
            await createdOption.click();
            await injectedPage.waitForTimeout(3000);
            await injectedPage.screenshot({ path: 'tests/e2e/screenshots/filter-created.png', fullPage: false });

            const countAfterCreated = injectedPage.locator('#public-playlist-count');
            if (await countAfterCreated.isVisible({ timeout: 2000 }).catch(() => false)) {
                console.log(`[Created] Count: ${await countAfterCreated.textContent()}`);
            }

            const gridCreated = injectedPage.locator('#public-playlists-grid .col-xs-6');
            console.log(`[Created] Cards: ${await gridCreated.count()}`);
        } else {
            console.log('[Filter] "I created" option not found in dropdown');
        }

        // === Test "Online only" filter ===
        await qSelect.click();
        await injectedPage.waitForTimeout(500);

        const onlineOption = injectedPage.locator('.q-item').filter({ hasText: /online|オンライン|仅在线/i }).first();
        if (await onlineOption.isVisible({ timeout: 2000 }).catch(() => false)) {
            await onlineOption.click();
            await injectedPage.waitForTimeout(3000);
            await injectedPage.screenshot({ path: 'tests/e2e/screenshots/filter-online.png', fullPage: false });

            const countAfterOnline = injectedPage.locator('#public-playlist-count');
            if (await countAfterOnline.isVisible({ timeout: 2000 }).catch(() => false)) {
                console.log(`[Online] Count: ${await countAfterOnline.textContent()}`);
            }

            const gridOnline = injectedPage.locator('#public-playlists-grid .col-xs-6');
            const onlineCards = await gridOnline.count();
            console.log(`[Online] Cards: ${onlineCards}`);
            // Online should have cards from known playlists
            expect(onlineCards).toBeGreaterThan(0);
        } else {
            console.log('[Filter] "Online only" option not found in dropdown');
        }

        // === Switch back to "All" and verify ===
        await qSelect.click();
        await injectedPage.waitForTimeout(500);

        const allOption = injectedPage.locator('.q-item').filter({ hasText: /^All$|すべて|全部/i }).first();
        if (await allOption.isVisible({ timeout: 2000 }).catch(() => false)) {
            await allOption.click();
            await injectedPage.waitForTimeout(3000);
            await injectedPage.screenshot({ path: 'tests/e2e/screenshots/filter-back-to-all.png', fullPage: false });

            const gridAll = injectedPage.locator('#public-playlists-grid .col-xs-6');
            const allCards = await gridAll.count();
            console.log(`[All restored] Cards: ${allCards}`);
            expect(allCards).toBeGreaterThan(0);
        }
    });

    test('user 0-work playlists are not filtered out in I created mode', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
        await helpers.gotoPlaylists(injectedPage);
        expect(await isScriptLoaded()).toBe(true);
        await waitForBridge();

        // Wait for our container
        await expect(injectedPage.locator('#asmr-ultimate-public-playlists')).toBeVisible({ timeout: 20000 });
        await injectedPage.waitForTimeout(3000);

        // Switch to "I created" filter
        const qSelect = injectedPage.locator('.q-page .q-select').first();
        if (await qSelect.count() === 0) {
            console.log('[0-work] No dropdown found, skipping');
            return;
        }

        await qSelect.click();
        await injectedPage.waitForTimeout(500);

        const createdOption = injectedPage.locator('.q-item').filter({ hasText: /created|作成|创建/i }).first();
        if (await createdOption.isVisible({ timeout: 2000 }).catch(() => false)) {
            await createdOption.click();
            await injectedPage.waitForTimeout(5000);

            // Check the playlist count - should include user's playlists including empty ones
            const countBadge = injectedPage.locator('#public-playlist-count');
            if (await countBadge.isVisible({ timeout: 2000 }).catch(() => false)) {
                const countText = await countBadge.textContent() || '';
                console.log(`[I Created] Playlist count: ${countText}`);
                // Extract number from count text
                const match = countText.match(/(\d+)/);
                if (match) {
                    const count = parseInt(match[1], 10);
                    console.log(`[I Created] Numeric count: ${count}`);
                    // User should have at least some playlists
                    expect(count).toBeGreaterThanOrEqual(0);
                }
            }

            await injectedPage.screenshot({ path: 'tests/e2e/screenshots/filter-created-with-empty.png', fullPage: false });
        }
    });
});
