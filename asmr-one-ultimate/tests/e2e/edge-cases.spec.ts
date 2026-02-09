/**
 * E2E: Edge Case & Bug Regression Tests
 *
 * Tests for race conditions, resource leaks, unhandled errors,
 * and other edge cases discovered via static analysis.
 *
 * Usage:
 *   npm run test:e2e -- tests/e2e/edge-cases.spec.ts
 */

import { test, expect, helpers, TEST_WORKS } from './fixtures';

test.describe('Unhandled Errors', () => {
  test('no unhandled promise rejections on work page load', async ({ injectedPage, isScriptLoaded }) => {
    const rejections: string[] = [];
    injectedPage.on('pageerror', (e) => rejections.push(e.message));

    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    expect(await isScriptLoaded()).toBe(true);

    // Wait for async operations (cache updates, API calls, etc.)
    await injectedPage.waitForTimeout(5000);

    // Filter for our script's errors (not host app noise)
    const scriptRejections = rejections.filter(e =>
      e.includes('AudioCache') || e.includes('HttpClient') ||
      e.includes('KikoeruBridge') || e.includes('ASMR') ||
      e.includes('Unhandled') || e.includes('unhandled')
    );

    console.log(`Script rejections: ${scriptRejections.length}`, scriptRejections);
    expect(scriptRejections).toHaveLength(0);
  });

  test('no unhandled rejections during rapid page navigation', async ({ injectedPage, isScriptLoaded }) => {
    const rejections: string[] = [];
    injectedPage.on('pageerror', (e) => rejections.push(e.message));

    // Rapid navigation: home -> work -> settings -> work -> home
    await helpers.gotoHome(injectedPage, 500);
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD, 500);
    await helpers.gotoSettings(injectedPage, 500);
    await helpers.gotoWork(injectedPage, TEST_WORKS.ALTERNATIVE, 500);
    await helpers.gotoHome(injectedPage, 500);

    // Let in-flight promises settle
    await injectedPage.waitForTimeout(3000);

    const scriptRejections = rejections.filter(e =>
      e.includes('AudioCache') || e.includes('HttpClient') ||
      e.includes('KikoeruBridge') || e.includes('ASMR')
    );

    console.log(`Rejections after rapid nav: ${scriptRejections.length}`, scriptRejections);
    expect(scriptRejections).toHaveLength(0);
  });
});

test.describe('Resource Leaks', () => {
  test('no duplicate event listeners after navigation cycle', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
    await helpers.gotoHome(injectedPage);
    expect(await isScriptLoaded()).toBe(true);
    await waitForBridge();

    // Navigate away and back multiple times
    for (let i = 0; i < 3; i++) {
      await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD, 500);
      await helpers.gotoHome(injectedPage, 500);
    }

    // Check for duplicate UI elements (indicates leaked re-injection)
    const radioToggles = await injectedPage.locator('.asmr-radio-toggle').count();
    const headerActions = await injectedPage.locator('.asmr-header-actions').count();
    const vectorBtns = await injectedPage.locator('.asmr-vector-btn').count();

    console.log(`After 3 nav cycles: radio=${radioToggles}, header=${headerActions}, vector=${vectorBtns}`);
    expect(radioToggles).toBeLessThanOrEqual(1);
    expect(headerActions).toBeLessThanOrEqual(1);
    expect(vectorBtns).toBeLessThanOrEqual(1);
  });

  test('memory does not grow excessively during navigation', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    expect(await isScriptLoaded()).toBe(true);
    await waitForBridge();
    await injectedPage.waitForTimeout(3000);

    // Measure baseline
    const baseline = await injectedPage.evaluate(() =>
      (performance as any).memory?.usedJSHeapSize || 0
    );

    // Navigate back and forth 5 times
    for (let i = 0; i < 5; i++) {
      await helpers.gotoHome(injectedPage, 300);
      await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD, 300);
    }

    await injectedPage.waitForTimeout(2000);

    const after = await injectedPage.evaluate(() =>
      (performance as any).memory?.usedJSHeapSize || 0
    );

    if (baseline > 0 && after > 0) {
      const growthMB = (after - baseline) / 1024 / 1024;
      console.log(`Memory growth after 5 nav cycles: ${growthMB.toFixed(1)}MB`);
      // Allow up to 30MB growth (features init, caches fill)
      expect(growthMB).toBeLessThan(30);
    }
  });
});

test.describe('Race Conditions', () => {
  test.describe.configure({ retries: 1 });

  test('rapid work navigation shows correct metadata', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
    // Navigate to first work
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    expect(await isScriptLoaded()).toBe(true);
    await waitForBridge();
    await injectedPage.waitForTimeout(2000);

    // Rapidly switch to second work
    await helpers.gotoWork(injectedPage, TEST_WORKS.ALTERNATIVE);
    await injectedPage.waitForTimeout(3000);

    // The displayed work should be the ALTERNATIVE, not STANDARD
    const currentUrl = injectedPage.url();
    console.log(`Current URL after rapid nav: ${currentUrl}`);
    expect(currentUrl).toContain(TEST_WORKS.ALTERNATIVE);

    // Check the page didn't crash
    const { alive } = await helpers.monitorHealth(injectedPage, 3);
    expect(alive).toBe(true);
  });

  test('concurrent work page loads do not cause errors', async ({ injectedPage, isScriptLoaded }) => {
    const errors: string[] = [];
    injectedPage.on('pageerror', (e) => errors.push(e.message));

    // Rapid fire: navigate to different works quickly
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD, 200);
    await helpers.gotoWork(injectedPage, TEST_WORKS.ALTERNATIVE, 200);
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD, 200);

    // Let everything settle
    await injectedPage.waitForTimeout(5000);
    expect(await isScriptLoaded()).toBe(true);

    // Filter for metadata-related errors
    const metaErrors = errors.filter(e =>
      e.includes('metadata') || e.includes('Metadata') ||
      e.includes('null') || e.includes('undefined')
    );

    console.log(`Errors after rapid work switching: ${metaErrors.length}`, metaErrors);
    expect(metaErrors).toHaveLength(0);
  });
});

test.describe('Cleanup & Lifecycle', () => {
  test('features survive settings page visit without errors', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
    const errors: string[] = [];
    injectedPage.on('pageerror', (e) => errors.push(e.message));

    // Start on work page (initializes many features)
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    expect(await isScriptLoaded()).toBe(true);
    await waitForBridge();
    await injectedPage.waitForTimeout(2000);

    // Visit settings (features should handle route change gracefully)
    await helpers.gotoSettings(injectedPage);
    await injectedPage.waitForTimeout(2000);

    // Go back to work page (features should re-initialize cleanly)
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    await injectedPage.waitForTimeout(3000);

    const scriptErrors = errors.filter(e =>
      e.includes('ASMR') || e.includes('asmr') ||
      e.includes('Cannot read') || e.includes('is not a function')
    );

    console.log(`Errors during settings round-trip: ${scriptErrors.length}`, scriptErrors);
    expect(scriptErrors).toHaveLength(0);

    // Page should still be healthy
    const { alive } = await helpers.monitorHealth(injectedPage, 3);
    expect(alive).toBe(true);
  });

  test('DOM node count stays stable across navigation', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(3000);

    const initial = await injectedPage.evaluate(() => document.querySelectorAll('*').length);

    // Navigate away and back
    await helpers.gotoHome(injectedPage, 1000);
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    await injectedPage.waitForTimeout(3000);

    const afterRoundTrip = await injectedPage.evaluate(() => document.querySelectorAll('*').length);

    const growth = afterRoundTrip - initial;
    console.log(`DOM nodes: ${initial} -> ${afterRoundTrip} (growth: ${growth})`);

    // Should not accumulate more than 500 extra nodes per round-trip
    expect(growth).toBeLessThan(500);
  });
});
