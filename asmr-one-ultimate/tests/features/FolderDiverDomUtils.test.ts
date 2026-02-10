import { describe, expect, it } from 'vitest';
import {
    findBestFolderItem,
    getActiveBreadcrumbTitle,
    getActiveFolderItemTitle,
    getFolderItemLabel,
    hasFolderIcon,
    isExactOrPrefixMatch,
    scoreFolderTitleMatch,
} from '../../src/features/folderDiverDomUtils';

describe('folderDiverDomUtils', () => {
    it('detects folder item via material icon text', () => {
        document.body.innerHTML = `
            <div class="q-item" id="folder-item">
                <i class="material-icons">folder</i>
            </div>
        `;
        const item = document.getElementById('folder-item');
        expect(item).not.toBeNull();
        expect(hasFolderIcon(item!)).toBe(true);
    });

    it('extracts normalized folder label text', () => {
        document.body.innerHTML = `
            <div class="q-item" id="item">
                <div class="q-item__label">
                    Folder   Name
                </div>
            </div>
        `;
        const item = document.getElementById('item');
        expect(getFolderItemLabel(item!)).toBe('Folder Name');
    });

    it('scores exact match higher than partial match', () => {
        const exact = scoreFolderTitleMatch('Voice Tracks', 'Voice Tracks');
        const prefix = scoreFolderTitleMatch('Voice Tracks Bonus', 'Voice Tracks');
        const includes = scoreFolderTitleMatch('Main Voice Tracks Set', 'Voice Tracks');
        expect(exact).toBeGreaterThan(prefix);
        expect(prefix).toBeGreaterThan(includes);
    });

    it('finds best folder item by score (prefers exact over contains)', () => {
        document.body.innerHTML = `
            <div id="work-tree">
                <div class="q-item" id="contains">
                    <i class="material-icons">folder</i>
                    <div class="q-item__label">Main Voice Tracks Set</div>
                </div>
                <div class="q-item" id="exact">
                    <i class="material-icons">folder</i>
                    <div class="q-item__label">Voice Tracks</div>
                </div>
            </div>
        `;
        const workTree = document.getElementById('work-tree');
        const best = findBestFolderItem(workTree!, 'Voice Tracks');
        expect(best?.id).toBe('exact');
    });

    it('reads active breadcrumb and active folder titles', () => {
        document.body.innerHTML = `
            <div id="work-tree">
                <div class="q-breadcrumbs--last">
                    <span class="q-breadcrumbs__el">Current Folder</span>
                </div>
                <div class="q-item q-item--active">
                    <div class="q-item__label">Current Folder</div>
                </div>
            </div>
        `;
        const workTree = document.getElementById('work-tree');
        expect(getActiveBreadcrumbTitle(workTree!)).toBe('Current Folder');
        expect(getActiveFolderItemTitle(workTree!)).toBe('Current Folder');
        expect(isExactOrPrefixMatch('Current Folder', 'Current')).toBe(true);
    });
});
