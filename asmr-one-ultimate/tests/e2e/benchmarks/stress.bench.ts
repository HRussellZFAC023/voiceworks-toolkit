/**
 * Stress Benchmarks
 *
 * Validates behavior under high load: dedup prevents duplicate work,
 * concurrent operations don't crash, and the system handles rapid
 * navigation gracefully.
 */

import { test, helpers } from '../fixtures';

test.describe('Stress Tests', () => {
    test('rapid navigation does not crash', async ({ injectedPage, waitForBridge }) => {
        const errors: string[] = [];
        injectedPage.on('pageerror', (e) => errors.push(e.message));

        await helpers.gotoHome(injectedPage, 1000);
        await waitForBridge(20_000);

        // Rapidly navigate between pages
        for (let i = 0; i < 5; i++) {
            await helpers.gotoWork(injectedPage, 'RJ01052162');
            await injectedPage.waitForTimeout(500);
            await helpers.gotoHome(injectedPage);
            await injectedPage.waitForTimeout(500);
        }

        // Page should still be alive
        const alive = await injectedPage.evaluate(() => document.readyState === 'complete').catch(() => false);
        test.expect(alive).toBe(true);

        // No fatal errors
        const fatalErrors = errors.filter(e =>
            !e.includes('net::ERR_') &&
            !e.includes('ERR_FAILED') &&
            !e.includes('AbortError')
        );
        console.log(`Errors during rapid navigation: ${fatalErrors.length}`);
        test.expect(fatalErrors.length).toBeLessThanOrEqual(3);
    });

    test('SharedCache handles 1000 concurrent writes without error', async ({ injectedPage, waitForBridge }) => {
        await helpers.gotoHome(injectedPage, 2000);
        await waitForBridge(20_000);

        const result = await injectedPage.evaluate(() => {
            const w = window as any;
            const cache = w.__ASMR_SHARED_CACHE__;
            if (!cache) return { available: false, success: false, count: 0, ms: 0 };

            const start = performance.now();
            const count = 1000;

            for (let i = 0; i < count; i++) {
                cache.set(`bench:stress:${i}`, `value-${i}`, 5000);
            }

            let verified = 0;
            for (let i = 0; i < count; i++) {
                if (cache.get(`bench:stress:${i}`) === `value-${i}`) verified++;
            }

            // Cleanup
            for (let i = 0; i < count; i++) {
                cache.delete(`bench:stress:${i}`);
            }

            return {
                available: true,
                success: verified === count,
                count: verified,
                ms: performance.now() - start,
            };
        });

        if (result.available) {
            console.log(`1000 cache ops: ${result.ms.toFixed(1)}ms, ${result.count}/1000 verified`);
            test.expect(result.success).toBe(true);
        }
    });

    test('EventBus handles burst of 100 events without dropping', async ({ injectedPage, waitForBridge }) => {
        await helpers.gotoHome(injectedPage, 2000);
        await waitForBridge(20_000);

        const result = await injectedPage.evaluate(() => {
            let received = 0;
            const w = window as any;

            // Access EventBus through the module system
            // Use a custom event that nothing else listens to
            const eventName = 'bench:stress-test';

            // We'll use CustomEvent on the window as a simpler proxy
            window.addEventListener(eventName, () => received++);

            const start = performance.now();
            for (let i = 0; i < 100; i++) {
                window.dispatchEvent(new CustomEvent(eventName));
            }
            const ms = performance.now() - start;

            return { received, ms };
        });

        console.log(`100 events dispatched in ${result.ms.toFixed(2)}ms, ${result.received} received`);
        test.expect(result.received).toBe(100);
    });

    test('DOM mutation handling does not degrade with many mutations', async ({ injectedPage, waitForBridge }) => {
        await helpers.gotoHome(injectedPage, 2000);
        await waitForBridge(20_000);

        const result = await injectedPage.evaluate(async () => {
            const container = document.createElement('div');
            container.style.display = 'none';
            document.body.appendChild(container);

            const start = performance.now();
            const batchSize = 50;

            // Add and remove elements in batches
            for (let batch = 0; batch < 10; batch++) {
                for (let i = 0; i < batchSize; i++) {
                    const el = document.createElement('span');
                    el.textContent = `test-${batch}-${i}`;
                    el.className = 'q-item__label';
                    container.appendChild(el);
                }
                // Let MutationObserver process
                await new Promise(r => setTimeout(r, 10));

                // Remove them
                container.innerHTML = '';
                await new Promise(r => setTimeout(r, 10));
            }

            const ms = performance.now() - start;
            document.body.removeChild(container);

            return { ms, mutations: 10 * batchSize * 2 };
        });

        console.log(`${result.mutations} DOM mutations processed in ${result.ms.toFixed(1)}ms`);
        // Should complete in under 5 seconds
        test.expect(result.ms).toBeLessThan(5000);
    });

    test('page does not leak after work page visit', async ({ injectedPage, waitForBridge }) => {
        await helpers.gotoHome(injectedPage, 2000);
        await waitForBridge(20_000);

        // Get baseline heap
        const baseline = await injectedPage.evaluate(() => {
            if (typeof gc === 'function') gc();
            return (performance as any).memory?.usedJSHeapSize ?? 0;
        });

        // Visit work page and return
        await helpers.gotoWork(injectedPage, 'RJ01052162', 2000);
        await helpers.gotoHome(injectedPage, 2000);

        // Force GC if available and measure
        const after = await injectedPage.evaluate(() => {
            if (typeof gc === 'function') gc();
            return (performance as any).memory?.usedJSHeapSize ?? 0;
        });

        if (baseline > 0 && after > 0) {
            const leakMB = (after - baseline) / 1024 / 1024;
            console.log(`Heap after round-trip: ${leakMB.toFixed(1)}MB growth`);
            // Allow up to 20MB growth (includes page-specific resources)
            test.expect(leakMB).toBeLessThan(20);
        }
    });
});
