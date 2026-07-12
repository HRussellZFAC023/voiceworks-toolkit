import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    gmRequest: vi.fn(),
    token: 'shared-jpdb-test-key',
}));

vi.mock('../../src/store/AppStore', () => ({
    AppStore: { getConfig: vi.fn(() => mocks.token) },
}));
vi.mock('../../src/infrastructure/HttpClient', () => ({
    gmRequest: mocks.gmRequest,
    HttpError: class HttpError extends Error {
        constructor(
            public readonly status: number,
            message: string,
            public readonly responseText = '',
        ) { super(message); }
    },
}));
vi.mock('../../src/core/Logger', () => ({
    Logger: { debug: vi.fn(), warn: vi.fn() },
}));

import { JpdbService } from '../../src/services/JpdbService';
import { HttpError } from '../../src/infrastructure/HttpClient';

describe('JpdbService transport compatibility', () => {
    beforeEach(() => {
        mocks.gmRequest.mockReset();
    });

    it('uses the same JPDB v1 bearer-key contract as Yomu via CORS-safe userscript HTTP', async () => {
        mocks.gmRequest.mockResolvedValue({
            status: 200,
            response: { tokens: [[]], vocabulary: [] },
            responseText: '',
        });

        await JpdbService.parse(['互換性テスト']);

        expect(mocks.gmRequest).toHaveBeenCalledTimes(1);
        expect(mocks.gmRequest).toHaveBeenCalledWith(expect.objectContaining({
            method: 'POST',
            url: 'https://jpdb.io/api/v1/parse',
            headers: expect.objectContaining({ Authorization: 'Bearer shared-jpdb-test-key' }),
            responseType: 'json',
        }));
    });

    it('preserves a structured JPDB error message from an HTTP failure', async () => {
        mocks.gmRequest.mockRejectedValue(new HttpError(
            400,
            'HTTP 400: Bad Request',
            JSON.stringify({ error_message: 'Invalid request payload' }),
        ));

        await expect(JpdbService.parse(['別のテスト']))
            .rejects.toThrow('Invalid request payload');
    });
});
