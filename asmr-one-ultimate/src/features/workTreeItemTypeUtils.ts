import type { FatherFolderItem } from '../types/store';

function toItemType(item: FatherFolderItem | undefined): string | null {
    const type = typeof item?.type === 'string' ? item.type.trim() : '';
    return type || null;
}

/**
 * Sync data-item-type attributes to match fatherFolder data by index.
 * Clears stale attributes on extra/missing/malformed rows.
 */
export function syncWorkTreeItemTypes(
    items: Iterable<Element>,
    fatherFolder: FatherFolderItem[],
): void {
    const itemList = Array.from(items).filter((item): item is HTMLElement => item instanceof HTMLElement);

    for (let i = 0; i < itemList.length; i++) {
        const element = itemList[i];
        const nextType = toItemType(fatherFolder[i]);
        if (nextType) {
            element.dataset.itemType = nextType;
        } else {
            delete element.dataset.itemType;
        }
    }
}
