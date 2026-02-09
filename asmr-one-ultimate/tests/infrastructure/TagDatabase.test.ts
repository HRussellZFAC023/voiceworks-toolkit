import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDB, deleteDB } from 'idb';
import { TagDatabase } from '../../src/infrastructure/TagDatabase';

const DB_NAME = 'asmr-one-ultimate-db';
const GM_KEY_TAGS = 'asmr-ult:tagdb:tags';
const GM_KEY_ENTITIES = 'asmr-ult:tagdb:entities';
const GM_KEY_MIGRATED = 'asmr-ult:tagdb:migrated';

const defaultGetImpl = (globalThis as any).GM_getValue.getMockImplementation();
const defaultSetImpl = (globalThis as any).GM_setValue.getMockImplementation();

async function resetMigrationDb(): Promise<void> {
    try {
        await deleteDB(DB_NAME);
    } catch {
        // ignore if missing
    }
}

describe('TagDatabase', () => {
    beforeEach(async () => {
        (globalThis as any).GM_getValue.mockImplementation(defaultGetImpl);
        (globalThis as any).GM_setValue.mockImplementation(defaultSetImpl);
        await resetMigrationDb();
    });

    afterEach(async () => {
        await resetMigrationDb();
    });

    describe('constructor / hydration', () => {
        it('creates an empty database', () => {
            const db = new TagDatabase();
            expect(db).toBeDefined();
        });

        it('hydrates from existing GM storage and normalizes values', async () => {
            (globalThis as any).GM_getValue.mockImplementation((key: string, def: unknown) => {
                if (key === GM_KEY_TAGS) {
                    return JSON.stringify([
                        { id: 1, name: ' tag-one ', en: ' Tag One ' },
                        { id: Number.NaN, name: 'invalid' },
                    ]);
                }
                if (key === GM_KEY_ENTITIES) {
                    return JSON.stringify({ ' circle-a ': ' Circle A ', '': 'bad' });
                }
                return def;
            });

            const db = new TagDatabase();
            await expect(db.getTag(1)).resolves.toEqual({ id: 1, name: 'tag-one', en: 'Tag One' });
            await expect(db.getEntity('circle-a')).resolves.toBe('Circle A');
            await expect(db.getEntity('')).resolves.toBeUndefined();
        });

        it('handles invalid JSON gracefully', () => {
            (globalThis as any).GM_getValue.mockImplementation((key: string, def: unknown) => {
                if (key === GM_KEY_TAGS) return 'not-json{';
                return def;
            });
            expect(() => new TagDatabase()).not.toThrow();
        });
    });

    describe('tag CRUD', () => {
        it('sets and gets a tag', async () => {
            const db = new TagDatabase();
            await db.setTag({ id: 42, name: 'ASMR', en: 'ASMR' });
            await expect(db.getTag(42)).resolves.toEqual({ id: 42, name: 'ASMR', en: 'ASMR' });
        });

        it('returns clones so callers cannot mutate internal cache', async () => {
            const db = new TagDatabase();
            await db.setTag({ id: 10, name: 'Original', en: 'EN' });

            const tag = await db.getTag(10);
            expect(tag).toBeDefined();
            if (!tag) return;
            tag.name = 'Mutated';

            await expect(db.getTag(10)).resolves.toEqual({ id: 10, name: 'Original', en: 'EN' });
        });

        it('rejects invalid tag payloads', async () => {
            const db = new TagDatabase();
            await expect(db.setTag({ id: Number.NaN as unknown as number, name: 'bad' })).rejects.toThrow('Invalid tag payload');
            await expect(db.setTag({ id: 1, name: '   ' })).rejects.toThrow('Invalid tag payload');
        });

        it('persists tags in deterministic id order', async () => {
            const db = new TagDatabase();
            await db.setTag({ id: 3, name: 'three' });
            await db.setTag({ id: 1, name: 'one' });
            await db.setTag({ id: 2, name: 'two' });

            const raw = (globalThis as any).GM_getValue(GM_KEY_TAGS, '[]');
            const stored = JSON.parse(raw);
            expect(stored.map((t: { id: number }) => t.id)).toEqual([1, 2, 3]);
        });
    });

    describe('entity CRUD', () => {
        it('sets and gets an entity translation', async () => {
            const db = new TagDatabase();
            await db.setEntity('circle-jp', 'Circle EN');
            await expect(db.getEntity('circle-jp')).resolves.toBe('Circle EN');
        });

        it('rejects invalid entity payloads', async () => {
            const db = new TagDatabase();
            await expect(db.setEntity(' ', 'value')).rejects.toThrow('Invalid entity payload');
            await expect(db.setEntity('name', ' ')).rejects.toThrow('Invalid entity payload');
        });

        it('persists entities in deterministic key order', async () => {
            const db = new TagDatabase();
            await db.setEntity('z-key', 'z');
            await db.setEntity('a-key', 'a');

            const raw = (globalThis as any).GM_getValue(GM_KEY_ENTITIES, '{}');
            const keys = Object.keys(JSON.parse(raw));
            expect(keys).toEqual(['a-key', 'z-key']);
        });
    });

    describe('export / import', () => {
        it('exports all data', async () => {
            const db = new TagDatabase();
            await db.setTag({ id: 1, name: 'tag1', en: 'Tag 1' });
            await db.setEntity('entity1', 'Entity 1');

            const exported = db.exportAll();
            expect(exported.tags).toEqual([{ id: 1, name: 'tag1', en: 'Tag 1' }]);
            expect(exported.entities).toEqual({ entity1: 'Entity 1' });
        });

        it('imports valid values and ignores invalid rows', async () => {
            const db = new TagDatabase();
            db.importAll({
                tags: [
                    { id: 10, name: 'imported', en: 'Imported' },
                    { id: Number.NaN as unknown as number, name: 'broken' },
                    { id: 11, name: '  ' },
                ],
                entities: {
                    good: 'Good',
                    ' ': 'bad',
                    bad2: '   ',
                },
            });

            await expect(db.getTag(10)).resolves.toEqual({ id: 10, name: 'imported', en: 'Imported' });
            await expect(db.getTag(11)).resolves.toBeUndefined();
            await expect(db.getEntity('good')).resolves.toBe('Good');
            await expect(db.getEntity('bad2')).resolves.toBeUndefined();
        });
    });

    describe('IndexedDB migration', () => {
        it('migrates tags/entities from IndexedDB and marks migration complete', async () => {
            const db = await openDB(DB_NAME, 2, {
                upgrade(upgradeDb) {
                    if (!upgradeDb.objectStoreNames.contains('tags')) {
                        upgradeDb.createObjectStore('tags', { keyPath: 'id' });
                    }
                    if (!upgradeDb.objectStoreNames.contains('entities')) {
                        upgradeDb.createObjectStore('entities', { keyPath: 'name' });
                    }
                },
            });

            await db.put('tags', { id: 2, name: 'Tag-2', en: 'Tag Two' });
            await db.put('tags', { id: 1, name: ' Tag-1 ', en: ' Tag One ' });
            await db.put('entities', { name: ' circle ', en: ' Circle ' });
            await db.put('entities', { name: '', en: 'bad' });
            db.close();

            const migrated = await TagDatabase.migrateFromIndexedDB();
            expect(migrated).toBe(true);

            const storedTagsRaw = (globalThis as any).GM_getValue(GM_KEY_TAGS, '[]');
            const storedEntitiesRaw = (globalThis as any).GM_getValue(GM_KEY_ENTITIES, '{}');
            expect(JSON.parse(storedTagsRaw)).toEqual([
                { id: 1, name: 'Tag-1', en: 'Tag One' },
                { id: 2, name: 'Tag-2', en: 'Tag Two' },
            ]);
            expect(JSON.parse(storedEntitiesRaw)).toEqual({ circle: 'Circle' });
            expect((globalThis as any).GM_getValue(GM_KEY_MIGRATED, false)).toBe(true);

            // second run should no-op
            const migratedAgain = await TagDatabase.migrateFromIndexedDB();
            expect(migratedAgain).toBe(false);
        });
    });
});
