import unittest
from title_cleaner import TitleCleaner


class TestTitleCleaner(unittest.TestCase):
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
            ("1_本編", None, "01 本編"),
            ("2_本編", None, "02 本編"),
            ("01_本編", None, "01 本編"),
            ("track01_本編", None, "01 本編"),
            ("1-01_本編", None, "1-01 本編"),
            # Additional Japanese formats
            ("トラック03_BGM", None, "03 BGM"),
            ("ボーナストラック02", None, "02"),
            ("特典01_ボイス", None, "01 ボイス"),
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
            ("1-02 【special】", None, "1-02 【special】"),
            ("5-01『title』track5", None, "5-01 『title』"),
            ("03「voice」", None, "03 「voice」"),
            ("Track04 ＜BGM＞", None, "04 ＜BGM＞"),
            # Edge cases with multiple numbers
            ("Track01 (Take 2)", None, "01 (Take 2)"),
            ("05 Version 2.0", None, "05 Version 2.0"),
            ("Track 3 feat. 2pac", None, "03 feat. 2pac"),
            ("Track 2 feat. 2pac", 3, "02 feat. 2pac"),
            # No numbers/indicators to clean
            ("just a title", None, "just a title"),
            ("【opening】", None, "【opening】"),
            ("BGM_Main", None, "BGM Main"),
            # Idempotency check
            ("05 本編", None, "05 本編"),
            ("1-02 name", None, "1-02 name"),
            ("03 【special】", None, "03 【special】"),
            # Standalone number cases
            ("13", None, "13"),  # Should not become "1-03"
            ("13 - title", None, "13 title"),
            ("track13", None, "13"),
            ("13_BGM", None, "13 BGM"),
            ("13track", None, "13"),
            # Edge cases that look like disk-track numbers
            ("130", None, "130"),  # Should not become "1-30"
            ("113", None, "113"),  # Should not become "1-13"
            ("213", None, "213"),  # Should not become "2-13"
            # Numbers with leading zeros
            ("013", None, "13"),  # Should normalize to "13"
            ("0013", None, "13"),  # Should normalize to "13"
            # Numbers that should remain standalone
            ("Track 13", None, "13"),
            ("No.13", None, "13"),
            ("Track No.13", None, "13"),
            ("第13話", None, "13"),
            ("-13", None, "13"),
            ("13.", None, "13"),
            (".13", None, "13"),
            ("06-こちらの2", None, "06 こちらの2"),
            ("1：プロローグ", None, "01 プロローグ"),
            ("1:プロローグ", None, "01 プロローグ"),
            ("【10】左耳舐めループ 耳塞ぎ有り", None, "10 左耳舐めループ 耳塞ぎ有り"),
            ("(7) 脱落", None, "07 脱落"),
            ("[01]久しぶり♪", None, "01 久しぶり♪"),
            ("Title ()", None, "Title"),
            ("Title []", None, "Title"),
            ("Title {}", None, "Title"),
            ("Title ＜＞", None, "Title"),
            ("Title 「」", None, "Title"),
            ("Title 『』", None, "Title"),
            ("Title 【】", None, "Title"),
            ("Title （）", None, "Title"),
            ("Title ［］", None, "Title"),
            ("Title ｛｝", None, "Title"),
            ("Title 《》", None, "Title"),
            ("Title 〈〉", None, "Title"),
            ("Track05 ( )", None, "05"),
            ("Track06 [ ]", None, "06"),
            ("Track07 { }", None, "07"),
            ("Track08 【 】", None, "08"),
            ("Track09 「 」", None, "09"),
            ("Track10 『 』", None, "10"),
            ("( )", None, ""),
            ("【】", None, ""),
            ("Title with empty brackets () [] {}", None, "Title with empty brackets"),
            ("Title with nested empty brackets (())", None, "Title with nested empty brackets"),
            ("【特典1】20分間、浮気まん", None, "01 20分間、浮気まん")
        ]

    def test_clean_title(self):
        for original, index, expected in self.test_cases:
            with self.subTest(original=original, index=index):
                cleaned = self.cleaner.clean(original, index)
                self.assertEqual(
                    cleaned,
                    expected,
                    msg=f"Failed: '{original}' with index {index} -> '{cleaned}' (expected '{expected}')",
                )


if __name__ == "__main__":
    unittest.main()
