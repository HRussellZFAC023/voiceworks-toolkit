import os
import win32api
import win32con
import logging
from pathlib import Path
from typing import Dict, Tuple
from PIL import Image, UnidentifiedImageError
from config_types import Config


class FolderIconManager:
    """Manages Windows folder icons including creation, deletion, and attribute management."""

    DESKTOP_INI = "desktop.ini"
    ICON_EXTENSION = ".ico"

    def __init__(self, config: Config):
        """Initialize folder icon manager.

        Args:
            config: Configuration object containing settings
        """
        self.logger = logging.getLogger(__name__)
        self._use_thumbnail = config.get("use_thumbnail", False)

    def change_icon(
        self, rjcode: str, icon_dir: str, saved_images: Dict[str, Path]
    ) -> None:
        """Change folder icon using local image files.

        Args:
            rjcode: Product code for logging
            icon_dir: Target directory path
            saved_images: Dictionary of saved image paths
        """
        if os.name != "nt":
            return

        dir_path = Path(icon_dir)
        if not dir_path.exists():
            raise ValueError(f"Directory does not exist: {icon_dir}")

        try:
            dir_attrs = self._backup_and_prepare_directory(dir_path)
            self._cleanup_existing_files(dir_path, rjcode)
            icon_name, jpg_name = self._create_icon_from_image(
                dir_path, rjcode, saved_images
            )
            if not icon_name:
                self.logger.warning(
                    "[%s] -> Skipping folder icon creation due to invalid image", rjcode
                )
                self._restore_directory_attributes(dir_path, dir_attrs)
                return
            self._create_desktop_ini(dir_path, icon_name)
            self._set_file_attributes(dir_path, icon_name)
            self._set_folder_attribute_system(dir_path)
            self._refresh_folder(dir_path)
            self._restore_directory_attributes(dir_path, dir_attrs)

            #print(
            #     '[%s] -> Successfully set folder icon: "%s" from %s',
            #     rjcode,
            #     icon_name,
            #     jpg_name,
            # )

        except Exception as e:
            self._handle_error(dir_path, dir_attrs, rjcode, e)
            raise

    def _create_icon_from_image(
        self, dir_path: Path, rjcode: str, saved_images: Dict[str, Path]
    ) -> Tuple[str, str]:
        """Create icon file from source image."""
        # Select source image
        jpg_name = "thumb.jpg" if self._use_thumbnail else "cover.jpg"
        source_image = saved_images.get(jpg_name)

        if not source_image:
            raise ValueError(f"No valid {jpg_name} found for {rjcode}")

        icon_name = f"@folder-icon-{rjcode}.ico"
        icon_path = dir_path / icon_name

        # Convert and save icon
        try:
            with Image.open(source_image) as img:
                # Convert to RGB to handle potential RGBA or other formats
                if img.mode not in ("RGB", "RGBA"):
                    img = img.convert("RGB")

                # Verify image data is complete
                img.load()

                square_img = self._create_square_image(img)
                self._save_multi_size_icon(square_img, icon_path)
        except (UnidentifiedImageError, OSError, ValueError) as e:
            self.logger.error(
                "[%s] -> Failed to process image '%s': %s",
                rjcode,
                source_image,
                str(e),
                exc_info=True,
            )
            # Try alternate image if available
            alternate_jpg = "cover.jpg" if self._use_thumbnail else "thumb.jpg"
            if alternate_jpg in saved_images:
                #print("[%s] -> Trying alternate image: %s", rjcode, alternate_jpg)
                try:
                    with Image.open(saved_images[alternate_jpg]) as img:
                        if img.mode not in ("RGB", "RGBA"):
                            img = img.convert("RGB")
                        img.load()
                        square_img = self._create_square_image(img)
                        self._save_multi_size_icon(square_img, icon_path)
                        jpg_name = alternate_jpg
                except Exception as e2:
                    self.logger.error(
                        "[%s] -> Failed to process alternate image: %s", rjcode, str(e2)
                    )
                    return "", ""
            else:
                return "", ""

        return icon_name, jpg_name

    def _create_square_image(self, img: Image.Image) -> Image.Image:
        """Create square image with transparency from source image."""
        # Resize maintaining aspect ratio
        size = 512, 512
        img.thumbnail(size, Image.Resampling.LANCZOS)

        # Convert to RGBA if needed
        if img.mode != "RGBA":
            img = img.convert("RGBA")

        # Center in square transparent canvas
        square_size = max(img.size)
        square_img = Image.new("RGBA", (square_size, square_size), (0, 0, 0, 0))
        paste_pos = (
            (square_size - img.size[0]) // 2,
            (square_size - img.size[1]) // 2,
        )
        square_img.paste(img, paste_pos)

        return square_img

    def _save_multi_size_icon(self, img: Image.Image, icon_path: Path) -> None:
        """Save image as ICO with multiple sizes."""
        img.save(
            icon_path,
            format="ICO",
            sizes=[
                (512, 512),
                (256, 256),
                (128, 128),
                (64, 64),
                (48, 48),
                (32, 32),
                (16, 16),
            ],
        )

    def _create_desktop_ini(self, dir_path: Path, icon_name: str) -> None:
        """Create desktop.ini file with icon settings."""
        ini_content = self._generate_ini_content(icon_name)
        ini_path = dir_path / self.DESKTOP_INI

        with open(ini_path, "w", encoding="utf-8") as f:
            f.write(ini_content)

    def _set_file_attributes(self, dir_path: Path, icon_name: str) -> None:
        """Set system and hidden attributes for icon files."""
        ini_path = dir_path / self.DESKTOP_INI
        ico_path = dir_path / icon_name

        for path in (ini_path, ico_path):
            win32api.SetFileAttributes(
                str(path),
                win32con.FILE_ATTRIBUTE_HIDDEN | win32con.FILE_ATTRIBUTE_SYSTEM,
            )

    def _set_folder_attribute_system(self, dir_path: Path) -> None:
        """Set the folder attribute to 'system' to ensure desktop.ini is read."""
        win32api.SetFileAttributes(
            str(dir_path),
            win32api.GetFileAttributes(str(dir_path)) | win32con.FILE_ATTRIBUTE_SYSTEM,
        )

    def _refresh_folder(self, dir_path: Path) -> None:
        """Refresh folder to apply changes (workaround for Windows caching)."""
        win32api.SetFileAttributes(str(dir_path), win32con.FILE_ATTRIBUTE_NORMAL)
        win32api.SetFileAttributes(
            str(dir_path),
            win32api.GetFileAttributes(str(dir_path)) | win32con.FILE_ATTRIBUTE_SYSTEM,
        )

    def _backup_and_prepare_directory(self, dir_path: Path) -> int:
        """Back up directory attributes and prepare for modification."""
        dir_attrs = win32api.GetFileAttributes(str(dir_path))
        win32api.SetFileAttributes(
            str(dir_path),
            dir_attrs
            & ~(win32con.FILE_ATTRIBUTE_READONLY | win32con.FILE_ATTRIBUTE_SYSTEM),
        )
        return dir_attrs

    def _cleanup_existing_files(self, dir_path: Path, rjcode: str) -> None:
        """Remove existing desktop.ini and icon files."""
        ini_path = dir_path / self.DESKTOP_INI
        if ini_path.exists():
            self._remove_file_with_attrs(ini_path, rjcode, self.DESKTOP_INI)

        for ico_file in dir_path.glob(f"*{self.ICON_EXTENSION}"):
            self._remove_file_with_attrs(ico_file, rjcode, ico_file.name)

    def _remove_file_with_attrs(
        self, file_path: Path, rjcode: str, file_desc: str
    ) -> None:
        """Safely remove file by first changing attributes."""
        try:
            win32api.SetFileAttributes(str(file_path), win32con.FILE_ATTRIBUTE_NORMAL)
            file_path.unlink()
            #print("[%s] -> Removed existing %s", rjcode, file_desc)
        except OSError as e:
            self.logger.warning("[%s] -> Failed to remove %s: %s", rjcode, file_desc, e)

    def _restore_directory_attributes(
        self, dir_path: Path, original_attrs: int
    ) -> None:
        """Restore directory attributes with system flag."""
        win32api.SetFileAttributes(
            str(dir_path), original_attrs | win32con.FILE_ATTRIBUTE_SYSTEM
        )

    def _handle_error(
        self, dir_path: Path, original_attrs: int, rjcode: str, error: Exception
    ) -> None:
        """Handle errors and attempt to restore directory attributes."""
        self.logger.error("[%s] -> Failed to set folder icon: %s", rjcode, str(error))
        try:
            win32api.SetFileAttributes(str(dir_path), original_attrs)
        except OSError:
            self.logger.warning(
                "[%s] -> Failed to restore directory attributes", rjcode
            )

    @staticmethod
    def _generate_ini_content(icon_name: str) -> str:
        """Generate desktop.ini file content."""
        return (
            "[.ShellClassInfo]\n"
            f'IconResource="{icon_name}",0\n'
            "[ViewState]\n"
            "Mode=\n"
            "Vid=\n"
            "FolderType=StorageProviderGeneric"
        )
