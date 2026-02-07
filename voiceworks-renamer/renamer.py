import concurrent.futures
import logging
from pathlib import Path
from typing import List, Dict, Optional

import wx

from config_types import Config
from image_handler import ImageHandler
from scanner import Scanner
from scraper import Scraper
from metadata_handler import MetadataHandler
from scraper.folderIcon_manager import FolderIconManager
from file_manager import FileManager
from scraper.translator import Translator
from transcriber import Transcriber
from script_manager import ScriptManager
from title_cleaner import TitleCleaner
from playlist_manager import PlaylistManager
from audio_processor import AudioProcessor
import threading


class Renamer:
    def __init__(
        self, scanner: Scanner, scraper: Scraper, config: Config, app_frame: wx.Frame
    ):
        """Initialize Renamer with required dependencies."""
        self.app_frame = app_frame
        if "rjcode" not in config.get("template", ""):
            raise ValueError("Template must contain 'rjcode'")

        self.config = config
        self.scanner = scanner
        self.file_manager = FileManager(config, scraper)
        self.metadata_handler = MetadataHandler(config, scraper, self.file_manager)
        self.script_manager = ScriptManager(config, scraper, self.metadata_handler)

        # Initialize handlers
        self.image_handler = ImageHandler(scraper, config)
        self.folder_icon_manager = FolderIconManager(config)
        self.transcriber = Transcriber(config)
        self.title_cleaner = TitleCleaner()
        self.translator = Translator(scraper)
        self.playlist_manager = PlaylistManager(config, self.file_manager)
        self.audio_processor = AudioProcessor(
            config,
            self.metadata_handler,
            self.script_manager,
            self.transcriber,
            self.title_cleaner,
            self.playlist_manager,
            self.file_manager,
        )

        self.logger = logging.getLogger(__name__)
        self.total_items = 0
        self.processed_items = 0
        self._progress_lock = threading.Lock()
        self.progress_callback = None

    def set_progress_callback(self, callback):
        """Set callback for progress updates"""
        self.progress_callback = callback

    def log_info(self, rjcode: str, message: str, *args, **kwargs) -> None:
        self.logger.info(f"[{rjcode}] -> {message}", *args, **kwargs)

    def _increment_progress(self):
        """Thread-safe progress increment."""
        with self._progress_lock:
            self.processed_items += 1
            current = self.processed_items
            total = self.total_items
        if total > 0:
            percentage = int(current / total * 100)
            wx.CallAfter(self.app_frame.progress_gauge.SetValue, percentage)

    def run(self, root_paths: List[str]) -> None:
        """Process all folders in the root paths."""
        thread_id = threading.get_ident()
        self.logger.info(
            "******************************Run Start(%s)******************************",
            thread_id,
        )

        self.logger.info("Scanning root paths: %s", root_paths)
        # Scanner.scan expects a single path string; collect results from all paths
        work_folders = []
        for root_path in root_paths:
            work_folders.extend(self.scanner.scan(root_path))
        self.logger.info("Found %d folders to process.", len(work_folders))

        features = self.config.get("features", {})
        with self._progress_lock:
            self.processed_items = 0

        # Calculate total based on enabled features
        if features.get("enable_folder_rename") and not any(
            features.get(f)
            for f in [
                "enable_file_rename",
                "enable_metadata_update",
                "enable_playlist_generation",
                "enable_transcription",
                "enable_cover_art",
                "enable_script_import",
            ]
        ):
            self.total_items = len(work_folders)
        else:
            self.total_items = 0
            for rjcode, path in work_folders:
                audio_files = self.file_manager.get_audio_files(path)
                self.total_items += len(audio_files)

        if self.total_items == 0:
            self.total_items = len(work_folders)  # Fallback to folder count

        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
            futures = {
                executor.submit(self._process_single_folder, rjcode, path): (
                    rjcode,
                    path,
                )
                for rjcode, path in work_folders
            }
            for future in concurrent.futures.as_completed(futures):
                rjcode, path = futures[future]
                try:
                    future.result()
                except Exception as err:
                    self.logger.error(
                        "[%s] -> Failed to process folder %s: %s",
                        rjcode,
                        path,
                        err,
                        exc_info=True,
                    )
        # After all processing is complete, generate playlists
        self.playlist_manager.generate_all_playlists()
        self.logger.info(
            "******************************Run End(%s)******************************\n\n",
            thread_id,
        )

    def _process_single_folder(self, rjcode: str, folder_path: str) -> None:
        """Process a single folder with the given RJ code."""
        self.logger.info("Processing folder: %s", folder_path)
        features = self.config.get("features", {})

        # Get metadata first
        metadata = self.metadata_handler.fetch_metadata(rjcode)
        if not metadata:
            self.logger.warning("No metadata found for RJ code %s", rjcode)
            return

        # Handle folder rename if enabled
        if features.get("enable_folder_rename"):
            new_path = self.file_manager.rename_folder(folder_path, metadata)
            if not new_path:
                self.logger.warning("Failed to rename folder: %s", folder_path)
            else:
                folder_path = new_path

        # Process images if enabled
        saved_images = {}
        if features.get("enable_cover_art"):
            saved_images = self.image_handler.save_images(folder_path, metadata, rjcode)

        # Process folder contents
        self._process_folder_contents(rjcode, folder_path, metadata, saved_images)

        # Update progress for folder rename only if that's the only enabled feature
        if features.get("enable_folder_rename") and not any(
            features.get(f)
            for f in [
                "enable_file_rename",
                "enable_metadata_update",
                "enable_playlist_generation",
                "enable_transcription",
                "enable_cover_art",
                "enable_script_import",
            ]
        ):
            self._increment_progress()
            if self.progress_callback:
                with self._progress_lock:
                    self.progress_callback(self.processed_items, self.total_items)

    def _process_folder_contents(
        self, rjcode: str, folder_path: str, metadata: dict, saved_images: dict
    ) -> None:
        """Process the contents of a folder including audio files and scripts."""
        features = self.config.get("features", {})

        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
            futures = []

            # Add folder icon task
            if features.get("enable_folder_icon"):
                futures.append(
                    executor.submit(
                        self.folder_icon_manager.change_icon,
                        rjcode,
                        folder_path,
                        saved_images,
                    )
                )

            # Add script import task
            if features.get("enable_script_import"):
                futures.append(
                    executor.submit(
                        self.script_manager.import_scripts, rjcode, Path(folder_path)
                    )
                )

            if features.get("enable_product_summary"):
                self.file_manager.save_product_summary(folder_path, metadata, rjcode)

            # Process audio files if any feature requires it
            if any(
                features.get(f)
                for f in [
                    "enable_file_rename",
                    "enable_metadata_update",
                    "enable_playlist_generation",
                    "enable_transcription",
                ]
            ):
                audio_files = self.file_manager.get_audio_files(folder_path)

                for idx, audio_file in enumerate(audio_files):
                    self.audio_processor.process_file(
                        audio_file,
                        rjcode,
                        Path(folder_path),
                        metadata,
                        idx,
                    )
                    self._increment_progress()

            concurrent.futures.wait(futures)

            # Update progress after each folder
            if self.progress_callback:
                with self._progress_lock:
                    self.progress_callback(self.processed_items, self.total_items)

            # Only reset progress gauge after all folders are done
            with self._progress_lock:
                if self.processed_items >= self.total_items:
                    wx.CallAfter(self.app_frame.progress_gauge.SetValue, 0)
                    if self.progress_callback:
                        self.progress_callback(0, 0)
