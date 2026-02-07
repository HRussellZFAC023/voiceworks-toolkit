import logging
from pathlib import Path

class FileSystem:
    """File system operations wrapper."""

    @staticmethod
    def ensure_directory_exists(path: str) -> None:
        """Create directory if it doesn't exist."""
        Path(path).mkdir(parents=True, exist_ok=True)

    @staticmethod
    def remove_file(path: str, rjcode: str) -> None:
        """Safely remove a file if it exists."""
        try:
            logging.info("[%s] -> Removing file: %s", rjcode, path)
            Path(path).unlink(missing_ok=True)
        except OSError as err:
            logging.error("[%s] -> Failed to remove file %s: %s", rjcode, path, err)
