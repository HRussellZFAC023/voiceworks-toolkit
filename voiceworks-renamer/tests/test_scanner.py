"""Comprehensive tests for the Scanner class.

Tests the root-level scanner.py module (not the scanner/ package).
Uses importlib to load from the exact file path to avoid the package shadowing.
"""

import importlib.util
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

# Ensure project root is on sys.path
PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

# Load the root-level scanner.py directly (not the scanner/ package)
_spec = importlib.util.spec_from_file_location(
    "scanner_module", str(PROJECT_ROOT / "scanner.py")
)
_scanner_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_scanner_module)
Scanner = _scanner_module.Scanner


class TestScanner(unittest.TestCase):
    """Tests for Scanner.scan() method."""

    def setUp(self):
        """Create a fresh temporary directory and Scanner instance for each test."""
        self.test_dir = tempfile.mkdtemp()
        self.scanner = Scanner()

    def tearDown(self):
        """Remove the temporary directory tree after each test."""
        shutil.rmtree(self.test_dir)

    def _mkdir(self, *parts):
        """Helper: create a subdirectory under self.test_dir and return its path."""
        path = os.path.join(self.test_dir, *parts)
        os.makedirs(path, exist_ok=True)
        return path

    # ------------------------------------------------------------------
    # 1. Basic scanning with RJ code folders
    # ------------------------------------------------------------------

    def test_single_rjcode_folder(self):
        """A single folder with a valid 7-digit RJ code is found."""
        self._mkdir("RJ1234567")
        results = self.scanner.scan(self.test_dir)
        self.assertEqual(len(results), 1)
        rjcode, folder = results[0]
        self.assertEqual(rjcode, "RJ1234567")
        self.assertEqual(folder, os.path.join(self.test_dir, "RJ1234567"))

    def test_rjcode_with_surrounding_text(self):
        """RJ code embedded in a longer folder name is extracted correctly."""
        self._mkdir("[Circle] RJ0012345 Work Title")
        results = self.scanner.scan(self.test_dir)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0][0], "RJ0012345")

    def test_rjcode_at_end_of_name(self):
        """RJ code at the end of the folder name is detected."""
        self._mkdir("Some Work RJ9999999")
        results = self.scanner.scan(self.test_dir)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0][0], "RJ9999999")

    def test_rjcode_at_start_of_name(self):
        """RJ code at the start of the folder name is detected."""
        self._mkdir("RJ0000001 - Title")
        results = self.scanner.scan(self.test_dir)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0][0], "RJ0000001")

    # ------------------------------------------------------------------
    # 2. Nested folders with RJ codes
    # ------------------------------------------------------------------

    def test_nested_rjcode_folder(self):
        """RJ code folder nested inside a non-RJ parent is found."""
        self._mkdir("collection", "RJ1111111")
        results = self.scanner.scan(self.test_dir)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0][0], "RJ1111111")
        self.assertIn("collection", results[0][1])

    def test_deeply_nested_rjcode(self):
        """RJ code folder several levels deep is still found."""
        self._mkdir("a", "b", "c", "RJ2222222")
        results = self.scanner.scan(self.test_dir)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0][0], "RJ2222222")

    def test_rjcode_parent_and_rjcode_child(self):
        """Both a parent and child folder with RJ codes are found."""
        self._mkdir("RJ1000000", "RJ2000000")
        results = self.scanner.scan(self.test_dir)
        rjcodes = {rj for rj, _ in results}
        self.assertEqual(rjcodes, {"RJ1000000", "RJ2000000"})

    # ------------------------------------------------------------------
    # 3. Folders without RJ codes (should be ignored)
    # ------------------------------------------------------------------

    def test_no_rjcode_folders(self):
        """Folders without RJ codes produce an empty result list."""
        self._mkdir("random_folder")
        self._mkdir("another folder")
        self._mkdir("music_collection")
        results = self.scanner.scan(self.test_dir)
        self.assertEqual(results, [])

    def test_folder_with_rj_lowercase_is_ignored(self):
        """Lowercase 'rj' does not match the pattern (case-sensitive)."""
        self._mkdir("rj1234567")
        results = self.scanner.scan(self.test_dir)
        self.assertEqual(results, [])

    def test_folder_with_mixed_case_rj_is_ignored(self):
        """Mixed case like 'Rj' or 'rJ' does not match."""
        self._mkdir("Rj1234567")
        self._mkdir("rJ1234567")
        results = self.scanner.scan(self.test_dir)
        self.assertEqual(results, [])

    # ------------------------------------------------------------------
    # 4. Mixed folders (some with, some without RJ codes)
    # ------------------------------------------------------------------

    def test_mixed_folders(self):
        """Only folders containing valid RJ codes are returned."""
        self._mkdir("RJ1234567")
        self._mkdir("no_code_here")
        self._mkdir("another_folder")
        self._mkdir("RJ7654321")
        results = self.scanner.scan(self.test_dir)
        rjcodes = sorted([rj for rj, _ in results])
        self.assertEqual(rjcodes, ["RJ1234567", "RJ7654321"])

    def test_mixed_nested_and_flat(self):
        """Mixing flat and nested RJ code folders returns all of them."""
        self._mkdir("RJ0000001")
        self._mkdir("sub", "RJ0000002")
        self._mkdir("other")
        results = self.scanner.scan(self.test_dir)
        rjcodes = {rj for rj, _ in results}
        self.assertEqual(rjcodes, {"RJ0000001", "RJ0000002"})

    # ------------------------------------------------------------------
    # 5. Multiple RJ code folders
    # ------------------------------------------------------------------

    def test_many_rjcode_folders(self):
        """Scanning with many RJ code folders returns all of them."""
        expected_codes = set()
        for i in range(20):
            code = f"RJ{i:07d}"
            self._mkdir(code)
            expected_codes.add(code)
        results = self.scanner.scan(self.test_dir)
        found_codes = {rj for rj, _ in results}
        self.assertEqual(found_codes, expected_codes)

    def test_multiple_rjcodes_at_same_depth(self):
        """Multiple RJ code folders at the same directory level."""
        self._mkdir("RJ1111111")
        self._mkdir("RJ2222222")
        self._mkdir("RJ3333333")
        results = self.scanner.scan(self.test_dir)
        rjcodes = sorted([rj for rj, _ in results])
        self.assertEqual(rjcodes, ["RJ1111111", "RJ2222222", "RJ3333333"])

    # ------------------------------------------------------------------
    # 6. Empty directory
    # ------------------------------------------------------------------

    def test_empty_directory(self):
        """Scanning an empty directory returns an empty list."""
        results = self.scanner.scan(self.test_dir)
        self.assertEqual(results, [])

    def test_directory_with_only_files(self):
        """Directory containing only files (no subdirectories) returns empty."""
        # Create files, not directories
        for name in ["file1.txt", "RJ1234567.txt", "readme.md"]:
            filepath = os.path.join(self.test_dir, name)
            with open(filepath, "w") as f:
                f.write("")
        results = self.scanner.scan(self.test_dir)
        self.assertEqual(results, [])

    # ------------------------------------------------------------------
    # 7. RJ code pattern edge cases
    # ------------------------------------------------------------------

    def test_six_digit_rjcode_is_ignored(self):
        """RJ followed by only 6 digits does not match (requires exactly 7)."""
        self._mkdir("RJ123456")
        results = self.scanner.scan(self.test_dir)
        self.assertEqual(results, [])

    def test_eight_digit_rjcode_matches_first_seven(self):
        """RJ followed by 8 digits matches the first 7 digits via search()."""
        self._mkdir("RJ12345678")
        results = self.scanner.scan(self.test_dir)
        # search() finds "RJ1234567" within "RJ12345678"
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0][0], "RJ1234567")

    def test_five_digit_rjcode_is_ignored(self):
        """RJ followed by 5 digits does not match."""
        self._mkdir("RJ12345")
        results = self.scanner.scan(self.test_dir)
        self.assertEqual(results, [])

    def test_rjcode_all_zeros(self):
        """RJ0000000 (all zeros) is a valid 7-digit match."""
        self._mkdir("RJ0000000")
        results = self.scanner.scan(self.test_dir)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0][0], "RJ0000000")

    def test_rjcode_all_nines(self):
        """RJ9999999 is a valid 7-digit match."""
        self._mkdir("RJ9999999")
        results = self.scanner.scan(self.test_dir)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0][0], "RJ9999999")

    def test_rj_without_digits_is_ignored(self):
        """'RJ' without trailing digits does not match."""
        self._mkdir("RJ_no_digits")
        results = self.scanner.scan(self.test_dir)
        self.assertEqual(results, [])

    def test_rj_with_letters_after_is_ignored(self):
        """'RJabcdefg' (letters not digits) does not match."""
        self._mkdir("RJabcdefg")
        results = self.scanner.scan(self.test_dir)
        self.assertEqual(results, [])

    def test_rjcode_with_hyphens_between_digits_is_ignored(self):
        """'RJ123-4567' has non-contiguous digits and does not match."""
        self._mkdir("RJ123-4567")
        results = self.scanner.scan(self.test_dir)
        self.assertEqual(results, [])

    def test_multiple_rjcodes_in_single_folder_name(self):
        """When a folder name contains two RJ codes, only the first is extracted."""
        self._mkdir("RJ1111111_vs_RJ2222222")
        results = self.scanner.scan(self.test_dir)
        self.assertEqual(len(results), 1)
        # re.search returns the first match
        self.assertEqual(results[0][0], "RJ1111111")

    def test_rjcode_preceded_by_letters_still_matches(self):
        """RJ code preceded by other letters (e.g., 'abcRJ1234567') still matches."""
        self._mkdir("prefixRJ1234567suffix")
        results = self.scanner.scan(self.test_dir)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0][0], "RJ1234567")

    # ------------------------------------------------------------------
    # 8. Unicode folder names containing RJ codes
    # ------------------------------------------------------------------

    def test_unicode_folder_with_rjcode_japanese(self):
        """Japanese characters around an RJ code still match."""
        self._mkdir("[Circle] RJ1234567 Japanese Title")
        results = self.scanner.scan(self.test_dir)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0][0], "RJ1234567")

    def test_unicode_folder_with_rjcode_cjk(self):
        """CJK characters surrounding an RJ code still allow detection."""
        self._mkdir("\u4e2d\u6587RJ5555555\u65e5\u672c\u8a9e")
        results = self.scanner.scan(self.test_dir)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0][0], "RJ5555555")

    def test_unicode_only_folder_is_ignored(self):
        """A folder with only Unicode text and no RJ code is ignored."""
        self._mkdir("\u30c6\u30b9\u30c8\u30d5\u30a9\u30eb\u30c0")
        results = self.scanner.scan(self.test_dir)
        self.assertEqual(results, [])

    def test_emoji_folder_with_rjcode(self):
        """Emoji characters in the folder name do not prevent RJ code detection."""
        self._mkdir("\U0001f3b5 RJ7777777 \U0001f3b6")
        results = self.scanner.scan(self.test_dir)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0][0], "RJ7777777")

    def test_fullwidth_rj_is_ignored(self):
        """Full-width 'RJ' (\uff32\uff2a) does not match the ASCII pattern."""
        self._mkdir("\uff32\uff2a1234567")
        results = self.scanner.scan(self.test_dir)
        self.assertEqual(results, [])

    # ------------------------------------------------------------------
    # Additional edge cases
    # ------------------------------------------------------------------

    def test_return_type_is_list_of_tuples(self):
        """scan() always returns a list of (str, str) tuples."""
        self._mkdir("RJ1234567")
        results = self.scanner.scan(self.test_dir)
        self.assertIsInstance(results, list)
        for item in results:
            self.assertIsInstance(item, tuple)
            self.assertEqual(len(item), 2)
            self.assertIsInstance(item[0], str)
            self.assertIsInstance(item[1], str)

    def test_returned_paths_are_absolute(self):
        """All returned folder paths are absolute."""
        self._mkdir("RJ1234567")
        results = self.scanner.scan(self.test_dir)
        for _, folder in results:
            self.assertTrue(os.path.isabs(folder))

    def test_returned_paths_exist(self):
        """All returned folder paths actually exist on disk."""
        self._mkdir("RJ1234567")
        self._mkdir("sub", "RJ7654321")
        results = self.scanner.scan(self.test_dir)
        for _, folder in results:
            self.assertTrue(os.path.isdir(folder))

    def test_rjcode_pattern_is_class_attribute(self):
        """RJCODE_PATTERN is accessible as a class attribute on Scanner."""
        self.assertTrue(hasattr(Scanner, "RJCODE_PATTERN"))
        self.assertIsNotNone(Scanner.RJCODE_PATTERN.search("RJ1234567"))
        self.assertIsNone(Scanner.RJCODE_PATTERN.search("RJ123456"))

    def test_scan_does_not_modify_filesystem(self):
        """Scanning does not create or remove any files/directories."""
        self._mkdir("RJ1234567")
        self._mkdir("other")
        contents_before = set()
        for dirpath, dirnames, filenames in os.walk(self.test_dir):
            for d in dirnames:
                contents_before.add(os.path.join(dirpath, d))
            for f in filenames:
                contents_before.add(os.path.join(dirpath, f))

        self.scanner.scan(self.test_dir)

        contents_after = set()
        for dirpath, dirnames, filenames in os.walk(self.test_dir):
            for d in dirnames:
                contents_after.add(os.path.join(dirpath, d))
            for f in filenames:
                contents_after.add(os.path.join(dirpath, f))

        self.assertEqual(contents_before, contents_after)

    def test_nonexistent_path_raises(self):
        """Scanning a nonexistent path does not crash; os.walk yields nothing."""
        fake_path = os.path.join(self.test_dir, "does_not_exist")
        results = self.scanner.scan(fake_path)
        self.assertEqual(results, [])

    def test_scanner_instance_is_reusable(self):
        """The same Scanner instance can be used for multiple scans."""
        self._mkdir("RJ1234567")
        results1 = self.scanner.scan(self.test_dir)
        results2 = self.scanner.scan(self.test_dir)
        self.assertEqual(results1, results2)


if __name__ == "__main__":
    unittest.main()
