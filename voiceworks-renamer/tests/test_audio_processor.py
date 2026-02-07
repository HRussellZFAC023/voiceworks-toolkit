"""Comprehensive tests for the AudioProcessor class."""

import os
import sys
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch, call

# Ensure project root is on sys.path
PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

# ---------------------------------------------------------------------------
# Stub out heavy third-party modules that are transitively imported by
# audio_processor -> metadata_handler -> file_manager -> scraper chain and
# transcriber.  These are not needed at runtime since every dependency of
# AudioProcessor is replaced with a MagicMock in the tests.
# ---------------------------------------------------------------------------
_STUB_MODULES = [
    # scraper chain
    "pyquery",
    "googletrans",
    "peewee",
    # mutagen (metadata_handler -> mutagen_helper)
    "mutagen",
    "mutagen.flac",
    "mutagen.mp4",
    "mutagen.id3",
    "mutagen.ogg",
    "mutagen.oggvorbis",
    "mutagen.oggopus",
    "mutagen.wave",
    "mutagen.aac",
    "mutagen.aiff",
    "mutagen.apev2",
    "mutagen.mp3",
    # transcriber
    "torch",
    "faster_whisper",
    "openvino_genai",
    "librosa",
    # wxPython (pulled in by some modules)
    "wx",
    "wx.adv",
    "wx.lib",
    "wx.lib.newevent",
    # langdetect
    "langdetect",
    # PIL / Pillow
    "PIL",
    "PIL.Image",
    # ffmpeg
    "ffmpeg",
]

for _mod_name in _STUB_MODULES:
    if _mod_name not in sys.modules:
        sys.modules[_mod_name] = MagicMock()

from audio_processor import AudioProcessor
from tests.conftest import make_config, MockConfig, make_sample_metadata


def _make_processor(config_overrides=None):
    """Create an AudioProcessor with all mocked dependencies and a MockConfig.

    Returns (processor, deps_dict) where deps_dict holds all the mocks keyed
    by the same names used as AudioProcessor.__init__ parameters.
    """
    config = MockConfig(config_overrides)
    deps = {
        "config": config,
        "metadata_handler": MagicMock(),
        "script_manager": MagicMock(),
        "transcriber": MagicMock(),
        "title_cleaner": MagicMock(),
        "playlist_manager": MagicMock(),
        "file_manager": MagicMock(),
    }
    proc = AudioProcessor(**deps)
    return proc, deps


class TestRenameFile(unittest.TestCase):
    """Tests for AudioProcessor._rename_file."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.proc, self.deps = _make_processor()

    def tearDown(self):
        shutil.rmtree(self.tmpdir)

    # ---- source == target ---------------------------------------------------

    def test_source_equals_target_returns_true(self):
        """When source and target are the same Path, return True immediately."""
        src = Path(self.tmpdir) / "track01.mp3"
        src.touch()
        result = self.proc._rename_file(src, src, "RJ1234567")
        self.assertTrue(result)

    def test_source_equals_target_does_not_call_rename(self):
        """No filesystem rename should happen when source == target."""
        src = Path(self.tmpdir) / "track01.mp3"
        src.touch()
        with patch.object(Path, "rename") as mock_rename:
            self.proc._rename_file(src, src, "RJ1234567")
            mock_rename.assert_not_called()

    # ---- target exists, overwrite disabled ----------------------------------

    def test_target_exists_no_overwrite_returns_false(self):
        """When target already exists and overwrite is disabled, return False."""
        src = Path(self.tmpdir) / "source.mp3"
        tgt = Path(self.tmpdir) / "target.mp3"
        src.touch()
        tgt.touch()
        # Default config has overwrite_existing=False
        result = self.proc._rename_file(src, tgt, "RJ1234567")
        self.assertFalse(result)

    def test_target_exists_no_overwrite_source_preserved(self):
        """Source file must still exist after a skipped rename."""
        src = Path(self.tmpdir) / "source.mp3"
        tgt = Path(self.tmpdir) / "target.mp3"
        src.touch()
        tgt.touch()
        self.proc._rename_file(src, tgt, "RJ1234567")
        self.assertTrue(src.exists())

    # ---- target exists, overwrite enabled -----------------------------------

    def test_target_exists_overwrite_enabled_attempts_rename(self):
        """When overwrite_existing is True and target exists, rename is attempted
        (does not return False early). On Windows Path.rename cannot overwrite,
        so the OSError handler catches it, but the overwrite guard is bypassed."""
        proc, deps = _make_processor({"overwrite_existing": True})
        src = Path(self.tmpdir) / "source.mp3"
        tgt = Path(self.tmpdir) / "target.mp3"
        src.write_text("source_data")
        tgt.write_text("old_target")
        # Patch Path.rename to simulate successful overwrite (POSIX behavior)
        with patch.object(Path, "rename") as mock_rename:
            result = proc._rename_file(src, tgt, "RJ1234567")
        self.assertTrue(result)
        mock_rename.assert_called_once_with(tgt)

    # ---- successful rename --------------------------------------------------

    def test_successful_rename_returns_true(self):
        """A normal successful rename returns True."""
        src = Path(self.tmpdir) / "old.mp3"
        tgt = Path(self.tmpdir) / "new.mp3"
        src.touch()
        result = self.proc._rename_file(src, tgt, "RJ1234567")
        self.assertTrue(result)

    def test_successful_rename_creates_target(self):
        """After a successful rename the target exists."""
        src = Path(self.tmpdir) / "old.mp3"
        tgt = Path(self.tmpdir) / "new.mp3"
        src.touch()
        self.proc._rename_file(src, tgt, "RJ1234567")
        self.assertTrue(tgt.exists())

    def test_successful_rename_removes_source(self):
        """After a successful rename the source no longer exists."""
        src = Path(self.tmpdir) / "old.mp3"
        tgt = Path(self.tmpdir) / "new.mp3"
        src.touch()
        self.proc._rename_file(src, tgt, "RJ1234567")
        self.assertFalse(src.exists())

    # ---- OSError handling ---------------------------------------------------

    def test_oserror_returns_false(self):
        """If Path.rename raises OSError, _rename_file returns False."""
        src = Path(self.tmpdir) / "source.mp3"
        tgt = Path(self.tmpdir) / "target.mp3"
        src.touch()
        with patch.object(Path, "rename", side_effect=OSError("disk full")):
            result = self.proc._rename_file(src, tgt, "RJ1234567")
        self.assertFalse(result)

    def test_oserror_logs_error(self):
        """OSError during rename is logged as an error."""
        src = Path(self.tmpdir) / "source.mp3"
        tgt = Path(self.tmpdir) / "target.mp3"
        src.touch()
        with patch.object(Path, "rename", side_effect=OSError("disk full")):
            with patch.object(self.proc.logger, "error") as mock_log:
                self.proc._rename_file(src, tgt, "RJ1234567")
                mock_log.assert_called_once()
                # Verify the rjcode appears in the logged message args
                logged_args = mock_log.call_args
                self.assertIn("RJ1234567", logged_args[0])


class TestHandleFileRename(unittest.TestCase):
    """Tests for AudioProcessor._handle_file_rename."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmpdir)

    # ---- disabled -----------------------------------------------------------

    def test_disabled_returns_none(self):
        """When enable_file_rename is False, _handle_file_rename returns None."""
        proc, deps = _make_processor()
        audio = Path(self.tmpdir) / "track01.mp3"
        audio.touch()
        result = proc._handle_file_rename(audio, 1, "RJ1234567")
        self.assertIsNone(result)

    def test_disabled_does_not_generate_filename(self):
        """When disabled, _generate_new_filename is never called."""
        proc, deps = _make_processor()
        audio = Path(self.tmpdir) / "track01.mp3"
        audio.touch()
        with patch.object(proc, "_generate_new_filename") as mock_gen:
            proc._handle_file_rename(audio, 1, "RJ1234567")
            mock_gen.assert_not_called()

    # ---- missing source file ------------------------------------------------

    def test_missing_source_returns_none(self):
        """When the source audio file does not exist, return None."""
        proc, deps = _make_processor({
            "features": {
                "enable_file_rename": True,
                "enable_metadata_update": False,
                "enable_cover_art": False,
                "enable_playlist_generation": False,
                "enable_transcription": False,
                "enable_translation": False,
                "enable_folder_rename": False,
                "enable_folder_icon": False,
                "enable_script_import": False,
            }
        })
        # title_cleaner mock needs to not fail when _generate_new_filename calls it
        deps["title_cleaner"].clean.return_value = "cleaned_title"
        deps["file_manager"].translate_content.return_value = {}
        deps["file_manager"].sanitize_filename.return_value = "cleaned_title"

        nonexistent = Path(self.tmpdir) / "ghost.mp3"
        result = proc._handle_file_rename(nonexistent, 1, "RJ1234567")
        self.assertIsNone(result)

    def test_missing_source_logs_error(self):
        """Missing source file is logged as an error."""
        proc, deps = _make_processor({
            "features": {
                "enable_file_rename": True,
                "enable_metadata_update": False,
                "enable_cover_art": False,
                "enable_playlist_generation": False,
                "enable_transcription": False,
                "enable_translation": False,
                "enable_folder_rename": False,
                "enable_folder_icon": False,
                "enable_script_import": False,
            }
        })
        deps["title_cleaner"].clean.return_value = "cleaned"
        deps["file_manager"].translate_content.return_value = {}
        deps["file_manager"].sanitize_filename.return_value = "cleaned"

        nonexistent = Path(self.tmpdir) / "ghost.mp3"
        with patch.object(proc.logger, "error") as mock_log:
            proc._handle_file_rename(nonexistent, 1, "RJ1234567")
            mock_log.assert_called_once()

    # ---- successful rename --------------------------------------------------

    def test_successful_rename_returns_new_path(self):
        """When rename succeeds, _handle_file_rename returns the new Path."""
        proc, deps = _make_processor({
            "features": {
                "enable_file_rename": True,
                "enable_metadata_update": False,
                "enable_cover_art": False,
                "enable_playlist_generation": False,
                "enable_transcription": False,
                "enable_translation": False,
                "enable_folder_rename": False,
                "enable_folder_icon": False,
                "enable_script_import": False,
            }
        })
        deps["title_cleaner"].clean.return_value = "new_title"
        deps["file_manager"].translate_content.return_value = {}
        deps["file_manager"].sanitize_filename.return_value = "new_title"

        audio = Path(self.tmpdir) / "old_name.mp3"
        audio.touch()
        result = proc._handle_file_rename(audio, 1, "RJ1234567")
        expected = audio.parent / "new_title.mp3"
        self.assertEqual(result, expected)
        self.assertTrue(expected.exists())

    def test_successful_rename_preserves_suffix(self):
        """The renamed file keeps the original file extension."""
        proc, deps = _make_processor({
            "features": {
                "enable_file_rename": True,
                "enable_metadata_update": False,
                "enable_cover_art": False,
                "enable_playlist_generation": False,
                "enable_transcription": False,
                "enable_translation": False,
                "enable_folder_rename": False,
                "enable_folder_icon": False,
                "enable_script_import": False,
            }
        })
        deps["title_cleaner"].clean.return_value = "track"
        deps["file_manager"].translate_content.return_value = {}
        deps["file_manager"].sanitize_filename.return_value = "track"

        audio = Path(self.tmpdir) / "original.flac"
        audio.touch()
        result = proc._handle_file_rename(audio, 1, "RJ1234567")
        self.assertEqual(result.suffix, ".flac")

    def test_rename_failure_returns_none(self):
        """When the underlying _rename_file fails, return None."""
        proc, deps = _make_processor({
            "features": {
                "enable_file_rename": True,
                "enable_metadata_update": False,
                "enable_cover_art": False,
                "enable_playlist_generation": False,
                "enable_transcription": False,
                "enable_translation": False,
                "enable_folder_rename": False,
                "enable_folder_icon": False,
                "enable_script_import": False,
            }
        })
        deps["title_cleaner"].clean.return_value = "new"
        deps["file_manager"].translate_content.return_value = {}
        deps["file_manager"].sanitize_filename.return_value = "new"

        audio = Path(self.tmpdir) / "old.mp3"
        audio.touch()
        with patch.object(proc, "_rename_file", return_value=False):
            result = proc._handle_file_rename(audio, 1, "RJ1234567")
        self.assertIsNone(result)


class TestHandleTranscription(unittest.TestCase):
    """Tests for AudioProcessor._handle_transcription."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.folder_path = Path(self.tmpdir)

    def tearDown(self):
        shutil.rmtree(self.tmpdir)

    # ---- disabled -----------------------------------------------------------

    def test_disabled_does_nothing(self):
        """When enable_transcription is False, transcriber is never called."""
        proc, deps = _make_processor()
        audio = Path(self.tmpdir) / "track01.mp3"
        audio.touch()
        proc._handle_transcription(audio, "RJ1234567", 1, self.folder_path)
        deps["transcriber"].transcribe_file.assert_not_called()

    def test_disabled_does_not_save(self):
        """When disabled, script_manager.save_transcription is never called."""
        proc, deps = _make_processor()
        audio = Path(self.tmpdir) / "track01.mp3"
        audio.touch()
        proc._handle_transcription(audio, "RJ1234567", 1, self.folder_path)
        deps["script_manager"].save_transcription.assert_not_called()

    # ---- existing transcripts -----------------------------------------------

    def test_existing_transcripts_skipped(self):
        """If both .txt and .lrc exist in scripts/ja/, transcription is skipped."""
        proc, deps = _make_processor({
            "features": {
                "enable_transcription": True,
                "enable_file_rename": False,
                "enable_metadata_update": False,
                "enable_cover_art": False,
                "enable_playlist_generation": False,
                "enable_translation": False,
                "enable_folder_rename": False,
                "enable_folder_icon": False,
                "enable_script_import": False,
            }
        })
        audio = Path(self.tmpdir) / "track01.mp3"
        audio.touch()

        # Create the scripts/ja directory with both transcript files
        scripts_dir = self.folder_path / "scripts" / "ja"
        scripts_dir.mkdir(parents=True, exist_ok=True)
        (scripts_dir / "track01.txt").write_text("transcript text")
        (scripts_dir / "track01.lrc").write_text("[00:00.00] lyric")

        proc._handle_transcription(audio, "RJ1234567", 1, self.folder_path)
        deps["transcriber"].transcribe_file.assert_not_called()

    def test_only_txt_exists_still_transcribes(self):
        """If only .txt exists (no .lrc), transcription is still performed."""
        proc, deps = _make_processor({
            "features": {
                "enable_transcription": True,
                "enable_file_rename": False,
                "enable_metadata_update": False,
                "enable_cover_art": False,
                "enable_playlist_generation": False,
                "enable_translation": False,
                "enable_folder_rename": False,
                "enable_folder_icon": False,
                "enable_script_import": False,
            }
        })
        deps["transcriber"].transcribe_file.return_value = {"text": "hello"}

        audio = Path(self.tmpdir) / "track01.mp3"
        audio.touch()

        scripts_dir = self.folder_path / "scripts" / "ja"
        scripts_dir.mkdir(parents=True, exist_ok=True)
        (scripts_dir / "track01.txt").write_text("text only")
        # No .lrc file

        proc._handle_transcription(audio, "RJ1234567", 1, self.folder_path)
        deps["transcriber"].transcribe_file.assert_called_once()

    def test_only_lrc_exists_still_transcribes(self):
        """If only .lrc exists (no .txt), transcription is still performed."""
        proc, deps = _make_processor({
            "features": {
                "enable_transcription": True,
                "enable_file_rename": False,
                "enable_metadata_update": False,
                "enable_cover_art": False,
                "enable_playlist_generation": False,
                "enable_translation": False,
                "enable_folder_rename": False,
                "enable_folder_icon": False,
                "enable_script_import": False,
            }
        })
        deps["transcriber"].transcribe_file.return_value = {"text": "hello"}

        audio = Path(self.tmpdir) / "track01.mp3"
        audio.touch()

        scripts_dir = self.folder_path / "scripts" / "ja"
        scripts_dir.mkdir(parents=True, exist_ok=True)
        (scripts_dir / "track01.lrc").write_text("[00:00.00] lrc only")
        # No .txt file

        proc._handle_transcription(audio, "RJ1234567", 1, self.folder_path)
        deps["transcriber"].transcribe_file.assert_called_once()

    # ---- transcription called when needed -----------------------------------

    def test_transcription_called_when_no_transcripts(self):
        """Transcription is called when no transcript files exist."""
        proc, deps = _make_processor({
            "features": {
                "enable_transcription": True,
                "enable_file_rename": False,
                "enable_metadata_update": False,
                "enable_cover_art": False,
                "enable_playlist_generation": False,
                "enable_translation": False,
                "enable_folder_rename": False,
                "enable_folder_icon": False,
                "enable_script_import": False,
            }
        })
        deps["transcriber"].transcribe_file.return_value = {"segments": []}

        audio = Path(self.tmpdir) / "track01.mp3"
        audio.touch()

        proc._handle_transcription(audio, "RJ1234567", 1, self.folder_path)
        deps["transcriber"].transcribe_file.assert_called_once_with(
            str(audio), "RJ1234567"
        )

    def test_transcription_result_saved(self):
        """When transcription returns data, save_transcription is called."""
        proc, deps = _make_processor({
            "features": {
                "enable_transcription": True,
                "enable_file_rename": False,
                "enable_metadata_update": False,
                "enable_cover_art": False,
                "enable_playlist_generation": False,
                "enable_translation": False,
                "enable_folder_rename": False,
                "enable_folder_icon": False,
                "enable_script_import": False,
            }
        })
        transcription_data = {"segments": [{"start": 0, "text": "hello"}]}
        deps["transcriber"].transcribe_file.return_value = transcription_data

        audio = Path(self.tmpdir) / "track01.mp3"
        audio.touch()

        proc._handle_transcription(audio, "RJ1234567", 5, self.folder_path)
        deps["script_manager"].save_transcription.assert_called_once_with(
            transcription_data, "RJ1234567", 5, self.folder_path
        )

    def test_empty_transcription_not_saved(self):
        """When transcription returns None/empty, save_transcription is NOT called."""
        proc, deps = _make_processor({
            "features": {
                "enable_transcription": True,
                "enable_file_rename": False,
                "enable_metadata_update": False,
                "enable_cover_art": False,
                "enable_playlist_generation": False,
                "enable_translation": False,
                "enable_folder_rename": False,
                "enable_folder_icon": False,
                "enable_script_import": False,
            }
        })
        deps["transcriber"].transcribe_file.return_value = None

        audio = Path(self.tmpdir) / "track01.mp3"
        audio.touch()

        proc._handle_transcription(audio, "RJ1234567", 1, self.folder_path)
        deps["script_manager"].save_transcription.assert_not_called()

    def test_no_scripts_dir_still_transcribes(self):
        """Even if scripts/ja directory does not exist, transcription proceeds."""
        proc, deps = _make_processor({
            "features": {
                "enable_transcription": True,
                "enable_file_rename": False,
                "enable_metadata_update": False,
                "enable_cover_art": False,
                "enable_playlist_generation": False,
                "enable_translation": False,
                "enable_folder_rename": False,
                "enable_folder_icon": False,
                "enable_script_import": False,
            }
        })
        deps["transcriber"].transcribe_file.return_value = {"text": "data"}

        audio = Path(self.tmpdir) / "track01.mp3"
        audio.touch()
        # No scripts/ja directory exists

        proc._handle_transcription(audio, "RJ1234567", 1, self.folder_path)
        deps["transcriber"].transcribe_file.assert_called_once()


class TestUpdateMetadata(unittest.TestCase):
    """Tests for AudioProcessor._update_metadata."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmpdir)

    # ---- disabled -----------------------------------------------------------

    def test_disabled_returns_empty_dict(self):
        """When enable_metadata_update is False, _update_metadata returns {}."""
        proc, deps = _make_processor()
        audio = Path(self.tmpdir) / "track01.mp3"
        metadata = make_sample_metadata()
        result = proc._update_metadata(audio, "RJ1234567", metadata, 1, None, 0)
        self.assertEqual(result, {})

    def test_disabled_does_not_call_handler(self):
        """When disabled, metadata_handler.update_metadata is not called."""
        proc, deps = _make_processor()
        audio = Path(self.tmpdir) / "track01.mp3"
        metadata = make_sample_metadata()
        proc._update_metadata(audio, "RJ1234567", metadata, 1, None, 0)
        deps["metadata_handler"].update_metadata.assert_not_called()

    # ---- enabled with no lyrics ---------------------------------------------

    def test_enabled_no_lyrics_calls_handler(self):
        """When enabled with no lyrics, metadata_handler is called with base metadata."""
        proc, deps = _make_processor({
            "features": {
                "enable_metadata_update": True,
                "enable_file_rename": False,
                "enable_cover_art": False,
                "enable_playlist_generation": False,
                "enable_transcription": False,
                "enable_translation": False,
                "enable_folder_rename": False,
                "enable_folder_icon": False,
                "enable_script_import": False,
            }
        })
        deps["metadata_handler"].update_metadata.return_value = {"status": "ok"}

        audio = Path(self.tmpdir) / "track01.mp3"
        metadata = {"rjcode": "RJ1234567", "work_name": "Test"}
        result = proc._update_metadata(audio, "RJ1234567", metadata, 1, None, 0)

        deps["metadata_handler"].update_metadata.assert_called_once()
        call_args = deps["metadata_handler"].update_metadata.call_args
        self.assertEqual(call_args[0][0], str(audio))
        self.assertEqual(call_args[0][2], 1)   # track_num
        self.assertIsNone(call_args[0][3])      # disk_num

    def test_enabled_none_lyrics_treated_as_empty(self):
        """Passing lyrics_data=None is equivalent to an empty dict."""
        proc, deps = _make_processor({
            "features": {
                "enable_metadata_update": True,
                "enable_file_rename": False,
                "enable_cover_art": False,
                "enable_playlist_generation": False,
                "enable_transcription": False,
                "enable_translation": False,
                "enable_folder_rename": False,
                "enable_folder_icon": False,
                "enable_script_import": False,
            }
        })
        deps["metadata_handler"].update_metadata.return_value = {}

        audio = Path(self.tmpdir) / "track.mp3"
        metadata = {"rjcode": "RJ1234567"}
        proc._update_metadata(audio, "RJ1234567", metadata, 1, None, 0, None)

        call_args = deps["metadata_handler"].update_metadata.call_args
        combined = call_args[0][1]
        # Original metadata keys should be present, no lyrics keys
        self.assertIn("rjcode", combined)

    # ---- merges lyrics data correctly ---------------------------------------

    def test_lyrics_merged_into_metadata(self):
        """Lyrics data for the correct track_idx is merged into combined metadata."""
        proc, deps = _make_processor({
            "features": {
                "enable_metadata_update": True,
                "enable_file_rename": False,
                "enable_cover_art": False,
                "enable_playlist_generation": False,
                "enable_transcription": False,
                "enable_translation": False,
                "enable_folder_rename": False,
                "enable_folder_icon": False,
                "enable_script_import": False,
            }
        })
        deps["metadata_handler"].update_metadata.return_value = {}

        audio = Path(self.tmpdir) / "track.mp3"
        metadata = {"rjcode": "RJ1234567", "work_name": "Test"}
        lyrics_data = {
            0: {
                "USLT::eng": "English lyrics line",
                "SYLT::jpn": b"synced data",
                "lyrics": "plain text lyrics",
            },
            1: {
                "USLT::eng": "Wrong track lyrics",
            },
        }
        proc._update_metadata(
            audio, "RJ1234567", metadata, 1, None, 0, lyrics_data
        )

        call_args = deps["metadata_handler"].update_metadata.call_args
        combined = call_args[0][1]
        # track_idx=0 lyrics should be merged
        self.assertEqual(combined["USLT::eng"], "English lyrics line")
        self.assertEqual(combined["SYLT::jpn"], b"synced data")
        self.assertEqual(combined["lyrics"], "plain text lyrics")
        # track_idx=1 lyrics should NOT be present
        self.assertNotEqual(combined.get("USLT::eng"), "Wrong track lyrics")

    def test_lyrics_do_not_overwrite_non_lyrics_metadata(self):
        """Non-lyrics keys from lyrics_data dict are not merged into metadata."""
        proc, deps = _make_processor({
            "features": {
                "enable_metadata_update": True,
                "enable_file_rename": False,
                "enable_cover_art": False,
                "enable_playlist_generation": False,
                "enable_transcription": False,
                "enable_translation": False,
                "enable_folder_rename": False,
                "enable_folder_icon": False,
                "enable_script_import": False,
            }
        })
        deps["metadata_handler"].update_metadata.return_value = {}

        audio = Path(self.tmpdir) / "track.mp3"
        metadata = {"rjcode": "RJ1234567", "work_name": "Original"}
        lyrics_data = {
            0: {
                "work_name": "SHOULD NOT OVERWRITE",
                "random_key": "ignored",
                "USLT::eng": "real lyrics",
            },
        }
        proc._update_metadata(
            audio, "RJ1234567", metadata, 1, None, 0, lyrics_data
        )

        call_args = deps["metadata_handler"].update_metadata.call_args
        combined = call_args[0][1]
        # work_name should stay original since "work_name" doesn't start with
        # USLT::, SYLT::, SYLT_SYNC::, or lyrics
        self.assertEqual(combined["work_name"], "Original")
        self.assertNotIn("random_key", combined)
        self.assertEqual(combined["USLT::eng"], "real lyrics")

    def test_lyrics_with_sylt_sync_prefix_merged(self):
        """Keys starting with 'SYLT_SYNC::' are also merged."""
        proc, deps = _make_processor({
            "features": {
                "enable_metadata_update": True,
                "enable_file_rename": False,
                "enable_cover_art": False,
                "enable_playlist_generation": False,
                "enable_transcription": False,
                "enable_translation": False,
                "enable_folder_rename": False,
                "enable_folder_icon": False,
                "enable_script_import": False,
            }
        })
        deps["metadata_handler"].update_metadata.return_value = {}

        audio = Path(self.tmpdir) / "track.mp3"
        metadata = {"rjcode": "RJ1234567"}
        lyrics_data = {
            0: {
                "SYLT_SYNC::jpn": [(100, "synced")],
            },
        }
        proc._update_metadata(
            audio, "RJ1234567", metadata, 1, None, 0, lyrics_data
        )

        call_args = deps["metadata_handler"].update_metadata.call_args
        combined = call_args[0][1]
        self.assertIn("SYLT_SYNC::jpn", combined)

    def test_disk_num_passed_to_handler(self):
        """disk_num is correctly forwarded to metadata_handler.update_metadata."""
        proc, deps = _make_processor({
            "features": {
                "enable_metadata_update": True,
                "enable_file_rename": False,
                "enable_cover_art": False,
                "enable_playlist_generation": False,
                "enable_transcription": False,
                "enable_translation": False,
                "enable_folder_rename": False,
                "enable_folder_icon": False,
                "enable_script_import": False,
            }
        })
        deps["metadata_handler"].update_metadata.return_value = {}

        audio = Path(self.tmpdir) / "track.mp3"
        metadata = {"rjcode": "RJ1234567"}
        proc._update_metadata(audio, "RJ1234567", metadata, 3, 2, 0)

        call_args = deps["metadata_handler"].update_metadata.call_args
        self.assertEqual(call_args[0][2], 3)  # track_num
        self.assertEqual(call_args[0][3], 2)  # disk_num

    def test_empty_lyrics_for_track_idx(self):
        """When lyrics_data has no entry for the given track_idx, no lyrics merged."""
        proc, deps = _make_processor({
            "features": {
                "enable_metadata_update": True,
                "enable_file_rename": False,
                "enable_cover_art": False,
                "enable_playlist_generation": False,
                "enable_transcription": False,
                "enable_translation": False,
                "enable_folder_rename": False,
                "enable_folder_icon": False,
                "enable_script_import": False,
            }
        })
        deps["metadata_handler"].update_metadata.return_value = {}

        audio = Path(self.tmpdir) / "track.mp3"
        metadata = {"rjcode": "RJ1234567"}
        lyrics_data = {
            5: {"USLT::eng": "lyrics for track 5"},
        }
        # track_idx=0, so lyrics_data[5] should not appear
        proc._update_metadata(
            audio, "RJ1234567", metadata, 1, None, 0, lyrics_data
        )

        call_args = deps["metadata_handler"].update_metadata.call_args
        combined = call_args[0][1]
        self.assertNotIn("USLT::eng", combined)


class TestUpdatePlaylists(unittest.TestCase):
    """Tests for AudioProcessor._update_playlists."""

    def test_enabled_calls_playlist_manager(self):
        """When enable_playlist_generation is True, playlist_manager is called."""
        proc, deps = _make_processor({
            "features": {
                "enable_playlist_generation": True,
                "enable_file_rename": False,
                "enable_metadata_update": False,
                "enable_cover_art": False,
                "enable_transcription": False,
                "enable_translation": False,
                "enable_folder_rename": False,
                "enable_folder_icon": False,
                "enable_script_import": False,
            }
        })
        audio = Path("C:/test/track.mp3")
        metadata = {"rjcode": "RJ1234567"}
        folder = Path("C:/test")
        proc._update_playlists(audio, metadata, folder)
        deps["playlist_manager"].update_playlists.assert_called_once_with(
            audio, metadata, folder
        )

    def test_disabled_does_not_call_playlist_manager(self):
        """When enable_playlist_generation is False, playlist_manager is not called."""
        proc, deps = _make_processor()
        audio = Path("C:/test/track.mp3")
        metadata = {"rjcode": "RJ1234567"}
        folder = Path("C:/test")
        proc._update_playlists(audio, metadata, folder)
        deps["playlist_manager"].update_playlists.assert_not_called()


class TestGenerateNewFilename(unittest.TestCase):
    """Tests for AudioProcessor._generate_new_filename."""

    def test_basic_filename_generation(self):
        """Generates a filename using title_cleaner + sanitize without translation."""
        proc, deps = _make_processor()
        deps["title_cleaner"].clean.return_value = "01 Track Title"
        deps["file_manager"].sanitize_filename.return_value = "01 Track Title"

        audio = Path("C:/music/original_name.mp3")
        result = proc._generate_new_filename(audio, 1, "RJ1234567")
        self.assertEqual(result, "01 Track Title.mp3")

    def test_preserves_file_extension(self):
        """The original file extension is preserved."""
        proc, deps = _make_processor()
        deps["title_cleaner"].clean.return_value = "cleaned"
        deps["file_manager"].sanitize_filename.return_value = "cleaned"

        audio = Path("C:/music/track.flac")
        result = proc._generate_new_filename(audio, 1, "RJ1234567")
        self.assertEqual(result, "cleaned.flac")

    def test_translation_enabled(self):
        """When enable_translation is True, translate_content is called."""
        proc, deps = _make_processor({
            "features": {
                "enable_translation": True,
                "enable_file_rename": False,
                "enable_metadata_update": False,
                "enable_cover_art": False,
                "enable_playlist_generation": False,
                "enable_transcription": False,
                "enable_folder_rename": False,
                "enable_folder_icon": False,
                "enable_script_import": False,
            }
        })
        deps["title_cleaner"].clean.return_value = "Japanese Title"
        deps["file_manager"].translate_content.return_value = {
            "Japanese Title": "English Title"
        }
        deps["file_manager"].sanitize_filename.return_value = "English Title"

        audio = Path("C:/music/original.mp3")
        result = proc._generate_new_filename(audio, 1, "RJ1234567")
        self.assertEqual(result, "English Title.mp3")
        deps["file_manager"].translate_content.assert_called_once_with(
            ["Japanese Title"], "RJ1234567"
        )

    def test_translation_returns_no_match_uses_original(self):
        """When translate_content returns empty dict, the cleaned title is kept."""
        proc, deps = _make_processor({
            "features": {
                "enable_translation": True,
                "enable_file_rename": False,
                "enable_metadata_update": False,
                "enable_cover_art": False,
                "enable_playlist_generation": False,
                "enable_transcription": False,
                "enable_folder_rename": False,
                "enable_folder_icon": False,
                "enable_script_import": False,
            }
        })
        deps["title_cleaner"].clean.return_value = "Original"
        deps["file_manager"].translate_content.return_value = {}
        deps["file_manager"].sanitize_filename.return_value = "Original"

        audio = Path("C:/music/track.mp3")
        result = proc._generate_new_filename(audio, 1, "RJ1234567")
        self.assertEqual(result, "Original.mp3")

    def test_translation_disabled_no_translate_call(self):
        """When enable_translation is False, translate_content is not called."""
        proc, deps = _make_processor()
        deps["title_cleaner"].clean.return_value = "Cleaned"
        deps["file_manager"].sanitize_filename.return_value = "Cleaned"

        audio = Path("C:/music/track.mp3")
        proc._generate_new_filename(audio, 1, "RJ1234567")
        deps["file_manager"].translate_content.assert_not_called()


class TestProcessFile(unittest.TestCase):
    """Integration-level tests for AudioProcessor.process_file with all mocked deps."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.folder_path = Path(self.tmpdir)

    def tearDown(self):
        shutil.rmtree(self.tmpdir)

    def _enable_all_features(self):
        """Return config overrides enabling all processing features."""
        return {
            "features": {
                "enable_file_rename": True,
                "enable_metadata_update": True,
                "enable_cover_art": False,
                "enable_playlist_generation": True,
                "enable_transcription": True,
                "enable_translation": False,
                "enable_folder_rename": False,
                "enable_folder_icon": False,
                "enable_script_import": False,
            }
        }

    def test_full_pipeline_all_features_enabled(self):
        """With all features enabled, transcription, rename, metadata, and playlist run."""
        proc, deps = _make_processor(self._enable_all_features())

        # Setup mocks
        deps["title_cleaner"].extract_info.return_value = (1, 3, "title")
        deps["title_cleaner"].clean.return_value = "03 title"
        deps["file_manager"].sanitize_filename.return_value = "03 title"
        deps["file_manager"].translate_content.return_value = {}
        deps["transcriber"].transcribe_file.return_value = {"segments": []}
        deps["script_manager"].get_scripts_as_lyrics.return_value = {}
        deps["metadata_handler"].update_metadata.return_value = {}

        audio = Path(self.tmpdir) / "original.mp3"
        audio.touch()
        metadata = make_sample_metadata()

        proc.process_file(audio, "RJ1234567", self.folder_path, metadata, 0)

        # Transcription should have been called
        deps["transcriber"].transcribe_file.assert_called_once()
        # Scripts as lyrics should have been fetched
        deps["script_manager"].get_scripts_as_lyrics.assert_called_once_with(
            self.folder_path
        )
        # Metadata handler should have been called
        deps["metadata_handler"].update_metadata.assert_called_once()
        # Playlist manager should have been called
        deps["playlist_manager"].update_playlists.assert_called_once()

    def test_all_features_disabled(self):
        """With all features disabled, only extract_info and get_scripts_as_lyrics run."""
        proc, deps = _make_processor()
        deps["title_cleaner"].extract_info.return_value = (None, None, "title")
        deps["script_manager"].get_scripts_as_lyrics.return_value = {}

        audio = Path(self.tmpdir) / "track.mp3"
        audio.touch()
        metadata = make_sample_metadata()

        proc.process_file(audio, "RJ1234567", self.folder_path, metadata, 0)

        deps["transcriber"].transcribe_file.assert_not_called()
        deps["metadata_handler"].update_metadata.assert_not_called()
        deps["playlist_manager"].update_playlists.assert_not_called()

    def test_extract_info_provides_track_num(self):
        """track_num from extract_info is used instead of track_idx."""
        proc, deps = _make_processor(self._enable_all_features())
        deps["title_cleaner"].extract_info.return_value = (2, 5, "Some Title")
        deps["title_cleaner"].clean.return_value = "05 Some Title"
        deps["file_manager"].sanitize_filename.return_value = "05 Some Title"
        deps["file_manager"].translate_content.return_value = {}
        deps["transcriber"].transcribe_file.return_value = None
        deps["script_manager"].get_scripts_as_lyrics.return_value = {}
        deps["metadata_handler"].update_metadata.return_value = {}

        audio = Path(self.tmpdir) / "track.mp3"
        audio.touch()
        metadata = make_sample_metadata()

        proc.process_file(audio, "RJ1234567", self.folder_path, metadata, 99)

        # Transcription should use track_num=5 (from extract_info), not track_idx=99
        transcribe_call = deps["transcriber"].transcribe_file.call_args
        # _handle_transcription receives actual_track
        # We verify metadata update got actual_track=5 and actual_disk=2
        meta_call = deps["metadata_handler"].update_metadata.call_args
        self.assertEqual(meta_call[0][2], 5)  # track_num
        self.assertEqual(meta_call[0][3], 2)  # disk_num

    def test_extract_info_returns_none_uses_track_idx(self):
        """When extract_info returns None for track_num, track_idx is used."""
        proc, deps = _make_processor(self._enable_all_features())
        deps["title_cleaner"].extract_info.return_value = (None, None, "Title")
        deps["title_cleaner"].clean.return_value = "Title"
        deps["file_manager"].sanitize_filename.return_value = "Title"
        deps["file_manager"].translate_content.return_value = {}
        deps["transcriber"].transcribe_file.return_value = None
        deps["script_manager"].get_scripts_as_lyrics.return_value = {}
        deps["metadata_handler"].update_metadata.return_value = {}

        audio = Path(self.tmpdir) / "track.mp3"
        audio.touch()
        metadata = make_sample_metadata()

        proc.process_file(audio, "RJ1234567", self.folder_path, metadata, 7)

        # Metadata should use track_idx=7 and disk_num=None
        meta_call = deps["metadata_handler"].update_metadata.call_args
        self.assertEqual(meta_call[0][2], 7)    # track_num = track_idx
        self.assertIsNone(meta_call[0][3])       # disk_num = None

    def test_exception_in_processing_is_caught(self):
        """Exceptions during processing are caught and logged, not raised."""
        proc, deps = _make_processor(self._enable_all_features())
        deps["title_cleaner"].extract_info.side_effect = ValueError("boom")

        audio = Path(self.tmpdir) / "track.mp3"
        audio.touch()
        metadata = make_sample_metadata()

        # Should NOT raise
        proc.process_file(audio, "RJ1234567", self.folder_path, metadata, 0)

    def test_exception_logged_with_rjcode(self):
        """Exceptions include the rjcode in the log output."""
        proc, deps = _make_processor(self._enable_all_features())
        deps["title_cleaner"].extract_info.side_effect = RuntimeError("test error")

        audio = Path(self.tmpdir) / "track.mp3"
        audio.touch()
        metadata = make_sample_metadata()

        with patch.object(proc.logger, "error") as mock_log:
            proc.process_file(audio, "RJ1234567", self.folder_path, metadata, 0)
            mock_log.assert_called_once()
            logged_args = mock_log.call_args[0]
            self.assertIn("RJ1234567", logged_args)

    def test_rename_result_used_for_metadata(self):
        """When file is renamed, the new path is passed to _update_metadata."""
        proc, deps = _make_processor(self._enable_all_features())
        deps["title_cleaner"].extract_info.return_value = (None, 1, "track")
        deps["title_cleaner"].clean.return_value = "01 track"
        deps["file_manager"].sanitize_filename.return_value = "01 track"
        deps["file_manager"].translate_content.return_value = {}
        deps["transcriber"].transcribe_file.return_value = None
        deps["script_manager"].get_scripts_as_lyrics.return_value = {}
        deps["metadata_handler"].update_metadata.return_value = {}

        audio = Path(self.tmpdir) / "original.mp3"
        audio.touch()
        metadata = make_sample_metadata()

        proc.process_file(audio, "RJ1234567", self.folder_path, metadata, 0)

        # The metadata handler should receive the new renamed path
        meta_call = deps["metadata_handler"].update_metadata.call_args
        new_path_str = meta_call[0][0]
        self.assertIn("01 track.mp3", new_path_str)

    def test_lyrics_data_passed_to_metadata(self):
        """Lyrics data from script_manager is forwarded to _update_metadata."""
        proc, deps = _make_processor(self._enable_all_features())
        deps["title_cleaner"].extract_info.return_value = (None, 1, "track")
        deps["title_cleaner"].clean.return_value = "01 track"
        deps["file_manager"].sanitize_filename.return_value = "01 track"
        deps["file_manager"].translate_content.return_value = {}
        deps["transcriber"].transcribe_file.return_value = None

        lyrics_data = {0: {"USLT::eng": "test lyrics"}}
        deps["script_manager"].get_scripts_as_lyrics.return_value = lyrics_data
        deps["metadata_handler"].update_metadata.return_value = {}

        audio = Path(self.tmpdir) / "track.mp3"
        audio.touch()
        metadata = make_sample_metadata()

        proc.process_file(audio, "RJ1234567", self.folder_path, metadata, 0)

        # Verify lyrics were merged into combined metadata
        meta_call = deps["metadata_handler"].update_metadata.call_args
        combined_meta = meta_call[0][1]
        self.assertEqual(combined_meta.get("USLT::eng"), "test lyrics")

    def test_playlist_uses_renamed_path(self):
        """Playlist update uses the renamed file path, not the original."""
        proc, deps = _make_processor(self._enable_all_features())
        deps["title_cleaner"].extract_info.return_value = (None, 1, "track")
        deps["title_cleaner"].clean.return_value = "renamed"
        deps["file_manager"].sanitize_filename.return_value = "renamed"
        deps["file_manager"].translate_content.return_value = {}
        deps["transcriber"].transcribe_file.return_value = None
        deps["script_manager"].get_scripts_as_lyrics.return_value = {}
        deps["metadata_handler"].update_metadata.return_value = {}

        audio = Path(self.tmpdir) / "original.mp3"
        audio.touch()
        metadata = make_sample_metadata()

        proc.process_file(audio, "RJ1234567", self.folder_path, metadata, 0)

        playlist_call = deps["playlist_manager"].update_playlists.call_args
        playlist_path = playlist_call[0][0]
        self.assertEqual(playlist_path.name, "renamed.mp3")


if __name__ == "__main__":
    unittest.main()
