import { beforeEach, describe, expect, it, vi } from 'vitest';

const controllerMock = {
    enable: vi.fn(),
    disable: vi.fn(),
    showExternalImages: vi.fn(),
};

vi.mock('../../src/features/MediaViewerController', () => ({
    MediaViewerController: {
        getInstance: vi.fn(() => controllerMock),
    },
}));

import { MediaViewer } from '../../src/features/MediaViewer';
import { MediaViewerController } from '../../src/features/MediaViewerController';

describe('MediaViewer compatibility wrapper', () => {
    beforeEach(() => {
        controllerMock.enable.mockReset();
        controllerMock.disable.mockReset();
        controllerMock.showExternalImages.mockReset();
        (MediaViewerController.getInstance as unknown as ReturnType<typeof vi.fn>).mockClear();
        (MediaViewer as unknown as { _instance: MediaViewer | null })._instance = null;
        delete (window as unknown as { __ASMR_MEDIA_VIEWER__?: unknown }).__ASMR_MEDIA_VIEWER__;
    });

    it('returns a stable singleton and stores it on window', () => {
        const first = MediaViewer.getInstance();
        const second = MediaViewer.getInstance();

        expect(first).toBe(second);
        expect((window as unknown as { __ASMR_MEDIA_VIEWER__?: unknown }).__ASMR_MEDIA_VIEWER__).toBe(first);
    });

    it('delegates enable/disable/showExternalImages to MediaViewerController', () => {
        const viewer = MediaViewer.getInstance();
        viewer.enable();
        viewer.disable();
        viewer.showExternalImages(['https://example.com/a.jpg'], 1);

        expect(controllerMock.enable).toHaveBeenCalledTimes(1);
        expect(controllerMock.disable).toHaveBeenCalledTimes(1);
        expect(controllerMock.showExternalImages).toHaveBeenCalledWith(['https://example.com/a.jpg'], 1);
    });

    it('refreshes the controller reference on repeated getInstance calls', () => {
        MediaViewer.getInstance();
        MediaViewer.getInstance();

        expect(MediaViewerController.getInstance).toHaveBeenCalledTimes(2);
    });
});
