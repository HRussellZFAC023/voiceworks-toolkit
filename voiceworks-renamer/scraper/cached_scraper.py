import json
import logging
import hashlib
import time
import traceback
from typing import List, Optional, Union, Tuple
from contextlib import contextmanager
from peewee import OperationalError
from config_types import Config
from scraper.scraper import Scraper
from scraper.translator import Translator
from scraper.db import db, WorkCache
from threading import Lock


class CachedScraper(Scraper):
    def __init__(self, config: Config):
        super().__init__(config)
        self.logger = logging.getLogger()
        self.config = config
        self._initialized = False
        self.translator = Translator(self)
        self._cache = {}  # In-memory cache replacing broken @lru_cache
        self._cache_lock = Lock()
        self._max_cache_size = 1024

    def initialize(self):
        """Initialize database connection."""
        if not self._initialized:
            self._initialize_db()

    def _initialize_db(self):
        """Helper function to initialize DB."""
        try:
            with db.connection_context():
                db.create_tables([WorkCache], safe=True)
                self._initialized = True
        except Exception as e:
            self._log_error("Failed to initialize CachedScraper", e)

    def _close_db(self):
        """Helper function to close DB connection."""
        try:
            db.close()
            self._initialized = False
        except Exception as e:
            self._log_error("Error during cleanup", e)

    def _evict_cache_if_needed(self):
        """Evict oldest entries if cache exceeds max size."""
        if len(self._cache) > self._max_cache_size:
            # Remove oldest 25% of entries
            to_remove = len(self._cache) // 4
            keys_to_remove = list(self._cache.keys())[:to_remove]
            for key in keys_to_remove:
                del self._cache[key]

    def _get_from_memory_cache(self, cache_key: str):
        """Thread-safe in-memory cache lookup."""
        with self._cache_lock:
            return self._cache.get(cache_key)

    def _set_memory_cache(self, cache_key: str, value):
        """Thread-safe in-memory cache store."""
        with self._cache_lock:
            self._evict_cache_if_needed()
            self._cache[cache_key] = value

    def _db_get(self, cache_key: str):
        """Get cached data from database with retry."""
        max_retries = 3
        retry_delay = 0.1
        for attempt in range(max_retries):
            try:
                with db.connection_context():
                    cache = WorkCache.get_or_none(WorkCache.cacheKey == cache_key)
                    if cache:
                        return json.loads(cache.cacheData)
                return None
            except OperationalError as e:
                if "database is locked" in str(e) and attempt < max_retries - 1:
                    time.sleep(retry_delay)
                    retry_delay *= 2
                else:
                    raise
        return None

    def _db_set(self, cache_key: str, value):
        """Store data in database with retry."""
        max_retries = 3
        retry_delay = 0.1
        for attempt in range(max_retries):
            try:
                with db.connection_context():
                    WorkCache.replace(
                        cacheKey=cache_key,
                        cacheData=json.dumps(value, ensure_ascii=False),
                    ).execute()
                return
            except OperationalError as e:
                if "database is locked" in str(e) and attempt < max_retries - 1:
                    time.sleep(retry_delay)
                    retry_delay *= 2
                else:
                    raise

    def _get_cached_data(self, cache_key: str):
        """Get cached data: memory first, then database."""
        # Check memory cache first
        result = self._get_from_memory_cache(cache_key)
        if result is not None:
            return result

        # Check database
        try:
            result = self._db_get(cache_key)
            if result is not None:
                self._set_memory_cache(cache_key, result)
                return result
        except Exception as e:
            self._log_error("Database read failed", e)

        return None

    def _cache_result(self, cache_key: str, func_result_getter):
        """Retrieve result from cache or execute function and cache result."""
        try:
            cached_data = self._get_cached_data(cache_key)
            if cached_data is not None:
                return cached_data

            # Execute the function to get fresh data
            result = func_result_getter()
            if result is not None:
                self._set_memory_cache(cache_key, result)
                try:
                    self._db_set(cache_key, result)
                except Exception as e:
                    self._log_error("Database write failed (result still usable)", e)
            return result
        except Exception as e:
            self._log_error("Cache operation failed", e)
            return func_result_getter()  # Fallback to direct execution

    def _log_error(self, message: str, error: Exception):
        """Log errors to the logger."""
        self.logger.error("%s: %s", message, error)
        traceback.print_exc()

    def _generate_cache_key(self, prefix: str, content: str) -> str:
        """Generate a short cache key by hashing content."""
        return f"{prefix}_{hashlib.md5(content.encode()).hexdigest()[:8]}"

    def scrape_metadata(
        self, rjcode: str, fetch_summary: bool, translate_summary: bool
    ):
        cache_key = f"SCRAPE_METADATA_{rjcode}_{fetch_summary}_{translate_summary}"
        return self._cache_result(
            cache_key,
            lambda: Scraper.scrape_metadata(self, rjcode, fetch_summary, translate_summary),
        )

    def translate(
        self, texts: Union[str, List[str]], target_language: str, rjcode: str
    ) -> Union[str, List[str]]:
        """Unified translation method with caching."""
        if not texts:
            return texts

        # Handle both string and list inputs for cache key
        if isinstance(texts, str):
            texts_for_hash = [texts]
        else:
            texts_for_hash = texts

        # Create a deterministic hash of the texts for cache key
        texts_hash = hashlib.md5(
            "".join(sorted(texts_for_hash)).encode()
        ).hexdigest()
        cache_key = f"TRANSLATE_{rjcode}_{target_language}_{texts_hash}"

        # Try to get from cache first
        cached_result = self._get_cached_data(cache_key)
        if cached_result is not None:
            return cached_result

        # If not in cache, translate and cache the result
        try:
            translated = self.translator.translate(texts, target_language, rjcode)
            if translated:
                # Store in both memory and db cache
                self._set_memory_cache(cache_key, translated)
                try:
                    self._db_set(cache_key, translated)
                except Exception as e:
                    self._log_error("Failed to cache translation in DB", e)
                return translated
        except Exception as e:
            self.logger.error(
                "[%s] -> Translation failed: %s", rjcode, str(e), exc_info=True
            )
            return texts

        return texts
