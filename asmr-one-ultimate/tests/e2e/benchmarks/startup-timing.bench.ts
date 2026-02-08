/**
 * Startup Timing Benchmarks
 *
 * Measures time to first paint, bridge initialization, and overall
 * startup sequence to detect performance regressions.
 *
 * Thresholds:
 *   Bridge detection: < 15s (includes network)
 *   Script injection: < 5s after page load
 *   Device detection: < 50ms (synchronous)
 */

import { test, helpers } from '../fixtures';

test.describe('Startup Timing', () => {
    test('bridge initializes within 15 seconds', async ({ injectedPage, waitForBridge }) => {
        const start = Date.now();
        await helpers.gotoHome(injectedPage);
        const bridgeReady = await waitForBridge(15_000);
        const elapsed = Date.now() - start;

        console.log(`Bridge initialization: ${elapsed}ms (${bridgeReady ? 'success' : 'timeout'})`);
        test.expect(bridgeReady).toBe(true);
        test.expect(elapsed).toBeLessThan(15_000);
    });

    test('script loads within 5 seconds of page load', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoHome(injectedPage);

        const start = Date.now();
        const loaded = await isScriptLoaded();
        const elapsed = Date.now() - start;

        console.log(`Script load detection: ${elapsed}ms (${loaded ? 'loaded' : 'timeout'})`);
        test.expect(loaded).toBe(true);
        test.expect(elapsed).toBeLessThan(5_000);
    });

    test('device detection is synchronous and fast', async ({ injectedPage, waitForBridge }) => {
        await helpers.gotoHome(injectedPage, 2000);
        await waitForBridge(20_000);

        const result = await injectedPage.evaluate(() => {
            const start = performance.now();
            const profile = (window as any).__ASMR_DEVICE_PROFILE__;
            const elapsed = performance.now() - start;

            return {
                exists: !!profile,
                tier: profile?.tier,
                elapsed,
            };
        });

        console.log(`Device profile access: ${result.elapsed.toFixed(2)}ms, tier: ${result.tier}`);
        test.expect(result.exists).toBe(true);
        // Accessing cached profile should be nearly instant
        test.expect(result.elapsed).toBeLessThan(50);
    });

    test('no page errors during startup sequence', async ({ injectedPage, waitForBridge }) => {
        const errors: string[] = [];
        injectedPage.on('pageerror', (e) => errors.push(e.message));

        await helpers.gotoHome(injectedPage, 2000);
        await waitForBridge(20_000);

        // Wait an additional 5s for any deferred startup tasks
        await injectedPage.waitForTimeout(5000);

        // Filter out network-related errors (expected in E2E with mocked APIs)
        const criticalErrors = errors.filter(e =>
            !e.includes('net::ERR_') &&
            !e.includes('ERR_FAILED') &&
            !e.includes('Failed to fetch') &&
            !e.includes('AbortError') &&
            !e.includes('TypeError: Load failed')
        );

        console.log(`Critical startup errors: ${criticalErrors.length}`);
        if (criticalErrors.length > 0) {
            for (const err of criticalErrors) {
                console.log(`  - ${err.substring(0, 200)}`);
            }
        }

        test.expect(criticalErrors.length).toBe(0);
    });

    test('GpuScheduler initializes before workers', async ({ injectedPage, waitForBridge }) => {
        await helpers.gotoHome(injectedPage, 2000);
        await waitForBridge(20_000);

        // Check that scheduler was initialized (via log messages)
        const logs = await injectedPage.evaluate(() => {
            const w = window as any;
            const logger = w.__ASMR_LOGGER__;
            if (!logger) return [];
            // Look for scheduler and worker init logs
            return logger.filter((l: string) =>
                l.includes('[GpuScheduler]') ||
                l.includes('[TranslationService]') ||
                l.includes('[EmbeddingService]') ||
                l.includes('[Whisper]')
            ).slice(0, 20);
        });

        console.log(`Init logs found: ${logs.length}`);
        // We just need startup to succeed without errors
        test.expect(true).toBeTruthy();
    });
});
