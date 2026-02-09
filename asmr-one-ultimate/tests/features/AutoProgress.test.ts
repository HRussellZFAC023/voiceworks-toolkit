
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { AutoProgress } from '../../src/features/AutoProgress';
import { KikoeruBridge } from '../../src/infrastructure/KikoeruBridge';
import { Config } from '../../src/core/Utils';
import { EventBus } from '../../src/core/EventBus';

// ---- Mocks ----

const mockUpdateReview = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/api', () => ({
    ReviewApi: {
        updateReview: (...args: any[]) => mockUpdateReview(...args),
    },
}));

vi.mock('../../src/features/radio', () => ({
    RadioMode: {
        isActive: false,
    },
}));

vi.mock('../../src/features/playlist', () => ({
    PlaylistMode: {
        isActive: false,
    },
}));

vi.mock('../../src/core/DomUtils', () => ({
    getAudioElement: () => ({
        duration: 100,
        currentTime: 0,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    }),
}));

// Re-import so we can mutate RadioMode.isActive in tests
import { RadioMode } from '../../src/features/radio';

vi.mock('../../src/infrastructure/KikoeruBridge', () => {
    const mockStore = {
        state: {
            AudioPlayer: {
                currentTime: 0,
                duration: 100,
                currentTrack: {
                    hash: 'track3.mp3',
                    title: 'Track 3',
                    duration: 100,
                    src: 'http://example.com/track3.mp3',
                    workId: '12345',
                    type: 'audio',
                },
                work: {
                    id: 12345,
                    tracks: [
                        { hash: 'track1.mp3', title: 'Track 1', type: 'audio', src: 'http://example.com/track1.mp3' },
                    ],
                    dirs: [
                        {
                            name: 'Folder A',
                            type: 'folder',
                            tracks: [
                                { hash: 'track2.mp3', title: 'Track 2', type: 'audio', src: 'http://example.com/track2.mp3' },
                            ],
                        },
                        {
                            name: 'Folder B',
                            type: 'folder',
                            tracks: [
                                { hash: 'track3.mp3', title: 'Track 3', type: 'audio', src: 'http://example.com/track3.mp3' },
                            ],
                        },
                    ],
                },
            },
            User: { marks: {} as Record<string, number> },
        },
        watch: vi.fn(),
        dispatch: vi.fn(),
    };
    const mockRouter = {
        currentRoute: { path: '/work/RJ12345', query: { path: '[]' } },
    };
    const mockApp = {
        $watch: vi.fn(),
    };

    return {
        KikoeruBridge: {
            getInstance: () => ({
                store: mockStore,
                router: mockRouter,
                app: mockApp,
                axios: { put: vi.fn().mockResolvedValue({}) },
            }),
        },
    };
});

vi.mock('../../src/core/Utils', async () => {
    const actual = await vi.importActual('../../src/core/Utils');
    return {
        ...actual,
        Config: {
            get: vi.fn().mockImplementation((key: string) => {
                // Default: all enabled
                const defaults: Record<string, any> = {
                    autoProgress: true,
                    autoProgressMarked: true,
                    autoProgressListening: true,
                    autoProgressListened: true,
                    autoProgressReplay: true,
                    autoProgressPostponed: true,
                    autoProgressReplayThreshold: 2,
                    autoProgressRadioSkipThreshold: 3,
                };
                return defaults[key] ?? true;
            }),
        },
        Logger: { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    };
});

// ---- Helpers ----

function getBridge(): any {
    return KikoeruBridge.getInstance();
}

function createAutoProgress(): AutoProgress {
    return new AutoProgress();
}

function setConfig(overrides: Record<string, any>): void {
    const defaults: Record<string, any> = {
        autoProgress: true,
        playlistAutoProgress: true,
        autoProgressMarked: true,
        autoProgressListening: true,
        autoProgressListened: true,
        autoProgressReplay: true,
        autoProgressPostponed: true,
        autoProgressReplayThreshold: 2,
        autoProgressRadioSkipThreshold: 3,
    };
    const merged = { ...defaults, ...overrides };
    (Config.get as Mock).mockImplementation((key: string) => merged[key] ?? true);
}

// ---- Tests ----

describe('AutoProgress', () => {
    let ap: AutoProgress;
    let bridge: any;

    beforeEach(() => {
        vi.clearAllMocks();
        bridge = getBridge();
        // Reset marks
        bridge.store.state.User.marks = {};
        // Reset currentTrack to default (track3 = last track in tree)
        bridge.store.state.AudioPlayer.currentTrack = {
            hash: 'track3.mp3',
            title: 'Track 3',
            duration: 100,
            src: 'http://example.com/track3.mp3',
            workId: '12345',
            type: 'audio',
        };
        // Reset RadioMode
        (RadioMode as any).isActive = false;
        // Reset GM storage mocks
        (globalThis as any).GM_getValue.mockReturnValue('{}');
        // Reset config to defaults
        setConfig({});
        // Create fresh instance
        ap = createAutoProgress();
        ap.enable();
    });

    // =========================================================================
    // Master toggle
    // =========================================================================

    describe('master toggle', () => {
        it('should not update if autoProgress is false', () => {
            setConfig({ autoProgress: false, playlistAutoProgress: false });
            (ap as any).checkAndMark(50);
            expect(mockUpdateReview).not.toHaveBeenCalled();
        });

        it('should not mark on route change if autoProgress is false', () => {
            setConfig({ autoProgress: false, playlistAutoProgress: false });
            (ap as any).handleRouteChange({ path: '/work/RJ99999' });
            expect(mockUpdateReview).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // Mark on visit (marked)
    // =========================================================================

    describe('marked on visit', () => {
        it('should mark "marked" when visiting a work page with no prior status', () => {
            (ap as any).handleRouteChange({ path: '/work/RJ99999' });
            expect(mockUpdateReview).toHaveBeenCalledWith({
                work_id: 99999,
                progress: 'marked',
                progressOnly: true,
            });
            expect(bridge.store.state.User.marks['99999']).toBe(1);
        });

        it('should not mark "marked" when work already has a status', () => {
            bridge.store.state.User.marks['99999'] = 2; // already listening
            (ap as any).handleRouteChange({ path: '/work/RJ99999' });
            expect(mockUpdateReview).not.toHaveBeenCalled();
        });

        it('should not mark if autoProgressMarked toggle is off', () => {
            setConfig({ autoProgressMarked: false });
            (ap as any).handleRouteChange({ path: '/work/RJ99999' });
            expect(mockUpdateReview).not.toHaveBeenCalled();
        });

        it('should handle routes without RJ prefix', () => {
            (ap as any).handleRouteChange({ path: '/work/99999' });
            expect(mockUpdateReview).toHaveBeenCalledWith(
                expect.objectContaining({ work_id: 99999, progress: 'marked' })
            );
        });

        it('should ignore non-work routes', () => {
            (ap as any).handleRouteChange({ path: '/settings' });
            expect(mockUpdateReview).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // Mark listening (>5s playback)
    // =========================================================================

    describe('listening', () => {
        it('should mark "listening" after >5s of playback', () => {
            (ap as any).checkAndMark(6);
            expect(mockUpdateReview).toHaveBeenCalledWith({
                work_id: 12345,
                progress: 'listening',
                progressOnly: true,
            });
            expect(bridge.store.state.User.marks['12345']).toBe(2);
        });

        it('should not mark "listening" before 5s', () => {
            (ap as any).checkAndMark(3);
            expect(mockUpdateReview).not.toHaveBeenCalled();
        });

        it('should not mark "listening" if toggle is off', () => {
            setConfig({ autoProgressListening: false });
            (ap as any).checkAndMark(6);
            expect(mockUpdateReview).not.toHaveBeenCalled();
        });

        it('should not mark "listening" if progress is >=90% (near end)', () => {
            // At 95% of duration, the listening check (progress < 0.9) will fail
            (ap as any).checkAndMark(95);
            // Should not get "listening" call (may get "listened" if last track)
            const listeningCalls = mockUpdateReview.mock.calls.filter(
                (c: any) => c[0]?.progress === 'listening'
            );
            expect(listeningCalls.length).toBe(0);
        });
    });

    // =========================================================================
    // Mark listened (last track at 85%)
    // =========================================================================

    describe('listened', () => {
        it('should mark "listened" when last track reaches 85%', () => {
            // Current track is track3.mp3 which IS the last track in the tree
            bridge.store.state.User.marks['12345'] = 2; // already listening
            (ap as any).checkAndMark(86); // 86% of 100s duration
            expect(mockUpdateReview).toHaveBeenCalledWith({
                work_id: 12345,
                progress: 'listened',
                progressOnly: true,
            });
        });

        it('should NOT mark "listened" for non-last tracks', () => {
            // Change current track to track1 (NOT the last track)
            bridge.store.state.AudioPlayer.currentTrack = {
                hash: 'track1.mp3',
                title: 'Track 1',
                type: 'audio',
                src: 'http://example.com/track1.mp3',
                workId: '12345',
                duration: 100,
            };
            bridge.store.state.User.marks['12345'] = 2;
            (ap as any).checkAndMark(90);

            const listenedCalls = mockUpdateReview.mock.calls.filter(
                (c: any) => c[0]?.progress === 'listened'
            );
            expect(listenedCalls.length).toBe(0);
        });

        it('should not mark "listened" if toggle is off', () => {
            setConfig({ autoProgressListened: false });
            bridge.store.state.User.marks['12345'] = 2;
            (ap as any).checkAndMark(90);
            const listenedCalls = mockUpdateReview.mock.calls.filter(
                (c: any) => c[0]?.progress === 'listened'
            );
            expect(listenedCalls.length).toBe(0);
        });
    });

    // =========================================================================
    // No-downgrade rule
    // =========================================================================

    describe('no-downgrade rule', () => {
        it('should not downgrade from listened(3) to listening(2)', () => {
            bridge.store.state.User.marks['12345'] = 3; // listened
            (ap as any).checkAndMark(6); // Would normally trigger listening
            const listeningCalls = mockUpdateReview.mock.calls.filter(
                (c: any) => c[0]?.progress === 'listening'
            );
            expect(listeningCalls.length).toBe(0);
        });

        it('should not downgrade from replay(4) to listened(3)', () => {
            bridge.store.state.User.marks['12345'] = 4; // replay
            // Make current track the last one and hit 85%
            (ap as any).checkAndMark(90);
            const listenedCalls = mockUpdateReview.mock.calls.filter(
                (c: any) => c[0]?.progress === 'listened'
            );
            expect(listenedCalls.length).toBe(0);
        });

        it('should allow upgrade from listening(2) to listened(3)', () => {
            bridge.store.state.User.marks['12345'] = 2; // listening
            (ap as any).checkAndMark(90); // Last track at >85%
            expect(mockUpdateReview).toHaveBeenCalledWith(
                expect.objectContaining({ progress: 'listened' })
            );
        });
    });

    // =========================================================================
    // Replay detection
    // =========================================================================

    describe('replay detection', () => {
        it('should mark "replay" when play count reaches threshold', () => {
            // Simulate play count = 1 already stored
            (globalThis as any).GM_getValue.mockReturnValue(JSON.stringify({ '12345': 1 }));
            bridge.store.state.User.marks['12345'] = 2;
            // This calls markAsListened -> incrementPlayCount (1+1=2 >= threshold 2)
            (ap as any).checkAndMark(90);
            expect(mockUpdateReview).toHaveBeenCalledWith(
                expect.objectContaining({ progress: 'replay' })
            );
        });

        it('should mark "listened" if play count is below threshold', () => {
            // Play count = 0 (first listen), increment -> 1, which is < 2
            (globalThis as any).GM_getValue.mockReturnValue('{}');
            bridge.store.state.User.marks['12345'] = 2;
            (ap as any).checkAndMark(90);
            expect(mockUpdateReview).toHaveBeenCalledWith(
                expect.objectContaining({ progress: 'listened' })
            );
        });

        it('should not mark "replay" if toggle is off', () => {
            setConfig({ autoProgressReplay: false });
            (globalThis as any).GM_getValue.mockReturnValue(JSON.stringify({ '12345': 5 }));
            bridge.store.state.User.marks['12345'] = 2;
            (ap as any).checkAndMark(90);
            // Should fall through to "listened" instead
            const replayCalls = mockUpdateReview.mock.calls.filter(
                (c: any) => c[0]?.progress === 'replay'
            );
            expect(replayCalls.length).toBe(0);
        });
    });

    // =========================================================================
    // Radio mode guard
    // =========================================================================

    describe('radio mode guard', () => {
        it('should block "listened" when radio is active', () => {
            (RadioMode as any).isActive = true;
            bridge.store.state.User.marks['12345'] = 2;
            (ap as any).checkAndMark(90);
            const listenedCalls = mockUpdateReview.mock.calls.filter(
                (c: any) => c[0]?.progress === 'listened'
            );
            expect(listenedCalls.length).toBe(0);
        });

        it('should still allow "listening" when radio is active', () => {
            (RadioMode as any).isActive = true;
            (ap as any).checkAndMark(6);
            expect(mockUpdateReview).toHaveBeenCalledWith(
                expect.objectContaining({ progress: 'listening' })
            );
        });
    });

    // =========================================================================
    // Postponed via radio skips
    // =========================================================================

    describe('postponed via radio skips', () => {
        it('should mark "postponed" after radio skip threshold is reached', () => {
            // Default threshold is 3
            (ap as any).handleRadioSkip('99999');
            (ap as any).handleRadioSkip('99999');
            expect(mockUpdateReview).not.toHaveBeenCalled();
            (ap as any).handleRadioSkip('99999');
            expect(mockUpdateReview).toHaveBeenCalledWith({
                work_id: 99999,
                progress: 'postponed',
                progressOnly: true,
            });
        });

        it('should not mark "postponed" if toggle is off', () => {
            setConfig({ autoProgressPostponed: false });
            (ap as any).handleRadioSkip('99999');
            (ap as any).handleRadioSkip('99999');
            (ap as any).handleRadioSkip('99999');
            expect(mockUpdateReview).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // Postponed via partial listen
    // =========================================================================

    describe('postponed via partial listen', () => {
        it('should mark "postponed" when navigating away with <30% of tracks played', () => {
            // Simulate listening to a work but not completing any tracks
            // Work has 3 tracks (from mock), 0 played = 0% < 30%
            (ap as any).currentListeningWorkId = '88888';
            (ap as any).currentTrackStarted = true; // user actually started listening (>5s)
            // No tracks added to playedTracksInWork for '88888'

            // Navigate to a different work
            (ap as any).handleWorkChange('77777');

            expect(mockUpdateReview).toHaveBeenCalledWith({
                work_id: 88888,
                progress: 'postponed',
                progressOnly: true,
            });
        });

        it('should NOT mark "postponed" if >=30% of tracks played', () => {
            (ap as any).currentListeningWorkId = '88888';
            (ap as any).currentTrackStarted = true;
            // Add 1 of 3 tracks played (33% > 30%)
            (ap as any).playedTracksInWork.set('88888', new Set(['track1.mp3']));
            (ap as any).handleWorkChange('77777');
            expect(mockUpdateReview).not.toHaveBeenCalled();
        });

        it('should NOT mark "postponed" if user never started listening (<=5s)', () => {
            (ap as any).currentListeningWorkId = '88888';
            (ap as any).currentTrackStarted = false; // never reached 5s
            (ap as any).handleWorkChange('77777');
            expect(mockUpdateReview).not.toHaveBeenCalled();
        });

        it('should NOT downgrade a "listened" work to "postponed"', () => {
            bridge.store.state.User.marks['88888'] = 3; // listened
            (ap as any).currentListeningWorkId = '88888';
            (ap as any).currentTrackStarted = true;
            (ap as any).handleWorkChange('77777');
            expect(mockUpdateReview).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // Deduplication
    // =========================================================================

    describe('deduplication', () => {
        it('should not send duplicate API calls for the same work+status', () => {
            (ap as any).checkAndMark(6); // listening
            expect(mockUpdateReview).toHaveBeenCalledTimes(1);
            (ap as any).checkAndMark(7); // still listening at 7s
            expect(mockUpdateReview).toHaveBeenCalledTimes(1); // no duplicate
        });

        it('should allow retry after API failure (dedup key removed)', async () => {
            mockUpdateReview.mockRejectedValueOnce(new Error('Network error'));
            (ap as any).checkAndMark(6); // listening — will fail
            expect(mockUpdateReview).toHaveBeenCalledTimes(1);
            // Wait for the promise rejection to process
            await vi.waitFor(() => {
                expect((ap as any).sentUpdates.has('12345-listening')).toBe(false);
            });
            // Now retry should work
            mockUpdateReview.mockResolvedValueOnce(undefined);
            (ap as any).checkAndMark(7);
            expect(mockUpdateReview).toHaveBeenCalledTimes(2);
        });

        it('should track multiple work+status keys independently', () => {
            // Disable postponed to avoid partial-listen triggering on work change
            setConfig({ autoProgressPostponed: false });
            (ap as any).checkAndMark(6); // listening for work 12345
            expect(mockUpdateReview).toHaveBeenCalledTimes(1);
            // Simulate a different work
            bridge.store.state.AudioPlayer.currentTrack = {
                ...bridge.store.state.AudioPlayer.currentTrack,
                workId: '99999',
            };
            (ap as any).checkAndMark(6); // listening for work 99999
            expect(mockUpdateReview).toHaveBeenCalledTimes(2);
        });
    });

    // =========================================================================
    // Optimistic rollback
    // =========================================================================

    describe('optimistic rollback', () => {
        it('should rollback marks on API failure', async () => {
            bridge.store.state.User.marks['12345'] = 1; // marked
            mockUpdateReview.mockRejectedValueOnce(new Error('Server error'));

            (ap as any).setProgress('12345', 'listening');
            // Optimistic update should have happened immediately
            expect(bridge.store.state.User.marks['12345']).toBe(2);

            // Wait for rejection to process
            await vi.waitFor(() => {
                // Should be rolled back to previous value (marked = 1)
                expect(bridge.store.state.User.marks['12345']).toBe(1);
            });
        });

        it('should delete marks entry on rollback if no previous status', async () => {
            delete bridge.store.state.User.marks['55555'];
            mockUpdateReview.mockRejectedValueOnce(new Error('Server error'));

            (ap as any).setProgress('55555', 'marked');
            expect(bridge.store.state.User.marks['55555']).toBe(1);

            await vi.waitFor(() => {
                expect(bridge.store.state.User.marks['55555']).toBeUndefined();
            });
        });
    });

    // =========================================================================
    // Tree flattening
    // =========================================================================

    describe('tree flattening', () => {
        it('should collect all audio tracks from nested tree', () => {
            const allTracks = (ap as any).flattenAudioTracks(bridge.store.state.AudioPlayer.work);
            expect(allTracks).toHaveLength(3);
            expect(allTracks[0].hash).toBe('track1.mp3');
            expect(allTracks[1].hash).toBe('track2.mp3');
            expect(allTracks[2].hash).toBe('track3.mp3');
        });

        it('should identify last track correctly', () => {
            // Current track is track3 which is the last one
            expect((ap as any).isLastTrackInWork(bridge.store.state.AudioPlayer.currentTrack)).toBe(true);
        });

        it('should return false for non-last track', () => {
            const nonLastTrack = { hash: 'track1.mp3', src: 'http://example.com/track1.mp3' };
            expect((ap as any).isLastTrackInWork(nonLastTrack)).toBe(false);
        });
    });

    // =========================================================================
    // Play count persistence
    // =========================================================================

    describe('play count persistence', () => {
        it('should increment and persist play counts via GM_setValue', () => {
            (globalThis as any).GM_getValue.mockReturnValue('{}');
            const count = (ap as any).incrementPlayCount('12345');
            expect(count).toBe(1);
            expect((globalThis as any).GM_setValue).toHaveBeenCalledWith(
                'autoProgressPlayCounts',
                JSON.stringify({ '12345': 1 })
            );
        });

        it('should return existing play count', () => {
            (globalThis as any).GM_getValue.mockReturnValue(JSON.stringify({ '12345': 3 }));
            expect(ap.getPlayCount('12345')).toBe(3);
        });

        it('should handle corrupted GM storage gracefully', () => {
            (globalThis as any).GM_getValue.mockReturnValue('NOT_JSON');
            expect(ap.getPlayCount('12345')).toBe(0); // should not throw
        });
    });

    // =========================================================================
    // Hash-based work ID resolution (real host app scenario)
    // =========================================================================

    describe('resolveWorkId from hash', () => {
        it('should extract work ID from hash format "{workID}/{fileIndex}"', () => {
            // Simulate real host app: currentPlayingFile has hash but no workId
            bridge.store.state.AudioPlayer.currentTrack = {
                hash: '1470225/2',
                title: 'Track 3',
                duration: 100,
                mediaStreamUrl: 'http://example.com/stream',
            };
            // No work property either
            const savedWork = bridge.store.state.AudioPlayer.work;
            bridge.store.state.AudioPlayer.work = undefined;
            bridge.store.state.AudioPlayer.queue = [];

            (ap as any).checkAndMark(6);
            expect(mockUpdateReview).toHaveBeenCalledWith(
                expect.objectContaining({ work_id: 1470225, progress: 'listening' })
            );

            bridge.store.state.AudioPlayer.work = savedWork;
        });

        it('should fall back to route params when hash has no slash', () => {
            bridge.store.state.AudioPlayer.currentTrack = {
                hash: 'some-track.mp3',
                title: 'Track',
                duration: 100,
                mediaStreamUrl: 'http://example.com/stream',
            };
            bridge.store.state.AudioPlayer.work = undefined;
            bridge.router.currentRoute = { path: '/work/RJ12345', query: { path: '[]' }, params: { id: 'RJ12345' } };

            (ap as any).checkAndMark(6);
            expect(mockUpdateReview).toHaveBeenCalledWith(
                expect.objectContaining({ work_id: 12345, progress: 'listening' })
            );

            // Restore
            bridge.store.state.AudioPlayer.work = {
                id: 12345,
                tracks: [{ hash: 'track1.mp3', title: 'Track 1', type: 'audio', src: 'http://example.com/track1.mp3' }],
                dirs: [
                    { name: 'Folder A', type: 'folder', tracks: [{ hash: 'track2.mp3', title: 'Track 2', type: 'audio', src: 'http://example.com/track2.mp3' }] },
                    { name: 'Folder B', type: 'folder', tracks: [{ hash: 'track3.mp3', title: 'Track 3', type: 'audio', src: 'http://example.com/track3.mp3' }] },
                ],
            };
            bridge.router.currentRoute = { path: '/work/RJ12345', query: { path: '[]' } };
        });

        it('should return null when no work ID can be resolved', () => {
            bridge.store.state.AudioPlayer.currentTrack = {
                hash: 'no-id-here.mp3',
                title: 'Track',
                duration: 100,
            };
            bridge.store.state.AudioPlayer.work = undefined;
            bridge.router.currentRoute = { path: '/settings', query: {} };

            (ap as any).checkAndMark(6);
            expect(mockUpdateReview).not.toHaveBeenCalled();

            // Restore
            bridge.store.state.AudioPlayer.work = {
                id: 12345,
                tracks: [{ hash: 'track1.mp3', title: 'Track 1', type: 'audio', src: 'http://example.com/track1.mp3' }],
                dirs: [
                    { name: 'Folder A', type: 'folder', tracks: [{ hash: 'track2.mp3', title: 'Track 2', type: 'audio', src: 'http://example.com/track2.mp3' }] },
                    { name: 'Folder B', type: 'folder', tracks: [{ hash: 'track3.mp3', title: 'Track 3', type: 'audio', src: 'http://example.com/track3.mp3' }] },
                ],
            };
            bridge.router.currentRoute = { path: '/work/RJ12345', query: { path: '[]' } };
        });
    });

    // =========================================================================
    // Queue-based last track detection (fallback)
    // =========================================================================

    describe('queue-based isLastTrackInWork', () => {
        it('should detect last track via queue when work tree is unavailable', () => {
            bridge.store.state.AudioPlayer.work = undefined;
            bridge.store.state.AudioPlayer.queue = [
                { hash: '12345/0', title: 'Track 1' },
                { hash: '12345/1', title: 'Track 2' },
                { hash: '12345/2', title: 'Track 3' },
            ];
            bridge.store.state.AudioPlayer.queueIndex = 2; // last
            bridge.store.state.AudioPlayer.currentTrack = {
                hash: '12345/2',
                title: 'Track 3',
                duration: 100,
                mediaStreamUrl: 'http://example.com/stream',
            };
            bridge.store.state.User.marks['12345'] = 2; // listening

            (ap as any).checkAndMark(90);
            expect(mockUpdateReview).toHaveBeenCalledWith(
                expect.objectContaining({ progress: 'listened' })
            );

            // Restore
            bridge.store.state.AudioPlayer.work = {
                id: 12345,
                tracks: [{ hash: 'track1.mp3', title: 'Track 1', type: 'audio', src: 'http://example.com/track1.mp3' }],
                dirs: [
                    { name: 'Folder A', type: 'folder', tracks: [{ hash: 'track2.mp3', title: 'Track 2', type: 'audio', src: 'http://example.com/track2.mp3' }] },
                    { name: 'Folder B', type: 'folder', tracks: [{ hash: 'track3.mp3', title: 'Track 3', type: 'audio', src: 'http://example.com/track3.mp3' }] },
                ],
            };
            delete bridge.store.state.AudioPlayer.queue;
            delete bridge.store.state.AudioPlayer.queueIndex;
        });

        it('should NOT detect last track if queueIndex is not at end', () => {
            bridge.store.state.AudioPlayer.work = undefined;
            bridge.store.state.AudioPlayer.queue = [
                { hash: '12345/0', title: 'Track 1' },
                { hash: '12345/1', title: 'Track 2' },
                { hash: '12345/2', title: 'Track 3' },
            ];
            bridge.store.state.AudioPlayer.queueIndex = 0; // not last
            bridge.store.state.AudioPlayer.currentTrack = {
                hash: '12345/0',
                title: 'Track 1',
                duration: 100,
                mediaStreamUrl: 'http://example.com/stream',
            };
            bridge.store.state.User.marks['12345'] = 2;

            (ap as any).checkAndMark(90);
            const listenedCalls = mockUpdateReview.mock.calls.filter(
                (c: any) => c[0]?.progress === 'listened'
            );
            expect(listenedCalls.length).toBe(0);

            // Restore
            bridge.store.state.AudioPlayer.work = {
                id: 12345,
                tracks: [{ hash: 'track1.mp3', title: 'Track 1', type: 'audio', src: 'http://example.com/track1.mp3' }],
                dirs: [
                    { name: 'Folder A', type: 'folder', tracks: [{ hash: 'track2.mp3', title: 'Track 2', type: 'audio', src: 'http://example.com/track2.mp3' }] },
                    { name: 'Folder B', type: 'folder', tracks: [{ hash: 'track3.mp3', title: 'Track 3', type: 'audio', src: 'http://example.com/track3.mp3' }] },
                ],
            };
            delete bridge.store.state.AudioPlayer.queue;
            delete bridge.store.state.AudioPlayer.queueIndex;
        });
    });

    // =========================================================================
    // EventBus integration
    // =========================================================================

    describe('EventBus integration', () => {
        it('should emit progress:update event on status change', () => {
            const spy = vi.fn();
            const cleanup = EventBus.on('progress:update', spy);
            try {
                (ap as any).handleRouteChange({ path: '/work/RJ55555' });
                expect(spy).toHaveBeenCalledWith({
                    workId: '55555',
                    progress: 'marked',
                    oldProgress: null,
                });
            } finally {
                cleanup();
            }
        });
    });
});
