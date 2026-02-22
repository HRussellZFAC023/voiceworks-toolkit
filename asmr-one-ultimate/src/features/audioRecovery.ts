import { getAudioElement, isValidAudioSource } from '../core/DomUtils';
import { resumeAudioContext } from '../core/AudioAnalysis';
import { Logger } from '../core/Utils';

export function setupAudioRecovery(): void {
    const audio = getAudioElement();
    if (!audio) {
        Logger.warn('[AudioRecovery] No <audio> element found, skipping recovery setup');
        return;
    }
    Logger.debug('[AudioRecovery] Setting up audio recovery listeners');

    let audioRecoveryAttempts = 0;
    const MAX_RECOVERY_ATTEMPTS = 3;
    const RECOVERY_COOLDOWN = 30000; // 30 seconds
    let lastRecoveryTime = 0;
    let lastKnownGoodSrc = '';
    let waitingTimer: ReturnType<typeof setTimeout> | null = null;

    // Reset recovery state when the source genuinely changes to a valid URL
    const srcObserver = new MutationObserver(() => {
        const src = audio.getAttribute('src') || audio.src;
        if (isValidAudioSource(src) && src !== lastKnownGoodSrc) {
            lastKnownGoodSrc = src;
            audioRecoveryAttempts = 0;
            if (waitingTimer !== null) {
                clearTimeout(waitingTimer);
                waitingTimer = null;
            }
        }
    });
    srcObserver.observe(audio, { attributes: true, attributeFilter: ['src'] });

    audio.addEventListener('stalled', () => {
        if (!isValidAudioSource(audio.src)) return; // Don't retry invalid src
        Logger.warn('[AudioRecovery] Audio stalled, retrying playback...', { src: audio.src, readyState: audio.readyState, currentTime: audio.currentTime });
        audio.play().catch(err => Logger.debug('[AudioRecovery] Stalled retry failed:', err));
    });

    audio.addEventListener('waiting', () => {
        Logger.debug('[AudioRecovery] Audio waiting', { src: audio.src, readyState: audio.readyState, paused: audio.paused });
        if (waitingTimer !== null) clearTimeout(waitingTimer);
        waitingTimer = setTimeout(() => {
            waitingTimer = null;
            if (audio.readyState < 3 && !audio.paused && isValidAudioSource(audio.src)) {
                const now = Date.now();

                // Reset counter after cooldown period
                if (now - lastRecoveryTime > RECOVERY_COOLDOWN) {
                    audioRecoveryAttempts = 0;
                }

                if (audioRecoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
                    Logger.warn('[AudioRecovery] Max recovery attempts reached, skipping reload');
                    return;
                }

                audioRecoveryAttempts++;
                lastRecoveryTime = now;

                Logger.warn('[AudioRecovery] Audio stuck in waiting. Reloading source...', { src: audio.src, readyState: audio.readyState, attempt: audioRecoveryAttempts });
                const current = audio.src;
                const savedTime = audio.currentTime;
                audio.src = '';
                audio.src = current;
                audio.currentTime = savedTime;
                audio.play().catch(err => Logger.debug('[AudioRecovery] Reload retry failed:', err));
            }
        }, 5000);
    });

    audio.addEventListener('error', () => {
        Logger.error('[AudioRecovery] Audio error event', { src: audio.src, error: audio.error });

        // If the src is invalid (e.g. bare origin after rapid skipping), try to
        // restore the last known good source so playback isn't permanently broken.
        if (!isValidAudioSource(audio.src) && lastKnownGoodSrc) {
            Logger.warn('[AudioRecovery] Invalid src after error, restoring last good source', { lastKnownGoodSrc });
            audio.src = lastKnownGoodSrc;
            audio.play().catch(err => Logger.debug('[AudioRecovery] Restore retry failed:', err));
        }
    });

    audio.addEventListener('play', () => {
        Logger.debug('[AudioRecovery] Audio play', { src: audio.src, currentTime: audio.currentTime });
    });

    audio.addEventListener('pause', () => {
        Logger.debug('[AudioRecovery] Audio pause', { src: audio.src, currentTime: audio.currentTime });
    });

    // Resume AudioContext when page becomes visible again.
    // On desktop, the browser may suspend the AudioContext when the tab is
    // backgrounded; resuming it when the user returns prevents silent playback
    // if the Visualizer/JoiTool had connected via createMediaElementSource().
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            resumeAudioContext(audio);
        }
    });
}
