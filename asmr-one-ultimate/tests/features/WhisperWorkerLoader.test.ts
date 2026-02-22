import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __getWhisperWorkerCodeForTests, createWhisperWorker } from '../../src/features/WhisperWorkerLoader';

describe('WhisperWorkerLoader', () => {
    let capturedBlob: Blob | null = null;
    let workerCtor: ReturnType<typeof vi.fn>;
    let originalCreateObjectURL: any;
    let originalRevokeObjectURL: any;

    beforeEach(() => {
        capturedBlob = null;
        workerCtor = vi.fn(() => ({ terminate: vi.fn(), postMessage: vi.fn() }));
        vi.stubGlobal('Worker', workerCtor as any);
        originalCreateObjectURL = (URL as any).createObjectURL;
        originalRevokeObjectURL = (URL as any).revokeObjectURL;

        (URL as any).createObjectURL = vi.fn((blob: Blob | MediaSource) => {
            capturedBlob = blob as Blob;
            return 'blob:test-worker';
        });
        (URL as any).revokeObjectURL = vi.fn(() => {});
    });

    afterEach(() => {
        (URL as any).createObjectURL = originalCreateObjectURL;
        (URL as any).revokeObjectURL = originalRevokeObjectURL;
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('creates module worker from inline blob and revokes URL', async () => {
        const worker = createWhisperWorker();

        expect(worker).toBeDefined();
        expect(workerCtor).toHaveBeenCalledWith('blob:test-worker', { type: 'module' });
        expect((URL as any).revokeObjectURL).toHaveBeenCalledWith('blob:test-worker');
        expect(capturedBlob).toBeInstanceOf(Blob);
        expect((capturedBlob as Blob).size).toBeGreaterThan(1000);
    });

    it('includes temporary WASM fallback logic that retries WebGPU on next chunk', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain('const useTemporaryFallback = isTimeoutFallback && !transientWebgpuFallbackUsed;');
        expect(code).toContain('skipWebgpu = !useTemporaryFallback;');
        expect(code).toContain('transientWebgpuFallbackUsed = true;');
        expect(code).toContain('Temporary WASM fallback complete; retrying WebGPU on next chunk');
    });

    it('resets temporary fallback state on worker reset message', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain('if (msg.type === \'reset\')');
        expect(code).toContain('transientWebgpuFallbackUsed = false;');
    });
});
