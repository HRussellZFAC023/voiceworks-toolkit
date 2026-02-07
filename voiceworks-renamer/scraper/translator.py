import logging
from concurrent.futures import ThreadPoolExecutor
from typing import List, Union
import re
from googletrans import Translator as GoogleTranslator
import time
import ssl
from requests import Timeout
from urllib3.exceptions import SSLError
import socket
from langdetect import detect_langs

MAX_TEXT_LENGTH = 1500
MAX_RETRIES = 20
INITIAL_DELAY = 1.0
SSL_EXCEPTIONS = (ssl.SSLError, SSLError, socket.error)


class Translator:
    """Handles all translation operations with multithreading and batching."""

    def __init__(self, cached_scraper):
        self.logger = logging.getLogger(__name__)
        self.cached_scraper = cached_scraper
        self._translator = GoogleTranslator()
        self.executor = ThreadPoolExecutor(max_workers=5)

    def translate(
        self, texts: Union[str, List[str]], target_language: str, rjcode: str
    ) -> Union[str, List[str]]:
        """Unified translation method for single or multiple texts."""
        if isinstance(texts, str):
            texts = [texts]
            single_input = True
        else:
            texts = texts[:]
            single_input = False

        if not texts:
            return texts if not single_input else ""

        # Only translate non-empty texts
        texts_to_translate = []
        indices_to_translate = []
        text_parts_count = []  # Keep track of how many parts each text splits into
        japanese_pattern = r"[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]"

        for idx, text in enumerate(texts):
            if not text.strip():
                continue
            # Only translate text containing Japanese characters
            if re.search(japanese_pattern, text):
                split_text = (
                    self._split_text(text) if len(text) > MAX_TEXT_LENGTH else [text]
                )
                texts_to_translate.extend(split_text)
                indices_to_translate.append(idx)
                text_parts_count.append(len(split_text))

        if not texts_to_translate:
            return texts if not single_input else texts[0]

        # Translate in batches
        translated_texts = []
        batches = self._prepare_batches(texts_to_translate)

        for batch in batches:
            translated_batch = self._translate_batch(batch, target_language, rjcode)
            translated_texts.extend(translated_batch)

        # Merge translations back into original list
        idx = 0
        for text_idx, parts_count in zip(indices_to_translate, text_parts_count):
            parts = translated_texts[idx : idx + parts_count]
            texts[text_idx] = "".join(parts)
            idx += parts_count

        return texts if not single_input else texts[0]

    def detect_language(self, text: str) -> str:
        """Detects text language using langdetect library."""

        if not text.strip():
            return ""

        # Get language probabilities
        langs = detect_langs(text)
        # Return most probable language
        return langs[0].lang

    def _prepare_batches(self, texts: List[str]) -> List[List[str]]:
        batches = []
        current_batch = []
        current_length = 0
        for text in texts:
            text_length = len(text)
            if text_length > MAX_TEXT_LENGTH:
                # Split text into smaller chunks
                chunks = self._split_text(text)
                for chunk in chunks:
                    if len(chunk) > MAX_TEXT_LENGTH:
                        self.logger.warning(
                            "Chunk exceeds maximum length and will be skipped."
                        )
                        continue
                    if current_length + len(chunk) > MAX_TEXT_LENGTH:
                        if current_batch:
                            batches.append(current_batch)
                        current_batch = [chunk]
                        current_length = len(chunk)
                    else:
                        current_batch.append(chunk)
                        current_length += len(chunk)
            else:
                if current_length + text_length > MAX_TEXT_LENGTH:
                    if current_batch:
                        batches.append(current_batch)
                    current_batch = [text]
                    current_length = text_length
                else:
                    current_batch.append(text)
                    current_length += text_length
        if current_batch:
            batches.append(current_batch)
        return batches

    def _split_text(self, text: str) -> List[str]:
        """Split text into chunks at natural boundaries not exceeding MAX_TEXT_LENGTH."""
        sentences = re.split(r"(?<=[。.!?！？\n])", text)
        chunks = []
        current_chunk = ""
        for sentence in sentences:
            if len(sentence) > MAX_TEXT_LENGTH:
                # Force split if a single sentence is too long
                forced_chunks = [
                    sentence[i : i + MAX_TEXT_LENGTH]
                    for i in range(0, len(sentence), MAX_TEXT_LENGTH)
                ]
                if current_chunk:
                    chunks.append(current_chunk)
                    current_chunk = ""
                chunks.extend(forced_chunks)
            elif len(current_chunk) + len(sentence) > MAX_TEXT_LENGTH:
                if current_chunk:
                    chunks.append(current_chunk)
                current_chunk = sentence
            else:
                current_chunk += sentence

        if current_chunk:
            chunks.append(current_chunk)

        return chunks

    def _translate_batch(
        self, texts: List[str], target_language: str, rjcode: str
    ) -> List[str]:
        """Translate a batch of texts with exponential backoff retry."""
        MAX_RETRIES = self.cached_scraper.config.get("read_timeout", 5)
        INITIAL_DELAY = self.cached_scraper.config.get("sleep_interval", 1)
        backoff_factor = 2
        delay = INITIAL_DELAY
        translator = GoogleTranslator()

        # Optional: Define batch size if the API has limitations
        BATCH_SIZE = 50  # Adjust based on API limits

        translated_texts = [""] * len(texts)  # Placeholder for translated texts
        texts_to_translate = texts.copy()  # Copy of texts to manipulate
        indices_to_translate = list(range(len(texts)))  # Indices corresponding to texts

        for attempt in range(1, MAX_RETRIES + 1):
            try:
                if not texts_to_translate:
                    break  # All texts have been translated

                # Process texts in batches if necessary
                for i in range(0, len(texts_to_translate), BATCH_SIZE):
                    batch_texts = texts_to_translate[i : i + BATCH_SIZE]
                    batch_indices = indices_to_translate[i : i + BATCH_SIZE]

                    results = translator.translate(
                        batch_texts, dest=target_language, src="ja"
                    )

                    if not isinstance(results, list):
                        results = [results]

                    if len(results) != len(batch_texts):
                        self.logger.warning(
                            "[%s] Mismatch in translation results: expected %d, got %d",
                            rjcode,
                            len(batch_texts),
                            len(results),
                        )
                        # Skip this batch and retry
                        raise ValueError("Mismatch in translation results")

                    # Store translated texts in the correct positions
                    for idx, result in zip(batch_indices, results):
                        translated_texts[idx] = result.text

                return translated_texts  # Successful translation

            except (SSLError, ConnectionError, Timeout) as e:
                self.logger.warning(
                    "[%s] Network error during translation attempt %d/%d: %s",
                    rjcode,
                    attempt,
                    MAX_RETRIES,
                    str(e),
                )
                # Reinitialize translator if necessary
                translator = GoogleTranslator()

            except Exception as e:
                last_error = e
                self.logger.error(
                    "[%s] Error during translation attempt %d/%d: %s",
                    rjcode,
                    attempt,
                    MAX_RETRIES,
                    str(e),
                )
                break

            if attempt < MAX_RETRIES:
                time.sleep(delay)
                delay *= backoff_factor
            else:
                self.logger.error(
                    "[%s] Max retries reached for translation.", rjcode,
                )
                break

        # Return texts with translated parts filled in, others remain original
        return [
            translated if translated else original
            for translated, original in zip(translated_texts, texts)
        ]

    def _apply_translation_map(self, text: str, translation_map: dict) -> str:
        """Apply custom translations from translation map."""
        for key, value in translation_map.items():
            pattern = rf"\b{re.escape(key)}\b"
            text = re.sub(pattern, value, text)
        return text

    def shutdown(self):
        """Clean up resources."""
        self.executor.shutdown(wait=True)
