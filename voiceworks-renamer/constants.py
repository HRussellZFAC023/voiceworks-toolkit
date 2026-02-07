import re

WINDOWS_RESERVED_CHARACTER_PATTERN = re.compile(r'[\\/*?:"<>|]')
WINDOWS_RESERVED_CHARACTER_PATTERN_STR = r'\/:*?"<>|'
WINDOWS_RESERVED_CHARACTER_REPLACE_STR = "＼／：＊？＂＜＞｜"
MAX_NAME_LENGTH = 200

COLORS = {
    "background": "#F5F6FA",
    "panel": "#FFFFFF",
    "accent": "#5C7AEA",
    "text": "#2E3440",
    "border": "#E4E6EB",
    "disabled": "#CBD5E0",
}

LOCALE_CHOICES = [
    ("English", "en_us"),
    ("Japanese", "ja_jp"),
    ("Chinese", "zh_cn"),
    ("Korean", "ko_kr"),
]

TEMPLATE_HELP = """Template Variables:
- maker_name: Circle/maker name
- rjcode: Product code (RJ######)
- rating: Product rating (★★★★☆)
- age: Age rating
- release_date: Release date
- work_name: Work title
- cv_list_str: Voice actors list
- tags_list_str: Tags list
"""
