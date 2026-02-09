import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AppStore } from '../../src/store/AppStore';
import { Logger } from '../../src/core/Logger';
describe('Logger', () => {
    let getConfigSpy: any;

    beforeEach(() => {
        // Spy on AppStore.getConfig to enable logging in tests
        getConfigSpy = vi.spyOn(AppStore, 'getConfig').mockImplementation((key: any) => {
            if (key === 'enableLogging') return true as any;
            if (key === 'debug') return true as any;
            return false as any;
        });

        // Reset stats between tests
        Logger.resetStats();

        // Reset console mocks (setup.ts already mocks them)
        vi.mocked(console.log).mockClear();
        vi.mocked(console.warn).mockClear();
        vi.mocked(console.error).mockClear();
    });

    afterEach(() => {
        getConfigSpy.mockRestore();
        vi.useRealTimers();
    });

    describe('log levels', () => {
        it('should call console.log for log()', () => {
            Logger.log('test message');
            expect(console.log).toHaveBeenCalled();
        });

        it('should call console.warn for warn()', () => {
            Logger.warn('warning message');
            expect(console.warn).toHaveBeenCalled();
        });

        it('should call console.error for error()', () => {
            Logger.error('error message');
            expect(console.error).toHaveBeenCalled();
        });

        it('should not log when enableLogging is false', () => {
            getConfigSpy.mockReturnValue(false as any);
            Logger.log('suppressed');
            expect(console.log).not.toHaveBeenCalled();
        });
    });

    describe('call statistics', () => {
        it('should track call counts', () => {
            Logger.log('test');
            Logger.log('test');
            Logger.log('test');

            const stats = Logger.getStats();
            expect(stats['log:test']?.count).toBe(3);
        });

        it('should track different messages separately', () => {
            Logger.log('msg1');
            Logger.log('msg2');
            Logger.log('msg1');

            const stats = Logger.getStats();
            expect(stats['log:msg1']?.count).toBe(2);
            expect(stats['log:msg2']?.count).toBe(1);
        });

        it('should track first and last call timestamps', () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));

            Logger.log('timed');
            const firstCall = Date.now();

            vi.advanceTimersByTime(1000);
            Logger.log('timed');
            const lastCall = Date.now();

            const stats = Logger.getStats();
            expect(stats['log:timed']?.firstCall).toBe(firstCall);
            expect(stats['log:timed']?.lastCall).toBe(lastCall);
        });

        it('should reset stats on resetStats()', () => {
            Logger.log('test');
            expect(Object.keys(Logger.getStats()).length).toBeGreaterThan(0);

            Logger.resetStats();
            expect(Object.keys(Logger.getStats()).length).toBe(0);
        });
    });

    describe('log buffer', () => {
        it('should buffer recent logs', () => {
            Logger.log('buffered1');
            Logger.log('buffered2');

            const logs = Logger.getLogs(10);
            expect(logs.length).toBeGreaterThanOrEqual(2);
            expect(logs.some(l => l.message === 'buffered1')).toBe(true);
            expect(logs.some(l => l.message === 'buffered2')).toBe(true);
        });

        it('should limit returned logs to count parameter', () => {
            for (let i = 0; i < 20; i++) {
                Logger.log(`msg${i}`);
            }
            const logs = Logger.getLogs(5);
            expect(logs.length).toBe(5);
        });

        it('should clear buffer on resetStats()', () => {
            Logger.log('test');
            Logger.resetStats();
            expect(Logger.getLogs().length).toBe(0);
        });

        it('should serialize args safely (circular refs become strings)', () => {
            const circular: any = { a: 1 };
            circular.self = circular;
            Logger.log('circular', circular);

            const logs = Logger.getLogs(1);
            expect(logs.length).toBe(1);
            expect(logs[0].args[0]).toBeDefined();
        });
    });

    describe('high frequency detection', () => {
        it('should detect high frequency calls', () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));

            // Fire many calls within the 1-second window (threshold is 50)
            for (let i = 0; i < 60; i++) {
                Logger.log('spam');
            }

            // Should have triggered the loop detection warning
            expect(console.warn).toHaveBeenCalled();
        });

        it('getHighFrequencyCalls should return frequent callers', () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));

            for (let i = 0; i < 15; i++) {
                Logger.log('frequent');
            }

            const highFreq = Logger.getHighFrequencyCalls(10);
            expect(highFreq.length).toBeGreaterThanOrEqual(1);
        });
    });

    describe('debug mode', () => {
        it('should log debug when debug config is true', () => {
            Logger.debug('debug message');
            // Verify it was tracked in stats (means it didn't early-return)
            const stats = Logger.getStats();
            expect(stats['debug:debug message']?.count).toBe(1);
        });

        it('should not log debug when debug config is false', () => {
            getConfigSpy.mockImplementation((key: any) => {
                if (key === 'debug') return false as any;
                if (key === 'enableLogging') return true as any;
                return false as any;
            });
            Logger.debug('suppressed debug');
            const stats = Logger.getStats();
            expect(stats['debug:suppressed debug']).toBeUndefined();
        });
    });

    describe('prefix', () => {
        it('should have the correct prefix', () => {
            expect(Logger.prefix).toBe('[ASMR Ultimate]');
        });
    });
});
