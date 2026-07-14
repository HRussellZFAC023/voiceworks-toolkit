import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { SemanticIndexState, SemanticVectorEntry } from './vectorSearchIndexTypes';
import { isPostBaselineRelease } from './vectorSearchDeltaPolicy';

type StoredVectorEntry = Omit<SemanticVectorEntry, 'vector'> & { vector: ArrayBuffer | Float32Array | number[] };

interface StoredBaselineEntry extends StoredVectorEntry {
    datasetId: string;
}

interface SemanticIndexDatabase extends DBSchema {
    baseline: {
        key: [string, string];
        value: StoredBaselineEntry;
        indexes: { 'by-dataset': string };
    };
    delta: {
        key: string;
        value: StoredVectorEntry;
    };
    meta: {
        key: string;
        value: SemanticIndexState;
    };
}

const DATABASE_NAME = 'asmr-one-vectors-v2';
const DATABASE_VERSION = 2;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function storeEntry(entry: SemanticVectorEntry): StoredVectorEntry {
    const vector = entry.vector instanceof Float32Array ? entry.vector : Float32Array.from(entry.vector);
    const stored = new Float32Array(vector.length);
    stored.set(vector);
    return { ...entry, vector: stored.buffer };
}

function loadEntry(entry: StoredVectorEntry): SemanticVectorEntry {
    const vector = entry.vector instanceof ArrayBuffer
        ? new Float32Array(entry.vector)
        : entry.vector instanceof Float32Array ? entry.vector : Float32Array.from(entry.vector);
    return { ...entry, vector };
}

export class VectorSearchRepository {
    private database?: Promise<IDBPDatabase<SemanticIndexDatabase>>;

    constructor(private readonly databaseName = DATABASE_NAME) {}

    async getState(): Promise<SemanticIndexState> {
        return await (await this.getDatabase()).get('meta', 'state') ?? { key: 'state' };
    }

    async updateState(update: Partial<Omit<SemanticIndexState, 'key'>>): Promise<SemanticIndexState> {
        const db = await this.getDatabase();
        const transaction = db.transaction('meta', 'readwrite');
        const current = await transaction.store.get('state') ?? { key: 'state' as const };
        const next: SemanticIndexState = { ...current, ...update, key: 'state' };
        await transaction.store.put(next);
        await transaction.done;
        return next;
    }

    async prepareDataset(datasetId: string): Promise<void> {
        const active = (await this.getState()).activeDatasetId;
        if (datasetId === active) return;
        await this.removeDataset(datasetId);
    }

    async putBaselineBatch(datasetId: string, entries: readonly SemanticVectorEntry[]): Promise<void> {
        const db = await this.getDatabase();
        const transaction = db.transaction('baseline', 'readwrite');
        await Promise.all(entries.map((entry) => transaction.store.put({ ...storeEntry(entry), datasetId })));
        await transaction.done;
    }

    async countDataset(datasetId: string): Promise<number> {
        return (await this.getDatabase()).countFromIndex('baseline', 'by-dataset', datasetId);
    }

    async activateDataset(
        datasetId: string,
        expectedCount: number,
        compatibilityFingerprint: string,
        manifestEtag?: string,
        manifestSha256?: string,
    ): Promise<void> {
        const db = await this.getDatabase();
        const transaction = db.transaction(['baseline', 'delta', 'meta'], 'readwrite');
        const count = await transaction.objectStore('baseline').index('by-dataset').count(datasetId);
        if (count !== expectedCount) {
            transaction.abort();
            await transaction.done.catch(() => undefined);
            throw new Error(`Baseline count mismatch: imported ${count}, expected ${expectedCount}`);
        }
        const meta = transaction.objectStore('meta');
        const current = await meta.get('state') ?? { key: 'state' as const };
        // Legacy fallback mode may have locally indexed historical works. Remove
        // them in the same transaction that activates the complete baseline.
        const delta = transaction.objectStore('delta');
        let deltaCursor = await delta.openCursor();
        while (deltaCursor) {
            if (!isPostBaselineRelease(deltaCursor.value.release)) await deltaCursor.delete();
            deltaCursor = await deltaCursor.continue();
        }
        await meta.put({
            ...current,
            key: 'state',
            activeDatasetId: datasetId,
            expectedBaselineCount: expectedCount,
            activeManifestSha256: manifestSha256,
            compatibilityFingerprint,
            manifestEtag: manifestEtag ?? current.manifestEtag,
            lastCheckedAt: Date.now(),
        });
        await transaction.done;
    }

    async removeDataset(datasetId: string): Promise<void> {
        const db = await this.getDatabase();
        const transaction = db.transaction(['baseline', 'meta'], 'readwrite');
        const state = await transaction.objectStore('meta').get('state');
        if (state?.activeDatasetId === datasetId) {
            await transaction.done;
            return;
        }
        const baseline = transaction.objectStore('baseline');
        let cursor = await baseline.index('by-dataset').openCursor(IDBKeyRange.only(datasetId));
        while (cursor) {
            await cursor.delete();
            cursor = await cursor.continue();
        }
        await transaction.done;
    }

    async cleanupInactiveDatasets(): Promise<void> {
        const active = (await this.getState()).activeDatasetId;
        if (!active) return;
        const db = await this.getDatabase();
        const keys = await db.getAllKeys('baseline');
        const stale = new Set(keys.map(([datasetId]) => datasetId).filter((datasetId) => datasetId !== active));
        for (const datasetId of stale) await this.removeDataset(datasetId);
    }

    async getDelta(id: string): Promise<SemanticVectorEntry | undefined> {
        const entry = await (await this.getDatabase()).get('delta', id);
        return entry ? loadEntry(entry) : undefined;
    }

    async putDelta(entry: SemanticVectorEntry): Promise<boolean> {
        const db = await this.getDatabase();
        const transaction = db.transaction(['delta', 'meta'], 'readwrite');
        const state = await transaction.objectStore('meta').get('state');
        if (state?.activeDatasetId && !isPostBaselineRelease(entry.release)) {
            await transaction.done;
            return false;
        }
        await transaction.objectStore('delta').put(storeEntry(entry));
        await transaction.done;
        return true;
    }

    async clearDelta(): Promise<void> {
        await (await this.getDatabase()).clear('delta');
    }

    async getMergedEntries(fallback: readonly SemanticVectorEntry[] = []): Promise<SemanticVectorEntry[]> {
        const db = await this.getDatabase();
        const active = (await this.getState()).activeDatasetId;
        const baseline: SemanticVectorEntry[] = active
            ? (await db.getAllFromIndex('baseline', 'by-dataset', active)).map(({ datasetId: _datasetId, ...entry }) => loadEntry(entry))
            : [...fallback];
        const merged = new Map(baseline.map((entry) => [entry.id, entry]));
        for (const entry of await db.getAll('delta')) merged.set(entry.id, loadEntry(entry));
        return [...merged.values()];
    }

    async hasUsableActiveBaseline(): Promise<boolean> {
        const state = await this.getState();
        return !!state.activeDatasetId
            && Number.isSafeInteger(state.expectedBaselineCount)
            && (state.expectedBaselineCount ?? 0) > 0
            && typeof state.activeManifestSha256 === 'string'
            && SHA256_PATTERN.test(state.activeManifestSha256)
            && await this.countDataset(state.activeDatasetId) === state.expectedBaselineCount;
    }

    async countMerged(fallback: readonly SemanticVectorEntry[] = []): Promise<number> {
        const db = await this.getDatabase();
        const active = (await this.getState()).activeDatasetId;
        const transaction = db.transaction(['baseline', 'delta'], 'readonly');
        const deltaKeys = await transaction.objectStore('delta').getAllKeys();
        if (!active) {
            await transaction.done;
            const ids = new Set(fallback.map((entry) => entry.id));
            for (const id of deltaKeys) ids.add(id);
            return ids.size;
        }
        const baseline = transaction.objectStore('baseline');
        const baselineCount = await baseline.index('by-dataset').count(active);
        const overlap = (await Promise.all(deltaKeys.map((id) => baseline.getKey([active, id]))))
            .filter((key) => key !== undefined).length;
        await transaction.done;
        return baselineCount + deltaKeys.length - overlap;
    }

    async close(): Promise<void> {
        if (!this.database) return;
        (await this.database).close();
        this.database = undefined;
    }

    private getDatabase(): Promise<IDBPDatabase<SemanticIndexDatabase>> {
        this.database ??= openDB<SemanticIndexDatabase>(this.databaseName, DATABASE_VERSION, {
            upgrade(db, oldVersion) {
                if (oldVersion >= 1) return;
                const baseline = db.createObjectStore('baseline', { keyPath: ['datasetId', 'id'] });
                baseline.createIndex('by-dataset', 'datasetId');
                db.createObjectStore('delta', { keyPath: 'id' });
                db.createObjectStore('meta', { keyPath: 'key' });
            },
        });
        return this.database;
    }
}
