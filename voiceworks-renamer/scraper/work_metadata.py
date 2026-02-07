from typing import TypedDict, List, Optional, Union


class WorkMetadata(TypedDict):
    # Basic identification
    rjcode: str
    work_name: str
    work_name_kana: str

    # Maker info
    maker_id: str
    maker_name: str
    circle_id: str

    # Series info
    series_id: str
    series_name: str

    # Content details
    age: str
    sex_category: str
    work_type: str
    work_category: str
    tags: List[str]
    cvs: List[str]
    genres: List[dict]
    intro_s: str
    summary: str

    # Technical details
    file_type: str
    file_size: Optional[str]
    options: List[str]
    machine: List[str]
    platform: List[str]
    supported_languages: List[str]

    # Media
    cover_url: str
    image_thum_url: str
    sample_images: List[str]

    # Commercial info
    price: int
    price_without_tax: int
    release_date: str
    rating: float
    is_trial: bool

    # Additional metadata
    rate_count_detail: dict
    creaters: List[dict]
    work_files: List[dict]
