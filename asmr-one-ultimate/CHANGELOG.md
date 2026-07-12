# Changelog

## 154 — 2026-07-11

- Added automatic recovery from ASMR.one's English-language frontend gate: the userscript restores the trusted SPA in place with Chinese-first direct privileged requests while preserving the real origin, login, and storage. Bootstrap and lazy-route JS/CSS are preloaded only after exact final-URL, MIME/file-type, Webpack registration, and byte-budget checks, so later routes do not fall back to blocked English-first browser requests. Proxy use remains limited to non-executable CSS dependencies and supported API reads.
- Added emergency playlist export in JSON, CSV, and TXT with strict separation between the user's playlists and public/community playlists; snapshots are also retained in userscript storage.
- Added Google Drive backup with a maintained public OAuth client, the least-privilege `drive.file` scope, and two clearly named JSON files.
- Added favourite voice actor and circle filters for advanced search (GitHub #1).
- Added Japanese-to-Chinese translation support across titles, metadata, reviews, tags, flat view, and static interface labels (GitHub #2), stronger source-echo rejection, and an optional OpenAI-compatible custom translation endpoint/model/key.
- Added raw untranslated Japanese transcript TXT export.
- Reworked Whisper startup to prepare the verified media CDN before playback, capture a bounded three-minute live PCM window from the already-playing element, and load the model concurrently. If capture is unavailable, it tries the host's smaller stream first and permits a full-stream compatibility decode only when its reported size is at most 32 MiB; automatic offline full-track caching is now opt-in, so the normal path does not duplicate the player download.
- Added size-aware audio decode/render/model/inference timeouts, smaller-model/WASM recovery, a conservative `whisper-tiny` policy for constrained Apple/Firefox adapters, and complete Whisper enable/disable cleanup to prevent indefinite stalls and lifecycle leaks.
- Isolated Whisper downloads and worker callbacks by transcription/worker generation, and deduplicated warmup/start model initialization so stale async work cannot stop or dispose a replacement run.
- Made JPDB use the same v1 Bearer-key contract and CORS-safe userscript transport as Yomu, so one JPDB API key works in both.
- Reduced origin load with paced playlist, discovery, review, and export batches.
- Removed the core Config/AppStore/EventBus/Logger circular dependency and gated lazy imports so the latest SPA toggle always wins.
- Moved Media Session, radio/public controls, recovery, and non-ML feature registration ahead of optional embedding warmup so core playback features are ready immediately.
- Added current/legacy host playback-command negotiation (`WANT_PLAY`/`WANT_PAUSE` with older fallbacks), fixed Flat View queue activation, and kept Learner/Whisper controls mounted when the host exposes only its compact footer player.
- Restored pointer access to the player gallery/lightbox with quiet transparent controls that reveal on hover/focus (and remain touch-accessible), made translated mini-player titles use stable one-line ellipsis with the full title available on hover, and added lazy verified-blob loading that rejects Cloudflare's HTTP-200 restriction image by exact redirect or digest while preferring the maintained Japan relay for DLsite images.
- Made Chinese-to-Japanese subtitle/title translation active by default for clean installs, kept explicit opt-outs, removed settings CSS that could partially overwrite the host theme, and moved the proxy donation/Yomu notice into a prominent lifecycle-safe banner below the live header.
- Reordered Flat View and Media Viewer queue replacement to protect synchronous host watchers from stale indexes, and restored action-only media-session play/pause compatibility.
- Added strict allowlist sanitization for remote review/metadata HTML and escaped remote or persisted strings in imperative DOM templates.
- Redacted API credentials from diagnostics and excluded them from downloadable settings backups; custom-translation cache writes now stay bound to the provider that started each request.
- Removed superseded pre-Vue feature implementations and updated stale infinite-scroll E2E assertions to the active controller architecture.
- Registered Learner Mode, Infinite Scroll, and Playlist Discovery with the shared toggle lifecycle; guarded deferred list/search/media/playlist work against post-disable writes; and made transcript badges prefer exact hashes while rejecting ambiguous duplicate filenames.
- Minified production builds and added a hard 2 MiB bundle-size gate (about 1.23 MB in this release candidate).
- Upgraded the Vite/Vitest development toolchain to patched releases and restored a zero-advisory `npm audit` baseline.
- Added `E2E_PROXY`, `E2E_PROXY_URL`, and `E2E_SKIP_WEBSERVER` test modes for blocked/restricted networks.
