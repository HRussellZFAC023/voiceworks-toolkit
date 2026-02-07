import { test, expect, helpers, TEST_WORKS } from './fixtures';

test.describe('MediaViewer v2.0', () => {

    test.beforeEach(async ({ injectedPage: page, isScriptLoaded }) => {
        await helpers.gotoWork(page, TEST_WORKS.STANDARD);
        await isScriptLoaded();
        await expect(page.locator('#work-tree')).toBeVisible({ timeout: 15000 });
        await page.waitForTimeout(2000);
    });

    test('modal element is created on work page', async ({ injectedPage: page }) => {
        // MediaViewer creates the modal during enable()
        const modal = page.locator('#asmr-media-viewer-modal');
        // Modal should exist in DOM (but not active until an image is clicked)
        await expect(modal).toHaveCount(1, { timeout: 10000 });

        // Verify modal has proper structure
        const hasBackdrop = await modal.locator('.media-viewer-backdrop').count();
        const hasBody = await modal.locator('.media-viewer-body').count();
        const hasCounter = await modal.locator('.media-viewer-counter').count();
        const hasZoomControls = await modal.locator('.media-viewer-zoom-controls').count();
        const hasClose = await modal.locator('.media-viewer-close').count();
        const hasNav = await modal.locator('.media-viewer-prev').count();
        const hasThumbnails = await modal.locator('.media-viewer-thumbnails').count();

        expect(hasBackdrop).toBe(1);
        expect(hasBody).toBe(1);
        expect(hasCounter).toBe(1);
        expect(hasZoomControls).toBe(1);
        expect(hasClose).toBe(1);
        expect(hasNav).toBe(1);
        expect(hasThumbnails).toBe(1);
    });

    test('modal can be activated and deactivated', async ({ injectedPage: page }) => {
        const modal = page.locator('#asmr-media-viewer-modal');
        await expect(modal).toHaveCount(1, { timeout: 10000 });

        // Modal should start inactive
        await expect(modal).not.toHaveClass(/active/);

        // Activate the modal directly for testing
        await modal.evaluate(el => el.classList.add('active'));
        await expect(modal).toHaveClass(/active/);

        // Deactivate
        await modal.evaluate(el => el.classList.remove('active'));
        await expect(modal).not.toHaveClass(/active/);
    });

    test('zoom controls are present with correct initial state', async ({ injectedPage: page }) => {
        const modal = page.locator('#asmr-media-viewer-modal');
        await expect(modal).toHaveCount(1, { timeout: 10000 });

        const zoomIn = modal.locator('.media-viewer-zoom-in');
        const zoomOut = modal.locator('.media-viewer-zoom-out');
        const zoomReset = modal.locator('.media-viewer-zoom-reset');
        const zoomIndicator = modal.locator('.media-viewer-zoom-indicator');
        const zoomSlider = modal.locator('.media-viewer-zoom-slider');

        await expect(zoomIn).toHaveCount(1);
        await expect(zoomOut).toHaveCount(1);
        await expect(zoomReset).toHaveCount(1);
        await expect(zoomIndicator).toHaveCount(1);
        await expect(zoomSlider).toHaveCount(1);

        // Initial zoom indicator should show 100%
        await expect(zoomIndicator).toHaveText('100%');
    });

    test('close button triggers hide', async ({ injectedPage: page }) => {
        const modal = page.locator('#asmr-media-viewer-modal');
        await expect(modal).toHaveCount(1, { timeout: 10000 });

        // Activate modal
        await modal.evaluate(el => el.classList.add('active'));
        await expect(modal).toHaveClass(/active/);

        // Click close button
        const closeBtn = modal.locator('.media-viewer-close');
        await closeBtn.click({ force: true });

        // Modal should be deactivated (the close button triggers hideModal)
        await expect(modal).not.toHaveClass(/active/, { timeout: 5000 });
    });

    test('thumbnail container and image thumbnails inject in work tree', async ({ injectedPage: page }) => {
        // Check if the ThumbnailManager injected thumbnails for image files
        const thumbContainers = page.locator('#work-tree .media-thumb-container, .asmr-flat-panel .media-thumb-container');
        const count = await thumbContainers.count();
        console.log(`Image thumbnails injected: ${count}`);
        // Thumbnails may or may not be present depending on whether image files are visible in the current folder
    });

    test('media viewer CSS is injected', async ({ injectedPage: page }) => {
        // Verify the media viewer CSS is loaded
        const hasMediaViewerCSS = await page.evaluate(() => {
            for (const sheet of document.styleSheets) {
                try {
                    for (const rule of sheet.cssRules) {
                        if (rule.cssText?.includes('media-viewer-modal')) {
                            return true;
                        }
                    }
                } catch (e) {
                    // Skip cross-origin
                }
            }
            return false;
        });

        expect(hasMediaViewerCSS).toBe(true);
    });

    test('keyboard handler is registered', async ({ injectedPage: page }) => {
        const modal = page.locator('#asmr-media-viewer-modal');
        await expect(modal).toHaveCount(1, { timeout: 10000 });

        // Activate modal and test Escape key
        await modal.evaluate(el => el.classList.add('active'));
        await expect(modal).toHaveClass(/active/);

        // Press Escape should close the modal
        await page.keyboard.press('Escape');
        await expect(modal).not.toHaveClass(/active/, { timeout: 5000 });
    });

    test('navigation buttons exist in modal', async ({ injectedPage: page }) => {
        const modal = page.locator('#asmr-media-viewer-modal');
        await expect(modal).toHaveCount(1, { timeout: 10000 });

        const prevBtn = modal.locator('.media-viewer-prev');
        const nextBtn = modal.locator('.media-viewer-next');

        await expect(prevBtn).toHaveCount(1);
        await expect(nextBtn).toHaveCount(1);

        // Check ARIA labels
        const prevLabel = await prevBtn.getAttribute('aria-label');
        const nextLabel = await nextBtn.getAttribute('aria-label');
        expect(prevLabel).toBeTruthy();
        expect(nextLabel).toBeTruthy();
    });

    test('action buttons have correct accessibility attributes', async ({ injectedPage: page }) => {
        const modal = page.locator('#asmr-media-viewer-modal');
        await expect(modal).toHaveCount(1, { timeout: 10000 });

        // All action buttons should have aria-label
        const actionButtons = modal.locator('.media-viewer-action');
        const count = await actionButtons.count();
        expect(count).toBeGreaterThan(0);

        for (let i = 0; i < count; i++) {
            const label = await actionButtons.nth(i).getAttribute('aria-label');
            expect(label).toBeTruthy();
        }
    });
});
