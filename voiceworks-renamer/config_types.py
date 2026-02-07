from typing import TypedDict, Optional


class FeatureFlags(TypedDict):
    """Configuration flags for individual features"""

    enable_folder_rename: bool  # Controls folder renaming
    enable_file_rename: bool  # Controls file renaming
    enable_metadata_update: bool  # Controls audio metadata updates
    enable_cover_art: bool  # Controls cover art handling
    enable_playlist_generation: bool  # Controls playlist generation
    enable_transcription: bool  # Controls transcription features
    enable_translation: bool  # Controls translation features
    enable_folder_icon: bool  # Controls folder icon generation
    enable_script_import: bool  # Controls script importing/handling


class Config(TypedDict):
    scanner_max_depth: int
    locale: str
    connect_timeout: int
    read_timeout: int
    sleep_interval: int
    template: str
    renamer_release_date_format: str
    remove_image_files: bool
    save_cover_jpg: bool
    cv_list_left: str
    cv_list_right: str
    save_sample_images: bool
    translation_map: dict
    enable_transcription: bool
    overwrite_existing: bool
    enable_playlist_generation: bool
    playlist_directory: str
    features: FeatureFlags
