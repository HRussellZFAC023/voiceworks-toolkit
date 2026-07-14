import { describe, expect, it, vi } from 'vitest';
import { runPacedBatches, runRollingPool } from '../../src/core/PacedBatch';

describe('runPacedBatches', () => {
    it('caps concurrency and pauses between batches', async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        const delay = vi.fn(async () => undefined);

        const results = await runPacedBatches(
            [1, 2, 3, 4, 5, 6, 7],
            async (value) => {
                inFlight += 1;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await Promise.resolve();
                inFlight -= 1;
                return value * 2;
            },
            { batchSize: 3, delayMs: 350, delay },
        );

        expect(maxInFlight).toBe(3);
        expect(delay).toHaveBeenCalledTimes(2);
        expect(delay).toHaveBeenCalledWith(350);
        expect(results.map((result) => result.status === 'fulfilled' ? result.value : null))
            .toEqual([2, 4, 6, 8, 10, 12, 14]);
    });

    it('keeps later batches running when an individual request fails', async () => {
        const visited: number[] = [];
        const results = await runPacedBatches(
            [1, 2, 3],
            async (value) => {
                visited.push(value);
                if (value === 2) throw new Error('rate limited');
                return value;
            },
            { batchSize: 2, delayMs: 0 },
        );

        expect(visited).toEqual([1, 2, 3]);
        expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    });
});

describe('runRollingPool', () => {
    it('fills a freed slot immediately, caps concurrency, and preserves result order', async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        const started: number[] = [];
        const releases = new Map<number, () => void>();
        const pending = runRollingPool([1, 2, 3, 4], async (value) => {
            started.push(value);
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise<void>((resolve) => releases.set(value, resolve));
            inFlight -= 1;
            return value * 10;
        }, 3);

        await vi.waitFor(() => expect(started).toEqual([1, 2, 3]));
        releases.get(2)?.();
        await vi.waitFor(() => expect(started).toEqual([1, 2, 3, 4]));
        expect(inFlight).toBe(3);
        releases.get(1)?.();
        releases.get(3)?.();
        releases.get(4)?.();

        const results = await pending;
        expect(maxInFlight).toBe(3);
        expect(results.map(result => result.status === 'fulfilled' ? result.value : null))
            .toEqual([10, 20, 30, 40]);
    });

    it('continues after a worker rejects', async () => {
        const visited: number[] = [];
        const results = await runRollingPool([1, 2, 3], async (value) => {
            visited.push(value);
            if (value === 2) throw new Error('failed');
            return value;
        }, 2);

        expect(visited.sort()).toEqual([1, 2, 3]);
        expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    });

    it('uses the safe default when concurrency is not finite', async () => {
        const results = await runRollingPool([1, 2], async value => value, Number.NaN);
        expect(results.map(result => result.status === 'fulfilled' ? result.value : null)).toEqual([1, 2]);
    });

    it('paces worker starts while remaining work-conserving', async () => {
        vi.useFakeTimers();
        try {
            const starts: number[] = [];
            const pending = runRollingPool([1, 2, 3], async value => {
                starts.push(Date.now());
                return value;
            }, { concurrency: 3, minStartIntervalMs: 50 });

            await vi.advanceTimersByTimeAsync(49);
            expect(starts).toHaveLength(1);
            await vi.advanceTimersByTimeAsync(1);
            expect(starts).toHaveLength(2);
            await vi.advanceTimersByTimeAsync(50);
            await expect(pending).resolves.toHaveLength(3);
            expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(50);
            expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(50);
        } finally {
            vi.useRealTimers();
        }
    });
});
