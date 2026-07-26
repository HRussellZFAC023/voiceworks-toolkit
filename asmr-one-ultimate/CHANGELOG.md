# Changelog

## 174 — 2026-07-26

- Live transcription now adapts to what the GPU can actually do. Whisper's decoder keeps its KV-cache shape arithmetic in int64, which WebGPU cannot express, so those nodes fall back to CPU and force roughly eight GPU-to-CPU readbacks per generated token. Where a browser resolves those readbacks on a polling timer rather than an event (Firefox does, on a fixed ~100 ms interval — Mozilla bug 1870699), that is around 0.8 s of pure waiting per token and accounts for about 95% of total transcription time. The worker now measures readback latency directly with an empty submit and, when it is slow, runs the encoder on WebGPU and the decoder on WASM. Measured on Apple M1 / Firefox with the base model: 0.20x realtime before, 1.04-1.35x after, with kanji intact. Browsers with fast readbacks are unaffected and keep the full pipeline on the GPU.
- Precision now follows the execution device. A q4 decoder is a good choice on the GPU but has no fast path on the WASM backend — measured five times slower — so a decoder moved to WASM uses q8 instead.
- Model tier selection is driven by measured adapter behaviour rather than the user agent, so a capable GPU is never downgraded to protect a slower browser, and an explicitly chosen model stays pinned exactly.
- Added an Advanced section to the Whisper settings, collapsed by default, exposing the custom model ID, encoder and decoder precision, execution device, window length and overlap, the anti-repetition parameters and the task, each with its measured trade-off stated plainly. Invalid entries are refused rather than silently clamped or repaired.
- Removed the duplicate fullscreen control: the host player already ships one, and the second was reported as unwanted. Fullscreen behaviour is unchanged and still available from the keyboard shortcut.
- Transcription status is now a single compact line that cannot appear twice, cannot be covered by or overlap the artwork, and reserves stable geometry so showing or changing it never reflows the player.
- Fixed a settings layout defect at narrow widths where an action row could overlap the row above it once its label wrapped.

## 173 — 2026-07-26

- Fixed a settings-panel layout defect at narrow widths: Quasar's gutter helper pulls its container up with a negative top margin, so an action row directly below a list item overlapped that item as soon as its label wrapped, which it always did at phone widths. Action buttons now wrap instead of running past the panel edge.
- Release-suite corrections only, otherwise identical to 172: the suite no longer fails on intermittent errors thrown by the host site's own bundle during navigation (its autoplay observer throws while our script is merely present), page errors now retain their stack so an intermittent failure is diagnosable, and the Google client assertion reads the effective configuration rather than raw storage that nothing writes now the client-ID row is gone.

## 172 — 2026-07-26

- Fixed the root cause of inaccurate live transcription: Whisper decoded greedily with no anti-repetition, so non-verbal ASMR audio (laughter, breaths, rustling) sent it into unbounded token loops that consumed a whole window's budget and swallowed the real speech in it. Measured on a 150-second Japanese ASMR excerpt against its published script, whisper-small went from 124.1% character error rate with a 120-character repeat run to 26.1% with no repeat run, and inference got 46% faster because tokens are no longer spent looping.
- Band-limited the live audio path before decimation. At a 48 kHz AudioContext the resampler dropped two of every three samples with no filter, folding all 8–24 kHz energy — exactly where whispers, sibilance, mouth clicks and tapping live — back onto the speech band at full amplitude. Anti-aliasing is now an 8th-order Butterworth cascade with state carried across callbacks, with a test asserting the alias is at least 40 dB down.
- Applied the correlation-aware downmix to decoded audio as well as live capture. The decoded path used the plain 0.5·(L+R) sum, which comb-filters or cancels the anti-phase content common in binaural ASMR, so the same track transcribed differently depending on which path ran.
- Restored a short first window after start and after every scrub, so a caption appears in a few seconds instead of requiring a full 29-second buffer; and bounded the quiet-window retry, which previously credited a 29-second window with 12 seconds on anything above −100 dBFS and so fired constantly on room tone.
- Live transcription now re-anchors to the playhead once it falls irrecoverably behind, recording the skipped span as unavailable rather than silently omitting it. Previously any lag became permanent for the rest of the track and only a manual scrub reset it.
- Auto model selection is now driven by measured GPU capability instead of user-agent sniffing. Adapters exposing WebGPU subgroups run the full configured model; adapters measurably lacking them use a conservative tier. An explicitly chosen model stays pinned regardless. The `tiny` preset now uses the timestamped export, which restores word-level karaoke at identical download size.
- Fixed authenticated media and playlist requests. The host stores its session token through Quasar's LocalStorage plugin, so the raw value is type-tagged; seven call sites sent it verbatim as `Authorization: Bearer __q_strn|…`, which every authenticated endpoint rejects. Token access is centralised and normalised.
- Fixed no native subtitles (GitHub issue #3). The check-lrc lookup percent-encoded a media hash whose `workId/trackIndex` separator then tripped the function's own URL guard, so every native subtitle discovery threw and was swallowed at debug level.
- Fixed work-folder images failing to open in the lightbox. Media requests to official ASMR origins had lost their privileged transport and authentication, so thumbnails still rendered while the lightbox could not read bytes. A single failed image also no longer deletes entries from the gallery.
- The Download Center now works in Firefox. The Chromium-only folder-picker gate is replaced by a sink abstraction with an OPFS-backed implementation and a per-work ZIP export, so resume, checkpointing and Opus conversion behave the same across browsers.
- One unreadable work no longer aborts an entire multi-work download; it is recorded as skipped and the run continues. Unclassified failures now report an actionable cause instead of a generic wall, and progress never renders a bare `0 / 0`.
- Removed all three site-search caps (single page, semantic limit 20, and a hard 30-row slice), added real total counts and progressive loading, made size enrichment lazy so rows no longer sit on `Loading…`, kept results visible while the query is edited, and added an "open work page" link to every row.
- Fixed garbled Japanese filenames: truncation split UTF-16 surrogate pairs, and legacy CP932 repair was too strict to fix partially corrupted names. Truncation is now code-point and UTF-8 byte aware.
- Fixed Advanced Search hanging on "Loading tags…". A request that never settled left the state stuck with no exit, and an empty-but-successful response poisoned the label cache for five minutes so every retry was a silent no-op. Failures are now distinguishable from empty results and offer a retry.
- Fixed favourite voice actors and circles not persisting: dialogs anchored to the host toolbar were destroyed and remounted when the host replaced it. The same latent defect is fixed in semantic search and Flat View.
- Translation now keeps up with newly loaded content and card recycling, no longer renders duplicate labels, and makes clipped card text and the mini-player title reachable in full. Traditional Chinese is no longer silently served Simplified, and official Chinese tag names are used.
- Settings: removed the Google Drive OAuth client-ID surface and its stale documentation, corrected the model download sizes, and fixed row overlap and light-theme contrast.

## 171 — 2026-07-25

- Kept the user's selected Whisper model and backend exact while giving Firefox/M1 Auto timestamped Base for accurate word-aligned karaoke and adaptive scheduling between an eight-second foreground window and the configured ASMR-quality window from measured real-time throughput and playhead-local lag. Status now reports current throughput and local backlog, queue backpressure remains bounded, and random seeks resume at the settled destination without corrupting whole-track coverage.
- Removed timestamp-like control tokens from learner captions, conservatively capped only pathological runs of 12 or more identical short Whisper segments, retained late lines long enough to read, stopped retry storms after native subtitle authorization failures while still accepting late host metadata, and reserved stable subtitle/player geometry to reduce content shift.
- Routed hash-only gallery, lightbox, Flat View, and download media through the official API origin, rejected unsafe or deeply encoded hash paths, prevented JWT leakage to external URLs, and accepted mislabeled image responses only after raster-byte verification.
- Preferred complete work-tree media metadata over skeletal DOM rows, restored hash-only gallery navigation and verified downloads, and bounded userscript-manager download callbacks that never resolve.
- Made unavailable title translation a recoverable download state with explicit retry or “Resume with Original titles” actions, and retained selected cover artwork from the saved work snapshot when optional metadata is slow.
- Made common sub-256 MiB audio downloads durable every 64 MiB and safely resumable even when the media CDN omits HTTP validators by matching SHA-256 samples from the committed local prefix/boundary against the same canonical remote object before appending.
- Detected late Whisper backfills across cumulative cached results so an earlier recovered line is briefly surfaced as delayed even when the final cached segment did not change.
- Gave cold WebGPU shader compilation and each actual adaptive window their own bounded watchdogs, poisoned and recreated failed ORT sessions only after Firefox released the prior GPU owner, and resumed from the earliest unfinished audio on the exact user-selected model/backend; also hardened English-gate recovery, audio-stall handling, and work-metadata image verification.
- Invoked stored browser fetch functions without an invalid class receiver so Firefox can load the hosted semantic baseline, validate resumable byte ranges, and prepare the optional Opus worker without weakening origin or checkpoint checks.

## 166 — 2026-07-16

- Made Site the default Download Center view, with whole-catalog semantic and live search kept separate from lazy-loaded Yours and Community playlist tabs.
- Added work cover thumbnails and background track-manifest size discovery, including category-aware partial totals that update when file-type or Opus options change.
- Prevented repeated or cancelled preview enrichment from corrupting size state, continuing after unmount, or stalling a user-started download.

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
