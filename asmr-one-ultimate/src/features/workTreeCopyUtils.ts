export function shouldSkipRootFolderItem(
    isFlatPanel: boolean,
    index: number,
    itemType: string | undefined,
    hasHash: boolean,
    labelText: string,
    allFilesLabel: string,
): boolean {
    if (isFlatPanel) return false;

    if (itemType === 'folder' && index === 0 && !hasHash) {
        return true;
    }

    const normalizedLabel = labelText.trim().toLowerCase();
    const normalizedAllFiles = allFilesLabel.trim().toLowerCase();
    return index === 0 && !!normalizedLabel && normalizedLabel === normalizedAllFiles;
}

export function sanitizeCopyText(rawTitle: string, copyLabel: string): string {
    const title = rawTitle.trim();
    if (!title) return '';

    const trimmedCopy = copyLabel.trim();
    if (!trimmedCopy) return title;

    const hasPrefix = title.toLowerCase().startsWith(trimmedCopy.toLowerCase());
    if (hasPrefix) {
        const nextChar = title.slice(trimmedCopy.length, trimmedCopy.length + 1);
        const isBoundary = !nextChar || /[\s:\uFF1A\u2010\u2011\u2012\u2013\u2014]/.test(nextChar);
        if (isBoundary) {
            return title
                .slice(trimmedCopy.length)
                .replace(/^[\s:\uFF1A\u2010\u2011\u2012\u2013\u2014]+/, '')
                .trim();
        }
    }

    return title;
}

export function buildCopyAriaLabel(copyLabel: string, itemTitle?: string): string {
    const label = copyLabel.trim();
    const title = (itemTitle || '').trim();
    if (!label) return title;
    if (!title) return label;
    return `${label} ${title}`;
}

export function getCopyTargetItems(container: Element): HTMLElement[] {
    const items = Array.from(container.querySelectorAll<HTMLElement>('[role="listitem"], .q-item'));
    return Array.from(new Set(items));
}

export function removeInjectedCopyButtons(root: ParentNode): number {
    const buttons = root.querySelectorAll<HTMLElement>('[data-xxcopy]');
    buttons.forEach((button) => button.remove());
    return buttons.length;
}

export function applyCopyButtonPresentation(
    button: HTMLElement,
    copyLabel: string,
    itemTitle?: string,
): void {
    const content = button.querySelector('.q-btn__content');
    if (content) {
        content.textContent = copyLabel;
    } else {
        button.textContent = copyLabel;
    }

    const title = (itemTitle || '').trim();
    if (title) {
        button.dataset.copyTitle = title;
    } else {
        delete button.dataset.copyTitle;
    }

    button.ariaLabel = buildCopyAriaLabel(copyLabel, title);
}
