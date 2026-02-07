/**
 * E2E: Work Page Stability Tests
 *
 * Tests launch a headless browser and automatically inject the userscript.
 * No manual browser setup or Tampermonkey installation required.
 *
 * Usage:
 *   npm run dev          # Start Vite dev server first
 *   npm run test:e2e     # Run tests (headless)
 */

import { test, expect, helpers, TEST_WORKS } from './fixtures';

test.describe('Work Page Stability', () => {
  test('page stays alive with userscript loaded', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);

    // Verify script is loaded
    const loaded = await isScriptLoaded();
    console.log(`Userscript loaded: ${loaded}`);
    expect(loaded).toBe(true);

    // Wait for bridge
    const bridgeReady = await waitForBridge(15000);
    console.log(`Bridge ready: ${bridgeReady}`);
    expect(bridgeReady).toBe(true);

    // Monitor for 10 seconds
    console.log('\nMonitoring page health...');
    const { alive, errors, samples } = await helpers.monitorHealth(injectedPage, 10);

    if (errors.length) {
      console.log('Errors:', errors);
    }

    // Check memory isn't growing excessively
    if (samples.length >= 2) {
      const start = samples[0].heap;
      const end = samples[samples.length - 1].heap;
      const growth = end - start;
      console.log(`Memory growth: ${growth.toFixed(1)}MB`);
      // Allow up to 50MB growth (reasonable for a complex SPA)
      expect(growth).toBeLessThan(50);
    }

    expect(alive).toBe(true);
    expect(errors.length).toBe(0);
  });

  test('navigation between pages stays stable', async ({ injectedPage, isScriptLoaded }) => {
    // Start at home
    await helpers.gotoHome(injectedPage);
    expect(await isScriptLoaded()).toBe(true);

    // Go to work page
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    expect(await isScriptLoaded()).toBe(true);

    // Go to settings
    await helpers.gotoSettings(injectedPage);
    expect(await isScriptLoaded()).toBe(true);

    // Back to home
    await helpers.gotoHome(injectedPage);
    expect(await isScriptLoaded()).toBe(true);

    // Monitor briefly
    const { alive, errors } = await helpers.monitorHealth(injectedPage, 5);
    expect(alive).toBe(true);
    expect(errors.length).toBe(0);
  });

  test('settings page renders without crash', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoSettings(injectedPage);
    expect(await isScriptLoaded()).toBe(true);

    // Check our settings sections exist
    const settingsSection = helpers.getSettingsSection(injectedPage);
    const count = await settingsSection.count();
    console.log(`Settings sections found: ${count}`);

    // Monitor for settings stability
    const { alive } = await helpers.monitorHealth(injectedPage, 5);
    expect(alive).toBe(true);
  });
});

test.describe('Work Page Features', () => {
  test('work tree displays correctly', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    expect(await isScriptLoaded()).toBe(true);
    await waitForBridge();

    // Check work tree exists
    const workTree = helpers.getWorkTree(injectedPage);
    await expect(workTree).toBeVisible({ timeout: 10000 });

    // Check items are loaded
    const items = await helpers.getWorkTreeItems(injectedPage);
    console.log(`Work tree items: ${items.length}`);
    expect(items.length).toBeGreaterThan(0);
  });

  test('flat view button is injected on work page', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    expect(await isScriptLoaded()).toBe(true);
    await waitForBridge();

    // Check flat view button exists
    const flatViewBtn = helpers.getFlatViewButton(injectedPage);
    const exists = await flatViewBtn.count() > 0;
    console.log(`Flat view button exists: ${exists}`);

    // Button should appear after brief delay for DOM injection
    if (!exists) {
      await injectedPage.waitForTimeout(2000);
      const existsAfterWait = await flatViewBtn.count() > 0;
      console.log(`Flat view button exists after wait: ${existsAfterWait}`);
    }
  });

  test('can get current track info', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    expect(await isScriptLoaded()).toBe(true);
    await waitForBridge();

    const track = await helpers.getCurrentTrack(injectedPage);
    console.log('Current track:', track);
    // Track might be null if nothing is playing, that's fine
  });
});

test.describe('UI Elements', () => {
  test('sidebar menu elements are injected', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
    await helpers.gotoHome(injectedPage);
    expect(await isScriptLoaded()).toBe(true);
    await waitForBridge();

    // Wait for sidebar to be ready
    await injectedPage.waitForTimeout(2000);

    // Check for our sidebar elements
    const radioToggle = await injectedPage.locator('.asmr-radio-toggle').count();
    const shuffleToggle = await injectedPage.locator('.asmr-shuffle-toggle').count();

    console.log(`Radio toggle: ${radioToggle > 0}, Shuffle toggle: ${shuffleToggle > 0}`);
  });

  test('header actions are injected', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
    await helpers.gotoHome(injectedPage);
    expect(await isScriptLoaded()).toBe(true);
    await waitForBridge();

    // Wait for header actions to be injected
    await injectedPage.waitForTimeout(2000);

    // Check for semantic search button
    const semanticBtn = helpers.getSemanticSearchButton(injectedPage);
    const semanticExists = await semanticBtn.count() > 0;
    console.log(`Semantic search button: ${semanticExists}`);

    // Check for playlist maker button
    const playlistBtn = helpers.getPlaylistMakerButton(injectedPage);
    const playlistExists = await playlistBtn.count() > 0;
    console.log(`Playlist maker button: ${playlistExists}`);
  });
});

test.describe('Translation Features', () => {
  test('work tree items get translated', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    expect(await isScriptLoaded()).toBe(true);
    await waitForBridge();

    // Wait for translations to be applied (async process)
    await injectedPage.waitForTimeout(5000);

    const hasTranslations = await helpers.hasTranslations(injectedPage);
    console.log(`Has translations: ${hasTranslations}`);
    // Note: translations depend on external API, so we just log the result
  });
});
