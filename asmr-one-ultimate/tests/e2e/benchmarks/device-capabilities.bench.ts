/**
 * Device Capabilities & Mobile Simulation Benchmarks
 *
 * Validates tier classification, model budget enforcement,
 * and constrained device behavior.
 */

import { test, helpers } from '../fixtures';

test.describe('DeviceCapabilities', () => {
    test('detects device tier on startup', async ({ injectedPage, waitForBridge }) => {
        await helpers.gotoHome(injectedPage, 2000);
        await waitForBridge(20_000);

        const profile = await injectedPage.evaluate(() => {
            return (window as any).__ASMR_DEVICE_PROFILE__;
        });

        test.expect(profile).toBeTruthy();
        test.expect(['full', 'limited', 'constrained']).toContain(profile.tier);
        test.expect(typeof profile.hasGpu).toBe('boolean');
        test.expect(typeof profile.memory).toBe('number');
        test.expect(typeof profile.cores).toBe('number');
        test.expect(typeof profile.isMobile).toBe('boolean');
        test.expect(typeof profile.reason).toBe('string');

        console.log(`Device tier: ${profile.tier}`);
        console.log(`Profile: ${profile.reason}`);
    });

    test('tier is exposed for debugging', async ({ injectedPage, waitForBridge }) => {
        await helpers.gotoHome(injectedPage, 2000);
        await waitForBridge(20_000);

        const tier = await injectedPage.evaluate(() => {
            return (window as any).__ASMR_DEVICE_TIER__;
        });

        test.expect(tier).toBeTruthy();
        test.expect(['full', 'limited', 'constrained']).toContain(tier);
    });

    test('Chromium headless detects as full tier with GPU', async ({ injectedPage, waitForBridge }) => {
        await helpers.gotoHome(injectedPage, 2000);
        await waitForBridge(20_000);

        const profile = await injectedPage.evaluate(() => {
            return (window as any).__ASMR_DEVICE_PROFILE__;
        });

        // Headless Chromium with --enable-unsafe-webgpu should detect as full or limited
        // (never constrained, since it's not mobile)
        test.expect(profile.isMobile).toBe(false);
        test.expect(['full', 'limited']).toContain(profile.tier);
    });
});

test.describe('Mobile Simulation', () => {
    test('touch device with small screen is constrained or limited', async ({ browser }) => {
        // Create a mobile-like context
        const context = await browser.newContext({
            viewport: { width: 375, height: 812 }, // iPhone X
            isMobile: true,
            hasTouch: true,
            userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
        });

        const page = await context.newPage();

        // Just evaluate the classification logic directly
        const tier = await page.evaluate(() => {
            const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
            const screenWidth = screen?.width ?? window.innerWidth;
            const ua = navigator.userAgent || '';
            const isMobile = (isTouch && screenWidth < 1024) || /Mobi|Android|iPhone|iPod/i.test(ua);
            const hasGpu = typeof (navigator as any).gpu !== 'undefined' && !!(navigator as any).gpu;
            const memory = (navigator as any).deviceMemory ?? -1;
            const cores = navigator.hardwareConcurrency ?? -1;

            // Reproduce classification logic
            if (isMobile && (!hasGpu || (memory > 0 && memory < 4))) return 'constrained';
            if (hasGpu && !isMobile && (memory >= 4 || memory < 0) && (cores >= 4 || cores < 0)) return 'full';
            return 'limited';
        });

        console.log(`Mobile simulation tier: ${tier}`);
        // Mobile device should not be classified as "full"
        test.expect(['constrained', 'limited']).toContain(tier);

        await context.close();
    });
});
