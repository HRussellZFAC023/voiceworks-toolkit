import { describe, expect, it, vi } from 'vitest';
import { LazyFeatureGate } from '../../src/core/LazyFeatureGate';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
}

describe('LazyFeatureGate', () => {
    it('does not enable a feature that was switched off while loading', async () => {
        const pending = deferred<{ enable: () => void; disable: () => void }>();
        const loader = vi.fn(() => pending.promise);
        const gate = new LazyFeatureGate(loader);

        gate.enable();
        gate.disable();
        gate.enable();
        gate.disable();

        const feature = { enable: vi.fn(() => undefined), disable: vi.fn(() => undefined) };
        pending.resolve(feature);
        await pending.promise;
        await Promise.resolve();

        expect(loader).toHaveBeenCalledTimes(1);
        expect(feature.enable).not.toHaveBeenCalled();
        expect(feature.disable).not.toHaveBeenCalled();
    });

    it('loads once and applies each stable state once', async () => {
        const feature = { enable: vi.fn(() => undefined), disable: vi.fn(() => undefined) };
        const pending = deferred<typeof feature>();
        const loader = vi.fn(() => pending.promise);
        const gate = new LazyFeatureGate(loader);

        gate.enable();
        gate.enable();
        pending.resolve(feature);
        await pending.promise;
        await vi.waitFor(() => expect(feature.enable).toHaveBeenCalledTimes(1));
        gate.disable();
        gate.disable();
        gate.enable();

        expect(loader).toHaveBeenCalledTimes(1);
        expect(feature.enable).toHaveBeenCalledTimes(2);
        expect(feature.disable).toHaveBeenCalledTimes(1);
    });

    it('waits for an async enable to settle before applying a newer disable', async () => {
        const pendingEnable = deferred<void>();
        const feature = {
            enable: vi.fn(() => pendingEnable.promise),
            disable: vi.fn(() => undefined),
        };
        const gate = new LazyFeatureGate(async () => feature);

        gate.enable();
        await vi.waitFor(() => expect(feature.enable).toHaveBeenCalledTimes(1));
        gate.disable();
        expect(feature.disable).not.toHaveBeenCalled();

        pendingEnable.resolve();
        await vi.waitFor(() => expect(feature.disable).toHaveBeenCalledTimes(1));
    });

    it('reports a rejected enable once and retries only after a fresh toggle', async () => {
        const onError = vi.fn();
        const feature = {
            enable: vi.fn()
                .mockRejectedValueOnce(new Error('not ready'))
                .mockResolvedValue(undefined),
            disable: vi.fn(() => undefined),
        };
        const gate = new LazyFeatureGate(async () => feature, onError);

        gate.enable();
        await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
        await Promise.resolve();
        expect(feature.enable).toHaveBeenCalledTimes(1);

        gate.disable();
        gate.enable();
        await vi.waitFor(() => expect(feature.enable).toHaveBeenCalledTimes(2));
    });

    it('retries a rejected dynamic import when enable is requested again', async () => {
        const onError = vi.fn();
        const feature = { enable: vi.fn(() => undefined), disable: vi.fn(() => undefined) };
        const loader = vi.fn()
            .mockRejectedValueOnce(new Error('chunk unavailable'))
            .mockResolvedValueOnce(feature);
        const gate = new LazyFeatureGate(loader, onError);

        gate.enable();
        await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));

        gate.enable();
        await vi.waitFor(() => expect(feature.enable).toHaveBeenCalledTimes(1));
        expect(loader).toHaveBeenCalledTimes(2);
    });
});
