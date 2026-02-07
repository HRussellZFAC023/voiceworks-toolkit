import logging
import os
import sqlite3
import threading
from pathlib import Path
from typing import Any, List
import datetime  # Added for date handling


class PlaylistManager:
    """Manages automatic playlist generation based on audio metadata."""

    def __init__(self, config: dict, file_manager: Any):
        """Initialize playlist manager with configuration."""
        self.logger = logging.getLogger(__name__)
        self.config = config
        self.file_manager = file_manager
        self.lock = threading.Lock()

        # Get playlist settings with defaults
        playlist_settings = self.config.get("playlist_settings", {})
        self.playlist_dir: Path = None  # Will be set in update_playlists
        self.enable_playlists = self.config.get("features", {}).get(
            "enable_playlist_generation", False
        )
        self.create_genre_playlists = playlist_settings.get(
            "create_genre_playlists", True
        )
        self.create_content_playlists = playlist_settings.get(
            "create_content_playlists", True
        )
        self.create_artist_playlists = playlist_settings.get(
            "create_artist_playlists", False
        )

        # Define playlist sorting configurations
        self.sorted_playlist_names = {
            "price": "By Price (High to Low)",
            "rating": "By Rating (High to Low)",
            "date": "By Release Date (Newest First)",
        }
        self.sorted_playlist_reverse = {
            "price": True,
            "rating": True,
            "date": True,
            # Adjust sort order here
        }

        # Initialize database
        self.conn = sqlite3.connect("playlists.db", check_same_thread=False)
        self._initialize_database()

        # Initialize in-memory caches
        self.playlist_entries_cache = {}
        self.sorted_playlists_cache = {}
        self.root_dir = None  # Add this line to store the root directory

    def _initialize_database(self):
        """Initialize SQLite database tables."""
        with self.conn:
            cursor = self.conn.cursor()
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS playlist_entries (
                    playlist_name TEXT,
                    file_path TEXT,
                    UNIQUE(playlist_name, file_path)
                )
            """
            )
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS sorted_playlists (
                    sort_key TEXT,
                    sort_value REAL,
                    file_path TEXT,
                    UNIQUE(sort_key, file_path)
                )
            """
            )

    def update_playlists(
        self, audio_file: Path, metadata: dict, root_dir: Path
    ) -> None:
        """Update playlists for a given audio file based on its metadata."""
        if not self.enable_playlists:
            return

        # Store root_dir for later use
        self.root_dir = root_dir

        # Set playlist directory
        playlist_path = self._determine_playlist_path(root_dir)
        playlist_path.mkdir(parents=True, exist_ok=True)
        self.playlist_dir = playlist_path

        abs_path = str(audio_file.absolute())
        formatted_path = self._format_playlist_path(abs_path)

        # Collect playlist entries
        playlist_entries = []

        # Handle genre-based playlists
        if self.create_genre_playlists:
            genres = self._extract_tags(metadata)
            for genre in genres:
                sanitized_name = self._sanitize_playlist_name(genre)
                if sanitized_name:
                    playlist_entries.append((sanitized_name, formatted_path))

        # Handle content playlists
        if self.create_content_playlists:
            if self._has_script_content(audio_file.parent):
                playlist_entries.append(("Scripts", formatted_path))

            age_rating = metadata.get("age", "Unknown")
            if age_rating:
                playlist_entries.append((f"Age Rating - {age_rating}", formatted_path))

            # Collect entries for sorted playlists
            self._collect_sorted_playlist_entries(formatted_path, metadata)

        # Handle artist playlists
        if self.create_artist_playlists:
            for cv in metadata.get("cvs", []):
                artist_name = f"Artist - {cv}"
                playlist_entries.append((artist_name, formatted_path))
            artist = metadata.get("maker_name", "Unknown Artist")
            playlist_entries.append((f"Artist - {artist}", formatted_path))

        # Update caches
        with self.lock:
            for playlist_name, file_path in playlist_entries:
                self.playlist_entries_cache.setdefault(playlist_name, set()).add(file_path)

    def _collect_sorted_playlist_entries(self, file_path: str, metadata: dict) -> None:
        """Collect entries for sorted playlists."""
        # Convert date to timestamp for proper sorting
        date_value = self._parse_date(metadata.get("release_date", ""))

        sort_values = {
            "price": float(metadata.get("price", 0.0)),
            "rating": float(metadata.get("rating", 0.0)),
            "date": date_value,
            # Additional sort keys can be added here
        }

        with self.lock:
            for sort_key, sort_value in sort_values.items():
                self.sorted_playlists_cache.setdefault(sort_key, []).append((sort_value, file_path))

    def generate_all_playlists(self) -> None:
        """Generate all playlist files after all updates are done."""
        if not self.enable_playlists or not self.root_dir:
            return

        # Ensure playlist directory is set
        if not self.playlist_dir:
            self.playlist_dir = self._determine_playlist_path(self.root_dir)
            self.playlist_dir.mkdir(parents=True, exist_ok=True)

        with self.lock:
            self._bulk_update_database()
            self._generate_playlist_files()

    def _bulk_update_database(self):
        """Bulk update the database with cached entries."""
        with self.conn:
            cursor = self.conn.cursor()
            # Insert playlist entries
            playlist_entries = [
                (playlist_name, file_path)
                for playlist_name, file_paths in self.playlist_entries_cache.items()
                for file_path in file_paths
            ]
            cursor.executemany(
                """
                INSERT OR IGNORE INTO playlist_entries (playlist_name, file_path)
                VALUES (?, ?)
            """,
                playlist_entries,
            )
            # Insert sorted playlist entries
            sorted_entries = []
            for sort_key, entries in self.sorted_playlists_cache.items():
                sorted_entries.extend(
                    [(sort_key, sort_value, file_path) for sort_value, file_path in entries]
                )
            cursor.executemany(
                """
                INSERT OR IGNORE INTO sorted_playlists (sort_key, sort_value, file_path)
                VALUES (?, ?, ?)
            """,
                sorted_entries,
            )
            # Clear caches after bulk insert
            self.playlist_entries_cache.clear()
            self.sorted_playlists_cache.clear()

    def _generate_playlist_files(self) -> None:
        """Generate all playlist files from the database."""
        if not self.playlist_dir:
            self.logger.error("Playlist directory not set. Skipping playlist generation.")
            return

        with self.conn:
            cursor = self.conn.cursor()

            # Generate regular playlists
            cursor.execute("SELECT DISTINCT playlist_name FROM playlist_entries")
            playlist_names = [row[0] for row in cursor.fetchall()]

            for playlist_name in playlist_names:
                cursor.execute(
                    """
                    SELECT file_path FROM playlist_entries
                    WHERE playlist_name = ?
                    ORDER BY file_path
                """,
                    (playlist_name,),
                )
                entries = [row[0] for row in cursor.fetchall()]

                if entries:
                    category = self._determine_category(playlist_name)
                    safe_name = self._sanitize_playlist_filename(playlist_name)
                    playlist_file = (
                        self.playlist_dir / category / f"{safe_name}.m3u"
                    )
                    playlist_file.parent.mkdir(parents=True, exist_ok=True)
                    self._write_playlist_file(playlist_file, entries)

            # Generate sorted playlists
            for sort_key, display_name in self.sorted_playlist_names.items():
                reverse = self.sorted_playlist_reverse.get(sort_key, True)
                cursor.execute(
                    f"""
                    SELECT sort_value, file_path FROM sorted_playlists
                    WHERE sort_key = ?
                    ORDER BY sort_value {"DESC" if reverse else "ASC"}
                """,
                    (sort_key,),
                )
                entries = [row[1] for row in cursor.fetchall()]

                if entries:
                    safe_name = self._sanitize_playlist_filename(display_name)
                    playlist_file = (
                        self.playlist_dir / "Content" / f"{safe_name}.m3u"
                    )
                    playlist_file.parent.mkdir(parents=True, exist_ok=True)
                    self._write_playlist_file(playlist_file, entries)

    def _sanitize_playlist_name(self, name: str) -> str:
        """Sanitize playlist name."""
        if self.file_manager:
            safe_name = self.file_manager.sanitize_filename(name, rjcode="")
        else:
            safe_name = "".join(
                c for c in name if c.isalnum() or c in " -_"
            ).strip()
        return safe_name

    def _sanitize_playlist_filename(self, name: str) -> str:
        """Sanitize playlist filename to be Windows-compatible."""
        # Replace problematic characters
        replacements = {
            '*': '＊',  # Full-width asterisk
            '"': '＂',  # Full-width quote
            '\\': '／',  # Forward slash
            '/': '／',  # Forward slash
            ':': '：',  # Full-width colon
            '?': '？',  # Full-width question mark
            '<': '＜',  # Full-width less than
            '>': '＞',  # Full-width greater than
            '|': '｜',  # Full-width vertical bar
        }

        result = name
        for char, replacement in replacements.items():
            result = result.replace(char, replacement)

        return result

    def _determine_category(self, playlist_name: str) -> str:
        """Determine the category directory for a playlist."""
        if playlist_name.startswith("Artist -"):
            return "Artists"
        elif playlist_name == "Scripts" or playlist_name.startswith("Age Rating -"):
            return "Content"
        else:
            return "Genres"

    def _has_script_content(self, folder_path: Path) -> bool:
        """Check if the audio file has associated script content."""
        # Check for script files in scripts directory
        scripts_dir = folder_path / "scripts"
        if scripts_dir.exists():
            for lang_dir in scripts_dir.glob("*"):
                if lang_dir.is_dir() and any(lang_dir.glob("*.txt")):
                    return True
        return False

    def _determine_playlist_path(self, root_dir: Path) -> Path:
        """Determine where to save playlist files."""
        playlist_dir = self.config.get("playlist_settings", {}).get(
            "playlist_directory"
        )
        if playlist_dir:
            return root_dir.parent / Path(playlist_dir)
        return root_dir.parent / "playlists"

    def _extract_tags(self, metadata: dict) -> List[str]:
        """Extract tags from metadata."""
        tags = metadata.get("tags", [])
        if isinstance(tags, str):
            tags = [tag.strip() for tag in tags.split(",")]
        return [tag for tag in tags if tag]

    def _write_playlist_file(self, playlist_file: Path, entries: List[str]) -> None:
        """Write a playlist file atomically using temp file."""
        import tempfile
        try:
            # Write to temp file first, then rename for atomicity
            tmp_path = playlist_file.with_suffix(".m3u.tmp")
            with open(tmp_path, "w", encoding="utf-8") as f:
                f.write("#EXTM3U\n")
                f.writelines(f"{entry}\n" for entry in entries)
            # Atomic rename (on same filesystem)
            tmp_path.replace(playlist_file)
            self.logger.debug("Successfully updated playlist %s", playlist_file)
        except Exception as e:
            self.logger.error("Failed to write playlist %s: %s", playlist_file, str(e))
            # Clean up temp file on failure
            if tmp_path.exists():
                try:
                    tmp_path.unlink()
                except OSError:
                    pass

    def _format_playlist_path(self, path: str) -> str:
        """Format file path for M3U playlist."""
        # Convert to absolute path if relative
        if not os.path.isabs(path):
            path = os.path.abspath(path)
        # Convert backslashes to forward slashes
        formatted = str(path).replace("\\", "/")
        return formatted

    def _parse_date(self, date_str: str) -> float:
        """Parse date string to timestamp."""
        if date_str:
            try:
                date_obj = datetime.datetime.strptime(date_str, "%Y-%m-%d")
                return date_obj.timestamp()
            except ValueError:
                self.logger.warning("Invalid date format: %s", date_str)
        return 0.0

    def cleanup_playlists(self) -> None:
        """Clean up and validate all playlists."""
        # This method can be implemented if needed
        pass

    def close(self):
        """Explicitly close database connection."""
        try:
            if self.conn:
                self.conn.close()
        except Exception as e:
            self.logger.warning("Error closing playlist database: %s", e)

    def __del__(self):
        """Cleanup when the object is destroyed."""
        self.close()
