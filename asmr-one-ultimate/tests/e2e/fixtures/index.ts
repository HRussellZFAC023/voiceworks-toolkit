/**
 * E2E Test Fixtures - CDP Connection to Existing Browser
 *
 * Connects to your browser via CDP where Tampermonkey is already running
 * with the userscript loaded via dev server HMR.
 *
 * Setup:
 *   1. npm run edge:debug (starts Edge with CDP on port 9222)
 *   2. npm run dev (starts Vite dev server on port 5173)
 *   3. Install userscript in Tampermonkey from http://localhost:5173/asmr-one-ultimate.user.js
 *   4. npm run test:e2e
 */

import { test as base, Page, Browser, chromium, Locator } from '@playwright/test';

const CDP_URL = 'http://localhost:9222';
const BASE_URL = 'https://asmr.one';

// Sample work IDs for testing (popular works likely to exist)
export const TEST_WORKS = {
  WITH_SUBTITLES: 'RJ01052162',  // Work known to have subtitles
  STANDARD: 'RJ01382560',        // Standard work
  FALLBACK: 'RJ196038',          // Fallback work
};

export interface CDPFixtures {
  /** The CDP-connected browser instance */
  cdpBrowser: Browser;
  /** A page from your existing browser context */
  userPage: Page;
  /** Check if the userscript is loaded */
  isScriptLoaded: () => Promise<boolean>;
  /** Wait for the KikoeruBridge to be ready */
  waitForBridge: (timeout?: number) => Promise<boolean>;
  /** Wait for userscript to fully initialize */
  waitForScript: (timeout?: number) => Promise<boolean>;
}

async function checkCDPAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

export const test = base.extend<CDPFixtures>({
  // Connect to existing browser via CDP
  cdpBrowser: async ({}, use, testInfo) => {
    const available = await checkCDPAvailable();
    if (!available) {
      console.error(`
Error: Edge not running with CDP.
Run: npm run edge:debug
Then: npm run dev
Then install userscript from http://localhost:5173/
`);
      testInfo.skip(true, 'Edge not running with CDP');
      return;
    }

    const browser = await chromium.connectOverCDP(CDP_URL);
    await use(browser);
    // Don't close - we don't own this browser
  },

  // Get a page from the existing browser context
  userPage: async ({ cdpBrowser }, use) => {
    const contexts = cdpBrowser.contexts();
    const context = contexts[0] || (await cdpBrowser.newContext());
    const page = await context.newPage();
    await use(page);
    await page.close();
  },

  // Check if userscript is loaded
  isScriptLoaded: async ({ userPage }, use) => {
    await use(async () => {
      return userPage.evaluate(() => !!(window as any).__ASMR_LOGGER__);
    });
  },

  // Wait for bridge to be ready
  waitForBridge: async ({ userPage }, use) => {
    await use(async (timeout = 30000) => {
      try {
        await userPage.waitForFunction(
          () => {
            const bridge = (window as any).__KIKOERU_BRIDGE__;
            return bridge?.store && bridge?.router;
          },
          { timeout }
        );
        return true;
      } catch {
        return false;
      }
    });
  },

  // Wait for script initialization
  waitForScript: async ({ userPage }, use) => {
    await use(async (timeout = 15000) => {
      try {
        await userPage.waitForFunction(() => !!(window as any).__ASMR_LOGGER__, { timeout });
        return true;
      } catch {
        return false;
      }
    });
  },
});

export { expect } from '@playwright/test';

// =============================================================================
// Helper Functions
// =============================================================================

export const helpers = {
  BASE_URL,

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  /** Navigate to home page */
  async gotoHome(page: Page, waitMs = 2000) {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(waitMs);
  },

  /** Navigate to a work page */
  async gotoWork(page: Page, workId: string, waitMs = 2000) {
    await page.goto(`${BASE_URL}/work/${workId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(waitMs);
  },

  /** Navigate to settings page */
  async gotoSettings(page: Page, waitMs = 1500) {
    await page.goto(`${BASE_URL}/settings`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(waitMs);
  },

  /** Navigate to tags page */
  async gotoTags(page: Page, waitMs = 1500) {
    await page.goto(`${BASE_URL}/tags`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(waitMs);
  },

  /** Navigate to works list */
  async gotoWorks(page: Page, waitMs = 1500) {
    await page.goto(`${BASE_URL}/works`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(waitMs);
  },

  // ---------------------------------------------------------------------------
  // Script State
  // ---------------------------------------------------------------------------

  /** Wait for userscript to initialize */
  async waitForScript(page: Page, timeout = 15000): Promise<boolean> {
    try {
      await page.waitForFunction(() => !!(window as any).__ASMR_LOGGER__, { timeout });
      return true;
    } catch {
      return false;
    }
  },

  /** Check if script is loaded */
  async isScriptLoaded(page: Page): Promise<boolean> {
    return page.evaluate(() => !!(window as any).__ASMR_LOGGER__);
  },

  /** Get config value from script */
  async getConfig(page: Page, key: string): Promise<any> {
    return page.evaluate((k) => (window as any).ASMRUlt?.get?.(k), key);
  },

  /** Set config value */
  async setConfig(page: Page, key: string, value: any): Promise<void> {
    await page.evaluate(([k, v]) => (window as any).ASMRUlt?.set?.(k, v), [key, value]);
  },

  // ---------------------------------------------------------------------------
  // Radio Mode
  // ---------------------------------------------------------------------------

  /** Check if Radio Mode is active */
  async isRadioActive(page: Page): Promise<boolean> {
    return page.evaluate(() => {
      const status = document.querySelector('.asmr-radio-status');
      return status?.textContent?.includes('ON') ?? false;
    });
  },

  /** Toggle Radio Mode via sidebar */
  async toggleRadio(page: Page) {
    const toggle = page.locator('.asmr-radio-toggle, [data-asmr="radio-toggle"]');
    if (await toggle.isVisible()) {
      await toggle.click();
      await page.waitForTimeout(500);
    }
  },

  /** Get Radio Mode status element */
  getRadioStatus(page: Page): Locator {
    return page.locator('.asmr-radio-status');
  },

  // ---------------------------------------------------------------------------
  // Shuffle
  // ---------------------------------------------------------------------------

  /** Check if Shuffle is enabled */
  async isShuffleEnabled(page: Page): Promise<boolean> {
    return page.evaluate(() => (window as any).ASMRUlt?.get?.('shuffle') ?? false);
  },

  /** Toggle Shuffle */
  async toggleShuffle(page: Page) {
    const toggle = page.locator('.asmr-shuffle-toggle, [data-asmr="shuffle-toggle"]');
    if (await toggle.isVisible()) {
      await toggle.click();
      await page.waitForTimeout(300);
    }
  },

  // ---------------------------------------------------------------------------
  // Playback
  // ---------------------------------------------------------------------------

  /** Wait for audio to start playing */
  async waitForPlaying(page: Page, timeout = 10000): Promise<boolean> {
    try {
      await page.waitForFunction(
        () => {
          const audio = document.querySelector('audio');
          return audio && !audio.paused && audio.currentTime > 0;
        },
        { timeout }
      );
      return true;
    } catch {
      return false;
    }
  },

  /** Check if audio is currently playing */
  async isPlaying(page: Page): Promise<boolean> {
    return page.evaluate(() => {
      const audio = document.querySelector('audio');
      return audio ? !audio.paused : false;
    });
  },

  /** Get current track info from Vuex store */
  async getCurrentTrack(page: Page) {
    return page.evaluate(() => {
      const bridge = (window as any).__KIKOERU_BRIDGE__;
      return bridge?.store?.state?.AudioPlayer?.playing;
    });
  },

  /** Get current playback time */
  async getPlaybackTime(page: Page): Promise<number> {
    return page.evaluate(() => {
      const audio = document.querySelector('audio');
      return audio?.currentTime ?? 0;
    });
  },

  // ---------------------------------------------------------------------------
  // Learner Mode
  // ---------------------------------------------------------------------------

  /** Check if Learner Mode UI is visible */
  async isLearnerVisible(page: Page): Promise<boolean> {
    const expanded = page.locator('.learner-subs-expanded');
    const collapsed = page.locator('.learner-subs-collapsed');
    return (await expanded.isVisible()) || (await collapsed.isVisible());
  },

  /** Get Learner controls container */
  getLearnerControls(page: Page): Locator {
    return page.locator('.learner-controls, .learner-collapsed-controls');
  },

  /** Click Prev Line button */
  async clickPrevLine(page: Page) {
    const btn = page.locator('.learner-prev-btn, [data-asmr="learner-prev"]');
    if (await btn.isVisible()) {
      await btn.click();
    }
  },

  /** Click Next Line button */
  async clickNextLine(page: Page) {
    const btn = page.locator('.learner-next-btn, [data-asmr="learner-next"]');
    if (await btn.isVisible()) {
      await btn.click();
    }
  },

  /** Toggle JP visibility */
  async toggleJP(page: Page) {
    const btn = page.locator('.learner-toggle-jp, [data-asmr="learner-toggle-jp"]');
    if (await btn.isVisible()) {
      await btn.click();
    }
  },

  /** Get Japanese subtitle text */
  async getJPText(page: Page): Promise<string> {
    return (await page.locator('.learner-jp').first().textContent()) ?? '';
  },

  /** Get English subtitle text */
  async getENText(page: Page): Promise<string> {
    return (await page.locator('.learner-en').first().textContent()) ?? '';
  },

  /** Check if English is blurred */
  async isENBlurred(page: Page): Promise<boolean> {
    return page.evaluate(() => {
      const en = document.querySelector('.learner-en');
      return en?.classList.contains('blurred') ?? false;
    });
  },

  // ---------------------------------------------------------------------------
  // Whisper
  // ---------------------------------------------------------------------------

  /** Get Whisper button */
  getWhisperButton(page: Page): Locator {
    return page.locator('.asmr-whisper-btn');
  },

  /** Check if Whisper is active/transcribing */
  async isWhisperActive(page: Page): Promise<boolean> {
    return page.evaluate(() => {
      const btn = document.querySelector('.asmr-whisper-btn');
      return btn?.getAttribute('data-active') === 'true';
    });
  },

  /** Check if Whisper is loading */
  async isWhisperLoading(page: Page): Promise<boolean> {
    return page.evaluate(() => {
      const btn = document.querySelector('.asmr-whisper-btn');
      return btn?.classList.contains('asmr-whisper-loading') ?? false;
    });
  },

  // ---------------------------------------------------------------------------
  // Semantic Search (Magic Search / Vector Search)
  // ---------------------------------------------------------------------------

  /** Get Semantic Search button in header */
  getSemanticSearchButton(page: Page): Locator {
    return page.locator('.asmr-vector-btn, [data-asmr="semantic-search"]');
  },

  /** Open Semantic Search dialog */
  async openSemanticSearch(page: Page) {
    const btn = this.getSemanticSearchButton(page);
    if (await btn.isVisible()) {
      await btn.click();
      await page.waitForTimeout(500);
    }
  },

  /** Check if Semantic Search dialog is open */
  async isSemanticSearchOpen(page: Page): Promise<boolean> {
    return page.locator('.asmr-vector-dialog').isVisible();
  },

  /** Get index count from dialog */
  async getIndexCount(page: Page): Promise<number> {
    const text = await page.locator('.asmr-vector-status').textContent();
    const match = text?.match(/(\d+)\s*works?\s*indexed/i);
    return match ? parseInt(match[1], 10) : 0;
  },

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  /** Check if our settings sections are injected */
  async hasSettingsSections(page: Page): Promise<{ radio: boolean; magic: boolean; whisper: boolean; storage: boolean }> {
    return {
      radio: await page.locator('#asmr-radio-settings-section').isVisible(),
      magic: await page.locator('#asmr-magic-settings-section').isVisible(),
      whisper: await page.locator('#asmr-whisper-settings-section').isVisible(),
      storage: await page.locator('#asmr-storage-settings-section').isVisible(),
    };
  },

  /** Get toggle state for a setting */
  async getToggleState(page: Page, key: string): Promise<boolean> {
    return page.evaluate((k) => {
      const toggle = document.querySelector(`#toggle-inner-${k}`);
      return toggle?.classList.contains('q-toggle__inner--truthy') ?? false;
    }, key);
  },

  /** Click a settings toggle */
  async clickToggle(page: Page, key: string) {
    const toggle = page.locator(`#toggle-inner-${key} input[type="checkbox"]`);
    if (await toggle.isVisible()) {
      await toggle.click();
      await page.waitForTimeout(200);
    }
  },

  // ---------------------------------------------------------------------------
  // UI Elements
  // ---------------------------------------------------------------------------

  /** Get sidebar drawer */
  getSidebar(page: Page): Locator {
    return page.locator('.q-drawer');
  },

  /** Get header actions container */
  getHeaderActions(page: Page): Locator {
    return page.locator('.asmr-header-actions');
  },

  /** Get player bar */
  getPlayerBar(page: Page): Locator {
    return page.locator('.player-bar, .q-footer');
  },

  /** Check if dark mode is active */
  async isDarkMode(page: Page): Promise<boolean> {
    return page.evaluate(() => {
      return document.body.classList.contains('body--dark') ||
             document.body.classList.contains('q-dark');
    });
  },

  // ---------------------------------------------------------------------------
  // Health Monitoring
  // ---------------------------------------------------------------------------

  /** Monitor page health (memory, DOM nodes, errors) */
  async monitorHealth(
    page: Page,
    seconds: number
  ): Promise<{ alive: boolean; errors: string[]; samples: { heap: number; nodes: number }[] }> {
    const errors: string[] = [];
    const samples: { heap: number; nodes: number }[] = [];

    page.on('pageerror', (e) => errors.push(e.message));

    for (let i = 0; i < seconds; i++) {
      await page.waitForTimeout(1000);
      const m = await page
        .evaluate(() => ({
          heap: ((performance as any).memory?.usedJSHeapSize || 0) / 1024 / 1024,
          nodes: document.querySelectorAll('*').length,
        }))
        .catch(() => null);

      if (!m) return { alive: false, errors, samples };
      samples.push(m);
      console.log(`  [${i + 1}s] ${m.heap.toFixed(1)}MB, ${m.nodes} nodes`);
    }

    return { alive: true, errors, samples };
  },

  /** Check for console errors */
  async getConsoleErrors(page: Page): Promise<string[]> {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });
    return errors;
  },

  // ---------------------------------------------------------------------------
  // Assertions
  // ---------------------------------------------------------------------------

  /** Assert element is visible and has expected text */
  async assertText(page: Page, selector: string, expectedText: string) {
    const el = page.locator(selector);
    await el.waitFor({ state: 'visible', timeout: 5000 });
    const text = await el.textContent();
    if (!text?.includes(expectedText)) {
      throw new Error(`Expected "${selector}" to contain "${expectedText}", got "${text}"`);
    }
  },

  /** Assert element has class */
  async assertHasClass(page: Page, selector: string, className: string) {
    const hasClass = await page.evaluate(
      ([sel, cls]) => document.querySelector(sel)?.classList.contains(cls),
      [selector, className]
    );
    if (!hasClass) {
      throw new Error(`Expected "${selector}" to have class "${className}"`);
    }
  },
};
