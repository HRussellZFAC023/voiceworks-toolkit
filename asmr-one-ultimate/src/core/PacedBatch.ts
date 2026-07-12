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
