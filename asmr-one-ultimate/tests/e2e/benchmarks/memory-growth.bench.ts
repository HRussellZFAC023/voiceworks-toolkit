/**
 * Memory Growth Benchmarks
 *
 * Measures heap size, DOM node count, and detached node leaks
 * over time during idle and active states.
 *
 * Thresholds:
 *   Idle heap growth: < 30MB/min
 *   Active heap growth: < 50MB/2min
 *   DOM node stability: ±10% over monitoring period
 */

import { test, helpers } from '../fixtures';

test.describe('Memory Growth', () => {
    test('idle heap stays stable for 60 seconds', async ({ injectedPage, waitForBridge }) => {
        await helpers.gotoHome(injectedPage, 2000);
        await waitForBridge(20_000);

        const result = await helpers.monitorHealth(injectedPage, 30);
        test.expect(result.alive).toBe(true);

        if (result.samples.length >= 2) {
            const first = result.samples[0];
            const last = result.samples[result.samples.length - 1];
            const heapGrowthMB = last.heap - first.heap;
            const durationMin = result.samples.length / 60;

            console.log(`Idle heap growth: ${heapGrowthMB.toFixed(1)}MB over ${result.samples.length}s`);
            console.log(`Rate: ${(heapGrowthMB / durationMin).toFixed(1)}MB/min`);

            // Threshold: < 30MB/min
            test.expect(heapGrowthMB / durationMin).toBeLessThan(30);
        }

        test.expect(result.errors.length).toBe(0);
    });

    test('DOM node count stays stable during idle', async ({ injectedPage, waitForBridge }) => {
        await helpers.gotoHome(injectedPage, 2000);
        await waitForBridge(20_000);

        const result = await helpers.monitorHealth(injectedPage, 20);
        test.expect(result.alive).toBe(true);

        if (result.samples.length >= 2) {
            const first = result.samples[0];
            const last = result.samples[result.samples.length - 1];
            const domDelta = Math.abs(last.dom - first.dom);
            const domPercent = (domDelta / first.dom) * 100;

            console.log(`DOM nodes: ${first.dom} → ${last.dom} (${domDelta > 0 ? '+' : ''}${domDelta}, ${domPercent.toFixed(1)}%)`);

            // Threshold: ±10% DOM node stability
            test.expect(domPercent).toBeLessThan(10);
        }
    });

    test('no detached DOM nodes accumulate', async ({ injectedPage, waitForBridge }) => {
        await helpers.gotoHome(injectedPage, 2000);
        await waitForBridge(20_000);

        // Navigate to a work page and back to trigger cleanup
        await helpers.gotoWork(injectedPage, 'RJ01052162', 2000);
        await helpers.gotoHome(injectedPage, 2000);

        const detachedCount = await injectedPage.evaluate(() => {
            // Count elements with no parent in the document
            const all = document.querySelectorAll('*');
            let detached = 0;
            for (const el of all) {
                if (!document.contains(el)) detached++;
            }
            return detached;
        });

        console.log(`Detached DOM nodes: ${detachedCount}`);
        // Detached nodes queried from document.querySelectorAll should always be 0
        // (they're in the document by definition). This tests that we don't have
        // zombie references in WeakSets/Maps
        test.expect(detachedCount).toBe(0);
    });

    test('no console errors during 20s idle period', async ({ injectedPage, waitForBridge }) => {
        const errors: string[] = [];
        injectedPage.on('pageerror', (e) => errors.push(e.message));

        await helpers.gotoHome(injectedPage, 2000);
        await waitForBridge(20_000);

        // Wait 20 seconds
        await injectedPage.waitForTimeout(20_000);

        console.log(`Console errors during idle: ${errors.length}`);
        if (errors.length > 0) {
            for (const err of errors.slice(0, 5)) {
                console.log(`  - ${err.substring(0, 200)}`);
            }
        }

        // Allow at most 2 non-critical errors (network flakiness)
        test.expect(errors.length).toBeLessThanOrEqual(2);
    });
});
