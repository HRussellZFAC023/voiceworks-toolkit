/**
 * PlayerFullscreenController - Mounts the PlayerFullscreen Vue SFC
 * into the audio player element.
 *
 * Extends FeatureController which handles CentralObserver registration,
 * injection point discovery, and mount/unmount lifecycle.
 *
 * Additional responsibility: when the host app re-creates the .audio-player
 * DOM element while fullscreen is active, re-syncs the fullscreen CSS class
 * via the mounted component's exposed `syncFullscreenClass()` method.
 */

import { type Component, type Ref } from 'vue';
import { FeatureController } from './FeatureController';
import PlayerFullscreenVue from './components/PlayerFullscreen.vue';

/** Shape of the methods exposed by PlayerFullscreen.vue via defineExpose */
interface PlayerFullscreenExposed {
    syncFullscreenClass?: () => void;
    isFullscreen?: Ref<boolean>;
    toggleFullscreen?: () => void;
    exit?: () => void;
}

export class PlayerFullscreenController extends FeatureController {
    private static instance: PlayerFullscreenController;

    private constructor() {
        super('asmr-player-fullscreen-root');
    }

    public static getInstance(): PlayerFullscreenController {
        if (!PlayerFullscreenController.instance) {
            PlayerFullscreenController.instance = new PlayerFullscreenController();
        }
        return PlayerFullscreenController.instance;
    }

    get component(): Component {
        return PlayerFullscreenVue;
    }

    protected get debounceMs(): number {
        return 500;
    }

    protected get insertMode(): 'append' | 'prepend' | 'after' | 'before' {
        return 'append';
    }

    findInjectionPoint(): HTMLElement | null {
        return document.querySelector('.audio-player') as HTMLElement | null;
    }

    /**
     * Override tryInject to additionally re-sync the fullscreen CSS class
     * on the .audio-player element when it's re-created by the host app.
     */
    protected tryInject(): void {
        super.tryInject();
        this.syncFullscreenOnComponent();
    }

    /**
     * Access the mounted Vue component instance and call its
     * syncFullscreenClass() method to re-apply the CSS class
     * if the .audio-player element was re-created.
     */
    private syncFullscreenOnComponent(): void {
        if (!this.mounted) return;

        try {
            const exposed = this.mounted.proxy as unknown as PlayerFullscreenExposed;
            exposed?.syncFullscreenClass?.();
        } catch {
            // Component may not be ready yet
        }
    }

    /**
     * Expose the active state for external consumers (e.g., KeyboardManager).
     */
    public get active(): boolean {
        if (!this.mounted) return false;
        try {
            const exposed = this.mounted.proxy as unknown as PlayerFullscreenExposed;
            return exposed?.isFullscreen?.value === true;
        } catch {
            return false;
        }
    }

    /**
     * Programmatically toggle fullscreen (e.g., called by KeyboardManager).
     */
    public toggle(): void {
        if (!this.mounted) return;
        try {
            const exposed = this.mounted.proxy as unknown as PlayerFullscreenExposed;
            exposed?.toggleFullscreen?.();
        } catch {
            // Component may not be ready
        }
    }

    /**
     * Programmatically exit fullscreen (e.g., called by other features).
     */
    public exit(): void {
        if (!this.mounted) return;
        try {
            const exposed = this.mounted.proxy as unknown as PlayerFullscreenExposed;
            exposed?.exit?.();
        } catch {
            // Component may not be ready
        }
    }
}
