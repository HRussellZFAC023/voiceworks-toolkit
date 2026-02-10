function normalizeText(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

export function getActiveBreadcrumbTitle(workTree: ParentNode): string {
    const activeBreadcrumb = workTree.querySelector('.q-breadcrumbs--last .q-breadcrumbs__el');
    return normalizeText(activeBreadcrumb?.textContent || '');
}

export function getActiveFolderItemTitle(workTree: ParentNode): string {
    const activeItem = workTree.querySelector('.q-item.q-item--active');
    if (!activeItem) return '';
    const label = activeItem.querySelector('.q-item__label') || activeItem.querySelector('.q-item__section--main');
    return normalizeText(label?.textContent || '');
}

export function hasFolderIcon(item: ParentNode): boolean {
    const hasAmberFolderIcon = !!item.querySelector(
        '.q-icon.text-amber, i.material-icons.text-amber, .q-icon.material-icons.text-amber',
    );
    if (hasAmberFolderIcon) return true;

    const icons = item.querySelectorAll('.q-icon, i.material-icons');
    for (const icon of icons) {
        const iconText = normalizeText(icon.textContent || '').toLowerCase();
        if (iconText === 'folder' || iconText === 'folder_open') {
            return true;
        }
    }
    return false;
}

export function getFolderItemLabel(item: ParentNode): string {
    const label = item.querySelector('.q-item__label:not(.q-item__label--caption)')
        || item.querySelector('.q-item__label')
        || item.querySelector('.q-item__section--main');
    return normalizeText(label?.textContent || '');
}

export function scoreFolderTitleMatch(rawLabel: string, title: string): number {
    const label = normalizeText(rawLabel).toLowerCase();
    const target = normalizeText(title).toLowerCase();
    if (!label || !target) return -1;
    if (label === target) return 400;
    if (label.startsWith(target)) return 300 - Math.max(0, label.length - target.length);
    if (target.length >= 3 && label.includes(target)) return 100 - label.indexOf(target);
    return -1;
}

export function isExactOrPrefixMatch(rawLabel: string, title: string): boolean {
    const score = scoreFolderTitleMatch(rawLabel, title);
    return score >= 200;
}

export function findBestFolderItem(workTree: ParentNode, title: string): HTMLElement | null {
    const items = workTree.querySelectorAll<HTMLElement>('.q-item');
    let best: { element: HTMLElement; score: number; label: string } | null = null;

    for (const item of items) {
        if (!hasFolderIcon(item)) continue;
        const label = getFolderItemLabel(item);
        if (!label) continue;
        const score = scoreFolderTitleMatch(label, title);
        if (score < 0) continue;
        if (!best || score > best.score) {
            best = { element: item, score, label };
        }
    }

    return best?.element || null;
}
