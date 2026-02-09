/**
 * E2E: Settings Page Tests
 *
 * Tests for the /settings page, ensuring all injected settings
 * sections are present and functional.
 */

import { test, expect, helpers } from './fixtures';

test.describe('Settings Page Injection', () => {
  test('Radio Settings section is injected', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoSettings(injectedPage);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(1500);

    const section = injectedPage.locator('#asmr-radio-settings-section');
    await expect(section).toBeVisible();
  });

  test('Playlist Settings section is injected', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoSettings(injectedPage);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(1500);

    const section = injectedPage.locator('#asmr-playlist-settings-section');
    await expect(section).toBeVisible();
  });

  test('Magic Search Settings section is injected', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoSettings(injectedPage);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(1500);

    const section = injectedPage.locator('#asmr-magic-settings-section');
    await expect(section).toBeVisible();
  });

  test('Whisper Settings section is injected', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoSettings(injectedPage);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(1500);

    const section = injectedPage.locator('#asmr-whisper-settings-section');
    await expect(section).toBeVisible();
  });

  test('Storage & Data section is injected', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoSettings(injectedPage);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(1500);

    const section = injectedPage.locator('#asmr-storage-settings-section');
    await expect(section).toBeVisible();
  });

  test('all settings sections present', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoSettings(injectedPage);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(1500);

    const sections = await helpers.hasSettingsSections(injectedPage);

    expect(sections.radio).toBe(true);
    expect(sections.playlist).toBe(true);
    expect(sections.magic).toBe(true);
    expect(sections.whisper).toBe(true);
    expect(sections.storage).toBe(true);
  });
});

test.describe('Settings Toggles', () => {
    test('toggles enableFavicon', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoSettings(injectedPage);
        await isScriptLoaded();
        await injectedPage.waitForTimeout(1500);

        const initial = await helpers.getToggleState(injectedPage, 'enableFavicon');
        await helpers.clickToggle(injectedPage, 'enableFavicon');
        const after = await helpers.getToggleState(injectedPage, 'enableFavicon');
        expect(after).toBe(!initial);

        // revert
        await helpers.clickToggle(injectedPage, 'enableFavicon');
    });

  test('Play All toggle exists', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoSettings(injectedPage);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(1500);

    await expect(injectedPage.locator('.asmr-toggle[data-key="playAllInFolder"]')).toBeVisible();
  });

  test('Shuffle toggle exists', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoSettings(injectedPage);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(1500);

    await expect(injectedPage.locator('.asmr-toggle[data-key="shuffle"]')).toBeVisible();
  });

  test('Auto Progress toggle exists', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoSettings(injectedPage);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(1500);

    await expect(injectedPage.locator('.asmr-toggle[data-key="autoProgress"]')).toBeVisible();
  });

  test('Flatten Track List toggle exists', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoSettings(injectedPage);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(1500);

    await expect(injectedPage.locator('.asmr-toggle[data-key="radioUseFlatTracks"]')).toBeVisible();
  });

  test('Whisper Quantized toggle exists', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoSettings(injectedPage);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(1500);

    await expect(injectedPage.locator('.asmr-toggle[data-key="whisperQuantized"]')).toBeVisible();
  });
});

test.describe('Settings Toggle Functionality', () => {
  test('toggle changes visual state on click', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoSettings(injectedPage);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(1500);

    // Get initial state of shuffle toggle
    const initialState = await helpers.getToggleState(injectedPage, 'shuffle');
    console.log(`Initial shuffle state: ${initialState}`);

    // Click the toggle
    await helpers.clickToggle(injectedPage, 'shuffle');
    await injectedPage.waitForTimeout(300);

    // Check state changed
    const newState = await helpers.getToggleState(injectedPage, 'shuffle');
    console.log(`New shuffle state: ${newState}`);

    expect(newState).not.toBe(initialState);

    // Revert the change
    await helpers.clickToggle(injectedPage, 'shuffle');
  });

  test('toggle persists value to config', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoSettings(injectedPage);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(1500);

    // Get current config value
    const initialConfig = await helpers.getConfig(injectedPage, 'shuffle');

    // Toggle
    await helpers.clickToggle(injectedPage, 'shuffle');
    await injectedPage.waitForTimeout(300);

    // Check config was updated
    const newConfig = await helpers.getConfig(injectedPage, 'shuffle');
    expect(newConfig).not.toBe(initialConfig);

    // Revert
    await helpers.clickToggle(injectedPage, 'shuffle');
  });
});

test.describe('Settings Input Fields', () => {
  test('API key input exists in Magic Search section', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoSettings(injectedPage);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(1500);

    const section = injectedPage.locator('#asmr-magic-settings-section');
    const input = section.locator('input[data-key="vectorSearchApiKey"]');

    await expect(input).toBeVisible();
  });

  test('Whisper model input exists', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoSettings(injectedPage);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(1500);

    const section = injectedPage.locator('#asmr-whisper-settings-section');
    const input = section.locator('input[data-key="whisperModel"]');

    await expect(input).toBeVisible();
  });

  test('Radio section has toggle fields', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoSettings(injectedPage);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(1500);

    const section = injectedPage.locator('#asmr-radio-settings-section');
    const toggles = section.locator('.q-toggle');

    const count = await toggles.count();
    expect(count).toBeGreaterThan(0);
  });
});

test.describe('Storage & Data', () => {
  test('Backup button exists', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoSettings(injectedPage);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(1500);

    const backupBtn = injectedPage.locator('.asmr-backup-btn');
    await expect(backupBtn).toBeVisible();
  });

  test('Factory Reset button exists', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoSettings(injectedPage);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(1500);

    const nukeBtn = injectedPage.locator('.asmr-nuke-btn');
    await expect(nukeBtn).toBeVisible();
  });
});

test.describe('Settings Page Stability', () => {
  test('settings page does not crash on load', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoSettings(injectedPage);
    await isScriptLoaded();

    const { alive, errors: _errors } = await helpers.monitorHealth(injectedPage, 5);
    expect(alive).toBe(true);
  });

  test('no duplicate sections on re-entry', async ({ injectedPage, isScriptLoaded }) => {
    // First visit
    await helpers.gotoSettings(injectedPage);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(1500);

    // Navigate away
    await helpers.gotoHome(injectedPage);

    // Return to settings
    await helpers.gotoSettings(injectedPage);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(1500);

    // Count sections
    const radioSections = await injectedPage.locator('#asmr-radio-settings-section').count();
    const playlistSections = await injectedPage.locator('#asmr-playlist-settings-section').count();
    const magicSections = await injectedPage.locator('#asmr-magic-settings-section').count();

    expect(radioSections).toBe(1);
    expect(playlistSections).toBe(1);
    expect(magicSections).toBe(1);
  });

  test('toggle states sync correctly on re-entry', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoSettings(injectedPage);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(1500);

    // Toggle shuffle
    await helpers.clickToggle(injectedPage, 'shuffle');
    const stateAfterToggle = await helpers.getToggleState(injectedPage, 'shuffle');

    // Navigate away and back
    await helpers.gotoHome(injectedPage);
    await helpers.gotoSettings(injectedPage);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(1500);

    // State should persist
    const stateAfterReentry = await helpers.getToggleState(injectedPage, 'shuffle');
    expect(stateAfterReentry).toBe(stateAfterToggle);

    // Revert
    await helpers.clickToggle(injectedPage, 'shuffle');
  });
});

test.describe('Settings Theme Support', () => {
  test('settings sections respect current theme', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoSettings(injectedPage);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(1500);

    const isDark = await helpers.isDarkMode(injectedPage);
    console.log(`Theme is dark: ${isDark}`);

    // Check that sections use theme-appropriate classes
    const section = injectedPage.locator('#asmr-radio-settings-section');
    const classes = await section.getAttribute('class');

    if (isDark) {
      expect(classes).toContain('q-list--dark');
    }
  });
});
