import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TagDatabase } from '../../src/infrastructure/TagDatabase';

describe('TagDatabase', () => {
    beforeEach(() => {
        // Clear GM storage before each test (setup.ts clears gmStorage map)
    });

    describe('constructor / hydration', () => {
        it('should create an empty database', () => {
            const db = new TagDatabase();
            expect(db).toBeDefined();
        });

        it('should hydrate from existing GM storage', () => {
            // Pre-populate GM storage
            (globalThis as any).GM_getValue.mockImplementation((key: string, def: any) => {
                if (key === 'asmr-ult:tagdb:tags') {
                    return JSON.stringify([{ id: 1, name: '耳かき', en: 'Ear Cleaning' }]);
                }
                if (key === 'asmr-ult:tagdb:entities') {
                    return JSON.stringify({ 'サークルA': 'Circle A' });
                }
                return def;
            });

            const db = new TagDatabase();
            // Verify hydration worked by checking getTag
            return db.getTag(1).then(tag => {
                expect(tag).toEqual({ id: 1, name: '耳かき', en: 'Ear Cleaning' });
            });
        });

        it('should handle invalid JSON in GM storage gracefully', () => {
            (globalThis as any).GM_getValue.mockImplementation((key: string, def: any) => {
                if (key === 'asmr-ult:tagdb:tags') return 'not-json{';
                return def;
            });
            // Should not throw
            expect(() => new TagDatabase()).not.toThrow();
        });

        it('should handle non-array tags data', () => {
            (globalThis as any).GM_getValue.mockImplementation((key: string, def: any) => {
                if (key === 'asmr-ult:tagdb:tags') return JSON.stringify('string-not-array');
                return def;
            });
            expect(() => new TagDatabase()).not.toThrow();
        });
    });

    describe('tag CRUD', () => {
        it('should set and get a tag', async () => {
            const db = new TagDatabase();
            await db.setTag({ id: 42, name: 'ASMR', en: 'ASMR' });
            const tag = await db.getTag(42);
            expect(tag).toEqual({ id: 42, name: 'ASMR', en: 'ASMR' });
        });

        it('should return undefined for non-existent tag', async () => {
            const db = new TagDatabase();
            const tag = await db.getTag(999);
            expect(tag).toBeUndefined();
        });

        it('should overwrite existing tag', async () => {
            const db = new TagDatabase();
            await db.setTag({ id: 1, name: 'original' });
            await db.setTag({ id: 1, name: 'updated', en: 'Updated' });
            const tag = await db.getTag(1);
            expect(tag?.name).toBe('updated');
            expect(tag?.en).toBe('Updated');
        });

        it('should return the tag id from setTag', async () => {
            const db = new TagDatabase();
            const id = await db.setTag({ id: 7, name: 'test' });
            expect(id).toBe(7);
        });

        it('should persist tags to GM storage', async () => {
            const db = new TagDatabase();
            await db.setTag({ id: 1, name: 'test' });
            expect((globalThis as any).GM_setValue).toHaveBeenCalledWith(
                'asmr-ult:tagdb:tags',
                expect.any(String)
            );
        });
    });

    describe('getAllTags', () => {
        it('should return all tags', async () => {
            const db = new TagDatabase();
            await db.setTag({ id: 1, name: 'tag1' });
            await db.setTag({ id: 2, name: 'tag2' });
            await db.setTag({ id: 3, name: 'tag3' });
            const tags = await db.getAllTags();
            expect(tags).toHaveLength(3);
        });

        it('should return empty array for new database', async () => {
            const db = new TagDatabase();
            const tags = await db.getAllTags();
            expect(tags).toEqual([]);
        });
    });

    describe('entity CRUD', () => {
        it('should set and get an entity translation', async () => {
            const db = new TagDatabase();
            await db.setEntity('サークル名', 'Circle Name');
            const en = await db.getEntity('サークル名');
            expect(en).toBe('Circle Name');
        });

        it('should return undefined for non-existent entity', async () => {
            const db = new TagDatabase();
            const en = await db.getEntity('missing');
            expect(en).toBeUndefined();
        });

        it('should overwrite existing entity', async () => {
            const db = new TagDatabase();
            await db.setEntity('name', 'First');
            await db.setEntity('name', 'Second');
            const en = await db.getEntity('name');
            expect(en).toBe('Second');
        });

        it('should persist entities to GM storage', async () => {
            const db = new TagDatabase();
            await db.setEntity('test', 'Test');
            expect((globalThis as any).GM_setValue).toHaveBeenCalledWith(
                'asmr-ult:tagdb:entities',
                expect.any(String)
            );
        });
    });

    describe('export / import', () => {
        it('should export all data', async () => {
            const db = new TagDatabase();
            await db.setTag({ id: 1, name: 'tag1', en: 'Tag 1' });
            await db.setEntity('entity1', 'Entity 1');

            const exported = db.exportAll();
            expect(exported.tags).toHaveLength(1);
            expect(exported.tags[0]).toEqual({ id: 1, name: 'tag1', en: 'Tag 1' });
            expect(exported.entities).toEqual({ 'entity1': 'Entity 1' });
        });

        it('should import tags and entities', async () => {
            const db = new TagDatabase();
            db.importAll({
                tags: [
                    { id: 10, name: 'imported', en: 'Imported' },
                    { id: 20, name: 'another' },
                ],
                entities: {
                    'jp_name': 'en_name',
                },
            });

            const tag = await db.getTag(10);
            expect(tag?.en).toBe('Imported');
            const entity = await db.getEntity('jp_name');
            expect(entity).toBe('en_name');
        });

        it('should merge imported data with existing', async () => {
            const db = new TagDatabase();
            await db.setTag({ id: 1, name: 'existing' });
            db.importAll({
                tags: [{ id: 2, name: 'new' }],
            });

            expect(await db.getTag(1)).toBeDefined();
            expect(await db.getTag(2)).toBeDefined();
        });

        it('should handle empty import data', () => {
            const db = new TagDatabase();
            expect(() => db.importAll({})).not.toThrow();
        });
    });
});
