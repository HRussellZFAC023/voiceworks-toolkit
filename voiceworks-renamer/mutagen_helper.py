import logging
from pathlib import Path
from base64 import b64encode
from typing import Dict, Optional
from concurrent.futures import ThreadPoolExecutor, as_completed

from mutagen import File
from mutagen.flac import FLAC, Picture
from mutagen.mp4 import MP4, MP4Cover
from mutagen.id3 import (
    ID3,
    TIT2,
    TALB,
    TPE1,
    TPE2,
    TRCK,
    TCON,
    TDRC,
    COMM,
    APIC,
    TPOS,
    USLT,
    TXXX,
    TKEY,
    PRIV,
)
from mutagen.mp3 import MP3
from mutagen.oggopus import OggOpus, OggOpusHeaderError
from mutagen.oggvorbis import OggVorbis


class MutagenHelper:
    """A helper class for handling Mutagen-specific metadata updates."""

    def __init__(self):
        self.logger = logging.getLogger(__name__)

    def update_metadata(
        self, file_path: str, tags: Dict[str, str], track_number: Optional[int] = None
    ) -> bool:
        """Update metadata for various audio formats."""
        try:
            ext = file_path.lower().split(".")[-1]
            if ext in ["mp3"]:
                return self._update_mp3_metadata(file_path, tags, track_number)
            elif ext in ["ogg", "oga"]:
                return self._update_ogg_metadata(file_path, tags, track_number)
            elif ext in ["opus"]:
                return self._update_opus_metadata(file_path, tags, track_number)
            else:
                audio = File(file_path)
                if audio is None:
                    return False
                self._set_tags(audio, tags, track_number, file_path)
            return True
        except Exception as e:
            self.logger.error(f"Error updating metadata for {file_path}: {str(e)}")
            return False

    def _fix_ogg_header(self, file_path: str) -> bool:
        """Attempt to fix the Ogg header for the given file."""
        try:
            with open(file_path, "rb") as f:
                data = f.read()
                # Look for the first OggS marker
                pos = data.find(b"OggS")
                if pos == -1:
                    self.logger.error("No OggS marker found in file")
                    return False

                # If OggS is not at the start, truncate the file
                if pos > 0:
                    with open(file_path, "rb+") as fw:
                        fw.seek(pos)
                        remaining_data = fw.read()
                        fw.seek(0)
                        fw.write(remaining_data)
                        fw.truncate()

                # Verify the fix worked
                try:
                    if pos > 0:  # Only reload if we modified the file
                        with open(file_path, "rb") as f:
                            if f.read(4) != b"OggS":
                                return False
                    return True
                except Exception as e:
                    self.logger.error(f"Failed to verify Ogg header fix: {str(e)}")
                    return False

        except Exception as e:
            self.logger.error(f"Failed to fix Ogg header: {str(e)}")
            return False

    def _update_ogg_metadata(
        self, file_path: str, tags: Dict[str, str], track_number: Optional[int] = None
    ) -> bool:
        """Update metadata for OGG files."""
        try:
            audio = OggVorbis(file_path)

            # Clear existing tags
            audio.tags.clear()

            # Add new tags
            for key, value in tags.items():
                if value:  # Only add non-empty values
                    # Convert single values to lists for OGG format
                    if isinstance(value, str):
                        audio.tags[key] = [value]
                    else:
                        audio.tags[key] = value

            # Add track number if provided
            if track_number is not None:
                audio.tags["tracknumber"] = [str(track_number)]

            # Save changes
            audio.save()
            return True

        except Exception as e:
            self.logger.error(
                f"Failed to update OGG metadata for {file_path}: {str(e)}"
            )
            return False

    def _validate_and_repair_opus(self, file_path: str) -> bool:
        """Validate and attempt to repair Opus file."""
        try:
            with open(file_path, "rb") as f:
                content = f.read()

            # Search for OggS marker
            oggs_pos = content.find(b"OggS")
            opus_pos = content.find(b"OpusHead")

            if oggs_pos == -1:
                self.logger.error(f"No OggS marker found in {file_path}")
                return False

            if opus_pos == -1:
                self.logger.error(f"No OpusHead marker found in {file_path}")
                return False

            # Check if file needs repair
            if oggs_pos > 0 or (opus_pos - oggs_pos) > 100:
                # Create backup
                backup_path = str(file_path) + ".bak"
                with open(backup_path, "wb") as f:
                    f.write(content)

                # Write repaired file
                with open(file_path, "wb") as f:
                    # Write from OggS marker
                    f.write(content[oggs_pos:])

                self.logger.info(
                    f"Repaired Opus file {file_path}, backup saved as {backup_path}"
                )

            return True

        except Exception as e:
            self.logger.error(
                f"Error validating/repairing Opus file {file_path}: {str(e)}"
            )
            return False

    def _update_opus_metadata(
        self, file_path: str, tags: Dict[str, str], track_number: Optional[int] = None
    ) -> bool:
        """Update metadata for Opus files with validation and repair."""
        try:
            # First validate and repair if needed
            if not self._validate_and_repair_opus(file_path):
                return False

            try:
                audio = OggOpus(file_path)
            except OggOpusHeaderError:
                # If loading fails after repair, give up
                self.logger.error(
                    f"Failed to load Opus file {file_path} even after repair"
                )
                return False

            # Ensure tags exist
            if not audio.tags:
                audio.add_tags()

            # Clear existing tags
            audio.tags.clear()

            # Add new tags, converting all values to strings
            for key, value in tags.items():
                if value is not None:  # Skip None values
                    try:
                        str_value = str(value)
                        audio.tags[key] = [str_value]
                    except Exception as e:
                        self.logger.warning(f"Failed to add tag {key}: {str(e)}")
                        continue

            # Add track number if provided
            if track_number is not None:
                audio.tags["tracknumber"] = [str(track_number)]

            # Save changes
            audio.save()
            return True

        except Exception as e:
            self.logger.error(
                f"Failed to update Opus metadata for {file_path}: {str(e)}"
            )
            return False

    def _update_mp3_metadata(
        self, file_path: str, tags: Dict[str, str], track_number: Optional[int] = None
    ) -> bool:
        """Update metadata for MP3 files."""
        try:
            # Load or create ID3 tags
            try:
                audio = ID3(file_path)
            except Exception:
                audio = ID3()

            # Clear existing tags
            audio.clear()

            # Map common tags to ID3 frames
            if "title" in tags:
                audio.add(TIT2(encoding=3, text=tags["title"]))
            if "artist" in tags:
                audio.add(TPE1(encoding=3, text=tags["artist"]))
            if "album" in tags:
                audio.add(TALB(encoding=3, text=tags["album"]))
            if "genre" in tags:
                audio.add(TCON(encoding=3, text=tags["genre"]))
            if track_number is not None:
                audio.add(TRCK(encoding=3, text=str(track_number)))
            if "comment" in tags:
                audio.add(COMM(encoding=3, lang="eng", desc="", text=tags["comment"]))

            # Add all other tags as custom TXXX frames
            for key, value in tags.items():
                if key not in ["title", "artist", "album", "genre", "comment"]:
                    try:
                        # Handle None values and convert numbers to strings
                        if value is not None:
                            str_value = str(value)
                            audio.add(TXXX(encoding=3, desc=key, text=str_value))
                    except Exception as e:
                        self.logger.warning(f"Failed to add custom tag {key}: {str(e)}")
                        continue

            # Save changes
            audio.save(file_path)
            return True

        except Exception as e:
            self.logger.error(
                f"Failed to update MP3 metadata for {file_path}: {str(e)}"
            )
            return False

    def _set_tags(
        self, audio, tags: Dict[str, str], track_number: Optional[int], file_path: str
    ) -> None:
        """Set new tags to the audio file."""
        if isinstance(audio, MP3):
            if audio.tags is None:
                audio.tags = ID3()

        for key, value in tags.items():
            if value:
                if isinstance(audio.tags, ID3):
                    self._set_id3_tag(audio.tags, key, value, track_number)
                elif isinstance(audio, FLAC):
                    audio[key] = [value]
                elif isinstance(audio, MP4):
                    self._set_mp4_tag(audio, key, value, track_number)
                else:
                    audio.tags[key.upper()] = [value]
        self._add_cover_art(audio, file_path)

    def _set_id3_tag(
        self, audio_tags: ID3, key: str, value: str, track_number: Optional[int]
    ) -> None:
        """Set individual ID3 tags."""
        tag_mapping = {
            "title": TIT2(encoding=3, text=value),
            "artist": TPE1(encoding=3, text=value),
            "album": TALB(encoding=3, text=value),
            "albumartist": TPE2(encoding=3, text=value),
            "genre": TCON(encoding=3, text=value),
            "date": TDRC(encoding=3, text=value),
            "year": TDRC(encoding=3, text=value),
            "comment": COMM(encoding=3, desc="", text=value),
            "discnumber": TPOS(encoding=3, text=value),
            "lyrics": USLT(encoding=3, desc="", text=value),
            "key": TKEY(encoding=3, text=value),
            "privatedata": PRIV(owner="com.example", data=value.encode("utf-8")),
        }
        if key in tag_mapping:
            audio_tags.add(tag_mapping[key])
        else:
            # Set unknown tags as TXXX frames
            audio_tags.add(TXXX(encoding=3, desc=key, text=value))
        if key == "tracknumber" and track_number is not None:
            audio_tags.add(TRCK(encoding=3, text=str(track_number)))
        if key == "coverart" and value:
            with open(value, "rb") as f:
                cover_data = f.read()
            audio_tags.add(
                APIC(
                    encoding=3, mime="image/jpeg", type=3, desc="Cover", data=cover_data
                )
            )

    def _set_mp4_tag(
        self, audio: MP4, key: str, value: str, track_number: Optional[int]
    ) -> None:
        """Set individual MP4 tags."""
        tag_mapping = {
            "title": "\xa9nam",
            "artist": "\xa9ART",
            "album": "\xa9alb",
            "albumartist": "aART",
            "genre": "\xa9gen",
            "description": "desc",
            "lyrics": "\xa9lyr",
            "copyright": "cprt",
            "encodedby": "\xa9enc",
            "publisher": "\xa9pub",
            "rating": "rate",
            "key": "keyw",
            "year": "\xa9day",
        }
        if key in tag_mapping:
            audio[tag_mapping[key]] = [value]
        else:
            # Set unknown tags as freeform atoms
            audio[f"----:com.apple.iTunes:{key}"] = [value]
        if key == "tracknumber" and track_number is not None:
            audio["trkn"] = [(track_number, 0)]

    def _add_cover_art(self, audio, file_path: str) -> None:
        """Add cover art and sample images to the audio file if available."""
        cover_path = Path(file_path).parent / "cover.jpg"
        sample_paths = sorted(Path(file_path).parent.glob("sample_*.jpg"))

        if cover_path.exists():
            with open(cover_path, "rb") as f:
                cover_data = f.read()
            if isinstance(audio, FLAC):
                picture = Picture()
                picture.data = cover_data
                picture.type = 3  # Cover image
                picture.mime = "image/jpeg"
                audio.clear_pictures()
                audio.add_picture(picture)
            elif isinstance(audio, MP4):
                audio["covr"] = [MP4Cover(cover_data, imageformat=MP4Cover.FORMAT_JPEG)]
            elif isinstance(audio.tags, ID3):
                audio.tags.add(
                    APIC(
                        encoding=3,
                        mime="image/jpeg",
                        type=3,
                        desc="Cover",
                        data=cover_data,
                    )
                )
            else:
                picture = Picture()
                picture.data = cover_data
                picture.type = 3
                picture.mime = "image/jpeg"
                audio.tags["METADATA_BLOCK_PICTURE"] = b64encode(
                    picture.write()
                ).decode("ascii")

        for idx, sample_path in enumerate(sample_paths, start=1):
            if sample_path.exists():
                with open(sample_path, "rb") as f:
                    sample_data = f.read()
                if isinstance(audio, FLAC):
                    picture = Picture()
                    picture.data = sample_data
                    picture.type = idx + 3  # Other cover types
                    picture.mime = "image/jpeg"
                    audio.add_picture(picture)
                elif isinstance(audio, MP4):
                    audio["covr"].append(
                        MP4Cover(sample_data, imageformat=MP4Cover.FORMAT_JPEG)
                    )
                elif isinstance(audio.tags, ID3):
                    audio.tags.add(
                        APIC(
                            encoding=3,
                            mime="image/jpeg",
                            type=idx + 3,
                            desc=f"Sample {idx}",
                            data=sample_data,
                        )
                    )
                else:
                    picture = Picture()
                    picture.data = sample_data
                    picture.type = idx + 3
                    picture.mime = "image/jpeg"
                    audio.tags[f"METADATA_BLOCK_PICTURE_{idx}"] = b64encode(
                        picture.write()
                    ).decode("ascii")
