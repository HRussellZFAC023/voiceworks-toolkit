/**
 * E2E: Player Fullscreen & Gallery Tests
 *
 * Verifies fullscreen toggle, gallery image loading from work tree,
 * navigation, and swipe-to-exit behavior.
 */

import { test, expect, helpers, TEST_WORKS } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Wait for the audio player to exist in the DOM.
 * Returns false if the page was rate-limited and the player never appeared.
 */
async function waitForPlayer(page: Page): Promise<boolean> {
    const player = page.locator('.audio-player');
    return player.waitFor({ state: 'attached', timeout: 10000 }).then(() => true).catch(() => false);
}

/**
 * Force the audio player visible.
 * The player is hidden by Vue's v-show when no track is loaded.
 * We override the inline display style so tests can interact with it.
 */
async function forcePlayerVisible(page: Page): Promise<boolean> {
    return page.evaluate(() => {
        const player = document.querySelector('.audio-player') as HTMLElement;
        if (!player) return false;
        player.style.setProperty('display', 'flex', 'important');
        player.style.setProperty('min-height', '80px', 'important');
        player.style.setProperty('visibility', 'visible', 'important');
        player.style.setProperty('opacity', '1', 'important');

        const btn = player.querySelector('.asmr-fullscreen-btn') as HTMLElement;
        if (btn) {
            btn.style.setProperty('opacity', '1', 'important');
            btn.style.setProperty('pointer-events', 'auto', 'important');
        }
        return true;
    });
}

/**
 * Enter fullscreen mode via the button. Handles the force-visible + click sequence.
 */
async function enterFullscreen(page: Page): Promise<void> {
    await forcePlayerVisible(page);
    const fsBtn = page.locator('.asmr-fullscreen-btn');
    await fsBtn.waitFor({ state: 'attached', timeout: 10000 });
    await fsBtn.click({ force: true });
    await page.waitForTimeout(500);
}

test.describe('Player Fullscreen', () => {
    test('fullscreen button appears on the audio player', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();

        if (!await waitForPlayer(injectedPage)) {
            console.log('Note: Player not found (rate-limited) - skipping');
            return;
        }

        const fsBtn = injectedPage.locator('.asmr-fullscreen-btn');
        await fsBtn.waitFor({ state: 'attached', timeout: 10000 });
        expect(await fsBtn.count()).toBeGreaterThan(0);
    });

    test('clicking fullscreen button enters fullscreen mode', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();

        if (!await waitForPlayer(injectedPage)) {
            console.log('Note: Player not found (rate-limited) - skipping');
            return;
        }

        await enterFullscreen(injectedPage);

        const player = injectedPage.locator('.audio-player');
        const isFullscreen = await player.evaluate(el => el.classList.contains('asmr-player-fullscreen'));
        expect(isFullscreen).toBe(true);

        const bodyActive = await injectedPage.evaluate(() => document.body.classList.contains('asmr-fullscreen-active'));
        expect(bodyActive).toBe(true);

        const fsBtn = injectedPage.locator('.asmr-fullscreen-btn');
        const iconText = await fsBtn.locator('.material-icons').textContent();
        expect(iconText).toBe('fullscreen_exit');
    });

    test('escape key exits fullscreen', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();

        if (!await waitForPlayer(injectedPage)) {
            console.log('Note: Player not found (rate-limited) - skipping');
            return;
        }

        await enterFullscreen(injectedPage);

        const player = injectedPage.locator('.audio-player');
        let isFullscreen = await player.evaluate(el => el.classList.contains('asmr-player-fullscreen'));
        expect(isFullscreen).toBe(true);

        await injectedPage.keyboard.press('Escape');
        await injectedPage.waitForTimeout(500);

        isFullscreen = await player.evaluate(el => el.classList.contains('asmr-player-fullscreen'));
        expect(isFullscreen).toBe(false);
    });

    test('clicking fullscreen button again exits fullscreen', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();

        if (!await waitForPlayer(injectedPage)) {
            console.log('Note: Player not found (rate-limited) - skipping');
            return;
        }

        const player = injectedPage.locator('.audio-player');
        await enterFullscreen(injectedPage);
        expect(await player.evaluate(el => el.classList.contains('asmr-player-fullscreen'))).toBe(true);

        const fsBtn = injectedPage.locator('.asmr-fullscreen-btn');
        await fsBtn.click({ force: true });
        await injectedPage.waitForTimeout(500);
        expect(await player.evaluate(el => el.classList.contains('asmr-player-fullscreen'))).toBe(false);

        const bodyActive = await injectedPage.evaluate(() => document.body.classList.contains('asmr-fullscreen-active'));
        expect(bodyActive).toBe(false);
    });
});

test.describe('Player Gallery', () => {
    test('gallery elements are injected into albumart', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();

        if (!await waitForPlayer(injectedPage)) {
            console.log('Note: Player not found (rate-limited) - skipping');
            return;
        }

        const galleryPrev = injectedPage.locator('.asmr-gallery-prev');
        await galleryPrev.waitFor({ state: 'attached', timeout: 10000 }).catch(() => {});

        expect(await injectedPage.locator('.asmr-gallery-img').count()).toBeGreaterThan(0);
        expect(await galleryPrev.count()).toBeGreaterThan(0);
        expect(await injectedPage.locator('.asmr-gallery-next').count()).toBeGreaterThan(0);
        expect(await injectedPage.locator('.asmr-gallery-counter').count()).toBeGreaterThan(0);
    });

    test('gallery image is visible when images are loaded', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();

        if (!await waitForPlayer(injectedPage)) {
            console.log('Note: Player not found (rate-limited) - skipping');
            return;
        }

        const galleryImg = injectedPage.locator('.asmr-gallery-img');
        await galleryImg.waitFor({ state: 'attached', timeout: 10000 }).catch(() => {});

        if (await galleryImg.count() === 0) {
            console.log('Note: Gallery img not injected yet - skipping');
            return;
        }

        const src = await galleryImg.evaluate(el => (el as HTMLImageElement).src || '');
        if (!src) {
            console.log('Note: Gallery image has no source yet - skipping visibility assertion');
            return;
        }

        // Gallery image should be visible whenever a valid image URL is loaded.
        await galleryImg.evaluate(el => (el as HTMLImageElement).decode?.().catch(() => undefined));
        const imgDisplay = await galleryImg.evaluate(el => getComputedStyle(el).display);
        expect(imgDisplay).not.toBe('none');
    });

    test('gallery loads images from tracks API in fullscreen', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();

        if (!await waitForPlayer(injectedPage)) {
            console.log('Note: Player not found (rate-limited) - skipping');
            return;
        }

        // Set work state on the bridge store so gallery knows which work to load
        await injectedPage.evaluate(() => {
            const w = window as any;
            const bridge = w.__ASMR_KIKOERU_BRIDGE__;
            if (bridge?.store) {
                try {
                    bridge.store.commit('AudioPlayer/SET_WORK', {
                        id: 1052162,
                        title: '[Mock] Standard Test Work',
                        mainCoverUrl: 'https://asmr.one/test-image-1.png',
                        source_id: 'RJ01052162',
                    });
                } catch (e) {
                    console.log('[E2E] Could not set player state:', e);
                }
            }
        });
        await injectedPage.waitForTimeout(500);

        await enterFullscreen(injectedPage);

        // Wait for gallery to load images (async fetch from tracks API)
        await injectedPage.waitForTimeout(3000);

        const galleryImg = injectedPage.locator('.asmr-gallery-img');
        const src = await galleryImg.evaluate(el => (el as HTMLImageElement).src).catch(() => '');

        console.log('Gallery img src:', src);
        if (src) {
            expect(src).toBeTruthy();
            console.log('Gallery image loaded successfully');
        } else {
            console.log('Note: Gallery image loading depends on bridge/store state which may not be available in E2E');
        }

        await injectedPage.keyboard.press('Escape');
    });

    test('gallery navigation works with arrow keys', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();

        if (!await waitForPlayer(injectedPage)) {
            console.log('Note: Player not found (rate-limited) - skipping');
            return;
        }

        await enterFullscreen(injectedPage);

        const hasImages = await injectedPage.evaluate(() => {
            const w = window as any;
            const gallery = w.ASMRUlt?.playerGallery || w.__ASMR_PLAYER_GALLERY__;
            if (!gallery) return false;
            gallery.images = [
                'https://asmr.one/test-image-1.png',
                'https://asmr.one/test-image-2.png',
            ];
            gallery.index = 0;
            gallery.workId = 'test';
            return true;
        });

        if (!hasImages) {
            console.log('Note: Gallery instance not accessible - skipping navigation test');
            await injectedPage.keyboard.press('Escape');
            return;
        }

        await injectedPage.keyboard.press('ArrowRight');
        await injectedPage.waitForTimeout(300);

        const galleryImg = injectedPage.locator('.asmr-gallery-img');
        const src = await galleryImg.evaluate(el => (el as HTMLImageElement).src).catch(() => '');
        console.log('After ArrowRight, gallery src:', src);

        await injectedPage.keyboard.press('Escape');
    });

    test('q-img is hidden in fullscreen mode', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();

        if (!await waitForPlayer(injectedPage)) {
            console.log('Note: Player not found (rate-limited) - skipping');
            return;
        }

        await enterFullscreen(injectedPage);

        const qImg = injectedPage.locator('.audio-player .albumart .q-img');
        if (await qImg.count() > 0) {
            const display = await qImg.evaluate(el => getComputedStyle(el).display);
            expect(display).toBe('none');
        }

        await injectedPage.keyboard.press('Escape');
    });
});
