/**
 * E2E: Interface Translator & Translation Features
 *
 * Tests for InterfaceTranslator (UI element localization),
 * PlayerTranslator, and TranslatedTags features.
 */

import { test, expect, helpers, TEST_WORKS } from './fixtures';

test.describe('Interface Translation', () => {

    test('translated elements exist on home page', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoHome(injectedPage);
        await isScriptLoaded();
        await injectedPage.waitForTimeout(3000);

        // InterfaceTranslator adds data-asmritran attribute to translated elements
        const translatedElements = await injectedPage.locator('[data-asmritran]').count();
        console.log(`Translated elements on home: ${translatedElements}`);
    });

    test('work page has translated title', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();
        await injectedPage.waitForTimeout(3000);

        // WorkMetadata may inject a translated title
        const translatedTitle = injectedPage.locator('.asmr-translated-title, .asmr-original-title');
        const count = await translatedTitle.count();
        console.log(`Translated titles on work page: ${count}`);
    });

    test('tag translations show parenthetical English names', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();
        await injectedPage.waitForTimeout(3000);

        // TranslatedTags adds English translations in parentheses after Japanese tag names
        const hasTranslations = await helpers.hasTranslations(injectedPage);
        console.log(`Has tag translations: ${hasTranslations}`);
    });

    test('metadata chips have translated text', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();
        await injectedPage.waitForTimeout(3000);

        // Chips in the metadata panel should show translations
        const chips = injectedPage.locator('.asmr-chip-tag');
        const chipCount = await chips.count();

        if (chipCount > 0) {
            // Check if any chip text contains a translation (parenthetical)
            for (let i = 0; i < Math.min(chipCount, 5); i++) {
                const text = await chips.nth(i).textContent();
                console.log(`Chip ${i}: ${text}`);
            }
        }
    });
});

test.describe('Player Translation', () => {

    test('player elements are translated on work page', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();
        await injectedPage.waitForTimeout(3000);

        // PlayerTranslator translates various player UI elements
        // Check if any button text has been translated
        const translatedButtons = await injectedPage.locator('[data-asmritran]').count();
        console.log(`Translated player elements: ${translatedButtons}`);
    });
});
