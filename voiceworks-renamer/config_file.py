import json
import os
import re
from typing import Final
import logging

# Assuming Locale is an enumeration of supported locales
# For this example, let's define it as follows:
from enum import Enum


class Locale(Enum):
    EN_US = "en_us"
    JA_JP = "ja_jp"


class ConfigFile(object):
    DEFAULT_CONFIG: Final = {
        "cv_list_left": "(CV. ",
        "cv_list_right": ")",
        "remove_image_files": False,
        "renamer_release_date_format": "%d-%m-%y",
        "template": "maker_name★ratingagerelease_daterjcode work_namecv_list_str～tags_list_str",
        "save_cover_jpg": True,
        "scanner_max_depth": 5,
        "http_proxy": None,
        "locale": "en_us",
        "connect_timeout": 30,
        "read_timeout": 30,
        "sleep_interval": 1,
        "save_sample_images": True,
        "use_thumbnail": False,
        "overwrite_existing": False,
        "include_original_name": True,
        "features": {
            "enable_folder_rename": True,
            "enable_file_rename": True,
            "enable_translation": True,
            "enable_metadata_update": True,
            "enable_cover_art": True,
            "enable_playlist_generation": True,
            "enable_folder_icon": True,
            "enable_script_import": True,
            "enable_transcription": False,
            "enable_product_summary": True,
        },
        "playlist_settings": {
            "enable_playlist_generation": True,
            "playlist_directory": "./_playlists",
            "create_genre_playlists": True,
            "create_content_playlists": True,
            "create_artist_playlists": True,
        },
    }

    def __init__(self, file_path: str):
        self.__file_path = file_path
        if not os.path.isfile(file_path):
            self.save_config(ConfigFile.DEFAULT_CONFIG)

    def load_config(self):
        """
        Load configuration from the config file
        """
        with open(self.__file_path, encoding="UTF-8") as file:
            config_dict = json.load(file)
            return config_dict

    def save_config(self, config_dict):
        """
        Save configuration to the file
        """
        with open(self.__file_path, "w", encoding="UTF-8") as file:
            json.dump(config_dict, file, indent=2, ensure_ascii=False)

    @property
    def file_path(self):
        return self.__file_path

    @staticmethod
    def verify_config(config_dict):
        logger = logging.getLogger()  # Use root logger
        strerror_list = []

        # cv_list_left
        cv_list_left = config_dict.get("cv_list_left")
        if not isinstance(cv_list_left, str):
            strerror_list.append("cv_list_left should be a string")
        else:
            illegal_chars = r'\/:*?"<>|'
            for char in cv_list_left:
                if char in illegal_chars:
                    strerror_list.append(
                        f"cv_list_left cannot contain system reserved character '{char}'"
                    )
                    break

        # cv_list_right
        cv_list_right = config_dict.get("cv_list_right")
        if not isinstance(cv_list_right, str):
            strerror_list.append("cv_list_right should be a string")
        else:
            illegal_chars = r'\/:*?"<>|'
            for char in cv_list_right:
                if char in illegal_chars:
                    strerror_list.append(
                        f"cv_list_right cannot contain system reserved character '{char}'"
                    )
                    break

        # remove_image_files
        remove_image_files = config_dict.get("remove_image_files")
        if not isinstance(remove_image_files, bool):
            strerror_list.append("remove_image_files should be a boolean")

        # renamer_release_date_format
        renamer_release_date_format = config_dict.get("renamer_release_date_format")
        if not isinstance(renamer_release_date_format, str):
            strerror_list.append("renamer_release_date_format should be a string")



        # template
        template = config_dict.get("template")
        if not isinstance(template, str):
            strerror_list.append("template should be a string")
        elif "rjcode" not in template:
            strerror_list.append('template should contain "rjcode"')

        # save_cover_jpg
        save_cover_jpg = config_dict.get("save_cover_jpg")
        if not isinstance(save_cover_jpg, bool):
            strerror_list.append("save_cover_jpg should be a boolean")

        # scanner_max_depth
        scanner_max_depth = config_dict.get("scanner_max_depth")
        if not isinstance(scanner_max_depth, int) or scanner_max_depth < 0:
            strerror_list.append(
                "scanner_max_depth should be an integer greater than or equal to 0"
            )

        # http_proxy
        http_proxy = config_dict.get("http_proxy")


        def validate_http_proxy(proxy_value, proxy_name):
            if proxy_value is None:
                return
            elif isinstance(proxy_value, str):
                http_proxy_pattern = re.compile(
                    r"\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:(\d+)"
                )
                if not http_proxy_pattern.fullmatch(proxy_value):
                    strerror_list.append(
                        f'{proxy_name} should be an HTTP proxy like "127.0.0.1:7890"; or set to null to use the system proxy'
                    )
            else:
                strerror_list.append(f"{proxy_name} should be a string or null")

        validate_http_proxy(http_proxy, "http_proxy")
        # locale
        locale = config_dict.get("locale")
        valid_locales = [loc.value for loc in Locale]
        if locale not in valid_locales:
            strerror_list.append(f"locale should be one of {valid_locales}")

        # connect_timeout
        connect_timeout = config_dict.get("connect_timeout")
        if not isinstance(connect_timeout, int) or connect_timeout <= 0:
            strerror_list.append("connect_timeout should be an integer greater than 0")

        # read_timeout
        read_timeout = config_dict.get("read_timeout")
        if not isinstance(read_timeout, int) or read_timeout <= 0:
            strerror_list.append("read_timeout should be an integer greater than 0")

        # sleep_interval
        sleep_interval = config_dict.get("sleep_interval")
        if not isinstance(sleep_interval, (int, float)) or sleep_interval < 0:
            strerror_list.append("sleep_interval should be a non-negative number")

        # save_sample_images
        save_sample_images = config_dict.get("save_sample_images")
        if not isinstance(save_sample_images, bool):
            strerror_list.append("save_sample_images should be a boolean")

        # use_thumbnail
        use_thumbnail = config_dict.get("use_thumbnail")
        if not isinstance(use_thumbnail, bool):
            strerror_list.append("use_thumbnail should be a boolean")

        # overwrite_existing
        overwrite_existing = config_dict.get("overwrite_existing")
        if not isinstance(overwrite_existing, bool):
            strerror_list.append("overwrite_existing should be a boolean")

        # include_original_name
        include_original_name = config_dict.get("include_original_name")
        if not isinstance(include_original_name, bool):
            strerror_list.append("include_original_name should be a boolean")

        # features
        features = config_dict.get("features")
        if not isinstance(features, dict):
            strerror_list.append("features should be a dictionary")
        else:
            for key in [
                "enable_folder_rename",
                "enable_file_rename",
                "enable_translation",
                "enable_metadata_update",
                "enable_cover_art",
                "enable_playlist_generation",
                "enable_folder_icon",
                "enable_script_import",
                "enable_transcription",
                "enable_product_summary",
            ]:
                value = features.get(key)
                if not isinstance(value, bool):
                    strerror_list.append(f"features['{key}'] should be a boolean")

        # playlist_settings
        playlist_settings = config_dict.get("playlist_settings")
        if not isinstance(playlist_settings, dict):
            strerror_list.append("playlist_settings should be a dictionary")
        else:
            playlist_keys = {
                "enable_playlist_generation": bool,
                "playlist_directory": str,
                "create_genre_playlists": bool,
                "create_content_playlists": bool,
                "create_artist_playlists": bool,
            }
            for key, expected_type in playlist_keys.items():
                value = playlist_settings.get(key)
                if not isinstance(value, expected_type):
                    strerror_list.append(
                        f"playlist_settings['{key}'] should be of type {expected_type.__name__}"
                    )

        if len(strerror_list) == 0:
            logger.info("Configuration verification passed.")
        else:
            logger.error(
                "Configuration verification failed with errors: %s", strerror_list
            )

        return strerror_list
