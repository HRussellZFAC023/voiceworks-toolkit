/**
 * MLCrashGuard — Detects repeated ML feature crashes and auto-disables them.
 *
 * Uses localStorage sentinels: a timestamp is written before an ML worker
 * initializes and cleared on success. If the page crashes/reloads before
 * clearing, the sentinel persists. After CRASH_THRESHOLD stale sentinels
 * within CRASH_WINDOW_MS, the feature is auto-disabled to break the crash loop.
 */

import { Config } from './Utils';
import { Logger } from './Logger';

const STORAGE_PREFIX = '__asmr_ml_guard_';
const CRASH_THRESHOLD = 3;           // crashes before auto-disable
const CRASH_WINDOW_MS = 5 * 60_000;  // 5 minute window

type MLFeature = 'whisper' | 'vectorSearch';

function storageKey(feature: MLFeature): string {
    return `${STORAGE_PREFIX}${feature}`;
}

function getCrashLog(feature: MLFeature): number[] {
    try {
        return JSON.parse(localStorage.getItem(storageKey(feature)) || '[]');
    } catch {
        return [];
    }
}

function setCrashLog(feature: MLFeature, log: number[]): void {
    try {
        localStorage.setItem(storageKey(feature), JSON.stringify(log));
    } catch { /* quota / private mode */ }
}

function configKeyFor(feature: MLFeature): 'enableWhisper' | 'enableVectorSearch' {
    return feature === 'whisper' ? 'enableWhisper' : 'enableVectorSearch';
}

export const MLCrashGuard = {
    /**
     * Called at startup. Checks for stale sentinels (= previous crash during init).
     * If the crash count exceeds the threshold, auto-disables the feature.
     */
    checkAndDisable(): void {
        for (const feature of ['whisper', 'vectorSearch'] as MLFeature[]) {
            const configKey = configKeyFor(feature);
            if (!Config.get(configKey)) continue; // already disabled, nothing to guard

            const log = getCrashLog(feature);
            const now = Date.now();

            // Count recent stale sentinels (negative values = uncleared init timestamps)
            const recentCrashes = log.filter(t => t < 0 && (now - Math.abs(t)) < CRASH_WINDOW_MS);

            if (recentCrashes.length >= CRASH_THRESHOLD) {
                Config.set(configKey, false);
                Logger.warn(`[MLCrashGuard] Auto-disabled ${feature} after ${recentCrashes.length} crashes in ${Math.round(CRASH_WINDOW_MS / 60_000)} min`);
                // Clear the log so re-enabling is a clean slate
                setCrashLog(feature, []);
            }
        }
    },

    /**
     * Call before an ML worker starts initializing.
     * Writes a negative timestamp (sentinel). If the page crashes before
     * initComplete() clears it, it counts as a crash on next startup.
     */
    initStarted(feature: MLFeature): void {
        const log = getCrashLog(feature);
        const now = Date.now();

        // Prune old entries outside the window
        const recent = log.filter(t => (now - Math.abs(t)) < CRASH_WINDOW_MS);
        recent.push(-now); // negative = uncleared sentinel
        setCrashLog(feature, recent);
    },

    /**
     * Call after an ML worker successfully initializes.
     * Converts the most recent sentinel to a positive (= success) timestamp.
     */
    initComplete(feature: MLFeature): void {
        const log = getCrashLog(feature);
        // Find the most recent negative entry and flip it positive
        for (let i = log.length - 1; i >= 0; i--) {
            if (log[i] < 0) {
                log[i] = Math.abs(log[i]);
                break;
            }
        }
        setCrashLog(feature, log);
    },

    /**
     * Call if an ML worker fails to initialize (caught error, not a hard crash).
     * The sentinel stays negative (counts as crash), no action needed.
     * This method exists for clarity / future use.
     */
    initFailed(_feature: MLFeature): void {
        // Sentinel is already negative from initStarted() — it stays as-is
    },

    /** Reset crash history for a feature (e.g., when user manually re-enables) */
    reset(feature: MLFeature): void {
        setCrashLog(feature, []);
    },
};
