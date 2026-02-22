/**
 * Shared helpers/constants for inline worker loaders.
 */

export const WORKER_TRANSFORMER_URLS = [
    'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1',
    'https://esm.sh/@huggingface/transformers@3.8.1',
    'https://unpkg.com/@huggingface/transformers@3.8.1?module',
] as const;

export const WORKER_HUB_BASE_URLS = [
    'https://huggingface.co',
    'https://hf-mirror.com',
] as const;

/**
 * Create a module Worker from inline source and revoke the blob URL.
 */
export function createInlineWorker(workerCode: string): Worker {
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);

    try {
        return new Worker(blobUrl, { type: 'module' });
    } finally {
        URL.revokeObjectURL(blobUrl);
    }
}
