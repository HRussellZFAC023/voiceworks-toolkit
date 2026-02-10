/**
 * Central Type Exports
 *
 * Import types from here rather than individual files for cleaner imports:
 * import { AudioTrack, KikoeruStore, ConfigKey } from '../types';
 */

// API types - data structures from Kikoeru and external APIs
export type {
    ApiResponse,
    PaginatedResponse,
    WorkTag,
    VoiceActor,
    Circle,
    WorkSummary,
    AudioTrack,
    TrackItem,
    WorkFolder,
    WorkDetail,
    SortOrder,
    WorkOrder,
    WorkSearchParams,
    PlayMode,
    PlayModeObject,
    PlayerTrack,
    AvailableLyric,
    WhisperSegment,
    WhisperWord,
    WhisperResult,
    WhisperProgress,
    VectorEntry,
    VectorSearchResult,
    SupportedLanguage,
    TranslationResult,
    TagEntry,
} from './api';

// DLsite types - external scraping and metadata
export type {
    DLsiteProductApiResponse,
    DLsiteDynamicApiResponse,
    DLsiteDynamicEntry,
    DLsiteGenre,
    DLsiteCreater,
    DLsiteContentFile,
    DLsiteImageFile,
    DLsiteDiscountInfo,
    DLsiteMetadata,
} from './dlsite';

// JPDB types
export {
    JPDBCardState,
} from './jpdb';
export type {
    JPDBCard,
    JPDBToken,
    JPDBRuby,
    JPDBMeaning,
    JPDBGrade,
    JPDBDeck,
    JPDBParsedResult,
    JPDBParseResult,
    JPDBRawToken,
    JPDBRawVocabulary,
    JPDBSpecialDeckName,
} from './jpdb';

// Store types - application state structures
export type {
    AudioPlayerState,
    UserState,
    WorksState,
    ViewState,
    PlaylistState,
    KikoeruStoreState,
    KikoeruStore,
    VueRouter,
    VueRoute,
    AxiosInstance,
    KikoeruApp,
    WorkTreeComponent,
    FatherFolderItem,
    PluginConfig,
    ConfigKey,
    RadioState,
    RadioModeState,
    LearnerModeState,
    WhisperState,
    PlaylistModeState,
    SearchState,
    AppState,
    AppEvents,
    AppEventName,
    AppEventPayload,
    WhisperUpdatePayload,
} from './store';

