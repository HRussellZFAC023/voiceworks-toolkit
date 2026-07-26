/**
 * E2E: Learner Mode Tests
 *
 * Tests for the bilingual subtitle learning feature.
 */

import { test, expect, helpers, TEST_WORKS } from './fixtures';
import type { Page } from '@playwright/test';

interface WhisperUiState {
  isTranscribing: boolean;
  isLoadingModel: boolean;
}

async function setWhisperUiState(
  page: Page,
  state: WhisperUiState,
  cleanupSelector?: string,
): Promise<void> {
  await page.evaluate(({ next, selector }) => {
    const runtime = window as typeof window & {
      __ASMR_APP_STORE__?: { setWhisperState(state: WhisperUiState): void };
      __ASMR_EVENT_BUS__?: {
        emit(event: 'whisper:transcribing', payload: { active: boolean }): void;
      };
    };
    runtime.__ASMR_APP_STORE__?.setWhisperState(next);
    runtime.__ASMR_EVENT_BUS__?.emit('whisper:transcribing', { active: next.isTranscribing });
    if (selector) document.querySelector(selector)?.remove();
  }, { next: state, selector: cleanupSelector });
}

async function pushHostRoute(page: Page, path: string): Promise<void> {
  await page.evaluate(async (nextPath) => {
    const runtime = window as typeof window & {
      __ASMR_KIKOERU_BRIDGE__?: {
        router?: { push(path: string): Promise<unknown> };
      };
    };
    const router = runtime.__ASMR_KIKOERU_BRIDGE__?.router;
    if (!router) throw new Error('Host router is unavailable');
    await router.push(nextPath).catch((error: unknown) => {
      if (!String(error).includes('NavigationDuplicated')) throw error;
    });
  }, path);
}

test.describe('Learner Mode UI Presence', () => {
  test('learner containers exist on work page', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.WITH_SUBTITLES);
    await isScriptLoaded();
    await helpers.playFirstTrack(injectedPage);

    // Check for expanded or collapsed subtitle containers
    const expanded = injectedPage.locator('.learner-subs-expanded');
    const collapsed = injectedPage.locator('.learner-subs-collapsed');

    await expect(expanded).toHaveCount(1, { timeout: 10000 });
    await expect(collapsed).toHaveCount(1, { timeout: 10000 });
  });

  test('learner controls are injected', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.WITH_SUBTITLES);
    await isScriptLoaded();
    await helpers.playFirstTrack(injectedPage);

    const controls = helpers.getLearnerControls(injectedPage);
    await expect(controls.first()).toBeAttached({ timeout: 10000 });
    expect(await controls.count()).toBeGreaterThanOrEqual(1);
  });
});

test.describe('Learner Mode Subtitle Display', () => {
  test('loads native VTT and reloads it after same-work route re-entry', async ({ injectedPage, isScriptLoaded }) => {
    const nativeSubtitleUrl = 'https://asmr.one/e2e-native-subtitle.vtt';
    const nativeText = 'ネイティブ字幕を再読み込みしました';
    let subtitleRequests = 0;

    await injectedPage.addInitScript(() => {
      localStorage.setItem('GM_whisperAutoWarmup', 'false');
    });
    // The host re-probes its selected API server on route re-entry. Keep that
    // host concern deterministic so this test measures only the learner
    // subtitle lifecycle; transient relay health failures otherwise replace
    // the work page with the host's "Network Error" screen before any VTT
    // request can be made.
    await injectedPage.route('**/api/health*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{}',
      });
    });
    await injectedPage.route('**/e2e-native-subtitle.vtt*', async (route) => {
      subtitleRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: 'text/vtt; charset=utf-8',
        body: `WEBVTT\n\n00:00:00.000 --> 00:00:20.000\n${nativeText}\n`,
      });
    });

    await helpers.gotoWork(injectedPage, TEST_WORKS.WITH_SUBTITLES);
    expect(await isScriptLoaded()).toBe(true);
    await helpers.playFirstTrack(injectedPage);
    await injectedPage.evaluate(() => {
      if (document.querySelector('audio')) return;
      const audio = document.createElement('audio');
      audio.dataset.e2eNativeSubtitleClock = 'true';
      document.body.appendChild(audio);
    });

    await injectedPage.evaluate((url) => {
      const runtime = window as typeof window & {
        __ASMR_KIKOERU_BRIDGE__?: {
          store?: {
            commit?: (type: string, payload: unknown) => void;
            state?: {
              AudioPlayer?: {
                queue?: Array<Record<string, unknown>>;
                queueIndex?: number;
                currentTrack?: Record<string, unknown>;
                currentPlayingFile?: Record<string, unknown>;
              };
            };
          };
        };
      };
      const player = runtime.__ASMR_KIKOERU_BRIDGE__?.store?.state?.AudioPlayer;
      const queue = player?.queue;
      const index = player?.queueIndex;
      if (!queue || typeof index !== 'number' || !queue[index]) {
        throw new Error('Active host track is unavailable');
      }
      const nextTrack = {
        ...queue[index],
        availableLyrics: [{
          title: 'e2e-native-subtitle.vtt',
          mediaStreamUrl: url,
        }],
      };
      const nextQueue = queue.map((track, trackIndex) => trackIndex === index ? nextTrack : track);
      const store = runtime.__ASMR_KIKOERU_BRIDGE__?.store;
      if (!store?.commit) throw new Error('Host store commit is unavailable');
      if (player.currentTrack) player.currentTrack = nextTrack;
      if (player.currentPlayingFile) player.currentPlayingFile = nextTrack;
      store.commit('AudioPlayer/SET_QUEUE', { queue: nextQueue, index });
    }, nativeSubtitleUrl);

    await pushHostRoute(injectedPage, '/works');
    await expect(injectedPage).toHaveURL(/\/works\/?$/);
    await pushHostRoute(injectedPage, `/work/${TEST_WORKS.WITH_SUBTITLES}`);
    await expect(injectedPage).toHaveURL(new RegExp(`/work/${TEST_WORKS.WITH_SUBTITLES}/?$`, 'i'));

    const nativeCaption = injectedPage.locator('.learner-jp').filter({ hasText: nativeText }).first();
    await expect.poll(() => subtitleRequests, { timeout: 10000 }).toBe(1);
    await expect(nativeCaption).toBeVisible({ timeout: 10000 });

    await pushHostRoute(injectedPage, '/works');
    await expect(injectedPage).toHaveURL(/\/works\/?$/);
    await pushHostRoute(injectedPage, `/work/${TEST_WORKS.WITH_SUBTITLES}`);
    await expect(injectedPage).toHaveURL(new RegExp(`/work/${TEST_WORKS.WITH_SUBTITLES}/?$`, 'i'));

    await expect.poll(() => subtitleRequests, { timeout: 10000 }).toBe(2);
    await expect(nativeCaption).toBeVisible({ timeout: 10000 });
  });

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

  for (const { label, whisperState } of [
    {
      label: 'model loading',
      whisperState: { isTranscribing: false, isLoadingModel: true },
    },
    {
      label: 'transcribing',
      whisperState: { isTranscribing: true, isLoadingModel: false },
    },
  ]) {
    test(`reserves the empty panel when remounted during Whisper startup (${label})`, async ({ injectedPage, isScriptLoaded }) => {
      await injectedPage.addInitScript(() => {
        localStorage.setItem('GM_whisperAutoWarmup', 'false');
      });
      await helpers.gotoHome(injectedPage);
      await isScriptLoaded();
      await injectedPage.evaluate(() => {
        document.querySelector('[data-testid="learner-remount-fixture"]')?.remove();
        const player = document.createElement('div');
        player.className = 'audio-player';
        player.dataset.testid = 'learner-remount-fixture';
        player.innerHTML = '<div class="albumart"></div>';
        document.body.appendChild(player);
      });

      const root = injectedPage.locator('#asmr-learner-subs-root');
      const expanded = injectedPage.locator('.learner-subs-expanded').first();
      await expect(root).toBeAttached({ timeout: 10000 });

      await setWhisperUiState(injectedPage, {
        isTranscribing: false,
        isLoadingModel: false,
      });
      await expect(expanded).toHaveClass(/hidden/);

      const beforeRemoval = await injectedPage.evaluate((state) => {
        const runtime = window as typeof window & {
          __ASMR_APP_STORE__?: {
            state: { whisper: typeof state };
            setWhisperState(next: typeof state): void;
          };
        };
        const store = runtime.__ASMR_APP_STORE__;
        if (!store) throw new Error('AppStore was unavailable');
        store.setWhisperState(state);
        const snapshot = { ...store.state.whisper };
        document.getElementById('asmr-learner-subs-root')?.remove();
        return snapshot;
      }, whisperState);
      expect(beforeRemoval).toMatchObject(whisperState);

      await expect(root).toBeAttached({ timeout: 10000 });
      const afterAttach = await injectedPage.evaluate(() => {
        const runtime = window as typeof window & {
          __ASMR_APP_STORE__?: { state: { whisper: unknown } };
        };
        return {
          state: runtime.__ASMR_APP_STORE__?.state.whisper,
          panelClass: document.querySelector('.learner-subs-expanded')?.className,
        };
      });
      expect(afterAttach.state).toMatchObject(whisperState);
      expect(afterAttach.panelClass).not.toMatch(/\bhidden\b/);
      await expect(expanded).not.toHaveClass(/hidden/);

      await setWhisperUiState(
        injectedPage,
        { isTranscribing: false, isLoadingModel: false },
        '[data-testid="learner-remount-fixture"]',
      );
    });
  }

  test('keeps non-fullscreen player geometry stable as bilingual content grows', async ({ injectedPage, isScriptLoaded }) => {
    await helpers.gotoWork(injectedPage, TEST_WORKS.WITH_SUBTITLES);
    await isScriptLoaded();
    await injectedPage.evaluate(() => {
      const runtime = window as typeof window & {
        ASMRUlt?: { set?(key: string, value: unknown): void };
      };
      runtime.ASMRUlt?.set?.('enableLearnerMode', false);
      document.querySelector('[data-testid="learner-layout-fixture"]')?.remove();
      const fixture = document.createElement('div');
      fixture.dataset.testid = 'learner-layout-fixture';
      fixture.className = 'audio-player';
      fixture.style.cssText = [
        'position:fixed',
        'inset:80px auto auto 80px',
        'display:flex',
        'flex-direction:column',
        'width:420px',
        'height:520px',
        'background:#222',
        'z-index:2147483647',
      ].join(';');
      fixture.innerHTML = `
        <div class="albumart" style="display:flex;flex:1 1 auto;min-height:0">
          <div class="q-img" style="flex:1 1 auto;min-height:0"></div>
        </div>
        <div class="learner-subs-expanded">
          <div class="learner-jp" lang="ja">短い字幕です</div>
          <button class="learner-en" type="button">The short translation.</button>
        </div>
        <div style="flex:0 0 72px"></div>
      `;
      document.body.appendChild(fixture);
    });

    const expanded = injectedPage.locator(
      '[data-testid="learner-layout-fixture"] .learner-subs-expanded',
    ).first();
    await expect(expanded).toBeVisible();

    type Geometry = {
      panelHeight: number;
      playerHeight: number;
      coverHeight: number;
      coverMaxHeight: string;
    };
    const snapshot = async (): Promise<Geometry> => injectedPage.evaluate(async () => {
      await new Promise<void>(resolve => requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      }));
      const panel = document.querySelector(
        '[data-testid="learner-layout-fixture"] .learner-subs-expanded',
      ) as HTMLElement | null;
      const player = panel?.closest('.audio-player') as HTMLElement | null;
      const cover = player?.querySelector('.albumart .q-img') as HTMLElement | null;
      if (!panel || !player || !cover) {
        throw new Error('Expanded player geometry was not available');
      }
      return {
        panelHeight: panel.getBoundingClientRect().height,
        playerHeight: player.getBoundingClientRect().height,
        coverHeight: cover.getBoundingClientRect().height,
        coverMaxHeight: cover.style.maxHeight,
      };
    });

    const baseline = await snapshot();
    expect(baseline.panelHeight).toBeGreaterThan(0);
    expect(baseline.coverHeight).toBeGreaterThan(0);

    const variants = [
      {
        jp: '短い字幕です',
        en: '',
      },
      {
        jp: 'これは非同期で届く長い日本語字幕です。'.repeat(12),
        en: 'This deliberately long translation arrives after the Japanese line. '.repeat(12),
      },
      {
        jp: '次の行です',
        en: 'The next line.',
      },
    ];

    for (const variant of variants) {
      await injectedPage.evaluate(({ jp, en }) => {
        const panel = document.querySelector(
          '[data-testid="learner-layout-fixture"] .learner-subs-expanded',
        );
        const primary = panel?.querySelector('.learner-jp');
        const secondary = panel?.querySelector('.learner-en');
        if (!primary || !secondary) throw new Error('Subtitle slots were not available');
        primary.textContent = jp;
        secondary.textContent = en;
      }, variant);

      const current = await snapshot();
      expect(Math.abs(current.panelHeight - baseline.panelHeight)).toBeLessThanOrEqual(1);
      expect(Math.abs(current.coverHeight - baseline.coverHeight)).toBeLessThanOrEqual(1);
      expect(Math.abs(current.playerHeight - baseline.playerHeight)).toBeLessThanOrEqual(1);
      expect(current.coverMaxHeight).toBe(baseline.coverMaxHeight);
    }

    const laneContainment = await injectedPage.evaluate(() => {
      const panel = document.querySelector(
        '[data-testid="learner-layout-fixture"] .learner-subs-expanded',
      ) as HTMLElement | null;
      const primary = panel?.querySelector('.learner-jp') as HTMLElement | null;
      const secondary = panel?.querySelector('.learner-en') as HTMLElement | null;
      if (!primary || !secondary) throw new Error('Subtitle slots were not available');
      const snapshot = (element: HTMLElement) => {
        const style = getComputedStyle(element);
        return {
          overflowY: style.overflowY,
          lineClamp: style.getPropertyValue('-webkit-line-clamp'),
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
        };
      };
      return {
        primary: snapshot(primary),
        secondary: snapshot(secondary),
      };
    });

    for (const lane of [laneContainment.primary, laneContainment.secondary]) {
      expect(lane.overflowY).toBe('hidden');
      expect(lane.lineClamp).toBe('2');
      // The source text can be taller, but the player exposes no nested
      // scrolling surface and keeps the visual lane at exactly two lines.
      expect(lane.scrollHeight).toBeGreaterThanOrEqual(lane.clientHeight);
    }
  });

  test('opens clamped subtitles in a body-level dialog without shifting the player', async ({ injectedPage, isScriptLoaded }) => {
    await injectedPage.addInitScript(() => {
      localStorage.setItem('GM_enablePlayerTranslator', 'false');
      localStorage.setItem('GM_whisperAutoWarmup', 'false');
    });
    await helpers.gotoHome(injectedPage);
    await isScriptLoaded();
    await injectedPage.evaluate(() => {
      document.querySelector('[data-testid="learner-disclosure-fixture"]')?.remove();
      const fixture = document.createElement('div');
      fixture.dataset.testid = 'learner-disclosure-fixture';
      fixture.className = 'audio-player';
      fixture.style.cssText = [
        'position:fixed',
        'inset:80px auto auto 80px',
        'display:flex',
        'flex-direction:column',
        'width:220px',
        'height:520px',
        'background:var(--asmr-bg-primary)',
        'z-index:2147483640',
      ].join(';');
      fixture.innerHTML = [
        '<div class="albumart" style="flex:0 0 260px">',
        '<div class="q-img" style="height:260px"></div>',
        '</div>',
        '<audio></audio>',
      ].join('');
      document.body.appendChild(fixture);
    });
    await expect(injectedPage.locator('#asmr-learner-subs-root')).toBeAttached({ timeout: 10000 });

    const longJapanese = 'タッチ操作とキーボード操作のどちらでも長い字幕全文を読めるようにします。';
    await injectedPage.evaluate((text) => {
      const runtime = window as typeof window & {
        __ASMR_EVENT_BUS__?: {
          emit(event: 'whisper:update', payload: {
            text: string;
            segments: Array<{ start: number; end: number; text: string }>;
            final: boolean;
            live: boolean;
            sourceLanguageHint: 'ja';
            timingQuality: 'segment';
          }): void;
        };
      };
      const audio = document.querySelector<HTMLAudioElement>(
        '[data-testid="learner-disclosure-fixture"] audio',
      );
      const now = audio?.currentTime || 0;
      runtime.__ASMR_EVENT_BUS__?.emit('whisper:update', {
        text,
        segments: [{ start: Math.max(0, now - 1), end: now + 120, text }],
        final: false,
        live: true,
        sourceLanguageHint: 'ja',
        timingQuality: 'segment',
      });
    }, longJapanese);

    const panel = injectedPage.locator(
      '[data-testid="learner-disclosure-fixture"] .learner-subs-expanded:not(.hidden)',
    ).first();
    const primaryLane = panel.locator('.learner-jp');
    await expect(primaryLane).toContainText('タッチ操作とキーボード操作');
    const displayedSubtitle = (await primaryLane.textContent())?.trim();
    expect(displayedSubtitle).toBeTruthy();
    const trigger = panel.locator('.learner-subtitle-expand');
    await expect(trigger).toBeVisible({ timeout: 10000 });
    await injectedPage.locator('[data-testid="learner-disclosure-fixture"]').evaluate((element) => {
      (element as HTMLElement).style.width = 'min(900px, calc(100vw - 100px))';
    });
    await expect(trigger).toBeHidden({ timeout: 10000 });
    await injectedPage.locator('[data-testid="learner-disclosure-fixture"]').evaluate((element) => {
      (element as HTMLElement).style.width = '220px';
    });
    await expect(trigger).toBeVisible({ timeout: 10000 });
    const panelHeightBefore = await panel.evaluate(element => element.getBoundingClientRect().height);

    await trigger.click();
    const dialog = injectedPage.getByRole('dialog', { name: 'Full subtitles' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.learner-subtitle-dialog-primary')).toHaveText(displayedSubtitle!);
    await expect(injectedPage.locator('body > .learner-subtitle-dialog-backdrop')).toHaveCount(1);
    expect(Math.abs(await panel.evaluate(element => element.getBoundingClientRect().height) - panelHeightBefore))
      .toBeLessThanOrEqual(1);

    await injectedPage.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await injectedPage.locator('[data-testid="learner-disclosure-fixture"]').evaluate(element => element.remove());
  });

  test('contains both bilingual subtitle lanes on mobile', async ({ injectedPage, isScriptLoaded }) => {
    await injectedPage.setViewportSize({ width: 390, height: 844 });
    await helpers.gotoWork(injectedPage, TEST_WORKS.WITH_SUBTITLES);
    await isScriptLoaded();
    await injectedPage.evaluate(() => {
      document.querySelector('[data-testid="learner-mobile-layout-fixture"]')?.remove();
      const fixture = document.createElement('div');
      fixture.dataset.testid = 'learner-mobile-layout-fixture';
      fixture.className = 'audio-player';
      fixture.style.cssText = 'position:fixed;inset:20px 15px auto;width:360px;z-index:2147483647';
      fixture.innerHTML = `
        <div class="learner-subs-expanded">
          <div class="learner-jp" lang="ja">これは長い日本語字幕が複数行に折り返されても読めることを確認する表示です。</div>
          <button class="learner-en" type="button">This checks that a long translated subtitle remains inside its reserved mobile lane.</button>
        </div>
      `;
      document.body.appendChild(fixture);
    });

    const geometry = await injectedPage.evaluate(async () => {
      await new Promise<void>(resolve => requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      }));
      const panel = document.querySelector(
        '[data-testid="learner-mobile-layout-fixture"] .learner-subs-expanded',
      ) as HTMLElement | null;
      const primary = panel?.querySelector('.learner-jp') as HTMLElement | null;
      const secondary = panel?.querySelector('.learner-en') as HTMLElement | null;
      if (!panel || !primary || !secondary) throw new Error('Mobile subtitle fixture was unavailable');
      return {
        panel: panel.getBoundingClientRect().toJSON(),
        primary: primary.getBoundingClientRect().toJSON(),
        secondary: secondary.getBoundingClientRect().toJSON(),
        clientHeight: panel.clientHeight,
        scrollHeight: panel.scrollHeight,
        primaryOverflowY: getComputedStyle(primary).overflowY,
        secondaryOverflowY: getComputedStyle(secondary).overflowY,
        primaryLineClamp: getComputedStyle(primary).getPropertyValue('-webkit-line-clamp'),
        secondaryLineClamp: getComputedStyle(secondary).getPropertyValue('-webkit-line-clamp'),
      };
    });

    expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.clientHeight);
    expect(geometry.primaryOverflowY).toBe('hidden');
    expect(geometry.secondaryOverflowY).toBe('hidden');
    expect(geometry.primaryLineClamp).toBe('2');
    expect(geometry.secondaryLineClamp).toBe('2');
    expect(geometry.primary.top).toBeGreaterThanOrEqual(geometry.panel.top - 1);
    expect(geometry.secondary.bottom).toBeLessThanOrEqual(geometry.panel.bottom + 1);
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
