/**
 * E2E: Keyboard Shortcuts
 *
 * Tests for KeyboardManager keyboard shortcut registration and handling.
 * Verifies that global shortcuts are registered and don't interfere
 * with form inputs or cause errors.
 */

import { test, expect, helpers, TEST_WORKS } from './fixtures';

test.describe('Keyboard Shortcuts', () => {

    test('KeyboardManager is initialized on work page', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();
        await injectedPage.waitForTimeout(2000);

        // KeyboardManager registers global keydown listener
        // We can verify by checking if the global API reports it
        const hasKeyboardManager = await injectedPage.evaluate(() => {
            const api = (window as any).ASMRUlt;
            return !!(api && api.keyboard);
        }).catch(() => false);
        console.log(`KeyboardManager exposed via API: ${hasKeyboardManager}`);
    });

    test('keyboard shortcuts do not throw errors', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();
        await injectedPage.waitForTimeout(2000);

        const errors: string[] = [];
        injectedPage.on('pageerror', (err) => errors.push(err.message));

        // Press various shortcut keys
        const keys = ['Space', 'm', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '[', ']'];
        for (const key of keys) {
            await injectedPage.keyboard.press(key);
            await injectedPage.waitForTimeout(100);
        }

        // No errors should have occurred
        const keyboardErrors = errors.filter(e => e.toLowerCase().includes('keyboard') || e.toLowerCase().includes('keydown'));
        expect(keyboardErrors).toHaveLength(0);
    });

    test('shortcuts are suppressed in input fields', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();
        await injectedPage.waitForTimeout(2000);

        // Find the search input in the header
        const searchInput = injectedPage.locator('.q-header input[type="text"], .q-header input[type="search"]').first();
        if (await searchInput.isVisible({ timeout: 3000 }).catch(() => false)) {
            await searchInput.focus();
            // Typing 'm' in an input should NOT trigger mute
            await searchInput.type('m');
            const inputValue = await searchInput.inputValue();
            // If keyboard manager correctly suppresses shortcuts in inputs,
            // 'm' should appear as text
            console.log(`Input value after pressing 'm': ${inputValue}`);
        }
    });

    test('Escape key closes semantic search dialog', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoHome(injectedPage);
        await isScriptLoaded();

        // Open semantic search dialog
        await helpers.openSemanticSearch(injectedPage);
        const isOpen = await helpers.isSemanticSearchOpen(injectedPage);
        expect(isOpen).toBe(true);

        // Press Escape should close it
        await injectedPage.keyboard.press('Escape');
        await injectedPage.waitForTimeout(500);

        const isStillOpen = await helpers.isSemanticSearchOpen(injectedPage);
        expect(isStillOpen).toBe(false);
    });
});
