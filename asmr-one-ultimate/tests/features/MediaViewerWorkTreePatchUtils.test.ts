import { describe, expect, it, vi } from 'vitest';
import {
    applyMediaViewerWorkTreePatch,
    restoreMediaViewerWorkTreePatch,
    type MediaViewerPatchableWorkTree,
} from '../../src/features/media/mediaViewerWorkTreePatchUtils';

describe('mediaViewerWorkTreePatchUtils', () => {
    it('applies patch once and preserves original handler', () => {
        const original = vi.fn(() => 'orig');
        const workTree: MediaViewerPatchableWorkTree<string> = {
            onClickItem: original,
        };

        const patched = applyMediaViewerWorkTreePatch(workTree, (orig) => (item) => {
            if (item === 'intercept') return 'patched';
            return orig(item);
        });

        expect(patched).toBe(true);
        expect(workTree.__mediaViewerPatched).toBe(true);
        expect(workTree.__mediaViewerOriginalOnClickItem).toBe(original);
        expect(workTree.onClickItem?.('intercept')).toBe('patched');
        expect(workTree.onClickItem?.('pass')).toBe('orig');
        expect(original).toHaveBeenCalledWith('pass');
    });

    it('does not double-patch an already patched tree', () => {
        const original = vi.fn(() => 'orig');
        const workTree: MediaViewerPatchableWorkTree<string> = {
            onClickItem: original,
        };

        applyMediaViewerWorkTreePatch(workTree, (orig) => (item) => orig(item));
        const firstPatched = workTree.onClickItem;

        const secondResult = applyMediaViewerWorkTreePatch(workTree, () => () => 'new');
        expect(secondResult).toBe(true);
        expect(workTree.onClickItem).toBe(firstPatched);
    });

    it('restores original handler and clears patch markers', () => {
        const original = vi.fn(() => 'orig');
        const workTree: MediaViewerPatchableWorkTree<string> = {
            onClickItem: original,
        };

        applyMediaViewerWorkTreePatch(workTree, () => () => 'patched');
        restoreMediaViewerWorkTreePatch(workTree);

        expect(workTree.__mediaViewerPatched).toBe(false);
        expect(workTree.__mediaViewerOriginalOnClickItem).toBeUndefined();
        expect(workTree.onClickItem).toBe(original);
        expect(workTree.onClickItem?.('x')).toBe('orig');
    });

    it('returns false when no original onClickItem exists', () => {
        const workTree: MediaViewerPatchableWorkTree<string> = {};
        const patched = applyMediaViewerWorkTreePatch(workTree, () => () => 'patched');
        expect(patched).toBe(false);
    });
});
