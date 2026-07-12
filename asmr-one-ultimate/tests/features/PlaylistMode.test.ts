import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { PlaylistMode } from '../../src/features/playlist/PlaylistMode';
import { EventBus } from '../../src/core/EventBus';
import { Config } from '../../src/core/Utils';
import { KikoeruBridge } from '../../src/infrastructure/KikoeruBridge';
import { WorkService } from '../../src/services/WorkService';
import { PlaylistApi } from '../../src/api/Playlist';
import { registerExclusivePlaybackMode } from '../../src/features/playbackModeCoordinator';

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

vi.mock('../../src/api/Playlist', () => ({
    PlaylistApi: {
        getPlaylistMetadata: vi.fn(),
        getPlaylistWorks: vi.fn(),
    },
}));

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

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
                    { type: 'other', hash: 'track-3', title: 'Track 3.opus' },
                    { type: 'other', hash: 'ignore-1', title: 'Readme.txt' },
                ],
            },
        ]);

        await (playlistMode as unknown as { loadWorkAndStartPlayback: (workId: string) => Promise<void> }).loadWorkAndStartPlayback('RJ00000001');

        expect(WorkService.getTracks).toHaveBeenCalledWith('RJ00000001');
        expect(mockPlaybackController.setQueueAndPlay).toHaveBeenCalledTimes(1);
        expect((mockPlaybackController.setQueueAndPlay as any).mock.calls[0][0]).toHaveLength(1);
        expect((mockPlaybackController.setQueueAndPlay as any).mock.calls[0][0][0]?.hash).toBe('track-1');
    });

    it('keeps the route watcher alive after deactivation so a later playlist URL loads', () => {
        const unwatch = vi.fn();
        mockBridge.app.$watch.mockReturnValue(unwatch);
        playlistMode.initialize();
        playlistMode.activate(['RJ00000001'], 'A', 'A', false);
        const routeCallback = mockBridge.app.$watch.mock.calls[0][1];
        const loadSpy = vi.spyOn(playlistMode, 'loadFromUrl').mockResolvedValue(undefined);

        playlistMode.deactivate();
        mockBridge.route = { path: '/playlist', fullPath: '/playlist?id=B', query: { id: 'B' } };
        routeCallback('/playlist?id=B');

        expect(unwatch).not.toHaveBeenCalled();
        expect(loadSpy).toHaveBeenCalledWith('B');
    });

    it('lets a newer URL playlist B supersede an in-flight playlist A load', async () => {
        const metadataA = deferred<{ name: string }>();
        const metadataB = deferred<{ name: string }>();
        const worksA = deferred<any>();
        const worksB = deferred<any>();
        (PlaylistApi.getPlaylistMetadata as any).mockImplementation((id: string) => (
            id === 'A' ? metadataA.promise : metadataB.promise
        ));
        (PlaylistApi.getPlaylistWorks as any).mockImplementation((id: string) => (
            id === 'A' ? worksA.promise : worksB.promise
        ));

        const loadA = playlistMode.loadFromUrl('A');
        const loadB = playlistMode.loadFromUrl('B');
        metadataB.resolve({ name: 'Playlist B' });
        worksB.resolve({
            works: [{ source_id: 'RJB' }],
            pagination: { totalCount: 1 },
        });
        await loadB;
        metadataA.resolve({ name: 'Playlist A' });
        worksA.resolve({
            works: [{ source_id: 'RJA' }],
            pagination: { totalCount: 1 },
        });
        await loadA;

        expect(playlistMode.getState()).toEqual(expect.objectContaining({
            playlistId: 'B',
            workIds: ['RJB'],
        }));
    });

    it('invalidates an in-flight URL load when the route leaves playlist context', async () => {
        const metadata = deferred<{ name: string }>();
        const works = deferred<any>();
        (PlaylistApi.getPlaylistMetadata as any).mockReturnValue(metadata.promise);
        (PlaylistApi.getPlaylistWorks as any).mockReturnValue(works.promise);
        playlistMode.initialize();
        const routeCallback = mockBridge.app.$watch.mock.calls[0][1];

        const loading = playlistMode.loadFromUrl('A');
        routeCallback('/');
        metadata.resolve({ name: 'Stale playlist' });
        works.resolve({
            works: [{ source_id: 'RJA' }],
            pagination: { totalCount: 1 },
        });
        await loading;

        expect(playlistMode.isActive).toBe(false);
        expect(playlistMode.getState().playlistId).toBeNull();
    });

    it('deactivates radio ownership when a playlist activates', () => {
        const deactivateRadio = vi.fn();
        registerExclusivePlaybackMode('radio', deactivateRadio);

        playlistMode.activate(['RJ00000001'], 'playlist', 'Playlist', false);

        expect(deactivateRadio).toHaveBeenCalledTimes(1);
    });

    it('ignores an old activation that completes after getWork', async () => {
        const oldWork = deferred<any>();
        (WorkService.getWork as any).mockReturnValueOnce(oldWork.promise);
        playlistMode.activate(['RJ00000001'], 'A', 'A', false);

        const staleLoad = (playlistMode as any).loadWorkAndStartPlayback('RJ00000001');
        playlistMode.activate(['RJ00000002'], 'B', 'B', false);
        oldWork.resolve({ id: 'RJ00000001', title: 'Old' });
        await staleLoad;

        expect(WorkService.getTracks).not.toHaveBeenCalled();
        expect(mockPlaybackController.setQueueAndPlay).not.toHaveBeenCalled();
    });

    it('lets newer navigation supersede a getWork still in flight', async () => {
        const workA = deferred<any>();
        const workB = deferred<any>();
        (WorkService.getWork as any).mockImplementation((id: string) => (
            id === 'RJ00000001' ? workA.promise : workB.promise
        ));
        (WorkService.getTracks as any).mockResolvedValue([]);
        mockPlaybackController.getPlayableTracksFromWork.mockImplementation((work: any) => ([{
            type: 'audio',
            hash: work.id,
            title: work.title,
            mediaStreamUrl: `/${work.id}`,
        }]));
        playlistMode.activate(['RJ00000001', 'RJ00000002'], 'P', 'P', false);

        const navigationA = (playlistMode as any).navigateToWork(0);
        const navigationB = (playlistMode as any).navigateToWork(1);
        workB.resolve({ id: 'RJ00000002', title: 'New' });
        await navigationB;
        workA.resolve({ id: 'RJ00000001', title: 'Old' });
        await navigationA;

        expect(mockPlaybackController.setQueueAndPlay).toHaveBeenCalledTimes(1);
        expect(mockPlaybackController.setQueueAndPlay).toHaveBeenCalledWith(
            [expect.objectContaining({ hash: 'RJ00000002' })],
            0,
        );
    });

    it('does not resume stale navigation after getTracks resolves', async () => {
        const tracksA = deferred<any>();
        (WorkService.getWork as any).mockImplementation(async (id: string) => ({ id, title: id }));
        (WorkService.getTracks as any).mockImplementation((id: string) => (
            id === 'RJ00000001' ? tracksA.promise : Promise.resolve([])
        ));
        mockPlaybackController.getPlayableTracksFromWork.mockImplementation((work: any) => ([{
            type: 'audio', hash: work.id, title: work.id, mediaStreamUrl: `/${work.id}`,
        }]));
        playlistMode.activate(['RJ00000001', 'RJ00000002'], 'P', 'P', false);

        const navigationA = (playlistMode as any).navigateToWork(0);
        await Promise.resolve();
        const navigationB = (playlistMode as any).navigateToWork(1);
        await navigationB;
        tracksA.resolve([]);
        await navigationA;

        expect(mockPlaybackController.setQueueAndPlay).toHaveBeenCalledTimes(1);
        expect(mockPlaybackController.setQueueAndPlay).toHaveBeenCalledWith(
            [expect.objectContaining({ hash: 'RJ00000002' })],
            0,
        );
    });

    it('does not resume stale navigation after a folder dive resolves', async () => {
        const diveA = deferred<any>();
        (WorkService.getWork as any).mockImplementation(async (id: string) => ({ id, title: id }));
        (WorkService.getTracks as any).mockResolvedValue([{ type: 'folder', title: 'Main', children: [] }]);
        mockFolderDiver.needsDiveFromPath.mockReturnValue(true);
        mockFolderDiver.diveFromPath
            .mockImplementationOnce(() => diveA.promise)
            .mockResolvedValueOnce({ success: true, reason: 'ok', path: [], depth: 0 });
        mockPlaybackController.getPlayableTracksFromWork.mockImplementation((work: any) => ([{
            type: 'audio', hash: work.id, title: work.id, mediaStreamUrl: `/${work.id}`,
        }]));
        playlistMode.activate(['RJ00000001', 'RJ00000002'], 'P', 'P', false);

        const navigationA = (playlistMode as any).navigateToWork(0);
        await Promise.resolve();
        await Promise.resolve();
        const navigationB = (playlistMode as any).navigateToWork(1);
        await navigationB;
        diveA.resolve({ success: true, reason: 'ok', path: [], depth: 0 });
        await navigationA;

        expect(mockPlaybackController.setQueueAndPlay).toHaveBeenCalledTimes(1);
        expect(mockPlaybackController.setQueueAndPlay).toHaveBeenCalledWith(
            [expect.objectContaining({ hash: 'RJ00000002' })],
            0,
        );
    });
});
