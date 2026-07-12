import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getJsonViaCors: vi.fn(),
    recordProxyUse: vi.fn(),
}));

vi.mock('../../src/infrastructure/KikoeruBridge', () => ({
    KikoeruBridge: {
        getInstance: () => ({ axios: { defaults: { baseURL: 'https://api.asmr.one' } } }),
    },
}));

vi.mock('../../src/infrastructure/HttpClient', () => ({
    HttpClient: { getJsonViaCors: mocks.getJsonViaCors },
    HttpError: class HttpError extends Error {
        constructor(public status: number, message: string) { super(message); }
    },
}));

vi.mock('../../src/core/ProxyUsage', () => ({
    recordProxyUse: mocks.recordProxyUse,
    hasUsedProxy: vi.fn(),
    onProxyUse: vi.fn(),
}));

vi.mock('../../src/core/Utils', () => ({
    Logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { proxyRequest } from '../../src/features/playlist/PlaylistService';

describe('PlaylistService proxy usage signal', () => {
    beforeEach(() => {
        mocks.getJsonViaCors.mockReset();
        mocks.recordProxyUse.mockReset();
    });

    it('records proxy use only after a successful relay response', async () => {
        mocks.getJsonViaCors.mockResolvedValue({ data: { works: [] } });

        await expect(proxyRequest('/api/works')).resolves.toEqual({ works: [] });
        expect(mocks.recordProxyUse).toHaveBeenCalledOnce();
    });

    it('does not record proxy use when the relay fails', async () => {
        mocks.getJsonViaCors.mockRejectedValue(new Error('relay unavailable'));

        await expect(proxyRequest('/api/works')).resolves.toBeNull();
        expect(mocks.recordProxyUse).not.toHaveBeenCalled();
    });
});
