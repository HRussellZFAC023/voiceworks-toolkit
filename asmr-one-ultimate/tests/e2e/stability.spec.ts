/**
 * E2E: Stability Tests
 *
 * Core stability tests ensuring the script doesn't crash or cause
 * memory leaks across navigation and extended use.
 */

import { test, expect, helpers, TEST_WORKS } from './fixtures';

test.describe('Script Initialization', () => {
  test('script loads on home page', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
    await helpers.gotoHome(injectedPage);

    const loaded = await isScriptLoaded();
    expect(loaded).toBe(true);

    const bridgeReady = await waitForBridge(10000);
    expect(bridgeReady).toBe(true);
  });

  test('script loads on work page', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    expect(await isScriptLoaded()).toBe(true);
  });

  test('script loads on settings page', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoSettings(injectedPage);
    expect(await isScriptLoaded()).toBe(true);
  });

  test('script loads on tags page', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoTags(injectedPage);
    expect(await isScriptLoaded()).toBe(true);
  });

  test('ASMRUlt API is exposed globally', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoHome(injectedPage);
    await isScriptLoaded();

    const hasAPI = await injectedPage.evaluate(() => {
      const api = (window as any).ASMRUlt;
      return !!(api && typeof api.get === 'function' && typeof api.set === 'function');
    });
    expect(hasAPI).toBe(true);
  });
});

test.describe('Navigation Stability', () => {
  test('survives home -> work -> settings -> home navigation', async ({ injectedPage, isScriptLoaded }) => {
    // Home
    await helpers.gotoHome(injectedPage);
    expect(await isScriptLoaded()).toBe(true);

    // Work
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    expect(await isScriptLoaded()).toBe(true);

    // Settings
    await helpers.gotoSettings(injectedPage);
    expect(await isScriptLoaded()).toBe(true);

    // Back to home
    await helpers.gotoHome(injectedPage);
    expect(await isScriptLoaded()).toBe(true);
  });

  test('survives rapid navigation between pages', async ({ injectedPage, isScriptLoaded }) => {
    const pages = [
      () => helpers.gotoHome(injectedPage, 500),
      () => helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD, 500),
      () => helpers.gotoSettings(injectedPage, 500),
      () => helpers.gotoTags(injectedPage, 500),
      () => helpers.gotoWorks(injectedPage, 500),
    ];

    for (const nav of pages) {
      await nav();
    }

    // Final check
    expect(await isScriptLoaded()).toBe(true);
  });

  test('no duplicate UI elements after navigation cycle', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoHome(injectedPage);
    await isScriptLoaded();

    // Navigate away and back
    await helpers.gotoSettings(injectedPage);
    await helpers.gotoHome(injectedPage);

    // Check no duplicate radio toggles
    const radioToggles = await injectedPage.locator('.asmr-radio-toggle').count();
    expect(radioToggles).toBeLessThanOrEqual(1);

    // Check no duplicate header actions
    const headerActions = await injectedPage.locator('.asmr-header-actions').count();
    expect(headerActions).toBeLessThanOrEqual(1);
  });
});

test.describe('Page Health', () => {
  test('work page stays alive for 15 seconds', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    expect(await isScriptLoaded()).toBe(true);

    console.log('Monitoring work page health...');
    const { alive, errors, samples } = await helpers.monitorHealth(injectedPage, 15);

    expect(alive).toBe(true);
    expect(errors.length).toBe(0);

    // Check memory isn't growing excessively (< 50MB growth)
    if (samples.length >= 2) {
      const growth = samples[samples.length - 1].heap - samples[0].heap;
      console.log(`Memory growth: ${growth.toFixed(1)}MB`);
      expect(growth).toBeLessThan(50);
    }
  });

  test('settings page stays alive for 10 seconds', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoSettings(injectedPage);
    expect(await isScriptLoaded()).toBe(true);

    console.log('Monitoring settings page health...');
    const { alive, errors: _errors } = await helpers.monitorHealth(injectedPage, 10);

    expect(alive).toBe(true);
    // Settings page previously had crash issues
  });

  test('home page stays alive for 10 seconds', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoHome(injectedPage);
    expect(await isScriptLoaded()).toBe(true);

    console.log('Monitoring home page health...');
    const { alive, errors: _errors2 } = await helpers.monitorHealth(injectedPage, 10);

    expect(alive).toBe(true);
  });

  test('no console errors on page load', async ({ injectedPage }) => {
    const errors: string[] = [];
    injectedPage.on('pageerror', (e) => errors.push(e.message));

    await helpers.gotoHome(injectedPage);
    await injectedPage.waitForTimeout(3000);

    // Filter out non-script errors
    const scriptErrors = errors.filter(e =>
      e.includes('ASMR') || e.includes('asmr') || e.includes('Kikoeru')
    );

    expect(scriptErrors).toHaveLength(0);
  });
});

test.describe('DOM Stability', () => {
  test('DOM node count stays reasonable', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    await isScriptLoaded();

    // Let features finish initializing before measuring baseline
    await injectedPage.waitForTimeout(3000);

    const initialNodes = await injectedPage.evaluate(() => document.querySelectorAll('*').length);

    // Wait and interact
    await injectedPage.waitForTimeout(5000);

    const finalNodes = await injectedPage.evaluate(() => document.querySelectorAll('*').length);
    const growth = finalNodes - initialNodes;

    console.log(`DOM nodes: ${initialNodes} -> ${finalNodes} (growth: ${growth})`);

    // Should not grow by more than 800 nodes in 5 seconds (features add UI elements during init)
    expect(growth).toBeLessThan(800);
  });

  test('no MutationObserver loops (DOM stability)', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    await isScriptLoaded();

    // Track DOM mutations
    const mutationCount = await injectedPage.evaluate(() => {
      return new Promise<number>((resolve) => {
        let count = 0;
        const observer = new MutationObserver((mutations) => {
          count += mutations.length;
        });
        observer.observe(document.body, { childList: true, subtree: true });

        setTimeout(() => {
          observer.disconnect();
          resolve(count);
        }, 5000);
      });
    });

    console.log(`Mutations in 5s: ${mutationCount}`);

    // Should not have excessive mutations (< 1000 in 5 seconds)
    expect(mutationCount).toBeLessThan(1000);
  });
});

test.describe('Error Recovery', () => {
  test('handles missing work gracefully', async ({ injectedPage, isScriptLoaded }) => {
    // Navigate to a non-existent work
    await helpers.gotoWork(injectedPage, 'RJ00000001');

    // Script should still be loaded
    const loaded = await isScriptLoaded();
    expect(loaded).toBe(true);

    // Page should not crash
    const { alive } = await helpers.monitorHealth(injectedPage, 3);
    expect(alive).toBe(true);
  });
});
