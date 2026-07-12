import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaybackController } from '../../../src/features/radio/PlaybackController';
import { KikoeruBridge } from '../../../src/infrastructure/KikoeruBridge';
import { getAudioElement } from '../../../src/core/DomUtils';

vi.mock('../../../src/core/Utils', () => ({
    Logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
    Config: { get: vi.fn(() => true), set: vi.fn() },
}));

vi.mock('../../../src/infrastructure/KikoeruBridge', () => ({
    KikoeruBridge: {
        getInstance: vi.fn(),
    },
}));

vi.mock('../../../src/store/AppStore', () => ({
    AppStore: {
        getConfig: vi.fn(() => false),
    },
}));

vi.mock('../../../src/core/WorkUtils', () => ({
    collectTracks: vi.fn(() => []),
    filterAudioTracks: vi.fn((tracks: unknown[]) => tracks),
    selectBestFolder: vi.fn(() => null),
    shuffleInPlace: vi.fn(),
}));

vi.mock('../../../src/core/DomUtils', () => ({
    getAudioElement: vi.fn(),
    findButtonByText: vi.fn(),
    findPlayButtons: vi.fn(() => []),
    findAudioItems: vi.fn(() => []),
}));

describe('PlaybackController', () => {
    let mockBridge: any;
    let mockAudio: any;

    beforeEach(() => {
        vi.clearAllMocks();

        mockBridge = {
            player: {
                queue: [],
                playlist: [],
                currentTrack: null,
                currentPlayingFile: null,
            },
            store: null,
            commit: vi.fn(),
            dispatch: vi.fn(() => Promise.resolve()),
            hasAction: vi.fn(() => false),
            hasMutation: vi.fn((mutation: string) => mutation === 'AudioPlayer/SET_TRACK'),
            requestPlay: vi.fn(() => false),
            requestPause: vi.fn(() => true),
        };
        mockBridge.store = {
            state: { AudioPlayer: mockBridge.player, User: {} },
            _mutations: { 'AudioPlayer/SET_TRACK': [] },
            commit: mockBridge.commit,
        };
        mockBridge.commit.mockImplementation((mutation: string, payload?: any) => {
            if (mutation === 'AudioPlayer/SET_TRACK') {
                mockBridge.player.queueIndex = payload;
            } else if (mutation === 'AudioPlayer/SET_QUEUE') {
                mockBridge.player.queue = payload.queue;
                mockBridge.player.queueIndex = payload.index;
            }
        });
        (KikoeruBridge.getInstance as any).mockReturnValue(mockBridge);

        mockAudio = {
            paused: false,
            currentTime: 12,
            currentSrc: 'https://example.com/old-track.mp3',
            getAttribute: vi.fn((name: string) => (name === 'src' ? 'https://example.com/old-track.mp3' : null)),
            removeAttribute: vi.fn(),
            load: vi.fn(),
            pause: vi.fn(),
            play: vi.fn(() => Promise.resolve()),
        };
        (getAudioElement as any).mockReturnValue(mockAudio);
    });

    it('pauses audio and clears queue when stopping playback (does not strip src)', () => {
        const controller = new PlaybackController();
        controller.stopPlayback();

        expect(mockAudio.pause).not.toHaveBeenCalled();
        // src should NOT be removed — stripping it breaks host app reactivity
        expect(mockAudio.removeAttribute).not.toHaveBeenCalled();
        expect(mockAudio.load).not.toHaveBeenCalled();
        expect(mockBridge.requestPause).toHaveBeenCalledTimes(1);
        expect(mockBridge.commit).toHaveBeenCalledWith('AudioPlayer/SET_QUEUE', { queue: [], index: 0 });
    });

    it('uses exactly one host pause request and does not dispatch pause twice', () => {
        mockBridge.requestPause.mockImplementation(() => {
            void mockBridge.dispatch('AudioPlayer/pause');
            return true;
        });
        const controller = new PlaybackController();

        controller.stopPlayback();

        expect(mockBridge.requestPause).toHaveBeenCalledTimes(1);
        expect(mockBridge.dispatch).toHaveBeenCalledTimes(1);
        expect(mockBridge.dispatch).toHaveBeenCalledWith('AudioPlayer/pause');
        expect(mockAudio.pause).not.toHaveBeenCalled();
    });

    it('falls back to one direct audio pause when the host has no pause contract', () => {
        mockBridge.requestPause.mockReturnValue(false);
        const controller = new PlaybackController();

        controller.stopPlayback();

        expect(mockAudio.pause).toHaveBeenCalledTimes(1);
        expect(mockBridge.dispatch).not.toHaveBeenCalled();
    });

    it('does not call direct audio.play fallback without queue/current track context', async () => {
        const controller = new PlaybackController();
        mockAudio.paused = true;
        mockBridge.player.queue = [];
        mockBridge.player.currentTrack = null;

        await controller.tryPlay();

        expect(mockAudio.play).not.toHaveBeenCalled();
    });

    it('allows direct audio.play fallback when queue exists', async () => {
        const controller = new PlaybackController();
        mockAudio.paused = true;
        mockBridge.player.queue = [{ hash: 'track-1' }];

        await controller.tryPlay();

        expect(mockAudio.play).toHaveBeenCalledTimes(1);
    });

    it('does not treat a recognized store request as proof that paused legacy audio started', async () => {
        const controller = new PlaybackController();
        mockBridge.requestPlay.mockReturnValue(true);
        mockBridge.player.queue = [{ hash: 'track-1' }];
        mockAudio.paused = true;

        await expect(controller.tryPlay()).resolves.toBe(true);

        expect(mockBridge.requestPlay).toHaveBeenCalledTimes(1);
        expect(mockAudio.play).toHaveBeenCalledTimes(1);
    });

    it('can force-play a specific queue track when auto-advance stalls', async () => {
        const controller = new PlaybackController();
        const queue = [
            { hash: 'track-1', title: 'Track 1' },
            { hash: 'track-2', title: 'Track 2' },
        ] as any[];

        // Audio is paused so the fallback play() path fires
        mockAudio.paused = true;

        const ok = await controller.forcePlayQueueTrack(queue as any, 1);

        expect(ok).toBe(true);
        expect(mockBridge.commit).toHaveBeenCalledWith('AudioPlayer/SET_TRACK', 1);
        expect(mockBridge.requestPlay).toHaveBeenCalledTimes(1);
        expect(mockAudio.play).toHaveBeenCalledTimes(1);
    });

    it('routes queue replacement through the stale-index-safe shared contract', async () => {
        mockBridge.player.queueIndex = 9;
        const observedIndexes: number[] = [];
        mockBridge.commit.mockImplementation((mutation: string, payload?: any) => {
            if (mutation === 'AudioPlayer/SET_TRACK') {
                mockBridge.player.queueIndex = payload;
            }
            if (mutation === 'AudioPlayer/SET_QUEUE') {
                observedIndexes.push(mockBridge.player.queueIndex);
                mockBridge.player.queue = payload.queue;
                mockBridge.player.queueIndex = payload.index;
            }
        });
        const controller = new PlaybackController();

        await controller.setQueueAndPlay([
            { type: 'audio', hash: 'new', title: 'New', mediaStreamUrl: '/new' },
        ]);

        expect(observedIndexes).toEqual([0]);
        expect(mockBridge.requestPlay).toHaveBeenCalledTimes(1);
    });

    it('uses an action-only playTrack contract and verifies the requested target', async () => {
        const queue = [
            { type: 'audio', hash: 'track-1', title: 'Track 1', mediaStreamUrl: '/1' },
            { type: 'audio', hash: 'track-2', title: 'Track 2', mediaStreamUrl: '/2' },
        ] as any[];
        mockBridge.hasAction.mockImplementation((action: string) => action === 'AudioPlayer/playTrack');
        mockBridge.dispatch.mockImplementation(async (_action: string, track: any) => {
            mockBridge.player.currentPlayingFile = track;
            mockBridge.player.queueIndex = 1;
        });
        mockAudio.paused = false;
        const controller = new PlaybackController();

        await expect(controller.forcePlayQueueTrack(queue, 1)).resolves.toBe(true);

        expect(mockBridge.dispatch).toHaveBeenCalledWith(
            'AudioPlayer/playTrack',
            expect.objectContaining({ hash: 'track-2' }),
        );
        expect(mockBridge.commit).not.toHaveBeenCalledWith('AudioPlayer/SET_QUEUE', expect.anything());
    });

    it('does not report success when no host contract selects the target', async () => {
        const player = { currentTime: 0, duration: 0 };
        mockBridge.player = player;
        mockBridge.store = {
            state: { AudioPlayer: player, User: {} },
            _mutations: {},
            commit: vi.fn(),
        };
        mockBridge.hasMutation.mockReturnValue(false);
        mockBridge.requestPlay.mockReturnValue(true);
        const controller = new PlaybackController();

        await expect(controller.forcePlayQueueTrack([
            { type: 'audio', hash: 'target', title: 'Target', mediaStreamUrl: '/target' },
        ], 0)).resolves.toBe(false);

        expect(mockAudio.play).not.toHaveBeenCalled();
    });
});
