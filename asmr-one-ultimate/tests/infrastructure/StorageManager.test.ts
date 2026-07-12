import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StorageManager } from '../../src/infrastructure/StorageManager';

// Mock AppStore
vi.mock('../../src/store/AppStore', () => ({
    AppStore: {
        getConfig: vi.fn(() => false),
        getAllConfig: vi.fn(() => ({
            enableLogging: false,
            debug: false,
            radioMode: true,
            cacheLimitGB: 5,
            translationApiKey: 'translation-secret',
            jpdbApiToken: 'jpdb-secret',
            vectorSearchApiKey: 'vector-secret',
            transcriptSyncApiKey: 'sync-secret',
        })),
    },
}));

describe('StorageManager', () => {
    beforeEach(() => {
        vi.mocked((globalThis as any).GM_setValue).mockClear();
        vi.mocked((globalThis as any).GM_getValue).mockClear();
        vi.mocked((globalThis as any).GM_deleteValue).mockClear();
        vi.mocked((globalThis as any).GM_listValues).mockClear();
    });

    describe('constructor', () => {
        it('should create with default limit', () => {
            const sm = new StorageManager();
            expect(sm).toBeDefined();
        });

        it('should create with custom limit', () => {
            const sm = new StorageManager(10);
            expect(sm).toBeDefined();
        });
    });

    describe('exportData', () => {
        it('should export config, cache and vectors', async () => {
            // Setup GM storage with some cache keys
            (globalThis as any).GM_listValues.mockReturnValue(['asmr-ult:cache1', 'other-key']);
            (globalThis as any).GM_getValue.mockImplementation((key: string) => {
                if (key === 'asmr-ult:cache1') return 'cached-value';
                return undefined;
            });

            const data = await StorageManager.exportData();

            expect(data.version).toBe(4);
            expect(data.config).toBeDefined();
            expect(data.config.translationApiKey).toBeUndefined();
            expect(data.config.jpdbApiToken).toBeUndefined();
            expect(data.config.vectorSearchApiKey).toBeUndefined();
            expect(data.config.transcriptSyncApiKey).toBeUndefined();
            expect(data.cache).toBeDefined();
            // Only asmr-ult: prefixed keys should be exported
            expect(data.cache['asmr-ult:cache1']).toBe('cached-value');
            expect(data.cache['other-key']).toBeUndefined();
        });

        it('should handle GM_listValues failure gracefully', async () => {
            (globalThis as any).GM_listValues.mockImplementation(() => {
                throw new Error('GM API unavailable');
            });

            const data = await StorageManager.exportData();
            expect(data.version).toBe(4);
            expect(data.cache).toEqual({});
        });
    });

    describe('importData', () => {
        it('should reject non-v4 backups', async () => {
            await expect(
                StorageManager.importData({ version: 3 as any, config: {}, cache: {}, vectors: [] })
            ).rejects.toThrow('Unsupported backup version: 3');
        });

        it('should import config values', async () => {
            const data = {
                version: 4 as const,
                config: {
                    enableLogging: true,
                    radioMode: false,
                },
                cache: {},
                vectors: [],
            };

            const count = await StorageManager.importData(data);
            expect(count).toBeGreaterThan(0);
        });

        it('should import cache values via GM_setValue', async () => {
            const data = {
                version: 4 as const,
                config: {},
                cache: {
                    'asmr-ult:test1': 'value1',
                    'asmr-ult:test2': 'value2',
                },
                vectors: [],
            };

            const count = await StorageManager.importData(data);
            expect((globalThis as any).GM_setValue).toHaveBeenCalledWith('asmr-ult:test1', 'value1');
            expect((globalThis as any).GM_setValue).toHaveBeenCalledWith('asmr-ult:test2', 'value2');
            expect(count).toBeGreaterThanOrEqual(2);
        });

        it('should handle missing cache gracefully', async () => {
            const data = {
                version: 4 as const,
                config: {},
                cache: undefined as any,
                vectors: [],
            };

            // Should not throw
            const count = await StorageManager.importData(data);
            expect(count).toBeGreaterThanOrEqual(0);
        });

        it('should handle empty vectors array', async () => {
            const data = {
                version: 4 as const,
                config: {},
                cache: {},
                vectors: [],
            };

            const count = await StorageManager.importData(data);
            expect(count).toBeGreaterThanOrEqual(0);
        });
    });
});
