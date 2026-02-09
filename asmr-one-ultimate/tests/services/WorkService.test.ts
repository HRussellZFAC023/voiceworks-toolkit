import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkServiceImpl } from '../../src/services/WorkService';

// Mock HttpClient to prevent real network calls
vi.mock('../../src/infrastructure/HttpClient', () => ({
    HttpClient: {
        getJsonViaCors: vi.fn().mockRejectedValue(new Error('network mock')),
        isRateLimited: vi.fn().mockReturnValue(false),
        setRateLimit: vi.fn(),
    },
}));

// Hoisted mock for KikoeruBridge so we can control per-test
const { mockGetInstance } = vi.hoisted(() => ({
    mockGetInstance: vi.fn(() => ({
        axios: { defaults: { baseURL: 'https://api.asmr-200.com' } },
    })),
}));

vi.mock('../../src/infrastructure/KikoeruBridge', () => ({
    KikoeruBridge: {
        getInstance: mockGetInstance,
    },
}));

describe('WorkService', () => {
    let svc: WorkServiceImpl;

    beforeEach(() => {
        mockGetInstance.mockReturnValue({
            axios: { defaults: { baseURL: 'https://api.asmr-200.com' } },
        });
        svc = new WorkServiceImpl();
    });

    // ==========================================================================
    // isFresh — private but critical for cache correctness
    // ==========================================================================
    describe('isFresh', () => {
        it('should return true for recent timestamp', () => {
            const now = Date.now();
            expect((svc as any).isFresh(now - 1000, 60_000)).toBe(true);
        });

        it('should return false for expired timestamp', () => {
            const now = Date.now();
            expect((svc as any).isFresh(now - 120_000, 60_000)).toBe(false);
        });

        it('should return true for exact boundary (just under TTL)', () => {
            const ttl = 10_000;
            const timestamp = Date.now() - (ttl - 1);
            expect((svc as any).isFresh(timestamp, ttl)).toBe(true);
        });

        it('should return false for exact TTL expiry', () => {
            const ttl = 10_000;
            const timestamp = Date.now() - ttl;
            expect((svc as any).isFresh(timestamp, ttl)).toBe(false);
        });

        it('should handle zero TTL (always stale)', () => {
            expect((svc as any).isFresh(Date.now(), 0)).toBe(false);
        });
    });

    // ==========================================================================
    // ID parsing — only test validation (reject invalid IDs).
    // Avoid tests that pass validation but fire async network calls that
    // produce unhandled rejections.
    // ==========================================================================
    describe('getWork ID parsing', () => {
        it('should throw for completely invalid ID', async () => {
            await expect(svc.getWork('invalid')).rejects.toThrow('Invalid work ID');
        });

        it('should throw for empty string', async () => {
            await expect(svc.getWork('')).rejects.toThrow('Invalid work ID');
        });

        it('should throw for zero', async () => {
            await expect(svc.getWork(0)).rejects.toThrow('Invalid work ID');
        });

        it('should throw for NaN-producing string', async () => {
            await expect(svc.getWork('abc')).rejects.toThrow('Invalid work ID');
        });
    });

    describe('getWorkInfo ID parsing', () => {
        it('should throw for invalid ID', async () => {
            await expect(svc.getWorkInfo('invalid')).rejects.toThrow('Invalid work ID');
        });

        it('should throw for empty ID', async () => {
            await expect(svc.getWorkInfo('')).rejects.toThrow('Invalid work ID');
        });
    });

    describe('getTracks ID parsing', () => {
        it('should throw for invalid ID', async () => {
            await expect(svc.getTracks('invalid')).rejects.toThrow('Invalid work ID');
        });

        it('should throw for empty ID', async () => {
            await expect(svc.getTracks('')).rejects.toThrow('Invalid work ID');
        });
    });

    // ==========================================================================
    // ID stripping logic — test the pattern directly (no async fetch)
    // ==========================================================================
    describe('ID prefix stripping', () => {
        it('should strip RJ prefix to get numeric part', () => {
            const stripped = String('RJ123456').replace(/^[A-Za-z]+/, '');
            expect(Number(stripped)).toBe(123456);
        });

        it('should strip lowercase prefix', () => {
            const stripped = String('rj123456').replace(/^[A-Za-z]+/, '');
            expect(Number(stripped)).toBe(123456);
        });

        it('should strip VJ prefix', () => {
            const stripped = String('VJ789012').replace(/^[A-Za-z]+/, '');
            expect(Number(stripped)).toBe(789012);
        });

        it('should strip BJ prefix', () => {
            const stripped = String('BJ00001').replace(/^[A-Za-z]+/, '');
            expect(Number(stripped)).toBe(1);
        });

        it('should handle numeric-only input', () => {
            const stripped = String('654321').replace(/^[A-Za-z]+/, '');
            expect(Number(stripped)).toBe(654321);
        });

        it('should return 0 (falsy) for all-alpha input', () => {
            // 'invalid' → strip all leading alpha → '' → Number('') = 0
            // The real code uses `if (!workId)` which catches both 0 and NaN
            const stripped = String('invalid').replace(/^[A-Za-z]+/, '');
            expect(Number(stripped)).toBe(0);
            expect(!Number(stripped)).toBe(true); // falsy, so getWork rejects
        });
    });

    // ==========================================================================
    // getApiBaseUrl — private but important for URL construction
    // ==========================================================================
    describe('getApiBaseUrl', () => {
        it('should return base URL from bridge axios', () => {
            const url = (svc as any).getApiBaseUrl();
            expect(url).toBe('https://api.asmr-200.com');
        });

        it('should strip trailing slash', () => {
            mockGetInstance.mockReturnValueOnce({
                axios: { defaults: { baseURL: 'https://example.com/' } },
            });
            const url = (svc as any).getApiBaseUrl();
            expect(url).toBe('https://example.com');
        });

        it('should return default API URL when bridge throws', () => {
            mockGetInstance.mockImplementationOnce(() => { throw new Error('No bridge'); });
            const url = (svc as any).getApiBaseUrl();
            expect(url).toBe('https://api.asmr-200.com');
        });

        it('should return default when baseURL is not http', () => {
            mockGetInstance.mockReturnValueOnce({
                axios: { defaults: { baseURL: undefined } },
            } as any);
            const url = (svc as any).getApiBaseUrl();
            expect(url).toBe('https://api.asmr-200.com');
        });

        it('should return default when baseURL is empty string', () => {
            mockGetInstance.mockReturnValueOnce({
                axios: { defaults: { baseURL: '' } },
            });
            const url = (svc as any).getApiBaseUrl();
            expect(url).toBe('https://api.asmr-200.com');
        });
    });
});
