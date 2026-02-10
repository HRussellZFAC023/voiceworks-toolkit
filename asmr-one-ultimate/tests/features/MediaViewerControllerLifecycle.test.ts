import { beforeEach, describe, expect, it, vi } from 'vitest';

const { unregisterMock, bridgeMock } = vi.hoisted(() => ({
    unregisterMock: vi.fn(),
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
        register: vi.fn(),
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
        injectThumbnails() { /* no-op for lifecycle tests */ }
        clearStaleThumbnails() { /* no-op for lifecycle tests */ }
    },
}));

import { MediaViewerController } from '../../src/features/MediaViewerController';

describe('MediaViewerController lifecycle cleanup', () => {
    beforeEach(() => {
        unregisterMock.mockReset();
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
});
