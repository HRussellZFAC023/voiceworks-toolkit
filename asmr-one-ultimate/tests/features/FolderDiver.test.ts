import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FolderDiver } from '../../src/features/FolderDiver';

vi.mock('../../src/core/Logger', () => ({
    Logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/infrastructure/KikoeruBridge', () => ({
    KikoeruBridge: {
        getInstance: () => ({
            updatePath: vi.fn(),
            findWorkTreeComponent: () => null,
        }),
    },
}));

vi.mock('../../src/core/WorkUtils', () => ({
    calculateFolderScore: vi.fn((name: string, trackCount: number, caption: string, isSample: boolean, formatPriority: string[], childFormats: string[] = []) => {
        let score = trackCount * 10;
        if (name.toLowerCase().includes('sample')) score -= 1000000;

        // Mock format priority logic
        if (childFormats.includes('wav')) score += 500000;
        if (childFormats.includes('mp3')) score += 100000;

        return score;
    }),
}));

describe('FolderDiver', () => {
    beforeEach(() => {
        // Reset singleton between tests
        (FolderDiver as any)._instance = null;
    });

    describe('needsDive', () => {
        it('returns true if tree has only folders and no root audio', () => {
            const diver = FolderDiver.getInstance();
            const tree = [
                { type: 'folder' as const, title: 'Dir', children: [] },
            ];
            expect(diver.needsDive(tree)).toBe(true);
        });

        it('returns false if tree has root-level audio', () => {
            const diver = FolderDiver.getInstance();
            const tree = [
                { type: 'folder' as const, title: 'Dir', children: [] },
                { type: 'audio' as const, hash: '1/0', title: 'track.mp3' },
            ];
            expect(diver.needsDive(tree)).toBe(false);
        });

        it('returns false if tree has no folders', () => {
            const diver = FolderDiver.getInstance();
            const tree = [
                { type: 'audio' as const, hash: '1/0', title: 'track.mp3' },
            ];
            expect(diver.needsDive(tree)).toBe(false);
        });

        it('returns false if tree has root-level files that look like audio by extension', () => {
            const tree = [
                { type: 'folder' as const, title: 'Folder', children: [] },
                { type: 'other' as const, hash: '1', title: 'audio.wav' },
            ];
            expect(FolderDiver.getInstance().needsDive(tree)).toBe(false);
        });
    });

    describe('needsDiveFromPath', () => {
        it('returns true when current path has folders but no direct audio', () => {
            const diver = FolderDiver.getInstance();
            const tree = [
                {
                    type: 'folder' as const,
                    title: 'Root',
                    children: [
                        { type: 'folder' as const, title: 'Audio', children: [] },
                    ],
                },
            ];

            expect(diver.needsDiveFromPath(tree, ['Root'])).toBe(true);
        });

        it('returns false when current path has direct audio', () => {
            const diver = FolderDiver.getInstance();
            const tree = [
                {
                    type: 'folder' as const,
                    title: 'Root',
                    children: [
                        { type: 'audio' as const, hash: '1/0', title: 'track.mp3' },
                    ],
                },
            ];

            expect(diver.needsDiveFromPath(tree, ['Root'])).toBe(false);
        });
    });

    describe('dive', () => {
        it('returns no_folders reason when tree has no folders', async () => {
            const diver = FolderDiver.getInstance();
            const tree = [
                { type: 'audio' as const, hash: '1/0', title: 'track.mp3' },
            ];

            const result = await diver.dive(tree);

            expect(result.success).toBe(false);
            expect(result.reason).toBe('no_folders');
        });

        it('dives into folder with audio tracks', async () => {
            const diver = FolderDiver.getInstance();
            const tree = [
                {
                    type: 'folder' as const,
                    title: 'Main',
                    children: [
                        { type: 'audio' as const, hash: '1/0', title: 'track1.mp3' },
                        { type: 'audio' as const, hash: '1/1', title: 'track2.mp3' },
                    ],
                },
            ];

            const result = await diver.dive(tree);

            expect(result.success).toBe(true);
            expect(result.reason).toBe('found_tracks');
            expect(result.path).toEqual(['Main']);
            expect(result.depth).toBe(1);
        });

        it('avoids diving into image-only folders', async () => {
            const diver = FolderDiver.getInstance();
            const tree = [
                {
                    type: 'folder' as const,
                    title: 'Images',
                    children: [
                        { type: 'image' as const, hash: '1/0', title: 'img.jpg' },
                    ],
                },
                {
                    type: 'folder' as const,
                    title: 'Audio',
                    children: [
                        { type: 'audio' as const, hash: '1/1', title: 'track.mp3' },
                    ],
                },
            ];

            const result = await diver.dive(tree);

            expect(result.success).toBe(true);
            expect(result.reason).toBe('found_tracks');
            expect(result.path).toEqual(['Audio']);
        });

        it('prioritizes folder with wav files over mp3 files based on content', async () => {
            const diver = FolderDiver.getInstance();
            diver.setFormatPriority(['wav', 'mp3']);

            const tree = [
                {
                    type: 'folder' as const,
                    title: 'Folder A',
                    children: [
                        { type: 'audio' as const, hash: '1/0', title: 'track.mp3' },
                    ],
                },
                {
                    type: 'folder' as const,
                    title: 'Folder B',
                    children: [
                        { type: 'audio' as const, hash: '1/1', title: 'track.wav' },
                    ],
                },
            ];

            const result = await diver.dive(tree);

            expect(result.success).toBe(true);
            expect(result.path).toEqual(['Folder B']);
        });

        it('does not dive if only image folders exist', async () => {
            const diver = FolderDiver.getInstance();
            const tree = [
                {
                    type: 'folder' as const,
                    title: 'Images',
                    children: [
                        { type: 'image' as const, hash: '1/0', title: 'img.jpg' },
                    ],
                },
            ];

            const result = await diver.dive(tree);

            expect(result.success).toBe(false);
            expect(result.reason).toBe('no_best_folder');
        });
    });

    describe('navigation', () => {
        it('getPath returns empty array after reset', () => {
            const diver = FolderDiver.getInstance();
            diver.reset();
            expect(diver.getPath()).toEqual([]);
        });

        it('navigateUp returns false at root', async () => {
            const diver = FolderDiver.getInstance();
            diver.reset();
            expect(await diver.navigateUp()).toBe(false);
        });
    });
});
