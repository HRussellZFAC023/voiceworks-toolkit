# Voiceworks Toolkit

Tools for Japanese language learning and library management with native voiceworks from DLsite and [asmr.one](https://as.mr).

## [よむ](yomu/) — JPDB/Yomitan Popup Reader

Standalone Tampermonkey userscript for Japanese lookup and mining on any website.

- **JPDB popups** — Tap scanned words, mine to decks, review with JPDB grades, and open the matching JPDB page.
- **Yomitan dictionaries** — Import Yomitan settings, dictionary ZIPs, and Dexie exports for local term, kanji, frequency, and pitch lookup.
- **Manga OCR** — Auto-scan nearby images through a YomiNinja-style OCR endpoint and tap recognized text to mine it.
- **Video mining** — ASB-style Japanese/native subtitle overlay, transcript side panel, local subtitle files, and optional MPV bridge mining.
- **iOS-first audio** — Yomitan-compatible audio sources, Blob playback, auto-play, and random/first source selection.

## [Voiceworks Ultimate](asmr-one-ultimate/) — Browser Enhancement Suite

Tampermonkey userscript that transforms asmr.one into a full-featured Japanese learning platform. All AI runs locally in the browser.

- **Learner Mode** — Real-time dual-language subtitles (Japanese primary, blurrable English secondary) with speed control
- **Live Transcription** — On-device Whisper speech-to-text (WebGPU-accelerated), turning any audio into study material
- **Neural Translation** — Two local translation models (JA→EN, ZH→EN) in Web Workers with 8ms batch coalescing
- **Semantic Search** — Find voiceworks by meaning using Jina v3 vector embeddings in IndexedDB
- **Radio & Playlist Modes** — Continuous immersion playback with community playlists
- **30+ Features** — Keyboard shortcuts, infinite scroll, audio visualizer, progress tracking, media viewer, and more

## [Voiceworks Renamer](voiceworks-renamer/) — Desktop Library Organizer

Python desktop app for batch-organizing voicework libraries with metadata enrichment, transcription, and playlist generation.

- **Batch Rename** — Folder and file renaming with customizable templates using scraped DLsite metadata
- **Whisper Transcription** — Kotoba-Whisper v2.0 with multi-backend support (CUDA, ROCm, OpenVINO, XPU, CPU)
- **Audio Tagging** — Rich metadata embedding (ID3, Vorbis, Opus) with MusicBee custom tags
- **Translation** — Auto-translate metadata, scripts, and summaries (EN, JA, ZH, KO)
- **Smart Playlists** — Auto-generated M3U playlists by genre, voice actor, and content type
- **Script Import** — Import community transcripts, translate, and export as LRC/TXT
