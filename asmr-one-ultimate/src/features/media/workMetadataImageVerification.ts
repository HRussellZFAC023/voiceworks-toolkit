import { runRollingPool } from '../../core/PacedBatch';

export const METADATA_IMAGE_VERIFY_CONCURRENCY = 3;

/**
 * Verify a snapshot of one work's sample images. Workers that have not started
 * when the work/proxy generation changes are discarded without making a
 * request; workers already in flight receive the captured generation so their
 * caller can reject stale writes after awaiting the network.
 */
export async function verifyMetadataImageBatch(
    urls: readonly string[],
    generation: number,
    getCurrentGeneration: () => number,
    verify: (url: string, generation: number) => Promise<boolean>,
): Promise<void> {
    await runRollingPool(
        [...urls],
        async (url) => getCurrentGeneration() === generation
            && await verify(url, generation),
        METADATA_IMAGE_VERIFY_CONCURRENCY,
    );
}
