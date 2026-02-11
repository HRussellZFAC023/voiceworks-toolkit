
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RadioMode } from '../../../src/features/radio/RadioMode';
import { EventBus } from '../../../src/core/EventBus';
import { AppStore } from '../../../src/store/AppStore';
import { KikoeruBridge } from '../../../src/infrastructure/KikoeruBridge';
import { FolderDiver } from '../../../src/features/FolderDiver';
import { WorkSelector } from '../../../src/features/radio/WorkSelector';
import { PlaybackController } from '../../../src/features/radio/PlaybackController';

// Mocks
vi.mock('../../../src/core/Logger', () => ({
    Logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    Config: { get: vi.fn((key) => key === 'playAllInFolder') },
}));

vi.mock('../../../src/store/AppStore', () => ({
    AppStore: {
        setRadioState: vi.fn(),
        getRadioState: vi.fn(),
        getConfig: vi.fn((key) => key === 'playAllInFolder'),
    },
}));

vi.mock('../../../src/infrastructure/KikoeruBridge', () => ({
    KikoeruBridge: {
        getInstance: vi.fn(),
    },
}));

vi.mock('../../../src/features/FolderDiver', () => ({
    FolderDiver: {
        getInstance: vi.fn(),
    },
}));

vi.mock('../../../src/features/radio/WorkSelector');
vi.mock('../../../src/features/radio/PlaybackController');
vi.mock('../../../src/services/WorkService', () => ({
    WorkService: {
        getWork: vi.fn(() => new Promise(() => {})), // Never resolves by default
        getTracks: vi.fn(() => new Promise(() => {})),
    }
}));

describe('RadioMode', () => {
    let radioMode: RadioMode;
    let mockBridge: any;
    let mockFolderDiver: any;
    let mockPlaybackController: any;
    let mockWorkSelector: any;

    beforeEach(() => {
        vi.useFakeTimers();

        // Setup Bridge Mock
        mockBridge = {
            store: {
                watch: vi.fn(),
            },
            app: {
                $watch: vi.fn(),
            },
            route: {
                path: '/work/RJ123456',
                params: { id: 'RJ123456' }
            },
            player: {
                currentTrack: null,
                queue: [],
                queueIndex: 0,
            },
            currentWorkId: 'RJ123456',
            currentWork: null,
            navigateToWork: vi.fn(),
        };
        (KikoeruBridge.getInstance as any).mockReturnValue(mockBridge);

        // Setup FolderDiver Mock
        mockFolderDiver = {
            reset: vi.fn(),
            needsDive: vi.fn().mockReturnValue(false),
            dive: vi.fn(),
        };
        (FolderDiver.getInstance as any).mockReturnValue(mockFolderDiver);

        // Setup PlaybackController Mock
        mockPlaybackController = {
            stopPlayback: vi.fn(),
            getPlayableTracksFromWork: vi.fn().mockReturnValue([]),
            shuffleAndPlay: vi.fn(),
            setQueueAndPlay: vi.fn(),
            clickPlayButton: vi.fn(),
            tryPlay: vi.fn(),
        };
        (PlaybackController as any).mockImplementation(() => mockPlaybackController);

        // Setup WorkSelector Mock
        mockWorkSelector = {
            selectRandomWork: vi.fn(),
            rememberWork: vi.fn(),
            getRecentWorkIds: vi.fn(() => []),
        };
        (WorkSelector as any).mockImplementation(() => mockWorkSelector);

        // Reset singleton
        (RadioMode as any)._instance = null;
        Object.defineProperty(window, '__ASMR_RADIO_MODE__', { value: undefined, writable: true });

        radioMode = RadioMode.getInstance();
    });

    afterEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
    });

    it('should wait for work data to load before diving/playing', async () => {
        // Initialize and Enable
        radioMode.initialize();
        radioMode.enable();

        // Mock the route watcher callback capture
        const routeWatcherCallback = mockBridge.app.$watch.mock.calls[0][1];

        // Trigger Route Change
        routeWatcherCallback('/work/RJ999999');

        // At this point, we are in the debounce period (500ms)
        await vi.advanceTimersByTimeAsync(500);

        // Verify we haven't tried to play yet (work data not loaded)
        expect(mockFolderDiver.dive).not.toHaveBeenCalled();
        expect(mockPlaybackController.getPlayableTracksFromWork).not.toHaveBeenCalled();

        // Advance further - loadWorkAndStartPlayback fires but WorkApi is not mocked
        // so it won't reach the playback stage
        await vi.advanceTimersByTimeAsync(2000);

        expect(mockPlaybackController.getPlayableTracksFromWork).not.toHaveBeenCalled();
    });

    it('should react to work:change event', async () => {
        // Initialize and Enable
        radioMode.initialize();
        radioMode.enable();

        // Mock the route watcher callback capture
        const routeWatcherCallback = mockBridge.app.$watch.mock.calls[0][1];

        // Trigger Route Change
        routeWatcherCallback('/work/RJ999999');
        await vi.advanceTimersByTimeAsync(500); // Pass debounce

        // Simulate Work Data becoming available via EventBus
        const workData = { id: 'RJ999999', title: 'New Work', dirs: [] } as unknown as import('../../../src/types/api').WorkDetail;
        mockBridge.currentWork = workData;
        mockBridge.player.playing = true;

        // Emit work:change - should clear playback timeout
        EventBus.emit('work:change', { workId: 'RJ999999', work: workData });

        // The onWorkChange handler should recognize playback started
        // No error should occur
    });

    it('should toggle between enabled and disabled', () => {
        radioMode.initialize();

        expect(radioMode.isActive).toBe(false);

        radioMode.enable();
        expect(radioMode.isActive).toBe(true);
        expect(AppStore.setRadioState).toHaveBeenCalledWith(
            expect.objectContaining({ isActive: true })
        );

        radioMode.disable();
        expect(radioMode.isActive).toBe(false);
        expect(AppStore.setRadioState).toHaveBeenCalledWith(
            expect.objectContaining({ isActive: false })
        );
    });

    it('should not double-enable or double-disable', () => {
        radioMode.initialize();

        radioMode.enable();
        const callCount = (AppStore.setRadioState as any).mock.calls.length;

        // Second enable should be ignored
        radioMode.enable();
        expect((AppStore.setRadioState as any).mock.calls.length).toBe(callCount);

        radioMode.disable();
        const callCount2 = (AppStore.setRadioState as any).mock.calls.length;

        // Second disable should be ignored
        radioMode.disable();
        expect((AppStore.setRadioState as any).mock.calls.length).toBe(callCount2);
    });

    it('should keep enough history for radio back after first forward skip', async () => {
        const history: string[] = [];
        mockWorkSelector.rememberWork.mockImplementation((id: string) => {
            const next = [id, ...history.filter(v => v !== id)];
            history.splice(0, history.length, ...next);
        });
        mockWorkSelector.getRecentWorkIds.mockImplementation(() => [...history]);
        mockWorkSelector.selectRandomWork.mockResolvedValue({ id: 'RJ654321', title: 'Next Work' });
        mockBridge.player.currentTrack = { hash: 't1' };

        radioMode.initialize();
        radioMode.enable();
        expect(history).toContain('RJ123456');

        await radioMode.skipToNext();
        expect(history).toContain('RJ654321');
        expect(history).toContain('RJ123456');

        // Simulate route/work update after navigation
        (radioMode as any).currentWorkId = 'RJ654321';

        expect(radioMode.canSkipToPrevious()).toBe(true);
        await radioMode.skipToPrevious();
        expect(mockBridge.navigateToWork).toHaveBeenCalledWith('RJ123456');
    });

    it('should navigate to previous work when history has one', async () => {
        (radioMode as any)._isActive = true;
        (radioMode as any).currentWorkId = 'RJ200000';
        mockWorkSelector.getRecentWorkIds.mockReturnValue(['RJ200000', 'RJ100000']);

        await radioMode.skipToPrevious();

        expect(mockPlaybackController.stopPlayback).toHaveBeenCalled();
        expect(mockBridge.navigateToWork).toHaveBeenCalledWith('RJ100000');
    });

    it('should disable previous skip when there is no prior history', async () => {
        (radioMode as any)._isActive = true;
        (radioMode as any).currentWorkId = 'RJ200000';
        mockWorkSelector.getRecentWorkIds.mockReturnValue(['RJ200000']);

        await radioMode.skipToPrevious();

        expect(mockBridge.navigateToWork).not.toHaveBeenCalled();
        expect(radioMode.canSkipToPrevious()).toBe(false);
    });

    it('collects playable non-audio files in flat mode', () => {
        const tracks = (radioMode as any).collectAllAudioFromTree([
            {
                type: 'folder',
                title: 'Main',
                children: [
                    { type: 'audio', hash: 'audio-1', title: 'Track 1', is_audio: true },
                    { type: 'other', hash: 'other-1', title: 'Movie.mp4' },
                    { type: 'other', hash: 'other-2', title: 'Notes.txt' },
                ],
            },
        ]);

        expect(tracks).toHaveLength(2);
        expect(tracks.map((t: any) => t.hash)).toEqual(['audio-1', 'other-1']);
    });
});
