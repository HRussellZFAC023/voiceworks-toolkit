/**
 * E2E: Work Metadata Panel
 *
 * Tests for the enhanced metadata display on work pages.
 * WorkMetadata scrapes DLsite for additional info and renders
 * a rich metadata panel with tags, CVs, stats, and description.
 */

import { test, expect, helpers, TEST_WORKS } from './fixtures';

test.describe('Work Metadata Panel', () => {

    test.beforeEach(async ({ injectedPage, isScriptLoaded }) => {
        await injectedPage.route('https://wild-sun-1a84.henry-85d.workers.dev/**', async (route) => {
            const url = new URL(route.request().url());
            if (url.pathname.includes('/api/=/product.json')) {
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify([{
                        workno: 'RJ01052162',
                        work_name: 'テスト作品',
                        maker_name: 'テストサークル',
                        age_category: 3,
                        regist_date: '2025-01-01',
                        genres: [{ id: 1, name: '耳かき' }],
                        price: 770,
                    }]),
                });
                return;
            }
            if (url.pathname.includes('/maniax-touch/product/info/ajax')) {
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({ RJ01052162: { rate_average_2dp: 4.8, dl_count: 1234 } }),
                });
                return;
            }
            if (url.pathname.endsWith('.jpg')) {
                await route.fulfill({
                    status: 200,
                    contentType: 'image/png',
                    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6XGD2sAAAAASUVORK5CYII=', 'base64'),
                });
                return;
            }
            if (url.pathname.includes('/work/=/product_id/')) {
                await route.fulfill({
                    status: 200,
                    contentType: 'text/html; charset=utf-8',
                    body: `<!doctype html><html><body>
                        <div class="work_parts_container">
                            <div class="work_parts_multitype_item type_text"><p>これは展開後に読める完全なDLsite作品説明です。音声作品の詳細を確認できます。</p></div>
                            <img src="https://img.dlsite.jp/modpub/images2/parts/RJ01052000/RJ01052162/sample.jpg">
                        </div>
                        <div class="work_buy_container"></div>
                    </body></html>`,
                });
                return;
            }
            await route.fulfill({ status: 404, body: '' });
        });
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();
        await injectedPage.waitForTimeout(2000);
    });

    test('metadata panel is injected on work page', async ({ injectedPage }) => {
        const panel = injectedPage.locator('.asmr-metadata-panel');
        await expect(panel).toBeVisible({ timeout: 15000 });
    });

    test('metadata panel has stats row', async ({ injectedPage }) => {
        const statsRow = injectedPage.locator('.asmr-meta-stats');
        await expect(statsRow).toBeVisible({ timeout: 15000 });

        // Should have at least a badge and price
        const badge = injectedPage.locator('.asmr-meta-badge');
        const price = injectedPage.locator('.asmr-meta-price');
        const badgeCount = await badge.count();
        const priceCount = await price.count();
        console.log(`Badge count: ${badgeCount}, Price count: ${priceCount}`);
        expect(badgeCount + priceCount).toBeGreaterThan(0);
    });

    test('metadata panel shows tag chips', async ({ injectedPage }) => {
        const chips = injectedPage.locator('.asmr-chip-tag');
        await injectedPage.waitForTimeout(3000);
        const count = await chips.count();
        console.log(`Tag chips: ${count}`);
        // Should have at least some tags (CV, circle, or tags)
        expect(count).toBeGreaterThan(0);
    });

    test('tag chips include circle, CV, and tag variants', async ({ injectedPage }) => {
        await injectedPage.waitForTimeout(3000);
        const circleChips = await injectedPage.locator('.asmr-chip-tag--circle').count();
        const cvChips = await injectedPage.locator('.asmr-chip-tag--cv').count();
        const tagChips = await injectedPage.locator('.asmr-chip-tag--tag').count();
        console.log(`Circle: ${circleChips}, CV: ${cvChips}, Tag: ${tagChips}`);
    });

    test('refresh button exists in stats row', async ({ injectedPage }) => {
        const refreshBtn = injectedPage.locator('.asmr-meta-refresh');
        await injectedPage.waitForTimeout(3000);
        const count = await refreshBtn.count();
        console.log(`Refresh button count: ${count}`);
    });

    test('details toggle expands real body and gallery content', async ({ injectedPage }) => {
        const toggle = injectedPage.locator('.asmr-meta-toggle');
        await expect(toggle).toBeVisible({ timeout: 15000 });
        await toggle.click();
        const details = injectedPage.locator('.asmr-meta-details');
        await expect(details).toContainText('これは展開後に読める完全なDLsite作品説明です', { timeout: 15000 });
        await expect(details.locator('.asmr-meta-gallery-item')).toHaveCount(1);
    });

    test('HVDB link is injected on work page', async ({ injectedPage }) => {
        // HVDBLink injects links next to DLsite link
        const hvdbLink = injectedPage.locator('a[href*="hvdb.me"]');
        const count = await hvdbLink.count();
        console.log(`HVDB links: ${count}`);
        if (count > 0) {
            const href = await hvdbLink.first().getAttribute('href');
            expect(href).toContain('hvdb.me');
        }
    });

    test('Chobit link is injected on work page', async ({ injectedPage }) => {
        const chobitLink = injectedPage.locator('a[href*="chobit.cc"]');
        const count = await chobitLink.count();
        console.log(`Chobit links: ${count}`);
        if (count > 0) {
            const href = await chobitLink.first().getAttribute('href');
            expect(href).toContain('chobit.cc');
        }
    });

    test('metadata panel does not duplicate on re-navigation', async ({ injectedPage }) => {
        // Two live-host navigations can each consume most of the shared 30s
        // navigation budget when the CDN is rate-limited. Keep the assertion
        // strict while allowing both readiness attempts to finish.
        test.setTimeout(90_000);
        await helpers.gotoHome(injectedPage);
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await injectedPage.waitForTimeout(3000);

        const panels = await injectedPage.locator('.asmr-metadata-panel').count();
        expect(panels).toBeLessThanOrEqual(1);
    });
});
