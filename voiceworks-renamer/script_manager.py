# script_manager.py

import logging
import shutil
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import List, Optional, Union
import re
from dataclasses import dataclass
import difflib

from config_types import Config
from metadata_handler import MetadataHandler


@dataclass
class TimedText:
    """Represents text with start and end timestamps."""

    start: float
    end: float
    text: str


class ScriptManager:
    """Handles script management, storage, and translation."""

    def __init__(self, config: Config, scraper, metadata_handler: MetadataHandler):
        self.logger = logging.getLogger(__name__)
        self.config = config
        self.scraper = scraper
        self.metadata_handler = metadata_handler
        self.scripts_root = Path("__scripts__")
        self.scripts_root.mkdir(exist_ok=True)

    def get_rj_folder(self, rjcode: str) -> Path:
        """Get the folder path for a given RJ code."""
        numeric_id = re.sub(r"^RJ0*", "", rjcode)
        folder = self.scripts_root / numeric_id
        folder.mkdir(parents=True, exist_ok=True)
        return folder

    def save_transcription(
        self, transcription: dict, rjcode: str, track_num: int, target_dir: Path
    ):
        """Save transcription in both TXT and LRC formats and handle translations."""
        base_name = transcription.get("original_filename", str(track_num))
        segments = transcription["segments"]

        # Generate and save LRC content
        lrc_content = self._generate_lrc(segments)
        ja_dir = self._prepare_language_directory(target_dir, "ja")
        lrc_path = ja_dir / f"{base_name}.lrc"
        self._save_text(lrc_path, lrc_content)

        # Generate and save plain text content
        txt_content = self._combine_segments(segments)
        txt_path = ja_dir / f"{base_name}.txt"
        self._save_text(txt_path, txt_content)

        # Translate and save if enabled
        if self.config.get("features", {}).get("enable_translation"):
            translated_segments = self._translate_segments(segments, rjcode)
            if translated_segments:
                target_lang = self.config.get("locale", "en_us").split("_")[0]
                lang_dir = self._prepare_language_directory(target_dir, target_lang)

                # Save translated LRC
                translated_lrc_content = self._generate_lrc(translated_segments)
                translated_lrc_path = lang_dir / f"{base_name}.lrc"
                self._save_text(translated_lrc_path, translated_lrc_content)

                # Save translated TXT
                translated_txt_content = self._combine_segments(translated_segments)
                translated_txt_path = lang_dir / f"{base_name}.txt"
                self._save_text(translated_txt_path, translated_txt_content)

    def _prepare_language_directory(self, target_dir: Path, lang_code: str) -> Path:
        """Create and return the language-specific scripts directory."""
        lang_dir = target_dir / "scripts" / lang_code
        lang_dir.mkdir(parents=True, exist_ok=True)
        return lang_dir

    def _save_text(self, path: Path, content: str) -> None:
        """Save text content to a file."""
        with path.open("w", encoding="utf-8") as f:
            f.write(content)

    def _generate_lrc(self, segments: List[Union[dict, TimedText]]) -> str:
        """Generate LRC content from segments."""
        lrc_lines = []
        for segment in segments:
            if isinstance(segment, TimedText):
                text = segment.text.strip()
                start_time = segment.start
            else:
                text = segment["text"].strip()
                start_time = segment["timestamp"][0]

            if not text:
                continue
            time_str = self._format_lrc_timestamp(start_time)
            lrc_lines.append(f"{time_str}{text}")
        return "\n".join(lrc_lines)

    def _format_lrc_timestamp(self, seconds: float) -> str:
        """Convert seconds to LRC timestamp format [mm:ss.xx]."""
        minutes = int(seconds // 60)
        seconds_remainder = seconds % 60
        return f"[{minutes:02d}:{seconds_remainder:05.2f}]"

    def _combine_segments(self, segments: List[Union[dict, TimedText]]) -> str:
        """Combine segments into a single text string."""
        combined_text = ""
        for segment in segments:
            text = (
                segment.text.strip()
                if isinstance(segment, TimedText)
                else segment["text"].strip()
            )
            if text:
                combined_text += text + "\n"
        return combined_text.strip()

    def _translate_segments(self, segments: List[dict], rjcode: str) -> List[TimedText]:
        """Translate segments while preserving timestamps."""
        lrc_content = self._generate_lrc(segments)
        translated_lrc = self._translate_text_with_timestamps(lrc_content, rjcode)
        translated_segments = self._parse_lrc_to_segments(translated_lrc)
        return translated_segments

    def _translate_text_with_timestamps(self, text: str, rjcode: str) -> Optional[str]:
        """Translate text while preserving timestamps."""
        if not text:
            return None

        # Protect timestamps by replacing them with placeholders
        timestamp_pattern = r"(\[\d{2}:\d{2}\.\d{2}\])"
        placeholders = re.findall(timestamp_pattern, text)
        text_without_timestamps = re.sub(timestamp_pattern, "<TIMESTAMP>", text)

        # Translate the text without timestamps
        target_language = self.config.get("locale", "en_us").split("_")[0]
        translated_text = self.scraper.translate(
            text_without_timestamps, target_language=target_language, rjcode=rjcode
        )
        if isinstance(translated_text, list):
            translated_text = "\n".join(translated_text)

        # Restore timestamps
        translated_lines = translated_text.split("<TIMESTAMP>")
        if len(translated_lines) != len(placeholders) + 1:
            self.logger.warning(
                "[%s] Mismatch between placeholders and timestamps after translation.",
                rjcode,
            )

        reconstructed_text = ""
        for i, line in enumerate(translated_lines):
            reconstructed_text += line
            if i < len(placeholders):
                reconstructed_text += placeholders[i]

        return reconstructed_text.strip()

    def _parse_lrc_to_segments(self, lrc_content: str) -> List[TimedText]:
        """Parse translated LRC content back into segments."""
        segments = []
        lines = lrc_content.strip().splitlines()
        for line in lines:
            match = re.match(r"\[(\d+):(\d+\.\d+)\](.*)", line)
            if match:
                minutes = int(match.group(1))
                seconds = float(match.group(2))
                text = match.group(3).strip()
                start_time = minutes * 60 + seconds
                segments.append(TimedText(start=start_time, end=0.0, text=text))

        # Update end times, ensuring they are greater than start times
        for i in range(len(segments) - 1):
            current_segment = segments[i]
            next_segment = segments[i + 1]
            current_segment.end = max(next_segment.start, current_segment.start + 0.01)
        if segments:
            segments[-1].end = (
                segments[-1].start + 5.0
            )  # Default duration for last segment

        return segments

    def import_scripts(self, rjcode: str, target_dir: Path) -> bool:
        """Import scripts and handle translations if enabled."""
        source_dir = self.get_rj_folder(rjcode)
        if not source_dir.exists():
            return False

        script_files = sorted(source_dir.glob("*.*"), key=self._sort_script_files)
        if not script_files:
            return False

        # Copy scripts to the target directory
        ja_dir = self._prepare_language_directory(target_dir, "ja")
        for script in script_files:
            shutil.copy2(script, ja_dir / script.name)

        # Translate scripts if enabled
        if self.config.get("features", {}).get("enable_translation"):
            self._translate_imported_scripts(target_dir, rjcode)

        return True

    def _translate_imported_scripts(self, target_dir: Path, rjcode: str) -> None:
        """Translate imported scripts in the target directory."""
        target_language = self.config.get("locale", "en_us").split("_")[0]
        ja_dir = target_dir / "scripts" / "ja"
        target_scripts_dir = self._prepare_language_directory(
            target_dir, target_language
        )

        script_files = sorted(ja_dir.glob("*.*"), key=self._sort_script_files)
        if not script_files:
            return

        def translate_file(script_path: Path):
            try:
                content = script_path.read_text(encoding="utf-8")
                translated_content = self._translate_text_with_timestamps(
                    content, rjcode
                )
                if translated_content:
                    target_path = target_scripts_dir / script_path.name
                    self._save_text(target_path, translated_content)
            except Exception as e:
                self.logger.error(
                    "[%s] -> Failed to translate script %s: %s",
                    rjcode,
                    script_path.name,
                    str(e),
                )

        with ThreadPoolExecutor(max_workers=6) as executor:
            list(executor.map(translate_file, script_files))

    def get_scripts_as_lyrics(self, work_dir: Path) -> dict:
        """Collects and returns lyrics data from imported scripts."""
        scripts_dir = work_dir / "scripts"
        lyrics_data = {}

        # Get all language directories
        lang_dirs = [d for d in scripts_dir.glob("*") if d.is_dir()]

        # Get the list of audio track files
        tracks_dir = work_dir
        audio_extensions = (
            ".mp3",
            ".wav",
            ".flac",
            ".m4a",
            ".ogg",
            ".aac",
            ".wma",
            ".ape",
            ".opus",
        )
        track_files = sorted(
            [f for f in tracks_dir.glob("*.*") if f.suffix.lower() in audio_extensions],
            key=self._sort_script_files,
        )

        # For each track file, attempt to find matching lyrics files
        for file_index, track_file in enumerate(track_files):
            track_lyrics = {}
            track_stem = track_file.stem

            # Process each language directory
            for lang_dir in lang_dirs:
                lang_code = self._normalize_language_code(lang_dir.name)

                # Try to find matching txt file based on filename
                txt_file = lang_dir / f"{track_stem}.txt"
                if not txt_file.exists():
                    # Use fuzzy matching within the current language directory
                    txt_file = self.find_closest_txt_file(lang_dir, track_stem)
                if txt_file is None or not txt_file.exists():
                    # No exact match or close fuzzy match found; use ordering
                    txt_files = sorted(
                        lang_dir.glob("*.txt"), key=self._sort_script_files
                    )
                    txt_file = (
                        txt_files[file_index] if file_index < len(txt_files) else None
                    )

                # Try to find matching lrc file based on filename
                lrc_file = lang_dir / f"{track_stem}.lrc"
                if not lrc_file.exists():
                    # If not found, try to find by ordering
                    lrc_files = sorted(
                        lang_dir.glob("*.lrc"), key=self._sort_script_files
                    )
                    lrc_file = (
                        lrc_files[file_index] if file_index < len(lrc_files) else None
                    )

                # Add unsynced lyrics from txt file
                if txt_file and txt_file.exists():
                    track_lyrics[f"USLT::{lang_code}"] = txt_file.read_text(
                        encoding="utf-8"
                    )

                # Add synced lyrics from lrc file
                if lrc_file and lrc_file.exists():
                    lrc_content = lrc_file.read_text(encoding="utf-8")
                    track_lyrics[f"SYLT::{lang_code}"] = lrc_content
                    track_lyrics[f"SYLT_SYNC::{lang_code}"] = lrc_content

            # Set default lyrics based on configuration
            target_lang = self._normalize_language_code(
                self.config.get("locale", "en_us").split("_")[0]
            )
            jpn_key = "USLT::jpn"
            target_key = f"USLT::{target_lang}"

            if self.config.get("features", {}).get("enable_translation"):
                if target_key in track_lyrics and track_lyrics[target_key]:
                    track_lyrics["lyrics"] = track_lyrics[target_key]
                elif jpn_key in track_lyrics and track_lyrics.get(jpn_key):
                    track_lyrics["lyrics"] = track_lyrics[jpn_key]
            else:
                if jpn_key in track_lyrics and track_lyrics.get(jpn_key):
                    track_lyrics["lyrics"] = track_lyrics[jpn_key]
                elif target_key in track_lyrics and track_lyrics.get(target_key):
                    track_lyrics["lyrics"] = track_lyrics[target_key]

            lyrics_data[file_index] = track_lyrics
        return lyrics_data

    def _normalize_language_code(self, lang_code: str) -> str:
        """Convert language codes to standard 3-letter format."""
        lang_map = {
            "ja": "jpn",
            "en": "eng",
            "ko": "kor",
            "zh": "zho",
        }
        return lang_map.get(lang_code.lower(), lang_code.lower())

    def _sort_script_files(self, filename: Path) -> int:
        """Sort files by numeric part of the filename."""
        num = re.search(r"(\d+)", filename.stem)
        return int(num.group(1)) if num else 0

    def find_closest_txt_file(
        self, lang_dir: Path, track_stem: str, threshold: float = 0.8
    ) -> Optional[Path]:
        """Find the closest matching txt file using fuzzy matching within the language directory."""
        if not lang_dir.exists():
            return None

        target = f"{track_stem}.txt"
        txt_files = [f.name for f in lang_dir.glob("*.txt")]

        if not txt_files:
            return None

        matches = difflib.get_close_matches(target, txt_files, n=1, cutoff=threshold)

        if matches:
            return lang_dir / matches[0]
        return None
