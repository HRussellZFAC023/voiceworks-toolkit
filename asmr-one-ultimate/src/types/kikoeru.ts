/**
 * Legacy Kikoeru Types
 *
 * @deprecated Import from './index' or './store' instead.
 * This file is maintained for backward compatibility only.
 */

// Re-export from new type files for backward compatibility
export type {
    AudioTrack,
    PlayerTrack,
} from './api';

export type {
    AudioPlayerState,
    UserState,
    WorksState,
    ViewState,
    PlaylistState,
    KikoeruStore,
    KikoeruApp,
} from './store';
