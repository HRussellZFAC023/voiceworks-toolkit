import { describe, expect, it } from 'vitest';
import {
    applyCopyButtonPresentation,
    buildCopyAriaLabel,
    getCopyTargetItems,
    removeInjectedCopyButtons,
    sanitizeCopyText,
    shouldSkipRootFolderItem,
} from '../../src/features/workTreeCopyUtils';

describe('workTreeCopyUtils', () => {
    it('skips root folder row in native tree', () => {
        expect(
            shouldSkipRootFolderItem(false, 0, 'folder', false, 'All files', 'All files'),
        ).toBe(true);
    });

    it('does not skip flat panel items', () => {
        expect(
            shouldSkipRootFolderItem(true, 0, 'folder', false, 'All files', 'All files'),
        ).toBe(false);
    });

    it('uses translated label fallback for root detection', () => {
        expect(
            shouldSkipRootFolderItem(false, 0, undefined, false, '全ファイル', '全ファイル'),
        ).toBe(true);
    });

    it('does not skip non-root rows', () => {
        expect(
            shouldSkipRootFolderItem(false, 1, 'folder', false, 'All files', 'All files'),
        ).toBe(false);
        expect(
            shouldSkipRootFolderItem(false, 0, 'audio', true, 'track1.mp3', 'All files'),
        ).toBe(false);
    });

    it('sanitizes copied text without damaging normal titles', () => {
        expect(sanitizeCopyText('Copy Track 1', 'Copy')).toBe('Track 1');
        expect(sanitizeCopyText('Track 1', 'Copy')).toBe('Track 1');
        expect(sanitizeCopyText('  Copy   Track 2  ', 'Copy')).toBe('Track 2');
        expect(sanitizeCopyText('Copyright note', 'Copy')).toBe('Copyright note');
        expect(sanitizeCopyText('Copy: Track 3', 'Copy')).toBe('Track 3');
        expect(sanitizeCopyText('Copy： Track 4', 'Copy')).toBe('Track 4');
        expect(sanitizeCopyText('Copy\u2014Track 5', 'Copy')).toBe('Track 5');
        expect(sanitizeCopyText('   ', 'Copy')).toBe('');
    });

    it('builds aria labels with optional item title', () => {
        expect(buildCopyAriaLabel('Copy', 'Track 1')).toBe('Copy Track 1');
        expect(buildCopyAriaLabel('Copy', '')).toBe('Copy');
        expect(buildCopyAriaLabel('', 'Track 1')).toBe('Track 1');
    });

    it('collects copy target items without duplicates', () => {
        const container = document.createElement('div');
        container.innerHTML = `
            <div class="q-item" role="listitem"></div>
            <div class="q-item"></div>
            <div role="listitem"></div>
        `;

        const items = getCopyTargetItems(container);
        expect(items).toHaveLength(3);
    });

    it('removes all injected copy buttons from a root node', () => {
        const root = document.createElement('div');
        root.innerHTML = `
            <button data-xxcopy="true"></button>
            <div><button data-xxcopy="true"></button></div>
        `;

        const removed = removeInjectedCopyButtons(root);
        expect(removed).toBe(2);
        expect(root.querySelector('[data-xxcopy]')).toBeNull();
    });

    it('applies copy button presentation and aria metadata', () => {
        const button = document.createElement('button');
        button.innerHTML = '<span class="q-btn__content"></span>';

        applyCopyButtonPresentation(button, 'Copy', 'Track 1');
        expect(button.querySelector('.q-btn__content')?.textContent).toBe('Copy');
        expect(button.dataset.copyTitle).toBe('Track 1');
        expect(button.ariaLabel).toBe('Copy Track 1');

        applyCopyButtonPresentation(button, 'Copy', '');
        expect(button.dataset.copyTitle).toBeUndefined();
        expect(button.ariaLabel).toBe('Copy');
    });
});
