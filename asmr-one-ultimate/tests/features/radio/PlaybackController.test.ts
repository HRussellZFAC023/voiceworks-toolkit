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
            commit: vi.fn(),
            dispatch: vi.fn(() => Promise.resolve()),
            hasAction: vi.fn(() => false),
        };
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

    it('clears audio source when stopping playback to prevent stale resume', () => {
        const controller = new PlaybackController();
        controller.stopPlayback();

        expect(mockAudio.pause).toHaveBeenCalledTimes(1);
        expect(mockAudio.removeAttribute).toHaveBeenCalledWith('src');
        expect(mockAudio.load).toHaveBeenCalledTimes(1);
        expect(mockBridge.commit).toHaveBeenCalledWith('AudioPlayer/SET_QUEUE', { queue: [], index: 0 });
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
});
