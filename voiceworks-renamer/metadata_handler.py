# metadata_handler.py

import logging
from pathlib import Path
from sqlite3 import OperationalError
from typing import Optional, Dict, List
import time
from threading import Lock, Semaphore

from config_types import Config
from file_manager import FileManager
from mutagen_helper import MutagenHelper
from scraper.scraper import Scraper
from scraper.work_metadata import WorkMetadata
from scraper.db import db


class MetadataHandler:
    """Manages metadata fetching and updating."""

    def __init__(self, config: Config, scraper: Scraper, file_manager: FileManager):
        self.config = config
        self.scraper = scraper
        self.logger = logging.getLogger(__name__)
        self.mutagen_helper = MutagenHelper()
        self.file_manager = file_manager
        self._translation_cache = {}
        self._translation_lock = Lock()
        # Limit concurrent disk operations
        self._disk_semaphore = Semaphore(3)

    def _get_translations(self, texts: List[str], rjcode: str) -> Dict[str, str]:
        """Get translations with caching"""
        with self._translation_lock:
            result = {}
            texts_to_translate = []

            # Check cache first
            for text in texts:
                cached = self._translation_cache.get(text)
                if cached:
                    result[text] = cached
                else:
                    texts_to_translate.append(text)

            # Only translate new texts
            if texts_to_translate:
                translations = self.file_manager.translate_content(
                    texts_to_translate, rjcode
                )
                # Update cache and results
                self._translation_cache.update(translations)
                result.update(translations)

            return result

    def fetch_metadata(self, rjcode: str) -> Optional[WorkMetadata]:
        """Fetch metadata for the given RJ code with retry on database lock."""
        # print("Fetching metadata for RJ code: %s", rjcode)
        max_retries = 5
        retry_delay = 0.1
        for attempt in range(1, max_retries + 1):
            try:
                with db.connection_context():
                    features = self.config.get("features", {})

                    metadata = self.scraper.scrape_metadata(
                        rjcode,
                        fetch_summary=features.get("enable_product_summary", False),
                        translate_summary=features.get("enable_translation", False),
                    )
                    return metadata
            except OperationalError as e:
                if "database is locked" in str(e):
                    self.logger.warning(
                        "Database locked. Retry attempt %d/%d", attempt, max_retries
                    )
                    time.sleep(retry_delay)
                else:
                    self.logger.error(
                        "Failed to scrape metadata for %s: %s", rjcode, e, exc_info=True
                    )
                    return None
            finally:
                db.close()  # Ensure the database connection is closed
        self.logger.error(
            "Failed to fetch metadata for %s after %d attempts due to database lock.",
            rjcode,
            max_retries,
        )
        return None

    def update_metadata(
        self,
        file_path: str,
        metadata: WorkMetadata,
        track_number: int,
        disk_number: Optional[int] = None,
    ):
        """Update metadata with rate limiting"""
        try:
            with self._disk_semaphore:
                # Generate tags dictionary
                tags = self._get_common_tags(
                    metadata, track_number, disk_number, file_path
                )
                # Call the correct method on mutagen_helper
                self.mutagen_helper.update_metadata(file_path, tags, track_number)
        except Exception as e:
            self.logger.error("Failed to update metadata for %s: %s", file_path, e)
            # Skip the file or log additional details if necessary

    def _get_common_tags(
        self,
        metadata: WorkMetadata,
        track_number: int,
        disk_number: Optional[int],
        file_path: str,
    ) -> Dict[str, str]:
        """Generate common tags with enhanced metadata."""

        def safe_str(value, default="") -> str:
            return str(value) if value is not None else default

        filename = Path(file_path).stem
        rjcode = metadata["rjcode"]

        # Collect texts to translate, including the filename
        texts_to_translate = [
            filename,
            # Core fields
            metadata.get("work_name", ""),
            metadata.get("work_name_kana", ""),
            metadata.get("maker_name", ""),
            metadata.get("series_name", ""),
            metadata.get("intro_s", ""),
            metadata.get("summary", ""),
            metadata.get("work_type", ""),
            metadata.get("work_category", ""),
            # Lists that need translation
            *metadata.get("cvs", []),
            *metadata.get("tags", []),
            *metadata.get("supported_languages", []),
            # Extract names from genres
            *(genre.get("name", "") for genre in metadata.get("genres", [])),
            # Extract creator names
            *(
                creator.get("name", "")
                for creator in metadata.get("creaters", [])
                if isinstance(creator, dict)
            ),
            # Platform descriptions - handle both string and list cases
            *(
                [metadata["platform"]]
                if isinstance(metadata.get("platform"), str)
                else metadata.get("platform", [])
            ),
        ]

        # Filter out empty strings and duplicates
        texts_to_translate = list(filter(None, dict.fromkeys(texts_to_translate)))

        features = self.config.get("features", {})

        translations = {}
        if features.get("enable_translation"):
            # Get translations
            translations = self._get_translations(texts_to_translate, rjcode)
        else:
            # Use metadata directly if translation is disabled
            translations = {text: text for text in texts_to_translate}

        # Build enhanced common tags
        common_tags = {
            # Translate and set the title
            "title": translations.get(filename, filename),
            "album": translations.get(metadata.get("work_name", ""), "Unknown Album"),
            "artist": ", ".join(
                translations.get(cv, cv) for cv in metadata.get("cvs", [])
            )
            or translations.get(metadata.get("maker_name", ""), "Unknown Artist"),
            "albumartist": translations.get(
                metadata.get("maker_name", ""), "Unknown Artist"
            ),
            "tracknumber": safe_str(track_number),
            "discnumber": safe_str(
                disk_number
                if disk_number is not None
                else metadata.get("series_id", "0")
            ),
            # Extended metadata
            "genre": ", ".join(
                translations.get(tag, tag) for tag in metadata.get("tags", [])
            ),
            "composer": metadata.get("circle_id", ""),
            "copyright": f"{metadata.get('maker_id', '')} / {metadata.get('maker_name', '')}",
            "encodedby": f"DLsite {metadata.get('file_type', '')}",
            "organization": metadata.get("work_category", ""),
            "publisher": metadata.get("maker_name", ""),
            "subtitle": translations.get(metadata.get("work_name_kana", ""), ""),
            "website": f"https://www.dlsite.com/maniax/work/=/product_id/{rjcode}.html",
            # Custom tags
            "WORK_TYPE": translations.get(metadata.get("work_type", ""), ""),
            "PLATFORMS": metadata.get("platform", ""),
            "AGE_RATING": safe_str(metadata.get("age", "")),
            "CIRCLE_ID": metadata.get("circle_id", ""),
            "PRICE": f"{metadata.get('price', 0)} JPY",
            "FILE_SIZE": metadata.get("file_size", ""),
            "SUPPORTED_LANGS": ", ".join(metadata.get("supported_languages", [])),
            "OPTIONS": ", ".join(metadata.get("options", [])),
            "MACHINES": ", ".join(metadata.get("machine", [])),
            # Rating and date
            "rating": str(metadata.get("rating", 0)),
            "year": metadata.get("release_date", "")[:4],
            "date": metadata.get("release_date", ""),
            # Description fields
            "comment": self._format_comment(metadata, translations),
            "description": translations.get(metadata.get("intro_s", ""), ""),
            "grouping": translations.get(metadata.get("series_name", ""), ""),
            "language": ", ".join(
                translations.get(lang, lang)
                for lang in metadata.get("supported_languages", [])
            ),
            # Default lyrics tag - uses first available localized lyrics
            "lyrics": "",
            # Language specific unsynced lyrics (USLT) and synced lyrics (SYLT)
            # These will be populated from metadata if available
            "USLT::jpn": "",
            "SYLT::jpn": "",
            "SYLT_SYNC::jpn": "",
        }
        # Update lyrics tags if present in metadata
        for key, value in metadata.items():
            if key.startswith(("USLT::", "SYLT::", "SYLT_SYNC::")):
                common_tags[key] = value

        # Set default lyrics to first available translation in order of preference
        target_lang = self._normalize_language_code(
            self.config.get("locale", "en_us").split("_")[0]
        )
        jpn_key = "USLT::jpn"
        target_key = f"USLT::{target_lang}"

        # Set lyrics in order of preference: target language, Japanese, first available
        if target_key in metadata and metadata[target_key]:
            common_tags["lyrics"] = metadata[target_key]
        elif jpn_key in metadata and metadata[jpn_key]:
            common_tags["lyrics"] = metadata[jpn_key]
        else:
            # Find first available lyrics
            for key in metadata:
                if key.startswith("USLT::") and metadata[key]:
                    common_tags["lyrics"] = metadata[key]
                    break

        return common_tags

    def _normalize_language_code(self, lang_code: str) -> str:
        """Convert language codes to standard 3-letter format."""
        lang_map = {
            "ja": "jpn",
            "en": "eng",
            "ko": "kor",
            "zh": "zho",
            "de": "deu",
            "es": "spa",
            "fr": "fra",
            "it": "ita",
            "pt": "por",
            "ru": "rus",
        }

        # If it's already a 3-letter code, return it
        if len(lang_code) == 3:
            return lang_code.lower()

        # Otherwise, try to map it
        return lang_map.get(lang_code.lower(), lang_code.lower())

    def _format_comment(
        self, metadata: WorkMetadata, translations: Dict[str, str]
    ) -> str:
        """Format an enhanced comment field with additional metadata."""
        comment_parts = [
            f"Title: {translations.get(metadata.get('work_name', ''), '')}",
            f"RJ Code: {metadata['rjcode']}",
            f"Circle: {metadata.get('circle_id', '')}",
            f"Maker: {translations.get(metadata.get('maker_name', ''), '')} ({metadata.get('maker_id', '')})",
            f"Type: {translations.get(metadata.get('work_type', ''), '')}",
            f"Category: {metadata.get('work_category', '')}",
            f"Age Rating: {metadata.get('age', '')}",
            f"File: {metadata.get('file_type', '')} ({metadata.get('file_size', '')})",
            f"Platform: {metadata.get('platform', '')}",
            f"Languages: {', '.join(translations.get(lang, lang) for lang in metadata.get('supported_languages', []))}",
            f"Rating: {metadata.get('rating', 0)}/5.0",
            f"Release Date: {metadata.get('release_date', '')}",
            f"Price: {metadata.get('price', 0)} JPY",
        ]

        if metadata.get("series_name"):
            comment_parts.append(
                f"Series: {translations.get(metadata['series_name'], '')} ({metadata.get('series_id', '')})"
            )

        if metadata.get("intro_s"):
            comment_parts.append(
                f"\nDescription: {translations.get(metadata['intro_s'], '')}"
            )

        return "\n ".join(comment_parts)
