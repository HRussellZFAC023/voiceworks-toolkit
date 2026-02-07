import json
import logging
from typing import Any, Callable

class ConfigObserver:
    def __init__(self):
        self.callbacks = []

    def subscribe(self, callback: Callable):
        self.callbacks.append(callback)

    def notify(self, key: str, value: Any):
        for callback in self.callbacks:
            callback(key, value)

class Config:
    """Handles loading and accessing configuration settings."""

    def __init__(self, config_path: str):
        self.logger = logging.getLogger(__name__)
        self.config_path = config_path
        self.config = self._load_config(config_path)
        self.observer = ConfigObserver()
        self.processing_stats = {"processed": 0, "total": 0}

    def _load_config(self, config_path: str) -> dict:
        """Load configuration from a JSON file."""
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                config = json.load(f)
            return config
        except Exception as e:
            self.logger.error("Failed to load configuration: %s", e, exc_info=True)
            return {}

    def save_config(self) -> None:
        """Save current configuration to file."""
        try:
            with open(self.config_path, "w", encoding="utf-8") as f:
                json.dump(self.config, f, indent=4, ensure_ascii=False)
            self.logger.debug(f"Configuration saved to {self.config_path}")
        except Exception as e:
            self.logger.error(f"Failed to save configuration: {str(e)}")

    def get(self, key: str, default=None):
        """Get a configuration value."""
        return self.config.get(key, default)

    def set(self, key: str, value: Any) -> None:
        """Set a configuration value and save to file."""
        if isinstance(value, dict):
            # Merge dict values instead of replacing
            current = self.config.get(key, {})
            current.update(value)
            self.config[key] = current
        else:
            self.config[key] = value

        # Notify observers
        self.observer.notify(key, value)

        # Save changes immediately
        self.save_config()

    def subscribe_to_changes(self, callback: Callable):
        """Subscribe to configuration changes."""
        self.observer.subscribe(callback)

    def update_progress(self, processed: int, total: int):
        """Update processing progress."""
        self.processing_stats["processed"] = processed
        self.processing_stats["total"] = total
        self.observer.notify("processing_stats", self.processing_stats)

    def get_progress(self):
        """Get current processing progress."""
        return self.processing_stats
