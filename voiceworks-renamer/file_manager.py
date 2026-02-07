import logging
from pathlib import Path
import time
import traceback
from typing import Dict, Optional, List
import re
from datetime import datetime
import unicodedata

from config_types import Config
from scraper.scraper import Scraper
from scraper.work_metadata import WorkMetadata
from constants import (
    WINDOWS_RESERVED_CHARACTER_PATTERN,
    WINDOWS_RESERVED_CHARACTER_PATTERN_STR,
    WINDOWS_RESERVED_CHARACTER_REPLACE_STR,
    MAX_NAME_LENGTH,
)


class FileManager:
    """Handles file and folder operations."""

    def __init__(self, config: Config, scraper: Scraper):
        self.translation_cache = {}
        self.logger = logging.getLogger(__name__)
        self.config = config
        self.scraper = scraper

    def rename_folder(self, folder_path: str, metadata: WorkMetadata) -> str:
        """Rename folder based on metadata and configuration."""
        # print("[%s] -> Renaming folder: %s", metadata["rjcode"], folder_path)
        new_name = self._generate_folder_name(metadata)
        if not new_name.strip():
            self.logger.warning(
                "[%s] -> New folder name is empty. Skipping rename.", metadata["rjcode"]
            )
            return folder_path

        new_folder_path = str(Path(folder_path).parent / new_name)

        try:
            Path(folder_path).rename(new_folder_path)
            # print(
            #     "[%s] -> Renamed folder to '%s'.", metadata["rjcode"], new_folder_path
            # )
            return str(new_folder_path)
        except OSError as err:
            self.logger.error(
                "[%s] -> Failed to rename folder: %s\n%s",
                metadata["rjcode"],
                err,
                traceback.format_exc(),
            )
            return folder_path

    def _generate_folder_name(self, metadata: WorkMetadata) -> str:
        """Generate new folder name based on metadata and template."""
        # Get base replacements
        replacements = self._prepare_replacements(metadata)

        # Get template
        new_name = self.config.get("template", "")

        # Translate work name and maker name if translation enabled
        if self.config.get("features", {}).get("enable_translation"):
            texts_to_translate = [
                metadata.get("work_name", ""),
                metadata.get("maker_name", ""),
            ]
            translations = self.translate_content(
                texts_to_translate, metadata["rjcode"]
            )

            # Update replacements with translations
            replacements["work_name"] = translations.get(
                metadata.get("work_name", ""), ""
            )
            replacements["maker_name"] = translations.get(
                metadata.get("maker_name", ""), ""
            )

        # Apply all replacements
        for key, value in replacements.items():
            new_name = new_name.replace(key, str(value))

        # Handle CV list translation
        translated_cvs = [
            self.translate_content(cv, metadata["rjcode"]).get(cv, cv)
            for cv in metadata.get("cvs", [])
        ]
        cv_list_str = (
            f"{self.config.get('cv_list_left', '')}{', '.join(translated_cvs)}{self.config.get('cv_list_right', '')}"
            if translated_cvs
            else ""
        )
        new_name = new_name.replace("cv_list_str", cv_list_str)

        # Handle tags list
        if "tags_list_str" in self.config.get("template", "") and self.config.get(
            "tags_option"
        ):
            tags_list = self._prepare_tags_list(metadata.get("tags", []))
            tags_list_str = self.config.get("delimiter", "").join(tags_list)
            new_name = new_name.replace("tags_list_str", tags_list_str)

        # Sanitize filename
        new_name = self.sanitize_filename(new_name, metadata["rjcode"])

        # Truncate if necessary
        if len(new_name) > MAX_NAME_LENGTH:
            new_name = self.truncate_name(new_name, metadata["rjcode"])

        return new_name.strip()

    def _prepare_replacements(self, metadata: dict) -> dict:
        """Prepare replacement values for template strings."""
        replacements = {}
        template = self.config.get("template", "")

        # Release date formatting
        if "release_date" in template:
            date_format = self.config.get("renamer_release_date_format", "%d-%m-%y")
            try:
                # First parse the date in YYYY-MM-DD format
                date_obj = time.strptime(metadata.get("release_date", ""), "%Y-%m-%d")
                # Then format it according to user's preference
                replacements["release_date"] = time.strftime(date_format, date_obj)
            except (ValueError, TypeError):
                # If parsing fails, use original date string
                replacements["release_date"] = metadata.get("release_date", "")

        # Handle CV list
        cv_list = metadata.get("cvs", [])
        if cv_list:
            cv_list_left = self.config.get("cv_list_left", "(CV. ")
            cv_list_right = self.config.get("cv_list_right", ")")
            replacements["cv_list_str"] = (
                f"{cv_list_left}{', '.join(cv_list)}{cv_list_right}"
            )
        else:
            replacements["cv_list_str"] = ""

        # Handle tags list
        tags = metadata.get("tags", [])
        if tags:
            delimiter = self.config.get("renamer_delimiter", " ")
            replacements["tags_list_str"] = delimiter.join(tags)
        else:
            replacements["tags_list_str"] = ""

        # Basic metadata
        replacements.update(
            {
                "maker_name": metadata.get("maker_name", ""),
                "rjcode": metadata.get("rjcode", ""),
                "rating": str(metadata.get("rating", "")),
                "age": metadata.get("age", ""),  # Use 'age' instead of 'age'
                "work_name": metadata.get("work_name", ""),
            }
        )

        return replacements

    def _prepare_tags_list(self, tags: List[str]) -> List[str]:
        """Prepare tags list based on configuration."""
        tags_list = []
        tags_ordered = (
            self.config.get("tags_option", {}).get("ordered_list", [])
            if self.config.get("tags_option")
            else []
        )

        for item in tags_ordered:
            if isinstance(item, str) and item in tags:
                tags_list.append(item)
            elif isinstance(item, list) and item[0] in tags:
                tags_list.append(item[1])

        for tag in tags:
            if tag not in tags_ordered:
                tags_list.append(tag)

        return (
            tags_list[: self.config.get("tags_option", {}).get("max_number", len(tags))]
            if self.config.get("tags_option")
            else tags
        )

    def sanitize_filename(self, filename: str, rjcode: str) -> str:
        """Sanitize filename by handling illegal characters and length."""
        filename = filename.replace("\n", " ").replace("\r", " ")

        if self.config.get("use_full_width_chars"):
            for char, full_width in zip(
                WINDOWS_RESERVED_CHARACTER_PATTERN_STR,
                WINDOWS_RESERVED_CHARACTER_REPLACE_STR,
            ):
                filename = filename.replace(char, full_width)
        else:
            filename = WINDOWS_RESERVED_CHARACTER_PATTERN.sub("", filename)

        # Replace multiple spaces with single space and strip
        filename = " ".join(filename.split())
        filename = filename.strip()

        return self.truncate_name(filename, rjcode)

    @staticmethod
    def truncate_name(name: str, rjcode: str) -> str:
        """Truncate folder name to MAX_NAME_LENGTH, avoiding mid-word truncation."""
        delimiters = " 、。・，！？：；~～\n) "
        truncate_pos = -1
        truncated_name = name
        if len(name) > MAX_NAME_LENGTH:
            logging.warning(
                "[%s] -> Name is too long (%d characters). Truncating to %d characters.",
                rjcode,
                len(name),
                MAX_NAME_LENGTH,
            )
            for delimiter in delimiters:
                pos = name.rfind(delimiter, 0, MAX_NAME_LENGTH)
                truncate_pos = max(truncate_pos, pos)

            if truncate_pos != -1:
                truncated_name = name[:truncate_pos]
            else:
                truncated_name = name[: MAX_NAME_LENGTH - 1]

        return truncated_name

    def _format_release_date(self, release_date: Optional[str]) -> str:
        """Format release date based on configuration."""
        if (release_date):
            try:
                release_date_obj = datetime.strptime(release_date, "%Y-%m-%d")
                return release_date_obj.strftime(
                    self.config.get("release_date_format", "")
                )
            except (ValueError, TypeError):
                self.logger.warning("Invalid release_date format: %s", release_date)
        return ""

    def _append_original_if_needed(self, original: str, translated: str) -> str:
        """Append the original text to the translated text if needed, avoiding duplicates."""

        if original == translated:
            return translated

        if not self.config.get("include_original_name"):
            return translated

        def _remove_punctuation(s: str) -> str:
            return "".join(c for c in s if not unicodedata.category(c).startswith("P"))

        # Strip leading parenthesis for comparison purposes
        original_for_comparison = original.lstrip("(")
        translated_for_comparison = translated.lstrip("(")

        # Split the strings at the first parenthesis after stripping
        original_before = re.split(r"\(", original_for_comparison, maxsplit=1)[
            0
        ].strip()
        translated_before = re.split(r"\(", translated_for_comparison, maxsplit=1)[
            0
        ].strip()

        # Remove punctuation from the strings for comparison
        original_before_no_punct = _remove_punctuation(original_before)
        translated_before_no_punct = _remove_punctuation(translated_before)

        # Compare the processed strings
        if (
            original_before_no_punct == translated_before_no_punct
            or original_before_no_punct.startswith(translated_before_no_punct)
            or translated_before_no_punct.startswith(original_before_no_punct)
        ):
            return original

        # Append the original text to the translated text
        return f"{translated} ({original})"

    def translate_content(self, texts: List[str], rjcode: str) -> Dict[str, str]:
        """Batch translate multiple texts with improved handling."""
        cache_key = f"{rjcode}_{hash(tuple(sorted(texts)))}"
        if cache_key in self.translation_cache:
            return self.translation_cache[cache_key]

        features = self.config.get("features", {})
        if not features.get("enable_translation") or not texts:
            return {text: text for text in texts}

        # Get translations from cached scraper
        target_language = self.config.get("locale", "").split("_")[0]
        translation_list = self.scraper.translate(texts, target_language, rjcode)
        translations = dict(zip(texts, translation_list))

        result = {
            text: self._append_original_if_needed(text, translation)
            for text, translation in translations.items()
        }

        self.translation_cache[cache_key] = result
        return result

    def get_audio_files(self, folder_path: str) -> List[Path]:
        """Retrieve a sorted list of audio files in the given folder."""
        try:
            folder = Path(folder_path)
            audio_extensions = {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus"}

            files = []
            for file in folder.rglob("*"):
                try:
                    if file.suffix.lower() in audio_extensions and file.is_file():
                        files.append(file)
                except (UnicodeEncodeError, UnicodeDecodeError, OSError) as e:
                    self.logger.warning(
                        "Skipping file with encoding/access issues: %s (%s)",
                        file, e
                    )
                    continue
            return sorted(files, key=lambda f: f.name)
        except Exception as e:
            self.logger.error("Error accessing folder %s: %s", folder_path, str(e))
            return []

    def save_to_file(
        self, folder_path: str, filename: str, content: str, rjcode: str
    ) -> None:
        """Save content to a specified file with robust encoding handling."""
        file_path = Path(folder_path) / filename
        try:
            # Try writing with UTF-8
            with open(file_path, "w", encoding="utf-8") as file:
                file.write(content)
        except UnicodeEncodeError:
            try:
                # Fallback to system default encoding
                with open(file_path, "w", encoding=None) as file:
                    file.write(content)
            except Exception as e:
                self.logger.error(
                    "[%s] -> Failed to save content to %s with any encoding: %s",
                    rjcode,
                    file_path,
                    e,
                )

    def read_file(self, file_path: str, rjcode: str) -> Optional[str]:
        """Read file content with robust encoding handling."""
        try:
            # Try UTF-8 first
            with open(file_path, 'r', encoding='utf-8') as f:
                return f.read()
        except UnicodeDecodeError:
            try:
                with open(file_path, 'r', encoding=None) as f:
                    return f.read()
            except Exception as e:
                self.logger.error(
                    "[%s] -> Failed to read file %s with any encoding: %s",
                    rjcode,
                    file_path,
                    e,
                )
                return None

    def save_product_summary(self, folder_path: str, metadata: dict, rjcode: str) -> None:
        """Save product summary and its translation if enabled."""
        summary = metadata.get("summary")  # Get summary directly from metadata
        if not summary:
            return

        # Always save original summary
        self.save_to_file(folder_path, "summary.txt", summary, rjcode)

        # Handle translation if enabled
        if self.config.get("features", {}).get("enable_translation"):
            target_language = self.config.get("locale", "en_us").split("_")[0]

            # Translate summary
            translated_summary = self.scraper.translate(summary, target_language, rjcode)

            # Save translated version
            if translated_summary and translated_summary != summary:
                # Process translated summary if it's a list
                if isinstance(translated_summary, list):
                    translated_summary = "\n".join(translated_summary)

                translated_filename = f"summary_{target_language}.txt"
                self.save_to_file(folder_path, translated_filename, translated_summary, rjcode)
