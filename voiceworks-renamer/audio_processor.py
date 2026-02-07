import logging
from pathlib import Path
from typing import Dict, Optional

from config_types import Config
from metadata_handler import MetadataHandler
from file_manager import FileManager
from transcriber import Transcriber
from script_manager import ScriptManager
from title_cleaner import TitleCleaner
from playlist_manager import PlaylistManager


class AudioProcessor:
    """Handles audio file processing operations"""

    def __init__(
        self,
        config: Config,
        metadata_handler: MetadataHandler,
        script_manager: ScriptManager,
        transcriber: Transcriber,
        title_cleaner: TitleCleaner,
        playlist_manager: PlaylistManager,
        file_manager: FileManager,
    ):
        self.config = config
        self.metadata_handler = metadata_handler
        self.script_manager = script_manager
        self.transcriber = transcriber
        self.title_cleaner = title_cleaner
        self.playlist_manager = playlist_manager
        self.file_manager = file_manager
        self.mutagen_helper = metadata_handler.mutagen_helper
        self.logger = logging.getLogger(__name__)

    def process_file(
        self,
        audio_file: Path,
        rjcode: str,
        folder_path: Path,
        metadata: dict,
        track_idx: int,
    ) -> None:
        """Process a single audio file"""
        try:
            disk_num, track_num, _ = self.title_cleaner.extract_info(audio_file.stem)
            actual_track = track_num if track_num is not None else track_idx
            actual_disk = disk_num if disk_num is not None else None

            # First handle transcription if enabled
            self._handle_transcription(audio_file, rjcode, actual_track, folder_path)

            # After transcription, save scripts as lyrics
            lyrics_data = self.script_manager.get_scripts_as_lyrics(folder_path)

            # Then handle file rename if enabled - store the new path
            new_path = audio_file
            if self.config.get("features", {}).get("enable_file_rename"):
                new_path = self._handle_file_rename(audio_file, actual_track, rjcode)

            # Update metadata using the new path if file was renamed and metadata updates are enabled
            if self.config.get("features", {}).get("enable_metadata_update"):
                self._update_metadata(
                    new_path if new_path else audio_file,
                    rjcode,
                    metadata,
                    actual_track,
                    actual_disk,
                    track_idx,
                    lyrics_data,
                )

            # Update playlists with new path
            self._update_playlists(new_path or audio_file, metadata, folder_path)

        except Exception as e:
            self.logger.error(
                "[%s] -> Failed to process audio file %s: %s",
                rjcode,
                audio_file.name,
                str(e),
                exc_info=True,
            )

    def _handle_transcription(
        self, audio_file: Path, rjcode: str, track_num: int, folder_path: Path
    ) -> None:
        """Handle audio transcription if enabled"""
        if not self.config.get("features", {}).get("enable_transcription"):
            return

        # Check if transcript already exists in local scripts folder
        local_script_dir = folder_path / "scripts" / "ja"
        txt_path = local_script_dir / f"{audio_file.stem}.txt"
        lrc_path = local_script_dir / f"{audio_file.stem}.lrc"

        # Skip if both txt and lrc files exist
        if txt_path.exists() and lrc_path.exists():
            self.logger.info(
                "[%s] Skipping transcription - transcript already exists for: %s",
                rjcode,
                audio_file.name,
            )
            return

        # Perform transcription if files don't exist
        transcription = self.transcriber.transcribe_file(str(audio_file), rjcode)
        if transcription:
            self.script_manager.save_transcription(
                transcription, rjcode, track_num, folder_path
            )

    def _update_metadata(
        self,
        audio_file: Path,
        rjcode: str,
        metadata: dict,
        track_num: int,
        disk_num: Optional[int],
        track_idx: int,
        lyrics_data: Optional[Dict] = None,
    ) -> Dict:
        """Update audio file metadata including lyrics."""
        # Guard against disabled metadata updates
        if not self.config.get("features", {}).get("enable_metadata_update"):
            return {}

        # Handle None lyrics_data safely
        lyrics_data = lyrics_data or {}

        # Get lyrics based on track index
        track_lyrics = lyrics_data.get(track_idx, {})

        # Merge metadata with lyrics data, letting track-specific lyrics override general metadata
        combined_metadata = {**metadata}
        if track_lyrics:
            # Add all lyrics-related fields from track_lyrics to metadata
            for key, value in track_lyrics.items():
                if key.startswith(("USLT::", "SYLT::", "SYLT_SYNC::", "lyrics")):
                    combined_metadata[key] = value

        # Log if lyrics were found
        if any(key.startswith(("USLT::", "SYLT::")) for key in track_lyrics):
            self.logger.debug(
                "[%s] Added lyrics to track %s (%s)", rjcode, track_idx, audio_file.name
            )

        return self.metadata_handler.update_metadata(
            str(audio_file), combined_metadata, track_num, disk_num
        )

    def _update_playlists(
        self, audio_file: Path, metadata: dict, folder_path: Path
    ) -> None:
        """Update playlists if enabled"""
        if self.config.get("features", {}).get("enable_playlist_generation"):
            self.playlist_manager.update_playlists(audio_file, metadata, folder_path)
            # No need to generate playlists here

    def _handle_file_rename(
        self, audio_file: Path, track_num: int, rjcode: str
    ) -> Optional[Path]:
        """Handle file renaming if enabled and return new path if renamed"""
        features = self.config.get("features", {})
        if not features.get("enable_file_rename"):
            return None

        new_name = self._generate_new_filename(audio_file, track_num, rjcode)
        new_path = audio_file.parent / new_name

        if not audio_file.exists():
            self.logger.error("[%s] -> Source file missing: %s", rjcode, audio_file)
            return None

        if self._rename_file(audio_file, new_path, rjcode):
            return new_path

        return None

    def _rename_file(self, source: Path, target: Path, rjcode: str) -> bool:
        """Rename file and return True if successful"""
        try:
            if source == target:
                return True
            if target.exists() and not self.config.get("overwrite_existing"):
                self.logger.warning(
                    "[%s] -> Target file already exists, skipping: %s", rjcode, target
                )
                return False
            source.rename(target)
            return True
        except OSError as e:
            self.logger.error(
                "[%s] -> Failed to rename %s to %s: %s", rjcode, source, target, e
            )
            return False

    def _generate_new_filename(
        self, audio_file: Path, track_num: int, rjcode: str
    ) -> str:
        """Generate new filename for audio file"""
        title = audio_file.stem
        new_title = self.title_cleaner.clean(title, track_num)

        # Translate the cleaned title if translation is enabled
        features = self.config.get("features", {})
        if features.get("enable_translation"):
            new_title = self.file_manager.translate_content(
                [new_title],
                rjcode,
            ).get(new_title, new_title)

        new_name = self.file_manager.sanitize_filename(new_title, rjcode=rjcode)
        return f"{new_name}{audio_file.suffix}"
