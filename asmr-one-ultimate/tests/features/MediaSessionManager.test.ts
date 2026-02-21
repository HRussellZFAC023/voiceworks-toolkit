import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/infrastructure/KikoeruBridge', () => ({
    KikoeruBridge: {
        getInstance: () => ({
            store: {
                state: { AudioPlayer: {} },
                watch: vi.fn(),
            },
        }),
    },
}));

import { MediaSessionManager } from '../../src/features/MediaSessionManager';

describe('MediaSessionManager', () => {
    beforeEach(() => {
        document.head.innerHTML = '';
        document.body.innerHTML = '';
    });

    it('prefers inline artwork before remote URLs', () => {
        const manager = new MediaSessionManager() as any;
        const remote = 'https://example.com/cover.jpg';
        const inline = 'data:image/jpeg;base64,AAA';

        const artwork = manager.buildArtwork([remote], inline) as MediaImage[];
        expect(artwork.length).toBeGreaterThan(0);
        expect(artwork[0].src).toBe(inline);
        expect(artwork.some((item) => item.src === remote)).toBe(true);
    });

    it('resolves and deduplicates cover candidates from store/dom/favicon', () => {
        document.body.innerHTML = `
            <div class="audio-player">
                <div class="albumart">
                    <div class="q-img__image" style="background-image: url('/api/cover/123.jpg')"></div>
                </div>
            </div>
        `;
        const icon = document.createElement('link');
        icon.rel = 'icon';
        icon.href = '/favicon.ico';
        document.head.appendChild(icon);

        const manager = new MediaSessionManager() as any;
        const track = { cover: '/api/cover/123.jpg' };
        const work = { id: 123, mainCoverUrl: '/api/cover/123.jpg' };
        const candidates = manager.resolveCoverCandidates(track, work) as string[];

        expect(candidates.length).toBeGreaterThan(0);
        expect(candidates[0]).toMatch(/^https?:\/\//);
        expect(new Set(candidates).size).toBe(candidates.length);
        expect(candidates.some((url) => url.includes('/api/cover/123.jpg'))).toBe(true);
        expect(candidates.some((url) => url.includes('/favicon.ico'))).toBe(true);
    });

    it('uses DOM now-playing labels when track/work store values are temporarily missing', () => {
        document.body.innerHTML = `
            <div class="audio-player">
                <div class="text-bold ellipsis-2-lines">Track from DOM</div>
                <div class="text-caption">Work from DOM</div>
            </div>
        `;

        const manager = new MediaSessionManager() as any;
        const metadata = manager.resolveMetadataText(undefined, undefined);

        expect(metadata.title).toBe('Track from DOM');
        expect(metadata.artist).toBe('Work from DOM');
        expect(metadata.album).toBe('Work from DOM');
    });

    it('prefers work title as artist and circle name as album for lockscreen metadata', () => {
        const manager = new MediaSessionManager() as any;
        const metadata = manager.resolveMetadataText(
            { title: 'Track Name' } as any,
            { title: 'Work Title', name: 'Circle Alias', circle: { name: 'Circle Name' } } as any
        );

        expect(metadata.title).toBe('Track Name');
        expect(metadata.artist).toBe('Work Title');
        expect(metadata.album).toBe('Circle Name');
    });
});
