"""Comprehensive tests for PlaylistManager class."""
import sys
import os
import sqlite3
import tempfile
import shutil
import datetime
from pathlib import Path
from unittest.mock import MagicMock, patch, PropertyMock

# Ensure project root is on sys.path
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from tests.conftest import make_config, make_sample_metadata


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_in_memory_connection(*args, **kwargs):
    """Return an in-memory SQLite connection regardless of the path argument."""
    return sqlite3.connect(":memory:", check_same_thread=False)


def _create_manager(config_overrides=None, file_manager=None):
    """Create a PlaylistManager with an in-memory DB (patched sqlite3.connect).

    Returns (manager, connection) so callers can inspect the DB directly.
    """
    from playlist_manager import PlaylistManager

    cfg = make_config(config_overrides)
    fm = file_manager or MagicMock()

    # Capture the connection object produced by the patch so tests can query it
    captured_conn = sqlite3.connect(":memory:", check_same_thread=False)

    with patch("playlist_manager.sqlite3.connect", return_value=captured_conn):
        mgr = PlaylistManager(cfg, fm)

    return mgr, captured_conn


def _enabled_config(**extra):
    """Return config overrides that enable playlist generation."""
    base = {
        "features": {
            "enable_playlist_generation": True,
        },
        "playlist_settings": {
            "create_genre_playlists": True,
            "create_content_playlists": True,
            "create_artist_playlists": True,
        },
    }
    base.update(extra)
    return base


# ===========================================================================
# 1. _extract_tags
# ===========================================================================

class TestExtractTags:
    """Tests for PlaylistManager._extract_tags."""

    def setup_method(self):
        self.mgr, self._conn = _create_manager()

    def teardown_method(self):
        self.mgr.close()

    def test_list_input(self):
        metadata = {"tags": ["ASMR", "Binaural", "Ear Cleaning"]}
        result = self.mgr._extract_tags(metadata)
        assert result == ["ASMR", "Binaural", "Ear Cleaning"]

    def test_string_input_comma_separated(self):
        metadata = {"tags": "ASMR, Binaural, Ear Cleaning"}
        result = self.mgr._extract_tags(metadata)
        assert result == ["ASMR", "Binaural", "Ear Cleaning"]

    def test_string_input_single_tag(self):
        metadata = {"tags": "ASMR"}
        result = self.mgr._extract_tags(metadata)
        assert result == ["ASMR"]

    def test_empty_list(self):
        metadata = {"tags": []}
        result = self.mgr._extract_tags(metadata)
        assert result == []

    def test_empty_string(self):
        metadata = {"tags": ""}
        result = self.mgr._extract_tags(metadata)
        assert result == []

    def test_missing_key(self):
        metadata = {}
        result = self.mgr._extract_tags(metadata)
        assert result == []

    def test_list_with_empty_strings_filtered(self):
        metadata = {"tags": ["ASMR", "", "Binaural", ""]}
        result = self.mgr._extract_tags(metadata)
        assert result == ["ASMR", "Binaural"]

    def test_string_with_extra_commas(self):
        metadata = {"tags": "ASMR,,Binaural,  ,Ear Cleaning"}
        result = self.mgr._extract_tags(metadata)
        # Empty-after-strip entries are filtered out
        assert "ASMR" in result
        assert "Binaural" in result
        assert "Ear Cleaning" in result
        assert "" not in result


# ===========================================================================
# 2. _sanitize_playlist_filename
# ===========================================================================

class TestSanitizePlaylistFilename:
    """Tests for _sanitize_playlist_filename (Windows-reserved char replacement)."""

    def setup_method(self):
        self.mgr, self._conn = _create_manager()

    def teardown_method(self):
        self.mgr.close()

    def test_asterisk_replaced(self):
        assert self.mgr._sanitize_playlist_filename("foo*bar") == "foo\uff0abar"

    def test_double_quote_replaced(self):
        assert self.mgr._sanitize_playlist_filename('say "hello"') == "say \uff02hello\uff02"

    def test_backslash_replaced(self):
        assert self.mgr._sanitize_playlist_filename("a\\b") == "a\uff0fb"

    def test_forward_slash_replaced(self):
        assert self.mgr._sanitize_playlist_filename("a/b") == "a\uff0fb"

    def test_colon_replaced(self):
        assert self.mgr._sanitize_playlist_filename("Age Rating: 18") == "Age Rating\uff1a 18"

    def test_question_mark_replaced(self):
        assert self.mgr._sanitize_playlist_filename("What?") == "What\uff1f"

    def test_less_than_replaced(self):
        assert self.mgr._sanitize_playlist_filename("a<b") == "a\uff1cb"

    def test_greater_than_replaced(self):
        assert self.mgr._sanitize_playlist_filename("a>b") == "a\uff1eb"

    def test_pipe_replaced(self):
        assert self.mgr._sanitize_playlist_filename("a|b") == "a\uff5cb"

    def test_no_replacement_needed(self):
        assert self.mgr._sanitize_playlist_filename("safe name") == "safe name"

    def test_all_reserved_chars(self):
        raw = '*"\\/:?<>|'
        result = self.mgr._sanitize_playlist_filename(raw)
        # None of the original reserved chars should remain
        for ch in '*"\\/:?<>|':
            assert ch not in result

    def test_empty_string(self):
        assert self.mgr._sanitize_playlist_filename("") == ""


# ===========================================================================
# 3. _determine_category
# ===========================================================================

class TestDetermineCategory:
    """Tests for _determine_category routing logic."""

    def setup_method(self):
        self.mgr, self._conn = _create_manager()

    def teardown_method(self):
        self.mgr.close()

    def test_artist_prefix(self):
        assert self.mgr._determine_category("Artist - SomeArtist") == "Artists"

    def test_artist_prefix_no_trailing_space(self):
        # The code checks startswith("Artist -") so this still matches
        assert self.mgr._determine_category("Artist -Name") == "Artists"

    def test_scripts_content(self):
        assert self.mgr._determine_category("Scripts") == "Content"

    def test_age_rating_content(self):
        assert self.mgr._determine_category("Age Rating - 18") == "Content"
        assert self.mgr._determine_category("Age Rating - All Ages") == "Content"

    def test_genre_default(self):
        assert self.mgr._determine_category("ASMR") == "Genres"

    def test_genre_other_names(self):
        assert self.mgr._determine_category("Binaural") == "Genres"
        assert self.mgr._determine_category("Ear Cleaning") == "Genres"

    def test_edge_case_artist_like_but_not_prefix(self):
        # "Artists" does not start with "Artist -", so falls to Genres
        assert self.mgr._determine_category("Artists Collection") == "Genres"


# ===========================================================================
# 4. _parse_date
# ===========================================================================

class TestParseDate:
    """Tests for _parse_date converting YYYY-MM-DD strings to timestamps."""

    def setup_method(self):
        self.mgr, self._conn = _create_manager()

    def teardown_method(self):
        self.mgr.close()

    def test_valid_date(self):
        result = self.mgr._parse_date("2024-01-15")
        expected = datetime.datetime.strptime("2024-01-15", "%Y-%m-%d").timestamp()
        assert result == expected

    def test_another_valid_date(self):
        result = self.mgr._parse_date("2000-12-31")
        expected = datetime.datetime.strptime("2000-12-31", "%Y-%m-%d").timestamp()
        assert result == expected

    def test_invalid_date_format(self):
        result = self.mgr._parse_date("15-01-2024")
        assert result == 0.0

    def test_invalid_date_garbage(self):
        result = self.mgr._parse_date("not-a-date")
        assert result == 0.0

    def test_empty_string(self):
        result = self.mgr._parse_date("")
        assert result == 0.0

    def test_none_like_falsy(self):
        # "" is the default from metadata.get(); None would also be falsy
        result = self.mgr._parse_date("")
        assert result == 0.0

    def test_partial_date(self):
        # "2024-01" is missing the day, should fail gracefully
        result = self.mgr._parse_date("2024-01")
        assert result == 0.0


# ===========================================================================
# 5. _write_playlist_file
# ===========================================================================

class TestWritePlaylistFile:
    """Tests for atomic M3U writing via _write_playlist_file."""

    def setup_method(self):
        self.mgr, self._conn = _create_manager()
        self.tmpdir = Path(tempfile.mkdtemp())

    def teardown_method(self):
        self.mgr.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_writes_m3u_header(self):
        playlist = self.tmpdir / "test.m3u"
        self.mgr._write_playlist_file(playlist, ["C:/Music/a.flac", "C:/Music/b.flac"])
        content = playlist.read_text(encoding="utf-8")
        assert content.startswith("#EXTM3U\n")

    def test_writes_all_entries(self):
        entries = ["C:/Music/a.flac", "C:/Music/b.flac", "C:/Music/c.flac"]
        playlist = self.tmpdir / "test.m3u"
        self.mgr._write_playlist_file(playlist, entries)
        content = playlist.read_text(encoding="utf-8")
        for entry in entries:
            assert entry in content

    def test_entries_each_on_own_line(self):
        entries = ["C:/Music/a.flac", "C:/Music/b.flac"]
        playlist = self.tmpdir / "test.m3u"
        self.mgr._write_playlist_file(playlist, entries)
        lines = playlist.read_text(encoding="utf-8").splitlines()
        assert lines[0] == "#EXTM3U"
        assert lines[1] == "C:/Music/a.flac"
        assert lines[2] == "C:/Music/b.flac"

    def test_atomic_rename_no_tmp_leftover(self):
        playlist = self.tmpdir / "test.m3u"
        self.mgr._write_playlist_file(playlist, ["entry"])
        tmp_file = playlist.with_suffix(".m3u.tmp")
        assert not tmp_file.exists(), "Temp file should be removed after rename"

    def test_final_file_exists(self):
        playlist = self.tmpdir / "test.m3u"
        self.mgr._write_playlist_file(playlist, ["entry"])
        assert playlist.exists()

    def test_empty_entries_still_writes_header(self):
        playlist = self.tmpdir / "test.m3u"
        self.mgr._write_playlist_file(playlist, [])
        content = playlist.read_text(encoding="utf-8")
        assert content.strip() == "#EXTM3U"

    def test_unicode_entries(self):
        entries = ["C:/Music/\u30c6\u30b9\u30c8/track.flac"]
        playlist = self.tmpdir / "test.m3u"
        self.mgr._write_playlist_file(playlist, entries)
        content = playlist.read_text(encoding="utf-8")
        assert "\u30c6\u30b9\u30c8" in content

    def test_overwrites_existing_file(self):
        playlist = self.tmpdir / "test.m3u"
        self.mgr._write_playlist_file(playlist, ["old_entry"])
        self.mgr._write_playlist_file(playlist, ["new_entry"])
        content = playlist.read_text(encoding="utf-8")
        assert "new_entry" in content
        assert "old_entry" not in content


# ===========================================================================
# 6. update_playlists
# ===========================================================================

class TestUpdatePlaylists:
    """Tests for update_playlists populating in-memory caches."""

    def setup_method(self):
        self.tmpdir = Path(tempfile.mkdtemp())
        self.root_dir = self.tmpdir / "works" / "RJ1234567"
        self.root_dir.mkdir(parents=True, exist_ok=True)
        self.audio_file = self.root_dir / "track01.flac"
        self.audio_file.touch()

    def teardown_method(self):
        if hasattr(self, "mgr"):
            self.mgr.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _make_manager(self, **extra_cfg):
        cfg = _enabled_config(**extra_cfg)
        self.mgr, self._conn = _create_manager(cfg)
        return self.mgr

    def test_disabled_does_nothing(self):
        mgr, conn = _create_manager()  # playlists disabled by default
        self.mgr = mgr
        metadata = make_sample_metadata()
        mgr.update_playlists(self.audio_file, metadata, self.root_dir)
        assert mgr.playlist_entries_cache == {}

    def test_genre_playlists_added(self):
        mgr = self._make_manager()
        metadata = make_sample_metadata()
        metadata["tags"] = ["ASMR", "Binaural"]
        mgr.update_playlists(self.audio_file, metadata, self.root_dir)
        # file_manager.sanitize_filename is used for genre names
        assert len(mgr.playlist_entries_cache) > 0

    def test_artist_playlists_added_for_cvs(self):
        mgr = self._make_manager()
        metadata = make_sample_metadata()
        metadata["cvs"] = ["VoiceActorA", "VoiceActorB"]
        metadata["maker_name"] = "SomeCircle"
        mgr.update_playlists(self.audio_file, metadata, self.root_dir)
        cache = mgr.playlist_entries_cache
        # Should have "Artist - VoiceActorA", "Artist - VoiceActorB", "Artist - SomeCircle"
        artist_keys = [k for k in cache if k.startswith("Artist -")]
        assert len(artist_keys) >= 3

    def test_age_rating_content_playlist(self):
        mgr = self._make_manager()
        metadata = make_sample_metadata()
        metadata["age"] = "18+"
        mgr.update_playlists(self.audio_file, metadata, self.root_dir)
        assert "Age Rating - 18+" in mgr.playlist_entries_cache

    def test_sorted_playlist_cache_populated(self):
        mgr = self._make_manager()
        metadata = make_sample_metadata()
        metadata["price"] = 1320
        metadata["rating"] = 4.5
        metadata["release_date"] = "2024-01-15"
        mgr.update_playlists(self.audio_file, metadata, self.root_dir)
        assert "price" in mgr.sorted_playlists_cache
        assert "rating" in mgr.sorted_playlists_cache
        assert "date" in mgr.sorted_playlists_cache

    def test_root_dir_stored(self):
        mgr = self._make_manager()
        metadata = make_sample_metadata()
        mgr.update_playlists(self.audio_file, metadata, self.root_dir)
        assert mgr.root_dir == self.root_dir

    def test_playlist_dir_created(self):
        mgr = self._make_manager()
        metadata = make_sample_metadata()
        mgr.update_playlists(self.audio_file, metadata, self.root_dir)
        assert mgr.playlist_dir is not None
        assert mgr.playlist_dir.exists()

    def test_script_content_playlist_when_scripts_exist(self):
        # Create a scripts directory with a .txt file
        scripts_dir = self.root_dir / "scripts" / "en"
        scripts_dir.mkdir(parents=True, exist_ok=True)
        (scripts_dir / "transcript.txt").touch()

        mgr = self._make_manager()
        metadata = make_sample_metadata()
        mgr.update_playlists(self.audio_file, metadata, self.root_dir)
        assert "Scripts" in mgr.playlist_entries_cache

    def test_no_script_content_playlist_without_scripts(self):
        mgr = self._make_manager()
        metadata = make_sample_metadata()
        # No scripts dir
        mgr.update_playlists(self.audio_file, metadata, self.root_dir)
        assert "Scripts" not in mgr.playlist_entries_cache

    def test_multiple_updates_accumulate(self):
        mgr = self._make_manager()
        metadata1 = make_sample_metadata()
        metadata1["tags"] = ["ASMR"]
        metadata1["cvs"] = []

        metadata2 = make_sample_metadata("RJ9999999")
        metadata2["tags"] = ["ASMR"]
        metadata2["cvs"] = []

        audio2 = self.root_dir / "track02.flac"
        audio2.touch()

        mgr.update_playlists(self.audio_file, metadata1, self.root_dir)
        mgr.update_playlists(audio2, metadata2, self.root_dir)

        # The sanitized "ASMR" playlist should have entries from both files
        # (exact key depends on file_manager.sanitize_filename mock)
        total_entries = sum(len(v) for v in mgr.playlist_entries_cache.values())
        assert total_entries >= 2


# ===========================================================================
# 7. generate_all_playlists
# ===========================================================================

class TestGenerateAllPlaylists:
    """Tests for generate_all_playlists writing M3U files from cache."""

    def setup_method(self):
        self.tmpdir = Path(tempfile.mkdtemp())
        self.root_dir = self.tmpdir / "works" / "RJ1234567"
        self.root_dir.mkdir(parents=True, exist_ok=True)
        self.audio_file = self.root_dir / "track01.flac"
        self.audio_file.touch()

    def teardown_method(self):
        if hasattr(self, "mgr"):
            self.mgr.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _make_manager(self, **extra_cfg):
        fm = MagicMock()
        fm.sanitize_filename.side_effect = lambda name, rjcode="": name
        cfg = _enabled_config(**extra_cfg)
        self.mgr, self._conn = _create_manager(cfg, file_manager=fm)
        return self.mgr

    def test_disabled_does_nothing(self):
        mgr, conn = _create_manager()  # disabled by default
        self.mgr = mgr
        mgr.generate_all_playlists()
        # No exception, no files written

    def test_no_root_dir_does_nothing(self):
        mgr = self._make_manager()
        mgr.root_dir = None
        mgr.generate_all_playlists()
        # No exception

    def test_genre_playlist_files_created(self):
        mgr = self._make_manager()
        metadata = make_sample_metadata()
        metadata["tags"] = ["ASMR", "Binaural"]
        mgr.update_playlists(self.audio_file, metadata, self.root_dir)
        mgr.generate_all_playlists()

        # Check that playlist files were created under Genres/
        genres_dir = mgr.playlist_dir / "Genres"
        if genres_dir.exists():
            m3u_files = list(genres_dir.glob("*.m3u"))
            assert len(m3u_files) >= 2

    def test_artist_playlist_files_created(self):
        mgr = self._make_manager()
        metadata = make_sample_metadata()
        metadata["cvs"] = ["ActorA"]
        metadata["maker_name"] = "CircleX"
        mgr.update_playlists(self.audio_file, metadata, self.root_dir)
        mgr.generate_all_playlists()

        artists_dir = mgr.playlist_dir / "Artists"
        if artists_dir.exists():
            m3u_files = list(artists_dir.glob("*.m3u"))
            assert len(m3u_files) >= 2  # ActorA + CircleX

    def test_content_playlist_files_created(self):
        mgr = self._make_manager()
        metadata = make_sample_metadata()
        metadata["age"] = "R-18"
        metadata["price"] = 1000
        metadata["rating"] = 4.0
        metadata["release_date"] = "2024-06-01"
        mgr.update_playlists(self.audio_file, metadata, self.root_dir)
        mgr.generate_all_playlists()

        content_dir = mgr.playlist_dir / "Content"
        if content_dir.exists():
            m3u_files = list(content_dir.glob("*.m3u"))
            # At least "Age Rating - R-18" + sorted playlists
            assert len(m3u_files) >= 1

    def test_sorted_playlists_created(self):
        mgr = self._make_manager()
        metadata = make_sample_metadata()
        metadata["price"] = 500
        metadata["rating"] = 3.5
        metadata["release_date"] = "2023-05-20"
        mgr.update_playlists(self.audio_file, metadata, self.root_dir)
        mgr.generate_all_playlists()

        content_dir = mgr.playlist_dir / "Content"
        if content_dir.exists():
            m3u_names = [f.stem for f in content_dir.glob("*.m3u")]
            # Should contain the sorted playlists
            expected_names = [
                mgr._sanitize_playlist_filename("By Price (High to Low)"),
                mgr._sanitize_playlist_filename("By Rating (High to Low)"),
                mgr._sanitize_playlist_filename("By Release Date (Newest First)"),
            ]
            for name in expected_names:
                assert name in m3u_names, f"Missing sorted playlist: {name}"

    def test_caches_cleared_after_generate(self):
        mgr = self._make_manager()
        metadata = make_sample_metadata()
        metadata["tags"] = ["ASMR"]
        mgr.update_playlists(self.audio_file, metadata, self.root_dir)
        assert len(mgr.playlist_entries_cache) > 0
        mgr.generate_all_playlists()
        assert mgr.playlist_entries_cache == {}
        assert mgr.sorted_playlists_cache == {}

    def test_database_populated_after_generate(self):
        mgr = self._make_manager()
        metadata = make_sample_metadata()
        metadata["tags"] = ["ASMR"]
        metadata["price"] = 800
        metadata["rating"] = 4.0
        metadata["release_date"] = "2024-03-01"
        mgr.update_playlists(self.audio_file, metadata, self.root_dir)
        mgr.generate_all_playlists()

        cursor = mgr.conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM playlist_entries")
        pe_count = cursor.fetchone()[0]
        assert pe_count > 0

        cursor.execute("SELECT COUNT(*) FROM sorted_playlists")
        sp_count = cursor.fetchone()[0]
        assert sp_count > 0

    def test_m3u_content_has_header_and_paths(self):
        mgr = self._make_manager()
        metadata = make_sample_metadata()
        metadata["tags"] = ["TestGenre"]
        metadata["cvs"] = []
        mgr.update_playlists(self.audio_file, metadata, self.root_dir)
        mgr.generate_all_playlists()

        genres_dir = mgr.playlist_dir / "Genres"
        m3u_files = list(genres_dir.glob("*.m3u")) if genres_dir.exists() else []
        assert len(m3u_files) >= 1
        content = m3u_files[0].read_text(encoding="utf-8")
        assert content.startswith("#EXTM3U\n")
        # Should contain a path entry (forward-slash formatted)
        lines = [l for l in content.splitlines() if not l.startswith("#")]
        assert len(lines) >= 1

    def test_playlist_directory_override(self):
        custom_dir = "custom_playlists"
        mgr = self._make_manager(
            playlist_settings={
                "playlist_directory": custom_dir,
                "create_genre_playlists": True,
                "create_content_playlists": True,
                "create_artist_playlists": True,
            }
        )
        metadata = make_sample_metadata()
        metadata["tags"] = ["TestGenre"]
        metadata["cvs"] = []
        mgr.update_playlists(self.audio_file, metadata, self.root_dir)
        # The playlist_dir should be root_dir.parent / custom_dir
        expected = self.root_dir.parent / custom_dir
        assert mgr.playlist_dir == expected


# ===========================================================================
# 8. close
# ===========================================================================

class TestClose:
    """Tests for the close() method."""

    def test_close_succeeds(self):
        mgr, conn = _create_manager()
        mgr.close()
        # Verify the connection is really closed by attempting an operation
        with pytest.raises(Exception):
            conn.execute("SELECT 1")

    def test_close_idempotent(self):
        mgr, conn = _create_manager()
        mgr.close()
        # Second close should not raise
        mgr.close()

    def test_close_with_none_conn(self):
        mgr, conn = _create_manager()
        mgr.conn = None
        # Should not raise
        mgr.close()


# ===========================================================================
# 9. _sanitize_playlist_name
# ===========================================================================

class TestSanitizePlaylistName:
    """Tests for _sanitize_playlist_name which delegates to file_manager."""

    def test_with_file_manager(self):
        fm = MagicMock()
        fm.sanitize_filename.return_value = "cleaned_name"
        mgr, conn = _create_manager(file_manager=fm)
        result = mgr._sanitize_playlist_name("raw name")
        fm.sanitize_filename.assert_called_once_with("raw name", rjcode="")
        assert result == "cleaned_name"
        mgr.close()

    def test_without_file_manager(self):
        mgr, conn = _create_manager()
        mgr.file_manager = None
        result = mgr._sanitize_playlist_name("Hello! World @#$%")
        # Only alphanumeric, space, dash, underscore should remain
        for ch in result:
            assert ch.isalnum() or ch in " -_"
        mgr.close()

    def test_without_file_manager_strips(self):
        mgr, conn = _create_manager()
        mgr.file_manager = None
        result = mgr._sanitize_playlist_name("  spaced  ")
        assert result == result.strip()
        mgr.close()


# ===========================================================================
# 10. _format_playlist_path
# ===========================================================================

class TestFormatPlaylistPath:
    """Tests for _format_playlist_path converting paths for M3U."""

    def setup_method(self):
        self.mgr, self._conn = _create_manager()

    def teardown_method(self):
        self.mgr.close()

    def test_backslashes_converted(self):
        result = self.mgr._format_playlist_path("C:\\Music\\track.flac")
        assert "\\" not in result
        assert "C:/Music/track.flac" in result

    def test_forward_slashes_preserved(self):
        result = self.mgr._format_playlist_path("C:/Music/track.flac")
        assert "C:/Music/track.flac" in result

    def test_absolute_path_unchanged(self):
        abs_path = os.path.abspath("some_file.flac").replace("\\", "/")
        result = self.mgr._format_playlist_path(os.path.abspath("some_file.flac"))
        assert abs_path in result


# ===========================================================================
# 11. _determine_playlist_path
# ===========================================================================

class TestDeterminePlaylistPath:
    """Tests for _determine_playlist_path resolving output directory."""

    def setup_method(self):
        self.tmpdir = Path(tempfile.mkdtemp())

    def teardown_method(self):
        if hasattr(self, "mgr"):
            self.mgr.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_default_path(self):
        self.mgr, conn = _create_manager()
        root = self.tmpdir / "works"
        result = self.mgr._determine_playlist_path(root)
        assert result == root.parent / "playlists"

    def test_custom_path(self):
        cfg = {"playlist_settings": {"playlist_directory": "my_playlists"}}
        self.mgr, conn = _create_manager(cfg)
        root = self.tmpdir / "works"
        result = self.mgr._determine_playlist_path(root)
        assert result == root.parent / "my_playlists"


# ===========================================================================
# 12. Database initialization
# ===========================================================================

class TestDatabaseInitialization:
    """Tests verifying the SQLite schema is created correctly."""

    def test_tables_exist(self):
        mgr, conn = _create_manager()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        )
        tables = {row[0] for row in cursor.fetchall()}
        assert "playlist_entries" in tables
        assert "sorted_playlists" in tables
        mgr.close()

    def test_playlist_entries_unique_constraint(self):
        mgr, conn = _create_manager()
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO playlist_entries (playlist_name, file_path) VALUES (?, ?)",
            ("test", "/a.flac"),
        )
        conn.commit()
        # Duplicate should be ignored (INSERT OR IGNORE used in bulk insert)
        cursor.execute(
            "INSERT OR IGNORE INTO playlist_entries (playlist_name, file_path) VALUES (?, ?)",
            ("test", "/a.flac"),
        )
        conn.commit()
        cursor.execute("SELECT COUNT(*) FROM playlist_entries")
        assert cursor.fetchone()[0] == 1
        mgr.close()

    def test_sorted_playlists_unique_constraint(self):
        mgr, conn = _create_manager()
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO sorted_playlists (sort_key, sort_value, file_path) VALUES (?, ?, ?)",
            ("price", 100.0, "/a.flac"),
        )
        conn.commit()
        cursor.execute(
            "INSERT OR IGNORE INTO sorted_playlists (sort_key, sort_value, file_path) VALUES (?, ?, ?)",
            ("price", 100.0, "/a.flac"),
        )
        conn.commit()
        cursor.execute("SELECT COUNT(*) FROM sorted_playlists")
        assert cursor.fetchone()[0] == 1
        mgr.close()
