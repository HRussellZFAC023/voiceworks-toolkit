import sys
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch
from types import ModuleType

sys.path.insert(0, str(Path(__file__).parent.parent))

# Mock heavy dependencies that script_manager.py imports transitively
# (metadata_handler -> file_manager -> scraper -> pyquery, etc.)
_mock_modules = {}
for mod_name in [
    "pyquery",
    "mutagen",
    "mutagen.id3",
    "mutagen.mp3",
    "mutagen.flac",
    "mutagen.mp4",
    "mutagen.oggvorbis",
    "mutagen.oggopus",
    "mutagen.wave",
    "mutagen.aiff",
    "peewee",
    "scraper",
    "scraper.scraper",
    "scraper.cached_scraper",
    "scraper.work_metadata",
    "scraper.db",
    "file_manager",
    "metadata_handler",
    "mutagen_helper",
]:
    if mod_name not in sys.modules:
        mock_mod = ModuleType(mod_name)
        # Add commonly referenced attributes as MagicMock
        mock_mod.__dict__.setdefault("Scraper", MagicMock)
        mock_mod.__dict__.setdefault("CachedScraper", MagicMock)
        mock_mod.__dict__.setdefault("WorkMetadata", MagicMock)
        mock_mod.__dict__.setdefault("db", MagicMock())
        mock_mod.__dict__.setdefault("FileManager", MagicMock)
        mock_mod.__dict__.setdefault("MetadataHandler", MagicMock)
        mock_mod.__dict__.setdefault("MutagenHelper", MagicMock)
        mock_mod.__dict__.setdefault("PyQuery", MagicMock)
        _mock_modules[mod_name] = mock_mod
        sys.modules[mod_name] = mock_mod

from script_manager import ScriptManager, TimedText


def _make_mock_config(overrides=None):
    """Create a mock config object with sensible defaults."""
    data = {
        "locale": "en_us",
        "features": {
            "enable_translation": False,
            "enable_transcription": False,
        },
    }
    if overrides:
        data.update(overrides)
    mock = MagicMock()
    mock.get = MagicMock(side_effect=lambda key, default=None: data.get(key, default))
    return mock


def _make_script_manager(config=None, scripts_root=None):
    """Create a ScriptManager with mocked dependencies and optional scripts_root override."""
    if config is None:
        config = _make_mock_config()
    scraper = MagicMock()
    metadata_handler = MagicMock()

    with patch.object(Path, "mkdir"):
        sm = ScriptManager(config, scraper, metadata_handler)

    if scripts_root is not None:
        sm.scripts_root = Path(scripts_root)

    return sm


class TestFormatLrcTimestamp(unittest.TestCase):
    """Tests for ScriptManager._format_lrc_timestamp()."""

    def setUp(self):
        self.sm = _make_script_manager()

    def test_zero_seconds(self):
        """0 seconds should produce [00:00.00]."""
        result = self.sm._format_lrc_timestamp(0)
        self.assertEqual(result, "[00:00.00]")

    def test_65_seconds(self):
        """65 seconds = 1 minute 5 seconds -> [01:05.00]."""
        result = self.sm._format_lrc_timestamp(65.0)
        self.assertEqual(result, "[01:05.00]")

    def test_fractional_seconds(self):
        """Fractional seconds should appear after the decimal point."""
        result = self.sm._format_lrc_timestamp(3.75)
        self.assertEqual(result, "[00:03.75]")

    def test_large_value_over_3600(self):
        """3661 seconds = 61 minutes 1 second -> [61:01.00]."""
        result = self.sm._format_lrc_timestamp(3661.0)
        self.assertEqual(result, "[61:01.00]")

    def test_3600_exactly(self):
        """3600 seconds = 60 minutes exactly -> [60:00.00]."""
        result = self.sm._format_lrc_timestamp(3600.0)
        self.assertEqual(result, "[60:00.00]")

    def test_small_fraction(self):
        """Small fractional values should be formatted correctly."""
        result = self.sm._format_lrc_timestamp(0.05)
        self.assertEqual(result, "[00:00.05]")

    def test_99_minutes(self):
        """Very large minutes value should still work."""
        result = self.sm._format_lrc_timestamp(99 * 60 + 59.99)
        self.assertEqual(result, "[99:59.99]")


class TestGenerateLrc(unittest.TestCase):
    """Tests for ScriptManager._generate_lrc()."""

    def setUp(self):
        self.sm = _make_script_manager()

    def test_dict_segments(self):
        """Dict-style segments with 'text' and 'timestamp' keys should generate valid LRC."""
        segments = [
            {"text": "Hello", "timestamp": [0.0, 2.0]},
            {"text": "World", "timestamp": [2.0, 4.0]},
        ]
        result = self.sm._generate_lrc(segments)
        lines = result.split("\n")
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[0], "[00:00.00]Hello")
        self.assertEqual(lines[1], "[00:02.00]World")

    def test_timed_text_segments(self):
        """TimedText segments should generate valid LRC."""
        segments = [
            TimedText(start=0.0, end=2.0, text="Line one"),
            TimedText(start=5.5, end=8.0, text="Line two"),
        ]
        result = self.sm._generate_lrc(segments)
        lines = result.split("\n")
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[0], "[00:00.00]Line one")
        self.assertEqual(lines[1], "[00:05.50]Line two")

    def test_empty_segments(self):
        """Empty segments list should produce empty string."""
        result = self.sm._generate_lrc([])
        self.assertEqual(result, "")

    def test_skips_blank_text(self):
        """Segments with only whitespace text should be skipped."""
        segments = [
            {"text": "Hello", "timestamp": [0.0, 2.0]},
            {"text": "   ", "timestamp": [2.0, 4.0]},
            {"text": "World", "timestamp": [4.0, 6.0]},
        ]
        result = self.sm._generate_lrc(segments)
        lines = result.split("\n")
        self.assertEqual(len(lines), 2)
        self.assertIn("Hello", lines[0])
        self.assertIn("World", lines[1])

    def test_mixed_segment_types(self):
        """A mix of dict and TimedText segments should both work."""
        segments = [
            {"text": "Dict line", "timestamp": [0.0, 2.0]},
            TimedText(start=3.0, end=5.0, text="TimedText line"),
        ]
        result = self.sm._generate_lrc(segments)
        lines = result.split("\n")
        self.assertEqual(len(lines), 2)
        self.assertIn("Dict line", lines[0])
        self.assertIn("TimedText line", lines[1])


class TestCombineSegments(unittest.TestCase):
    """Tests for ScriptManager._combine_segments()."""

    def setUp(self):
        self.sm = _make_script_manager()

    def test_normal_segments(self):
        """Normal segments should be joined with newlines."""
        segments = [
            {"text": "Line A", "timestamp": [0, 1]},
            {"text": "Line B", "timestamp": [1, 2]},
        ]
        result = self.sm._combine_segments(segments)
        self.assertEqual(result, "Line A\nLine B")

    def test_empty_segments(self):
        """Empty list should produce empty string."""
        result = self.sm._combine_segments([])
        self.assertEqual(result, "")

    def test_mixed_dict_and_timed_text(self):
        """Mixed segment types should combine correctly."""
        segments = [
            {"text": "First", "timestamp": [0, 1]},
            TimedText(start=1.0, end=2.0, text="Second"),
            {"text": "Third", "timestamp": [2, 3]},
        ]
        result = self.sm._combine_segments(segments)
        self.assertEqual(result, "First\nSecond\nThird")

    def test_whitespace_only_segments_skipped(self):
        """Segments with only whitespace text should be skipped."""
        segments = [
            {"text": "Keep", "timestamp": [0, 1]},
            {"text": "   ", "timestamp": [1, 2]},
            {"text": "Also keep", "timestamp": [2, 3]},
        ]
        result = self.sm._combine_segments(segments)
        self.assertEqual(result, "Keep\nAlso keep")

    def test_timed_text_only(self):
        """All TimedText segments should combine correctly."""
        segments = [
            TimedText(start=0.0, end=1.0, text="Alpha"),
            TimedText(start=1.0, end=2.0, text="Beta"),
        ]
        result = self.sm._combine_segments(segments)
        self.assertEqual(result, "Alpha\nBeta")


class TestNormalizeLanguageCode(unittest.TestCase):
    """Tests for ScriptManager._normalize_language_code()."""

    def setUp(self):
        self.sm = _make_script_manager()

    def test_ja_to_jpn(self):
        self.assertEqual(self.sm._normalize_language_code("ja"), "jpn")

    def test_en_to_eng(self):
        self.assertEqual(self.sm._normalize_language_code("en"), "eng")

    def test_ko_to_kor(self):
        self.assertEqual(self.sm._normalize_language_code("ko"), "kor")

    def test_zh_to_zho(self):
        self.assertEqual(self.sm._normalize_language_code("zh"), "zho")

    def test_unknown_passthrough(self):
        """Unknown codes should be returned lowercased."""
        self.assertEqual(self.sm._normalize_language_code("fr"), "fr")

    def test_uppercase_input(self):
        """Input should be case-insensitive."""
        self.assertEqual(self.sm._normalize_language_code("JA"), "jpn")
        self.assertEqual(self.sm._normalize_language_code("EN"), "eng")

    def test_mixed_case(self):
        """Mixed case should still work."""
        self.assertEqual(self.sm._normalize_language_code("Ko"), "kor")

    def test_already_three_letter(self):
        """Already three-letter codes not in the map pass through lowercased."""
        self.assertEqual(self.sm._normalize_language_code("jpn"), "jpn")
        self.assertEqual(self.sm._normalize_language_code("deu"), "deu")


class TestGetRjFolder(unittest.TestCase):
    """Tests for ScriptManager.get_rj_folder()."""

    def test_strips_rj_prefix(self):
        """RJ prefix should be removed."""
        with tempfile.TemporaryDirectory() as tmpdir:
            sm = _make_script_manager(scripts_root=tmpdir)
            folder = sm.get_rj_folder("RJ1234567")
            self.assertEqual(folder.name, "1234567")

    def test_strips_leading_zeros(self):
        """Leading zeros after RJ should be stripped."""
        with tempfile.TemporaryDirectory() as tmpdir:
            sm = _make_script_manager(scripts_root=tmpdir)
            folder = sm.get_rj_folder("RJ01234567")
            self.assertEqual(folder.name, "1234567")

    def test_strips_all_leading_zeros(self):
        """Multiple leading zeros should all be stripped."""
        with tempfile.TemporaryDirectory() as tmpdir:
            sm = _make_script_manager(scripts_root=tmpdir)
            folder = sm.get_rj_folder("RJ000123")
            self.assertEqual(folder.name, "123")

    def test_folder_created(self):
        """The folder should be created on disk."""
        with tempfile.TemporaryDirectory() as tmpdir:
            sm = _make_script_manager(scripts_root=tmpdir)
            folder = sm.get_rj_folder("RJ1234567")
            self.assertTrue(folder.exists())
            self.assertTrue(folder.is_dir())

    def test_folder_is_under_scripts_root(self):
        """The folder should be a subdirectory of scripts_root."""
        with tempfile.TemporaryDirectory() as tmpdir:
            sm = _make_script_manager(scripts_root=tmpdir)
            folder = sm.get_rj_folder("RJ999")
            self.assertEqual(folder.parent, Path(tmpdir))

    def test_numeric_only_code(self):
        """A code that is purely numeric (no RJ prefix) should work."""
        with tempfile.TemporaryDirectory() as tmpdir:
            sm = _make_script_manager(scripts_root=tmpdir)
            folder = sm.get_rj_folder("1234567")
            self.assertEqual(folder.name, "1234567")


class TestSaveTranscription(unittest.TestCase):
    """Tests for ScriptManager.save_transcription()."""

    def test_creates_lrc_and_txt_files(self):
        """save_transcription should create both .lrc and .txt files in scripts/ja/."""
        with tempfile.TemporaryDirectory() as tmpdir:
            target_dir = Path(tmpdir)
            sm = _make_script_manager(scripts_root=tmpdir)

            transcription = {
                "original_filename": "track_01",
                "segments": [
                    {"text": "Hello world", "timestamp": [0.0, 2.0]},
                    {"text": "Second line", "timestamp": [2.0, 4.0]},
                ],
            }

            sm.save_transcription(transcription, "RJ123456", 1, target_dir)

            lrc_path = target_dir / "scripts" / "ja" / "track_01.lrc"
            txt_path = target_dir / "scripts" / "ja" / "track_01.txt"

            self.assertTrue(lrc_path.exists(), f"LRC file not found at {lrc_path}")
            self.assertTrue(txt_path.exists(), f"TXT file not found at {txt_path}")

    def test_lrc_content_format(self):
        """LRC file should contain properly formatted timestamps."""
        with tempfile.TemporaryDirectory() as tmpdir:
            target_dir = Path(tmpdir)
            sm = _make_script_manager(scripts_root=tmpdir)

            transcription = {
                "original_filename": "audio",
                "segments": [
                    {"text": "First", "timestamp": [0.0, 1.0]},
                    {"text": "Second", "timestamp": [65.5, 70.0]},
                ],
            }

            sm.save_transcription(transcription, "RJ123", 1, target_dir)

            lrc_path = target_dir / "scripts" / "ja" / "audio.lrc"
            content = lrc_path.read_text(encoding="utf-8")
            self.assertIn("[00:00.00]First", content)
            self.assertIn("[01:05.50]Second", content)

    def test_txt_content(self):
        """TXT file should contain combined segment text."""
        with tempfile.TemporaryDirectory() as tmpdir:
            target_dir = Path(tmpdir)
            sm = _make_script_manager(scripts_root=tmpdir)

            transcription = {
                "original_filename": "voice",
                "segments": [
                    {"text": "Line one", "timestamp": [0.0, 1.0]},
                    {"text": "Line two", "timestamp": [1.0, 2.0]},
                ],
            }

            sm.save_transcription(transcription, "RJ456", 1, target_dir)

            txt_path = target_dir / "scripts" / "ja" / "voice.txt"
            content = txt_path.read_text(encoding="utf-8")
            self.assertIn("Line one", content)
            self.assertIn("Line two", content)

    def test_uses_track_num_when_no_original_filename(self):
        """When original_filename is missing, track_num should be used as the base name."""
        with tempfile.TemporaryDirectory() as tmpdir:
            target_dir = Path(tmpdir)
            sm = _make_script_manager(scripts_root=tmpdir)

            transcription = {
                "segments": [
                    {"text": "Content", "timestamp": [0.0, 1.0]},
                ],
            }

            sm.save_transcription(transcription, "RJ789", 3, target_dir)

            lrc_path = target_dir / "scripts" / "ja" / "3.lrc"
            txt_path = target_dir / "scripts" / "ja" / "3.txt"
            self.assertTrue(lrc_path.exists())
            self.assertTrue(txt_path.exists())

    def test_scripts_ja_directory_created(self):
        """The scripts/ja/ directory should be created if it does not exist."""
        with tempfile.TemporaryDirectory() as tmpdir:
            target_dir = Path(tmpdir) / "work"
            # target_dir does not exist yet
            sm = _make_script_manager(scripts_root=tmpdir)

            transcription = {
                "original_filename": "test",
                "segments": [
                    {"text": "Hello", "timestamp": [0.0, 1.0]},
                ],
            }

            sm.save_transcription(transcription, "RJ100", 1, target_dir)

            ja_dir = target_dir / "scripts" / "ja"
            self.assertTrue(ja_dir.exists())
            self.assertTrue(ja_dir.is_dir())


class TestGetScriptsAsLyrics(unittest.TestCase):
    """Tests for ScriptManager.get_scripts_as_lyrics()."""

    def _setup_work_dir(self, tmpdir):
        """Set up a work directory with audio files and script files."""
        work_dir = Path(tmpdir) / "work"
        work_dir.mkdir()

        # Create audio files
        (work_dir / "01_track.mp3").write_bytes(b"\x00")
        (work_dir / "02_track.mp3").write_bytes(b"\x00")

        # Create scripts/ja directory with matching files
        ja_dir = work_dir / "scripts" / "ja"
        ja_dir.mkdir(parents=True)

        (ja_dir / "01_track.txt").write_text("Japanese text 1", encoding="utf-8")
        (ja_dir / "01_track.lrc").write_text("[00:00.00]Lyric 1", encoding="utf-8")
        (ja_dir / "02_track.txt").write_text("Japanese text 2", encoding="utf-8")
        (ja_dir / "02_track.lrc").write_text("[00:00.00]Lyric 2", encoding="utf-8")

        return work_dir

    def test_matches_lyrics_to_audio_files(self):
        """Lyrics should be matched to audio files by filename."""
        with tempfile.TemporaryDirectory() as tmpdir:
            work_dir = self._setup_work_dir(tmpdir)
            sm = _make_script_manager(scripts_root=tmpdir)

            lyrics = sm.get_scripts_as_lyrics(work_dir)

            self.assertIn(0, lyrics)
            self.assertIn(1, lyrics)

    def test_unsynced_lyrics_key(self):
        """Unsynced lyrics should be stored under USLT::jpn key."""
        with tempfile.TemporaryDirectory() as tmpdir:
            work_dir = self._setup_work_dir(tmpdir)
            sm = _make_script_manager(scripts_root=tmpdir)

            lyrics = sm.get_scripts_as_lyrics(work_dir)

            self.assertIn("USLT::jpn", lyrics[0])
            self.assertEqual(lyrics[0]["USLT::jpn"], "Japanese text 1")

    def test_synced_lyrics_key(self):
        """Synced lyrics should be stored under SYLT::jpn key."""
        with tempfile.TemporaryDirectory() as tmpdir:
            work_dir = self._setup_work_dir(tmpdir)
            sm = _make_script_manager(scripts_root=tmpdir)

            lyrics = sm.get_scripts_as_lyrics(work_dir)

            self.assertIn("SYLT::jpn", lyrics[0])
            self.assertIn("[00:00.00]Lyric 1", lyrics[0]["SYLT::jpn"])

    def test_default_lyrics_is_japanese(self):
        """Without translation enabled, default lyrics should be Japanese."""
        with tempfile.TemporaryDirectory() as tmpdir:
            work_dir = self._setup_work_dir(tmpdir)
            sm = _make_script_manager(scripts_root=tmpdir)

            lyrics = sm.get_scripts_as_lyrics(work_dir)

            self.assertIn("lyrics", lyrics[0])
            self.assertEqual(lyrics[0]["lyrics"], "Japanese text 1")

    def test_no_scripts_directory(self):
        """When scripts directory has no language subdirectories, result should be empty dicts."""
        with tempfile.TemporaryDirectory() as tmpdir:
            work_dir = Path(tmpdir) / "work"
            work_dir.mkdir()
            (work_dir / "01_track.mp3").write_bytes(b"\x00")

            scripts_dir = work_dir / "scripts"
            scripts_dir.mkdir()

            sm = _make_script_manager(scripts_root=tmpdir)
            lyrics = sm.get_scripts_as_lyrics(work_dir)

            # Track exists but no lyrics matched
            self.assertEqual(len(lyrics), 1)
            self.assertEqual(lyrics[0], {})

    def test_multiple_languages(self):
        """When multiple language directories exist, all should be included."""
        with tempfile.TemporaryDirectory() as tmpdir:
            work_dir = Path(tmpdir) / "work"
            work_dir.mkdir()
            (work_dir / "01_track.mp3").write_bytes(b"\x00")

            ja_dir = work_dir / "scripts" / "ja"
            ja_dir.mkdir(parents=True)
            (ja_dir / "01_track.txt").write_text("Japanese", encoding="utf-8")

            en_dir = work_dir / "scripts" / "en"
            en_dir.mkdir(parents=True)
            (en_dir / "01_track.txt").write_text("English", encoding="utf-8")

            sm = _make_script_manager(scripts_root=tmpdir)
            lyrics = sm.get_scripts_as_lyrics(work_dir)

            self.assertIn("USLT::jpn", lyrics[0])
            self.assertIn("USLT::eng", lyrics[0])
            self.assertEqual(lyrics[0]["USLT::jpn"], "Japanese")
            self.assertEqual(lyrics[0]["USLT::eng"], "English")


class TestImportScripts(unittest.TestCase):
    """Tests for ScriptManager.import_scripts()."""

    def test_import_copies_files(self):
        """import_scripts should copy files from source to target scripts/ja/."""
        with tempfile.TemporaryDirectory() as tmpdir:
            scripts_root = Path(tmpdir) / "scripts_root"
            scripts_root.mkdir()

            # Create source scripts
            source_dir = scripts_root / "1234567"
            source_dir.mkdir()
            (source_dir / "track1.lrc").write_text("[00:00.00]Hello", encoding="utf-8")
            (source_dir / "track1.txt").write_text("Hello", encoding="utf-8")

            target_dir = Path(tmpdir) / "target"
            target_dir.mkdir()

            sm = _make_script_manager(scripts_root=str(scripts_root))

            result = sm.import_scripts("RJ1234567", target_dir)

            self.assertTrue(result)
            ja_dir = target_dir / "scripts" / "ja"
            self.assertTrue((ja_dir / "track1.lrc").exists())
            self.assertTrue((ja_dir / "track1.txt").exists())

    def test_import_nonexistent_source(self):
        """import_scripts should return False when source folder does not exist."""
        with tempfile.TemporaryDirectory() as tmpdir:
            sm = _make_script_manager(scripts_root=tmpdir)
            target_dir = Path(tmpdir) / "target"
            target_dir.mkdir()

            result = sm.import_scripts("RJ9999999", target_dir)

            self.assertFalse(result)

    def test_import_empty_source(self):
        """import_scripts should return False when source folder is empty."""
        with tempfile.TemporaryDirectory() as tmpdir:
            scripts_root = Path(tmpdir) / "scripts_root"
            scripts_root.mkdir()
            (scripts_root / "1234").mkdir()

            sm = _make_script_manager(scripts_root=str(scripts_root))
            target_dir = Path(tmpdir) / "target"
            target_dir.mkdir()

            result = sm.import_scripts("RJ1234", target_dir)

            self.assertFalse(result)


class TestTimedText(unittest.TestCase):
    """Tests for the TimedText dataclass."""

    def test_creation(self):
        """TimedText should store start, end, and text."""
        tt = TimedText(start=1.5, end=3.0, text="Hello")
        self.assertEqual(tt.start, 1.5)
        self.assertEqual(tt.end, 3.0)
        self.assertEqual(tt.text, "Hello")

    def test_equality(self):
        """Two TimedText with same values should be equal."""
        a = TimedText(start=0.0, end=1.0, text="Test")
        b = TimedText(start=0.0, end=1.0, text="Test")
        self.assertEqual(a, b)


if __name__ == "__main__":
    unittest.main()
