"""Shared test fixtures and helpers."""
import sys
import os
import json
import tempfile
from pathlib import Path
from unittest.mock import MagicMock

# Ensure project root is on path
PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT))


def make_config(overrides=None):
    """Create a Config-like dict for testing."""
    base = {
        "locale": "en_us",
        "connect_timeout": 10,
        "read_timeout": 10,
        "sleep_interval": 0,
        "template": "rjcode work_name",
        "renamer_release_date_format": "%Y-%m-%d",
        "remove_image_files": False,
        "save_cover_jpg": True,
        "save_sample_images": False,
        "cv_list_left": "(CV. ",
        "cv_list_right": ")",
        "use_full_width_chars": False,
        "overwrite_existing": False,
        "include_original_name": False,
        "features": {
            "enable_folder_rename": False,
            "enable_file_rename": False,
            "enable_metadata_update": False,
            "enable_cover_art": False,
            "enable_playlist_generation": False,
            "enable_transcription": False,
            "enable_translation": False,
            "enable_folder_icon": False,
            "enable_script_import": False,
            "enable_product_summary": False,
        },
        "playlist_settings": {
            "playlist_directory": "",
            "create_genre_playlists": True,
            "create_content_playlists": True,
            "create_artist_playlists": False,
        },
    }
    if overrides:
        base.update(overrides)
    return base


class MockConfig:
    """Mock config that behaves like the Config class."""

    def __init__(self, data=None):
        self.config = make_config(data)

    def get(self, key, default=None):
        return self.config.get(key, default)

    def set(self, key, value):
        self.config[key] = value

    def save_config(self):
        pass


def make_sample_metadata(rjcode="RJ1234567"):
    """Create sample WorkMetadata for testing."""
    return {
        "rjcode": rjcode,
        "work_name": "テスト作品",
        "maker_id": "RG12345",
        "maker_name": "テストサークル",
        "release_date": "2024-01-15",
        "series_id": "",
        "series_name": "",
        "age": "⑱",
        "options": [],
        "machine": [],
        "platform": "PC",
        "work_type": "SOU",
        "file_type": "WAV",
        "file_size": "1.5GB",
        "circle_id": "RG12345",
        "sex_category": "male",
        "work_category": "audio",
        "price": 1320,
        "price_without_tax": 1200,
        "is_trial": False,
        "intro_s": "テスト作品の紹介文です",
        "summary": "テスト作品の詳細な説明文です",
        "work_name_kana": "テストサクヒン",
        "tags": ["ASMR", "バイノーラル", "耳かき"],
        "cvs": ["テスト声優A", "テスト声優B"],
        "cover_url": "https://example.com/cover.jpg",
        "image_thum_url": "https://example.com/thumb.jpg",
        "sample_images": [],
        "supported_languages": ["Japanese"],
        "rating": 4.5,
    }
