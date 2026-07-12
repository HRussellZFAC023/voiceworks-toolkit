import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { eventBusEmit } = vi.hoisted(() => ({ eventBusEmit: vi.fn() }));

let pathCalls = 0;
let autoFilterFolders = true;
const routeUnwatch = vi.fn();
const hostPathUnwatch = vi.fn();
const flatViewPrefetch = vi.fn();
const flatViewEnable = vi.fn();
const flatViewDisable = vi.fn();
const folderDiverReset = vi.fn();
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

vi.mock('../../src/core/EventBus', () => ({
    EventBus: { emit: eventBusEmit, on: vi.fn(() => () => {}) },
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
            reset: folderDiverReset,
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
        document.body.innerHTML = '';
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
        folderDiverReset.mockReset();
        eventBusEmit.mockReset();
        bridgeMock.route = { path: '/work/RJ111', query: {}, fullPath: '/work/RJ111' };
        bridgeMock.currentWorkId = 'RJ111';
        vi.useFakeTimers();
        (WorkTreeManager as any)._instance = null;
    });

    afterEach(() => {
        (WorkTreeManager as unknown as { _instance?: WorkTreeManager })._instance?.disable();
        vi.clearAllTimers();
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
        expect(folderDiverReset).toHaveBeenCalledTimes(2);

        addSpy.mockRestore();
        removeSpy.mockRestore();
    });

    it('invalidates deferred folder navigation before handling a new work', () => {
        const manager = WorkTreeManager.getInstance();

        manager.enable();
        (manager as any).handleWorkRoute('RJ222');

        expect(folderDiverReset).toHaveBeenCalledTimes(2);
        expect(flatViewPrefetch).toHaveBeenNthCalledWith(2, 'RJ222');
    });

    it('cancels the missing-tree observer retry on disable', async () => {
        bridgeMock.route = { path: '/settings', query: {}, fullPath: '/settings' };
        bridgeMock.currentWorkId = '';
        const manager = WorkTreeManager.getInstance();

        manager.enable();
        expect((manager as any).treeObserverRetry).not.toBeNull();

        manager.disable();
        const tree = document.createElement('div');
        tree.id = 'work-tree';
        document.body.appendChild(tree);
        await vi.advanceTimersByTimeAsync(200);

        expect((manager as any).treeObserverRetry).toBeNull();
        expect((manager as any).treeObserver).toBeNull();
    });

    it('attaches the observer retry only while the feature remains enabled', async () => {
        bridgeMock.route = { path: '/settings', query: {}, fullPath: '/settings' };
        bridgeMock.currentWorkId = '';
        const manager = WorkTreeManager.getInstance();
        manager.enable();

        const tree = document.createElement('div');
        tree.id = 'work-tree';
        document.body.appendChild(tree);
        await vi.advanceTimersByTimeAsync(200);

        expect((manager as any).treeObserverRetry).toBeNull();
        expect((manager as any).treeObserver).toBeInstanceOf(MutationObserver);
    });

    it('detaches Vue hooks and rejects stale callbacks across disable and re-enable', () => {
        bridgeMock.route = { path: '/settings', query: {}, fullPath: '/settings' };
        bridgeMock.currentWorkId = '';
        const handlers = new Map<string, Array<() => void>>();
        const unwatch = vi.fn();
        const treeVm = {
            path: [],
            tree: [],
            fatherFolder: [],
            _vnode: {},
            $forceUpdate: vi.fn(),
            $watch: vi.fn(() => unwatch),
            $on: vi.fn((event: string, callback: () => void) => {
                const registered = handlers.get(event) || [];
                registered.push(callback);
                handlers.set(event, registered);
            }),
            $off: vi.fn(),
        };
        const workTree = document.createElement('div');
        workTree.id = 'work-tree';
        document.body.appendChild(workTree);

        const manager = WorkTreeManager.getInstance();
        manager.enable();
        (manager as any).installTreeHooks(treeVm);
        const oldUpdated = handlers.get('hook:updated')?.[0];
        expect(oldUpdated).toBeTypeOf('function');
        oldUpdated?.();
        expect(eventBusEmit).toHaveBeenCalledTimes(1);

        manager.disable();
        expect(unwatch).toHaveBeenCalledOnce();
        expect(treeVm.$off).toHaveBeenCalledTimes(3);
        oldUpdated?.();
        expect(eventBusEmit).toHaveBeenCalledTimes(1);

        manager.enable();
        (manager as any).installTreeHooks(treeVm);
        const newUpdated = handlers.get('hook:updated')?.[1];
        oldUpdated?.();
        newUpdated?.();
        expect(eventBusEmit).toHaveBeenCalledTimes(2);
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
