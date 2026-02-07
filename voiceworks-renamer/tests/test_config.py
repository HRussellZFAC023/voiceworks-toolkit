"""Tests for the Config class (config.py)."""

import sys
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).parent.parent))

from config import Config, ConfigObserver


class TestConfigObserver(unittest.TestCase):
    """Tests for ConfigObserver."""

    def test_subscribe_adds_callback(self):
        observer = ConfigObserver()
        cb = MagicMock()
        observer.subscribe(cb)
        self.assertIn(cb, observer.callbacks)

    def test_notify_calls_all_callbacks(self):
        observer = ConfigObserver()
        cb1 = MagicMock()
        cb2 = MagicMock()
        observer.subscribe(cb1)
        observer.subscribe(cb2)

        observer.notify("some_key", 42)

        cb1.assert_called_once_with("some_key", 42)
        cb2.assert_called_once_with("some_key", 42)

    def test_notify_with_no_subscribers(self):
        observer = ConfigObserver()
        # Should not raise
        observer.notify("key", "value")


class TestConfigLoadValidJSON(unittest.TestCase):
    """Test loading a valid config JSON file."""

    def test_load_valid_config(self):
        data = {"locale": "ja_jp", "connect_timeout": 30, "features": {"enable_transcription": True}}
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as f:
            json.dump(data, f, ensure_ascii=False)
            tmp_path = f.name

        try:
            config = Config(tmp_path)
            self.assertEqual(config.config, data)
            self.assertEqual(config.get("locale"), "ja_jp")
            self.assertEqual(config.get("connect_timeout"), 30)
            self.assertTrue(config.get("features")["enable_transcription"])
        finally:
            os.unlink(tmp_path)


class TestConfigLoadMissingFile(unittest.TestCase):
    """Test loading a missing config file returns empty dict."""

    def test_load_missing_file_returns_empty_dict(self):
        config = Config("/nonexistent/path/config_missing_12345.json")
        self.assertEqual(config.config, {})


class TestConfigGet(unittest.TestCase):
    """Tests for Config.get()."""

    def setUp(self):
        data = {"locale": "en_us", "connect_timeout": 10}
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as f:
            json.dump(data, f)
            self.tmp_path = f.name
        self.config = Config(self.tmp_path)

    def tearDown(self):
        os.unlink(self.tmp_path)

    def test_get_existing_key(self):
        self.assertEqual(self.config.get("locale"), "en_us")

    def test_get_missing_key_returns_none(self):
        self.assertIsNone(self.config.get("nonexistent"))

    def test_get_missing_key_with_default(self):
        self.assertEqual(self.config.get("nonexistent", "fallback"), "fallback")

    def test_get_existing_key_ignores_default(self):
        self.assertEqual(self.config.get("locale", "fallback"), "en_us")


class TestConfigSetScalar(unittest.TestCase):
    """Tests for Config.set() with scalar values."""

    def setUp(self):
        data = {"locale": "en_us"}
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as f:
            json.dump(data, f)
            self.tmp_path = f.name
        self.config = Config(self.tmp_path)

    def tearDown(self):
        os.unlink(self.tmp_path)

    def test_set_new_scalar_value(self):
        self.config.set("connect_timeout", 20)
        self.assertEqual(self.config.get("connect_timeout"), 20)

    def test_set_overwrites_existing_scalar(self):
        self.config.set("locale", "ja_jp")
        self.assertEqual(self.config.get("locale"), "ja_jp")

    def test_set_string_value(self):
        self.config.set("template", "rjcode work_name")
        self.assertEqual(self.config.get("template"), "rjcode work_name")

    def test_set_boolean_value(self):
        self.config.set("save_cover_jpg", False)
        self.assertFalse(self.config.get("save_cover_jpg"))


class TestConfigSetDictMerges(unittest.TestCase):
    """Tests for Config.set() with dict values -- merges instead of replacing."""

    def setUp(self):
        data = {
            "features": {
                "enable_folder_rename": False,
                "enable_file_rename": False,
                "enable_metadata_update": False,
            }
        }
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as f:
            json.dump(data, f)
            self.tmp_path = f.name
        self.config = Config(self.tmp_path)

    def tearDown(self):
        os.unlink(self.tmp_path)

    def test_set_dict_merges_into_existing(self):
        self.config.set("features", {"enable_folder_rename": True})
        features = self.config.get("features")
        # The updated key should be True
        self.assertTrue(features["enable_folder_rename"])
        # The untouched keys should remain
        self.assertFalse(features["enable_file_rename"])
        self.assertFalse(features["enable_metadata_update"])

    def test_set_dict_adds_new_key_to_existing(self):
        self.config.set("features", {"enable_transcription": True})
        features = self.config.get("features")
        self.assertTrue(features["enable_transcription"])
        # Original keys still intact
        self.assertFalse(features["enable_folder_rename"])

    def test_set_dict_creates_new_key_if_absent(self):
        self.config.set("playlist_settings", {"create_genre_playlists": True})
        settings = self.config.get("playlist_settings")
        self.assertTrue(settings["create_genre_playlists"])


class TestConfigObserverNotification(unittest.TestCase):
    """Tests that setting a value triggers observer notification."""

    def setUp(self):
        data = {"locale": "en_us"}
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as f:
            json.dump(data, f)
            self.tmp_path = f.name
        self.config = Config(self.tmp_path)

    def tearDown(self):
        os.unlink(self.tmp_path)

    def test_observer_notified_on_set(self):
        callback = MagicMock()
        self.config.subscribe_to_changes(callback)

        self.config.set("locale", "ja_jp")

        callback.assert_called_once_with("locale", "ja_jp")

    def test_observer_notified_with_dict_value(self):
        callback = MagicMock()
        self.config.subscribe_to_changes(callback)

        new_features = {"enable_transcription": True}
        self.config.set("features", new_features)

        # Observer receives the original value passed to set(), not the merged result
        callback.assert_called_once_with("features", new_features)

    def test_multiple_observers_all_notified(self):
        cb1 = MagicMock()
        cb2 = MagicMock()
        self.config.subscribe_to_changes(cb1)
        self.config.subscribe_to_changes(cb2)

        self.config.set("locale", "ko_kr")

        cb1.assert_called_once_with("locale", "ko_kr")
        cb2.assert_called_once_with("locale", "ko_kr")


class TestConfigSaveConfig(unittest.TestCase):
    """Tests that save_config writes JSON to disk."""

    def setUp(self):
        data = {"locale": "en_us", "connect_timeout": 10}
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as f:
            json.dump(data, f)
            self.tmp_path = f.name
        self.config = Config(self.tmp_path)

    def tearDown(self):
        os.unlink(self.tmp_path)

    def test_save_config_writes_valid_json(self):
        self.config.config["new_key"] = "new_value"
        self.config.save_config()

        with open(self.tmp_path, "r", encoding="utf-8") as f:
            saved = json.load(f)

        self.assertEqual(saved["new_key"], "new_value")
        self.assertEqual(saved["locale"], "en_us")

    def test_set_persists_to_disk(self):
        """set() calls save_config internally, so changes should be on disk."""
        self.config.set("locale", "fr_fr")

        with open(self.tmp_path, "r", encoding="utf-8") as f:
            saved = json.load(f)

        self.assertEqual(saved["locale"], "fr_fr")

    def test_save_config_preserves_unicode(self):
        self.config.config["work_name"] = "\u30c6\u30b9\u30c8\u4f5c\u54c1"
        self.config.save_config()

        with open(self.tmp_path, "r", encoding="utf-8") as f:
            saved = json.load(f)

        self.assertEqual(saved["work_name"], "\u30c6\u30b9\u30c8\u4f5c\u54c1")


class TestConfigProgress(unittest.TestCase):
    """Tests for update_progress and get_progress."""

    def setUp(self):
        data = {}
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as f:
            json.dump(data, f)
            self.tmp_path = f.name
        self.config = Config(self.tmp_path)

    def tearDown(self):
        os.unlink(self.tmp_path)

    def test_initial_progress_is_zero(self):
        progress = self.config.get_progress()
        self.assertEqual(progress["processed"], 0)
        self.assertEqual(progress["total"], 0)

    def test_update_progress(self):
        self.config.update_progress(5, 10)
        progress = self.config.get_progress()
        self.assertEqual(progress["processed"], 5)
        self.assertEqual(progress["total"], 10)

    def test_update_progress_overrides_previous(self):
        self.config.update_progress(3, 10)
        self.config.update_progress(7, 10)
        progress = self.config.get_progress()
        self.assertEqual(progress["processed"], 7)
        self.assertEqual(progress["total"], 10)

    def test_update_progress_notifies_observer(self):
        callback = MagicMock()
        self.config.subscribe_to_changes(callback)

        self.config.update_progress(5, 10)

        callback.assert_called_once_with(
            "processing_stats", {"processed": 5, "total": 10}
        )


class TestConfigSubscribeToChanges(unittest.TestCase):
    """Tests for subscribe_to_changes convenience method."""

    def setUp(self):
        data = {}
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as f:
            json.dump(data, f)
            self.tmp_path = f.name
        self.config = Config(self.tmp_path)

    def tearDown(self):
        os.unlink(self.tmp_path)

    def test_subscribe_to_changes_registers_on_observer(self):
        callback = MagicMock()
        self.config.subscribe_to_changes(callback)
        self.assertIn(callback, self.config.observer.callbacks)

    def test_subscribe_multiple_callbacks(self):
        cb1 = MagicMock()
        cb2 = MagicMock()
        self.config.subscribe_to_changes(cb1)
        self.config.subscribe_to_changes(cb2)
        self.assertEqual(len(self.config.observer.callbacks), 2)


if __name__ == "__main__":
    unittest.main()
