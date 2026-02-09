import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    HttpError,
    retryWithBackoff,
    gmRequest,
    parseGmHeaders,
    KikoeruApiClient,
    HttpClient,
} from '../../src/infrastructure/HttpClient';

describe('HttpError', () => {
    it('should create error with status and message', () => {
        const err = new HttpError(404, 'Not Found');
        expect(err.status).toBe(404);
        expect(err.message).toBe('Not Found');
        expect(err.name).toBe('HttpError');
    });

    it('should mark 429 as retryable', () => {
        expect(new HttpError(429, 'Rate Limited').retryable).toBe(true);
    });

    it('should mark 5xx as retryable', () => {
        expect(new HttpError(500, 'Server Error').retryable).toBe(true);
        expect(new HttpError(502, 'Bad Gateway').retryable).toBe(true);
        expect(new HttpError(503, 'Unavailable').retryable).toBe(true);
    });

    it('should mark 4xx (except 429) as not retryable', () => {
        expect(new HttpError(400, 'Bad Request').retryable).toBe(false);
        expect(new HttpError(401, 'Unauthorized').retryable).toBe(false);
        expect(new HttpError(403, 'Forbidden').retryable).toBe(false);
        expect(new HttpError(404, 'Not Found').retryable).toBe(false);
    });

    it('should be an instance of Error', () => {
        const err = new HttpError(500, 'fail');
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(HttpError);
    });
});

describe('retryWithBackoff', () => {
    it('should return result on first success', async () => {
        const fn = vi.fn().mockResolvedValue('success');
        const result = await retryWithBackoff(fn);
        expect(result).toBe('success');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure then succeed', async () => {
        const fn = vi.fn()
            .mockRejectedValueOnce(new Error('fail1'))
            .mockResolvedValueOnce('success');

        // Use real timers with short backoff
        const result = await retryWithBackoff(fn, { attempts: 3, backoffMs: 1, multiplier: 1 });
        expect(result).toBe('success');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should throw after all attempts exhausted', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('always fails'));
        await expect(
            retryWithBackoff(fn, { attempts: 2, backoffMs: 1, multiplier: 1 })
        ).rejects.toThrow('always fails');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should not retry non-retryable HttpErrors', async () => {
        const fn = vi.fn().mockRejectedValue(new HttpError(404, 'Not Found'));
        await expect(retryWithBackoff(fn, { attempts: 3 })).rejects.toThrow('Not Found');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry retryable HttpErrors (429)', async () => {
        const fn = vi.fn()
            .mockRejectedValueOnce(new HttpError(429, 'Rate Limited'))
            .mockResolvedValueOnce('ok');
        const result = await retryWithBackoff(fn, { attempts: 3, backoffMs: 1, multiplier: 1 });
        expect(result).toBe('ok');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should respect shouldRetry predicate', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('abort'));
        await expect(
            retryWithBackoff(fn, { attempts: 5, shouldRetry: () => false })
        ).rejects.toThrow('abort');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should use default config when none provided', async () => {
        const fn = vi.fn().mockResolvedValue('ok');
        expect(await retryWithBackoff(fn)).toBe('ok');
    });
});

describe('parseGmHeaders', () => {
    it('should parse raw headers string', () => {
        const raw = 'Content-Type: application/json\r\nX-Custom: value\r\n';
        const headers = parseGmHeaders(raw);
        expect(headers['content-type']).toBe('application/json');
        expect(headers['x-custom']).toBe('value');
    });

    it('should handle headers with colons in value', () => {
        const raw = 'Date: Mon, 01 Jan 2024 00:00:00 GMT\r\n';
        const headers = parseGmHeaders(raw);
        expect(headers['date']).toBe('Mon, 01 Jan 2024 00:00:00 GMT');
    });

    it('should return empty object for empty/null input', () => {
        expect(parseGmHeaders('')).toEqual({});
        expect(parseGmHeaders(undefined)).toEqual({});
    });

    it('should skip malformed header lines', () => {
        const raw = 'Valid: header\r\nmalformed-no-value\r\nAlso-Valid: yes\r\n';
        const headers = parseGmHeaders(raw);
        expect(headers['valid']).toBe('header');
        expect(headers['also-valid']).toBe('yes');
        expect(Object.keys(headers)).toHaveLength(2);
    });

    it('should lowercase header names', () => {
        const raw = 'X-Request-ID: abc123\r\n';
        const headers = parseGmHeaders(raw);
        expect(headers['x-request-id']).toBe('abc123');
    });

    it('should trim whitespace from keys and values', () => {
        const raw = '  Content-Type  :  text/html  \r\n';
        const headers = parseGmHeaders(raw);
        expect(headers['content-type']).toBe('text/html');
    });
});

describe('gmRequest', () => {
    it('should resolve on successful response', async () => {
        (globalThis as any).GM_xmlhttpRequest = vi.fn((opts: any) => {
            opts.onload({
                status: 200,
                statusText: 'OK',
                responseText: '{"data": true}',
                response: { data: true },
                responseHeaders: 'Content-Type: application/json\r\n',
            });
        });

        const res = await gmRequest({ url: 'https://example.com/api' });
        expect(res.status).toBe(200);
        expect(res.responseText).toBe('{"data": true}');
    });

    it('should reject on HTTP error status', async () => {
        (globalThis as any).GM_xmlhttpRequest = vi.fn((opts: any) => {
            opts.onload({
                status: 404,
                statusText: 'Not Found',
                responseText: '',
                response: null,
                responseHeaders: '',
            });
        });

        await expect(gmRequest({ url: 'https://example.com/missing' }))
            .rejects.toThrow('HTTP 404');
    });

    it('should reject on network error', async () => {
        (globalThis as any).GM_xmlhttpRequest = vi.fn((opts: any) => {
            opts.onerror(new Error('Network failure'));
        });

        await expect(gmRequest({ url: 'https://example.com' }))
            .rejects.toThrow('Network failure');
    });

    it('should reject on timeout', async () => {
        (globalThis as any).GM_xmlhttpRequest = vi.fn((opts: any) => {
            opts.ontimeout();
        });

        await expect(gmRequest({ url: 'https://example.com' }))
            .rejects.toThrow('Request timeout');
    });

    it('should reject when GM_xmlhttpRequest is not available', async () => {
        (globalThis as any).GM_xmlhttpRequest = undefined;

        await expect(gmRequest({ url: 'https://example.com' }))
            .rejects.toThrow('GM_xmlhttpRequest not available');
    });

    it('should pass request configuration', async () => {
        const mockGm = vi.fn((opts: any) => {
            opts.onload({ status: 200, responseText: 'ok', responseHeaders: '' });
        });
        (globalThis as any).GM_xmlhttpRequest = mockGm;

        await gmRequest({
            url: 'https://example.com',
            method: 'POST',
            headers: { 'X-Custom': 'test' },
            timeout: 5000,
        });

        expect(mockGm).toHaveBeenCalledWith(expect.objectContaining({
            method: 'POST',
            url: 'https://example.com',
            headers: { 'X-Custom': 'test' },
            timeout: 5000,
        }));
    });
});

describe('KikoeruApiClient', () => {
    let mockAxios: any;
    let client: KikoeruApiClient;

    beforeEach(() => {
        mockAxios = { get: vi.fn() };
        client = new KikoeruApiClient(mockAxios);
    });

    it('should fetch works', async () => {
        mockAxios.get.mockResolvedValue({ data: [{ id: 1 }] });
        const result = await client.getWorks({ page: 1 });
        expect(mockAxios.get).toHaveBeenCalledWith('/api/works', { params: { page: 1 } });
        expect(result).toEqual([{ id: 1 }]);
    });

    it('should fetch a single work', async () => {
        mockAxios.get.mockResolvedValue({ data: { id: 123 } });
        const result = await client.getWork(123);
        expect(mockAxios.get).toHaveBeenCalledWith('/api/work/123', { params: undefined });
        expect(result).toEqual({ id: 123 });
    });

    it('should fetch tags', async () => {
        mockAxios.get.mockResolvedValue({ data: { data: [{ id: 1, name: 'ASMR' }] } });
        const result = await client.getTags();
        expect(result).toEqual({ data: [{ id: 1, name: 'ASMR' }] });
    });

    it('should deduplicate concurrent requests for same path', async () => {
        let resolvePromise: (v: any) => void;
        mockAxios.get.mockImplementation(() => new Promise(r => { resolvePromise = r; }));

        const p1 = client.get('/api/test');
        const p2 = client.get('/api/test');

        resolvePromise!({ data: 'result' });
        const [r1, r2] = await Promise.all([p1, p2]);

        expect(r1).toBe('result');
        expect(r2).toBe('result');
        expect(mockAxios.get).toHaveBeenCalledTimes(1);
    });

    it('should not deduplicate different paths', async () => {
        mockAxios.get.mockResolvedValue({ data: 'ok' });
        await Promise.all([
            client.get('/api/a'),
            client.get('/api/b'),
        ]);
        expect(mockAxios.get).toHaveBeenCalledTimes(2);
    });

    it('should clean up inflight after request completes', async () => {
        mockAxios.get.mockResolvedValue({ data: 'first' });
        await client.get('/api/test');

        mockAxios.get.mockResolvedValue({ data: 'second' });
        const result = await client.get('/api/test');
        expect(result).toBe('second');
        expect(mockAxios.get).toHaveBeenCalledTimes(2);
    });
});

describe('HttpClient rate limiting', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
    });

    afterEach(() => {
        HttpClient.clearRateLimit('test.com');
        vi.useRealTimers();
    });

    it('should track rate limits', () => {
        expect(HttpClient.isRateLimited('test.com')).toBe(false);
        HttpClient.setRateLimit('test.com', 5000);
        expect(HttpClient.isRateLimited('test.com')).toBe(true);
    });

    it('should expire rate limits', () => {
        HttpClient.setRateLimit('test.com', 1000);
        expect(HttpClient.isRateLimited('test.com')).toBe(true);

        vi.advanceTimersByTime(1001);
        expect(HttpClient.isRateLimited('test.com')).toBe(false);
    });

    it('should report remaining rate limit time', () => {
        HttpClient.setRateLimit('test.com', 5000);
        expect(HttpClient.getRateLimitRemaining('test.com')).toBe(5000);

        vi.advanceTimersByTime(2000);
        expect(HttpClient.getRateLimitRemaining('test.com')).toBe(3000);
    });

    it('should return 0 for non-rate-limited domains', () => {
        expect(HttpClient.getRateLimitRemaining('unknown.com')).toBe(0);
    });

    it('should clear rate limits', () => {
        HttpClient.setRateLimit('test.com', 5000);
        HttpClient.clearRateLimit('test.com');
        expect(HttpClient.isRateLimited('test.com')).toBe(false);
    });
});
