import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    watch: vi.fn(),
    unwatch: vi.fn(),
    setActionHandler: vi.fn(),
    requestPlay: vi.fn(),
    requestPause: vi.fn(),
    commit: vi.fn(),
    dispatch: vi.fn(async () => undefined),
    hasAction: vi.fn((_action: string) => false),
    hasMutation: vi.fn((mutation: string) =>
        mutation === 'AudioPlayer/PREVIOUS_TRACK' || mutation === 'AudioPlayer/NEXT_TRACK'),
}));

vi.mock('../../src/infrastructure/KikoeruBridge', () => ({
    KikoeruBridge: {
        getInstance: () => ({
            store: {
                state: { AudioPlayer: {} },
                watch: mocks.watch,
                dispatch: mocks.dispatch,
            },
            hasAction: mocks.hasAction,
            hasMutation: mocks.hasMutation,
            requestPlay: mocks.requestPlay,
            requestPause: mocks.requestPause,
            commit: mocks.commit,
        }),
    },
}));

import { MediaSessionManager } from '../../src/features/MediaSessionManager';

describe('MediaSessionManager', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.head.innerHTML = '';
        document.body.innerHTML = '';
        mocks.watch.mockReturnValue(mocks.unwatch);
        mocks.requestPlay.mockReturnValue(true);
        mocks.requestPause.mockReturnValue(true);
        mocks.hasAction.mockReturnValue(false);
        mocks.hasMutation.mockImplementation((mutation: string) =>
            mutation === 'AudioPlayer/PREVIOUS_TRACK' || mutation === 'AudioPlayer/NEXT_TRACK');
        Object.defineProperty(navigator, 'mediaSession', {
            configurable: true,
            value: {
                metadata: null,
                playbackState: 'none',
                setActionHandler: mocks.setActionHandler,
                setPositionState: vi.fn(),
            },
        });
        vi.stubGlobal('MediaMetadata', class MediaMetadata {
            constructor(init: unknown) { Object.assign(this, init); }
        });
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

    it('rejects executable artwork URLs while retaining safe inline images', () => {
        const manager = new MediaSessionManager() as any;
        const candidates = manager.resolveCoverCandidates(
            { cover: 'javascript:alert(1)' },
            { mainCoverUrl: 'data:text/html,<script>alert(2)</script>' },
        ) as string[];
        expect(candidates).toEqual([]);

        const inline = manager.resolveCoverCandidates(
            { cover: 'data:image/png;base64,AAAA' },
            undefined,
        ) as string[];
        expect(inline).toEqual(['data:image/png;base64,AAAA']);
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

    it('does not duplicate lock-screen watchers when toggled repeatedly', () => {
        const manager = new MediaSessionManager();

        manager.enable();
        manager.enable();
        expect(mocks.watch).toHaveBeenCalledTimes(1);

        manager.disable();
        manager.disable();
        expect(mocks.unwatch).toHaveBeenCalledTimes(1);
    });

    it('restores metadata after disable and re-enable', () => {
        const manager = new MediaSessionManager();

        manager.enable();
        expect(navigator.mediaSession.metadata).not.toBeNull();

        manager.disable();
        expect(navigator.mediaSession.metadata).toBeNull();

        manager.enable();
        expect(navigator.mediaSession.metadata).not.toBeNull();
        manager.disable();
    });

    it('keeps registering controls when the browser rejects one action', () => {
        mocks.setActionHandler.mockImplementation((action: string) => {
            if (action === 'seekbackward') throw new DOMException('Unsupported', 'NotSupportedError');
        });
        const manager = new MediaSessionManager();

        expect(() => manager.enable()).not.toThrow();
        expect(mocks.setActionHandler.mock.calls.map(([action]) => action)).toEqual(expect.arrayContaining([
            'play',
            'pause',
            'previoustrack',
            'nexttrack',
            'seekforward',
            'seekto',
        ]));
        expect(() => manager.disable()).not.toThrow();
    });

    it('registers lock-screen actions against current host playback contracts', () => {
        const handlers = new Map<string, (() => void) | null>();
        mocks.setActionHandler.mockImplementation((action: string, handler: (() => void) | null) => {
            handlers.set(action, handler);
        });
        const manager = new MediaSessionManager();

        manager.enable();
        handlers.get('play')?.();
        handlers.get('pause')?.();
        handlers.get('previoustrack')?.();
        handlers.get('nexttrack')?.();

        expect(mocks.requestPlay).toHaveBeenCalledOnce();
        expect(mocks.requestPause).toHaveBeenCalledOnce();
        expect(mocks.commit).toHaveBeenCalledWith('AudioPlayer/PREVIOUS_TRACK');
        expect(mocks.commit).toHaveBeenCalledWith('AudioPlayer/NEXT_TRACK');
        manager.disable();
    });

    it('falls back to legacy Vuex actions for action-only play/pause hosts', async () => {
        const handlers = new Map<string, (() => void) | null>();
        mocks.setActionHandler.mockImplementation((action: string, handler: (() => void) | null) => {
            handlers.set(action, handler);
        });
        mocks.requestPlay.mockReturnValue(false);
        mocks.requestPause.mockReturnValue(false);
        mocks.hasAction.mockImplementation((action: string) =>
            action === 'AudioPlayer/play' || action === 'AudioPlayer/pause');
        const manager = new MediaSessionManager();

        manager.enable();
        handlers.get('play')?.();
        handlers.get('pause')?.();
        await Promise.resolve();

        expect(mocks.dispatch).toHaveBeenCalledWith('AudioPlayer/play', undefined);
        expect(mocks.dispatch).toHaveBeenCalledWith('AudioPlayer/pause', undefined);
        manager.disable();
    });
});
