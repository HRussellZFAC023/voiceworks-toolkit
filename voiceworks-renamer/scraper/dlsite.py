import re
import logging
from typing import Dict, Final, Optional, ClassVar
from urllib.parse import unquote


class Dlsite:
    """DLsite metadata scraper and text translator"""

    # Class-level logger
    logger: ClassVar[logging.Logger] = logging.getLogger(__name__)

    # Regex patterns
    WORKNO_PATTERN: Final = re.compile(r"(RE|RJ|VJ)(\d{6}|\d{8})(?!\d+)")
    RGCODE_PATTERN: Final = re.compile(r"RG(\d{5})(?!\d+)")
    SRICODE_PATTERN: Final = re.compile(r"SRI(\d{10})(?!\d+)")

    @staticmethod
    def parse_workno(string: str) -> Optional[str]:
        """Parse work number from string"""
        match = Dlsite.WORKNO_PATTERN.search(string.upper())
        return match.group() if match else None

    @staticmethod
    def compile_work_page_url(rjcode: str) -> str:
        """Generate work page URL from RJ code"""
        return f"https://www.dlsite.com/maniax/work/=/product_id/{rjcode}.html"

    @staticmethod
    def compile_product_api_url(rjcode: str) -> str:
        """Generate product API URL from RJ code"""
        return f"https://www.dlsite.com/maniax/api/=/product.json?workno={rjcode}"

    @staticmethod
    def parse_url_params(url: str) -> Dict[str, str]:
        """Parse URL parameters into dictionary"""
        unquoted_url = unquote(url)
        split_url = unquoted_url.split(r"/=/", 1)
        params_str = split_url[1] if len(split_url) == 2 else ""
        params_str = re.sub(r"(?:\?.*$|(\.html)?/?$)", "", params_str)

        params = {}
        params_list = params_str.split("/")
        for i in range(0, len(params_list), 2):
            key = params_list[i]
            value = params_list[i + 1] if i + 1 < len(params_list) else ""
            params[key] = value
        return params
