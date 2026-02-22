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

    it('pins worker to WASM after GPU inference failure to avoid backend thrash', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain('skipWebgpu = true;');
        expect(code).not.toContain('transientWebgpuFallbackUsed');
        expect(code).not.toContain('Temporary WASM fallback complete; retrying WebGPU on next chunk');
    });

    it('suppresses late WebGPU rejections after timeout recovery', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain('Ignoring late WebGPU rejection after timeout');
        expect(code).toContain('timedOut = true;');
        expect(code).toContain('Promise.race([guarded, timeout])');
    });

    it('suppresses late recoverable GPU unhandled rejections after fallback', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain('RECOVERABLE_GPU_REJECTION_RE');
        expect(code).toContain('suppressRecoverableGpuRejectionsUntil');
        expect(code).toContain('looksNumericGpuCode');
        expect(code).toContain('Suppressed late recoverable GPU rejection');
        expect(code).toContain('armRecoverableRejectionSuppression();');
    });

    it('uses fp32 decoder on webgpu dtype candidates', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain("decoder_model_merged: 'fp32'");
        expect(code).not.toContain("decoder_model_merged: 'q4'");
    });

    it('tries fp16 encoder first on Intel Arc, then falls back to fp32', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain('isIntelArc');
        expect(code).toContain("encoder_model: 'fp16'");
        expect(code).toContain("encoder_model: 'fp32'");
    });

    it('keeps first-run timeout window when shader warmup does not complete', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain('ENABLE_SHADER_WARMUP');
        expect(code).toContain('Skipping warmup on Firefox; using extended first-inference timeout');
        expect(code).toContain('let warmupCompiled = false;');
        expect(code).toContain('if (warmupCompiled)');
        expect(code).toContain('Keeping first-run timeout window because warmup did not complete');
    });

    it('reuses same in-flight pipeline load instead of disposing/recreating', () => {
        const code = __getWhisperWorkerCodeForTests();

        expect(code).toContain('let loadingModel = null;');
        expect(code).toContain('const sameLoading = !currentModel');
        expect(code).toContain('if (pipelinePromise && (sameLoaded || sameLoading))');
    });
});
