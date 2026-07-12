export interface FavoriteEntity {
    id: string | number;
    name: string;
    count?: number;
}

export const FAVORITE_ENTITY_KEYS = {
    vas: 'asmr-ult:favorites:vas',
    circles: 'asmr-ult:favorites:circles',
} as const;

export function normalizeFavoriteEntities(value: unknown): FavoriteEntity[] {
    let parsed = value;
    if (typeof value === 'string') {
        try { parsed = JSON.parse(value); } catch { return []; }
    }
    if (!Array.isArray(parsed)) return [];

    const seen = new Set<string>();
    const favorites: FavoriteEntity[] = [];
    for (const candidate of parsed) {
        if (!candidate || typeof candidate !== 'object') continue;
        const item = candidate as Partial<FavoriteEntity>;
        if ((typeof item.id !== 'string' && typeof item.id !== 'number') || typeof item.name !== 'string') continue;
        const name = item.name.trim();
        const id = String(item.id);
        if (!name || seen.has(id)) continue;
        seen.add(id);
        favorites.push({ id: item.id, name, ...(typeof item.count === 'number' ? { count: item.count } : {}) });
    }
    return favorites;
}

export function toggleFavoriteEntity(
    favorites: FavoriteEntity[],
    item: FavoriteEntity,
): FavoriteEntity[] {
    const id = String(item.id);
    if (favorites.some((favorite) => String(favorite.id) === id)) {
        return favorites.filter((favorite) => String(favorite.id) !== id);
    }
    return [...favorites, { ...item, name: item.name.trim() }];
}

export function sortEntitiesWithFavorites<T extends FavoriteEntity>(items: T[], favoriteIds: Array<string | number>): T[] {
    const order = new Map(favoriteIds.map((id, index) => [String(id), index]));
    return items
        .map((item, index) => ({ item, index }))
        .sort((a, b) => {
            const aOrder = order.get(String(a.item.id));
            const bOrder = order.get(String(b.item.id));
            if (aOrder !== undefined && bOrder !== undefined) return aOrder - bOrder;
            if (aOrder !== undefined) return -1;
            if (bOrder !== undefined) return 1;
            return a.index - b.index;
        })
        .map(({ item }) => item);
}
