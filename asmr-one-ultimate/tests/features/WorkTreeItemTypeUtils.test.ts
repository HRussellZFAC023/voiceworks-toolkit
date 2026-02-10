import { describe, expect, it } from 'vitest';
import { syncWorkTreeItemTypes } from '../../src/features/workTreeItemTypeUtils';

function createItem(type?: string): HTMLElement {
    const item = document.createElement('div');
    item.className = 'q-item';
    if (type) item.dataset.itemType = type;
    return item;
}

describe('workTreeItemTypeUtils', () => {
    it('sets item types from fatherFolder by index', () => {
        const first = createItem();
        const second = createItem();

        syncWorkTreeItemTypes([first, second], [
            { title: 'a.mp3', type: 'audio' },
            { title: 'folder', type: 'folder' },
        ]);

        expect(first.dataset.itemType).toBe('audio');
        expect(second.dataset.itemType).toBe('folder');
    });

    it('clears stale type when fatherFolder entry is missing', () => {
        const first = createItem('audio');
        const second = createItem('folder');

        syncWorkTreeItemTypes([first, second], [
            { title: 'a.mp3', type: 'audio' },
        ]);

        expect(first.dataset.itemType).toBe('audio');
        expect(second.dataset.itemType).toBeUndefined();
    });

    it('clears stale type when entry type is empty', () => {
        const item = createItem('audio');
        syncWorkTreeItemTypes([item], [{ title: 'a.mp3', type: '' }]);
        expect(item.dataset.itemType).toBeUndefined();
    });
});
