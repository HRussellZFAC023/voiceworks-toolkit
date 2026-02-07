# Voiceworks Renamer

A desktop tool for batch-organizing Japanese voicework libraries with automated metadata enrichment, audio tagging, transcription, translation, and intelligent playlist generation. Built for learners and collectors who maintain large libraries of Japanese audio content from DLsite.

Forked from [yodhcn/dlsite-doujin-renamer](https://github.com/yodhcn/dlsite-doujin-renamer) with significant extensions.

## Features

### Batch Folder & File Renaming
Recursively scans directories up to a configurable depth for voicework folders (identified by RJ codes), then renames them using a customizable template system. Template variables include creator name, age rating, release date, work title, voice actor list, and tags. Audio files within each folder are also renamed with automatic track and disk number extraction from filenames.

Supports both manual folder selection and drag-and-drop input.

### Metadata Scraping & Caching
Fetches detailed metadata from DLsite for each voicework: title, voice actors, tags, release date, age rating, price, file size, supported languages, and more. Results are cached in a local SQLite database (`cache.db`) to avoid redundant network requests. Rate limiting with configurable sleep intervals respects DLsite's servers.

### Audio Tag Embedding
Writes rich metadata to audio file tags (ID3, Vorbis, Opus, etc.) via [Mutagen](https://mutagen.readthedocs.io/). Standard tags cover title, album, artist, album artist, track number, genre, year, date, and more. Custom MusicBee-compatible tags include WORK_TYPE, PLATFORMS, AGE_RATING, CIRCLE_ID, PRICE, FILE_SIZE, and SUPPORTED_LANGS — enabling advanced filtering and smart playlists in music players.

### Whisper Transcription
On-device speech-to-text using [Kotoba-Whisper v2.0](https://huggingface.co/kotoba-tech/kotoba-whisper-v2.0) optimized for Japanese audio. Supports multiple GPU backends:
- **OpenVINO** — Intel CPU/GPU inference
- **CUDA** — NVIDIA GPU
- **ROCm** — AMD GPU
- **XPU** — Intel Arc/integrated GPU via Intel Extension for PyTorch
- **CPU** — Fallback for any hardware

Transcripts are saved as both `.lrc` (timed lyrics) and `.txt` (plain text) with optional translation to English, Chinese, or Korean.

### Translation
Automatic translation of metadata, scripts, and product summaries using Google Translate. Target languages: English (`en_us`), Japanese (`ja_jp`), Chinese (`zh_cn`, `zh_tw`), Korean (`ko_kr`). Translates folder names, audio tags, and imported script files.

### Cover Art & Images
Downloads and saves cover images as `cover.jpg` in each voicework folder. Optionally downloads sample preview images and thumbnails. Image validation ensures corrupted downloads are discarded.

### Script Import & Translation
Automatically imports existing transcript/script files from a `__scripts__/{id}/` directory structure. Imported scripts are translated to the configured target language and exported as both LRC (timed lyrics for audio players) and TXT formats — useful for generating study materials from community-shared transcripts.

### Smart Playlist Generation
Auto-generates M3U playlists from your library organized by:
- **Genre** — grouped by content tags
- **Content type** — categorized by work format
- **Voice actor** — one playlist per VA

Playlists can be sorted by price, rating, or release date. All playlist data is stored in a local SQLite database for efficient queries across large libraries.

### Folder Icon Assignment
Assigns custom Windows folder icons based on voicework content type for visual organization in File Explorer.

### GUI Settings Panel
All features are configurable through a live settings panel in the GUI — no manual JSON editing required. Individual features can be toggled on/off:

| Feature | Toggle |
|---------|--------|
| Folder renaming | `enable_folder_rename` |
| File renaming | `enable_file_rename` |
| Translation | `enable_translation` |
| Audio tag updates | `enable_metadata_update` |
| Cover art download | `enable_cover_art` |
| Playlist generation | `enable_playlist_generation` |
| Folder icons | `enable_folder_icon` |
| Script import | `enable_script_import` |
| Product summaries | `enable_product_summary` |
| Transcription | `enable_transcription` |

## Installation

### Requirements
- Python 3.9+
- Windows (uses pywin32 for folder icons and file operations)
- FFmpeg (for audio codec support)

### Setup
```bash
pip install -r requirements.txt
python main.py
```

### Build standalone executable
```bash
python build.py
# Output: dist/main.exe
```

### Windows long path support
If you encounter path length issues with deeply nested voicework folders:
```powershell
New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" `
    -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force
```

## Architecture

```
main.py                  Entry point (wxPython GUI)
├── modern_frame.py      Main window with settings panel, logging, drag-drop
├── renamer.py           Orchestrator coordinating all handlers
│   ├── scanner.py       Recursive filesystem scan for RJ code folders
│   ├── metadata_handler.py   DLsite metadata fetch + cache
│   ├── file_manager.py       Folder/file rename + sanitization
│   ├── image_handler.py      Cover art + sample image download
│   ├── audio_processor.py    Audio tag embedding via Mutagen
│   ├── script_manager.py     Script import + translation + LRC export
│   ├── transcriber.py        Whisper speech-to-text (multi-backend)
│   ├── playlist_manager.py   M3U playlist generation (SQLite)
│   └── title_cleaner.py      Track/disk number extraction
├── scraper/             DLsite scraping + translation + locale
│   ├── dlsite.py        DLsite HTML parser
│   ├── cached_scraper.py Scraper with SQLite caching layer
│   ├── translator.py    Google Translate integration
│   └── langs/           Locale definitions (en, ja, zh, ko)
└── config.py            JSON configuration with observer pattern
```

### Technology Stack

| Category | Technology |
|----------|-----------|
| GUI | wxPython 4.2 |
| Audio Tags | Mutagen 1.47 |
| Transcription | faster-whisper 1.0 + Kotoba-Whisper v2.0 |
| ML Backend | PyTorch 2.5 (CUDA, ROCm, XPU, CPU) |
| Intel Inference | OpenVINO + Intel Extension for PyTorch |
| Web Scraping | requests + lxml + pyquery |
| Translation | googletrans |
| Database | peewee (SQLite ORM) |
| Image Processing | Pillow |
| Build | PyInstaller |

## Audio Metadata Tags

### Standard Tags
| Tag | Content |
|-----|---------|
| title | Track title (from filename) |
| album | Work name |
| artist | Voice actors or maker name |
| albumartist | Circle/maker name |
| tracknumber | Extracted from filename |
| discnumber | Series ID if applicable |
| genre | Translated work tags |
| year / date | Release year / full date |
| comment | Detailed work information |
| description | Product summary |
| website | DLsite product page URL |

### Custom Tags (MusicBee)
WORK_TYPE, PLATFORMS, AGE_RATING, CIRCLE_ID, PRICE, FILE_SIZE, SUPPORTED_LANGS, OPTIONS, MACHINES

To use in MusicBee: Edit > Preferences > Tags (1) > Additional Tags.

## License

MIT
