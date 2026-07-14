import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmbeddingWorker, normalizeEmbeddingText } from '../../src/features/EmbeddingWorkerLoader';

describe('EmbeddingWorkerLoader', () => {
    let workerCtor: any;
    let originalCreateObjectURL: any;
    let originalRevokeObjectURL: any;

    beforeEach(() => {
        workerCtor = vi.fn(() => ({ terminate: vi.fn(), postMessage: vi.fn() }));
        vi.stubGlobal('Worker', workerCtor as any);

        originalCreateObjectURL = (URL as any).createObjectURL;
        originalRevokeObjectURL = (URL as any).revokeObjectURL;
        (URL as any).createObjectURL = vi.fn(() => 'blob:test-embedding-worker');
        (URL as any).revokeObjectURL = vi.fn(() => {});
    });

    afterEach(() => {
        (URL as any).createObjectURL = originalCreateObjectURL;
        (URL as any).revokeObjectURL = originalRevokeObjectURL;
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('creates module worker from inline blob and revokes URL', () => {
        const worker = createEmbeddingWorker();

        expect(worker).toBeDefined();
        expect(workerCtor).toHaveBeenCalledWith('blob:test-embedding-worker', { type: 'module' });
        expect((URL as any).revokeObjectURL).toHaveBeenCalledWith('blob:test-embedding-worker');
    });

    it('normalizes real whitespace before embedding', () => {
        expect(normalizeEmbeddingText('  title\n\twith   spaces  ')).toBe('title with spaces');
    });
});
