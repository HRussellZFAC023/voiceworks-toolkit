import concurrent.futures
import logging
import os
from pathlib import Path
from typing import Dict
import time
import urllib3
from urllib3.exceptions import HTTPError

# Import FileSystem from the new filesystem.py module instead of renamer.py
from config_types import Config
from file_manager import FileManager
from filesystem import FileSystem
from scraper.scraper import Scraper
from scraper.work_metadata import WorkMetadata
from PIL import Image, UnidentifiedImageError

INITIAL_DELAY = 1
MAX_RETRIES = 10


class ImageHandler:
    """Handles image downloading, saving, and cleanup."""

    def __init__(self, scraper: Scraper, config: Config):
        self.logger = logging.getLogger(__name__)
        self.scraper = scraper
        self.config = config
        self.max_retries = self.config.get("read_timeout", MAX_RETRIES)
        self.retry_delay = self.config.get("sleep_interval", INITIAL_DELAY)
        # Add file_manager initialization
        self.file_manager = FileManager(config, scraper)

    def save_images(
        self, folder_path: str, metadata: WorkMetadata, rjcode: str
    ) -> Dict[str, Path]:
        """Save cover, sample, and thumbnail images to the folder and return their paths."""
        #print("[%s] -> Saving images for folder: %s", rjcode, folder_path)

        # Create folder if it doesn't exist
        os.makedirs(folder_path, exist_ok=True)

        images_to_download = []
        saved_images = {}

        # Validate and prepare cover image
        cover_url = metadata.get("cover_url")
        if self.config.get("save_cover_jpg") and cover_url:
            cover_path = Path(folder_path) / self.file_manager.sanitize_filename(
                "cover.jpg", rjcode=rjcode )
            if cover_path.exists() and not self._is_image_valid(cover_path):
                self.logger.warning(
                    "[%s] -> Cover image is corrupted, deleting and redownloading.",
                    rjcode,
                )
                cover_path.unlink()
            if not cover_path.exists() or self.config.get("overwrite_existing", False):
                images_to_download.append(("cover.jpg", cover_url))
            saved_images["cover.jpg"] = cover_path

        # Validate and prepare sample images
        sample_images = metadata.get("sample_images", [])
        if self.config.get("save_sample_images") and sample_images:
            for idx, image_url in enumerate(sample_images, start=1):
                image_name = self.file_manager.sanitize_filename(
                    f"sample_{idx}.jpg", rjcode=rjcode
                )
                image_path = Path(folder_path) / image_name
                if image_path.exists() and not self._is_image_valid(image_path):
                    self.logger.warning(
                        "[%s] -> Sample image %s is corrupted, deleting and redownloading.",
                        rjcode,
                        image_name,
                    )
                    image_path.unlink()
                if not image_path.exists() or self.config.get(
                    "overwrite_existing", False
                ):
                    images_to_download.append((image_name, image_url))
                saved_images[image_name] = image_path

        # Validate and prepare thumbnail image
        thumbnail_url = metadata.get("thumbnail_url")
        if self.config.get("use_thumbnail") and thumbnail_url:
            thumbnail_path = Path(folder_path) / self.file_manager.sanitize_filename(
                "thumb.jpg", rjcode=rjcode
            )
            if thumbnail_path.exists() and not self._is_image_valid(thumbnail_path):
                self.logger.warning(
                    "[%s] -> Thumbnail image is corrupted, deleting and redownloading.",
                    rjcode,
                )
                thumbnail_path.unlink()
            if not thumbnail_path.exists() or self.config.get(
                "overwrite_existing", False
            ):
                images_to_download.append(("thumb.jpg", thumbnail_url))
            saved_images["thumb.jpg"] = thumbnail_path

        # Debug logging to check if images_to_download is populated correctly
        #print("[%s] -> Images to download: %s", rjcode, images_to_download)

        # Download images in parallel
        if images_to_download:
            with concurrent.futures.ThreadPoolExecutor() as executor:
                futures = {
                    executor.submit(
                        self._download_image,
                        image_url,
                        str(Path(folder_path) / image_name),
                        rjcode,
                    ): image_name
                    for image_name, image_url in images_to_download
                }
                for future in concurrent.futures.as_completed(futures):
                    image_name = futures[future]
                    try:
                        future.result()
                        #print("[%s] -> Downloaded image: %s", rjcode, image_name)
                    except Exception as err:
                        self.logger.error(
                            "[%s] -> Failed to download image %s: %s",
                            rjcode,
                            image_name,
                            err,
                        )

        return saved_images

    def _is_image_valid(self, image_path: Path) -> bool:
        """Check if an image file is valid and not corrupted."""
        try:
            with Image.open(image_path) as img:
                img.verify()
            return True
        except (UnidentifiedImageError, OSError):
            return False

    def _download_image(self, url: str, target_path: str, rjcode: str) -> None:
        """Download image with retries and proper error handling."""
        # Only sanitize the filename portion, not the entire path
        target_dir = str(Path(target_path).parent)
        filename = Path(target_path).name
        sanitized_filename = self.file_manager.sanitize_filename(filename, rjcode=rjcode)
        sanitized_target_path = str(Path(target_dir) / sanitized_filename)

        retries = 0
        last_error = None

        while retries < self.max_retries:
            try:
                self.scraper.urlretrieve(url, sanitized_target_path)

                # Verify the downloaded image
                if not self._is_image_valid(Path(sanitized_target_path)):
                    raise ValueError("Downloaded image is corrupted")

                return  # Success, exit the retry loop

            except (
                urllib3.exceptions.NameResolutionError,
                HTTPError,
                ConnectionError,
            ) as e:
                last_error = e
                retries += 1
                if retries < self.max_retries:
                    self.logger.warning(
                        "[%s] -> Failed to download image (attempt %d/%d): %s - retrying in %d seconds...",
                        rjcode,
                        retries,
                        self.max_retries,
                        str(e),
                        self.retry_delay,
                    )
                    time.sleep(self.retry_delay)
                continue

            except Exception as e:
                # For other errors, cleanup and raise immediately
                if Path(sanitized_target_path).exists():
                    Path(sanitized_target_path).unlink()
                self.logger.error(
                    "[%s] -> Failed to download or save image %s: %s",
                    rjcode,
                    sanitized_target_path,
                    str(e),
                )
                raise

        # If we get here, all retries failed
        if Path(sanitized_target_path).exists():
            Path(sanitized_target_path).unlink()
        self.logger.error(
            "[%s] -> Failed to download image after %d attempts: %s - %s",
            rjcode,
            self.max_retries,
            sanitized_target_path,
            str(last_error),
        )
        raise last_error

    def cleanup_images(self, folder_path: str, rjcode: str) -> None:
        """Clean up image files based on configuration."""
        #print("[%s] -> Cleaning up images for folder: %s", rjcode, folder_path)
        if self.config.get("remove_image_files"):
            # Remove main image
            image_path = Path(folder_path) / ("thumb.jpg")
            if image_path.exists():
                FileSystem.remove_file(str(image_path), rjcode)
                #print("[%s] -> Removed thumbnail file: %s", rjcode, image_path.name)

            # Remove cover.jpg if not saving
            if not self.config.get("save_cover_jpg"):
                cover_path = Path(folder_path) / "cover.jpg"
                if cover_path.exists():
                    FileSystem.remove_file(str(cover_path), rjcode)
                    #print("[%s] -> Removed cover image: %s", rjcode, cover_path.name)

            # Remove sample images if not saving
            if not self.config.get("save_sample_images"):
                for idx in range(1, 11):
                    sample_path = Path(folder_path) / f"sample_{idx}.jpg"
                    if sample_path.exists():
                        FileSystem.remove_file(str(sample_path), rjcode)
                        #print(
                        #     "[%s] -> Removed sample image: %s", rjcode, sample_path.name
                        # )
