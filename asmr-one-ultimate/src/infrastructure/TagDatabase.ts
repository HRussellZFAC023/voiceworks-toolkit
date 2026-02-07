import { GM_getValue, GM_setValue } from '$';
import { Logger } from '../core/Utils';

interface Tag {
    id: number;
    name: string;
    en?: string;
}

interface EntityTranslation {
    name: string;
    en: string;
}

const GM_KEY_TAGS = 'asmr-ult:tagdb:tags';
const GM_KEY_ENTITIES = 'asmr-ult:tagdb:entities';
const GM_KEY_MIGRATED = 'asmr-ult:tagdb:migrated';

/**
 * TagDatabase - Stores tag and entity translations in GM_* storage.
 *
 * Uses GM_getValue/GM_setValue instead of IndexedDB so that translations
 * survive browser cache clears. L1 in-memory Maps for fast reads.
 * Async method signatures kept for backward compatibility.
 */
export class TagDatabase {
    private tagMap = new Map<number, Tag>();
    private entityMap = new Map<string, string>();

    constructor() {
        this.hydrate();
    }

    private hydrate(): void {
        try {
            const rawTags = GM_getValue(GM_KEY_TAGS, '[]');
            const tags: Tag[] = typeof rawTags === 'string' ? JSON.parse(rawTags) : rawTags;
            if (Array.isArray(tags)) {
                for (const t of tags) this.tagMap.set(t.id, t);
            }
        } catch {
            Logger.warn('[TagDatabase] Failed to parse stored tags');
        }

        try {
            const rawEntities = GM_getValue(GM_KEY_ENTITIES, '{}');
            const entities: Record<string, string> = typeof rawEntities === 'string'
                ? JSON.parse(rawEntities) : rawEntities;
            if (entities && typeof entities === 'object') {
                for (const [name, en] of Object.entries(entities)) {
                    this.entityMap.set(name, en);
                }
            }
        } catch {
            Logger.warn('[TagDatabase] Failed to parse stored entities');
        }
    }

    private persistTags(): void {
        try {
            GM_setValue(GM_KEY_TAGS, JSON.stringify([...this.tagMap.values()]));
        } catch {
            Logger.warn('[TagDatabase] Failed to persist tags');
        }
    }

    private persistEntities(): void {
        try {
            const obj: Record<string, string> = {};
            this.entityMap.forEach((en, name) => { obj[name] = en; });
            GM_setValue(GM_KEY_ENTITIES, JSON.stringify(obj));
        } catch {
            Logger.warn('[TagDatabase] Failed to persist entities');
        }
    }

    // -- Public API (async signatures for backward compat) --

    public async getTag(id: number): Promise<Tag | undefined> {
        return this.tagMap.get(id);
    }

    public async setTag(tag: Tag): Promise<number> {
        this.tagMap.set(tag.id, tag);
        this.persistTags();
        return tag.id;
    }

    public async getAllTags(): Promise<Tag[]> {
        return [...this.tagMap.values()];
    }

    public async getEntity(name: string): Promise<string | undefined> {
        return this.entityMap.get(name);
    }

    public async setEntity(name: string, en: string): Promise<string> {
        this.entityMap.set(name, en);
        this.persistEntities();
        return en;
    }

    // -- Export/Import for backup --

    public exportAll(): { tags: Tag[]; entities: Record<string, string> } {
        const entities: Record<string, string> = {};
        this.entityMap.forEach((en, name) => { entities[name] = en; });
        return {
            tags: [...this.tagMap.values()],
            entities,
        };
    }

    public importAll(data: { tags?: Tag[]; entities?: Record<string, string> }): void {
        if (data.tags) {
            for (const t of data.tags) this.tagMap.set(t.id, t);
            this.persistTags();
        }
        if (data.entities) {
            for (const [name, en] of Object.entries(data.entities)) {
                this.entityMap.set(name, en);
            }
            this.persistEntities();
        }
    }

    // -- One-time migration from IndexedDB --

    public static async migrateFromIndexedDB(): Promise<boolean> {
        if (GM_getValue(GM_KEY_MIGRATED, false)) return false;

        try {
            const { openDB } = await import('idb');
            const db = await openDB('asmr-one-ultimate-db', 2, {
                upgrade(upgradeDb, oldVersion) {
                    if (oldVersion < 1) upgradeDb.createObjectStore('tags', { keyPath: 'id' });
                    if (oldVersion < 2) upgradeDb.createObjectStore('entities', { keyPath: 'name' });
                },
            });

            const tags: Tag[] = await db.getAll('tags');
            const entities: EntityTranslation[] = await db.getAll('entities');
            db.close();

            if (tags.length > 0 || entities.length > 0) {
                const instance = new TagDatabase();
                for (const t of tags) instance.tagMap.set(t.id, t);
                instance.persistTags();
                for (const e of entities) instance.entityMap.set(e.name, e.en);
                instance.persistEntities();
                Logger.log(`[TagDatabase] Migrated ${tags.length} tags and ${entities.length} entities from IndexedDB`);
            }

            GM_setValue(GM_KEY_MIGRATED, true);
            return tags.length > 0 || entities.length > 0;
        } catch {
            // DB doesn't exist or migration failed — mark done anyway
            GM_setValue(GM_KEY_MIGRATED, true);
            return false;
        }
    }
}
