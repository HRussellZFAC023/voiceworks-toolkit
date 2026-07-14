/**
 * Run independent async jobs in small batches with a pause between batches.
 *
 * This is intentionally tiny and dependency-free so API-facing features share
 * one conservative concurrency boundary instead of each inventing its own
 * high-fan-out Promise.all loop.
 */
export async function runPacedBatches<TInput, TOutput>(
    inputs: readonly TInput[],
    worker: (input: TInput) => Promise<TOutput>,
    options: {
        batchSize?: number;
        delayMs?: number;
        delay?: (ms: number) => Promise<void>;
    } = {},
): Promise<PromiseSettledResult<TOutput>[]> {
    const batchSize = Math.max(1, Math.floor(options.batchSize ?? 3));
    const delayMs = Math.max(0, options.delayMs ?? 350);
    const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const settled: PromiseSettledResult<TOutput>[] = [];

    for (let i = 0; i < inputs.length; i += batchSize) {
        settled.push(...await Promise.allSettled(
            inputs.slice(i, i + batchSize).map(worker),
        ));
        if (delayMs > 0 && i + batchSize < inputs.length) {
            await delay(delayMs);
        }
    }

    return settled;
}

/**
 * Run a bounded number of workers without batch barriers.
 *
 * Unlike `runPacedBatches`, a free slot immediately takes the next input, so
 * one slow request cannot stall otherwise-idle capacity. Results retain input
 * order and one rejection never stops the remaining work.
 */
export async function runRollingPool<TInput, TOutput>(
    inputs: readonly TInput[],
    worker: (input: TInput) => Promise<TOutput>,
    options: number | {
        concurrency?: number;
        minStartIntervalMs?: number;
        delay?: (ms: number) => Promise<void>;
    } = 3,
): Promise<PromiseSettledResult<TOutput>[]> {
    const results = new Array<PromiseSettledResult<TOutput>>(inputs.length);
    const concurrency = typeof options === 'number' ? options : (options.concurrency ?? 3);
    const requestedConcurrency = Number.isFinite(concurrency) ? Math.floor(concurrency) : 3;
    const workerCount = Math.min(inputs.length, Math.max(1, requestedConcurrency));
    const minStartIntervalMs = typeof options === 'number'
        ? 0
        : Math.max(0, Number.isFinite(options.minStartIntervalMs) ? options.minStartIntervalMs ?? 0 : 0);
    const delay = typeof options === 'number'
        ? (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
        : options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let nextIndex = 0;
    let nextStartAt = 0;

    const waitForStartSlot = async (): Promise<void> => {
        if (minStartIntervalMs <= 0) return;
        const now = Date.now();
        const scheduledAt = Math.max(now, nextStartAt);
        nextStartAt = scheduledAt + minStartIntervalMs;
        if (scheduledAt > now) await delay(scheduledAt - now);
    };

    const runners = Array.from({ length: workerCount }, async () => {
        for (;;) {
            const index = nextIndex;
            if (index >= inputs.length) return;
            nextIndex += 1;
            await waitForStartSlot();
            try {
                results[index] = { status: 'fulfilled', value: await worker(inputs[index]) };
            } catch (reason) {
                results[index] = { status: 'rejected', reason };
            }
        }
    });

    await Promise.all(runners);
    return results;
}
