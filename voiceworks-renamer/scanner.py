
import os
import re
from typing import List, Tuple

class Scanner:
    """Scans directories to identify work folders based on RJ codes."""

    RJCODE_PATTERN = re.compile(r"RJ\d{7}")

    def scan(self, root_path: str) -> List[Tuple[str, str]]:
        """Scan the root directory for folders containing RJ codes.

        Returns:
            A list of tuples containing RJ codes and their corresponding folder paths.
        """
        work_folders = []
        for dirpath, dirnames, _ in os.walk(root_path):
            for dirname in dirnames:
                match = self.RJCODE_PATTERN.search(dirname)
                if match:
                    rjcode = match.group()
                    folder_path = os.path.join(dirpath, dirname)
                    work_folders.append((rjcode, folder_path))
        return work_folders
