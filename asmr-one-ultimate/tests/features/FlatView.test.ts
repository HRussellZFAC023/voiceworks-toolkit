import { describe, it, expect } from 'vitest';
import { flattenTree } from '../../src/features/flatViewUtils';

describe('FlatView', () => {
    it('flattenTree produces correct output from tree data', () => {
        const tree = [
            {
                type: 'folder' as const,
                title: 'CD1',
                children: [
                    { type: 'audio' as const, hash: '1/0', title: 'track1.mp3' },
                    { type: 'audio' as const, hash: '1/1', title: 'track2.mp3' },
                ],
            },
            {
                type: 'folder' as const,
                title: 'Bonus',
                children: [
                    {
                        type: 'folder' as const,
                        title: 'SubBonus',
                        children: [
                            { type: 'audio' as const, hash: '1/2', title: 'deep.mp3' },
                        ],
                    },
                ],
            },
            { type: 'text' as const, hash: '1/3', title: 'readme.txt' },
        ];

        const items = flattenTree(tree as any);

        expect(items.length).toBe(4);
        expect(items[0].title).toBe('track1.mp3');
        expect(items[0].folderPath).toBe('CD1');
        expect(items[1].title).toBe('track2.mp3');
        expect(items[1].folderPath).toBe('CD1');
        expect(items[2].title).toBe('deep.mp3');
        expect(items[2].folderPath).toBe('Bonus / SubBonus');
        expect(items[3].title).toBe('readme.txt');
        expect(items[3].folderPath).toBe('');
    });

    it('flattenTree handles empty tree', () => {
        const items = flattenTree([]);
        expect(items.length).toBe(0);
    });

    it('flattenTree handles root-level items without folders', () => {
        const tree = [
            { type: 'audio' as const, hash: 'a', title: 'track.mp3' },
            { type: 'image' as const, hash: 'b', title: 'cover.jpg' },
        ];
        const items = flattenTree(tree as any);
        expect(items.length).toBe(2);
        expect(items[0].folderPath).toBe('');
        expect(items[1].folderPath).toBe('');
    });
});
