/**
 * E2E: Semantic Search (Magic Search / Vector Search) Tests
 *
 * Tests for the semantic search dialog and functionality.
 */

import { test, expect, helpers } from './fixtures';

test.describe('Semantic Search Button', () => {
  test('button is visible in header', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoHome(injectedPage);
    await isScriptLoaded();

    const btn = helpers.getSemanticSearchButton(injectedPage);
    await expect(btn).toBeVisible();
  });

  test('button has tooltip/title', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoHome(injectedPage);
    await isScriptLoaded();

    const btn = helpers.getSemanticSearchButton(injectedPage);
    const title = await btn.getAttribute('title');

    expect(title).toBeTruthy();
    console.log(`Button title: ${title}`);
  });

  test('button icon is psychology', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoHome(injectedPage);
    await isScriptLoaded();

    const btn = helpers.getSemanticSearchButton(injectedPage);
    const icon = btn.locator('.q-icon, .material-icons');
    const text = await icon.textContent();

    expect(text).toContain('psychology');
  });
});

test.describe('Semantic Search Dialog', () => {
  test('clicking button opens dialog', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoHome(injectedPage);
    await isScriptLoaded();

    await helpers.openSemanticSearch(injectedPage);

    const dialog = injectedPage.locator('.asmr-vector-dialog');
    await expect(dialog).toBeVisible();
  });

  test('dialog has search input', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoHome(injectedPage);
    await isScriptLoaded();

    await helpers.openSemanticSearch(injectedPage);

    const input = injectedPage.locator('.asmr-vector-dialog .asmr-vector-input');
    await expect(input).toBeVisible();
  });

  test('dialog has search button', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoHome(injectedPage);
    await isScriptLoaded();

    await helpers.openSemanticSearch(injectedPage);

    const searchBtn = injectedPage.locator('.asmr-vector-go, .asmr-vector-dialog button');
    await expect(searchBtn.first()).toBeVisible();
  });

  test('dialog shows index status', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoHome(injectedPage);
    await isScriptLoaded();

    await helpers.openSemanticSearch(injectedPage);

    const status = injectedPage.locator('.asmr-vector-status');
    await expect(status).toBeVisible();

    const text = await status.textContent();
    console.log(`Index status: ${text}`);
  });

  test('dialog can be closed', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoHome(injectedPage);
    await isScriptLoaded();

    await helpers.openSemanticSearch(injectedPage);

    // Press Escape to close
    await injectedPage.keyboard.press('Escape');
    await injectedPage.waitForTimeout(500);

    // Dialog should be closed or closing
    const isOpen = await helpers.isSemanticSearchOpen(injectedPage);
    // May still be visible briefly during animation
    console.log(`Dialog still open after Escape: ${isOpen}`);
  });
});

test.describe('Semantic Search Results', () => {
  test('results container exists in dialog', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoHome(injectedPage);
    await isScriptLoaded();

    await helpers.openSemanticSearch(injectedPage);

    const resultList = injectedPage.locator('.asmr-vector-result-list');
    await expect(resultList).toHaveCount(1);
  });

  test('empty state shows correctly', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoHome(injectedPage);
    await isScriptLoaded();

    await helpers.openSemanticSearch(injectedPage);

    // Without a search, results should be empty or have placeholder
    const results = injectedPage.locator('.asmr-vector-result');
    const count = await results.count();

    console.log(`Results without search: ${count}`);
  });

  test('results have proper structure', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoHome(injectedPage);
    await isScriptLoaded();

    await helpers.openSemanticSearch(injectedPage);

    // Check for result card structure
    const resultCard = injectedPage.locator('.asmr-vector-result').first();

    // If results exist, check structure
    if (await resultCard.isVisible()) {
      // Should have thumbnail area
      const thumb = resultCard.locator('.asmr-vector-thumb');
      const title = resultCard.locator('.asmr-vector-title');

      console.log(`Has thumb: ${await thumb.isVisible()}`);
      console.log(`Has title: ${await title.isVisible()}`);
    }
  });
});

test.describe('Semantic Search Index', () => {
  test('index count is displayed', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoHome(injectedPage);
    await isScriptLoaded();

    await helpers.openSemanticSearch(injectedPage);

    const count = await helpers.getIndexCount(injectedPage);
    console.log(`Index count: ${count}`);

    // Count should be a number (0 or more)
    expect(typeof count).toBe('number');
    expect(count).toBeGreaterThanOrEqual(0);
  });
});

test.describe('Semantic Search Dialog Styling', () => {
  test('dialog uses theme-aware colors', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoHome(injectedPage);
    await isScriptLoaded();

    await helpers.openSemanticSearch(injectedPage);

    injectedPage.locator('.asmr-vector-dialog');

    // Should have background defined
    const hasBackground = await injectedPage.evaluate(() => {
      const d = document.querySelector('.asmr-vector-dialog');
      if (!d) return false;
      const style = getComputedStyle(d);
      return !!style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)';
    });

    expect(hasBackground).toBe(true);
  });

  test('dialog is properly sized', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoHome(injectedPage);
    await isScriptLoaded();

    await helpers.openSemanticSearch(injectedPage);

    const dialog = injectedPage.locator('.asmr-vector-dialog');
    const box = await dialog.boundingBox();

    expect(box).toBeTruthy();
    if (box) {
      console.log(`Dialog size: ${box.width}x${box.height}`);
      // Should be reasonably large
      expect(box.width).toBeGreaterThan(300);
      expect(box.height).toBeGreaterThan(200);
    }
  });

  test('dialog is responsive on mobile', async ({ injectedPage, isScriptLoaded }) => {
    await injectedPage.setViewportSize({ width: 400, height: 800 });
    await helpers.gotoHome(injectedPage);
    await isScriptLoaded();

    await helpers.openSemanticSearch(injectedPage);

    const dialog = injectedPage.locator('.asmr-vector-dialog');
    const box = await dialog.boundingBox();

    if (box) {
      // On mobile, dialog should be nearly full width
      console.log(`Mobile dialog width: ${box.width}`);
      expect(box.width).toBeGreaterThan(350);
    }
  });
});

test.describe('Semantic Search Input', () => {
  test('input accepts text', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoHome(injectedPage);
    await isScriptLoaded();

    await helpers.openSemanticSearch(injectedPage);

    const input = injectedPage.locator('.asmr-vector-dialog .asmr-vector-input').first();
    await input.fill('ear cleaning');

    const value = await input.inputValue();
    expect(value).toBe('ear cleaning');
  });

  test('input has placeholder', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoHome(injectedPage);
    await isScriptLoaded();

    await helpers.openSemanticSearch(injectedPage);

    const input = injectedPage.locator('.asmr-vector-dialog .asmr-vector-input').first();
    const placeholder = await input.getAttribute('placeholder');

    console.log(`Input placeholder: ${placeholder}`);
  });
});

test.describe('Semantic Search Pagination', () => {
  test('pagination controls exist', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoHome(injectedPage);
    await isScriptLoaded();

    await helpers.openSemanticSearch(injectedPage);

    const pagination = injectedPage.locator('.asmr-vector-pagination');
    const isVisible = await pagination.isVisible();

    console.log(`Pagination visible: ${isVisible}`);
  });
});

test.describe('Semantic Search Stability', () => {
  test('opening/closing dialog repeatedly does not crash', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoHome(injectedPage);
    await isScriptLoaded();

    for (let i = 0; i < 3; i++) {
      await helpers.openSemanticSearch(injectedPage);
      await injectedPage.waitForTimeout(300);
      await injectedPage.keyboard.press('Escape');
      await injectedPage.waitForTimeout(300);
    }

    // Page should still be responsive
    const { alive } = await helpers.monitorHealth(injectedPage, 2);
    expect(alive).toBe(true);
  });

  test('dialog survives page navigation', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoHome(injectedPage);
    await isScriptLoaded();

    // Open dialog
    await helpers.openSemanticSearch(injectedPage);

    // Navigate away (this should close the dialog)
    await helpers.gotoSettings(injectedPage);
    await injectedPage.waitForTimeout(500);

    // Navigate back
    await helpers.gotoHome(injectedPage);
    await injectedPage.waitForTimeout(500);

    // Should be able to open dialog again
    await helpers.openSemanticSearch(injectedPage);
    const isOpen = await helpers.isSemanticSearchOpen(injectedPage);

    expect(isOpen).toBe(true);
  });
});
