import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlaylistDiscovery } from '../../src/features/PlaylistDiscovery';

vi.mock('../../src/infrastructure/KikoeruBridge', () => ({
    KikoeruBridge: {
        getInstance: vi.fn(() => ({
            route: { path: '/playlists' },
            app: { $watch: vi.fn() }
        }))
    }
}));

describe('PlaylistDiscovery', () => {
    let instance: PlaylistDiscovery;

    beforeEach(() => {
        // @ts-ignore - reset singleton
        PlaylistDiscovery.instance = null;
        instance = PlaylistDiscovery.getInstance();
    });

    it('is singleton', () => {
        const instance2 = PlaylistDiscovery.getInstance();
        expect(instance).toBe(instance2);
    });

    it('returns correct card class', () => {
        expect(instance.getCardClass()).toContain('q-card');
    });

    it('returns correct muted text class', () => {
        expect(instance.getMutedTextClass()).toContain('text-grey');
    });

    it('eager-loads lazy images when observer is unavailable', () => {
        // Mock Image so onload fires synchronously when src is set
        const origImage = globalThis.Image;
        globalThis.Image = vi.fn().mockImplementation(() => {
            const img: Record<string, unknown> = {};
            Object.defineProperty(img, 'src', {
                set(_val: string) {
                    if (typeof img.onload === 'function') img.onload(new Event('load'));
                    else if (typeof img.onerror === 'function') img.onerror(new Event('error'));
                }
            });
            return img;
        }) as unknown as typeof Image;

        const root = document.createElement('div');
        root.innerHTML = '<div class="playlist-lazy-image" data-src="https://example.com/test.jpg"></div>';
        const lazyEl = root.querySelector('.playlist-lazy-image') as HTMLElement;

        // @ts-ignore - access private helper for test
        instance.observeLazyImages(root);

        expect(lazyEl.dataset.src).toBeUndefined();
        expect(lazyEl.style.backgroundImage).toContain('https://example.com/test.jpg');

        globalThis.Image = origImage;
    });
});
