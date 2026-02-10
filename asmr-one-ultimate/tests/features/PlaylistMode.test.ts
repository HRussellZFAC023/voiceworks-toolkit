import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { PlaylistMode } from '../../src/features/playlist/PlaylistMode';
import { EventBus } from '../../src/core/EventBus';
import { Config } from '../../src/core/Utils';
import { KikoeruBridge } from '../../src/infrastructure/KikoeruBridge';
import { WorkService } from '../../src/services/WorkService';

vi.mock('../../src/core/Utils', () => ({
    Logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    Config: { get: vi.fn(), set: vi.fn() },
}));

vi.mock('../../src/features/radio', () => ({
    RadioMode: {
        getInstance: vi.fn(() => ({ isActive: false, disable: vi.fn() })),
    },
}));

vi.mock('../../src/infrastructure/KikoeruBridge', () => ({
    KikoeruBridge: {
        getInstance: vi.fn(),
    },
}));

vi.mock('../../src/features/radio/PlaybackController', () => ({
    PlaybackController: vi.fn(),
}));

vi.mock('../../src/features/FolderDiver', () => ({
    FolderDiver: {
        getInstance: vi.fn(),
    },
}));

vi.mock('../../src/services/WorkService', () => ({
    WorkService: {
        getWork: vi.fn(),
        getTracks: vi.fn(),
    },
}));

describe('PlaylistMode', () => {
    let playlistMode: PlaylistMode;
    let mockBridge: any;
    let mockPlaybackController: any;
    let mockFolderDiver: any;

    beforeEach(async () => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        EventBus.removeAllListeners();

        mockBridge = {
            app: { $watch: vi.fn(() => vi.fn()) },
            route: { path: '/work/RJ00000001', fullPath: '/work/RJ00000001', query: {} },
            player: {
                queue: [],
                playlist: [],
                queueIndex: 0,
                currentTime: 0,
                duration: 0,
            },
            navigateToWork: vi.fn(),
        };
        (KikoeruBridge.getInstance as any).mockReturnValue(mockBridge);

        mockPlaybackController = {
            stopPlayback: vi.fn(),
            getPlayableTracksFromWork: vi.fn(() => []),
            setQueueAndPlay: vi.fn(),
            clickPlayButton: vi.fn(),
        };
        const { PlaybackController } = await import('../../src/features/radio/PlaybackController');
        (PlaybackController as any).mockImplementation(() => mockPlaybackController);

        mockFolderDiver = {
            getHostPath: vi.fn(() => []),
            syncPath: vi.fn(),
            needsDiveFromPath: vi.fn(() => false),
            diveFromPath: vi.fn(),
        };
        const { FolderDiver } = await import('../../src/features/FolderDiver');
        (FolderDiver.getInstance as any).mockReturnValue(mockFolderDiver);

        (Config.get as any).mockImplementation((key: string) => {
            if (key === 'playlistPlayAllInFolder') return false;
            if (key === 'playlistShuffle') return false;
            if (key === 'playlistLoopPlaylist') return false;
            if (key === 'playlistUseFlatTracks') return false;
            if (key === 'playlistAutoFilterFolders') return true;
            return false;
        });

        (PlaylistMode as unknown as { _instance?: PlaylistMode })._instance = undefined;
        Object.defineProperty(window, '__ASMR_PLAYLIST_MODE__', { value: undefined, writable: true });
        playlistMode = PlaylistMode.getInstance();
    });

    afterEach(() => {
        EventBus.removeAllListeners();
        vi.useRealTimers();
    });

    it('advances to next work on track end when playlistPlayAllInFolder is off', () => {
        (playlistMode as unknown as { _isActive: boolean })._isActive = true;
        (playlistMode as unknown as { isNavigating: boolean }).isNavigating = false;
        (playlistMode as unknown as { hasAdvanced: boolean }).hasAdvanced = false;
        (playlistMode as unknown as { playAllInFolder: boolean }).playAllInFolder = false;

        const nextSpy = vi.spyOn(playlistMode, 'next').mockResolvedValue(undefined);
        (playlistMode as unknown as { checkAndAdvance: () => void }).checkAndAdvance();

        expect(nextSpy).toHaveBeenCalledTimes(1);
    });

    it('intercepts host track auto-advance when playlistPlayAllInFolder is off', () => {
        (playlistMode as unknown as { _isActive: boolean })._isActive = true;
        (playlistMode as unknown as { isNavigating: boolean }).isNavigating = false;
        (playlistMode as unknown as { hasAdvanced: boolean }).hasAdvanced = false;
        (playlistMode as unknown as { playAllInFolder: boolean }).playAllInFolder = false;
        (playlistMode as unknown as { lastQueueIndex: number }).lastQueueIndex = 0;

        mockBridge.player.queue = [{ hash: 'a' }, { hash: 'b' }, { hash: 'c' }];
        mockBridge.player.queueIndex = 1;
        mockBridge.player.currentTime = 12;
        mockBridge.player.duration = 120;

        const nextSpy = vi.spyOn(playlistMode, 'next').mockResolvedValue(undefined);
        (playlistMode as unknown as { checkQueuePosition: () => void }).checkQueuePosition();

        expect(nextSpy).toHaveBeenCalledTimes(1);
    });

    it('does not auto-advance mid-queue when playlistPlayAllInFolder is on', () => {
        (playlistMode as unknown as { _isActive: boolean })._isActive = true;
        (playlistMode as unknown as { isNavigating: boolean }).isNavigating = false;
        (playlistMode as unknown as { hasAdvanced: boolean }).hasAdvanced = false;
        (playlistMode as unknown as { playAllInFolder: boolean }).playAllInFolder = true;
        (playlistMode as unknown as { lastQueueIndex: number }).lastQueueIndex = 0;

        mockBridge.player.queue = [{ hash: 'a' }, { hash: 'b' }, { hash: 'c' }];
        mockBridge.player.queueIndex = 1;
        mockBridge.player.currentTime = 12;
        mockBridge.player.duration = 120;

        const nextSpy = vi.spyOn(playlistMode, 'next').mockResolvedValue(undefined);
        (playlistMode as unknown as { checkQueuePosition: () => void }).checkQueuePosition();

        expect(nextSpy).not.toHaveBeenCalled();
    });

    it('uses playlistUseFlatTracks to build queue from full track tree', async () => {
        (Config.get as any).mockImplementation((key: string) => {
            if (key === 'playlistUseFlatTracks') return true;
            if (key === 'playlistShuffle') return false;
            return false;
        });

        (playlistMode as unknown as { _isActive: boolean })._isActive = true;
        (playlistMode as unknown as { workIds: string[] }).workIds = ['RJ00000001'];
        (playlistMode as unknown as { currentWorkIndex: number }).currentWorkIndex = 0;

        (WorkService.getWork as any).mockResolvedValue({
            id: 1,
            title: 'Test Work',
            dirs: [],
        });
        (WorkService.getTracks as any).mockResolvedValue([
            {
                type: 'folder',
                title: 'Main',
                children: [
                    { type: 'audio', hash: 'track-1', title: 'Track 1', is_audio: true },
                    { type: 'audio', hash: 'track-2', title: 'Track 2', is_audio: true },
                ],
            },
        ]);

        await (playlistMode as unknown as { loadWorkAndStartPlayback: (workId: string) => Promise<void> }).loadWorkAndStartPlayback('RJ00000001');

        expect(WorkService.getTracks).toHaveBeenCalledWith('RJ00000001');
        expect(mockPlaybackController.setQueueAndPlay).toHaveBeenCalledTimes(1);
        expect((mockPlaybackController.setQueueAndPlay as any).mock.calls[0][0]).toHaveLength(2);
    });
});
