import { AppStore } from '../store/AppStore';

const LOG_PREFIX = '[ASMR Ultimate]';
const LOG_STYLE = 'background: #7c4dff; color: white; border-radius: 3px; padding: 2px 4px; font-weight: bold;';
const DEBUG_STYLE = 'color: #aaa;';

interface CallStats {
    count: number;
    firstCall: number;
    lastCall: number;
    recentCalls: number[]; // timestamps of last 100 calls
}

interface LogEntry {
    timestamp: number;
    level: string;
    message: string;
    args: unknown[];
    stack?: string;
}

class LoggerImpl {
    prefix = LOG_PREFIX;

    private callStats = new Map<string, CallStats>();
    private logBuffer: LogEntry[] = [];
    private maxBufferSize = 1000;
    private loopDetectionThreshold = 50; // calls within 1 second triggers warning
    private loopDetectionWindow = 1000; // 1 second window

    log(message: string, ...args: unknown[]): void {
        this.logAt('log', console.log, message, args);
    }

    info(message: string, ...args: unknown[]): void {
        this.logAt('info', console.info, message, args);
    }

    warn(message: string, ...args: unknown[]): void {
        this.logAt('warn', console.warn, message, args);
    }

    error(message: string, ...args: unknown[]): void {
        this.logAt('error', console.error, message, args, '', true);
    }

    debug(message: string, ...args: unknown[]): void {
        if (!AppStore.getConfig('debug')) return;
        this.logAt('debug', console.debug, message, args, `[DEBUG] `, false, DEBUG_STYLE);
    }

    /**
     * Trace log with stack trace - useful for tracking call origins
     */
    trace(message: string, ...args: unknown[]): void {
        if (!AppStore.getConfig('enableLogging')) return;
        const stack = new Error().stack?.split('\n').slice(2).join('\n');
        console.log(`%c${LOG_PREFIX}%c [TRACE] ${message}`, LOG_STYLE, 'color: #888;', ...args);
        this.dirObjects(args);
        console.log('%c' + stack, 'color: #666; font-size: 10px;');
        this.bufferLog('trace', message, args, true);
    }

    /**
     * Log an object with full deep inspection via console.dir.
     * Useful for complex nested objects that console.log collapses.
     */
    dir(label: string, obj: unknown): void {
        if (!AppStore.getConfig('enableLogging')) return;
        console.log(`%c${LOG_PREFIX}%c ${label} ▼`, LOG_STYLE, 'font-weight: bold;');
        console.dir(obj);
        this.bufferLog('dir', label, [obj]);
    }

    /**
     * Log tabular data (arrays of objects) in a readable table format.
     */
    table(label: string, data: unknown[] | Record<string, unknown>): void {
        if (!AppStore.getConfig('enableLogging')) return;
        console.log(`%c${LOG_PREFIX}%c ${label} ▼`, LOG_STYLE, 'font-weight: bold;');
        console.table(data);
        this.bufferLog('table', label, [data]);
    }

    /**
     * Performance timing
     */
    time(label: string): void {
        if (!AppStore.getConfig('enableLogging')) return;
        console.time(`${LOG_PREFIX} ${label}`);
    }

    timeEnd(label: string): void {
        if (!AppStore.getConfig('enableLogging')) return;
        console.timeEnd(`${LOG_PREFIX} ${label}`);
    }

    group(label: string): void {
        if (!AppStore.getConfig('enableLogging')) return;
        console.group(`%c${LOG_PREFIX}%c ${label}`, LOG_STYLE, '');
    }

    groupCollapsed(label: string): void {
        if (!AppStore.getConfig('enableLogging')) return;
        console.groupCollapsed(`%c${LOG_PREFIX}%c ${label}`, LOG_STYLE, '');
    }

    groupEnd(): void {
        if (!AppStore.getConfig('enableLogging')) return;
        console.groupEnd();
    }

    /**
     * Core logging method - all level-specific methods delegate here.
     */
    private logAt(
        level: string,
        consoleFn: (...a: unknown[]) => void,
        message: string,
        args: unknown[],
        prefix = '',
        includeStack = false,
        resetStyle = '',
    ): void {
        if (!AppStore.getConfig('enableLogging')) return;
        this.trackCall(level, message);
        consoleFn(`%c${LOG_PREFIX}%c ${prefix}${message}`, LOG_STYLE, resetStyle, ...args);
        this.dirObjects(args);
        this.bufferLog(level, message, args, includeStack);
    }

    /**
     * Expand any non-primitive args via console.dir for deep inspection.
     * Only outputs for objects/arrays that would otherwise be collapsed.
     */
    private dirObjects(args: unknown[]): void {
        for (const arg of args) {
            if (arg !== null && arg !== undefined && typeof arg === 'object') {
                try {
                    console.dir(arg);
                } catch {
                    // Ignore if console.dir is not available (e.g. test env)
                }
            }
        }
    }

    /**
     * Track function calls to detect potential infinite loops
     */
    private trackCall(level: string, message: string): void {
        const key = `${level}:${message}`;
        const now = Date.now();

        let stats = this.callStats.get(key);
        if (!stats) {
            stats = {
                count: 0,
                firstCall: now,
                lastCall: now,
                recentCalls: [],
            };
            this.callStats.set(key, stats);
        }

        stats.count++;
        stats.lastCall = now;
        stats.recentCalls.push(now);

        // Keep only recent calls within window
        const windowStart = now - this.loopDetectionWindow;
        stats.recentCalls = stats.recentCalls.filter(t => t >= windowStart);

        // Detect potential infinite loop
        if (stats.recentCalls.length >= this.loopDetectionThreshold) {
            const rate = stats.recentCalls.length / (this.loopDetectionWindow / 1000);
            console.warn(
                `%c${LOG_PREFIX}%c [LOOP DETECTED] "${message}" called ${stats.recentCalls.length} times in ${this.loopDetectionWindow}ms (${rate.toFixed(1)}/sec)`,
                LOG_STYLE,
                'color: red; font-weight: bold;'
            );
            console.trace('Call stack:');

            // Reset to avoid spam
            stats.recentCalls = [];
        }
    }

    /**
     * Buffer logs for later retrieval
     */
    private bufferLog(level: string, message: string, args: unknown[], includeStack = false): void {
        const entry: LogEntry = {
            timestamp: Date.now(),
            level,
            message,
            args: args.map(a => {
                try {
                    return JSON.parse(JSON.stringify(a));
                } catch {
                    return String(a);
                }
            }),
        };

        if (includeStack) {
            entry.stack = new Error().stack;
        }

        this.logBuffer.push(entry);

        // Trim buffer
        if (this.logBuffer.length > this.maxBufferSize) {
            this.logBuffer = this.logBuffer.slice(-this.maxBufferSize);
        }
    }

    /**
     * Get call statistics for debugging
     */
    getStats(): Record<string, CallStats> {
        const result: Record<string, CallStats> = {};
        this.callStats.forEach((v, k) => {
            result[k] = { ...v };
        });
        return result;
    }

    /**
     * Get recent logs
     */
    getLogs(count = 100): LogEntry[] {
        return this.logBuffer.slice(-count);
    }

    /**
     * Get high-frequency calls (potential loops)
     */
    getHighFrequencyCalls(threshold = 10): Array<{ key: string; stats: CallStats }> {
        const results: Array<{ key: string; stats: CallStats }> = [];
        const now = Date.now();
        const window = this.loopDetectionWindow;

        this.callStats.forEach((stats, key) => {
            const recentCount = stats.recentCalls.filter(t => t >= now - window).length;
            if (recentCount >= threshold) {
                results.push({ key, stats: { ...stats } });
            }
        });

        return results.sort((a, b) => b.stats.recentCalls.length - a.stats.recentCalls.length);
    }

    /**
     * Reset all statistics
     */
    resetStats(): void {
        this.callStats.clear();
        this.logBuffer = [];
    }

    /**
     * Dump diagnostic info to console
     */
    dumpDiagnostics(): void {
        console.group(`%c${LOG_PREFIX}%c Diagnostics Dump`, LOG_STYLE, 'font-weight: bold;');

        console.log('Call Statistics:');
        const stats = this.getStats();
        const sortedStats = Object.entries(stats)
            .sort(([, a], [, b]) => b.count - a.count)
            .slice(0, 20);
        console.table(sortedStats.map(([key, s]) => ({
            key,
            totalCalls: s.count,
            recentCalls: s.recentCalls.length,
            elapsed: `${((s.lastCall - s.firstCall) / 1000).toFixed(1)}s`,
        })));

        console.log('High Frequency Calls:');
        const highFreq = this.getHighFrequencyCalls(5);
        if (highFreq.length > 0) {
            console.table(highFreq.map(({ key, stats: s }) => ({
                key,
                callsInLastSecond: s.recentCalls.length,
                totalCalls: s.count,
            })));
        } else {
            console.log('No high-frequency calls detected');
        }

        console.log('Recent Logs (last 20):');
        console.table(this.getLogs(20).map(l => ({
            time: new Date(l.timestamp).toISOString().slice(11, 23),
            level: l.level,
            message: l.message.slice(0, 50),
        })));

        console.groupEnd();
    }
}

export const Logger = new LoggerImpl();

// Expose to global for debugging
if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__ASMR_LOGGER__ = Logger;
}
