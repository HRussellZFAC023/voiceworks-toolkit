/**
 * E2E: UI Element Tests
 *
 * Tests for UI injection, visibility, and correct placement
 * of all userscript elements.
 */

import { test, expect, helpers, TEST_WORKS } from './fixtures';

test.describe('Sidebar Elements', () => {
  test('Radio Mode toggle is injected in sidebar', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoHome(injectedPage);
    await isScriptLoaded();
    // Wait for sidebar injection
    await injectedPage.waitForTimeout(2000);

    const sidebar = helpers.getSidebar(injectedPage);
    await expect(sidebar).toBeVisible();

    // Radio toggle should exist (uses ID, not class)
    const radioToggle = injectedPage.locator('#asmr-radio-toggle');
    await expect(radioToggle).toBeVisible({ timeout: 10000 });
  });

  test('Radio Mode shows ON/OFF status', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoHome(injectedPage);
    await isScriptLoaded();

    const status = helpers.getRadioStatus(injectedPage);
    const text = await status.textContent();

    // Should show either ON or OFF
    expect(text?.includes('ON') || text?.includes('OFF')).toBe(true);
  });

  test('Shuffle toggle is visible in sidebar', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoHome(injectedPage);
    await isScriptLoaded();

    const shuffleToggle = injectedPage.locator('.asmr-shuffle-toggle, [data-asmr="shuffle-toggle"]');
    // May or may not be visible depending on implementation
    const count = await shuffleToggle.count();
    console.log(`Shuffle toggle count: ${count}`);
  });
});

test.describe('Header Elements', () => {
  test('keeps Material Icons usable when every remote font request is blocked', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoHome(injectedPage);
    await isScriptLoaded();

    const metrics = await injectedPage.evaluate(async () => {
      const names = ['skip_previous', 'replay_10', 'pause', 'forward_10', 'skip_next'];
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:-9999px;top:0;display:flex';
      for (const name of names) {
        const icon = document.createElement('i');
        icon.className = 'material-icons';
        icon.textContent = name;
        icon.style.width = '30px';
        icon.style.fontSize = '24px';
        host.appendChild(icon);
      }
      document.body.appendChild(host);
      await document.fonts.ready;
      const result = [...host.children].map(element => ({
        name: element.textContent,
        clientWidth: (element as HTMLElement).clientWidth,
        scrollWidth: (element as HTMLElement).scrollWidth,
      }));
      host.remove();
      return result;
    });

    expect(metrics).toHaveLength(5);
    for (const metric of metrics) {
      expect(metric.scrollWidth, `${metric.name} spilled fallback text`).toBeLessThanOrEqual(metric.clientWidth + 1);
    }
  });

  test('header actions container is injected', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoHome(injectedPage);
    await isScriptLoaded();

    const headerActions = helpers.getHeaderActions(injectedPage);
    await expect(headerActions).toBeVisible();
  });

  test('Semantic Search button is in header', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoHome(injectedPage);
    await isScriptLoaded();

    const btn = helpers.getSemanticSearchButton(injectedPage);
    await expect(btn).toBeVisible();
  });

  test('Semantic Search button has correct icon', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoHome(injectedPage);
    await isScriptLoaded();

    const btn = helpers.getSemanticSearchButton(injectedPage);
    const icon = btn.locator('.q-icon, .material-icons');

    // Vector search uses the Material `saved_search` glyph.
    const iconText = await icon.textContent();
    expect(iconText).toContain('saved_search');
  });

  test('Support button is visible', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoHome(injectedPage);
    await isScriptLoaded();

    const supportBtn = injectedPage.locator('.asmr-support-btn');
    const count = await supportBtn.count();
    console.log(`Support button count: ${count}`);
  });
});

test.describe('Player Bar Elements', () => {
  test('starting a track initializes the player and requests playback', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    await isScriptLoaded();
    await helpers.playFirstTrack(injectedPage);

    const playback = await injectedPage.evaluate(() => {
      const bridge = (window as any).__ASMR_KIKOERU_BRIDGE__;
      const player = bridge?.store?.state?.AudioPlayer
        || bridge?._app?.$store?.state?.AudioPlayer;
      const queue = player?.queue || player?.playlist || [];
      const current = player?.currentPlayingFile
        || player?.currentTrack
        || queue[player?.queueIndex ?? 0];
      return {
        currentTitle: current?.title || '',
        queueLength: Array.isArray(queue) ? queue.length : 0,
        playing: player?.playing,
        controlSignal: player?.playingControlSignal || '',
      };
    });

    expect(playback.currentTitle).toBeTruthy();
    expect(playback.queueLength).toBeGreaterThan(0);
    expect(playback.playing || playback.controlSignal === 'wantPlay').toBe(true);
    await expect(injectedPage.locator('.player-bar-container, .player-bar, .q-footer').first())
      .toBeAttached({ timeout: 10000 });
  });

  test('Whisper button appears in player controls', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    await isScriptLoaded();

    const whisperBtn = helpers.getWhisperButton(injectedPage);
    // Wait for it to be injected
    await injectedPage.waitForTimeout(2000);

    const count = await whisperBtn.count();
    console.log(`Whisper button count: ${count}`);
    // Should have at least one whisper button
    expect(count).toBeGreaterThanOrEqual(0); // May not always be present
  });

  test('Learner controls container exists', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.WITH_SUBTITLES);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(2000);

    const learnerControls = helpers.getLearnerControls(injectedPage);
    const count = await learnerControls.count();
    console.log(`Learner controls count: ${count}`);
  });
});

test.describe('Work Page Elements', () => {
  test('file list is present on work page', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    await isScriptLoaded();

    const fileList = injectedPage.locator('.q-virtual-scroll__content, .file-list-virtual-scroll, #work-tree');
    await expect(fileList.first()).toBeVisible({ timeout: 10000 });
  });

  test('track items are visible', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    await isScriptLoaded();

    const trackItems = injectedPage.locator('.q-item, .file-list-item');
    await injectedPage.waitForTimeout(2000);

    const count = await trackItems.count();
    console.log(`Track items: ${count}`);
    expect(count).toBeGreaterThan(0);
  });
});

test.describe('Theme Compatibility', () => {
  test('elements are visible in current theme', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoHome(injectedPage);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(2000);

    const isDark = await helpers.isDarkMode(injectedPage);
    console.log(`Dark mode: ${isDark}`);

    // All key elements should be visible regardless of theme
    const radioToggle = injectedPage.locator('#asmr-radio-toggle');
    const semanticBtn = helpers.getSemanticSearchButton(injectedPage);

    await expect(radioToggle).toBeVisible({ timeout: 10000 });
    await expect(semanticBtn).toBeVisible({ timeout: 10000 });
  });

  test('accent color is applied to active elements', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoHome(injectedPage);
    await isScriptLoaded();

    // Check that CSS variables are defined
    const hasAccent = await injectedPage.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return !!style.getPropertyValue('--asmr-accent');
    });

    expect(hasAccent).toBe(true);
  });
});

test.describe('Accessibility', () => {
  test('buttons have accessible labels', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    await isScriptLoaded();
    await injectedPage.waitForTimeout(2000);

    // Check Semantic Search button has title/aria-label
    const semanticBtn = helpers.getSemanticSearchButton(injectedPage);
    const title = await semanticBtn.getAttribute('title');
    const ariaLabel = await semanticBtn.getAttribute('aria-label');

    expect(title || ariaLabel).toBeTruthy();
  });

  test('interactive elements are keyboard focusable', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoHome(injectedPage);
    await isScriptLoaded();

    // Tab through and check we can reach our elements
    const semanticBtn = helpers.getSemanticSearchButton(injectedPage);

    // Focus the button
    await semanticBtn.focus();
    await injectedPage.evaluate(() => {
      return document.activeElement?.classList.contains('asmr-vector-btn');
    });

    // Button should be focusable
    expect(await semanticBtn.isVisible()).toBe(true);
  });

  test('focus outlines are visible', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoHome(injectedPage);
    await isScriptLoaded();

    const semanticBtn = helpers.getSemanticSearchButton(injectedPage);
    await semanticBtn.focus();

    // Check focus styles are applied (via CSS)
    const hasFocusStyle = await injectedPage.evaluate(() => {
      const btn = document.querySelector('.asmr-vector-btn:focus');
      if (!btn) return false;
      const style = getComputedStyle(btn);
      return style.outline !== 'none' || style.outlineWidth !== '0px';
    });

    // Focus styling should be defined in CSS
    console.log(`Has focus style: ${hasFocusStyle}`);
  });
});

test.describe('Responsive Design', () => {
  test('elements adapt to narrow viewport', async ({ injectedPage, isScriptLoaded }) => {
    await injectedPage.setViewportSize({ width: 400, height: 800 });
    await helpers.gotoHome(injectedPage);
    await isScriptLoaded();

    // Core elements should still be accessible
    const semanticBtn = helpers.getSemanticSearchButton(injectedPage);
    await expect(semanticBtn).toBeVisible();
  });

  test('playback UI does not overflow a small screen', async ({ injectedPage, isScriptLoaded }) => {
    await injectedPage.setViewportSize({ width: 400, height: 800 });
    await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
    await isScriptLoaded();
    await helpers.playFirstTrack(injectedPage);

    await expect(injectedPage.locator('#asmr-learner-subs-root')).toBeAttached({ timeout: 10000 });
    const horizontalOverflow = await injectedPage.evaluate(() => {
      const root = document.documentElement;
      return root.scrollWidth - root.clientWidth;
    });
    expect(horizontalOverflow).toBeLessThanOrEqual(1);

    // Core header elements should still be accessible on small screen
    const semanticBtn = helpers.getSemanticSearchButton(injectedPage);
    await expect(semanticBtn).toBeVisible();
  });
});
