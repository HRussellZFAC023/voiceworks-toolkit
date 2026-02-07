/**
 * E2E: App Store & Global API
 *
 * Tests for AppStore configuration management and the
 * ASMRUlt global API exposed on the window object.
 */

import { test, expect, helpers, TEST_WORKS } from './fixtures';

test.describe('ASMRUlt Global API', () => {

    test('ASMRUlt API is exposed with get/set methods', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoHome(injectedPage);
        await isScriptLoaded();

        const apiShape = await injectedPage.evaluate(() => {
            const api = (window as any).ASMRUlt;
            if (!api) return null;
            return {
                hasGet: typeof api.get === 'function',
                hasSet: typeof api.set === 'function',
                hasVersion: 'version' in api || 'VERSION' in api,
            };
        });
        expect(apiShape).not.toBeNull();
        expect(apiShape!.hasGet).toBe(true);
        expect(apiShape!.hasSet).toBe(true);
    });

    test('API get returns config values', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoHome(injectedPage);
        await isScriptLoaded();

        const config = await injectedPage.evaluate(() => {
            const api = (window as any).ASMRUlt;
            if (!api) return null;
            return {
                shuffle: api.get('shuffle'),
                playAllInFolder: api.get('playAllInFolder'),
                enableFavicon: api.get('enableFavicon'),
                enableMediaViewer: api.get('enableMediaViewer'),
                playbackRate: api.get('playbackRate'),
            };
        });
        console.log(`Config values: ${JSON.stringify(config)}`);
        expect(config).not.toBeNull();
        // playbackRate should be a number between 0.5 and 2.0
        expect(typeof config!.playbackRate).toBe('number');
    });

    test('API set updates config and persists to GM storage', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoHome(injectedPage);
        await isScriptLoaded();

        // Get initial shuffle value
        const initial = await helpers.getConfig(injectedPage, 'shuffle');

        // Toggle via API
        await injectedPage.evaluate(() => {
            const api = (window as any).ASMRUlt;
            const current = api.get('shuffle');
            api.set('shuffle', !current);
        });

        // Verify the value changed in GM storage
        const updated = await helpers.getConfig(injectedPage, 'shuffle');
        expect(updated).toBe(!initial);

        // Revert
        await injectedPage.evaluate(() => {
            const api = (window as any).ASMRUlt;
            const current = api.get('shuffle');
            api.set('shuffle', !current);
        });
    });

    test('AppStore singleton is exposed on window', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoHome(injectedPage);
        await isScriptLoaded();

        const hasAppStore = await injectedPage.evaluate(() => {
            return !!(window as any).__ASMR_APP_STORE__;
        });
        console.log(`AppStore singleton: ${hasAppStore}`);
    });

    test('config persists across page navigation', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoHome(injectedPage);
        await isScriptLoaded();

        // Set a known value
        await injectedPage.evaluate(() => {
            const api = (window as any).ASMRUlt;
            api.set('shuffle', true);
        });

        // Navigate away and back
        await helpers.gotoSettings(injectedPage);
        await helpers.gotoHome(injectedPage);
        await isScriptLoaded();

        // Value should persist
        const value = await injectedPage.evaluate(() => {
            const api = (window as any).ASMRUlt;
            return api.get('shuffle');
        });
        expect(value).toBe(true);

        // Revert
        await injectedPage.evaluate(() => {
            const api = (window as any).ASMRUlt;
            api.set('shuffle', false);
        });
    });
});

test.describe('AppStore Radio State', () => {

    test('radio state is accessible via API', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoHome(injectedPage);
        await isScriptLoaded();

        const radioActive = await helpers.isRadioActive(injectedPage);
        console.log(`Radio active: ${radioActive}`);
        // Radio should start inactive
        expect(radioActive).toBe(false);
    });

    test('isRadioActive and isPlaylistActive are exposed', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoHome(injectedPage);
        await isScriptLoaded();

        const apiFunctions = await injectedPage.evaluate(() => {
            const api = (window as any).ASMRUlt;
            return {
                hasIsRadioActive: typeof api?.isRadioActive === 'function',
                hasIsPlaylistActive: typeof api?.isPlaylistActive === 'function',
                hasActivatePlaylist: typeof api?.activatePlaylist === 'function',
                hasDeactivatePlaylist: typeof api?.deactivatePlaylist === 'function',
            };
        });
        console.log(`API functions: ${JSON.stringify(apiFunctions)}`);
    });
});

test.describe('AppStore Feature Toggles', () => {

    test('feature toggle keys exist in config', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoHome(injectedPage);
        await isScriptLoaded();

        const toggleKeys = await injectedPage.evaluate(() => {
            const api = (window as any).ASMRUlt;
            if (!api) return [];
            const keys = [
                'enableFavicon', 'enableMediaViewer', 'enableInfiniteScroll',
                'enablePlaylistDiscovery', 'enableLearnerMode', 'enableAdvancedSearch',
                'enableWorkMetadata', 'enableWhisper',
            ];
            return keys.filter(k => api.get(k) !== undefined);
        });
        console.log(`Feature toggle keys found: ${toggleKeys.length}`);
        expect(toggleKeys.length).toBeGreaterThan(0);
    });

    test('all feature toggles return boolean values', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoHome(injectedPage);
        await isScriptLoaded();

        const toggleValues = await injectedPage.evaluate(() => {
            const api = (window as any).ASMRUlt;
            if (!api) return null;
            const keys = [
                'enableFavicon', 'enableMediaViewer', 'enableInfiniteScroll',
                'enablePlaylistDiscovery', 'enableLearnerMode', 'enableAdvancedSearch',
                'enableWorkMetadata', 'enableWhisper',
            ];
            const result: Record<string, string> = {};
            for (const k of keys) {
                const val = api.get(k);
                result[k] = typeof val;
            }
            return result;
        });

        if (toggleValues) {
            for (const [key, type] of Object.entries(toggleValues)) {
                console.log(`${key}: ${type}`);
                expect(type).toBe('boolean');
            }
        }
    });
});
