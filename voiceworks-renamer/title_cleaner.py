import re
from typing import Optional, Tuple


class TitleCleaner:
    def __init__(self):

        self.track_indicators = r"track|tr|volume|vol|chapter|ch|episode|ep|part|pt|soundtrack|ost|vo|bonus|append|trial|demo|次回予告|おまけ|体験版|特典|エピソード|章|話|巻|トラック|ボーナストラック|no|number|no\.|num|s[0-9]+|side|act|scene|cut|segment|tracklist|sequence|movement|series|set|no\.?|＃|#|第"
        self.disk_indicators = r"disc|disk|cd|dvd|bd|vol|volume|part|pt|ディスク|ボリューム|パート|盤|ブックレット|ディスク[0-9]+|CD[0-9]+|DVD[0-9]+|BD[0-9]+"

        self.file_extension_pattern = r"\.(mp3|wav|flac|m4a|ogg|opus)$"

    def extract_info(self, title: str) -> Tuple[Optional[str], Optional[str], str]:
        """Extract disk number, track number, and remaining title."""
        # Remove file extension
        title = re.sub(self.file_extension_pattern, "", title, flags=re.IGNORECASE)

        # Check for numbers in various brackets including parentheses at start
        bracket_number = re.match(r'^[【［\[(\(][^\d]*?(\d+)[^\d]*?[】］\])\)]\s*(.*)$', title)
        if bracket_number:
            track = bracket_number.group(1)
            remainder = bracket_number.group(2)
            return None, track, remainder

        # First check for explicit disk-track pattern (e.g. "1-02")
        direct_disk_track = re.match(r"^(\d+)-(\d+)", title)
        if direct_disk_track:
            disk, track = direct_disk_track.groups()
            remainder = title[direct_disk_track.end() :].strip()
            return disk, track, remainder

        # Update standalone_pattern to include full-width colon '：'
        standalone_pattern = r'^[.\s-]*(?:第)?(\d+)[：:\-.\s]?'
        standalone = re.match(standalone_pattern, title)
        if standalone:
            track = standalone.group(1)
            remainder = title[standalone.end():].strip()
            # Clean potential remaining 第 character
            remainder = re.sub(r'^第', '', remainder)
            return None, track, remainder

        # Patterns
        disk_track_pattern = rf"(?:(?:{self.disk_indicators})[-\s._]*)?(\d+)[-_.](\d+)"
        track_pattern = rf"(?:{self.track_indicators})[-\s._]*(\d+)"
        disk_pattern = rf"(?:{self.disk_indicators})[-\s._]*(\d+)"
        standalone_pattern = r"^[.\s]*(\d+)"

        # Try disk-track pattern
        disk_track_match = re.search(disk_track_pattern, title, re.IGNORECASE)
        if disk_track_match:
            disk, track = disk_track_match.groups()
            remainder = (
                title[: disk_track_match.start()] + title[disk_track_match.end() :]
            ).strip()
            return disk, track, remainder

        # Try track with possible disk indicator before
        track_matches = list(re.finditer(track_pattern, title, re.IGNORECASE))
        if track_matches:
            track_match = track_matches[-1]
            track = track_match.group(1)
            pre_track = title[: track_match.start()]
            post_track = title[track_match.end() :]
            # Check for disk before track
            disk_match = re.search(disk_pattern, pre_track, re.IGNORECASE)
            disk = disk_match.group(1) if disk_match else None
            remainder = (
                title[: disk_match.start()] if disk_match else pre_track
            ) + post_track
            return disk, track, remainder.strip()

        # Try standalone number at start
        standalone_match = re.match(standalone_pattern, title)
        if standalone_match:
            track = standalone_match.group(1)
            remainder = title[standalone_match.end() :].strip()
            return None, track, remainder

        return None, None, title.strip()

    def clean(self, title: str, index: Optional[int] = None) -> str:
        """Clean title and preserve track numbers."""
        if not title:
            return title

        # Extract track info
        disk_num, track_num, remainder = self.extract_info(title)

        # If no track found, use index
        if track_num is None and index is not None:
            track_num = str(index)

        # Pre-clean any concatenated track indicators
        remainder = re.sub(
            rf"(?:{self.track_indicators}|{self.disk_indicators})\d*(?={self.track_indicators}|{self.disk_indicators}|\d|$)",
            "",
            remainder,
            flags=re.IGNORECASE,
        )

        # Split into parts and clean
        parts = re.split(r"[-_\s]+", remainder)
        cleaned_parts = []
        for i, part in enumerate(parts):
            if not part:  # Skip empty parts
                continue
            # Clean only standalone track indicators or those with trailing numbers
            cleaned_part = part
            # First try with word boundaries for Latin text
            cleaned_part = re.sub(
                rf"\b(?:{self.track_indicators}|{self.disk_indicators})\b\d*",
                "",
                cleaned_part,
                flags=re.IGNORECASE,
            )
            # Then try with Japanese text boundaries
            cleaned_part = re.sub(
                rf"(?:^|(?<=[^\w]))(?:{self.track_indicators}|{self.disk_indicators})(?:\d+)?(?=$|(?=[^\w]))",
                "",
                cleaned_part,
                flags=re.IGNORECASE,
            )
            # Skip pure numbers unless they're part of a version number
            if re.match(r"^\d+$", cleaned_part):
                if i < len(parts) - 1 and parts[i + 1].lower() == "version":
                    cleaned_parts.append(cleaned_part)
                continue
            # Only add non-empty parts
            if cleaned_part.strip():
                cleaned_parts.append(cleaned_part.strip())

        # Join parts
        remainder_clean = " ".join(cleaned_parts).strip(" .")

        # Remove empty brackets of all kinds (including nested ones)
        empty_brackets_pattern = r'[\(\[\{＜「『【（［｛《〈](?:\s*)[\)\]\}＞」』】）］｝》〉]'
        while re.search(empty_brackets_pattern, remainder_clean):
            remainder_clean = re.sub(empty_brackets_pattern, '', remainder_clean)

        # Format track/disk numbers
        if track_num is not None:
            track_str = f"{int(track_num):02d}"
            if disk_num is not None and not re.match(r"^0+$", disk_num):
                disk_str = str(int(disk_num))
                prefix = f"{disk_str}-{track_str}"
            else:
                prefix = track_str
        else:
            prefix = ""

        # Build final result
        if prefix and remainder_clean:
            result = f"{prefix} {remainder_clean}"
        elif prefix:
            result = prefix
        else:
            result = remainder_clean

        return result.strip()
