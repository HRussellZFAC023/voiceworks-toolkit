/**
 * Constants - Named constants replacing magic numbers throughout the codebase.
 *
 * Every value has a comment explaining *why* it exists at that magnitude.
 */

// =============================================================================
// URLs
// =============================================================================

/** Default API server URL — used as fallback when the host app's axios baseURL is unavailable. */
export const DEFAULT_API_SERVER = 'https://api.asmr-200.com';

// =============================================================================
// Timing
// =============================================================================

/** Timing constants (milliseconds unless noted). */
export const TIMING = {
    /** Debounce before persisting user edits (fast enough to feel instant). */
    SAVE_DEBOUNCE_MS: 800,
    /** How long the "Saved" toast stays visible. */
    SAVE_TOAST_MS: 3000,
    /** Default notification (toast) display duration. */
    NOTIFICATION_MS: 3000,
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
    /** Debounce for CentralObserver feature registrations (fast enough to catch DOM settles). */
    OBSERVER_REGISTER_DEBOUNCE_MS: 500,
    /** Default timeout for GM_xmlhttpRequest / fetch calls. */
    HTTP_TIMEOUT_MS: 30_000,
    /** One requestAnimationFrame tick — used for DOM click simulation delays. */
    DOM_FRAME_MS: 16,
    /** Initial backoff delay for exponential retry (429 handling, scroll retry). */
    INITIAL_BACKOFF_MS: 1000,
    /** Exponential backoff multiplier per retry attempt. */
    BACKOFF_MULTIPLIER: 2,
} as const;

// =============================================================================
// Cache TTLs
// =============================================================================

/** Cache time-to-live durations (milliseconds). */
export const CACHE_TTL = {
    /** Long-lived caches: translation results, embedding vectors (30 days). */
    THIRTY_DAYS_MS: 1000 * 60 * 60 * 24 * 30,
    /** Medium-lived caches: DLsite scraper metadata (7 days). */
    SEVEN_DAYS_MS: 1000 * 60 * 60 * 24 * 7,
    /** Short-lived caches: work metadata, track lists (24 hours). */
    TWENTY_FOUR_HOURS_MS: 24 * 60 * 60 * 1000,
} as const;

// =============================================================================
// Retry
// =============================================================================

/** Default retry configuration for API calls. */
export const RETRY = {
    /** Standard retry for JSON API calls (e.g. Works API). */
    API_JSON: { attempts: 2, backoffMs: 1000, multiplier: 2 },
    /** Retry for HTML scraping (slightly more conservative). */
    API_HTML: { attempts: 2, backoffMs: 1000, multiplier: 2 },
    /** Retry for blob/image fetches (shorter backoff). */
    BLOB: { attempts: 2, backoffMs: 500 },
} as const;

// =============================================================================
// Limits
// =============================================================================

/** Hard limits that prevent runaway behaviour. */
export const LIMITS = {
    /** Maximum folder recursion depth for FolderDiver (works can nest 7+ levels deep). */
    MAX_DIVE_DEPTH: 15,
    /** Items per translation batch (API rate-limit safe). */
    TRANSLATION_BATCH_SIZE: 30,
    /** Upper bound on items to translate in one session (memory safe). */
    MAX_TRANSLATE_ITEMS: 200,
    /** LRU size for play-count tracking. */
    PLAY_COUNT_CACHE_SIZE: 1000,
    /** Retry limit for programmatic DOM clicks. */
    DOM_CLICK_MAX_ATTEMPTS: 4,
    /** Maximum pages to fetch when paginating DLsite reviews or search results. */
    MAX_REVIEW_PAGES: 10,
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
    BGM_FOLDER_PENALTY: -50_000,
    BGM_PREF_BONUS: 150_000,
    NO_AUDIO_PENALTY: -2_000_000,
    /** Folders scoring below this are rejected entirely. */
    MINIMUM_VIABLE_SCORE: -400_000,
} as const;
