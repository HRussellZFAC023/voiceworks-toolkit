import { describe, expect, it } from 'vitest';
import {
    normalizeFavoriteEntities,
    sortEntitiesWithFavorites,
    toggleFavoriteEntity,
} from '../../src/features/favoriteEntities';

describe('favorite entities', () => {
    it('normalizes persisted favorites and removes malformed duplicates', () => {
        expect(normalizeFavoriteEntities(JSON.stringify([
            { id: 2, name: ' Circle B ' },
            { id: 2, name: 'duplicate' },
            { id: null, name: 'bad' },
        ]))).toEqual([{ id: 2, name: 'Circle B' }]);
    });

    it('toggles a favorite without mutating the source array', () => {
        const original = [{ id: 1, name: 'VA A' }];
        const added = toggleFavoriteEntity(original, { id: 2, name: 'VA B' });
        expect(original).toHaveLength(1);
        expect(added.map(item => item.id)).toEqual([1, 2]);
        expect(toggleFavoriteEntity(added, { id: 1, name: 'VA A' }).map(item => item.id)).toEqual([2]);
    });

    it('keeps favorite order at the top without disturbing the remaining API order', () => {
        const items = [
            { id: 1, name: 'A' },
            { id: 2, name: 'B' },
            { id: 3, name: 'C' },
        ];
        expect(sortEntitiesWithFavorites(items, [3, 1]).map(item => item.id)).toEqual([3, 1, 2]);
    });
});
