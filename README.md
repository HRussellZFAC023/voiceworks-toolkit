# Voiceworks Toolkit

Browser enhancement toolkit for Japanese language learning with native voiceworks on [asmr.one](https://asmr.one).

## [Voiceworks Ultimate](asmr-one-ultimate/) — ASMR.one Browser Enhancement Suite

Tampermonkey userscript that transforms asmr.one into a full-featured Japanese learning platform. Whisper runs on-device; translation and optional semantic-search providers are remote and cached.

- **Learner Mode** — Real-time dual-language subtitles (Japanese primary, blurrable English secondary) with speed control
- **Live Transcription** — On-device Whisper speech-to-text (WebGPU-accelerated), turning any audio into study material
- **Translation** — Cached Google translation with echo detection, JA↔ZH support, and optional OpenAI-compatible custom endpoints
- **Semantic Search** — Find voiceworks by meaning using Jina v3 vector embeddings in IndexedDB
- **Radio & Playlist Modes** — Continuous immersion playback with community playlists
- **Resilience** — Region-gate API fallback, separate own/public emergency playlist backups, and optional Google Drive upload
- **30+ Features** — Keyboard shortcuts, infinite scroll, audio visualizer, progress tracking, media viewer, and more
