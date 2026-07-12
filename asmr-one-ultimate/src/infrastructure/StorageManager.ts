import { openDB, DBSchema, deleteDB, IDBPDatabase } from 'idb';
import { Config, Logger } from '../core/Utils';
import { AppStore } from '../store/AppStore';
import { AudioCache } from './AudioCache';
import type { ConfigKey, PluginConfig, VectorEntry } from '../types';
import { omitSensitiveConfig } from '../core/configSecrets';

import { GM_listValues, GM_deleteValue, GM_getValue, GM_setValue } from '$';

/**
 * Backup format version 4 - Full Database Dump (excluding bloated AudioCache)
 */
interface BackupData {
    version: 4;
    config: Record<string, unknown>;
    cache: Record<string, any>; // GM_ values
    vectors: VectorEntry[];      // asmr-one-vectors IDB dump
}

/** All known IndexedDB databases used by the plugin */
const KNOWN_DATABASES = [
    'asmr-one-audio-cache', // Excluded from backup (blobs)
    'asmr-one-ultimate-db', // Legacy (migrated to GM)
    'asmr-one-vectors',     // Vector Search Index
    'asmr-one-work-cache',  // Work metadata cache (WorkService)
];

interface VectorDB extends DBSchema {
    vectors: {
        key: string;
        value: VectorEntry;
    };
}

export class StorageManager {
    private limit: number; // Bytes

    constructor(limitGB: number = Number(Config.get('cacheLimitGB') || 5)) {
        this.limit = limitGB * 1024 * 1024 * 1024;
    }

    public async enable(): Promise<void> {
        if (navigator.storage && navigator.storage.estimate) {
            const estimate = await navigator.storage.estimate();
            const usage = estimate.usage || 0;

            Logger.debug(`[StorageManager] Usage: ${(usage / 1024 / 1024).toFixed(2)} MB`);

            if (usage > this.limit) {
                Logger.warn('[StorageManager] Quota exceeded. Starting eviction...');
                await this.evict();
            }
        }
    }

    /**
     * Export full database (Config + GM Cache + Vectors)
     * Excludes AudioCache (Biohazard: large blobs)
     */
    public static async exportData(): Promise<BackupData> {
        Logger.log('[StorageManager] Starting data export...');
        // 1. Capture GM Cache
        const cache: Record<string, any> = {};
        try {
            const keys = GM_listValues();
            for (const key of keys) {
                // valuable cache data starts with asmr-ult:
                if (key.startsWith('asmr-ult:')) {
                    cache[key] = GM_getValue(key);
                }
            }
        } catch (e) {
            Logger.warn('[StorageManager] Failed to export cache keys', e);
        }

        // 2. Capture Vectors from IDB
        let vectors: VectorEntry[] = [];
        try {
            const db = await openDB<VectorDB>('asmr-one-vectors', 1);
            if (db.objectStoreNames.contains('vectors')) {
                vectors = await db.getAll('vectors');
            }
            db.close();
        } catch (e) {
            Logger.warn('[StorageManager] Failed to export vectors', e);
        }

        const exportData = {
            version: 4 as const,
            // API credentials remain in userscript storage. Downloadable JSON
            // backups are convenient to copy/share and must not contain them.
            config: omitSensitiveConfig(AppStore.getAllConfig() as unknown as Record<string, unknown>),
            cache,
            vectors
        };
        Logger.log('[StorageManager] Export complete:', {
            configKeys: Object.keys(exportData.config).length,
            cacheKeys: Object.keys(exportData.cache).length,
            vectorCount: exportData.vectors.length,
        });
        return exportData;
    }

    /**
     * Import full database.
     * ONLY supports Version 4 (Full DB).
     */
    public static async importData(data: BackupData): Promise<number> {
        Logger.log('[StorageManager] Starting data import...', {
            version: data.version,
            configKeys: Object.keys(data.config || {}).length,
            cacheKeys: Object.keys(data.cache || {}).length,
            vectorCount: data.vectors?.length || 0,
        });
        if (data.version !== 4) {
            throw new Error(`Unsupported backup version: ${data.version}. Only v4 is supported.`);
        }

        let imported = 0;

        // 1. Import Config
        const knownKeys = Object.keys(AppStore.getAllConfig());
        for (const key of knownKeys) {
            if (key in data.config) {
                Config.set(key as ConfigKey, data.config[key] as PluginConfig[ConfigKey]);
                imported++;
            }
        }

        // 2. Import GM Cache
        if (data.cache) {
            let cacheCount = 0;
            for (const [key, value] of Object.entries(data.cache)) {
                try {
                    GM_setValue(key, value);
                    cacheCount++;
                } catch (e) {
                    // ignore
                }
            }
            if (cacheCount > 0) {
                imported += cacheCount;
                Logger.log(`[StorageManager] Imported ${cacheCount} cache items`);
            }
        }

        // 3. Import Vectors (Nuke & Replace)
        if (data.vectors && Array.isArray(data.vectors)) {
            try {
                // Delete existing vector DB to avoid stale data mixing
                await deleteDB('asmr-one-vectors');

                const db = await openDB<VectorDB>('asmr-one-vectors', 1, {
                    upgrade(db) {
                        db.createObjectStore('vectors', { keyPath: 'id' });
                    }
                });

                const tx = db.transaction('vectors', 'readwrite');
                await Promise.all(data.vectors.map(v => tx.store.put(v)));
                await tx.done;

                imported += data.vectors.length;
                Logger.log(`[StorageManager] Imported ${data.vectors.length} vectors`);
                db.close();
            } catch (e) {
                Logger.error('[StorageManager] Failed to import vectors', e);
            }
        }

        return imported;
    }

    /**
     * Prompt the user to select a JSON backup file and restore settings from it.
     */
    public static restoreBackup(): Promise<number> {
        return new Promise((resolve, reject) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,application/json';
            input.addEventListener('change', async () => {
                const file = input.files?.[0];
                if (!file) { resolve(0); return; }
                try {
                    const text = await file.text();
                    const data = JSON.parse(text);
                    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
                        throw new Error('Invalid backup format: expected a JSON object');
                    }
                    if (data.version !== 4) {
                        alert('Error: This backup is not Version 4. Only full DB backups are supported in this version.');
                        resolve(0);
                        return;
                    }
                    const count = await StorageManager.importData(data as BackupData);
                    resolve(count);
                } catch (err) {
                    Logger.warn('[StorageManager] Failed to restore backup:', err);
                    alert('Restore Failed: ' + (err as Error).message);
                    reject(err);
                }
            });
            input.click();
        });
    }

    /**
     * Download current configuration as a JSON file.
     */
    public static async downloadBackup(): Promise<void> {
        const data = await StorageManager.exportData();

        // Build Blob from chunks to avoid V8 string length limit
        // when serializing large datasets (35k+ cache keys, 48k+ vectors)
        const chunks: BlobPart[] = [];
        chunks.push('{"version":4,"config":');
        chunks.push(JSON.stringify(data.config));
        chunks.push(',"cache":{');

        const cacheKeys = Object.keys(data.cache);
        for (let i = 0; i < cacheKeys.length; i++) {
            if (i > 0) chunks.push(',');
            chunks.push(JSON.stringify(cacheKeys[i]) + ':' + JSON.stringify(data.cache[cacheKeys[i]]));
        }

        chunks.push('},"vectors":[');

        for (let i = 0; i < data.vectors.length; i++) {
            if (i > 0) chunks.push(',');
            chunks.push(JSON.stringify(data.vectors[i]));
        }

        chunks.push(']}');

        const blob = new Blob(chunks, { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `asmr-ultimate-FULL-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    /**
     * Factory reset: delete all IndexedDB databases and clear all GM_* values.
     * Reloads the page after completion.
     */
    public static async nuke(): Promise<void> {
        Logger.log('[StorageManager] Factory reset initiated');

        // 1. Delete all known IndexedDB databases
        // deleteDB hangs if any connection is still open (AudioCache, VectorSearch, etc.)
        // — use a timeout so the rest of the reset (GM clear, reload) isn't blocked.
        const DB_DELETE_TIMEOUT_MS = 3000;
        const withTimeout = (promise: Promise<void>, ms: number): Promise<void> =>
            Promise.race([
                promise,
                new Promise<void>((_, reject) =>
                    setTimeout(() => reject(new Error(`deleteDB timed out after ${ms}ms (open connection?)`)), ms),
                ),
            ]);
        const dbResults = await Promise.allSettled(
            KNOWN_DATABASES.map(name => {
                Logger.log(`[StorageManager] Deleting IDB: ${name}`);
                return withTimeout(deleteDB(name), DB_DELETE_TIMEOUT_MS);
            })
        );
        for (let i = 0; i < dbResults.length; i++) {
            const r = dbResults[i];
            if (r.status === 'rejected') {
                Logger.warn(`[StorageManager] Failed to delete ${KNOWN_DATABASES[i]}:`, r.reason);
            }
        }

        // 2. Clear all GM_* storage values
        try {
            const keys = GM_listValues();
            for (const key of keys) {
                GM_deleteValue(key);
            }
            Logger.log(`[StorageManager] Cleared ${keys.length} GM values`);
        } catch {
            Logger.warn('[StorageManager] GM_listValues/GM_deleteValue not available, clearing localStorage fallback');
            // Fallback: clear GM_ prefixed localStorage entries (used in E2E/non-Tampermonkey)
            const toRemove: string[] = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key?.startsWith('GM_') || key?.startsWith('asmr-ult:')) {
                    toRemove.push(key);
                }
            }
            toRemove.forEach(k => localStorage.removeItem(k));
            Logger.log(`[StorageManager] Cleared ${toRemove.length} localStorage entries`);
        }

        // 3. Clear MLCrashGuard sentinels (localStorage)
        for (const key of ['__asmr_ml_guard_whisper', '__asmr_ml_guard_vectorSearch']) {
            localStorage.removeItem(key);
        }

        // 4. Clear object URLs
        AudioCache.objectUrls.forEach(url => URL.revokeObjectURL(url));
        AudioCache.objectUrls.clear();

        // 4. Clear Browser Cache API (Transformers.js model files)
        try {
            if (typeof caches !== 'undefined') {
                const names = await caches.keys();
                const modelCaches = names.filter(n =>
                    n.includes('transformers') || n.includes('onnx') || n.includes('huggingface'),
                );
                await Promise.allSettled(modelCaches.map(n => caches.delete(n)));
                Logger.log(`[StorageManager] Cleared ${modelCaches.length} Cache API entries`);
            }
        } catch {
            Logger.warn('[StorageManager] Cache API clear failed (non-critical)');
        }

        Logger.log('[StorageManager] Factory reset complete. Reloading...');
        window.location.reload();
    }

    private async evict(): Promise<void> {
        const db = await openDB<AudioCacheDB>('asmr-one-audio-cache', 1, {
            upgrade(upgradeDb) {
                if (!upgradeDb.objectStoreNames.contains('blobs')) {
                    const store = upgradeDb.createObjectStore('blobs', { keyPath: 'url' });
                    store.createIndex('by-lastPlayed', 'lastPlayed');
                }
            }
        });
        if (!db.objectStoreNames.contains('blobs')) return;

        // Calculate size FIRST, before opening the readwrite transaction.
        // Waiting for getTotalSize while a transaction is open caused it to time out/auto-commit.
        let total = await this.getTotalSize(db);
        const target = this.limit * 0.8;

        if (total <= target) return;

        const tx = db.transaction('blobs', 'readwrite');
        const index = tx.store.index('by-lastPlayed');
        let cursor = await index.openCursor(null, 'next'); // Oldest first

        while (cursor && total > target) {
            const entry = cursor.value;
            total -= entry.size || 0;
            Logger.debug('[StorageManager] Evicting:', entry.url);
            await cursor.delete();
            // Clean up blob URL
            AudioCache.releaseUrl(entry.url);
            cursor = await cursor.continue();
        }

        await tx.done;
    }

    private async getTotalSize(db: IDBPDatabase<AudioCacheDB>): Promise<number> {
        let total = 0;
        let cursor = await db.transaction('blobs').store.openCursor();
        while (cursor) {
            total += cursor.value.size || 0;
            cursor = await cursor.continue();
        }
        return total;
    }
}

interface AudioCacheDB extends DBSchema {
    blobs: {
        key: string;
        value: {
            url: string;
            blob: Blob;
            lastPlayed: number;
            size: number;
        };
        indexes: { 'by-lastPlayed': number };
    };
}
