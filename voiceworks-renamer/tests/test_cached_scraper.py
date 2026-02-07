"""Comprehensive tests for the CachedScraper class."""
import sys
import json
import hashlib
import threading
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

# ---------------------------------------------------------------------------
# Ensure project root is on sys.path
# ---------------------------------------------------------------------------
sys.path.insert(0, str(Path(__file__).parent.parent))

# ---------------------------------------------------------------------------
# Stub heavy third-party modules BEFORE any project code is imported.
# Using MagicMock ensures any attribute access (e.g. aiohttp.ClientSession,
# requests.get) succeeds automatically.  Only peewee is installed for real
# because CachedScraper directly uses peewee.OperationalError.
# ---------------------------------------------------------------------------
_STUB_MODULES = [
    "aiohttp",
    "requests",
    "pyquery",
    "googletrans",
    "langdetect",
    "mutagen",
    "PIL",
    "wx",
    "ffmpeg",
    "faster_whisper",
    "torch",
    "torchvision",
    "torchaudio",
    "urllib3",
    "urllib3.exceptions",
]

for _mod_name in _STUB_MODULES:
    if _mod_name not in sys.modules:
        sys.modules[_mod_name] = MagicMock()

# Now it's safe to import project code
from tests.conftest import make_config, make_sample_metadata  # noqa: E402
from scraper.cached_scraper import CachedScraper  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _patch_externals():
    """Patch DB, WorkCache, Translator, and Scraper.__init__ for every test."""
    with patch("scraper.cached_scraper.db") as mock_db, \
         patch("scraper.cached_scraper.WorkCache") as mock_wc, \
         patch("scraper.cached_scraper.Translator") as mock_translator_cls, \
         patch("scraper.scraper.Scraper.__init__", return_value=None):
        # db.connection_context returns a no-op context manager
        ctx = MagicMock()
        ctx.__enter__ = MagicMock(return_value=None)
        ctx.__exit__ = MagicMock(return_value=False)
        mock_db.connection_context.return_value = ctx
        # WorkCache.get_or_none defaults to cache miss
        mock_wc.get_or_none.return_value = None
        # WorkCache.replace().execute() is a no-op
        mock_wc.replace.return_value.execute.return_value = None
        # Translator instance stub
        mock_translator_inst = MagicMock()
        mock_translator_cls.return_value = mock_translator_inst
        yield {
            "db": mock_db,
            "WorkCache": mock_wc,
            "Translator": mock_translator_cls,
            "translator": mock_translator_inst,
        }


@pytest.fixture
def config():
    """Return a plain-dict config suitable for CachedScraper."""
    return make_config()


@pytest.fixture
def scraper(config):
    """Return a fresh CachedScraper instance with all externals mocked."""
    return CachedScraper(config)


# ===========================================================================
# 1. Memory cache: get / set / thread safety / eviction
# ===========================================================================

class TestMemoryCache:
    """Tests for _get_from_memory_cache and _set_memory_cache."""

    def test_get_returns_none_for_missing_key(self, scraper):
        assert scraper._get_from_memory_cache("nonexistent") is None

    def test_set_then_get_returns_value(self, scraper):
        scraper._set_memory_cache("key1", {"data": 42})
        assert scraper._get_from_memory_cache("key1") == {"data": 42}

    def test_overwrite_existing_key(self, scraper):
        scraper._set_memory_cache("key1", "old")
        scraper._set_memory_cache("key1", "new")
        assert scraper._get_from_memory_cache("key1") == "new"

    def test_multiple_keys_independent(self, scraper):
        scraper._set_memory_cache("a", 1)
        scraper._set_memory_cache("b", 2)
        assert scraper._get_from_memory_cache("a") == 1
        assert scraper._get_from_memory_cache("b") == 2

    def test_stores_various_types(self, scraper):
        scraper._set_memory_cache("str", "hello")
        scraper._set_memory_cache("list", [1, 2, 3])
        scraper._set_memory_cache("dict", {"nested": True})
        scraper._set_memory_cache("int", 99)
        assert scraper._get_from_memory_cache("str") == "hello"
        assert scraper._get_from_memory_cache("list") == [1, 2, 3]
        assert scraper._get_from_memory_cache("dict") == {"nested": True}
        assert scraper._get_from_memory_cache("int") == 99


class TestMemoryCacheThreadSafety:
    """Concurrent access should not corrupt internal state."""

    def test_concurrent_writes_do_not_crash(self, scraper):
        errors = []

        def writer(tid):
            try:
                for i in range(200):
                    scraper._set_memory_cache(f"t{tid}_k{i}", i)
            except Exception as exc:
                errors.append(exc)

        threads = [threading.Thread(target=writer, args=(t,)) for t in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert errors == [], f"Concurrent writes raised: {errors}"

    def test_concurrent_reads_and_writes(self, scraper):
        # Pre-populate
        for i in range(100):
            scraper._set_memory_cache(f"k{i}", i)

        errors = []

        def reader():
            try:
                for i in range(100):
                    scraper._get_from_memory_cache(f"k{i}")
            except Exception as exc:
                errors.append(exc)

        def writer():
            try:
                for i in range(100, 200):
                    scraper._set_memory_cache(f"k{i}", i)
            except Exception as exc:
                errors.append(exc)

        threads = (
            [threading.Thread(target=reader) for _ in range(4)]
            + [threading.Thread(target=writer) for _ in range(4)]
        )
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert errors == [], f"Concurrent read/write raised: {errors}"


class TestCacheEviction:
    """Tests for _evict_cache_if_needed."""

    def test_no_eviction_at_max_size(self, scraper):
        """When cache size equals max, no eviction occurs (> not >=)."""
        scraper._max_cache_size = 10
        for i in range(10):
            scraper._set_memory_cache(f"k{i}", i)
        assert len(scraper._cache) == 10

    def test_eviction_removes_oldest_quarter(self, scraper):
        scraper._max_cache_size = 10
        # Populate 11 entries directly (bypasses eviction check in _set)
        for i in range(11):
            scraper._cache[f"k{i}"] = i
        # At 11 entries (>10), next _set_memory_cache triggers eviction
        scraper._set_memory_cache("new_key", "new_value")
        # 11 entries => evict 11//4 = 2 oldest, then add 1 => 10 total
        assert len(scraper._cache) <= scraper._max_cache_size + 1
        # The first two keys (k0, k1) should have been removed
        assert scraper._get_from_memory_cache("k0") is None
        assert scraper._get_from_memory_cache("k1") is None
        # Later keys and the new key survive
        assert scraper._get_from_memory_cache("k10") == 10
        assert scraper._get_from_memory_cache("new_key") == "new_value"

    def test_eviction_with_very_small_max(self, scraper):
        """Edge case: max=1, inserting 2 items."""
        scraper._max_cache_size = 1
        scraper._set_memory_cache("first", 1)
        assert len(scraper._cache) == 1
        # Second insert: len(1) > max(1) is False, so no eviction
        scraper._set_memory_cache("second", 2)
        assert scraper._get_from_memory_cache("second") == 2

    def test_large_eviction(self, scraper):
        scraper._max_cache_size = 100
        for i in range(200):
            scraper._cache[f"k{i}"] = i
        # 200 entries > 100, evict 200//4=50, then add 1 => 151
        scraper._set_memory_cache("trigger", "val")
        assert len(scraper._cache) == 151

    def test_eviction_preserves_newest_entries(self, scraper):
        scraper._max_cache_size = 4
        for i in range(5):
            scraper._cache[f"k{i}"] = i
        # 5 entries > 4, evict 5//4=1 oldest (k0), then add 'latest'
        scraper._set_memory_cache("latest", 999)
        assert scraper._get_from_memory_cache("k0") is None
        assert scraper._get_from_memory_cache("latest") == 999
        assert scraper._get_from_memory_cache("k4") == 4


# ===========================================================================
# 2. Cache lookup order: memory -> DB -> fresh computation
# ===========================================================================

class TestGetCachedData:
    """Tests for _get_cached_data lookup order."""

    def test_returns_from_memory_cache_first(self, scraper, _patch_externals):
        scraper._set_memory_cache("my_key", {"source": "memory"})
        result = scraper._get_cached_data("my_key")
        assert result == {"source": "memory"}
        # DB should NOT have been queried
        _patch_externals["WorkCache"].get_or_none.assert_not_called()

    def test_falls_back_to_db_on_memory_miss(self, scraper, _patch_externals):
        mock_cache_row = MagicMock()
        mock_cache_row.cacheData = json.dumps({"source": "db"})
        _patch_externals["WorkCache"].get_or_none.return_value = mock_cache_row

        result = scraper._get_cached_data("db_key")
        assert result == {"source": "db"}
        # Should also be promoted into memory cache
        assert scraper._get_from_memory_cache("db_key") == {"source": "db"}

    def test_returns_none_when_both_miss(self, scraper, _patch_externals):
        _patch_externals["WorkCache"].get_or_none.return_value = None
        result = scraper._get_cached_data("absent_key")
        assert result is None

    def test_returns_none_on_db_exception(self, scraper, _patch_externals):
        """DB errors are caught; method returns None rather than raising."""
        _patch_externals["WorkCache"].get_or_none.side_effect = Exception("db crashed")
        result = scraper._get_cached_data("err_key")
        assert result is None


# ===========================================================================
# 3. _cache_result: cache-or-compute pattern
# ===========================================================================

class TestCacheResult:
    """Tests for _cache_result."""

    def test_calls_getter_on_cache_miss(self, scraper):
        getter = MagicMock(return_value={"computed": True})
        result = scraper._cache_result("miss_key", getter)
        assert result == {"computed": True}
        getter.assert_called_once()

    def test_returns_cached_on_second_call(self, scraper):
        call_count = 0

        def getter():
            nonlocal call_count
            call_count += 1
            return {"value": call_count}

        first = scraper._cache_result("key", getter)
        second = scraper._cache_result("key", getter)
        assert first == {"value": 1}
        assert second == {"value": 1}  # cached, not recomputed
        assert call_count == 1

    def test_does_not_cache_none_result(self, scraper):
        getter = MagicMock(return_value=None)
        result = scraper._cache_result("none_key", getter)
        assert result is None
        # Since None was not stored, second call re-invokes getter
        getter.return_value = {"now_available": True}
        result2 = scraper._cache_result("none_key", getter)
        assert result2 == {"now_available": True}

    def test_stores_in_memory_and_db(self, scraper, _patch_externals):
        getter = MagicMock(return_value={"data": 1})
        scraper._cache_result("persist_key", getter)
        # Memory cache should have the value
        assert scraper._get_from_memory_cache("persist_key") == {"data": 1}
        # DB write should have been attempted
        _patch_externals["WorkCache"].replace.assert_called()

    def test_survives_db_write_failure(self, scraper, _patch_externals):
        _patch_externals["WorkCache"].replace.return_value.execute.side_effect = (
            Exception("disk full")
        )
        getter = MagicMock(return_value={"data": "ok"})
        result = scraper._cache_result("fragile_key", getter)
        # Result should still be returned despite DB failure
        assert result == {"data": "ok"}
        # Memory cache should still have the value
        assert scraper._get_from_memory_cache("fragile_key") == {"data": "ok"}

    def test_fallback_to_direct_execution_on_total_failure(self, scraper):
        """If the entire cache machinery throws, fall back to getter()."""
        scraper._get_cached_data = MagicMock(side_effect=RuntimeError("broken"))
        getter = MagicMock(return_value={"fallback": True})
        result = scraper._cache_result("broken_key", getter)
        # The outer except calls getter() as fallback
        assert result == {"fallback": True}
        # getter called once in the try block (after _get_cached_data raised),
        # plus once in the except fallback
        assert getter.call_count == 2


# ===========================================================================
# 4. translate: string, list, empty inputs
# ===========================================================================

class TestTranslate:
    """Tests for the translate() method."""

    def test_empty_string_returns_empty_string(self, scraper):
        result = scraper.translate("", "en", "RJ123456")
        assert result == ""

    def test_empty_list_returns_empty_list(self, scraper):
        result = scraper.translate([], "en", "RJ123456")
        assert result == []

    def test_string_input_translated(self, scraper, _patch_externals):
        _patch_externals["translator"].translate.return_value = "translated text"
        result = scraper.translate("hello", "en", "RJ123456")
        assert result == "translated text"
        _patch_externals["translator"].translate.assert_called_once_with(
            "hello", "en", "RJ123456"
        )

    def test_list_input_translated(self, scraper, _patch_externals):
        _patch_externals["translator"].translate.return_value = ["one", "two"]
        result = scraper.translate(["a", "b"], "en", "RJ123456")
        assert result == ["one", "two"]

    def test_cached_translation_not_retranslated(self, scraper, _patch_externals):
        _patch_externals["translator"].translate.return_value = "cached translation"
        # First call -- should translate
        scraper.translate("text_to_cache", "en", "RJ111111")
        # Second call with identical args -- should hit cache
        result = scraper.translate("text_to_cache", "en", "RJ111111")
        assert result == "cached translation"
        # Translator should only have been invoked once
        assert _patch_externals["translator"].translate.call_count == 1

    def test_different_target_languages_cached_separately(self, scraper, _patch_externals):
        _patch_externals["translator"].translate.side_effect = [
            "english translation",
            "french translation",
        ]
        result_en = scraper.translate("text", "en", "RJ222222")
        result_fr = scraper.translate("text", "fr", "RJ222222")
        assert result_en == "english translation"
        assert result_fr == "french translation"
        assert _patch_externals["translator"].translate.call_count == 2

    def test_different_rjcodes_cached_separately(self, scraper, _patch_externals):
        _patch_externals["translator"].translate.side_effect = [
            "result_a",
            "result_b",
        ]
        result_a = scraper.translate("text", "en", "RJ000001")
        result_b = scraper.translate("text", "en", "RJ000002")
        assert result_a == "result_a"
        assert result_b == "result_b"
        assert _patch_externals["translator"].translate.call_count == 2

    def test_translation_failure_returns_original_string(self, scraper, _patch_externals):
        _patch_externals["translator"].translate.side_effect = Exception("API down")
        result = scraper.translate("original text", "en", "RJ333333")
        assert result == "original text"

    def test_translation_failure_returns_original_list(self, scraper, _patch_externals):
        _patch_externals["translator"].translate.side_effect = Exception("API down")
        result = scraper.translate(["a", "b"], "en", "RJ333333")
        assert result == ["a", "b"]

    def test_translator_returns_falsy_result(self, scraper, _patch_externals):
        """If translator returns empty string, it is treated as falsy and the
        original texts are returned."""
        _patch_externals["translator"].translate.return_value = ""
        result = scraper.translate("hello", "en", "RJ444444")
        # translated is falsy => skips caching => returns original texts
        assert result == "hello"

    def test_cache_key_uses_sorted_hash(self, scraper, _patch_externals):
        """Verify cache key is deterministic using sorted text concatenation."""
        _patch_externals["translator"].translate.return_value = ["x", "y"]
        scraper.translate(["b", "a"], "en", "RJ555555")

        texts_hash = hashlib.md5("".join(sorted(["b", "a"])).encode()).hexdigest()
        expected_key = f"TRANSLATE_RJ555555_en_{texts_hash}"
        assert scraper._get_from_memory_cache(expected_key) == ["x", "y"]

    def test_none_input_returns_none(self, scraper):
        """None is falsy so the early return kicks in."""
        result = scraper.translate(None, "en", "RJ000000")
        assert result is None


# ===========================================================================
# 5. scrape_metadata: caching behaviour
# ===========================================================================

class TestScrapeMetadata:
    """Tests for scrape_metadata caching wrapper."""

    def test_scrape_metadata_caches_result(self, scraper):
        metadata = make_sample_metadata("RJ1234567")
        with patch(
            "scraper.cached_scraper.Scraper.scrape_metadata", return_value=metadata
        ) as mock_scrape:
            first = scraper.scrape_metadata("RJ1234567", True, False)
            second = scraper.scrape_metadata("RJ1234567", True, False)

        assert first == metadata
        assert second == metadata
        # Base scraper should have been called only once
        mock_scrape.assert_called_once()

    def test_scrape_metadata_cache_key_includes_flags(self, scraper):
        meta_a = make_sample_metadata("RJ0000001")
        meta_b = {**make_sample_metadata("RJ0000001"), "summary": "translated"}

        call_idx = 0

        def side_effect(*_args, **_kwargs):
            nonlocal call_idx
            call_idx += 1
            return meta_a if call_idx == 1 else meta_b

        with patch(
            "scraper.cached_scraper.Scraper.scrape_metadata", side_effect=side_effect
        ):
            result_a = scraper.scrape_metadata("RJ0000001", True, False)
            result_b = scraper.scrape_metadata("RJ0000001", True, True)

        # Different flags produce different cache keys => different results
        assert result_a == meta_a
        assert result_b == meta_b

    def test_scrape_metadata_returns_none_on_failure(self, scraper):
        with patch(
            "scraper.cached_scraper.Scraper.scrape_metadata", return_value=None
        ):
            result = scraper.scrape_metadata("RJ9999999", False, False)
        assert result is None

    def test_scrape_metadata_different_rjcodes_separate(self, scraper):
        meta1 = make_sample_metadata("RJ0000001")
        meta2 = make_sample_metadata("RJ0000002")

        with patch(
            "scraper.cached_scraper.Scraper.scrape_metadata",
            side_effect=[meta1, meta2],
        ):
            r1 = scraper.scrape_metadata("RJ0000001", False, False)
            r2 = scraper.scrape_metadata("RJ0000002", False, False)

        assert r1["rjcode"] == "RJ0000001"
        assert r2["rjcode"] == "RJ0000002"

    def test_scrape_metadata_cache_key_format(self, scraper):
        """Verify the exact cache key format used by scrape_metadata."""
        metadata = make_sample_metadata("RJ7777777")
        with patch(
            "scraper.cached_scraper.Scraper.scrape_metadata", return_value=metadata
        ):
            scraper.scrape_metadata("RJ7777777", True, False)

        expected_key = "SCRAPE_METADATA_RJ7777777_True_False"
        assert scraper._get_from_memory_cache(expected_key) == metadata


# ===========================================================================
# 6. DB layer: _db_get / _db_set with retry
# ===========================================================================

class TestDbLayer:
    """Tests for _db_get and _db_set with retry logic."""

    def test_db_get_returns_parsed_json(self, scraper, _patch_externals):
        mock_row = MagicMock()
        mock_row.cacheData = json.dumps({"key": "value"})
        _patch_externals["WorkCache"].get_or_none.return_value = mock_row
        result = scraper._db_get("some_key")
        assert result == {"key": "value"}

    def test_db_get_returns_none_on_miss(self, scraper, _patch_externals):
        _patch_externals["WorkCache"].get_or_none.return_value = None
        result = scraper._db_get("missing")
        assert result is None

    def test_db_get_retries_on_locked(self, scraper, _patch_externals):
        from peewee import OperationalError

        locked_err = OperationalError("database is locked")
        mock_row = MagicMock()
        mock_row.cacheData = json.dumps({"retried": True})
        _patch_externals["WorkCache"].get_or_none.side_effect = [
            locked_err,
            mock_row,
        ]
        result = scraper._db_get("retry_key")
        assert result == {"retried": True}
        assert _patch_externals["WorkCache"].get_or_none.call_count == 2

    def test_db_get_raises_after_max_retries(self, scraper, _patch_externals):
        from peewee import OperationalError

        locked_err = OperationalError("database is locked")
        _patch_externals["WorkCache"].get_or_none.side_effect = [
            locked_err,
            locked_err,
            locked_err,
        ]
        with pytest.raises(OperationalError):
            scraper._db_get("doomed_key")

    def test_db_get_raises_non_locked_error_immediately(self, scraper, _patch_externals):
        from peewee import OperationalError

        other_err = OperationalError("disk I/O error")
        _patch_externals["WorkCache"].get_or_none.side_effect = other_err
        with pytest.raises(OperationalError, match="disk I/O error"):
            scraper._db_get("bad_key")
        assert _patch_externals["WorkCache"].get_or_none.call_count == 1

    def test_db_set_calls_replace(self, scraper, _patch_externals):
        scraper._db_set("write_key", {"written": True})
        _patch_externals["WorkCache"].replace.assert_called_once()
        call_kwargs = _patch_externals["WorkCache"].replace.call_args[1]
        assert call_kwargs["cacheKey"] == "write_key"
        assert json.loads(call_kwargs["cacheData"]) == {"written": True}

    def test_db_set_retries_on_locked(self, scraper, _patch_externals):
        from peewee import OperationalError

        locked_err = OperationalError("database is locked")
        _patch_externals["WorkCache"].replace.return_value.execute.side_effect = [
            locked_err,
            None,  # success on second attempt
        ]
        scraper._db_set("retry_write", {"value": 1})
        assert _patch_externals["WorkCache"].replace.return_value.execute.call_count == 2

    def test_db_set_raises_after_max_retries(self, scraper, _patch_externals):
        from peewee import OperationalError

        locked_err = OperationalError("database is locked")
        _patch_externals["WorkCache"].replace.return_value.execute.side_effect = [
            locked_err,
            locked_err,
            locked_err,
        ]
        with pytest.raises(OperationalError):
            scraper._db_set("doomed_write", {"value": 1})

    def test_db_set_ensures_ascii_false(self, scraper, _patch_externals):
        scraper._db_set("unicode_key", {"name": "テスト"})
        call_kwargs = _patch_externals["WorkCache"].replace.call_args[1]
        # ensure_ascii=False keeps Japanese characters as-is
        assert "テスト" in call_kwargs["cacheData"]


# ===========================================================================
# 7. initialize / _initialize_db
# ===========================================================================

class TestInitialize:
    """Tests for initialize() and _initialize_db()."""

    def test_initialize_sets_flag(self, scraper, _patch_externals):
        assert scraper._initialized is False
        scraper.initialize()
        assert scraper._initialized is True

    def test_initialize_idempotent(self, scraper, _patch_externals):
        scraper.initialize()
        scraper.initialize()
        # create_tables should only be called once
        _patch_externals["db"].create_tables.assert_called_once()

    def test_initialize_handles_db_error(self, scraper, _patch_externals):
        _patch_externals["db"].create_tables.side_effect = Exception("init failed")
        scraper.initialize()  # should not raise
        assert scraper._initialized is False


# ===========================================================================
# 8. _generate_cache_key
# ===========================================================================

class TestGenerateCacheKey:
    """Tests for _generate_cache_key."""

    def test_deterministic(self, scraper):
        key1 = scraper._generate_cache_key("PREFIX", "content")
        key2 = scraper._generate_cache_key("PREFIX", "content")
        assert key1 == key2

    def test_different_content_different_key(self, scraper):
        key1 = scraper._generate_cache_key("P", "aaa")
        key2 = scraper._generate_cache_key("P", "bbb")
        assert key1 != key2

    def test_different_prefix_different_key(self, scraper):
        key1 = scraper._generate_cache_key("A", "same")
        key2 = scraper._generate_cache_key("B", "same")
        assert key1 != key2

    def test_format(self, scraper):
        key = scraper._generate_cache_key("META", "sample")
        expected_hash = hashlib.md5("sample".encode()).hexdigest()[:8]
        assert key == f"META_{expected_hash}"

    def test_unicode_content(self, scraper):
        key = scraper._generate_cache_key("TR", "テスト作品")
        expected_hash = hashlib.md5("テスト作品".encode()).hexdigest()[:8]
        assert key == f"TR_{expected_hash}"


# ===========================================================================
# 9. _close_db
# ===========================================================================

class TestCloseDb:
    """Tests for _close_db."""

    def test_close_resets_initialized(self, scraper, _patch_externals):
        scraper._initialized = True
        scraper._close_db()
        assert scraper._initialized is False
        _patch_externals["db"].close.assert_called_once()

    def test_close_handles_error(self, scraper, _patch_externals):
        _patch_externals["db"].close.side_effect = Exception("close error")
        scraper._initialized = True
        scraper._close_db()  # should not raise


# ===========================================================================
# 10. Integration-style: full round-trip through cache layers
# ===========================================================================

class TestIntegration:
    """End-to-end scenarios combining memory cache, DB, and compute."""

    def test_cold_start_to_warm_cache(self, scraper, _patch_externals):
        """First call computes, second call hits memory cache."""
        metadata = make_sample_metadata("RJ9876543")
        with patch(
            "scraper.cached_scraper.Scraper.scrape_metadata", return_value=metadata
        ) as mock_scrape:
            r1 = scraper.scrape_metadata("RJ9876543", False, False)
            r2 = scraper.scrape_metadata("RJ9876543", False, False)

        assert r1 == metadata
        assert r2 == metadata
        mock_scrape.assert_called_once()

    def test_db_warm_memory_cold(self, scraper, _patch_externals):
        """If memory is empty but DB has data, promote to memory and return."""
        db_data = {"rjcode": "RJ1111111", "work_name": "from_db"}
        mock_row = MagicMock()
        mock_row.cacheData = json.dumps(db_data)
        _patch_externals["WorkCache"].get_or_none.return_value = mock_row

        cache_key = "SCRAPE_METADATA_RJ1111111_False_False"
        result = scraper._get_cached_data(cache_key)
        assert result == db_data
        # Now it should be promoted to memory cache
        assert scraper._get_from_memory_cache(cache_key) == db_data

    def test_translate_then_scrape_use_independent_caches(self, scraper, _patch_externals):
        """Translation and metadata caches use distinct keys."""
        _patch_externals["translator"].translate.return_value = "translated"
        meta = make_sample_metadata("RJ5555555")

        with patch(
            "scraper.cached_scraper.Scraper.scrape_metadata", return_value=meta
        ):
            t_result = scraper.translate("hello", "en", "RJ5555555")
            m_result = scraper.scrape_metadata("RJ5555555", False, False)

        assert t_result == "translated"
        assert m_result == meta

    def test_eviction_does_not_corrupt_newer_entries(self, scraper, _patch_externals):
        """After eviction, recently added entries should still be accessible."""
        scraper._max_cache_size = 5
        metadata_list = []
        with patch("scraper.cached_scraper.Scraper.scrape_metadata") as mock_scrape:
            for i in range(10):
                m = make_sample_metadata(f"RJ{i:07d}")
                metadata_list.append(m)
                mock_scrape.return_value = m
                scraper.scrape_metadata(f"RJ{i:07d}", False, False)

        # The most recently added entry should still be in cache
        last_key = "SCRAPE_METADATA_RJ0000009_False_False"
        assert scraper._get_from_memory_cache(last_key) == metadata_list[-1]

    def test_multiple_translate_calls_mixed_types(self, scraper, _patch_externals):
        """Interleave string and list translates to verify no cross-talk."""
        _patch_externals["translator"].translate.side_effect = [
            "single_result",
            ["batch_a", "batch_b"],
            "another_single",
        ]
        r1 = scraper.translate("one", "en", "RJ100000")
        r2 = scraper.translate(["x", "y"], "en", "RJ200000")
        r3 = scraper.translate("two", "ja", "RJ300000")

        assert r1 == "single_result"
        assert r2 == ["batch_a", "batch_b"]
        assert r3 == "another_single"
        assert _patch_externals["translator"].translate.call_count == 3
