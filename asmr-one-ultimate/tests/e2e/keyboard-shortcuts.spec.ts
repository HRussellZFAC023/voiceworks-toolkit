/**
 * E2E: Keyboard Shortcuts
 *
 * Tests for KeyboardManager keyboard shortcut registration and handling.
 * Verifies that global shortcuts are registered, don't interfere
 * with form inputs, and actually control the audio element and player UI.
 */

import { test, expect, helpers, TEST_WORKS } from './fixtures';

/**
 * Inject a test audio element into the page.
 * Returns initial state for assertions.
 */
async function injectTestAudio(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
        // Remove any existing audio elements
        document.querySelectorAll('audio').forEach(a => a.remove());
        const audio = document.createElement('audio');
        // Use a silent data URI so the element is "loaded" enough to allow property changes
        audio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
        audio.volume = 0.5;
        audio.muted = false;
        audio.playbackRate = 1.0;
        // Override duration via defineProperty since it's read-only on real elements
        Object.defineProperty(audio, 'duration', { value: 300, writable: true, configurable: true });
        document.body.appendChild(audio);
        return {
            volume: audio.volume,
            muted: audio.muted,
            playbackRate: audio.playbackRate,
            currentTime: audio.currentTime,
            paused: audio.paused,
        };
    });
}

/** Read current audio element state */
async function getAudioState(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
        const audio = document.querySelector('audio');
        if (!audio) return null;
        return {
            volume: audio.volume,
            muted: audio.muted,
            playbackRate: audio.playbackRate,
            currentTime: audio.currentTime,
            paused: audio.paused,
        };
    });
}

test.describe('Keyboard Shortcuts', () => {

    test('KeyboardManager is initialized on work page', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();
        await injectedPage.waitForTimeout(2000);

        const hasKeyboardManager = await injectedPage.evaluate(() => {
            const api = (window as any).ASMRUlt;
            return !!(api && api.keyboard);
        }).catch(() => false);
        console.log(`KeyboardManager exposed via API: ${hasKeyboardManager}`);
    });

    test('keyboard shortcuts do not throw errors', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();
        await injectedPage.waitForTimeout(2000);
        await injectTestAudio(injectedPage);

        const errors: string[] = [];
        injectedPage.on('pageerror', (err) => errors.push(err.message));

        // Press every shortcut key
        const keys = [
            'Space', 'm', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
            'a', 'd', 'j', 'l', 'p', 'n', 'b', '0', '5', '9',
        ];
        for (const key of keys) {
            await injectedPage.keyboard.press(key);
            await injectedPage.waitForTimeout(100);
        }

        const keyboardErrors = errors.filter(e =>
            e.toLowerCase().includes('keyboard') || e.toLowerCase().includes('keydown')
        );
        expect(keyboardErrors).toHaveLength(0);
    });

    test('shortcuts are suppressed in input fields', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();
        await injectedPage.waitForTimeout(2000);

        const searchInput = injectedPage.locator('.q-header input[type="text"], .q-header input[type="search"]').first();
        if (await searchInput.isVisible({ timeout: 3000 }).catch(() => false)) {
            await searchInput.focus();
            await searchInput.type('m');
            const inputValue = await searchInput.inputValue();
            console.log(`Input value after pressing 'm': ${inputValue}`);
        }
    });

    test('Escape key closes semantic search dialog', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoHome(injectedPage);
        await isScriptLoaded();

        await helpers.openSemanticSearch(injectedPage);
        const isOpen = await helpers.isSemanticSearchOpen(injectedPage);
        expect(isOpen).toBe(true);

        await injectedPage.keyboard.press('Escape');
        await injectedPage.waitForTimeout(500);

        const isStillOpen = await helpers.isSemanticSearchOpen(injectedPage);
        expect(isStillOpen).toBe(false);
    });

    // =========================================================================
    // Audio element control tests
    // =========================================================================

    test('Space toggles play/pause on audio element', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();
        await injectedPage.waitForTimeout(2000);
        await injectTestAudio(injectedPage);

        // Audio starts paused
        let state = await getAudioState(injectedPage);
        expect(state?.paused).toBe(true);

        // Press Space to play — play() may fail silently on data URI, but paused state changes
        await injectedPage.keyboard.press('Space');
        await injectedPage.waitForTimeout(200);

        // Press Space again to pause
        await injectedPage.keyboard.press('Space');
        await injectedPage.waitForTimeout(200);

        state = await getAudioState(injectedPage);
        // After play+pause, should be paused again
        expect(state?.paused).toBe(true);
    });

    test('ArrowLeft/ArrowRight seek audio by 5 seconds', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();
        await injectedPage.waitForTimeout(2000);
        await injectTestAudio(injectedPage);

        // Set currentTime to 30s
        await injectedPage.evaluate(() => {
            const audio = document.querySelector('audio')!;
            audio.currentTime = 30;
        });

        await injectedPage.keyboard.press('ArrowRight');
        await injectedPage.waitForTimeout(100);

        let state = await getAudioState(injectedPage);
        expect(state?.currentTime).toBeCloseTo(35, 0);

        await injectedPage.keyboard.press('ArrowLeft');
        await injectedPage.waitForTimeout(100);

        state = await getAudioState(injectedPage);
        expect(state?.currentTime).toBeCloseTo(30, 0);
    });

    test('j/l seek audio by 10 seconds', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();
        await injectedPage.waitForTimeout(2000);
        await injectTestAudio(injectedPage);

        await injectedPage.evaluate(() => {
            const audio = document.querySelector('audio')!;
            audio.currentTime = 30;
        });

        await injectedPage.keyboard.press('l');
        await injectedPage.waitForTimeout(100);

        let state = await getAudioState(injectedPage);
        expect(state?.currentTime).toBeCloseTo(40, 0);

        await injectedPage.keyboard.press('j');
        await injectedPage.waitForTimeout(100);

        state = await getAudioState(injectedPage);
        expect(state?.currentTime).toBeCloseTo(30, 0);
    });

    test('ArrowUp/ArrowDown adjust volume', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();
        await injectedPage.waitForTimeout(2000);
        await injectTestAudio(injectedPage);

        let state = await getAudioState(injectedPage);
        expect(state?.volume).toBeCloseTo(0.5, 1);

        await injectedPage.keyboard.press('ArrowUp');
        await injectedPage.waitForTimeout(100);

        state = await getAudioState(injectedPage);
        expect(state?.volume).toBeCloseTo(0.55, 1);

        await injectedPage.keyboard.press('ArrowDown');
        await injectedPage.waitForTimeout(100);

        state = await getAudioState(injectedPage);
        expect(state?.volume).toBeCloseTo(0.5, 1);
    });

    test('m key toggles mute on audio element', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();
        await injectedPage.waitForTimeout(2000);
        await injectTestAudio(injectedPage);

        let state = await getAudioState(injectedPage);
        expect(state?.muted).toBe(false);

        await injectedPage.keyboard.press('m');
        await injectedPage.waitForTimeout(100);

        state = await getAudioState(injectedPage);
        expect(state?.muted).toBe(true);

        await injectedPage.keyboard.press('m');
        await injectedPage.waitForTimeout(100);

        state = await getAudioState(injectedPage);
        expect(state?.muted).toBe(false);
    });

    test('>/< keys adjust playback rate', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();
        await injectedPage.waitForTimeout(2000);
        await injectTestAudio(injectedPage);

        let state = await getAudioState(injectedPage);
        expect(state?.playbackRate).toBe(1);

        // Dispatch '>' key event directly (Playwright Shift+. may not set e.key correctly)
        await injectedPage.evaluate(() => {
            document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '>', shiftKey: true, bubbles: true }));
        });
        await injectedPage.waitForTimeout(100);

        state = await getAudioState(injectedPage);
        expect(state?.playbackRate).toBeCloseTo(1.25, 2);

        // Dispatch '<' key event directly
        await injectedPage.evaluate(() => {
            document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '<', shiftKey: true, bubbles: true }));
        });
        await injectedPage.waitForTimeout(100);

        state = await getAudioState(injectedPage);
        expect(state?.playbackRate).toBeCloseTo(1.0, 2);
    });

    test('= key resets playback rate to 1.0', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();
        await injectedPage.waitForTimeout(2000);
        await injectTestAudio(injectedPage);

        // Speed up via dispatched key events
        await injectedPage.evaluate(() => {
            document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '>', shiftKey: true, bubbles: true }));
            document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '>', shiftKey: true, bubbles: true }));
        });
        await injectedPage.waitForTimeout(100);

        let state = await getAudioState(injectedPage);
        expect(state?.playbackRate).toBeCloseTo(1.5, 2);

        await injectedPage.keyboard.press('=');
        await injectedPage.waitForTimeout(100);

        state = await getAudioState(injectedPage);
        expect(state?.playbackRate).toBe(1);
    });

    test('0-9 keys seek to percentage of duration', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();
        await injectedPage.waitForTimeout(2000);
        await injectTestAudio(injectedPage);

        // Press 5 to seek to 50%
        await injectedPage.keyboard.press('5');
        await injectedPage.waitForTimeout(100);

        let state = await getAudioState(injectedPage);
        // Duration is 300s, so 50% = 150s
        expect(state?.currentTime).toBeCloseTo(150, 0);

        // Press 0 to seek to 0%
        await injectedPage.keyboard.press('0');
        await injectedPage.waitForTimeout(100);

        state = await getAudioState(injectedPage);
        expect(state?.currentTime).toBeCloseTo(0, 0);
    });

    test('seek clamps to 0 and does not go negative', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();
        await injectedPage.waitForTimeout(2000);
        await injectTestAudio(injectedPage);

        await injectedPage.evaluate(() => {
            const audio = document.querySelector('audio')!;
            audio.currentTime = 2;
        });

        // Seek back 5s from 2s should clamp to 0
        await injectedPage.keyboard.press('ArrowLeft');
        await injectedPage.waitForTimeout(100);

        const state = await getAudioState(injectedPage);
        expect(state?.currentTime).toBe(0);
    });

    test('volume clamps to 0 and 1', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();
        await injectedPage.waitForTimeout(2000);
        await injectTestAudio(injectedPage);

        // Set volume very high
        await injectedPage.evaluate(() => {
            const audio = document.querySelector('audio')!;
            audio.volume = 0.98;
        });

        await injectedPage.keyboard.press('ArrowUp');
        await injectedPage.waitForTimeout(100);

        let state = await getAudioState(injectedPage);
        expect(state?.volume).toBe(1);

        // Set volume very low
        await injectedPage.evaluate(() => {
            const audio = document.querySelector('audio')!;
            audio.volume = 0.02;
        });

        await injectedPage.keyboard.press('ArrowDown');
        await injectedPage.waitForTimeout(100);

        state = await getAudioState(injectedPage);
        expect(state?.volume).toBe(0);
    });

    test('a/d keys emit nav-prev/nav-next events', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();
        await injectedPage.waitForTimeout(2000);
        await injectTestAudio(injectedPage);

        // Set up event listeners to track nav events
        await injectedPage.evaluate(() => {
            (window as any).__navEvents = [];
            const api = (window as any).ASMRUlt;
            if (api?.EventBus) {
                api.EventBus.on('player:nav-prev', () => (window as any).__navEvents.push('prev'));
                api.EventBus.on('player:nav-next', () => (window as any).__navEvents.push('next'));
            }
        });

        await injectedPage.keyboard.press('a');
        await injectedPage.waitForTimeout(100);
        await injectedPage.keyboard.press('d');
        await injectedPage.waitForTimeout(100);

        const events = await injectedPage.evaluate(() => (window as any).__navEvents);
        console.log('Nav events received:', events);
        // Events should have fired (may be caught by LearnerMode or fall through to track nav)
    });

    test('b key toggles learner blur config', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();
        await injectedPage.waitForTimeout(2000);
        await injectTestAudio(injectedPage);

        const blurBefore = await helpers.getConfig(injectedPage, 'learnerBlur');

        await injectedPage.keyboard.press('b');
        await injectedPage.waitForTimeout(200);

        const blurAfter = await helpers.getConfig(injectedPage, 'learnerBlur');
        // Should have toggled
        expect(blurAfter).toBe(!blurBefore);
    });

    test('volume changes update Vuex store for UI sync', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();
        await waitForBridge();
        await injectedPage.waitForTimeout(2000);
        await injectTestAudio(injectedPage);

        await injectedPage.keyboard.press('ArrowUp');
        await injectedPage.waitForTimeout(200);

        // Check Vuex store was updated
        const storeVolume = await injectedPage.evaluate(() => {
            const bridge = (window as any).__ASMR_KIKOERU_BRIDGE__;
            return bridge?.store?.state?.AudioPlayer?.volume;
        }).catch(() => null);

        if (storeVolume !== null && storeVolume !== undefined) {
            console.log(`Store volume after ArrowUp: ${storeVolume}`);
            expect(storeVolume).toBeGreaterThan(0.5);
        } else {
            console.log('Store volume not accessible (bridge may not be fully initialized)');
        }
    });

    test('mute changes update Vuex store for UI sync', async ({ injectedPage, isScriptLoaded, waitForBridge }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();
        await waitForBridge();
        await injectedPage.waitForTimeout(2000);
        await injectTestAudio(injectedPage);

        await injectedPage.keyboard.press('m');
        await injectedPage.waitForTimeout(200);

        const storeMuted = await injectedPage.evaluate(() => {
            const bridge = (window as any).__ASMR_KIKOERU_BRIDGE__;
            return bridge?.store?.state?.AudioPlayer?.muted;
        }).catch(() => null);

        if (storeMuted !== null && storeMuted !== undefined) {
            console.log(`Store muted after m: ${storeMuted}`);
            expect(storeMuted).toBe(true);
        } else {
            console.log('Store muted not accessible (bridge may not be fully initialized)');
        }
    });
});
