import { describe, expect, it, vi } from 'vitest';
import { runPacedBatches } from '../../src/core/PacedBatch';

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
