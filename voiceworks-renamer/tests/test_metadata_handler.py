"""Tests for the MetadataHandler class (metadata_handler.py)."""

import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch
from sqlite3 import OperationalError

sys.path.insert(0, str(Path(__file__).parent.parent))

from tests.conftest import make_sample_metadata, MockConfig

# Mock heavy dependencies that metadata_handler imports transitively so we
# do not need aiohttp, mutagen, peewee, etc. installed in the test environment.
# These must be set BEFORE importing metadata_handler.

_mock_mutagen_helper_module = MagicMock()
_mock_file_manager_module = MagicMock()
_mock_scraper_module = MagicMock()
_mock_scraper_pkg = MagicMock()
_mock_work_metadata_module = MagicMock()
_mock_db_module = MagicMock()
_mock_config_types_module = MagicMock()

# Stub the modules in sys.modules so metadata_handler can import them
sys.modules.setdefault("mutagen_helper", _mock_mutagen_helper_module)
sys.modules.setdefault("file_manager", _mock_file_manager_module)
sys.modules.setdefault("scraper", _mock_scraper_pkg)
sys.modules.setdefault("scraper.scraper", _mock_scraper_module)
sys.modules.setdefault("scraper.work_metadata", _mock_work_metadata_module)
sys.modules.setdefault("scraper.db", _mock_db_module)
sys.modules.setdefault("config_types", _mock_config_types_module)

# Make sure the mock db module has a usable db object with connection_context
_mock_db_module.db = MagicMock()

# Make sure MutagenHelper is a class-like callable returning a MagicMock
_mock_mutagen_helper_module.MutagenHelper = MagicMock

# Now we can safely import
from metadata_handler import MetadataHandler


def _make_handler(config_data=None, scraper=None, file_manager=None):
    """Create a MetadataHandler with mocked dependencies."""
    config = MockConfig(config_data)
    if scraper is None:
        scraper = MagicMock()
    if file_manager is None:
        file_manager = MagicMock()

    handler = MetadataHandler(config, scraper, file_manager)
    return handler


class TestNormalizeLanguageCode(unittest.TestCase):
    """Tests for MetadataHandler._normalize_language_code."""

    def setUp(self):
        self.handler = _make_handler()

    def test_two_letter_to_three_letter_ja(self):
        self.assertEqual(self.handler._normalize_language_code("ja"), "jpn")

    def test_two_letter_to_three_letter_en(self):
        self.assertEqual(self.handler._normalize_language_code("en"), "eng")

    def test_two_letter_to_three_letter_ko(self):
        self.assertEqual(self.handler._normalize_language_code("ko"), "kor")

    def test_two_letter_to_three_letter_zh(self):
        self.assertEqual(self.handler._normalize_language_code("zh"), "zho")

    def test_two_letter_to_three_letter_de(self):
        self.assertEqual(self.handler._normalize_language_code("de"), "deu")

    def test_two_letter_to_three_letter_es(self):
        self.assertEqual(self.handler._normalize_language_code("es"), "spa")

    def test_two_letter_to_three_letter_fr(self):
        self.assertEqual(self.handler._normalize_language_code("fr"), "fra")

    def test_three_letter_passthrough(self):
        self.assertEqual(self.handler._normalize_language_code("jpn"), "jpn")

    def test_three_letter_passthrough_eng(self):
        self.assertEqual(self.handler._normalize_language_code("eng"), "eng")

    def test_three_letter_uppercase_lowered(self):
        self.assertEqual(self.handler._normalize_language_code("JPN"), "jpn")

    def test_unknown_two_letter_code_returned_lowercase(self):
        self.assertEqual(self.handler._normalize_language_code("xx"), "xx")

    def test_unknown_three_letter_code_returned_lowercase(self):
        self.assertEqual(self.handler._normalize_language_code("XYZ"), "xyz")

    def test_case_insensitive_mapping(self):
        self.assertEqual(self.handler._normalize_language_code("JA"), "jpn")
        self.assertEqual(self.handler._normalize_language_code("En"), "eng")


class TestGetCommonTags(unittest.TestCase):
    """Tests for MetadataHandler._get_common_tags."""

    def setUp(self):
        # Disable translation so translations dict is identity mapping
        self.handler = _make_handler(
            config_data={"features": {"enable_translation": False}}
        )
        self.metadata = make_sample_metadata()

    def test_basic_tag_fields(self):
        tags = self.handler._get_common_tags(
            self.metadata, track_number=1, disk_number=None, file_path="/tmp/track01.mp3"
        )

        # Title should be the filename stem (no translation)
        self.assertEqual(tags["title"], "track01")
        self.assertEqual(tags["album"], self.metadata["work_name"])
        self.assertEqual(tags["tracknumber"], "1")
        self.assertIn(self.metadata["maker_name"], tags["copyright"])
        self.assertIn(self.metadata["rjcode"], tags["website"])

    def test_artist_from_cvs(self):
        tags = self.handler._get_common_tags(
            self.metadata, track_number=1, disk_number=None, file_path="/tmp/track01.mp3"
        )
        # CVs joined by comma
        for cv in self.metadata["cvs"]:
            self.assertIn(cv, tags["artist"])

    def test_genre_from_tags(self):
        tags = self.handler._get_common_tags(
            self.metadata, track_number=1, disk_number=None, file_path="/tmp/track01.mp3"
        )
        for tag in self.metadata["tags"]:
            self.assertIn(tag, tags["genre"])

    def test_disk_number_explicit(self):
        tags = self.handler._get_common_tags(
            self.metadata, track_number=1, disk_number=2, file_path="/tmp/track01.mp3"
        )
        self.assertEqual(tags["discnumber"], "2")

    def test_disk_number_falls_back_to_series_id(self):
        self.metadata["series_id"] = "SRI0001"
        tags = self.handler._get_common_tags(
            self.metadata, track_number=3, disk_number=None, file_path="/tmp/track03.mp3"
        )
        self.assertEqual(tags["discnumber"], "SRI0001")

    def test_year_extracted_from_release_date(self):
        tags = self.handler._get_common_tags(
            self.metadata, track_number=1, disk_number=None, file_path="/tmp/track01.mp3"
        )
        self.assertEqual(tags["year"], "2024")
        self.assertEqual(tags["date"], "2024-01-15")

    def test_price_formatted(self):
        tags = self.handler._get_common_tags(
            self.metadata, track_number=1, disk_number=None, file_path="/tmp/track01.mp3"
        )
        self.assertEqual(tags["PRICE"], "1320 JPY")

    def test_rating_as_string(self):
        tags = self.handler._get_common_tags(
            self.metadata, track_number=1, disk_number=None, file_path="/tmp/track01.mp3"
        )
        self.assertEqual(tags["rating"], "4.5")

    def test_website_url(self):
        tags = self.handler._get_common_tags(
            self.metadata, track_number=1, disk_number=None, file_path="/tmp/track01.mp3"
        )
        expected_url = f"https://www.dlsite.com/maniax/work/=/product_id/{self.metadata['rjcode']}.html"
        self.assertEqual(tags["website"], expected_url)

    def test_comment_field_present(self):
        tags = self.handler._get_common_tags(
            self.metadata, track_number=1, disk_number=None, file_path="/tmp/track01.mp3"
        )
        self.assertIn("comment", tags)
        self.assertIsInstance(tags["comment"], str)
        self.assertTrue(len(tags["comment"]) > 0)

    def test_lyrics_keys_initialized(self):
        tags = self.handler._get_common_tags(
            self.metadata, track_number=1, disk_number=None, file_path="/tmp/track01.mp3"
        )
        self.assertIn("lyrics", tags)
        self.assertIn("USLT::jpn", tags)
        self.assertIn("SYLT::jpn", tags)

    def test_uslt_lyrics_copied_from_metadata(self):
        self.metadata["USLT::jpn"] = "Japanese lyrics here"
        tags = self.handler._get_common_tags(
            self.metadata, track_number=1, disk_number=None, file_path="/tmp/track01.mp3"
        )
        self.assertEqual(tags["USLT::jpn"], "Japanese lyrics here")

    def test_lyrics_default_to_target_language(self):
        """Default lyrics should use target language if available."""
        self.metadata["USLT::eng"] = "English lyrics"
        self.metadata["USLT::jpn"] = "Japanese lyrics"
        tags = self.handler._get_common_tags(
            self.metadata, track_number=1, disk_number=None, file_path="/tmp/track01.mp3"
        )
        # Config locale is en_us, so target_lang is "eng"
        self.assertEqual(tags["lyrics"], "English lyrics")

    def test_lyrics_fallback_to_jpn(self):
        """If target language not available, fall back to Japanese."""
        self.metadata["USLT::jpn"] = "Japanese lyrics"
        tags = self.handler._get_common_tags(
            self.metadata, track_number=1, disk_number=None, file_path="/tmp/track01.mp3"
        )
        self.assertEqual(tags["lyrics"], "Japanese lyrics")


class TestFormatComment(unittest.TestCase):
    """Tests for MetadataHandler._format_comment."""

    def setUp(self):
        self.handler = _make_handler()
        self.metadata = make_sample_metadata()
        # Identity translations for simplicity
        self.translations = {text: text for text in [
            self.metadata["work_name"],
            self.metadata["maker_name"],
            self.metadata["work_type"],
            self.metadata.get("intro_s", ""),
            self.metadata.get("series_name", ""),
        ]}

    def test_comment_includes_title(self):
        comment = self.handler._format_comment(self.metadata, self.translations)
        self.assertIn("Title:", comment)
        self.assertIn(self.metadata["work_name"], comment)

    def test_comment_includes_rjcode(self):
        comment = self.handler._format_comment(self.metadata, self.translations)
        self.assertIn("RJ Code:", comment)
        self.assertIn(self.metadata["rjcode"], comment)

    def test_comment_includes_circle(self):
        comment = self.handler._format_comment(self.metadata, self.translations)
        self.assertIn("Circle:", comment)

    def test_comment_includes_maker(self):
        comment = self.handler._format_comment(self.metadata, self.translations)
        self.assertIn("Maker:", comment)
        self.assertIn(self.metadata["maker_name"], comment)

    def test_comment_includes_type(self):
        comment = self.handler._format_comment(self.metadata, self.translations)
        self.assertIn("Type:", comment)

    def test_comment_includes_category(self):
        comment = self.handler._format_comment(self.metadata, self.translations)
        self.assertIn("Category:", comment)

    def test_comment_includes_age_rating(self):
        comment = self.handler._format_comment(self.metadata, self.translations)
        self.assertIn("Age Rating:", comment)

    def test_comment_includes_rating(self):
        comment = self.handler._format_comment(self.metadata, self.translations)
        self.assertIn("Rating:", comment)
        self.assertIn("/5.0", comment)

    def test_comment_includes_release_date(self):
        comment = self.handler._format_comment(self.metadata, self.translations)
        self.assertIn("Release Date:", comment)
        self.assertIn("2024-01-15", comment)

    def test_comment_includes_price(self):
        comment = self.handler._format_comment(self.metadata, self.translations)
        self.assertIn("Price:", comment)
        self.assertIn("JPY", comment)

    def test_comment_includes_series_when_present(self):
        self.metadata["series_name"] = "\u30c6\u30b9\u30c8\u30b7\u30ea\u30fc\u30ba"
        self.metadata["series_id"] = "SRI0001"
        self.translations["\u30c6\u30b9\u30c8\u30b7\u30ea\u30fc\u30ba"] = "Test Series"
        comment = self.handler._format_comment(self.metadata, self.translations)
        self.assertIn("Series:", comment)
        self.assertIn("Test Series", comment)
        self.assertIn("SRI0001", comment)

    def test_comment_excludes_series_when_absent(self):
        self.metadata["series_name"] = ""
        comment = self.handler._format_comment(self.metadata, self.translations)
        self.assertNotIn("Series:", comment)

    def test_comment_includes_description_when_present(self):
        comment = self.handler._format_comment(self.metadata, self.translations)
        self.assertIn("Description:", comment)

    def test_comment_excludes_description_when_absent(self):
        self.metadata["intro_s"] = ""
        comment = self.handler._format_comment(self.metadata, self.translations)
        self.assertNotIn("Description:", comment)


class TestGetTranslations(unittest.TestCase):
    """Tests for MetadataHandler._get_translations with caching."""

    def setUp(self):
        self.file_manager = MagicMock()
        self.handler = _make_handler(file_manager=self.file_manager)

    def test_translates_new_texts(self):
        self.file_manager.translate_content.return_value = {
            "hello": "konnichiwa",
            "world": "sekai",
        }

        result = self.handler._get_translations(["hello", "world"], "RJ123456")

        self.assertEqual(result["hello"], "konnichiwa")
        self.assertEqual(result["world"], "sekai")
        self.file_manager.translate_content.assert_called_once_with(
            ["hello", "world"], "RJ123456"
        )

    def test_caches_results(self):
        self.file_manager.translate_content.return_value = {"hello": "konnichiwa"}

        # First call: should translate
        self.handler._get_translations(["hello"], "RJ123456")
        # Second call: should use cache
        result = self.handler._get_translations(["hello"], "RJ123456")

        self.assertEqual(result["hello"], "konnichiwa")
        # translate_content should only have been called once
        self.assertEqual(self.file_manager.translate_content.call_count, 1)

    def test_only_translates_new_texts(self):
        # Pre-populate cache
        self.handler._translation_cache["cached_text"] = "cached_translation"

        self.file_manager.translate_content.return_value = {"new_text": "new_translation"}

        result = self.handler._get_translations(
            ["cached_text", "new_text"], "RJ123456"
        )

        self.assertEqual(result["cached_text"], "cached_translation")
        self.assertEqual(result["new_text"], "new_translation")
        # Only the new text should be sent for translation
        self.file_manager.translate_content.assert_called_once_with(
            ["new_text"], "RJ123456"
        )

    def test_all_cached_skips_translation_call(self):
        self.handler._translation_cache["a"] = "A"
        self.handler._translation_cache["b"] = "B"

        result = self.handler._get_translations(["a", "b"], "RJ123456")

        self.assertEqual(result, {"a": "A", "b": "B"})
        self.file_manager.translate_content.assert_not_called()


class TestFetchMetadata(unittest.TestCase):
    """Tests for MetadataHandler.fetch_metadata."""

    def setUp(self):
        self.scraper = MagicMock()
        self.handler = _make_handler(
            config_data={
                "features": {
                    "enable_product_summary": False,
                    "enable_translation": False,
                }
            },
            scraper=self.scraper,
        )

    @patch("metadata_handler.db")
    def test_fetch_metadata_success(self, mock_db):
        sample = make_sample_metadata()
        self.scraper.scrape_metadata.return_value = sample
        mock_db.connection_context.return_value.__enter__ = MagicMock()
        mock_db.connection_context.return_value.__exit__ = MagicMock(return_value=False)

        result = self.handler.fetch_metadata("RJ1234567")

        self.assertEqual(result, sample)
        self.scraper.scrape_metadata.assert_called_once_with(
            "RJ1234567",
            fetch_summary=False,
            translate_summary=False,
        )

    @patch("metadata_handler.db")
    def test_fetch_metadata_returns_none_on_non_lock_error(self, mock_db):
        mock_db.connection_context.return_value.__enter__ = MagicMock()
        mock_db.connection_context.return_value.__exit__ = MagicMock(return_value=False)

        # The OperationalError is raised inside the `with` block via scrape_metadata
        self.scraper.scrape_metadata.side_effect = OperationalError("some other error")

        result = self.handler.fetch_metadata("RJ1234567")

        self.assertIsNone(result)

    @patch("metadata_handler.db")
    @patch("metadata_handler.time.sleep")
    def test_fetch_metadata_retries_on_database_locked(self, mock_sleep, mock_db):
        mock_db.connection_context.return_value.__enter__ = MagicMock()
        mock_db.connection_context.return_value.__exit__ = MagicMock(return_value=False)

        sample = make_sample_metadata()
        # Fail twice with "database is locked", then succeed
        self.scraper.scrape_metadata.side_effect = [
            OperationalError("database is locked"),
            OperationalError("database is locked"),
            sample,
        ]

        result = self.handler.fetch_metadata("RJ1234567")

        self.assertEqual(result, sample)
        self.assertEqual(self.scraper.scrape_metadata.call_count, 3)
        self.assertEqual(mock_sleep.call_count, 2)

    @patch("metadata_handler.db")
    @patch("metadata_handler.time.sleep")
    def test_fetch_metadata_returns_none_after_max_retries(self, mock_sleep, mock_db):
        mock_db.connection_context.return_value.__enter__ = MagicMock()
        mock_db.connection_context.return_value.__exit__ = MagicMock(return_value=False)

        self.scraper.scrape_metadata.side_effect = OperationalError("database is locked")

        result = self.handler.fetch_metadata("RJ1234567")

        self.assertIsNone(result)
        # max_retries is 5
        self.assertEqual(self.scraper.scrape_metadata.call_count, 5)

    @patch("metadata_handler.db")
    def test_fetch_metadata_with_features_enabled(self, mock_db):
        mock_db.connection_context.return_value.__enter__ = MagicMock()
        mock_db.connection_context.return_value.__exit__ = MagicMock(return_value=False)

        handler = _make_handler(
            config_data={
                "features": {
                    "enable_product_summary": True,
                    "enable_translation": True,
                }
            },
            scraper=self.scraper,
        )
        sample = make_sample_metadata()
        self.scraper.scrape_metadata.return_value = sample

        result = handler.fetch_metadata("RJ1234567")

        self.assertEqual(result, sample)
        self.scraper.scrape_metadata.assert_called_with(
            "RJ1234567",
            fetch_summary=True,
            translate_summary=True,
        )


class TestUpdateMetadata(unittest.TestCase):
    """Tests for MetadataHandler.update_metadata."""

    def setUp(self):
        self.handler = _make_handler(
            config_data={"features": {"enable_translation": False}}
        )
        self.metadata = make_sample_metadata()

    def test_update_metadata_calls_mutagen_helper(self):
        self.handler.update_metadata(
            "/tmp/track01.mp3", self.metadata, track_number=1
        )

        self.handler.mutagen_helper.update_metadata.assert_called_once()
        call_args = self.handler.mutagen_helper.update_metadata.call_args
        self.assertEqual(call_args[0][0], "/tmp/track01.mp3")
        self.assertEqual(call_args[0][2], 1)  # track_number

    def test_update_metadata_passes_generated_tags(self):
        self.handler.update_metadata(
            "/tmp/track01.mp3", self.metadata, track_number=1
        )

        call_args = self.handler.mutagen_helper.update_metadata.call_args
        tags = call_args[0][1]  # Second positional arg is the tags dict
        self.assertIsInstance(tags, dict)
        self.assertIn("title", tags)
        self.assertIn("album", tags)

    def test_update_metadata_handles_exception_gracefully(self):
        self.handler.mutagen_helper.update_metadata.side_effect = Exception("write error")

        # Should not raise
        self.handler.update_metadata(
            "/tmp/track01.mp3", self.metadata, track_number=1
        )


if __name__ == "__main__":
    unittest.main()
