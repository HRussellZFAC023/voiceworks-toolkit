/**
 * Constants - Named constants replacing magic numbers throughout the codebase.
 *
 * Every value has a comment explaining *why* it exists at that magnitude.
 */

/** Timing constants (milliseconds unless noted). */
export const TIMING = {
    /** Debounce before persisting user edits (fast enough to feel instant). */
    SAVE_DEBOUNCE_MS: 800,
    /** How long the "Saved" toast stays visible. */
    SAVE_TOAST_MS: 3000,
    /** Interval for polling player-bar bottom offset while comment panel is open. */
    OFFSET_POLL_MS: 500,
    /** Interval between retries when waiting for the <audio> element to appear. */
    AUDIO_RETRY_INTERVAL_MS: 500,
    /** Max retries (× AUDIO_RETRY_INTERVAL_MS = 10 s total wait). */
    AUDIO_RETRY_MAX_ATTEMPTS: 20,
    /** Grace period before treating a "waiting" audio as stuck. */
    AUDIO_STALL_TIMEOUT_MS: 5000,
    /** Batch delay for CentralObserver DOM-mutation processing. */
    CENTRAL_OBSERVER_BATCH_MS: 50,
} as const;

/** Hard limits that prevent runaway behaviour. */
export const LIMITS = {
    /** Maximum folder recursion depth for FolderDiver. */
    MAX_DIVE_DEPTH: 6,
    /** Items per translation batch (API rate-limit safe). */
    TRANSLATION_BATCH_SIZE: 30,
    /** Upper bound on items to translate in one session (memory safe). */
    MAX_TRANSLATE_ITEMS: 200,
    /** LRU size for play-count tracking. */
    PLAY_COUNT_CACHE_SIZE: 1000,
    /** Retry limit for programmatic DOM clicks. */
    DOM_CLICK_MAX_ATTEMPTS: 4,
} as const;

/** Progress thresholds (0-1 fractions). */
export const THRESHOLDS = {
    /** Fraction of track played to count as "started listening". */
    LISTENING_PROGRESS: 0.05,
    /** Fraction of track played to count as "listened" (last track only). */
    LISTENED_PROGRESS: 0.85,
    /** Progress fraction past which we suppress the "listening" mark (near end of track). */
    NEAR_END_PROGRESS: 0.90,
    /** Fraction after which a second play counts as a replay. */
    REPLAY_PROGRESS: 0.05,
} as const;

/**
 * Folder-scoring penalties / bonuses.
 *
 * Magnitude matters: penalties must outweigh any realistic duration/track bonus
 * so that sample/cover folders are never auto-selected.
 */
export const SCORING = {
    SAMPLE_FOLDER_PENALTY: -1_000_000,
    COVER_FOLDER_PENALTY: -500_000,
    SCRIPT_FOLDER_PENALTY: -300_000,
    IMAGE_FOLDER_PENALTY: -400_000,
    SE_FOLDER_PENALTY: -50_000,
    SE_PREF_BONUS: 150_000,
    BGM_BONUS: 100_000,
    NO_AUDIO_PENALTY: -2_000_000,
    /** Folders scoring below this are rejected entirely. */
    MINIMUM_VIABLE_SCORE: -400_000,
} as const;
