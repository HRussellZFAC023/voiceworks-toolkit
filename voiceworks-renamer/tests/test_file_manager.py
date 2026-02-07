"""Comprehensive tests for the FileManager class."""
import sys
import tempfile
import os
from pathlib import Path
from unittest.mock import MagicMock, patch

# Ensure the project root is on sys.path so imports resolve correctly.
sys.path.insert(0, str(Path(__file__).parent.parent))

# ---------------------------------------------------------------------------
# Pre-mock heavy/optional third-party modules that the import chain pulls in
# but are NOT needed for FileManager unit tests. This avoids requiring torch,
# wxPython, aiohttp, faster-whisper, etc. to be installed in the test env.
# ---------------------------------------------------------------------------
_OPTIONAL_MODULES = [
    "aiohttp",
    "wx",
    "wx.lib",
    "wx.lib.newevent",
    "mutagen",
    "mutagen.id3",
    "mutagen.mp3",
    "mutagen.flac",
    "mutagen.mp4",
    "mutagen.oggvorbis",
    "mutagen.oggopus",
    "faster_whisper",
    "torch",
    "ffmpeg",
    "PIL",
    "PIL.Image",
    "googletrans",
    "langdetect",
    "pyquery",
    "lxml",
]
for _mod_name in _OPTIONAL_MODULES:
    if _mod_name not in sys.modules:
        sys.modules[_mod_name] = MagicMock()

import unittest

from file_manager import FileManager
from constants import (
    WINDOWS_RESERVED_CHARACTER_PATTERN,
    WINDOWS_RESERVED_CHARACTER_PATTERN_STR,
    WINDOWS_RESERVED_CHARACTER_REPLACE_STR,
    MAX_NAME_LENGTH,
)
from tests.conftest import MockConfig, make_config, make_sample_metadata


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_fm(config_overrides=None):
    """Create a FileManager with a MockConfig and a MagicMock scraper."""
    config = MockConfig(config_overrides)
    scraper = MagicMock()
    return FileManager(config=config, scraper=scraper)


# ===========================================================================
# 1. sanitize_filename
# ===========================================================================

class TestSanitizeFilename(unittest.TestCase):
    """Tests for FileManager.sanitize_filename."""

    def setUp(self):
        self.fm = _make_fm()
        self.rjcode = "RJ123456"

    # ---- reserved character removal (default mode) ----

    def test_removes_backslash(self):
        result = self.fm.sanitize_filename(r"foo\bar", self.rjcode)
        self.assertNotIn("\\", result)
        self.assertIn("foobar", result)

    def test_removes_forward_slash(self):
        result = self.fm.sanitize_filename("foo/bar", self.rjcode)
        self.assertNotIn("/", result)

    def test_removes_colon(self):
        result = self.fm.sanitize_filename("foo:bar", self.rjcode)
        self.assertNotIn(":", result)

    def test_removes_asterisk(self):
        result = self.fm.sanitize_filename("foo*bar", self.rjcode)
        self.assertNotIn("*", result)

    def test_removes_question_mark(self):
        result = self.fm.sanitize_filename("foo?bar", self.rjcode)
        self.assertNotIn("?", result)

    def test_removes_double_quote(self):
        result = self.fm.sanitize_filename('foo"bar', self.rjcode)
        self.assertNotIn('"', result)

    def test_removes_angle_brackets(self):
        result = self.fm.sanitize_filename("foo<bar>baz", self.rjcode)
        self.assertNotIn("<", result)
        self.assertNotIn(">", result)

    def test_removes_pipe(self):
        result = self.fm.sanitize_filename("foo|bar", self.rjcode)
        self.assertNotIn("|", result)

    def test_removes_all_reserved_chars_at_once(self):
        dirty = 'a\\b/c:d*e?f"g<h>i|j'
        result = self.fm.sanitize_filename(dirty, self.rjcode)
        for ch in WINDOWS_RESERVED_CHARACTER_PATTERN_STR:
            self.assertNotIn(ch, result)

    # ---- full-width replacement mode ----

    def test_full_width_replaces_backslash(self):
        fm = _make_fm({"use_full_width_chars": True})
        result = fm.sanitize_filename(r"foo\bar", self.rjcode)
        self.assertIn("\uff3c", result)  # fullwidth backslash
        self.assertNotIn("\\", result)

    def test_full_width_replaces_forward_slash(self):
        fm = _make_fm({"use_full_width_chars": True})
        result = fm.sanitize_filename("foo/bar", self.rjcode)
        self.assertIn("\uff0f", result)  # fullwidth solidus

    def test_full_width_replaces_colon(self):
        fm = _make_fm({"use_full_width_chars": True})
        result = fm.sanitize_filename("foo:bar", self.rjcode)
        self.assertIn("\uff1a", result)  # fullwidth colon

    def test_full_width_replaces_all_reserved(self):
        fm = _make_fm({"use_full_width_chars": True})
        dirty = 'a\\b/c:d*e?f"g<h>i|j'
        result = fm.sanitize_filename(dirty, self.rjcode)
        for fw_char in WINDOWS_RESERVED_CHARACTER_REPLACE_STR:
            self.assertIn(fw_char, result)

    # ---- newline handling ----

    def test_newline_replaced_with_space(self):
        result = self.fm.sanitize_filename("foo\nbar", self.rjcode)
        self.assertNotIn("\n", result)
        self.assertIn("foo bar", result)

    def test_carriage_return_replaced_with_space(self):
        result = self.fm.sanitize_filename("foo\rbar", self.rjcode)
        self.assertNotIn("\r", result)
        self.assertIn("foo bar", result)

    def test_crlf_replaced_and_collapsed(self):
        result = self.fm.sanitize_filename("foo\r\nbar", self.rjcode)
        self.assertNotIn("\r", result)
        self.assertNotIn("\n", result)
        self.assertIn("foo bar", result)

    # ---- multiple spaces collapsed ----

    def test_multiple_spaces_collapsed_to_single(self):
        result = self.fm.sanitize_filename("foo   bar", self.rjcode)
        self.assertEqual(result, "foo bar")

    def test_tabs_collapsed(self):
        result = self.fm.sanitize_filename("foo\t\tbar", self.rjcode)
        self.assertEqual(result, "foo bar")

    def test_mixed_whitespace_collapsed(self):
        result = self.fm.sanitize_filename("foo  \t \n  bar", self.rjcode)
        self.assertEqual(result, "foo bar")

    # ---- edge cases ----

    def test_empty_string(self):
        result = self.fm.sanitize_filename("", self.rjcode)
        self.assertEqual(result, "")

    def test_only_reserved_chars(self):
        result = self.fm.sanitize_filename('\\/:*?"<>|', self.rjcode)
        self.assertEqual(result, "")

    def test_leading_trailing_spaces_stripped(self):
        result = self.fm.sanitize_filename("  hello world  ", self.rjcode)
        self.assertEqual(result, "hello world")

    def test_unicode_preserved(self):
        result = self.fm.sanitize_filename("テスト作品名", self.rjcode)
        self.assertEqual(result, "テスト作品名")

    def test_sanitize_calls_truncate(self):
        """sanitize_filename delegates to truncate_name at the end."""
        long_name = "a" * 300
        result = self.fm.sanitize_filename(long_name, self.rjcode)
        self.assertLessEqual(len(result), MAX_NAME_LENGTH)


# ===========================================================================
# 2. truncate_name
# ===========================================================================

class TestTruncateName(unittest.TestCase):
    """Tests for the static method FileManager.truncate_name."""

    def test_short_name_unchanged(self):
        name = "Short name"
        result = FileManager.truncate_name(name, "RJ000001")
        self.assertEqual(result, name)

    def test_exact_limit_unchanged(self):
        name = "x" * MAX_NAME_LENGTH
        result = FileManager.truncate_name(name, "RJ000001")
        self.assertEqual(result, name)

    def test_long_name_truncated_at_space_delimiter(self):
        # Build a name that exceeds MAX_NAME_LENGTH with spaces inside.
        word = "hello "
        repetitions = (MAX_NAME_LENGTH // len(word)) + 10
        long_name = (word * repetitions).strip()
        result = FileManager.truncate_name(long_name, "RJ000001")
        self.assertLessEqual(len(result), MAX_NAME_LENGTH)
        # Should end at a space boundary (last space before limit)
        # Verify it does NOT cut in the middle of "hello"
        self.assertTrue(
            result.endswith("hello") or result.endswith("hello "),
            f"Expected truncation at word boundary, got: ...{result[-20:]!r}",
        )

    def test_long_name_truncated_at_japanese_delimiter(self):
        # Use Japanese comma '、' as the delimiter present in the name.
        segment = "あいうえお、"  # 6 chars per segment
        repetitions = (MAX_NAME_LENGTH // len(segment)) + 5
        long_name = (segment * repetitions).rstrip("、")
        result = FileManager.truncate_name(long_name, "RJ000002")
        self.assertLessEqual(len(result), MAX_NAME_LENGTH)

    def test_no_delimiter_hard_cut(self):
        # A long name with no delimiters at all.
        long_name = "a" * (MAX_NAME_LENGTH + 50)
        result = FileManager.truncate_name(long_name, "RJ000003")
        self.assertEqual(len(result), MAX_NAME_LENGTH - 1)

    def test_delimiter_only_after_limit_hard_cut(self):
        # Delimiters exist but only AFTER the MAX_NAME_LENGTH boundary.
        long_name = "a" * (MAX_NAME_LENGTH + 5) + " " + "b" * 10
        result = FileManager.truncate_name(long_name, "RJ000004")
        # rfind within [0, MAX_NAME_LENGTH) won't find the space, so hard cut.
        self.assertEqual(len(result), MAX_NAME_LENGTH - 1)

    def test_returns_string(self):
        result = FileManager.truncate_name("test", "RJ000005")
        self.assertIsInstance(result, str)


# ===========================================================================
# 3. get_audio_files
# ===========================================================================

class TestGetAudioFiles(unittest.TestCase):
    """Tests for FileManager.get_audio_files."""

    def setUp(self):
        self.fm = _make_fm()

    def test_finds_all_audio_extensions(self):
        extensions = [".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus"]
        with tempfile.TemporaryDirectory() as tmpdir:
            for ext in extensions:
                (Path(tmpdir) / f"track{ext}").write_bytes(b"\x00")

            result = self.fm.get_audio_files(tmpdir)
            result_extensions = sorted(f.suffix.lower() for f in result)
            self.assertEqual(result_extensions, sorted(extensions))

    def test_ignores_non_audio_files(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            (Path(tmpdir) / "readme.txt").write_text("hello")
            (Path(tmpdir) / "cover.jpg").write_bytes(b"\xff\xd8")
            (Path(tmpdir) / "data.json").write_text("{}")
            (Path(tmpdir) / "track.mp3").write_bytes(b"\x00")

            result = self.fm.get_audio_files(tmpdir)
            self.assertEqual(len(result), 1)
            self.assertEqual(result[0].name, "track.mp3")

    def test_empty_directory(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            result = self.fm.get_audio_files(tmpdir)
            self.assertEqual(result, [])

    def test_recursive_search(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            subdir = Path(tmpdir) / "subfolder"
            subdir.mkdir()
            (Path(tmpdir) / "root.mp3").write_bytes(b"\x00")
            (subdir / "nested.flac").write_bytes(b"\x00")

            result = self.fm.get_audio_files(tmpdir)
            names = [f.name for f in result]
            self.assertIn("nested.flac", names)
            self.assertIn("root.mp3", names)

    def test_returns_sorted_by_name(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            (Path(tmpdir) / "charlie.mp3").write_bytes(b"\x00")
            (Path(tmpdir) / "alpha.mp3").write_bytes(b"\x00")
            (Path(tmpdir) / "bravo.mp3").write_bytes(b"\x00")

            result = self.fm.get_audio_files(tmpdir)
            names = [f.name for f in result]
            self.assertEqual(names, ["alpha.mp3", "bravo.mp3", "charlie.mp3"])

    def test_case_insensitive_extension(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            (Path(tmpdir) / "track.MP3").write_bytes(b"\x00")
            (Path(tmpdir) / "track2.Flac").write_bytes(b"\x00")

            result = self.fm.get_audio_files(tmpdir)
            self.assertEqual(len(result), 2)

    def test_nonexistent_directory_returns_empty(self):
        result = self.fm.get_audio_files("/nonexistent/path/12345")
        self.assertEqual(result, [])

    def test_returns_list_of_path_objects(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            (Path(tmpdir) / "track.mp3").write_bytes(b"\x00")
            result = self.fm.get_audio_files(tmpdir)
            self.assertIsInstance(result, list)
            for item in result:
                self.assertIsInstance(item, Path)


# ===========================================================================
# 4. save_to_file / read_file round-trip
# ===========================================================================

class TestSaveAndReadFile(unittest.TestCase):
    """Tests for FileManager.save_to_file and FileManager.read_file."""

    def setUp(self):
        self.fm = _make_fm()
        self.rjcode = "RJ999999"

    def test_roundtrip_ascii(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            content = "Hello, world!"
            self.fm.save_to_file(tmpdir, "test.txt", content, self.rjcode)
            file_path = str(Path(tmpdir) / "test.txt")
            result = self.fm.read_file(file_path, self.rjcode)
            self.assertEqual(result, content)

    def test_roundtrip_utf8_japanese(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            content = "これはテスト内容です。日本語テキスト。"
            self.fm.save_to_file(tmpdir, "japanese.txt", content, self.rjcode)
            file_path = str(Path(tmpdir) / "japanese.txt")
            result = self.fm.read_file(file_path, self.rjcode)
            self.assertEqual(result, content)

    def test_roundtrip_utf8_chinese(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            content = "这是中文测试内容"
            self.fm.save_to_file(tmpdir, "chinese.txt", content, self.rjcode)
            file_path = str(Path(tmpdir) / "chinese.txt")
            result = self.fm.read_file(file_path, self.rjcode)
            self.assertEqual(result, content)

    def test_roundtrip_emoji_and_special(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            content = "Stars: \u2605\u2606 | Arrows: \u2190\u2192"
            self.fm.save_to_file(tmpdir, "special.txt", content, self.rjcode)
            file_path = str(Path(tmpdir) / "special.txt")
            result = self.fm.read_file(file_path, self.rjcode)
            self.assertEqual(result, content)

    def test_roundtrip_multiline(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            content = "Line 1\nLine 2\nLine 3\n"
            self.fm.save_to_file(tmpdir, "multi.txt", content, self.rjcode)
            file_path = str(Path(tmpdir) / "multi.txt")
            result = self.fm.read_file(file_path, self.rjcode)
            self.assertEqual(result, content)

    def test_roundtrip_empty_content(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            content = ""
            self.fm.save_to_file(tmpdir, "empty.txt", content, self.rjcode)
            file_path = str(Path(tmpdir) / "empty.txt")
            result = self.fm.read_file(file_path, self.rjcode)
            self.assertEqual(result, content)

    def test_read_nonexistent_file_raises(self):
        """read_file only catches UnicodeDecodeError internally; a missing file
        raises FileNotFoundError."""
        with self.assertRaises(FileNotFoundError):
            self.fm.read_file("/nonexistent/path/file.txt", self.rjcode)

    def test_save_overwrites_existing(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            self.fm.save_to_file(tmpdir, "over.txt", "first", self.rjcode)
            self.fm.save_to_file(tmpdir, "over.txt", "second", self.rjcode)
            file_path = str(Path(tmpdir) / "over.txt")
            result = self.fm.read_file(file_path, self.rjcode)
            self.assertEqual(result, "second")


# ===========================================================================
# 5. _prepare_replacements
# ===========================================================================

class TestPrepareReplacements(unittest.TestCase):
    """Tests for FileManager._prepare_replacements."""

    def test_basic_metadata_fields(self):
        fm = _make_fm({"template": "rjcode work_name maker_name"})
        metadata = make_sample_metadata()
        replacements = fm._prepare_replacements(metadata)

        self.assertEqual(replacements["rjcode"], "RJ1234567")
        self.assertEqual(replacements["work_name"], "テスト作品")
        self.assertEqual(replacements["maker_name"], "テストサークル")

    def test_rating_is_string(self):
        fm = _make_fm({"template": "rating"})
        metadata = make_sample_metadata()
        replacements = fm._prepare_replacements(metadata)
        self.assertEqual(replacements["rating"], "4.5")
        self.assertIsInstance(replacements["rating"], str)

    def test_age_field(self):
        fm = _make_fm({"template": "age"})
        metadata = make_sample_metadata()
        replacements = fm._prepare_replacements(metadata)
        self.assertEqual(replacements["age"], "\u2471")  # circled 18 (⑱)

    def test_release_date_formatting(self):
        fm = _make_fm({
            "template": "release_date",
            "renamer_release_date_format": "%Y/%m/%d",
        })
        metadata = make_sample_metadata()
        metadata["release_date"] = "2024-06-15"
        replacements = fm._prepare_replacements(metadata)
        self.assertEqual(replacements["release_date"], "2024/06/15")

    def test_release_date_default_format(self):
        fm = _make_fm({
            "template": "release_date",
            "renamer_release_date_format": "%d-%m-%y",
        })
        metadata = make_sample_metadata()
        metadata["release_date"] = "2024-01-15"
        replacements = fm._prepare_replacements(metadata)
        self.assertEqual(replacements["release_date"], "15-01-24")

    def test_release_date_invalid_fallback(self):
        fm = _make_fm({
            "template": "release_date",
            "renamer_release_date_format": "%Y-%m-%d",
        })
        metadata = make_sample_metadata()
        metadata["release_date"] = "not-a-date"
        replacements = fm._prepare_replacements(metadata)
        self.assertEqual(replacements["release_date"], "not-a-date")

    def test_release_date_empty(self):
        fm = _make_fm({
            "template": "release_date",
            "renamer_release_date_format": "%Y-%m-%d",
        })
        metadata = make_sample_metadata()
        metadata["release_date"] = ""
        replacements = fm._prepare_replacements(metadata)
        # Empty string causes ValueError in strptime, falls back to original
        self.assertEqual(replacements["release_date"], "")

    def test_cv_list_with_cvs(self):
        fm = _make_fm({
            "template": "cv_list_str",
            "cv_list_left": "(CV. ",
            "cv_list_right": ")",
        })
        metadata = make_sample_metadata()
        metadata["cvs"] = ["Alice", "Bob"]
        replacements = fm._prepare_replacements(metadata)
        self.assertEqual(replacements["cv_list_str"], "(CV. Alice, Bob)")

    def test_cv_list_empty(self):
        fm = _make_fm({"template": "cv_list_str"})
        metadata = make_sample_metadata()
        metadata["cvs"] = []
        replacements = fm._prepare_replacements(metadata)
        self.assertEqual(replacements["cv_list_str"], "")

    def test_tags_list_with_tags(self):
        fm = _make_fm({
            "template": "tags_list_str",
            "renamer_delimiter": " | ",
        })
        metadata = make_sample_metadata()
        metadata["tags"] = ["ASMR", "Healing"]
        replacements = fm._prepare_replacements(metadata)
        self.assertEqual(replacements["tags_list_str"], "ASMR | Healing")

    def test_tags_list_empty(self):
        fm = _make_fm({"template": "tags_list_str"})
        metadata = make_sample_metadata()
        metadata["tags"] = []
        replacements = fm._prepare_replacements(metadata)
        self.assertEqual(replacements["tags_list_str"], "")

    def test_missing_metadata_fields_use_defaults(self):
        fm = _make_fm({"template": "rjcode work_name maker_name"})
        metadata = {}  # Completely empty
        replacements = fm._prepare_replacements(metadata)
        self.assertEqual(replacements["rjcode"], "")
        self.assertEqual(replacements["work_name"], "")
        self.assertEqual(replacements["maker_name"], "")

    def test_template_not_containing_release_date_skips_parsing(self):
        fm = _make_fm({"template": "rjcode work_name"})
        metadata = make_sample_metadata()
        replacements = fm._prepare_replacements(metadata)
        # release_date key should NOT be in replacements since it is not in template
        self.assertNotIn("release_date", replacements)


# ===========================================================================
# 6. translate_content
# ===========================================================================

class TestTranslateContent(unittest.TestCase):
    """Tests for FileManager.translate_content."""

    def test_translation_disabled_returns_identity(self):
        fm = _make_fm({
            "features": {"enable_translation": False},
        })
        texts = ["hello", "world"]
        result = fm.translate_content(texts, "RJ000001")
        self.assertEqual(result, {"hello": "hello", "world": "world"})

    def test_translation_empty_list(self):
        fm = _make_fm({
            "features": {"enable_translation": True},
        })
        result = fm.translate_content([], "RJ000001")
        self.assertEqual(result, {})

    def test_translation_enabled_calls_scraper(self):
        fm = _make_fm({
            "features": {"enable_translation": True},
            "locale": "en_us",
            "include_original_name": False,
        })
        fm.scraper.translate.return_value = ["hi", "planet"]
        result = fm.translate_content(["hello", "world"], "RJ000001")
        fm.scraper.translate.assert_called_once_with(
            ["hello", "world"], "en", "RJ000001"
        )
        self.assertEqual(result["hello"], "hi")
        self.assertEqual(result["world"], "planet")

    def test_translation_caching(self):
        fm = _make_fm({
            "features": {"enable_translation": True},
            "locale": "en_us",
            "include_original_name": False,
        })
        fm.scraper.translate.return_value = ["translated"]
        texts = ["original"]
        rjcode = "RJ000001"

        result1 = fm.translate_content(texts, rjcode)
        result2 = fm.translate_content(texts, rjcode)

        # Scraper should only be called once due to caching.
        self.assertEqual(fm.scraper.translate.call_count, 1)
        self.assertEqual(result1, result2)

    def test_translation_different_rjcodes_not_cached_together(self):
        fm = _make_fm({
            "features": {"enable_translation": True},
            "locale": "en_us",
            "include_original_name": False,
        })
        fm.scraper.translate.return_value = ["translated"]
        fm.translate_content(["text"], "RJ000001")
        fm.translate_content(["text"], "RJ000002")
        # Different rjcodes should trigger separate calls.
        self.assertEqual(fm.scraper.translate.call_count, 2)


# ===========================================================================
# 7. rename_folder
# ===========================================================================

class TestRenameFolder(unittest.TestCase):
    """Tests for FileManager.rename_folder."""

    def test_rename_folder_success(self):
        fm = _make_fm({"template": "rjcode work_name"})
        metadata = make_sample_metadata()

        with tempfile.TemporaryDirectory() as tmpdir:
            old_folder = Path(tmpdir) / "old_name"
            old_folder.mkdir()

            result = fm.rename_folder(str(old_folder), metadata)
            expected_name = fm._generate_folder_name(metadata)
            expected_path = str(Path(tmpdir) / expected_name)
            self.assertEqual(result, expected_path)
            self.assertTrue(Path(result).exists())
            self.assertFalse(old_folder.exists())

    def test_rename_folder_empty_name_skips(self):
        fm = _make_fm({"template": ""})
        metadata = make_sample_metadata()

        with tempfile.TemporaryDirectory() as tmpdir:
            old_folder = Path(tmpdir) / "old_name"
            old_folder.mkdir()

            result = fm.rename_folder(str(old_folder), metadata)
            # Should return the original path since the new name is empty.
            self.assertEqual(result, str(old_folder))
            self.assertTrue(old_folder.exists())

    def test_rename_folder_os_error_returns_original(self):
        fm = _make_fm({"template": "rjcode work_name"})
        metadata = make_sample_metadata()

        # Pass a non-existent folder to trigger OSError.
        fake_path = "/nonexistent/path/folder_12345"
        result = fm.rename_folder(fake_path, metadata)
        self.assertEqual(result, fake_path)


# ===========================================================================
# 8. _generate_folder_name
# ===========================================================================

class TestGenerateFolderName(unittest.TestCase):
    """Tests for FileManager._generate_folder_name."""

    def test_simple_template(self):
        fm = _make_fm({"template": "rjcode work_name"})
        metadata = make_sample_metadata()
        result = fm._generate_folder_name(metadata)
        self.assertIn("RJ1234567", result)
        self.assertIn("テスト作品", result)

    def test_template_with_maker(self):
        fm = _make_fm({"template": "[maker_name] rjcode work_name"})
        metadata = make_sample_metadata()
        result = fm._generate_folder_name(metadata)
        self.assertTrue(result.startswith("[テストサークル]"))

    def test_template_sanitized(self):
        fm = _make_fm({"template": "rjcode work_name"})
        metadata = make_sample_metadata()
        metadata["work_name"] = 'Test: "Work" <Name>'
        result = fm._generate_folder_name(metadata)
        # Reserved characters should be removed.
        self.assertNotIn(":", result)
        self.assertNotIn('"', result)
        self.assertNotIn("<", result)
        self.assertNotIn(">", result)

    def test_template_truncated_when_too_long(self):
        fm = _make_fm({"template": "work_name"})
        metadata = make_sample_metadata()
        metadata["work_name"] = "A" * 300
        result = fm._generate_folder_name(metadata)
        self.assertLessEqual(len(result), MAX_NAME_LENGTH)


# ===========================================================================
# 9. Edge cases and integration
# ===========================================================================

class TestEdgeCases(unittest.TestCase):
    """Additional edge case tests."""

    def test_sanitize_preserves_dots_and_hyphens(self):
        fm = _make_fm()
        result = fm.sanitize_filename("v1.0 - release", "RJ000001")
        self.assertEqual(result, "v1.0 - release")

    def test_sanitize_preserves_parentheses(self):
        fm = _make_fm()
        result = fm.sanitize_filename("Work (Deluxe Edition)", "RJ000001")
        self.assertEqual(result, "Work (Deluxe Edition)")

    def test_sanitize_preserves_square_brackets(self):
        fm = _make_fm()
        result = fm.sanitize_filename("[Circle] Work Name", "RJ000001")
        self.assertEqual(result, "[Circle] Work Name")

    def test_truncate_name_with_multiple_delimiter_types(self):
        """When multiple delimiter types are present, truncation picks the
        rightmost one before the limit."""
        prefix = "x" * 190
        # At position 190, add a space, then more chars past 200
        name = prefix + " " + "y" * 20
        self.assertGreater(len(name), MAX_NAME_LENGTH)
        result = FileManager.truncate_name(name, "RJ000001")
        self.assertLessEqual(len(result), MAX_NAME_LENGTH)
        # Should have truncated at the space (position 190)
        self.assertEqual(result, prefix)

    def test_get_audio_files_deeply_nested(self):
        fm = _make_fm()
        with tempfile.TemporaryDirectory() as tmpdir:
            deep = Path(tmpdir) / "a" / "b" / "c"
            deep.mkdir(parents=True)
            (deep / "deep.opus").write_bytes(b"\x00")

            result = fm.get_audio_files(tmpdir)
            self.assertEqual(len(result), 1)
            self.assertEqual(result[0].name, "deep.opus")

    def test_save_to_file_creates_file(self):
        fm = _make_fm()
        with tempfile.TemporaryDirectory() as tmpdir:
            fm.save_to_file(tmpdir, "new_file.txt", "content", "RJ000001")
            self.assertTrue((Path(tmpdir) / "new_file.txt").exists())

    def test_full_width_mode_does_not_strip_normal_chars(self):
        fm = _make_fm({"use_full_width_chars": True})
        result = fm.sanitize_filename("Normal Text 123", "RJ000001")
        self.assertEqual(result, "Normal Text 123")


if __name__ == "__main__":
    unittest.main()
