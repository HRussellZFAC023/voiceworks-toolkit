import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from title_cleaner import TitleCleaner


class TestTitleCleanerClean(unittest.TestCase):
    """Tests for TitleCleaner.clean() - migrated from root test_title_cleaner.py with additions."""

    def setUp(self):
        self.cleaner = TitleCleaner()
        self.test_cases = [
            # Basic track number cases
            ("5", None, "05"),
            ("track5", None, "05"),
            ("track 5 5", None, "05"),
            ("5 - title", None, "05 title"),
            # Additional track number variations
            ("Track01", None, "01"),
            ("TR.05 - Song", None, "05 Song"),
            ("Tr-08_Music", None, "08 Music"),
            ("Vol.3 Track02", None, "3-02"),
            # Japanese numbered content
            ("1_\u672c\u7de8", None, "01 \u672c\u7de8"),
            ("2_\u672c\u7de8", None, "02 \u672c\u7de8"),
            ("01_\u672c\u7de8", None, "01 \u672c\u7de8"),
            ("track01_\u672c\u7de8", None, "01 \u672c\u7de8"),
            ("1-01_\u672c\u7de8", None, "1-01 \u672c\u7de8"),
            # Additional Japanese formats
            ("\u30c8\u30e9\u30c3\u30af03_BGM", None, "03 BGM"),
            ("\u30dc\u30fc\u30ca\u30b9\u30c8\u30e9\u30c3\u30af02", None, "02"),
            ("\u7279\u517801_\u30dc\u30a4\u30b9", None, "01 \u30dc\u30a4\u30b9"),
            # Disk-track number cases
            ("1-02", None, "1-02"),
            ("1-02 title", None, "1-02 title"),
            ("disk1-02 track02 name", None, "1-02 name"),
            ("cd2-03 track3 title", None, "2-03 title"),
            # Additional disk formats
            ("Disc03-01", None, "3-01"),
            ("CD5_Track02", None, "5-02"),
            ("DISK2-05_BGM", None, "2-05 BGM"),
            # Malformed disk-track cases
            ("track2-03track03", None, "2-03"),
            ("2-03-name", None, "2-03 name"),
            ("track5-1noise", None, "5-01 noise"),
            ("disc1track02", None, "1-02"),
            # Special characters and brackets
            ("1-02 \u3010special\u3011", None, "1-02 \u3010special\u3011"),
            ("5-01\u300etitle\u300ftrack5", None, "5-01 \u300etitle\u300f"),
            ("03\u300cvoice\u300d", None, "03 \u300cvoice\u300d"),
            ("Track04 \uff1cBGM\uff1e", None, "04 \uff1cBGM\uff1e"),
            # Edge cases with multiple numbers
            ("Track01 (Take 2)", None, "01 (Take 2)"),
            ("05 Version 2.0", None, "05 Version 2.0"),
            ("Track 3 feat. 2pac", None, "03 feat. 2pac"),
            ("Track 2 feat. 2pac", 3, "02 feat. 2pac"),
            # No numbers/indicators to clean
            ("just a title", None, "just a title"),
            ("\u3010opening\u3011", None, "\u3010opening\u3011"),
            ("BGM_Main", None, "BGM Main"),
            # Idempotency check
            ("05 \u672c\u7de8", None, "05 \u672c\u7de8"),
            ("1-02 name", None, "1-02 name"),
            ("03 \u3010special\u3011", None, "03 \u3010special\u3011"),
            # Standalone number cases
            ("13", None, "13"),
            ("13 - title", None, "13 title"),
            ("track13", None, "13"),
            ("13_BGM", None, "13 BGM"),
            ("13track", None, "13"),
            # Edge cases that look like disk-track numbers
            ("130", None, "130"),
            ("113", None, "113"),
            ("213", None, "213"),
            # Numbers with leading zeros
            ("013", None, "13"),
            ("0013", None, "13"),
            # Numbers that should remain standalone
            ("Track 13", None, "13"),
            ("No.13", None, "13"),
            ("Track No.13", None, "13"),
            ("\u7b2c13\u8a71", None, "13"),
            ("-13", None, "13"),
            ("13.", None, "13"),
            (".13", None, "13"),
            ("06-\u3053\u3061\u3089\u306e2", None, "06 \u3053\u3061\u3089\u306e2"),
            ("1\uff1a\u30d7\u30ed\u30ed\u30fc\u30b0", None, "01 \u30d7\u30ed\u30ed\u30fc\u30b0"),
            ("1:\u30d7\u30ed\u30ed\u30fc\u30b0", None, "01 \u30d7\u30ed\u30ed\u30fc\u30b0"),
            ("\u301010\u3011\u5de6\u8033\u8210\u3081\u30eb\u30fc\u30d7 \u8033\u585e\u304e\u6709\u308a", None, "10 \u5de6\u8033\u8210\u3081\u30eb\u30fc\u30d7 \u8033\u585e\u304e\u6709\u308a"),
            ("(7) \u8131\u843d", None, "07 \u8131\u843d"),
            ("[01]\u4e45\u3057\u3076\u308a\u266a", None, "01 \u4e45\u3057\u3076\u308a\u266a"),
            ("Title ()", None, "Title"),
            ("Title []", None, "Title"),
            ("Title {}", None, "Title"),
            ("Title \uff1c\uff1e", None, "Title"),
            ("Title \u300c\u300d", None, "Title"),
            ("Title \u300e\u300f", None, "Title"),
            ("Title \u3010\u3011", None, "Title"),
            ("Title \uff08\uff09", None, "Title"),
            ("Title \uff3b\uff3d", None, "Title"),
            ("Title \uff5b\uff5d", None, "Title"),
            ("Title \u300a\u300b", None, "Title"),
            ("Title \u3008\u3009", None, "Title"),
            ("Track05 ( )", None, "05"),
            ("Track06 [ ]", None, "06"),
            ("Track07 { }", None, "07"),
            ("Track08 \u3010 \u3011", None, "08"),
            ("Track09 \u300c \u300d", None, "09"),
            ("Track10 \u300e \u300f", None, "10"),
            ("( )", None, ""),
            ("\u3010\u3011", None, ""),
            ("Title with empty brackets () [] {}", None, "Title with empty brackets"),
            ("Title with nested empty brackets (())", None, "Title with nested empty brackets"),
            ("\u3010\u72791\u301120\u5206\u9593\u3001\u6d6e\u6c17\u307e\u3093", None, "01 20\u5206\u9593\u3001\u6d6e\u6c17\u307e\u3093"),
        ]

    def test_clean_title(self):
        """Run all existing test cases through TitleCleaner.clean()."""
        for original, index, expected in self.test_cases:
            with self.subTest(original=original, index=index):
                cleaned = self.cleaner.clean(original, index)
                self.assertEqual(
                    cleaned,
                    expected,
                    msg=f"Failed: '{original}' with index {index} -> '{cleaned}' (expected '{expected}')",
                )


class TestTitleCleanerExtractInfo(unittest.TestCase):
    """Tests for TitleCleaner.extract_info() returning (disk, track, remainder) tuples."""

    def setUp(self):
        self.cleaner = TitleCleaner()

    def test_simple_track_number(self):
        """A plain number should be extracted as a track."""
        disk, track, remainder = self.cleaner.extract_info("5")
        self.assertIsNone(disk)
        self.assertEqual(track, "5")
        self.assertEqual(remainder, "")

    def test_track_with_indicator(self):
        """'Track01' should extract track=01 with no disk."""
        disk, track, remainder = self.cleaner.extract_info("Track01")
        self.assertIsNone(disk)
        self.assertEqual(track, "01")

    def test_disk_track_pattern(self):
        """'1-02' should extract disk=1, track=02."""
        disk, track, remainder = self.cleaner.extract_info("1-02")
        self.assertEqual(disk, "1")
        self.assertEqual(track, "02")
        self.assertEqual(remainder, "")

    def test_disk_track_with_remainder(self):
        """'1-02 title' should extract disk=1, track=02, remainder='title'."""
        disk, track, remainder = self.cleaner.extract_info("1-02 title")
        self.assertEqual(disk, "1")
        self.assertEqual(track, "02")
        self.assertEqual(remainder, "title")

    def test_disk_indicator_with_track(self):
        """'disk1-02 track02 name' should extract disk and track numbers."""
        disk, track, remainder = self.cleaner.extract_info("disk1-02 track02 name")
        self.assertEqual(disk, "1")
        self.assertEqual(track, "02")

    def test_bracket_number(self):
        """'[01]title' should extract track from brackets."""
        disk, track, remainder = self.cleaner.extract_info("[01]\u4e45\u3057\u3076\u308a")
        self.assertIsNone(disk)
        self.assertEqual(track, "01")
        self.assertEqual(remainder, "\u4e45\u3057\u3076\u308a")

    def test_full_width_bracket_number(self):
        """Full-width brackets like \u301010\u3011 should extract the number."""
        disk, track, remainder = self.cleaner.extract_info("\u301010\u3011\u30bf\u30a4\u30c8\u30eb")
        self.assertIsNone(disk)
        self.assertEqual(track, "10")
        self.assertEqual(remainder, "\u30bf\u30a4\u30c8\u30eb")

    def test_parenthesis_number(self):
        """'(7) title' should extract track=7."""
        disk, track, remainder = self.cleaner.extract_info("(7) \u8131\u843d")
        self.assertIsNone(disk)
        self.assertEqual(track, "7")
        self.assertEqual(remainder, "\u8131\u843d")

    def test_no_track_info(self):
        """A string with no numbers should return (None, None, original)."""
        disk, track, remainder = self.cleaner.extract_info("just a title")
        self.assertIsNone(disk)
        self.assertIsNone(track)
        self.assertEqual(remainder, "just a title")

    def test_track_with_separator(self):
        """'5 - title' should extract track=5 and remainder='title'."""
        disk, track, remainder = self.cleaner.extract_info("5 - title")
        self.assertIsNone(disk)
        self.assertEqual(track, "5")

    def test_japanese_track_indicator(self):
        """Japanese track indicators should be recognized."""
        disk, track, remainder = self.cleaner.extract_info("\u30c8\u30e9\u30c3\u30af03_BGM")
        self.assertIsNone(disk)
        self.assertEqual(track, "03")

    def test_disc_indicator(self):
        """'Disc03-01' should be recognized as disk=3, track=01."""
        disk, track, remainder = self.cleaner.extract_info("Disc03-01")
        # The disk-track pattern should be found
        self.assertIsNotNone(disk)
        self.assertIsNotNone(track)

    def test_leading_zeros_stripped(self):
        """Leading zeros in standalone numbers should still be returned as-is from extract_info."""
        disk, track, remainder = self.cleaner.extract_info("013")
        self.assertIsNone(disk)
        self.assertEqual(track, "013")
        self.assertEqual(remainder, "")

    def test_number_with_colon(self):
        """'1:\u30d7\u30ed\u30ed\u30fc\u30b0' should extract track=1."""
        disk, track, remainder = self.cleaner.extract_info("1:\u30d7\u30ed\u30ed\u30fc\u30b0")
        self.assertIsNone(disk)
        self.assertEqual(track, "1")
        self.assertIn("\u30d7\u30ed\u30ed\u30fc\u30b0", remainder)

    def test_full_width_colon(self):
        """'1\uff1a\u30d7\u30ed\u30ed\u30fc\u30b0' should extract track=1."""
        disk, track, remainder = self.cleaner.extract_info("1\uff1a\u30d7\u30ed\u30ed\u30fc\u30b0")
        self.assertIsNone(disk)
        self.assertEqual(track, "1")
        self.assertIn("\u30d7\u30ed\u30ed\u30fc\u30b0", remainder)


class TestTitleCleanerEdgeCases(unittest.TestCase):
    """Edge case tests for TitleCleaner."""

    def setUp(self):
        self.cleaner = TitleCleaner()

    def test_empty_string_clean(self):
        """clean() with empty string should return empty string."""
        result = self.cleaner.clean("", None)
        self.assertEqual(result, "")

    def test_empty_string_extract_info(self):
        """extract_info() with empty string should return (None, None, '')."""
        disk, track, remainder = self.cleaner.extract_info("")
        self.assertIsNone(disk)
        self.assertIsNone(track)
        self.assertEqual(remainder, "")

    def test_very_long_string_clean(self):
        """clean() should handle very long strings without crashing."""
        long_title = "A" * 5000
        result = self.cleaner.clean(long_title, None)
        self.assertIsInstance(result, str)

    def test_very_long_string_extract_info(self):
        """extract_info() should handle very long strings without crashing."""
        long_title = "Track01 " + "X" * 5000
        disk, track, remainder = self.cleaner.extract_info(long_title)
        self.assertIsNotNone(track)
        self.assertIsInstance(remainder, str)

    def test_only_spaces_clean(self):
        """clean() with only spaces should return empty string."""
        result = self.cleaner.clean("   ", None)
        self.assertEqual(result, "")

    def test_only_spaces_extract_info(self):
        """extract_info() with only spaces should return (None, None, '')."""
        disk, track, remainder = self.cleaner.extract_info("   ")
        self.assertIsNone(disk)
        self.assertIsNone(track)
        self.assertEqual(remainder, "")

    def test_none_index_fallback(self):
        """When no track is found and index is None, no track prefix should appear."""
        result = self.cleaner.clean("just a title", None)
        self.assertEqual(result, "just a title")

    def test_index_fallback_when_no_track(self):
        """When no track is found, index should be used as the track number."""
        result = self.cleaner.clean("just a title", 5)
        self.assertEqual(result, "05 just a title")


class TestTitleCleanerFileExtensions(unittest.TestCase):
    """Tests for file extension removal during extract_info."""

    def setUp(self):
        self.cleaner = TitleCleaner()

    def test_mp3_extension_removal(self):
        """.mp3 extension should be stripped before processing."""
        disk, track, remainder = self.cleaner.extract_info("Track01 Song.mp3")
        self.assertIsNotNone(track)
        self.assertNotIn(".mp3", remainder)

    def test_wav_extension_removal(self):
        """.wav extension should be stripped before processing."""
        disk, track, remainder = self.cleaner.extract_info("05 Title.wav")
        self.assertEqual(track, "05")
        self.assertNotIn(".wav", remainder)

    def test_flac_extension_removal(self):
        """.flac extension should be stripped before processing."""
        disk, track, remainder = self.cleaner.extract_info("Track03 Music.flac")
        self.assertIsNotNone(track)
        self.assertNotIn(".flac", remainder)

    def test_m4a_extension_removal(self):
        """.m4a extension should be stripped before processing."""
        disk, track, remainder = self.cleaner.extract_info("02 Audio.m4a")
        self.assertEqual(track, "02")
        self.assertNotIn(".m4a", remainder)

    def test_ogg_extension_removal(self):
        """.ogg extension should be stripped before processing."""
        disk, track, remainder = self.cleaner.extract_info("Track07 Voice.ogg")
        self.assertIsNotNone(track)
        self.assertNotIn(".ogg", remainder)

    def test_opus_extension_removal(self):
        """.opus extension should be stripped before processing."""
        disk, track, remainder = self.cleaner.extract_info("01 Recording.opus")
        self.assertEqual(track, "01")
        self.assertNotIn(".opus", remainder)

    def test_case_insensitive_extension(self):
        """Extension removal should be case-insensitive."""
        disk, track, remainder = self.cleaner.extract_info("Track01 Song.MP3")
        self.assertIsNotNone(track)
        self.assertNotIn(".MP3", remainder)
        self.assertNotIn(".mp3", remainder)

    def test_extension_not_in_middle(self):
        """Extensions should only be removed from the end of the string."""
        disk, track, remainder = self.cleaner.extract_info("Track01 file.mp3.bak")
        # .mp3 is not at the end so should NOT be removed as a file extension
        # The .bak suffix means the regex won't match .mp3
        self.assertIsNotNone(track)

    def test_no_extension(self):
        """Titles without extensions should work normally."""
        disk, track, remainder = self.cleaner.extract_info("Track01 Title")
        self.assertIsNotNone(track)

    def test_clean_with_extension(self):
        """clean() should handle filenames with extensions properly."""
        result = self.cleaner.clean("Track05 Song.mp3", None)
        self.assertNotIn(".mp3", result)
        self.assertIn("05", result)


if __name__ == "__main__":
    unittest.main()
