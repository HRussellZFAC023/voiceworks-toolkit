import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    claimExclusivePlaybackMode,
    registerExclusivePlaybackMode,
} from '../../src/features/playbackModeCoordinator';

describe('playbackModeCoordinator', () => {
    beforeEach(() => {
        Object.defineProperty(window, '__ASMR_PLAYBACK_MODE_DEACTIVATORS__', {
            value: {},
            writable: true,
            configurable: true,
        });
    });

    it('deactivates playlist when radio claims playback ownership', () => {
        const deactivateRadio = vi.fn();
        const deactivatePlaylist = vi.fn();
        registerExclusivePlaybackMode('radio', deactivateRadio);
        registerExclusivePlaybackMode('playlist', deactivatePlaylist);

        claimExclusivePlaybackMode('radio');

        expect(deactivatePlaylist).toHaveBeenCalledTimes(1);
        expect(deactivateRadio).not.toHaveBeenCalled();
    });

    it('deactivates radio when playlist claims playback ownership', () => {
        const deactivateRadio = vi.fn();
        const deactivatePlaylist = vi.fn();
        registerExclusivePlaybackMode('radio', deactivateRadio);
        registerExclusivePlaybackMode('playlist', deactivatePlaylist);

        claimExclusivePlaybackMode('playlist');

        expect(deactivateRadio).toHaveBeenCalledTimes(1);
        expect(deactivatePlaylist).not.toHaveBeenCalled();
    });
});
