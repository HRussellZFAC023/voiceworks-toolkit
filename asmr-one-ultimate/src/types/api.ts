/**
 * ASMR.one API Types - Comprehensive type definitions for all API endpoints
 *
 * API Reference:
 * - GET /api/work/{id}     - Full work details with user-specific data (userRating, progress, myVote)
 * - GET /api/workInfo/{id} - Work info without user-specific data (public view)
 * - GET /api/tracks/{id}?v=2 - File/folder tree structure
 * - GET /api/works         - Paginated work list with filters
 * - GET /api/search/{q}    - Full-text search
 * - GET /api/tags          - All tags
 * - GET /api/vas           - All voice actors
 * - GET /api/circles       - All circles
 * - GET /api/cover/{id}.jpg?type=main|sam|240x240 - Cover images
 */

import { DEFAULT_API_SERVER } from '../core/Constants';

// ============================================================================
// Base Response Types
// ============================================================================

export interface ApiResponse<T> {
    data: T;
    status: number;
    message?: string;
}

export interface PaginatedResponse<T> {
    works: T[];
    pagination: {
        currentPage: number;
        pageSize: number;
        totalCount: number;
    };
}

// ============================================================================
// Tag Types - /api/tags, embedded in work responses
// ============================================================================

/** Tag i18n translations for a specific locale */
export interface TagI18nLocale {
    name?: string;
    history?: Array<{
        name: string;
        deprecatedAt: number;
    }>;
}

/** Tag i18n container */
export interface TagI18n {
    'en-us'?: TagI18nLocale;
    'ja-jp'?: TagI18nLocale;
    'zh-cn'?: TagI18nLocale;
}

/** Full tag with voting and i18n - from /api/work/{id} */
export interface WorkTag {
    id: number;
    name: string;
    i18n?: TagI18n;
    /** User upvotes for this tag on the work */
    upvote?: number;
    /** User downvotes for this tag on the work */
    downvote?: number;
    /** Tag ranking by votes */
    voteRank?: number;
    /** 0 = pending, 1 = approved */
    voteStatus?: number;
    /** Current user's vote: -1 = downvote, 0 = none, 1 = upvote */
    myVote?: number;
}

/** Simplified tag for lists */
export interface TagEntry {
    id: number;
    name: string;
    /** Japanese name */
    ja?: string;
    /** English name */
    en?: string;
    /** Usage count */
    count?: number;
}

// ============================================================================
// Voice Actor Types - /api/vas, embedded in work responses
// ============================================================================

export interface VoiceActor {
    /** UUID string for VAs */
    id: string;
    name: string;
}

/** VA entry from /api/vas list */
export interface VAEntry {
    id: string;
    name: string;
    /** Number of works */
    count?: number;
}

// ============================================================================
// Circle Types - /api/circles, embedded in work responses
// ============================================================================

export interface Circle {
    id: number;
    name: string;
    source_id?: string;
    source_type?: 'DLSITE' | string;
}

/** Circle entry from /api/circles list */
export interface CircleEntry {
    id: number;
    name: string;
    source_id?: string;
    /** Number of works */
    count?: number;
}

// ============================================================================
// Rating Types - embedded in work responses
// ============================================================================

export interface RateCountDetail {
    /** Rating value 1-5 */
    review_point: number;
    /** Number of ratings at this point */
    count: number;
    /** Percentage of total ratings */
    ratio: number;
}

export interface WorkRank {
    /** 'day' | 'week' | 'month' */
    term: 'day' | 'week' | 'month';
    /** 'all' | 'voice' | category specific */
    category: string;
    /** Rank position */
    rank: number;
    /** Date when this rank was achieved */
    rank_date: string;
}

// ============================================================================
// Language Edition Types - for multi-language works
// ============================================================================

export interface LanguageEdition {
    /** Language code: JPN, CHI_HANS, CHI_HANT, KO_KR, ENG, etc. */
    lang: string;
    /** Display label in Japanese */
    label: string;
    /** Work number for this edition */
    workno: string;
    edition_id: number;
    edition_type: 'language';
    display_order: number;
}

export interface TranslationStatusEntry {
    is_denied: boolean;
    bonus_price: number;
    is_available: boolean;
    applied_count: number;
    on_sale_count: number;
}

export interface TranslationInfo {
    lang: string | null;
    is_child: boolean;
    is_parent: boolean;
    is_original: boolean;
    is_volunteer: boolean;
    child_worknos: string[];
    parent_workno: string | null;
    original_workno: string | null;
    is_translation_agree: boolean;
    translation_bonus_langs: string[];
    is_translation_bonus_child: boolean;
    translation_status_for_translator: Record<string, TranslationStatusEntry>;
}

// ============================================================================
// Track/File Types - /api/tracks/{id}?v=2
// ============================================================================

/** Embedded work reference in track items */
export interface TrackWorkRef {
    id: number;
    source_id: string;
    source_type: 'DLSITE' | string;
}

/** Base track item (audio, image, text, other) */
export interface TrackItem {
    type: 'audio' | 'image' | 'text' | 'other';
    hash: string;
    title: string;
    work?: TrackWorkRef;
    workTitle?: string;
    /** Streaming URL */
    mediaStreamUrl?: string;
    /** Download URL */
    mediaDownloadUrl?: string;
    /** File size in bytes */
    size?: number;
    /** Duration in seconds (for audio) */
    duration?: number;
    /** Some host serializers attach empty folder fields to leaf items. */
    children?: [];
    dirs?: [];
    tracks?: [];
}

/** Audio track with extended metadata */
export interface AudioTrack extends TrackItem {
    type: 'audio';
    duration?: number;
    /** Alternate URL field names from API variations */
    src?: string;
    media_stream_url?: string;
    stream_url?: string;
    media_download_url?: string;
    file_url?: string;
    url?: string;
    /** Work ID references */
    work_title?: string;
    workId?: string | number;
    work_id?: string | number;
    is_audio?: boolean;
}

/** Folder node in track tree */
export interface TrackFolder {
    type: 'folder';
    title: string;
    children: Array<TrackFolder | TrackItem>;
}

/** Root tracks response - array of folders and items */
export type TracksResponse = Array<TrackFolder | TrackItem>;

// ============================================================================
// Work Types - /api/work/{id}, /api/workInfo/{id}
// ============================================================================

/** Core work data shared by all work responses */
export interface WorkCore {
    id: number;
    title: string;
    circle_id: number;
    /** Circle name (denormalized) */
    name: string;
    nsfw: boolean;
    /** Release date YYYY-MM-DD */
    release: string;
    dl_count: number;
    price: number;
    review_count: number;
    rate_count: number;
    rate_average_2dp: number;
    rate_count_detail: RateCountDetail[];
    rank: WorkRank[];
    has_subtitle: boolean;
    /** Date added to asmr.one */
    create_date: string;
    vas: VoiceActor[];
    tags: WorkTag[];
    language_editions: LanguageEdition[];
    original_workno: string | null;
    other_language_editions_in_db: string[];
    translation_info: TranslationInfo;
    /** Encoded work attributes string */
    work_attributes: string;
    /** 'adult' | 'all' | 'r15' */
    age_category_string: string;
    /** Total duration in seconds */
    duration: number;
    source_type: 'DLSITE' | string;
    source_id: string;
    sourceId?: string | number;
    source_url: string;
    circle: Circle;
    /** Small cover URL */
    samCoverUrl: string;
    /** 240x240 thumbnail URL */
    thumbnailCoverUrl: string;
    /** Main/large cover URL */
    mainCoverUrl: string;
}

/** Work info response - /api/workInfo/{id} (no user data) */
export interface WorkInfo extends WorkCore {
    // WorkInfo has same structure as WorkCore but without user fields
}

/** Full work response - /api/work/{id} (includes user data) */
export interface Work extends WorkCore {
    /** User's personal rating (null if not rated) */
    userRating: number | null;
    /** User's review text (null if none) */
    review_text: string | null;
    /** User's progress status */
    progress: 'marked' | 'listening' | 'listened' | 'replay' | 'postponed' | null;
    /** Last update timestamp */
    updated_at: string | null;
    /** Username who rated (for public profiles) */
    user_name: string | null;
}

/** Work detail with directory tree (used in player) */
export interface WorkDetail extends Work {
    description?: string;
    summary?: string;
    /** Directory tree structure */
    dirs?: WorkFolder[];
    tracks?: AudioTrack[];
    children?: WorkFolder[];
}

/** Legacy work folder structure (from Vuex store) */
export interface WorkFolder {
    name: string;
    title?: string;
    type?: 'folder' | 'directory';
    children_count?: number;
    duration_text?: string;
    caption?: string;
    tracks?: AudioTrack[];
    dirs?: WorkFolder[];
    children?: WorkFolder[];
}

/** Work summary for lists (lighter than full Work) */
export interface WorkSummary {
    id: number | string;
    title: string;
    circle?: Circle;
    nsfw: boolean;
    release: string;
    dl_count?: number;
    price?: number;
    rate_count?: number;
    review_count?: number;
    rate_average_2dp?: number;
    rate_count_detail?: RateCountDetail[];
    rank?: WorkRank[];
    has_subtitle?: boolean;
    create_date?: string;
    tags: WorkTag[];
    vas: VoiceActor[];
    /** Legacy cover URL field */
    main_cover_url?: string;
    samCoverUrl?: string;
    thumbnailCoverUrl?: string;
    mainCoverUrl?: string;
}

// ============================================================================
// Search & Filter Types
// ============================================================================

export type SortOrder = 'asc' | 'desc';

export type WorkOrder =
    | 'release'
    | 'rating'
    | 'dl_count'
    | 'price'
    | 'rate_average_2dp'
    | 'review_count'
    | 'id'
    | 'nsfw'
    | 'insert_time'
    | 'create_date'
    | 'random'
    | 'betterRandom';

export interface WorkSearchParams {
    page?: number;
    order?: WorkOrder;
    sort?: SortOrder;
    /** Comma-separated tag IDs to include */
    tags?: string;
    /** Comma-separated tag IDs to exclude */
    exclude_tags?: string;
    /** Search query */
    query?: string;
    /** Filter by circle ID */
    circle?: number;
    /** Filter by VA ID */
    vas?: string;
    /** NSFW filter */
    nsfw?: boolean;
    /** Filter by subtitle availability */
    hasSubtitle?: boolean;
    /** Random seed for random/betterRandom order */
    seed?: number;
}

/** Works list response - /api/works */
export interface WorksResponse {
    works: Work[];
    pagination: {
        currentPage: number;
        pageSize: number;
        totalCount: number;
    };
}

// ============================================================================
// Player State Types
// ============================================================================

export type PlayMode = 'order' | 'repeat' | 'repeat-one' | 'shuffle';

export interface PlayModeObject {
    id: number;
    name: PlayMode;
}

/**
 * Available lyrics/subtitle file associated with a track.
 * Found in track.availableLyrics[] array.
 */
export interface AvailableLyric {
    /** File type, e.g., 'text' */
    type: 'text' | string;
    /** Unique hash identifier */
    hash: string;
    /** File name/title, e.g., 'ASMR - 01.vtt' */
    title: string;
    /** Parent work reference */
    work?: TrackWorkRef;
    /** Work title */
    workTitle?: string;
    /** Streaming URL for the lyrics file (VTT, LRC, etc.) */
    mediaStreamUrl: string;
    /** Download URL for the lyrics file */
    mediaDownloadUrl?: string;
    /** File size in bytes */
    size?: number;
}

/**
 * Full player track structure as stored in AudioPlayer.queue[].
 * This is the actual runtime structure used by the Kikoeru/ASMR.one player.
 *
 * IMPORTANT: The current track is at queue[queueIndex], NOT at currentTrack
 * or currentPlayingFile (those properties don't exist in the store).
 */
export interface PlayerTrack {
    /** Track type - 'audio' for playable tracks */
    type: 'audio' | 'image' | 'text' | 'other';
    /** Unique hash identifier for the file */
    hash: string;
    /** Track/file title */
    title: string;
    /** Reference to the parent work */
    work?: TrackWorkRef;
    /** Work title (denormalized) */
    workTitle?: string;
    /** Primary streaming URL for the track */
    mediaStreamUrl: string;
    /** Download URL for the track */
    mediaDownloadUrl?: string;
    /** Low quality streaming URL (for bandwidth saving) */
    streamLowQualityUrl?: string;
    /** Low quality streaming URL (snake_case host variant) */
    stream_low_quality_url?: string;
    /** Duration in seconds */
    duration?: number;
    /** File size in bytes */
    size?: number;
    /** Available lyrics/subtitle files for this track */
    availableLyrics?: AvailableLyric[];
    /** Cover image URL */
    cover?: string;

    // Legacy/alternative URL field names (for compatibility)
    /** Alternative URL field */
    src?: string;
    /** Alternative URL field */
    media_stream_url?: string;
    /** Alternative URL field */
    stream_url?: string;
    /** Alternative URL field */
    media_download_url?: string;
    /** Alternative URL field */
    file_url?: string;
    /** Alternative URL field */
    url?: string;
    /** Work ID (alternative field) */
    workId?: string | number;
    /** Work ID (snake_case alternative) */
    work_id?: string | number;
    /** Work title (snake_case alternative) */
    work_title?: string;
}

// ============================================================================
// Cover Image URLs
// ============================================================================

export type CoverType = 'main' | 'sam' | '240x240';

/**
 * Build cover URL for a work
 * @param workId - Numeric work ID (without RJ prefix)
 * @param type - 'main' (large), 'sam' (small), '240x240' (thumbnail)
 */
export function buildCoverUrl(workId: number | string, type: CoverType = 'main', server?: string): string {
    const id = typeof workId === 'string' ? workId.replace(/\D/g, '') : workId;
    // Return empty string for invalid/empty IDs - caller should handle with fallback
    if (!id || id === '' || id === '0') {
        return '';
    }
    const baseUrl = (server || DEFAULT_API_SERVER).replace(/\/$/, '');
    return `${baseUrl}/api/cover/${id}.jpg?type=${type}`;
}

// ============================================================================
// Whisper Types
// ============================================================================

export interface WhisperWord {
    start: number;
    end: number;
    text: string;
}

export interface WhisperSegment {
    start: number;
    end: number;
    text: string;
    words?: WhisperWord[];
}

export interface WhisperResult {
    text: string;
    segments: WhisperSegment[];
    webvtt?: string;
    language?: string;
}

export interface WhisperProgress {
    message: string;
    percent: number;
    stage: 'loading' | 'model' | 'transcribing';
    loading: boolean;
}

// ============================================================================
// Vector Search Types
// ============================================================================

export interface VectorEntry {
    id: string;
    title: string;
    description: string;
    tags: string[];
    searchTags?: string[];
    circle?: string;
    vas?: string[];
    series?: string;
    searchText?: string;
    cover?: string;
    vector: number[];
}

export interface VectorSearchResult {
    entry: VectorEntry;
    score: number;
}

// ============================================================================
// Translation Types
// ============================================================================

export type SupportedLanguage = 'en' | 'ja' | 'zh' | 'ko' | 'es' | 'fr' | 'de';

export interface TranslationResult {
    original: string;
    translated: string;
    sourceLang?: SupportedLanguage;
    targetLang: SupportedLanguage;
}

// ============================================================================
// Playlist Types - /api/playlist/*
// ============================================================================

export type PlaylistPrivacy = 0 | 1 | 2; // 0=private, 1=unlisted, 2=public

export interface Playlist {
    id: string;
    name: string;
    description?: string;
    privacy: PlaylistPrivacy;
    works: string[]; // RJ codes
    created_at: string;
    updated_at: string;
}

// ============================================================================
// History Types - /api/history
// ============================================================================

/** Play history record for a specific track */
export interface HistoryRecord {
    work_id: number;
    file_index: number;
    file_name: string;
    /** Current playback position in seconds */
    play_time: number;
    /** Total duration in seconds */
    total_time: number;
    created_at?: string;
    updated_at?: string;
    user_name?: string;
}

/** Parameters for recording play history */
export interface HistoryParams {
    work_id: number;
    file_index: number;
    file_name: string;
    play_time: number;
    total_time: number;
}

// ============================================================================
// Auth Types - /api/auth/me
// ============================================================================

export interface AuthLoginParams {
    name: string;
    password: string;
}

export interface AuthLoginResponse {
    token: string;
}

export interface AuthUserResponse {
    user: {
        name: string;
        group: 'administrator' | 'user' | 'guest';
    };
    auth: boolean;
}

// ============================================================================
// Review List Types - GET /api/review
// ============================================================================

export type ProgressFilter = 'marked' | 'listening' | 'listened' | 'replay' | 'postponed';

export interface ReviewListParams {
    page?: number;
    sort?: 'desc' | 'asc';
    seed?: number;
    order?: string;
    filter?: ProgressFilter;
}

export interface ReviewListResponse {
    works: Work[];
    pagination: {
        currentPage: number;
        pageSize: number;
        hasMore: boolean;
    };
}

// ============================================================================
// Media Types - /api/media
// ============================================================================

export interface LrcCheckResponse {
    result: boolean;
    message: string;
    hash?: string;
}
