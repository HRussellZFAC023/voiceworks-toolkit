/**
 * E2E: Interface Translator & Translation Features
 *
 * Tests for InterfaceTranslator (UI element localization),
 * PlayerTranslator, and TranslatedTags features.
 */

import { test, expect, helpers, TEST_WORKS } from './fixtures';

async function mockGoogleTranslations(
    page: import('@playwright/test').Page,
    translatedText: string,
): Promise<void> {
    await page.route(/^https:\/\/translate\.(?:googleapis\.com|google\.com|google\.co\.jp)\//, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([[[translatedText, '', null, null, 1]], null, 'ja']),
        });
    });
}

test.describe('Interface Translation', () => {

    test('Chinese UI card translation exposes and expands the full text', async ({ injectedPage, isScriptLoaded }) => {
        await mockGoogleTranslations(injectedPage, '完整的卡片翻译文本，用于验证展开后不会被省略。');
        await injectedPage.addInitScript(() => localStorage.setItem('locale', 'zh-CN'));
        await helpers.gotoHome(injectedPage);
        expect(await isScriptLoaded()).toBe(true);

        // The deterministic home mock uses English titles. Add one host-shaped
        // Japanese card so this test exercises the real userscript observer,
        // translation request, insertion, and CSS expansion path in-browser.
        await injectedPage.evaluate(() => {
            const card = document.createElement('div');
            card.className = 'work-card-intersection';
            card.innerHTML = `
                <div class="q-card">
                    <div class="ellipsis-2-lines">
                        <a href="/work/RJ09999999">限界集落で耳舐めと睡眠導入</a>
                    </div>
                </div>`;
            document.body.appendChild(card);
        });

        const translation = injectedPage.locator('.asmr-card-translation').first();
        await expect(translation).toBeVisible({ timeout: 20000 });
        const text = translation.locator('.asmr-card-translation-text');
        await expect(text).not.toHaveText('');
        expect(await translation.getAttribute('title')).toBe(await text.textContent());
        await expect(translation).toHaveAttribute('aria-expanded', 'false');

        await translation.click();
        await expect(translation).toHaveAttribute('aria-expanded', 'true');
        await expect(translation).toHaveClass(/asmr-card-translation--expanded/);
        expect(await text.evaluate((element) => getComputedStyle(element).overflow)).toBe('visible');
    });

    test('document title translates and survives a delayed host overwrite', async ({ injectedPage, isScriptLoaded }) => {
        const translatedTitle = '文档标题译文';
        await mockGoogleTranslations(injectedPage, translatedTitle);
        await injectedPage.addInitScript(() => localStorage.setItem('locale', 'zh-CN'));
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        expect(await isScriptLoaded()).toBe(true);

        await injectedPage.evaluate(() => {
            const runtime = window as Window & {
                __ASMR_KIKOERU_BRIDGE__?: { store?: { state?: { AudioPlayer?: Record<string, unknown> } } };
                __ASMR_EVENT_BUS__?: { emit(event: string, payload: unknown): void };
            };
            const work = {
                id: '1052162',
                title: '限界集落で耳舐め',
                translation_info: { lang: 'JPN', is_original: true },
            };
            const audioPlayer = runtime.__ASMR_KIKOERU_BRIDGE__?.store?.state?.AudioPlayer;
            if (audioPlayer) audioPlayer.work = work;
            runtime.__ASMR_EVENT_BUS__?.emit('work:change', { workId: '1052162', work });
        });

        await expect.poll(() => injectedPage.title(), { timeout: 15000 })
            .toBe(`${translatedTitle} - ASMR Online`);

        await injectedPage.evaluate(() => { document.title = 'Host overwrite'; });
        await expect.poll(() => injectedPage.title(), { timeout: 15000 })
            .toBe(`${translatedTitle} - ASMR Online`);
    });

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

    test('Japanese player text is translated in the active Chinese UI', async ({ injectedPage, isScriptLoaded }) => {
        const translatedPlayerText = '播放器译文';
        await mockGoogleTranslations(injectedPage, translatedPlayerText);
        await injectedPage.addInitScript(() => localStorage.setItem('locale', 'zh-CN'));
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        expect(await isScriptLoaded()).toBe(true);

        await injectedPage.evaluate(() => {
            const runtime = window as Window & {
                __ASMR_KIKOERU_BRIDGE__?: { store?: { state?: { AudioPlayer?: Record<string, unknown> } } };
                __ASMR_EVENT_BUS__?: { emit(event: string, payload: unknown): void };
            };
            const hostPlayer = document.createElement('div');
            hostPlayer.id = 'e2e-player-translation';
            hostPlayer.className = 'audio-player';
            hostPlayer.innerHTML = `
                <div class="ellipsis-2-lines text-bold q-pb-xs">耳舐め音声.mp3</div>
                <span class="text-caption">限界集落</span>`;
            document.body.appendChild(hostPlayer);

            const track = { title: '耳舐め音声.mp3', hash: 'e2e-player-translation' };
            const work = {
                id: '1052162',
                title: '限界集落',
                translation_info: { lang: 'JPN', is_original: true },
            };
            const audioPlayer = runtime.__ASMR_KIKOERU_BRIDGE__?.store?.state?.AudioPlayer;
            if (audioPlayer) {
                audioPlayer.currentTrack = track;
                audioPlayer.work = work;
            }
            runtime.__ASMR_EVENT_BUS__?.emit('track:change', { track, workId: '1052162' });
        });

        const translatedTrack = injectedPage.locator(
            '#e2e-player-translation .ellipsis-2-lines[data-asmr-translated="true"]',
        );
        await expect(translatedTrack).toHaveAttribute(
            'data-asmr-translated-text',
            translatedPlayerText,
            { timeout: 15000 },
        );
        await expect(translatedTrack).toHaveAttribute('data-asmr-source', '耳舐め音声.mp3');
    });

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
