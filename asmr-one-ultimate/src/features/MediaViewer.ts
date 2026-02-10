/**
 * MediaViewer (compatibility wrapper)
 *
 * The legacy imperative MediaViewer implementation has been superseded by
 * MediaViewerController + MediaLightbox.vue. This class remains as a thin
 * compatibility layer for older call sites that still import MediaViewer.
 */

import { MediaViewerController } from './MediaViewerController';

declare const unsafeWindow: Window & typeof globalThis;

type LegacyMediaViewerWindow = Window & typeof globalThis & {
    __ASMR_MEDIA_VIEWER__?: MediaViewer;
};

const globalWindow = (
    typeof unsafeWindow !== 'undefined' ? unsafeWindow : window
) as LegacyMediaViewerWindow;

export class MediaViewer {
    private static _instance: MediaViewer | null = null;
    private controller: MediaViewerController;

    private constructor() {
        this.controller = MediaViewerController.getInstance();
    }

    public static getInstance(): MediaViewer {
        const existing = globalWindow.__ASMR_MEDIA_VIEWER__;
        if (existing) {
            MediaViewer._instance = existing;
            existing.refreshController();
            return existing;
        }

        if (!MediaViewer._instance) {
            MediaViewer._instance = new MediaViewer();
            globalWindow.__ASMR_MEDIA_VIEWER__ = MediaViewer._instance;
        } else {
            MediaViewer._instance.refreshController();
        }

        return MediaViewer._instance;
    }

    public enable(): void {
        this.controller.enable();
    }

    public disable(): void {
        this.controller.disable();
    }

    public showExternalImages(urls: string[], startIndex = 0): void {
        this.controller.showExternalImages(urls, startIndex);
    }

    private refreshController(): void {
        this.controller = MediaViewerController.getInstance();
    }
}
