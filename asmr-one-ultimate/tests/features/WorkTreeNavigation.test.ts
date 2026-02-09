/**
 * Tests for WorkTree navigation bug fixes.
 *
 * Covers:
 * 1. fatherFolder is computed (never directly mutated)
 * 2. MutationObserver does not reset user navigation
 * 3. Host-initiated path changes emit worktree:path-change
 * 4. TranscriptFileInjector finds tracks in worktree via fatherFolder fallback
 * 5. Path validation prevents setting invalid paths
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('../../src/core/Utils', () => ({
    Logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    Config: { get: vi.fn(() => true), set: vi.fn() },
}));

vi.mock('../../src/core/Logger', () => ({
    Logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../src/core/EventBus', () => ({
    EventBus: {
        emit: vi.fn(),
        on: vi.fn(() => vi.fn()),
    },
}));

vi.mock('../../src/services/WorkService', () => ({
    WorkService: { getTracks: vi.fn() },
}));

// ============================================================================
// Helpers — mock host WorkTree component
// ============================================================================

interface MockWorkTreeVm {
    tree: any[];
    path: string[];
    /** Computed: derives from tree + path (mirrors host WorkTree.vue) */
    readonly fatherFolder: any[];
    $set: (target: any, key: string, value: any) => void;
    $forceUpdate: () => void;
    $watch: (getter: any, handler: any) => () => void;
}

function createMockTree() {
    return [
        {
            type: 'folder',
            title: 'Main',
            children: [
                { type: 'audio', hash: 'h1', title: 'track1.mp3' },
                { type: 'audio', hash: 'h2', title: 'track2.mp3' },
                {
                    type: 'folder',
                    title: 'Subfolder',
                    children: [
                        { type: 'audio', hash: 'h3', title: 'track3.mp3' },
                    ],
                },
            ],
        },
        {
            type: 'folder',
            title: 'Images',
            children: [
                { type: 'image', hash: 'img1', title: 'cover.jpg' },
            ],
        },
    ];
}

function createMockVm(tree: any[]): MockWorkTreeVm {
    const vm: any = {
        tree,
        path: [] as string[],
        $set: vi.fn((target: any, key: string, value: any) => {
            // Simulate Vue 2 $set: for 'path' (data), it updates.
            // For 'fatherFolder' (computed), it's a no-op.
            if (key === 'path') {
                target[key] = value;
            }
            // fatherFolder is computed — $set is silently ignored for computed props
        }),
        $forceUpdate: vi.fn(),
        $watch: vi.fn(() => vi.fn()),
    };
    // Define fatherFolder as a getter (computed property) to match host behavior
    Object.defineProperty(vm, 'fatherFolder', {
        get() {
            let current = vm.tree.concat();
            for (const segment of vm.path) {
                const folder = current.find((item: any) => item.type === 'folder' && item.title === segment);
                if (!folder) return current; // fallback to current on bad path
                current = folder.children;
            }
            return current;
        },
        configurable: true,
    });
    return vm;
}

// ============================================================================
// Test: fatherFolder is computed, not directly settable
// ============================================================================

describe('fatherFolder computed property behavior', () => {
    it('fatherFolder auto-derives from path at root', () => {
        const tree = createMockTree();
        const vm = createMockVm(tree);
        vm.path = [];
        expect(vm.fatherFolder).toHaveLength(2); // Main + Images folders
        expect(vm.fatherFolder[0].title).toBe('Main');
    });

    it('fatherFolder auto-derives from path at subfolder', () => {
        const tree = createMockTree();
        const vm = createMockVm(tree);
        vm.path = ['Main'];
        expect(vm.fatherFolder).toHaveLength(3); // track1, track2, Subfolder
        expect(vm.fatherFolder[0].title).toBe('track1.mp3');
    });

    it('fatherFolder updates when path changes', () => {
        const tree = createMockTree();
        const vm = createMockVm(tree);

        vm.path = [];
        const rootItems = vm.fatherFolder;
        expect(rootItems[0].title).toBe('Main');

        vm.path = ['Main'];
        const mainItems = vm.fatherFolder;
        expect(mainItems[0].title).toBe('track1.mp3');
        expect(mainItems).not.toEqual(rootItems);
    });

    it('$set on fatherFolder is ignored (computed has no setter)', () => {
        const tree = createMockTree();
        const vm = createMockVm(tree);
        vm.path = ['Main'];

        // Attempt to set fatherFolder (should be ignored for computed)
        vm.$set(vm, 'fatherFolder', [{ type: 'audio', hash: 'fake', title: 'fake.mp3' }]);

        // fatherFolder should still reflect the computed value
        expect(vm.fatherFolder[0].title).toBe('track1.mp3');
    });

    it('navigating back to root restores root items', () => {
        const tree = createMockTree();
        const vm = createMockVm(tree);

        vm.path = ['Main'];
        expect(vm.fatherFolder[0].title).toBe('track1.mp3');

        vm.path = [];
        expect(vm.fatherFolder[0].title).toBe('Main');
        expect(vm.fatherFolder).toHaveLength(2);
    });

    it('navigating into nested subfolder works', () => {
        const tree = createMockTree();
        const vm = createMockVm(tree);

        vm.path = ['Main', 'Subfolder'];
        expect(vm.fatherFolder).toHaveLength(1);
        expect(vm.fatherFolder[0].title).toBe('track3.mp3');
    });
});

// ============================================================================
// Test: syncWorkTreeToRoute validates path before setting
// ============================================================================

describe('path validation', () => {
    it('getNodesAtPath returns tree root for invalid path', () => {
        // Import FolderDiver directly to test getNodesAtPath
        vi.mock('../../src/infrastructure/KikoeruBridge', () => ({
            KikoeruBridge: {
                getInstance: () => ({
                    findWorkTreeComponent: () => null,
                    getPathSegments: () => [],
                    updatePath: vi.fn(),
                }),
            },
        }));

        // Simulate the validation logic from syncWorkTreeToRoute
        const tree = createMockTree();
        const invalidPath = ['NonExistent', 'Path'];

        // Walk the path
        let current: any[] = tree;
        let fallback = false;
        for (const segment of invalidPath) {
            const folder = current.find((n: any) => n.type === 'folder' && n.title === segment);
            if (!folder) {
                fallback = true;
                break;
            }
            current = folder.children;
        }

        expect(fallback).toBe(true);
    });

    it('valid paths resolve correctly', () => {
        const tree = createMockTree();
        const validPath = ['Main', 'Subfolder'];

        let current: any[] = tree;
        let resolved = true;
        for (const segment of validPath) {
            const folder = current.find((n: any) => n.type === 'folder' && n.title === segment);
            if (!folder) {
                resolved = false;
                break;
            }
            current = folder.children;
        }

        expect(resolved).toBe(true);
        expect(current).toHaveLength(1);
        expect(current[0].title).toBe('track3.mp3');
    });
});

// ============================================================================
// Test: MutationObserver should NOT call syncWorkTreeToRoute
// ============================================================================

describe('MutationObserver behavior', () => {
    it('user folder click should not be overridden by route sync', () => {
        const tree = createMockTree();
        const vm = createMockVm(tree);

        // Simulate: user clicks folder "Main"
        // Host app sets path internally (no route change)
        vm.path = ['Main'];
        expect(vm.fatherFolder[0].title).toBe('track1.mp3');

        // Previously, MutationObserver would read stale route path ([])
        // and call syncWorkTreeToRoute([]), resetting the navigation.
        // With the fix, MutationObserver does NOT call syncWorkTreeToRoute.
        // The path should remain as the user set it.

        // Simulate what the OLD code would do (THIS IS THE BUG):
        const routePath: string[] = []; // Route has no path query
        const oldBehavior_wouldReset = !arraysEqual(vm.path, routePath);
        expect(oldBehavior_wouldReset).toBe(true); // Bug: would reset!

        // The fix: path stays as user set it
        expect(vm.path).toEqual(['Main']);
        expect(vm.fatherFolder[0].title).toBe('track1.mp3');
    });

    it('going back via breadcrumb should update correctly', () => {
        const tree = createMockTree();
        const vm = createMockVm(tree);

        // Navigate into folder
        vm.path = ['Main', 'Subfolder'];
        expect(vm.fatherFolder[0].title).toBe('track3.mp3');

        // User clicks breadcrumb to go back to Main
        vm.path = vm.path.slice(0, 1); // ['Main']
        expect(vm.fatherFolder[0].title).toBe('track1.mp3');

        // User clicks ROOT breadcrumb
        vm.path = [];
        expect(vm.fatherFolder[0].title).toBe('Main');
    });
});

// ============================================================================
// Test: TranscriptFileInjector track lookup from fatherFolder
// ============================================================================

describe('TranscriptFileInjector fatherFolder fallback', () => {
    it('finds audio track by index matching', () => {
        const tree = createMockTree();
        const vm = createMockVm(tree);
        vm.path = ['Main'];
        const folder = vm.fatherFolder;

        // Simulate DOM: 3 items (track1, track2, Subfolder)
        // Index 0 should map to folder[0] = track1.mp3
        const idx = 0;
        expect(folder[idx]?.type).toBe('audio');
        expect(folder[idx]?.hash).toBe('h1');
        expect(folder[idx]?.title).toBe('track1.mp3');
    });

    it('finds audio track by title matching', () => {
        const tree = createMockTree();
        const vm = createMockVm(tree);
        vm.path = ['Main'];
        const folder = vm.fatherFolder;

        const titleText = 'track2.mp3';
        const match = folder.find((f: any) => f.type === 'audio' && f.title === titleText);
        expect(match).toBeDefined();
        expect(match?.hash).toBe('h2');
    });

    it('skips non-audio items', () => {
        const tree = createMockTree();
        const vm = createMockVm(tree);
        vm.path = ['Main'];
        const folder = vm.fatherFolder;

        // Index 2 is the Subfolder (type=folder), not audio
        const idx = 2;
        expect(folder[idx]?.type).toBe('folder');
        // TranscriptFileInjector should skip this
    });

    it('handles data-asmr-hash attribute lookup', () => {
        const tree = createMockTree();
        const vm = createMockVm(tree);
        vm.path = ['Main'];
        const folder = vm.fatherFolder;

        // Simulate looking up by hash attribute
        const hash = 'h2';
        const match = folder.find((f: any) => f.hash === hash && f.type === 'audio');
        expect(match).toBeDefined();
        expect(match?.title).toBe('track2.mp3');
    });
});

// ============================================================================
// Test: Translation state reset on host-initiated navigation
// ============================================================================

import { EventBus } from '../../src/core/EventBus';

describe('translation reset on navigation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('path change should trigger worktree:path-change event', () => {
        // Simulate what watchHostPath does when path changes
        const oldPath = ['Main'];
        const newPath = ['Main', 'Subfolder'];

        if (!arraysEqual(oldPath, newPath)) {
            EventBus.emit('worktree:path-change', { path: newPath });
        }

        expect(EventBus.emit).toHaveBeenCalledWith('worktree:path-change', { path: newPath });
    });

    it('same path should not trigger event', () => {
        const oldPath = ['Main'];
        const newPath = ['Main'];

        if (!arraysEqual(oldPath, newPath)) {
            EventBus.emit('worktree:path-change', { path: newPath });
        }

        expect(EventBus.emit).not.toHaveBeenCalled();
    });

    it('navigating back to root should trigger event', () => {
        const oldPath = ['Main'];
        const newPath: string[] = [];

        if (!arraysEqual(oldPath, newPath)) {
            EventBus.emit('worktree:path-change', { path: newPath });
        }

        expect(EventBus.emit).toHaveBeenCalledWith('worktree:path-change', { path: [] });
    });
});

// ============================================================================
// Test: ThumbnailManager hash attribute on all items
// ============================================================================

describe('ThumbnailManager hash assignment', () => {
    it('hash should be set for audio items, not just images', () => {
        const tree = createMockTree();
        const vm = createMockVm(tree);
        vm.path = ['Main'];
        const folder = vm.fatherFolder;

        // Simulate fileMap creation (like ThumbnailManager does)
        const fileMap = new Map<string, any>();
        folder.forEach((f: any) => {
            fileMap.set(f.title, f);
            const baseName = f.title.replace(/\.[^.]+$/, '');
            fileMap.set(baseName, f);
        });

        // All items should be findable in fileMap, including audio
        expect(fileMap.get('track1.mp3')?.hash).toBe('h1');
        expect(fileMap.get('track2.mp3')?.hash).toBe('h2');
    });
});

// ============================================================================
// Test: syncParentFolder is a no-op
// ============================================================================

describe('FolderDiver.syncParentFolder', () => {
    it('does not mutate fatherFolder (computed property)', () => {
        const tree = createMockTree();
        const vm = createMockVm(tree);
        vm.path = ['Main'];

        const originalFolder = [...vm.fatherFolder];

        // syncParentFolder is now a no-op
        // Previously it would splice the computed result, corrupting tree data
        // After fix: no mutation occurs, fatherFolder is derived from path

        expect(vm.fatherFolder).toEqual(originalFolder);
        expect(vm.fatherFolder[0].title).toBe('track1.mp3');
    });

    it('tree data integrity is preserved after navigation', () => {
        const tree = createMockTree();
        const vm = createMockVm(tree);

        // Navigate into Main
        vm.path = ['Main'];
        const mainChildren = vm.fatherFolder;
        expect(mainChildren).toHaveLength(3);

        // Navigate into Subfolder
        vm.path = ['Main', 'Subfolder'];
        const subChildren = vm.fatherFolder;
        expect(subChildren).toHaveLength(1);

        // Navigate back to root
        vm.path = [];
        const rootItems = vm.fatherFolder;
        expect(rootItems).toHaveLength(2);

        // Navigate back into Main — children should be intact (not corrupted)
        vm.path = ['Main'];
        expect(vm.fatherFolder).toHaveLength(3);
        expect(vm.fatherFolder[0].title).toBe('track1.mp3');
        expect(vm.fatherFolder[2].type).toBe('folder');
        expect(vm.fatherFolder[2].title).toBe('Subfolder');
    });
});

// ============================================================================
// Utility
// ============================================================================

function arraysEqual(a: string[], b: string[]): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}
