import { getAudioElement, isValidAudioSource } from '../core/DomUtils';
import { resumeAudioContext } from '../core/AudioAnalysis';
import { CentralObserver } from '../core/CentralObserver';
import { Logger } from '../core/Utils';

const OBSERVER_ID = 'audio-recovery';
const MAX_RECOVERY_ATTEMPTS = 3;
const RECOVERY_COOLDOWN = 30_000;
const WAITING_RECOVERY_DELAY = 5_000;

let activeCleanup: (() => void) | null = null;

/**
 * Keep playback recovery attached to the host's current audio element.
 *
 * The host may render the player after bootstrap or replace the element during
 * a route change, so discovery is driven by CentralObserver instead of being a
 * one-shot startup check. The returned cleanup is safe to call repeatedly.
 */
export function setupAudioRecovery(): () => void {
    // A second setup replaces the first registration instead of stacking DOM
    // listeners and visibility handlers.
    activeCleanup?.();

    let disposed = false;
    let boundAudio: HTMLAudioElement | null = null;
    let audioRecoveryAttempts = 0;
    let lastRecoveryTime = 0;
    let lastKnownGoodSrc = '';
    let waitingTimer: ReturnType<typeof setTimeout> | null = null;
    let recoveryDeferredUntilVisible = false;
    let invalidSourceRestoreDeferredUntilVisible = false;
    let pendingMetadataCleanup: (() => void) | null = null;
    let elementCleanups: (() => void)[] = [];

    const clearWaitingTimer = (): void => {
        if (waitingTimer !== null) {
            clearTimeout(waitingTimer);
            waitingTimer = null;
        }
    };

    const clearPendingMetadataRestore = (): void => {
        pendingMetadataCleanup?.();
        pendingMetadataCleanup = null;
    };

    const resetForSource = (audio: HTMLAudioElement): void => {
        const src = audio.currentSrc || audio.getAttribute('src') || audio.src;
        if (isValidAudioSource(src) && src !== lastKnownGoodSrc) {
            lastKnownGoodSrc = src;
            audioRecoveryAttempts = 0;
            recoveryDeferredUntilVisible = false;
            invalidSourceRestoreDeferredUntilVisible = false;
            clearWaitingTimer();
        }
    };

    const restoreAfterMetadata = (
        audio: HTMLAudioElement,
        src: string,
        savedTime: number,
        shouldResume: boolean,
    ): void => {
        clearPendingMetadataRestore();

        let handled = false;
        const onLoadedMetadata = (): void => {
            if (handled) return;
            handled = true;
            clearPendingMetadataRestore();

            if (disposed || boundAudio !== audio) return;
            const activeSrc = audio.currentSrc || audio.getAttribute('src') || audio.src;
            if (activeSrc !== src && audio.src !== src) return;

            try {
                const duration = Number.isFinite(audio.duration) && audio.duration > 0
                    ? audio.duration
                    : Number.POSITIVE_INFINITY;
                audio.currentTime = Math.min(savedTime, duration);
            } catch (err) {
                Logger.debug('[AudioRecovery] Could not restore playback position:', err);
            }

            if (shouldResume) {
                audio.play().catch(err => Logger.debug('[AudioRecovery] Reload retry failed:', err));
            }
        };

        audio.addEventListener('loadedmetadata', onLoadedMetadata);
        pendingMetadataCleanup = () => audio.removeEventListener('loadedmetadata', onLoadedMetadata);
    };

    const attemptWaitingRecovery = (audio: HTMLAudioElement): void => {
        if (disposed || boundAudio !== audio) return;
        if (audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA || audio.paused || !isValidAudioSource(audio.src)) {
            recoveryDeferredUntilVisible = false;
            return;
        }

        // Replacing src while a document is hidden can interrupt otherwise
        // healthy background playback. Remember the recovery and retry only
        // when the user returns to the page.
        if (document.visibilityState !== 'visible') {
            recoveryDeferredUntilVisible = true;
            Logger.debug('[AudioRecovery] Deferring waiting recovery until the document is visible');
            return;
        }

        recoveryDeferredUntilVisible = false;
        const now = Date.now();
        if (now - lastRecoveryTime > RECOVERY_COOLDOWN) {
            audioRecoveryAttempts = 0;
        }
        if (audioRecoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
            Logger.warn('[AudioRecovery] Max recovery attempts reached, skipping reload');
            return;
        }

        audioRecoveryAttempts++;
        lastRecoveryTime = now;

        const current = audio.currentSrc || audio.src;
        const savedTime = Number.isFinite(audio.currentTime) ? Math.max(0, audio.currentTime) : 0;
        const shouldResume = !audio.paused;
        Logger.warn('[AudioRecovery] Audio stuck in waiting. Reloading source...', {
            src: current,
            readyState: audio.readyState,
            attempt: audioRecoveryAttempts,
        });

        // Register before assigning src: cached media can expose metadata very
        // quickly. Position restoration and play() happen only after metadata
        // makes seeking safe.
        restoreAfterMetadata(audio, current, savedTime, shouldResume);
        audio.src = '';
        audio.src = current;
        audio.load();
    };

    const restoreInvalidSource = (audio: HTMLAudioElement): void => {
        if (disposed || boundAudio !== audio) return;
        if (isValidAudioSource(audio.src) || !lastKnownGoodSrc) {
            invalidSourceRestoreDeferredUntilVisible = false;
            return;
        }
        if (document.visibilityState !== 'visible') {
            invalidSourceRestoreDeferredUntilVisible = true;
            Logger.debug('[AudioRecovery] Deferring invalid-source restore until the document is visible');
            return;
        }

        invalidSourceRestoreDeferredUntilVisible = false;
        recoveryDeferredUntilVisible = false;
        const savedTime = Number.isFinite(audio.currentTime) ? Math.max(0, audio.currentTime) : 0;
        const shouldResume = !audio.paused;
        Logger.warn('[AudioRecovery] Invalid src after error, restoring last good source', { lastKnownGoodSrc });
        restoreAfterMetadata(audio, lastKnownGoodSrc, savedTime, shouldResume);
        audio.src = lastKnownGoodSrc;
        audio.load();
    };

    const unbindAudio = (): void => {
        clearWaitingTimer();
        clearPendingMetadataRestore();
        for (const cleanup of elementCleanups) cleanup();
        elementCleanups = [];
        boundAudio = null;
        audioRecoveryAttempts = 0;
        lastRecoveryTime = 0;
        lastKnownGoodSrc = '';
        recoveryDeferredUntilVisible = false;
        invalidSourceRestoreDeferredUntilVisible = false;
    };

    const bindAudio = (audio: HTMLAudioElement): void => {
        if (audio === boundAudio) return;
        unbindAudio();
        boundAudio = audio;
        resetForSource(audio);

        const onSourceLifecycle = (): void => resetForSource(audio);
        const onStalled = (): void => {
            if (!isValidAudioSource(audio.src)) return;
            Logger.warn('[AudioRecovery] Audio stalled, retrying playback...', {
                src: audio.src,
                readyState: audio.readyState,
                currentTime: audio.currentTime,
            });
            audio.play().catch(err => Logger.debug('[AudioRecovery] Stalled retry failed:', err));
        };
        const onWaiting = (): void => {
            Logger.debug('[AudioRecovery] Audio waiting', {
                src: audio.src,
                readyState: audio.readyState,
                paused: audio.paused,
            });
            clearWaitingTimer();
            waitingTimer = setTimeout(() => {
                waitingTimer = null;
                attemptWaitingRecovery(audio);
            }, WAITING_RECOVERY_DELAY);
        };
        const onError = (): void => {
            Logger.error('[AudioRecovery] Audio error event', { src: audio.src, error: audio.error });
            restoreInvalidSource(audio);
        };
        const onPlay = (): void => {
            Logger.debug('[AudioRecovery] Audio play', { src: audio.src, currentTime: audio.currentTime });
        };
        const onPause = (): void => {
            Logger.debug('[AudioRecovery] Audio pause', { src: audio.src, currentTime: audio.currentTime });
        };

        audio.addEventListener('loadstart', onSourceLifecycle);
        audio.addEventListener('loadedmetadata', onSourceLifecycle);
        audio.addEventListener('stalled', onStalled);
        audio.addEventListener('waiting', onWaiting);
        audio.addEventListener('error', onError);
        audio.addEventListener('play', onPlay);
        audio.addEventListener('pause', onPause);
        elementCleanups = [
            () => audio.removeEventListener('loadstart', onSourceLifecycle),
            () => audio.removeEventListener('loadedmetadata', onSourceLifecycle),
            () => audio.removeEventListener('stalled', onStalled),
            () => audio.removeEventListener('waiting', onWaiting),
            () => audio.removeEventListener('error', onError),
            () => audio.removeEventListener('play', onPlay),
            () => audio.removeEventListener('pause', onPause),
        ];

        Logger.debug('[AudioRecovery] Bound recovery listeners to current <audio> element');
    };

    const syncAudioElement = (): void => {
        if (disposed) return;
        const audio = getAudioElement();
        if (audio) {
            bindAudio(audio);
        } else if (boundAudio && !boundAudio.isConnected) {
            unbindAudio();
        }
    };

    const onVisibilityChange = (): void => {
        if (document.visibilityState !== 'visible') return;
        const audio = boundAudio;
        if (!audio) {
            syncAudioElement();
            return;
        }
        resumeAudioContext(audio);
        if (invalidSourceRestoreDeferredUntilVisible) {
            restoreInvalidSource(audio);
            return;
        }
        if (recoveryDeferredUntilVisible) {
            attemptWaitingRecovery(audio);
        }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    CentralObserver.register(OBSERVER_ID, syncAudioElement, 100);
    syncAudioElement();

    let cleaned = false;
    const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        disposed = true;
        document.removeEventListener('visibilitychange', onVisibilityChange);
        CentralObserver.unregister(OBSERVER_ID);
        unbindAudio();
        if (activeCleanup === cleanup) activeCleanup = null;
    };
    activeCleanup = cleanup;
    return cleanup;
}
