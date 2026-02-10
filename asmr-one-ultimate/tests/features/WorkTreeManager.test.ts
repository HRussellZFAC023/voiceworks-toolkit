import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let pathCalls = 0;
let autoFilterFolders = true;
const routeUnwatch = vi.fn();
const hostPathUnwatch = vi.fn();
const flatViewPrefetch = vi.fn();
const flatViewEnable = vi.fn();
const flatViewDisable = vi.fn();
const appWatch = vi.fn((expr: unknown) => {
    if (expr === '$route') return routeUnwatch;
    return hostPathUnwatch;
});
const bridgeMock = {
    app: { $watch: appWatch },
    route: { path: '/work/RJ111', query: {}, fullPath: '/work/RJ111' },
    currentWorkId: 'RJ111',
    workTreeVm: null as unknown,
    invalidateWorkTreeCache: vi.fn(),
    findWorkTreeComponent: vi.fn(() => ({
        tree: [{ type: 'folder', title: 'Audio', children: [] }],
        path: [],
        fatherFolder: [],
        $watch: vi.fn(() => vi.fn()),
        $on: vi.fn(),
        $forceUpdate: vi.fn(),
        _vnode: {},
    })),
};

vi.mock('../../src/core/Utils', () => ({
    Logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    Config: {
        get: vi.fn((key: string) => key === 'autoFilterFolders' ? autoFilterFolders : true),
        set: vi.fn(),
    },
}));

vi.mock('../../src/features/FolderDiver', () => ({
    FolderDiver: {
        getInstance: () => ({
            getHostPath: () => {
                pathCalls += 1;
                return pathCalls % 2 === 0 ? ['A'] : [];
            },
            syncPath: vi.fn(),
            getNodesAtPath: vi.fn((tree: unknown) => tree),
            hasDirectAudio: vi.fn(() => false),
            needsDiveFromPath: vi.fn(() => false),
            diveFromPath: vi.fn(),
            reset: vi.fn(),
        }),
    },
}));

vi.mock('../../src/infrastructure/KikoeruBridge', () => ({
    KikoeruBridge: {
        getInstance: () => bridgeMock,
    },
}));

vi.mock('../../src/features/FlatViewController', () => ({
    FlatViewController: class {
        enable() { flatViewEnable(); }
        disable() { flatViewDisable(); }
        prefetch(workId: string) { flatViewPrefetch(workId); }
    },
}));

import { WorkTreeManager } from '../../src/features/WorkTreeManager';

describe('WorkTreeManager', () => {
    beforeEach(() => {
        pathCalls = 0;
        autoFilterFolders = true;
        routeUnwatch.mockReset();
        hostPathUnwatch.mockReset();
        appWatch.mockClear();
        bridgeMock.findWorkTreeComponent.mockClear();
        bridgeMock.invalidateWorkTreeCache.mockClear();
        flatViewPrefetch.mockReset();
        flatViewEnable.mockReset();
        flatViewDisable.mockReset();
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

    it('cleans up route/path watchers and manual nav listeners on disable', () => {
        autoFilterFolders = false;
        const addSpy = vi.spyOn(document, 'addEventListener');
        const removeSpy = vi.spyOn(document, 'removeEventListener');

        const manager = WorkTreeManager.getInstance();
        manager.enable();
        manager.disable();

        expect(appWatch).toHaveBeenCalled();
        expect(routeUnwatch).toHaveBeenCalledTimes(1);
        expect(hostPathUnwatch).toHaveBeenCalledTimes(1);
        expect(addSpy).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
        expect(addSpy).toHaveBeenCalledWith('keydown', expect.any(Function), true);
        expect(removeSpy).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
        expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function), true);
        expect(bridgeMock.invalidateWorkTreeCache).toHaveBeenCalledTimes(1);
        expect(flatViewEnable).toHaveBeenCalledTimes(1);
        expect(flatViewDisable).toHaveBeenCalledTimes(1);

        addSpy.mockRestore();
        removeSpy.mockRestore();
    });

    it('resets route state on disable so re-enable re-handshakes same work route', () => {
        autoFilterFolders = false;
        const manager = WorkTreeManager.getInstance();

        manager.enable();
        manager.disable();
        manager.enable();

        expect(flatViewPrefetch).toHaveBeenCalledTimes(2);
        expect(flatViewPrefetch).toHaveBeenNthCalledWith(1, 'RJ111');
        expect(flatViewPrefetch).toHaveBeenNthCalledWith(2, 'RJ111');
    });
});
