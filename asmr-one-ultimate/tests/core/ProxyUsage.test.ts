import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('ProxyUsage', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('notifies a late subscriber when use was recorded before startup', async () => {
        const { onProxyUse, recordProxyUse } = await import('../../src/core/ProxyUsage');
        const listener = vi.fn();

        recordProxyUse();
        const unsubscribe = onProxyUse(listener);

        expect(listener).toHaveBeenCalledOnce();
        unsubscribe();
        recordProxyUse();
        expect(listener).toHaveBeenCalledOnce();
    });

    it('isolates observer failures so every listener still receives the signal', async () => {
        const { onProxyUse, recordProxyUse } = await import('../../src/core/ProxyUsage');
        const healthy = vi.fn();
        onProxyUse(() => { throw new Error('listener failed'); });
        onProxyUse(healthy);

        expect(() => recordProxyUse()).not.toThrow();
        expect(healthy).toHaveBeenCalledOnce();
    });
});
