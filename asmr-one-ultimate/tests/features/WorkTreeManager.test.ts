import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let pathCalls = 0;

vi.mock('../../src/core/Utils', () => ({
    Logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    Config: { get: vi.fn(() => true), set: vi.fn() },
}));

vi.mock('../../src/features/FolderDiver', () => ({
    FolderDiver: {
        getInstance: () => ({
            getHostPath: () => {
                pathCalls += 1;
                return pathCalls % 2 === 0 ? ['A'] : [];
            },
        }),
    },
}));

vi.mock('../../src/infrastructure/KikoeruBridge', () => ({
    KikoeruBridge: {
        getInstance: () => ({
            findWorkTreeComponent: () => ({
                tree: [
                    { type: 'folder', title: 'Audio', children: [] },
                ],
            }),
        }),
    },
}));

vi.mock('../../src/features/FlatViewController', () => ({
    FlatViewController: class {
        enable() {}
        disable() {}
        prefetch() {}
    },
}));

import { WorkTreeManager } from '../../src/features/WorkTreeManager';

describe('WorkTreeManager', () => {
    beforeEach(() => {
        pathCalls = 0;
        vi.useFakeTimers();
        (WorkTreeManager as any)._instance = null;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('returns last seen tree/path when host diver never stabilizes', async () => {
        const manager = WorkTreeManager.getInstance();
        (manager as any).diveToken = 1;
        const promise = (manager as any).waitForHostDiver(1);
        await vi.advanceTimersByTimeAsync(9000);
        const result = await promise;

        expect(result).not.toBeNull();
        expect(result.tree.length).toBe(1);
    });
});
