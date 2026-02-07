import asyncio
import aiohttp
import contextlib
import logging
import os
from typing import Tuple, Union, List
from urllib.request import getproxies

import requests
from pyquery import PyQuery as pq
from config_types import Config
from scraper.dlsite import Dlsite
from scraper.locale import Locale
from scraper.work_metadata import WorkMetadata


def _get_system_proxies():
    """
    Retrieve system proxies and adjust as needed.
    """
    proxies = getproxies()
    https_proxy = proxies.get("https")
    http_proxy = proxies.get("http")
    if https_proxy and https_proxy.startswith("https://"):
        proxies["https"] = http_proxy
    return proxies


class Scraper:
    """Scraper class for scraping metadata and other information from Dlsite."""

    def __init__(self, config: Config):
        self.__logger = logging.getLogger(__name__)
        self.__config = config
        self.__locale = Locale(self.__config.get("locale"))
        self.__connect_timeout = self.__config.get(
            "connect_timeout",
        )
        self.__read_timeout = self.__config.get(
            "read_timeout",
        )
        self.__sleep_interval = self.__config.get(
            "sleep_interval",
        )
        self.__proxies = (
            self.__config.get(
                "http_proxy",
            )
            or _get_system_proxies()
        )

    async def __request_concurrent(self, rjcode: str) -> Tuple[dict, str]:
        """Make concurrent requests to both API and work page."""
        timeout = aiohttp.ClientTimeout(total=60)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            api_task = asyncio.create_task(
                self.__request_product_api_async(session, rjcode)
            )
            page_task = asyncio.create_task(
                self.__request_work_page_async(session, rjcode)
            )
            # Use return_exceptions to handle partial failures gracefully
            results = await asyncio.gather(
                api_task, page_task, return_exceptions=True
            )

            api_data = results[0]
            page_html = results[1]

            # Raise API errors (critical), but tolerate page errors
            if isinstance(api_data, Exception):
                raise api_data
            if isinstance(page_html, Exception):
                self.__logger.warning(
                    "[%s] -> Work page request failed: %s", rjcode, page_html
                )
                page_html = ""

            return api_data, page_html

    async def __request_product_api_async(
        self, session: aiohttp.ClientSession, rjcode: str
    ):
        """Async version of product API request."""
        url = Dlsite.compile_product_api_url(rjcode)
        params = {"locale": self.__locale.name}
        connect_timeout = self.__connect_timeout or 30
        async with session.get(
            url, params=params, timeout=aiohttp.ClientTimeout(total=connect_timeout)
        ) as response:
            response.raise_for_status()
            data = await response.json()
            if not data:
                raise ValueError("Empty response from API")
            return data[0]

    async def __request_work_page_async(
        self, session: aiohttp.ClientSession, rjcode: str
    ):
        """Async version of work page request."""
        url = Dlsite.compile_work_page_url(rjcode)
        params = {"locale": self.__locale.name}
        connect_timeout = self.__connect_timeout or 30
        try:
            async with session.get(
                url, params=params, timeout=aiohttp.ClientTimeout(total=connect_timeout)
            ) as response:
                response.raise_for_status()
                return await response.text()
        except aiohttp.ClientResponseError as e:
            if e.status == 404:
                self.__logger.warning("[%s] -> Work page not found (404)", rjcode)
                return ""
            else:
                raise

    def extract_product_summary(self, rjcode: str, html: str) -> str:
        """Extract product summary from HTML content."""
        self.__logger.info("[%s] -> Extracting product summary", rjcode)
        if not html:
            return ""
        d = pq(html)
        summary = d("#intro, #work_outline, .work_parts_container").text()
        return summary.strip() if summary else ""

    def scrape_metadata(
        self,
        rjcode: str,
        fetch_summary: bool,
        translate_summary: bool,
    ) -> WorkMetadata:
        self.__logger.info("[%s] -> Scraping metadata", rjcode)
        rjcode = rjcode.upper()
        if not Dlsite.WORKNO_PATTERN.fullmatch(rjcode):
            self.__logger.error("[%s] -> Invalid RJ code", rjcode)
            raise ValueError(f"Invalid RJ code: {rjcode}")

        api_data, html = asyncio.run(self.__request_concurrent(rjcode))
        metadata = self.__extract_metadata_from_api(rjcode, api_data)

        # Always try to get detailed summary first
        summary = self.extract_product_summary(rjcode, html) if fetch_summary else ""
        metadata["summary"] = summary or metadata.get(
            "intro_s", ""
        )  # Fallback to intro_s if no summary

        self.__logger.info("[%s] -> Metadata scraped successfully", rjcode)
        return metadata

    def __extract_metadata_from_api(
        self, rjcode: str, product_info: dict = None
    ) -> dict:
        """Extract metadata from API response."""
        self.__logger.info("[%s] -> Processing metadata from API", rjcode)

        if not product_info:
            self.__logger.warning("[%s] -> Empty product info from API", rjcode)
            product_info = {}

        # Helper function to safely split strings
        def safe_split(value: str, delimiter: str = "#") -> List[str]:
            if not value or not isinstance(value, str):
                return []
            return [x for x in value.split(delimiter) if x]

        # Extract CVs with corrected extraction
        cvs = []
        if isinstance(product_info.get("creaters"), dict):
            # Extract from voice_by list
            for cv in product_info["creaters"].get("voice_by", []):
                if isinstance(cv, dict) and "name" in cv:
                    cvs.append(cv["name"])

        metadata = {
            # Basic fields with empty string defaults
            "rjcode": rjcode,
            "work_name": product_info.get("work_name", ""),
            "maker_id": product_info.get("maker_id", ""),
            "maker_name": product_info.get("maker_name", ""),
            "release_date": (product_info.get("regist_date", "") or "")[:10],
            "series_id": product_info.get("series_id", ""),
            "series_name": product_info.get("series_name", ""),
            "age": self.get_age(
                product_info.get("age_category")
            ),  # Use 'age' instead of 'age'
            # Fields that need safe splitting
            "options": safe_split(product_info.get("options")),
            "machine": safe_split(product_info.get("machine")),
            "platform": ", ".join(product_info.get("platform", [])),
            # Additional fields
            "work_type": product_info.get("work_type_string", ""),
            "file_type": product_info.get("file_type", ""),
            "file_size": product_info.get("file_size", ""),
            "circle_id": product_info.get("circle_id", ""),
            "sex_category": product_info.get("sex_category", ""),
            "work_category": product_info.get("work_category", ""),
            "price": product_info.get("price", 0),
            "price_without_tax": product_info.get("price_without_tax", 0),
            "is_trial": bool(product_info.get("trials", [])),
            "intro_s": product_info.get("intro_s", ""),
            "summary": product_info.get("intro_s", ""),
            "work_name_kana": product_info.get("work_name_kana", ""),
            "tags": [
                genre["name"].split("/")[-1].strip()
                for genre in product_info.get("genres_replaced", product_info.get("genres", []))
                if isinstance(genre, dict) and "name" in genre
            ],
            "cvs": list(dict.fromkeys(cvs)),
            "cover_url": self.get_full_url(product_info.get("image_main")),
            "image_thum_url": self.get_full_url(product_info.get("image_thum")),
            "sample_images": [
                self.get_full_url(image)
                for image in (product_info.get("image_samples", []) or [])
            ],
            # Computed fields
            "supported_languages": self.get_supported_languages(product_info),
            "rating": self.calculate_average_rating(product_info),
        }

        self.__logger.info(
            "[%s] -> Metadata from product API scraped successfully", rjcode
        )
        return metadata

    @staticmethod
    def get_full_url(image_info):
        if not isinstance(image_info, dict):
            return ""
        url = image_info.get("url", "").strip()
        return f"https:{url}" if url.startswith("//") else url

    @staticmethod
    def get_supported_languages(product_info: dict) -> List[str]:
        language_codes = {
            "JPN": "Japanese",
            "ENG": "English",
            "CHN": "Chinese",
            "KOR": "Korean",
            "FRE": "French",
            "GER": "German",
            "SPA": "Spanish",
            "ITA": "Italian",
            "RUS": "Russian",
            "POR": "Portuguese",
            "VIE": "Vietnamese",
            "THA": "Thai",
            "IND": "Indonesian",
            "ARA": "Arabic",
            "HIN": "Hindi",
            "TUR": "Turkish",
        }
        options = product_info.get("options", "").split("#")
        return [
            language_codes.get(code, "") for code in options if code in language_codes
        ]

    @staticmethod
    def calculate_average_rating(product_info: dict) -> float:
        rating_counts = product_info.get("rate_count_detail", {})
        if rating_counts:
            total_score = sum(
                int(rating) * count for rating, count in rating_counts.items()
            )
            total_count = sum(count for count in rating_counts.values())
            return round(total_score / total_count, 2) if total_count else 0.0
        return 0.0

    @staticmethod
    def get_age(age: int) -> str:
        return {1: "Ⓤ", 2: "⑮"}.get(age, "⑱")

    def urlretrieve(
        self, url: str, filename: Union[os.PathLike, str]
    ) -> Tuple[str, dict]:
        """
        Download a file from a URL to a local file
        """
        self.__logger.info("Downloading file from URL: %s", url)
        with contextlib.closing(
            requests.get(
                url,
                stream=True,
                proxies=self.__proxies,
                timeout=(self.__connect_timeout, self.__read_timeout),
            )
        ) as response:
            response.raise_for_status()
            with open(filename, "wb") as file:
                for chunk in response.iter_content(chunk_size=8192):
                    file.write(chunk)
        self.__logger.info("File downloaded successfully: %s", filename)
        return filename, response.headers
