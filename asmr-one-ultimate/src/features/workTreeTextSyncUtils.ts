import { getCleanText } from '../core/DomUtils';
import type { FatherFolderItem } from '../types/store';

export interface LabelFix {
    label: HTMLElement;
    expected: string;
}

/**
 * Build expected title slots from fatherFolder while preserving index alignment.
 * Missing titles are represented as null and intentionally not compacted.
 */
export function buildExpectedTitles(fatherFolder: FatherFolderItem[]): Array<string | null> {
    return fatherFolder.map((item) => {
        const title = typeof item?.title === 'string' ? item.title.trim() : '';
        return title || null;
    });
}

/**
 * Collect work-tree labels that have drifted from expected fatherFolder titles.
 */
export function collectStaleLabelFixes(
    labels: Iterable<HTMLElement>,
    expectedTitles: Array<string | null>,
): LabelFix[] {
    const fixes: LabelFix[] = [];
    const labelList = Array.from(labels);
    const limit = Math.min(labelList.length, expectedTitles.length);

    for (let i = 0; i < limit; i++) {
        const label = labelList[i];
        const expected = expectedTitles[i];
        if (!label || !expected) continue;

        const domText = getCleanText(label);
        if (domText === expected || domText.includes(expected)) continue;

        fixes.push({ label, expected });
    }

    return fixes;
}

/**
 * Apply stale-label corrections and clear feature-specific stale state.
 */
export function applyLabelFixes(fixes: LabelFix[]): void {
    for (const { label, expected } of fixes) {
        label.textContent = expected;
        delete label.dataset.asmrtag;
        delete label.dataset.asmrtagState;
        delete label.dataset.asmrtagScope;
        delete label.dataset.asmrtagTranslation;
        label.classList.remove('asmr-translated');
        label.classList.remove('asmr-worktree-translation');
        label.removeAttribute('data-jpdb');
        label.removeAttribute('data-jpdb-original');
    }
}
