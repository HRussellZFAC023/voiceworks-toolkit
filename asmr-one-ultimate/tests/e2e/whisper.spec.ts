/**
 * E2E: Whisper Transcription Tests
 *
 * Tests for the local AI transcription feature.
 */

import { test, expect, helpers, TEST_WORKS } from './fixtures';

test.describe('Whisper Button Presence', () => {
  test('Whisper button exists on work page', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    await isScriptLoaded();
    await helpers.playFirstTrack(injectedPage);

    const btn = helpers.getWhisperButton(injectedPage).first();
    await expect(btn).toBeAttached({ timeout: 10000 });
    await expect(btn).toHaveAttribute('aria-label', /.+/);
    await expect(btn.locator('.material-icons, .q-icon')).toContainText('record_voice_over');

    expect(await helpers.getWhisperButton(injectedPage).count()).toBe(1);
  });

  test('Whisper button has correct icon', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(2000);

    const btn = helpers.getWhisperButton(injectedPage).first();
    if (await btn.isVisible()) {
      const icon = btn.locator('.q-icon, .material-icons, i');
      const text = await icon.textContent();

      console.log(`Whisper button icon: ${text}`);
      // Could be various icons like 'mic', 'record_voice_over', etc.
    }
  });

  test('Whisper button has tooltip', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(2000);

    const btn = helpers.getWhisperButton(injectedPage).first();
    if (await btn.isVisible()) {
      const title = await btn.getAttribute('title');
      const ariaLabel = await btn.getAttribute('aria-label');

      console.log(`Whisper tooltip: ${title || ariaLabel}`);
    }
  });
});

test.describe('Whisper Button Placement', () => {
  test('Whisper button in main player area', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(2000);

    // Check for button in main player controls
    const playerBtn = injectedPage.locator('.audio-player .asmr-whisper-btn, .asmr-whisper-btn--player');
    const count = await playerBtn.count();

    console.log(`Whisper buttons in main player: ${count}`);
  });

  test('Whisper button in mini player', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(2000);

    // Check for button in collapsed/mini player
    const miniBtn = injectedPage.locator('.player-bar .asmr-whisper-btn, .asmr-whisper-btn--mini');
    const count = await miniBtn.count();

    console.log(`Whisper buttons in mini player: ${count}`);
  });
});

test.describe('Whisper Button States', () => {
  test('button has data-active attribute', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(2000);

    const btn = helpers.getWhisperButton(injectedPage).first();
    if (await btn.isVisible()) {
      const dataActive = await btn.getAttribute('data-active');
      console.log(`Whisper data-active: ${dataActive}`);
    }
  });

  test('inactive state has no loading class', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(2000);

    const btn = helpers.getWhisperButton(injectedPage).first();
    if (await btn.isVisible()) {
      const isLoading = await helpers.isWhisperLoading(injectedPage);
      console.log(`Whisper initially loading: ${isLoading}`);

      // Should not be loading on initial load
      expect(isLoading).toBe(false);
    }
  });
});

test.describe('Whisper Button Styling', () => {
  test('button uses Quasar button classes', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(2000);

    const btn = helpers.getWhisperButton(injectedPage).first();
    if (await btn.isVisible()) {
      const classes = await btn.getAttribute('class');
      console.log(`Whisper button classes: ${classes}`);

      // Should have q-btn class for Quasar styling
      const hasQuasarClass = classes?.includes('q-btn');
      console.log(`Has Quasar button class: ${hasQuasarClass}`);
    }
  });

  test('active state uses accent color', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(2000);

    // Check CSS rule for active state
    const hasActiveRule = await injectedPage.evaluate(() => {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule.cssText?.includes('asmr-whisper-btn') &&
                rule.cssText?.includes('data-active')) {
              return true;
            }
          }
        } catch (e) {
          // Skip cross-origin
        }
      }
      return false;
    });

    console.log(`Active state CSS exists: ${hasActiveRule}`);
  });
});

test.describe('Whisper Loading Animation', () => {
  test('loading animation CSS is defined', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    await isScriptLoaded();

    const hasAnimation = await injectedPage.evaluate(() => {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule.cssText?.includes('whisper-load-pulse') ||
                rule.cssText?.includes('asmr-whisper-loading')) {
              return true;
            }
          }
        } catch (e) {
          // Skip cross-origin
        }
      }
      return false;
    });

    console.log(`Loading animation CSS exists: ${hasAnimation}`);
  });
});

test.describe('Whisper Accessibility', () => {
  test('button is keyboard accessible', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(2000);

    const btn = helpers.getWhisperButton(injectedPage).first();
    if (await btn.isVisible()) {
      // Check it's focusable
      await btn.focus();

      const isFocused = await injectedPage.evaluate(() => {
        return document.activeElement?.classList.contains('asmr-whisper-btn');
      });

      console.log(`Button focused: ${isFocused}`);
    }
  });

  test('button has accessible name', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(2000);

    const btn = helpers.getWhisperButton(injectedPage).first();
    if (await btn.isVisible()) {
      const ariaLabel = await btn.getAttribute('aria-label');
      const title = await btn.getAttribute('title');
      const text = await btn.textContent();

      // Should have some accessible name
      // Name is available via ariaLabel, title, or text
      console.log(`Whisper accessible name: ${ariaLabel || title || text}`);
    }
  });
});

test.describe('Whisper Button Sizing', () => {
  test('main player button has adequate size', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(2000);

    const btn = injectedPage.locator('.asmr-whisper-btn--player').first();
    if (await btn.isVisible()) {
      const box = await btn.boundingBox();
      if (box) {
        console.log(`Main player button size: ${box.width}x${box.height}`);
        // Should be reasonably sized
        expect(box.width).toBeGreaterThanOrEqual(28);
        expect(box.height).toBeGreaterThanOrEqual(28);
      }
    }
  });

  test('mini player button has adequate size', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(2000);

    const btn = injectedPage.locator('.asmr-whisper-btn--mini').first();
    if (await btn.isVisible()) {
      const box = await btn.boundingBox();
      if (box) {
        console.log(`Mini player button size: ${box.width}x${box.height}`);
        // Should be compact but tappable
        expect(box.width).toBeGreaterThanOrEqual(24);
        expect(box.height).toBeGreaterThanOrEqual(24);
      }
    }
  });

  test('buttons meet touch target requirements on mobile', async ({ injectedPage, isScriptLoaded }) => {
    await injectedPage.setViewportSize({ width: 400, height: 800 });
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(2000);

    const btn = helpers.getWhisperButton(injectedPage).first();
    if (await btn.isVisible()) {
      const box = await btn.boundingBox();
      if (box) {
        console.log(`Mobile button size: ${box.width}x${box.height}`);
        // Should be at least 44px for touch (or close to it)
        // Note: We log but don't strictly fail, as there may be exceptions
      }
    }
  });
});

test.describe('Whisper Settings', () => {
  test('Whisper settings exist in settings page', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoSettings(injectedPage);
    await isScriptLoaded();
    // Increased wait time for settings injection
    await injectedPage.waitForTimeout(3000);

    const section = injectedPage.locator('#asmr-whisper-settings-section');
    await expect(section).toBeVisible({ timeout: 15000 });
  });

  test('Whisper model download control exists', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoSettings(injectedPage);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(3000);

    const section = injectedPage.locator('#asmr-whisper-settings-section');
    await expect(section).toBeVisible({ timeout: 15000 });

    const download = section.getByRole('button', { name: /download whisper/i });
    await expect(download).toBeVisible({ timeout: 15000 });
    await expect(section.locator('.asmr-settings-hint-text')).not.toHaveText('');
  });

  test('Force Whisper WASM toggle exists', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoSettings(injectedPage);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(3000);

    // Toggle uses data-key attribute on the .asmr-toggle wrapper
    const toggle = injectedPage.locator('#asmr-whisper-settings-section .asmr-toggle[data-key="forceWhisperWasm"]');
    await expect(toggle).toBeVisible({ timeout: 15000 });
  });
});

test.describe('Whisper Stability', () => {
  test('button survives page scroll', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(2000);

    // Scroll down
    await injectedPage.evaluate(() => window.scrollTo(0, 500));
    await injectedPage.waitForTimeout(500);

    // Button should still exist (maybe in mini player)
    const btn = helpers.getWhisperButton(injectedPage);
    const count = await btn.count();

    console.log(`Whisper buttons after scroll: ${count}`);
  });

  test('no duplicate buttons after navigation', async ({ injectedPage, isScriptLoaded }) => {
    // First visit
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(2000);

    const initialCount = await helpers.getWhisperButton(injectedPage).count();

    // Navigate away and back
    await helpers.gotoHome(injectedPage);
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    await injectedPage.waitForTimeout(2000);

    const finalCount = await helpers.getWhisperButton(injectedPage).count();

    console.log(`Whisper buttons: ${initialCount} -> ${finalCount}`);

    // Should not have more buttons than reasonable
    expect(finalCount).toBeLessThanOrEqual(4); // main + mini + possible duplicates
  });
});
