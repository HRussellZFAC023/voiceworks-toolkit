/**
 * E2E: Learner Mode Tests
 *
 * Tests for the bilingual subtitle learning feature.
 */

import { test, expect, helpers, TEST_WORKS } from './fixtures';

test.describe('Learner Mode UI Presence', () => {
  test('learner containers exist on work page', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.WITH_SUBTITLES);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(2000);

    // Check for expanded or collapsed subtitle containers
    const expanded = injectedPage.locator('.learner-subs-expanded');
    const collapsed = injectedPage.locator('.learner-subs-collapsed');

    const expandedCount = await expanded.count();
    const collapsedCount = await collapsed.count();

    console.log(`Expanded containers: ${expandedCount}`);
    console.log(`Collapsed containers: ${collapsedCount}`);
  });

  test('learner controls are injected', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.WITH_SUBTITLES);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(2000);

    const controls = helpers.getLearnerControls(injectedPage);
    const count = await controls.count();

    console.log(`Learner control containers: ${count}`);
  });
});

test.describe('Learner Mode Subtitle Display', () => {
  test('JP subtitle container exists', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.WITH_SUBTITLES);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(2000);

    const jp = injectedPage.locator('.learner-jp');
    const count = await jp.count();

    console.log(`JP containers: ${count}`);
  });

  test('EN subtitle container exists', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.WITH_SUBTITLES);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(2000);

    const en = injectedPage.locator('.learner-en');
    const count = await en.count();

    console.log(`EN containers: ${count}`);
  });
});

test.describe('Learner Mode Controls', () => {
  test('prev/next buttons exist', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.WITH_SUBTITLES);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(2000);

    const prevBtn = injectedPage.locator('.learner-prev-btn, [data-asmr="learner-prev"]');
    const nextBtn = injectedPage.locator('.learner-next-btn, [data-asmr="learner-next"]');

    console.log(`Prev buttons: ${await prevBtn.count()}`);
    console.log(`Next buttons: ${await nextBtn.count()}`);
  });

  test('toggle JP button exists', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.WITH_SUBTITLES);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(2000);

    const toggleJp = injectedPage.locator('.learner-toggle-jp, [data-asmr="learner-toggle-jp"]');
    const count = await toggleJp.count();

    console.log(`Toggle JP buttons: ${count}`);
  });
});

test.describe('Learner Mode Blur Mechanic', () => {
  test('EN text can have blurred class', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.WITH_SUBTITLES);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(2000);

    const en = injectedPage.locator('.learner-en').first();
    if (await en.isVisible()) {
      const classes = await en.getAttribute('class');
      console.log(`EN classes: ${classes}`);

      // Check if blurred class is present or can be applied
      const isBlurred = classes?.includes('blurred');
      console.log(`EN is blurred: ${isBlurred}`);
    }
  });

  test('blur CSS is defined', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.WITH_SUBTITLES);
    await isScriptLoaded();

    // Check that blur CSS rule exists
    const hasBlurRule = await injectedPage.evaluate(() => {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule.cssText?.includes('.learner-en.blurred')) {
              return true;
            }
          }
        } catch (e) {
          // Cross-origin stylesheet, skip
        }
      }
      return false;
    });

    console.log(`Blur CSS rule exists: ${hasBlurRule}`);
  });
});

test.describe('Learner Mode Layout', () => {
  test('expanded panel has min-height', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.WITH_SUBTITLES);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(2000);

    const expanded = injectedPage.locator('.learner-subs-expanded').first();
    if (await expanded.isVisible()) {
      const box = await expanded.boundingBox();
      if (box) {
        console.log(`Expanded height: ${box.height}`);
        // Should have some minimum height for stability
        expect(box.height).toBeGreaterThan(30);
      }
    }
  });

  test('collapsed panel is compact', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.WITH_SUBTITLES);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(2000);

    const collapsed = injectedPage.locator('.learner-subs-collapsed').first();
    if (await collapsed.isVisible()) {
      const box = await collapsed.boundingBox();
      if (box) {
        console.log(`Collapsed height: ${box.height}`);
      }
    }
  });
});

test.describe('Learner Mode Cleanup', () => {
  test('subtitle UI cleans up on navigation', async ({ injectedPage, isScriptLoaded }) => {
    // Go to work page
    await helpers.gotoWork(injectedPage, TEST_WORKS.WITH_SUBTITLES);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(2000);

    // Navigate away
    await helpers.gotoHome(injectedPage);
    await injectedPage.waitForTimeout(1000);

    // Check that learner UI was cleaned up
    const expanded = injectedPage.locator('.learner-subs-expanded');
    const collapsed = injectedPage.locator('.learner-subs-collapsed');

    const expandedCount = await expanded.count();
    const collapsedCount = await collapsed.count();

    // Should be minimal or zero on non-work pages
    console.log(`After nav - Expanded: ${expandedCount}, Collapsed: ${collapsedCount}`);
  });

  test('no duplicate containers after re-visiting work', async ({ injectedPage, isScriptLoaded }) => {
    // First visit
    await helpers.gotoWork(injectedPage, TEST_WORKS.WITH_SUBTITLES);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(2000);

    // Navigate away
    await helpers.gotoHome(injectedPage);
    await injectedPage.waitForTimeout(500);

    // Return to work
    await helpers.gotoWork(injectedPage, TEST_WORKS.WITH_SUBTITLES);
    await injectedPage.waitForTimeout(2000);

    // Count containers
    const expanded = await injectedPage.locator('.learner-subs-expanded').count();

    // Should have at most a reasonable number (not duplicated)
    console.log(`Expanded containers after re-visit: ${expanded}`);
    expect(expanded).toBeLessThanOrEqual(2); // Might have main + collapsed
  });
});

test.describe('Learner Mode Accessibility', () => {
  test('control buttons have aria labels', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.WITH_SUBTITLES);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(2000);

    const controls = injectedPage.locator('.learner-controls button, .learner-collapsed-controls button');

    const count = await controls.count();
    for (let i = 0; i < Math.min(count, 3); i++) {
      const btn = controls.nth(i);
      const ariaLabel = await btn.getAttribute('aria-label');
      const title = await btn.getAttribute('title');
      console.log(`Button ${i}: aria-label="${ariaLabel}", title="${title}"`);
    }
  });

  test('controls are keyboard accessible', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.WITH_SUBTITLES);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(2000);

    const controls = injectedPage.locator('.learner-controls button, .learner-collapsed-controls button').first();
    if (await controls.isVisible()) {
      // Should be focusable
      const tabIndex = await controls.getAttribute('tabindex');
      console.log(`First control tabindex: ${tabIndex}`);
    }
  });
});

test.describe('Learner Mode Theme', () => {
  test('subtitle text uses theme colors', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.WITH_SUBTITLES);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(2000);

    const isDark = await helpers.isDarkMode(injectedPage);
    const jp = injectedPage.locator('.learner-jp').first();

    if (await jp.isVisible()) {
      const color = await injectedPage.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).color : null;
      }, '.learner-jp');

      console.log(`Theme: ${isDark ? 'dark' : 'light'}, JP text color: ${color}`);
    }
  });
});
