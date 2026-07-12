/**
 * Keeps the two continuous-playback modes mutually exclusive without making
 * either feature import the other (which previously created a module cycle).
 */

export type ExclusivePlaybackMode = 'radio' | 'playlist';

type DeactivateMode = () => void;

declare const unsafeWindow: Window & typeof globalThis;

const globalWindow = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) as Window & {
    __ASMR_PLAYBACK_MODE_DEACTIVATORS__?: Partial<Record<ExclusivePlaybackMode, DeactivateMode>>;
};

function getDeactivators(): Partial<Record<ExclusivePlaybackMode, DeactivateMode>> {
    return globalWindow.__ASMR_PLAYBACK_MODE_DEACTIVATORS__
        || (globalWindow.__ASMR_PLAYBACK_MODE_DEACTIVATORS__ = {});
}

export function registerExclusivePlaybackMode(
    mode: ExclusivePlaybackMode,
    deactivate: DeactivateMode,
): void {
    getDeactivators()[mode] = deactivate;
}

export function claimExclusivePlaybackMode(mode: ExclusivePlaybackMode): void {
    const deactivators = getDeactivators();
    const otherMode: ExclusivePlaybackMode = mode === 'radio' ? 'playlist' : 'radio';
    deactivators[otherMode]?.();
}
