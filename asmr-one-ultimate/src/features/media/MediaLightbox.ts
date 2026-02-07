export interface MediaLightboxDeps {
    getModal: () => HTMLElement | null;
    setModal: (modal: HTMLElement) => void;
    hideModal: () => void;
    navigateMedia: (direction: number) => void;
    zoomIn: () => void;
    zoomOut: () => void;
    resetZoom: () => void;
    setZoom: (level: number) => void;
    toggleFullscreen: () => void;
    downloadCurrentMedia: () => void;
    openRawMedia: () => void;
    handleTouchStart: (e: TouchEvent) => void;
    handleTouchMove: (e: TouchEvent) => void;
    handleTouchEnd: (e: TouchEvent) => void;
    getBoundHandleKeydown: () => (e: KeyboardEvent) => void;
    getBoundHandleWheel: () => (e: WheelEvent) => void;
    getBoundHandleMouseDown: () => (e: MouseEvent) => void;
    getBoundHandleMouseMove: () => (e: MouseEvent) => void;
    getBoundHandleMouseUp: () => (e: MouseEvent) => void;
}

export class MediaLightbox {
    private deps: MediaLightboxDeps;

    constructor(deps: MediaLightboxDeps) {
        this.deps = deps;
    }

    ensureModal(): void {
        if (this.deps.getModal()) return;

        const modal = document.createElement('div');
        modal.id = 'asmr-media-viewer-modal';
        modal.className = 'media-viewer-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.innerHTML = `
            <div class="media-viewer-backdrop"></div>
            <div class="media-viewer-container">
                <div class="media-viewer-header">
                    <div class="media-viewer-counter">
                        <span class="media-viewer-current">1</span>
                        <span class="media-viewer-separator">/</span>
                        <span class="media-viewer-total">1</span>
                    </div>
                    <div class="media-viewer-title"></div>
                    <div class="media-viewer-actions">
                        <div class="media-viewer-zoom-controls">
                            <button class="media-viewer-action media-viewer-zoom-out" aria-label="Zoom out" title="Zoom out (-)">
                                <span class="material-icons">remove</span>
                            </button>
                            <input type="range" class="media-viewer-zoom-slider" min="50" max="400" value="100" step="10" title="Zoom level">
                            <button class="media-viewer-action media-viewer-zoom-in" aria-label="Zoom in" title="Zoom in (+)">
                                <span class="material-icons">add</span>
                            </button>
                            <div class="media-viewer-zoom-indicator">100%</div>
                            <button class="media-viewer-action media-viewer-zoom-reset" aria-label="Reset zoom" title="Reset zoom (0)">
                                <span class="material-icons">fit_screen</span>
                            </button>
                        </div>
                        <button class="media-viewer-action media-viewer-fullscreen" aria-label="Toggle fullscreen" title="Fullscreen (F)">
                            <span class="material-icons">fullscreen</span>
                        </button>
                        <button class="media-viewer-action media-viewer-download" aria-label="Download" title="Download">
                            <span class="material-icons">download</span>
                        </button>
                        <button class="media-viewer-action media-viewer-raw" aria-label="Open raw" title="Open raw image in new tab">
                            <span class="material-icons">open_in_new</span>
                        </button>
                        <button class="media-viewer-action media-viewer-close" aria-label="Close" title="Close (Esc)">
                            <span class="material-icons">close</span>
                        </button>
                    </div>
                </div>
                <div class="media-viewer-body">
                    <div class="media-viewer-content">
                        <button class="media-viewer-nav media-viewer-prev" aria-label="Previous (&#8592;)">
                            <span class="material-icons">chevron_left</span>
                        </button>
                        <div class="media-viewer-loader">
                            <span class="material-icons spinning">refresh</span>
                        </div>
                        <div class="media-viewer-media-wrapper"></div>
                        <button class="media-viewer-nav media-viewer-next" aria-label="Next (&#8594;)">
                            <span class="material-icons">chevron_right</span>
                        </button>
                    </div>
                </div>
                <div class="media-viewer-thumbnails"></div>
            </div>
        `;
        document.body.appendChild(modal);

        this.deps.setModal(modal);
        this.setupModalEvents(modal);
    }

    private setupModalEvents(modal: HTMLElement): void {
        const backdrop = modal.querySelector('.media-viewer-backdrop');
        const body = modal.querySelector('.media-viewer-body');
        const closeBtn = modal.querySelector('.media-viewer-close');
        const prevBtn = modal.querySelector('.media-viewer-prev');
        const nextBtn = modal.querySelector('.media-viewer-next');
        const zoomInBtn = modal.querySelector('.media-viewer-zoom-in');
        const zoomOutBtn = modal.querySelector('.media-viewer-zoom-out');
        const zoomResetBtn = modal.querySelector('.media-viewer-zoom-reset');
        const zoomSlider = modal.querySelector('.media-viewer-zoom-slider') as HTMLInputElement;
        const fullscreenBtn = modal.querySelector('.media-viewer-fullscreen');
        const downloadBtn = modal.querySelector('.media-viewer-download');
        const content = modal.querySelector('.media-viewer-content');
        const mediaWrapper = modal.querySelector('.media-viewer-media-wrapper') as HTMLElement;

        // Close on backdrop click
        backdrop?.addEventListener('click', () => this.deps.hideModal());

        // Close on body click (outside the image)
        body?.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;
            // Only close if clicking directly on body, not on nav buttons or content
            if (target === body || target.classList.contains('media-viewer-content')) {
                this.deps.hideModal();
            }
        });

        closeBtn?.addEventListener('click', () => this.deps.hideModal());
        prevBtn?.addEventListener('click', (e) => { e.stopPropagation(); this.deps.navigateMedia(-1); });
        nextBtn?.addEventListener('click', (e) => { e.stopPropagation(); this.deps.navigateMedia(1); });
        zoomInBtn?.addEventListener('click', (e) => { e.stopPropagation(); this.deps.zoomIn(); });
        zoomOutBtn?.addEventListener('click', (e) => { e.stopPropagation(); this.deps.zoomOut(); });
        zoomResetBtn?.addEventListener('click', (e) => { e.stopPropagation(); this.deps.resetZoom(); });
        zoomSlider?.addEventListener('input', (e) => {
            e.stopPropagation();
            this.deps.setZoom(parseInt((e.target as HTMLInputElement).value, 10) / 100);
        });
        fullscreenBtn?.addEventListener('click', (e) => { e.stopPropagation(); this.deps.toggleFullscreen(); });
        downloadBtn?.addEventListener('click', (e) => { e.stopPropagation(); this.deps.downloadCurrentMedia(); });
        const rawBtn = modal.querySelector('.media-viewer-raw');
        rawBtn?.addEventListener('click', (e) => { e.stopPropagation(); this.deps.openRawMedia(); });

        // Touch events for swipe
        content?.addEventListener('touchstart', (e) => this.deps.handleTouchStart(e as TouchEvent), { passive: true });
        content?.addEventListener('touchmove', (e) => this.deps.handleTouchMove(e as TouchEvent), { passive: false });
        content?.addEventListener('touchend', (e) => this.deps.handleTouchEnd(e as TouchEvent));

        // Keyboard navigation
        document.addEventListener('keydown', this.deps.getBoundHandleKeydown());

        // Mouse wheel zoom
        if (mediaWrapper) {
            mediaWrapper.addEventListener('wheel', this.deps.getBoundHandleWheel() as EventListener, { passive: false });
            mediaWrapper.addEventListener('mousedown', this.deps.getBoundHandleMouseDown() as EventListener);
            mediaWrapper.addEventListener('dragstart', (e) => e.preventDefault());
        }

        // Drag to pan when zoomed (document-level for smooth dragging)
        document.addEventListener('mousemove', this.deps.getBoundHandleMouseMove());
        document.addEventListener('mouseup', this.deps.getBoundHandleMouseUp());
    }
}
