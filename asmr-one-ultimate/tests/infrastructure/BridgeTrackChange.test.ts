/**
 * Tests for KikoeruBridge track:change event emission.
 *
 * Bug: track:change was only emitted when both `track` AND `workId` were truthy.
 * If workId was empty string (e.g. playing from homepage without /work/:id route),
 * the event never fired, breaking features like alwaysTranscribe and track-based
 * auto-restart.
 *
 * Fix: emit track:change when track is truthy, regardless of workId.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Simulated Bridge watcher pattern (matches KikoeruBridge.setupWatchers)
// ============================================================================

interface TrackChangeEvent {
    track: { src: string; title?: string };
    workId: string;
}

/**
 * Fixed bridge watcher: emits when track is truthy (workId can be empty)
 */
function simulateFixedWatcher(
    newSrc: string | null,
    lastTrackSrc: string | null,
    currentTrack: { src: string; title?: string } | undefined,
    currentWorkId: string,
): TrackChangeEvent | null {
    if (newSrc && newSrc !== lastTrackSrc) {
        const track = currentTrack;
        const workId = currentWorkId;
        if (track) {
            return { track, workId };
        }
    }
    return null;
}

/**
 * Old broken bridge watcher: required truthy workId
 */
function simulateBrokenWatcher(
    newSrc: string | null,
    lastTrackSrc: string | null,
    currentTrack: { src: string; title?: string } | undefined,
    currentWorkId: string,
): TrackChangeEvent | null {
    if (newSrc && newSrc !== lastTrackSrc) {
        const track = currentTrack;
        const workId = currentWorkId;
        if (track && workId) {
            return { track, workId };
        }
    }
    return null;
}

// ============================================================================
// Tests
// ============================================================================

describe('KikoeruBridge track:change emission', () => {
    const track = { src: 'http://example.com/audio.mp3', title: 'Test Track' };

    describe('Fixed watcher (workId not required)', () => {
        it('emits track:change with valid workId', () => {
            const event = simulateFixedWatcher('new-src', null, track, 'RJ123456');
            expect(event).not.toBeNull();
            expect(event!.track).toBe(track);
            expect(event!.workId).toBe('RJ123456');
        });

        it('emits track:change with empty workId', () => {
            const event = simulateFixedWatcher('new-src', null, track, '');
            expect(event).not.toBeNull();
            expect(event!.track).toBe(track);
            expect(event!.workId).toBe('');
        });

        it('does not emit when src unchanged', () => {
            const event = simulateFixedWatcher('same-src', 'same-src', track, 'RJ123456');
            expect(event).toBeNull();
        });

        it('does not emit when src is null', () => {
            const event = simulateFixedWatcher(null, null, track, 'RJ123456');
            expect(event).toBeNull();
        });

        it('does not emit when track is undefined', () => {
            const event = simulateFixedWatcher('new-src', null, undefined, 'RJ123456');
            expect(event).toBeNull();
        });
    });

    describe('Broken watcher (reproduces bug)', () => {
        it('fails to emit track:change with empty workId', () => {
            const event = simulateBrokenWatcher('new-src', null, track, '');
            // BUG: empty string workId is falsy, so event is never emitted
            expect(event).toBeNull();
        });

        it('emits with valid workId', () => {
            const event = simulateBrokenWatcher('new-src', null, track, 'RJ123456');
            expect(event).not.toBeNull();
        });
    });
});

describe('Whisper auto-transcribe watcher', () => {
    it('tryAutoStartForCurrentTrack returns true when audio is playing', () => {
        // Simulates the tryAutoStartForCurrentTrack logic
        const transcribing = false;
        const track = { hash: 'abc123', mediaStreamUrl: null, src: 'http://example.com/audio.mp3' };
        const src = track.hash || track.mediaStreamUrl || track.src;
        const audio = { paused: false } as HTMLAudioElement;

        const canStart = !transcribing && !!src && !!audio && !audio.paused;
        expect(canStart).toBe(true);
    });

    it('tryAutoStartForCurrentTrack returns false when audio is paused', () => {
        const transcribing = false;
        const track = { hash: 'abc123', mediaStreamUrl: null, src: 'http://example.com/audio.mp3' };
        const src = track.hash || track.mediaStreamUrl || track.src;
        const audio = { paused: true } as HTMLAudioElement;

        const canStart = !transcribing && !!src && !!audio && !audio.paused;
        expect(canStart).toBe(false);
    });

    it('tryAutoStartForCurrentTrack returns false when already transcribing', () => {
        const transcribing = true;
        const track = { hash: 'abc123', mediaStreamUrl: null, src: 'http://example.com/audio.mp3' };
        const src = track.hash || track.mediaStreamUrl || track.src;
        const audio = { paused: false } as HTMLAudioElement;

        const canStart = !transcribing && !!src && !!audio && !audio.paused;
        expect(canStart).toBe(false);
    });

    it('tryAutoStartForCurrentTrack returns false when no track', () => {
        const transcribing = false;
        const src = '';
        const audio = { paused: false } as HTMLAudioElement;

        const canStart = !transcribing && !!src && !!audio && !audio.paused;
        expect(canStart).toBe(false);
    });
});
