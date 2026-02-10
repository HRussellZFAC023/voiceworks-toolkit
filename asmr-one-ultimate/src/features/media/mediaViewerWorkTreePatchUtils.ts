export type WorkTreeClickHandler<TItem = unknown> = (item: TItem) => unknown;

export interface MediaViewerPatchableWorkTree<TItem = unknown> {
    onClickItem?: WorkTreeClickHandler<TItem>;
    __mediaViewerPatched?: boolean;
    __mediaViewerOriginalOnClickItem?: WorkTreeClickHandler<TItem>;
}

export function applyMediaViewerWorkTreePatch<TItem>(
    workTree: MediaViewerPatchableWorkTree<TItem>,
    createPatchedHandler: (original: WorkTreeClickHandler<TItem>) => WorkTreeClickHandler<TItem>,
): boolean {
    if (typeof workTree.onClickItem !== 'function') return false;
    if (workTree.__mediaViewerPatched) return true;

    const original = workTree.onClickItem;
    workTree.__mediaViewerOriginalOnClickItem = original;
    workTree.onClickItem = createPatchedHandler(original);
    workTree.__mediaViewerPatched = true;
    return true;
}

export function restoreMediaViewerWorkTreePatch<TItem>(
    workTree: MediaViewerPatchableWorkTree<TItem> | null | undefined,
): void {
    if (!workTree) return;

    const original = workTree.__mediaViewerOriginalOnClickItem;
    if (typeof original === 'function') {
        workTree.onClickItem = original;
    }
    delete workTree.__mediaViewerOriginalOnClickItem;
    workTree.__mediaViewerPatched = false;
}
