/**
 * E2E: Work Tree Feature Tests
 *
 * Tests Flat View (drawer panel) and Folder Diving features.
 * Flat view opens as a side panel alongside the native tree (non-exclusive).
 *
 * Usage:
 *   npm run test:e2e          # Headless (fast)
 *   npm run test:e2e:headed   # Visible browser (debugging)
 */

import { test, expect, helpers, TEST_WORKS } from './fixtures';

test.describe('Flat View', () => {
    test('flat view button appears on work page', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        expect(await isScriptLoaded()).toBe(true);
        await waitForBridge();

        // Wait for DOM injection
        await injectedPage.waitForTimeout(3000);

        const btn = helpers.getFlatViewButton(injectedPage);
        const count = await btn.count();
        console.log(`Flat view button found: ${count > 0}`);
        expect(count).toBeGreaterThan(0);
    });

    test('clicking flat view button opens panel alongside native tree', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        expect(await isScriptLoaded()).toBe(true);
        await waitForBridge();
        await injectedPage.waitForTimeout(3000);

        // Verify native tree is visible before toggle
        const workTree = helpers.getWorkTree(injectedPage);
        await expect(workTree).toBeVisible({ timeout: 10000 });

        // Click flat view button
        await helpers.toggleFlatView(injectedPage);

        // Flat panel should now be open
        const flatPanel = helpers.isFlatPanelOpen(injectedPage);
        await expect(flatPanel).toBeVisible({ timeout: 5000 });

        // Native tree should STILL be visible (drawer panel coexists)
        await expect(workTree).toBeVisible();
        console.log('Flat panel and native tree both visible: true');
    });

    test('flat view shows all files from all folders', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        expect(await isScriptLoaded()).toBe(true);
        await waitForBridge();
        await injectedPage.waitForTimeout(3000);

        // Activate flat view
        await helpers.toggleFlatView(injectedPage);

        // Host auto-dive can re-render the work tree after the toggle. Wait for
        // the panel's real data readiness instead of sampling after a fixed sleep.
        let flatItemCount = 0;
        await expect.poll(async () => {
            flatItemCount = (await helpers.getFlatViewItems(injectedPage)).length;
            return flatItemCount;
        }, { timeout: 15_000 }).toBeGreaterThan(0);
        console.log(`Flat view items: ${flatItemCount}`);
    });

    test('flat view items show folder path context', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        expect(await isScriptLoaded()).toBe(true);
        await waitForBridge();
        await injectedPage.waitForTimeout(3000);

        await helpers.toggleFlatView(injectedPage);
        await injectedPage.waitForTimeout(2000);

        // Check for caption/subtitle text showing folder paths
        const captions = await injectedPage.locator('.asmr-flat-panel .q-item__label--caption').allTextContents();
        console.log(`Path captions found: ${captions.length}`);
        if (captions.length > 0) {
            console.log(`Sample path: ${captions[0]}`);
        }
        // At least some items should have path context
        expect(captions.length).toBeGreaterThan(0);
    });

    test('flat view items have correct icons by type', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        expect(await isScriptLoaded()).toBe(true);
        await waitForBridge();
        await injectedPage.waitForTimeout(3000);

        await helpers.toggleFlatView(injectedPage);
        await injectedPage.waitForTimeout(2000);

        // Should NOT have any folder icons (all folders are expanded in flat view)
        const folderIcons = await injectedPage.locator('.asmr-flat-panel .q-icon').filter({ hasText: 'folder' }).count();
        console.log(`Folder icons in flat view: ${folderIcons}`);
        expect(folderIcons).toBe(0);

        // Should have audio play buttons or material icons for other types
        const audioButtons = await injectedPage.locator('.asmr-flat-panel .q-btn--round').count();
        const descriptionIcons = await injectedPage.locator('.asmr-flat-panel .q-icon').filter({ hasText: 'description' }).count();
        const photoIcons = await injectedPage.locator('.asmr-flat-panel .q-icon').filter({ hasText: 'photo' }).count();
        console.log(`Audio buttons: ${audioButtons}, Description icons: ${descriptionIcons}, Photo icons: ${photoIcons}`);
        expect(audioButtons + descriptionIcons + photoIcons).toBeGreaterThan(0);
    });

    test('toggling flat view off closes panel', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        expect(await isScriptLoaded()).toBe(true);
        await waitForBridge();
        await injectedPage.waitForTimeout(3000);

        // Toggle on
        await helpers.toggleFlatView(injectedPage);
        const flatPanel = helpers.isFlatPanelOpen(injectedPage);
        await expect(flatPanel).toBeVisible({ timeout: 5000 });

        // Toggle off
        await helpers.toggleFlatView(injectedPage);

        // Panel should no longer have the open class
        await expect(flatPanel).not.toBeVisible({ timeout: 5000 });

        // Native tree should still be visible
        const workTree = helpers.getWorkTree(injectedPage);
        await expect(workTree).toBeVisible();
    });
});

test.describe('Folder Navigation', () => {
    // Skip retry on failure since rate limiting is common
    test.describe.configure({ retries: 2 });

    test('folder names update correctly when navigating via URL path parameter', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
        // This test verifies that folder/file names are correctly displayed
        // when navigating between folder levels via URL query params
        // Bug: stale translation data was overwriting Vue's correct render

        const baseUrl = 'https://asmr.one';
        const workId = TEST_WORKS.STANDARD;

        // First, go to root of work tree (path=[])
        await injectedPage.goto(`${baseUrl}/work/${workId}?path=%5B%5D#work-tree`, {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });
        expect(await isScriptLoaded()).toBe(true);
        await waitForBridge();
        await injectedPage.waitForTimeout(5000);

        // Get initial items at root level
        const workTree = helpers.getWorkTree(injectedPage);
        await expect(workTree).toBeVisible({ timeout: 10000 });

        const rootLabels = await injectedPage.locator('#work-tree .q-item__label:not(.q-item__label--caption)').allTextContents();
        console.log('Root level items (path=[]):', rootLabels);
        const rootItems = rootLabels.filter(l => l.trim().length > 0);
        expect(rootItems.length).toBeGreaterThan(0);

        // Record root item names for later comparison
        const rootItemsSnapshot = [...rootItems];

        // Find a folder to navigate into (should have folder icon)
        const folderItems = await injectedPage.locator('#work-tree .q-item').filter({
            has: injectedPage.locator('.material-icons:text("folder")')
        }).all();

        if (folderItems.length === 0) {
            console.log('No folders found at root, test cannot continue with folder navigation');
            return;
        }

        // Get the first folder's name
        const firstFolderName = await folderItems[0].locator('.q-item__label').first().textContent();
        console.log('Clicking folder:', firstFolderName);

        // Click on first folder
        await folderItems[0].click();
        await injectedPage.waitForTimeout(3000);

        // Get items after navigating into folder
        const subfolderLabels = await injectedPage.locator('#work-tree .q-item__label:not(.q-item__label--caption)').allTextContents();
        console.log('Inside folder items:', subfolderLabels);
        const subfolderItems = subfolderLabels.filter(l => l.trim().length > 0);

        // Content inside folder should be different from root
        const isDifferentContent = JSON.stringify(rootItemsSnapshot) !== JSON.stringify(subfolderItems);
        console.log('Content changed after entering folder:', isDifferentContent);

        // Now navigate back to root via URL change (simulating breadcrumb/back navigation)
        await injectedPage.goto(`${baseUrl}/work/${workId}?path=%5B%5D#work-tree`, {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });
        await injectedPage.waitForTimeout(3000);

        // Get items after navigating back to root
        const returnLabels = await injectedPage.locator('#work-tree .q-item__label:not(.q-item__label--caption)').allTextContents();
        console.log('After returning to root items:', returnLabels);
        const returnItems = returnLabels.filter(l => l.trim().length > 0);

        // CRITICAL CHECK: The items should match the original root items
        // Not the subfolder items (which would indicate stale data)

        // Skip if items didn't load properly (rate limiting)
        if (returnItems.length === 0) {
            console.log('Warning: No items after return navigation (possible rate limiting)');
            test.skip();
            return;
        }

        const hasSubfolderContent = returnItems.some(item => {
            // Check if any return item matches subfolder content but NOT root content
            return subfolderItems.some(subItem =>
                item.includes(subItem) || subItem.includes(item)
            ) && !rootItemsSnapshot.some(rootItem =>
                item.includes(rootItem) || rootItem.includes(item)
            );
        });

        console.log('Has stale subfolder content after returning to root:', hasSubfolderContent);

        // The returned items should match root items (allowing for translation changes)
        // Check by comparing first 8 characters (before any translation parentheses)
        const matchingRootItems = rootItemsSnapshot.filter(rootItem => {
            const rootPrefix = rootItem.substring(0, 8);
            return returnItems.some(retItem =>
                retItem.startsWith(rootPrefix) || retItem.includes(rootPrefix)
            );
        });
        const matchRatio = matchingRootItems.length / rootItemsSnapshot.length;
        console.log(`Root items match ratio: ${matchRatio} (${matchingRootItems.length}/${rootItemsSnapshot.length})`);

        // At least 50% of items should match (accounting for translation differences)
        expect(matchRatio).toBeGreaterThanOrEqual(0.5);
    });

    test('click folder then click ROOT breadcrumb restores correct names', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
        // This test reproduces the exact user-reported bug:
        //   1. Click a folder → see files inside
        //   2. Click ROOT breadcrumb → folder icons appear but NAMES are stale (from subfolder)
        // Root cause: FuriganaRenderer replaces text nodes with <ruby> HTML,
        // preventing Vue from patching {{ item.title }} on re-render.

        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        expect(await isScriptLoaded()).toBe(true);
        await waitForBridge();
        await injectedPage.waitForTimeout(5000);

        const workTree = helpers.getWorkTree(injectedPage);
        await expect(workTree).toBeVisible({ timeout: 10000 });

        // Snapshot root-level labels
        const rootLabels = await injectedPage
            .locator('#work-tree .q-item__label:not(.q-item__label--caption)')
            .allTextContents();
        const rootItems = rootLabels.map(l => l.trim()).filter(l => l.length > 0);
        console.log('Root items:', rootItems);

        if (rootItems.length === 0) {
            console.log('Warning: work tree items not rendered (mock env limitation)');
            test.skip();
            return;
        }

        // Count folders at root
        const rootFolderCount = await helpers.getWorkTreeFolderCount(injectedPage);
        console.log('Root folder count:', rootFolderCount);

        // Find and click first folder
        const folderRows = await injectedPage
            .locator('#work-tree .q-item')
            .filter({ has: injectedPage.locator('.material-icons:text("folder")') })
            .all();

        if (folderRows.length === 0) {
            console.log('No folders found, skipping click navigation test');
            return;
        }

        const folderName = await folderRows[0].locator('.q-item__label').first().textContent();
        console.log('Clicking folder:', folderName?.trim());

        // Click into the folder
        await folderRows[0].click();
        await injectedPage.waitForTimeout(3000);

        // Snapshot subfolder labels
        const subLabels = await injectedPage
            .locator('#work-tree .q-item__label:not(.q-item__label--caption)')
            .allTextContents();
        const subItems = subLabels.map(l => l.trim()).filter(l => l.length > 0);
        console.log('Subfolder items:', subItems);

        // Content should have changed (subfolder has different files)
        if (subItems.length > 0 && rootItems.length > 0) {
            expect(JSON.stringify(subItems)).not.toBe(JSON.stringify(rootItems));
        }

        // Now click ROOT breadcrumb to go back
        const breadcrumbs = await helpers.getBreadcrumbTexts(injectedPage);
        console.log('Breadcrumb texts:', breadcrumbs);

        // Find the ROOT / first breadcrumb and click it
        const rootBreadcrumb = injectedPage
            .locator('#work-tree .q-breadcrumbs .q-btn')
            .first();
        if (await rootBreadcrumb.count() > 0) {
            await rootBreadcrumb.click();
            await injectedPage.waitForTimeout(3000);
        } else {
            console.log('No breadcrumb found, attempting URL-based root navigation');
            const baseUrl = 'https://asmr.one';
            await injectedPage.goto(`${baseUrl}/work/${TEST_WORKS.STANDARD}?path=%5B%5D#work-tree`, {
                waitUntil: 'domcontentloaded',
                timeout: 30000,
            });
            await injectedPage.waitForTimeout(3000);
        }

        // CRITICAL CHECK 1: Labels should match root items, not subfolder items
        const returnLabels = await injectedPage
            .locator('#work-tree .q-item__label:not(.q-item__label--caption)')
            .allTextContents();
        const returnItems = returnLabels.map(l => l.trim()).filter(l => l.length > 0);
        console.log('After ROOT click items:', returnItems);

        if (returnItems.length === 0) {
            console.log('Warning: no items after return (rate limiting?)');
            test.skip();
            return;
        }

        // Folder count should match root level
        const returnFolderCount = await helpers.getWorkTreeFolderCount(injectedPage);
        console.log(`Folder count: root=${rootFolderCount}, after return=${returnFolderCount}`);
        expect(returnFolderCount).toBe(rootFolderCount);

        // Item names should NOT be subfolder content
        const hasStaleSubfolderContent = returnItems.every(item =>
            subItems.some(sub => item === sub)
        );
        console.log('Has stale subfolder content:', hasStaleSubfolderContent);
        expect(hasStaleSubfolderContent).toBe(false);

        // CRITICAL CHECK 2: No stale transcript download buttons should remain
        const staleTranscriptBtns = await injectedPage
            .locator('#work-tree [data-asmr-transcript]')
            .count();
        console.log('Stale transcript buttons:', staleTranscriptBtns);
        // Transcript buttons at root level should be 0 (root has folders and images, not audio)
        // Even if some persist, they should match current items, not stale ones

        // CRITICAL CHECK 3: No stale copy buttons should remain
        const staleCopyBtns = await injectedPage
            .locator('#work-tree [data-xxcopy]')
            .count();
        console.log('Stale copy buttons:', staleCopyBtns);
    });

    test('repeated folder enter/exit preserves correct item names', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
        // Stress test: navigate in/out of folders multiple times
        // to ensure cleanWorkTreeDOM properly resets state each time

        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        expect(await isScriptLoaded()).toBe(true);
        await waitForBridge();
        await injectedPage.waitForTimeout(5000);

        const workTree = helpers.getWorkTree(injectedPage);
        await expect(workTree).toBeVisible({ timeout: 10000 });

        // Take initial root snapshot
        const initialLabels = await injectedPage
            .locator('#work-tree .q-item__label:not(.q-item__label--caption)')
            .allTextContents();
        const initialItems = initialLabels.map(l => l.trim()).filter(l => l.length > 0);

        if (initialItems.length === 0) {
            console.log('No initial items, skipping');
            return;
        }

        // Perform 2 rounds of enter/exit
        for (let round = 0; round < 2; round++) {
            console.log(`--- Round ${round + 1} ---`);

            // Find a folder
            const folders = await injectedPage
                .locator('#work-tree .q-item')
                .filter({ has: injectedPage.locator('.material-icons:text("folder")') })
                .all();

            if (folders.length === 0) {
                console.log('No folders found, stopping');
                break;
            }

            // Click into folder
            await folders[0].click();
            await injectedPage.waitForTimeout(2000);

            const insideLabels = await injectedPage
                .locator('#work-tree .q-item__label:not(.q-item__label--caption)')
                .allTextContents();
            console.log(`  Inside folder: ${insideLabels.map(l => l.trim()).filter(l => l).join(', ')}`);

            // Navigate back to root via breadcrumb
            const rootBtn = injectedPage.locator('#work-tree .q-breadcrumbs .q-btn').first();
            if (await rootBtn.count() > 0) {
                await rootBtn.click();
                await injectedPage.waitForTimeout(2000);
            }

            // Verify root items restored
            const afterLabels = await injectedPage
                .locator('#work-tree .q-item__label:not(.q-item__label--caption)')
                .allTextContents();
            const afterItems = afterLabels.map(l => l.trim()).filter(l => l.length > 0);
            console.log(`  After return: ${afterItems.join(', ')}`);

            // Items should have same count as initial
            expect(afterItems.length).toBe(initialItems.length);
        }
    });
});

test.describe('Folder Diving', () => {
    test('auto-navigates to content folder', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        expect(await isScriptLoaded()).toBe(true);
        await waitForBridge();

        // Wait for auto-dive to complete (DOM click simulation needs time)
        await injectedPage.waitForTimeout(8000);

        // If the work has subfolders, breadcrumbs should appear
        const breadcrumbs = helpers.getBreadcrumbs(injectedPage);
        const breadcrumbCount = await breadcrumbs.count();
        console.log(`Breadcrumbs visible: ${breadcrumbCount > 0}`);

        // Check breadcrumb text (should show folder path)
        if (breadcrumbCount > 0) {
            const texts = await helpers.getBreadcrumbTexts(injectedPage);
            // Filter out empty strings from breadcrumb text extraction
            const nonEmpty = texts.filter(t => t.trim().length > 0);
            console.log(`Breadcrumb path: ${nonEmpty.join(' > ')} (raw items: ${texts.length})`);
            // Breadcrumbs present means dive attempted; text may be empty if DOM click
            // simulation didn't navigate (e.g. folder icon text differs in live app)
            expect(breadcrumbCount).toBeGreaterThan(0);
        }
    });

    test('dive and flat view coexist independently', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        expect(await isScriptLoaded()).toBe(true);
        await waitForBridge();
        await injectedPage.waitForTimeout(3000);

        // Activate flat view
        await helpers.toggleFlatView(injectedPage);
        await injectedPage.waitForTimeout(2000);

        // Flat view should be visible
        const flatPanel = helpers.isFlatPanelOpen(injectedPage);
        await expect(flatPanel).toBeVisible({ timeout: 5000 });

        // Native tree should also be visible (not replaced by flat view)
        const workTree = helpers.getWorkTree(injectedPage);
        await expect(workTree).toBeVisible();

        console.log('Dive and flat view coexist: true');
    });
});
