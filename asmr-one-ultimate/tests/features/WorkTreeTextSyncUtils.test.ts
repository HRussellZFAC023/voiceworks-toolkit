import { describe, expect, it } from 'vitest';
import { applyLabelFixes, buildExpectedTitles, collectStaleLabelFixes } from '../../src/features/workTreeTextSyncUtils';

function createLabel(text: string): HTMLElement {
    const label = document.createElement('div');
    label.className = 'q-item__label';
    label.textContent = text;
    return label;
}

describe('workTreeTextSyncUtils', () => {
    it('preserves fatherFolder index alignment when building expected titles', () => {
        const expected = buildExpectedTitles([
            { title: 'track1.mp3', type: 'audio' },
            { title: '', type: 'folder' },
            { title: 'track3.mp3', type: 'audio' },
        ]);

        expect(expected).toEqual(['track1.mp3', null, 'track3.mp3']);
    });

    it('collects only stale labels', () => {
        const labelA = createLabel('track1.mp3');
        const labelB = createLabel('wrong-title');

        const fixes = collectStaleLabelFixes([labelA, labelB], ['track1.mp3', 'track2.mp3']);
        expect(fixes).toHaveLength(1);
        expect(fixes[0].label).toBe(labelB);
        expect(fixes[0].expected).toBe('track2.mp3');
    });

    it('does not shift expected title indexes when middle title is missing', () => {
        const labels = [
            createLabel('track1.mp3'),
            createLabel('folder'),
            createLabel('wrong-third'),
        ];

        const expected = ['track1.mp3', null, 'track3.mp3'];
        const fixes = collectStaleLabelFixes(labels, expected);

        expect(fixes).toHaveLength(1);
        expect(fixes[0].label).toBe(labels[2]);
        expect(fixes[0].expected).toBe('track3.mp3');
    });

    it('applies label fixes and strips stale translation/furigana attributes', () => {
        const label = createLabel('wrong-title');
        label.dataset.asmrtag = 'x';
        label.dataset.asmrtagState = 'y';
        label.dataset.asmrtagScope = 'z';
        label.dataset.asmrtagTranslation = 'translated';
        label.classList.add('asmr-translated', 'asmr-worktree-translation');
        label.setAttribute('data-jpdb', '1');
        label.setAttribute('data-jpdb-original', 'orig');

        applyLabelFixes([{ label, expected: 'correct.mp3' }]);

        expect(label.textContent).toBe('correct.mp3');
        expect(label.dataset.asmrtag).toBeUndefined();
        expect(label.dataset.asmrtagState).toBeUndefined();
        expect(label.dataset.asmrtagScope).toBeUndefined();
        expect(label.dataset.asmrtagTranslation).toBeUndefined();
        expect(label.classList.contains('asmr-translated')).toBe(false);
        expect(label.classList.contains('asmr-worktree-translation')).toBe(false);
        expect(label.hasAttribute('data-jpdb')).toBe(false);
        expect(label.hasAttribute('data-jpdb-original')).toBe(false);
    });
});
