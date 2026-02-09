import { GM_getValue, GM_setValue } from '$';
import { openDB } from 'idb';
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

function normalizeTag(input: Partial<Tag>): Tag | null {
    if (typeof input?.id !== 'number' || !Number.isFinite(input.id)) return null;
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    if (!name) return null;
    const en = typeof input?.en === 'string' ? input.en.trim() : undefined;
    return en ? { id: input.id, name, en } : { id: input.id, name };
}

function normalizeEntity(name: string, en: string): { name: string; en: string } | null {
    const safeName = typeof name === 'string' ? name.trim() : '';
    const safeEn = typeof en === 'string' ? en.trim() : '';
    if (!safeName || !safeEn) return null;
    return { name: safeName, en: safeEn };
}

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
                for (const t of tags) {
                    const normalized = normalizeTag(t);
                    if (normalized) this.tagMap.set(normalized.id, normalized);
                }
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
                    const normalized = normalizeEntity(name, en);
                    if (normalized) this.entityMap.set(normalized.name, normalized.en);
                }
            }
        } catch {
            Logger.warn('[TagDatabase] Failed to parse stored entities');
        }
    }

    private persistTags(): void {
        try {
            const sorted = [...this.tagMap.values()].sort((a, b) => a.id - b.id);
            GM_setValue(GM_KEY_TAGS, JSON.stringify(sorted));
        } catch {
            Logger.warn('[TagDatabase] Failed to persist tags');
        }
    }

    private persistEntities(): void {
        try {
            const obj: Record<string, string> = {};
            [...this.entityMap.entries()]
                .sort(([a], [b]) => a.localeCompare(b))
                .forEach(([name, en]) => { obj[name] = en; });
            GM_setValue(GM_KEY_ENTITIES, JSON.stringify(obj));
        } catch {
            Logger.warn('[TagDatabase] Failed to persist entities');
        }
    }

    // -- Public API (async signatures for backward compat) --

    public async getTag(id: number): Promise<Tag | undefined> {
        const tag = this.tagMap.get(id);
        return tag ? { ...tag } : undefined;
    }

    public async setTag(tag: Tag): Promise<number> {
        const normalized = normalizeTag(tag);
        if (!normalized) throw new Error('[TagDatabase] Invalid tag payload');
        this.tagMap.set(normalized.id, normalized);
        this.persistTags();
        return normalized.id;
    }

    public async getAllTags(): Promise<Tag[]> {
        return [...this.tagMap.values()].map(tag => ({ ...tag }));
    }

    public async getEntity(name: string): Promise<string | undefined> {
        return this.entityMap.get(name);
    }

    public async setEntity(name: string, en: string): Promise<string> {
        const normalized = normalizeEntity(name, en);
        if (!normalized) throw new Error('[TagDatabase] Invalid entity payload');
        this.entityMap.set(normalized.name, normalized.en);
        this.persistEntities();
        return normalized.en;
    }

    // -- Export/Import for backup --

    public exportAll(): { tags: Tag[]; entities: Record<string, string> } {
        const entities: Record<string, string> = {};
        this.entityMap.forEach((en, name) => { entities[name] = en; });
        return {
            tags: [...this.tagMap.values()].map(tag => ({ ...tag })),
            entities,
        };
    }

    public importAll(data: { tags?: Tag[]; entities?: Record<string, string> }): void {
        if (data.tags) {
            for (const t of data.tags) {
                const normalized = normalizeTag(t);
                if (normalized) this.tagMap.set(normalized.id, normalized);
            }
            this.persistTags();
        }
        if (data.entities) {
            for (const [name, en] of Object.entries(data.entities)) {
                const normalized = normalizeEntity(name, en);
                if (normalized) this.entityMap.set(normalized.name, normalized.en);
            }
            this.persistEntities();
        }
    }

    // -- One-time migration from IndexedDB --

    public static async migrateFromIndexedDB(): Promise<boolean> {
        if (GM_getValue(GM_KEY_MIGRATED, false)) return false;

        try {
            // openDB is statically imported at top level
            const db = await openDB('asmr-one-ultimate-db', 2, {
                upgrade(upgradeDb, oldVersion) {
                    if (oldVersion < 1) upgradeDb.createObjectStore('tags', { keyPath: 'id' });
                    if (oldVersion < 2) upgradeDb.createObjectStore('entities', { keyPath: 'name' });
                },
            });

            const tags: Tag[] = await db.getAll('tags');
            const entities: EntityTranslation[] = await db.getAll('entities');
            db.close();

            const normalizedTags = tags
                .map(t => normalizeTag(t))
                .filter((t): t is Tag => !!t);
            const normalizedEntities = entities
                .map(e => normalizeEntity(e.name, e.en))
                .filter((e): e is { name: string; en: string } => !!e);

            if (normalizedTags.length > 0 || normalizedEntities.length > 0) {
                const instance = new TagDatabase();
                for (const t of normalizedTags) instance.tagMap.set(t.id, t);
                instance.persistTags();
                for (const e of normalizedEntities) instance.entityMap.set(e.name, e.en);
                instance.persistEntities();
                Logger.log(`[TagDatabase] Migrated ${normalizedTags.length} tags and ${normalizedEntities.length} entities from IndexedDB`);
            }

            GM_setValue(GM_KEY_MIGRATED, true);
            return normalizedTags.length > 0 || normalizedEntities.length > 0;
        } catch {
            // DB doesn't exist or migration failed — mark done anyway
            GM_setValue(GM_KEY_MIGRATED, true);
            return false;
        }
    }
}
