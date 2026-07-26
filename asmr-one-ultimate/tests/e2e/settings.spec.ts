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

  test('Translation Settings section is injected', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoSettings(injectedPage);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(1500);

    const section = injectedPage.locator('#asmr-translation-settings-section');
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
    expect(sections.translation).toBe(true);
    expect(sections.whisper).toBe(true);
    expect(sections.storage).toBe(true);
    expect(sections.emergency).toBe(true);
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

  test('Track pool all-folders toggle exists', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoSettings(injectedPage);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(1500);

    await expect(injectedPage.locator('.asmr-toggle[data-key="playlistUseFlatTracks"]')).toBeVisible();
  });

  test('Force Whisper WASM toggle exists', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoSettings(injectedPage);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(1500);

    await expect(injectedPage.locator('.asmr-toggle[data-key="forceWhisperWasm"]')).toBeVisible();
  });

  test('player fullscreen and gallery feature toggles are visible', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoSettings(injectedPage);
    await isScriptLoaded();

    await expect(injectedPage.locator('.asmr-toggle[data-key="enablePlayerFullscreen"]')).toBeVisible();
    await expect(injectedPage.locator('.asmr-toggle[data-key="enablePlayerGallery"]')).toBeVisible();
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
  test('custom translation endpoint, model, and secret inputs are typed correctly', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoSettings(injectedPage);
    await isScriptLoaded();

    const section = injectedPage.locator('#asmr-translation-settings-section');
    await expect(section.locator('input[data-key="translationApiEndpoint"]')).toHaveAttribute('type', 'url');
    await expect(section.locator('input[data-key="translationApiModel"]')).toHaveAttribute('type', 'text');
    await expect(section.locator('input[data-key="translationApiKey"]')).toHaveAttribute('type', 'password');
  });

  test('Emergency Backup uses the bundled Google client without exposing its ID', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoSettings(injectedPage);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(1500);

    const section = injectedPage.locator('#asmr-emergency-export-section');
    const input = section.locator('input[data-key="googleDriveClientId"]');

    await expect(input).toHaveCount(0);
    await expect.poll(() => helpers.getConfig(injectedPage, 'googleDriveClientId'))
      .toMatch(/^166564421003-[a-z0-9]+\.apps\.googleusercontent\.com$/);
    await expect.poll(() => injectedPage.evaluate(() => Boolean(
      (window as typeof window & { google?: { accounts?: { oauth2?: unknown } } })
        .google?.accounts?.oauth2,
    ))).toBe(true);
  });

  test('Whisper runtime controls exist', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoSettings(injectedPage);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(1500);

    const section = injectedPage.locator('#asmr-whisper-settings-section');
    const input = section.locator('.asmr-toggle[data-key="forceWhisperWasm"]');

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

    const backupBtn = injectedPage.getByTestId('settings-backup');
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
    const translationSections = await injectedPage.locator('#asmr-translation-settings-section').count();

    expect(radioSections).toBe(1);
    expect(playlistSections).toBe(1);
    expect(translationSections).toBe(1);
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
  test('settings sections switch every owned surface between light and dark atomically', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoSettings(injectedPage);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(1500);

    const forbidden = '.q-list--dark, .q-item--dark, .q-field--dark, .q-toggle--dark, .bg-black';
    await expect(injectedPage.locator('#asmr-settings-panel-root').locator(forbidden)).toHaveCount(0);

    const surfaces = await injectedPage.evaluate(() => {
      const body = document.body;
      const html = document.documentElement;
      const app = document.getElementById('q-app');
      body.classList.remove('body--dark', 'q-dark');
      html.classList.remove('dark', 'q-dark');
      app?.classList.remove('q-dark');

      const section = document.getElementById('asmr-radio-settings-section') as HTMLElement;
      const input = document.querySelector<HTMLElement>('.asmr-hotkey-input');
      const separator = section.querySelector<HTMLElement>('.asmr-settings-separator');
      const action = document.querySelector<HTMLElement>('[data-testid="settings-backup"]');
      const read = () => ({
        sectionBg: getComputedStyle(section).backgroundColor,
        sectionText: getComputedStyle(section).color,
        inputBg: input ? getComputedStyle(input).backgroundColor : '',
        separatorBg: separator ? getComputedStyle(separator).backgroundColor : '',
        actionBg: action ? getComputedStyle(action).backgroundColor : '',
      });

      const light = read();
      body.classList.add('body--dark');
      const dark = read();
      return { light, dark };
    });

    expect(surfaces.light.sectionBg).not.toBe(surfaces.dark.sectionBg);
    expect(surfaces.light.sectionText).not.toBe(surfaces.dark.sectionText);
    expect(surfaces.light.inputBg).not.toBe(surfaces.dark.inputBg);
    expect(surfaces.light.separatorBg).not.toBe(surfaces.dark.separatorBg);
    expect(surfaces.light.actionBg).not.toBe(surfaces.dark.actionBg);
  });
});

test.describe('Settings Row Layout', () => {
  test('no settings row overlaps or overflows its section at any panel width', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoSettings(injectedPage);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(1500);

    for (const theme of ['light', 'dark'] as const) {
      await injectedPage.evaluate((mode) => {
        document.body.classList.toggle('body--dark', mode === 'dark');
      }, theme);

      for (const width of [360, 480, 768, 1024, 1440]) {
        await injectedPage.setViewportSize({ width, height: 900 });
        await injectedPage.waitForTimeout(150);

        const problems = await injectedPage.evaluate(() => {
          const EPSILON = 0.5;
          const overlaps: string[] = [];
          const overflow: string[] = [];
          for (const section of document.querySelectorAll('.asmr-settings-section')) {
            const bounds = section.getBoundingClientRect();
            const rows = Array.from(section.children);
            for (let index = 0; index < rows.length - 1; index++) {
              const current = rows[index].getBoundingClientRect();
              const next = rows[index + 1].getBoundingClientRect();
              if (current.height === 0 || next.height === 0) continue;
              if (next.top < current.bottom - EPSILON) {
                overlaps.push(`${(rows[index].textContent || '').trim().slice(0, 40)} / ${(rows[index + 1].textContent || '').trim().slice(0, 40)}`);
              }
            }
            for (const label of section.querySelectorAll('.q-item__label, .asmr-range-ticks button')) {
              const rect = label.getBoundingClientRect();
              if (rect.width === 0) continue;
              if (rect.right > bounds.right + EPSILON || rect.left < bounds.left - EPSILON) {
                overflow.push((label.textContent || '').trim().slice(0, 40));
              }
            }
          }
          return { overlaps, overflow };
        });

        expect(problems.overlaps, `${theme} @ ${width}px`).toEqual([]);
        expect(problems.overflow, `${theme} @ ${width}px`).toEqual([]);
      }
    }
  });
});
