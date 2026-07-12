import { beforeEach, describe, expect, it, vi } from 'vitest';

const { registerMock, unregisterMock, injectThumbnailsMock, bridgeMock } = vi.hoisted(() => ({
    registerMock: vi.fn(),
    unregisterMock: vi.fn(),
    injectThumbnailsMock: vi.fn(),
    bridgeMock: {
        findComponent: vi.fn(() => null),
        watch: vi.fn(() => undefined),
        router: {
            beforeEach: vi.fn(() => vi.fn()),
        },
    },
}));

vi.mock('../../src/infrastructure/KikoeruBridge', () => ({
    KikoeruBridge: {
        getInstance: vi.fn(() => bridgeMock),
    },
}));

vi.mock('../../src/core/CentralObserver', () => ({
    CentralObserver: {
        register: registerMock,
        unregister: unregisterMock,
    },
}));

vi.mock('../../src/core/MountApp', () => ({
    mountApp: vi.fn(() => ({
        app: {},
        unmount: vi.fn(),
    })),
}));

vi.mock('../../src/core/Utils', () => ({
    Logger: {
        log: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

vi.mock('../../src/features/media/ThumbnailManager', () => ({
    ThumbnailManager: class {
        injectThumbnails() { injectThumbnailsMock(); }
        clearStaleThumbnails() { /* no-op for lifecycle tests */ }
    },
}));

import { MediaViewerController } from '../../src/features/MediaViewerController';

describe('MediaViewerController lifecycle cleanup', () => {
    beforeEach(() => {
        vi.useRealTimers();
        document.body.innerHTML = '';
        registerMock.mockReset();
        unregisterMock.mockReset();
        injectThumbnailsMock.mockReset();
        bridgeMock.findComponent.mockReset();
        bridgeMock.findComponent.mockReturnValue(null);
        bridgeMock.watch.mockReset();
        (MediaViewerController as unknown as { _instance: MediaViewerController | null })._instance = null;
    });

    it('disable restores patched WorkTree handler and clears folder watcher', () => {
        const controller = MediaViewerController.getInstance() as unknown as {
            patchWorkTree: (workTree: { onClickItem: (item: unknown) => unknown }) => void;
            disable: () => void;
            folderPathWatcherCleanup?: () => void;
            folderWatcherSetup: boolean;
            activeRequestId: number;
        };

        const originalClick = vi.fn(() => 'original');
        const workTree = { onClickItem: originalClick };
        controller.patchWorkTree(workTree);
        expect(workTree.onClickItem).not.toBe(originalClick);

        const unwatch = vi.fn();
        controller.folderPathWatcherCleanup = unwatch;
        controller.folderWatcherSetup = true;
        const requestIdBeforeDisable = controller.activeRequestId;

        controller.disable();

        expect(unwatch).toHaveBeenCalledTimes(1);
        expect(controller.folderWatcherSetup).toBe(false);
        expect(workTree.onClickItem).toBe(originalClick);
        expect(controller.activeRequestId).toBe(requestIdBeforeDisable + 1);
        expect(unregisterMock).toHaveBeenCalledWith('MediaViewer');
    });

    it('cancels an observer callback delay that was queued before disable', () => {
        vi.useFakeTimers();
        document.body.innerHTML = '<div id="work-tree"></div>';
        const controller = MediaViewerController.getInstance() as unknown as {
            enable: () => void;
            disable: () => void;
            hookWorkTree: () => void;
            watchFolderNavigation: () => void;
        };
        const hookSpy = vi.spyOn(controller, 'hookWorkTree');
        const folderSpy = vi.spyOn(controller, 'watchFolderNavigation');

        controller.enable();
        const observerCallback = registerMock.mock.calls[0][1] as () => void;
        observerCallback();
        controller.disable();
        vi.advanceTimersByTime(200);

        expect(hookSpy).toHaveBeenCalledTimes(1); // initial enable only
        expect(injectThumbnailsMock).not.toHaveBeenCalled();
        expect(folderSpy).not.toHaveBeenCalled();
    });
});
