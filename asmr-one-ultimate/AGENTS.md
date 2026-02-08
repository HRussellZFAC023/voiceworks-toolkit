ASMR.one Ultimate – Agents Operational Manual

Welcome to ASMR.one Ultimate, a feature-packed userscript designed to enhance asmr.one with continuous playback (“Radio Mode”), bilingual subtitles (“Learner Mode”), semantic search, and more. This AGENTS.md manual is written for AI coding agents (and human maintainers) who will fix bugs, implement features, and maintain parity with the legacy script’s behavior. It provides a comprehensive understanding of the project’s architecture, user experience, and known quirks – enabling agents to collaborate effectively through issue queues and iterative development.

Issue Checklist

- [x] Settings / UX: /settings should show our settings options, but currently doesn't
- [x] Settings / UX: Settings injection/event binding is broken (remove inline handlers / fix context isolation)
- [x] Settings / UX: Add API key input option to the settings page
- [x] Metadata / Performance: Metadata fetch per work is too slow -> batch fetch + cache, fetch everything in one go
- [x] Metadata / Performance: Translations should be done in parallel (not serial), with caching
- [x] Metadata / Performance: Any DLsite search / metadata lookup must be locally cached
- [x] Metadata / Performance: DLsite metadata errors like "Empty API response" need robust parsing + fallback
- [x] Learner Mode / Subtitles: Learner mode subtitle features regressed (restore expected behaviour fully)
- [x] Learner Mode / Subtitles: There are two subtitle views (expanded + minimised) — both must work and stay in sync
- [x] Learner Mode / Subtitles: Blur behaviour should match expected UX (click-to-reveal behaviour, not fragile toggles)
- [x] Learner Mode / Subtitles: Mini-player subtitles missing / inconsistent — fix
- [x] Whisper Transcription: Whisper search/transcribe fails: [Whisper] No audio source found to transcribe.
- [x] Whisper Transcription: Whisper icon is ugly / misaligned — make it blend with learner controls
- [x] Whisper Transcription: Whisper should support live Japanese transcription
- [x] Whisper Transcription: Investigate best Whisper model for live JP in-browser (Whisper Web / worker)
- [x] Whisper Transcription: If Whisper is toggled on, inject live transcription as subtitles (override static subs when desired)
- [x] Radio Mode / Playback: Radio mode only goes to the first track — should be random depending on selection
- [x] Radio Mode / Playback: Shuffle isn't being honored / starts at track 0 too often — fix track choice + queue shuffle logic
- [x] Tags / Search / Discovery: Multitag filtering from the homepage is not set up
- [x] Tags / Search / Discovery: /tags / /circles / /vas search only works in Japanese — English should work too
- [x] Tags / Search / Discovery: Improve the vector search dialog: Rename "Magic Search" -> something better
- [x] Tags / Search / Discovery: Improve the vector search dialog: Increase search icon size so it looks better
- [x] Tags / Search / Discovery: "100 works indexed" currently only indexes first 5 pages — pressing again should do next pages (pagination)
- [x] Tags / Search / Discovery: Search behaviour to DLsite must be cached (again: local cache)
- [x] UI Consistency: Toggle state color should use a purple accent (and apply this consistently everywhere)
- [x] Dialog UX: Add the shared dialog sizing/style injection to all dialogs
- [x] Quality / Tests: Add tests so fixes don't regress (at least smoke tests for core flows)
- [x] Vector Search: Auto-populate the vector index (or offer “index on demand” with throttling) so it isn’t empty by default
- [x] Vector Search: Indexing must be resumable (store last indexed page/cursor so it can continue later)
- [x] Vector Search: Embedding requests should run in parallel (with rate limiting) + cache embeddings per work
- [x] Radio Mode: Avoid repeating the same works too frequently (keep a short history buffer)
- [x] Radio Mode: Choose a random *starting track* intelligently (avoid always picking track 0 / avoid “cover” folders)
- [x] Playback: Improve stuck-audio recovery (detect “play didn’t start” and retry with backoff)
- [x] Playback: Flat View toggle placement + behavior parity (if still required)
- [x] Learner Mode: Clean up injected subtitle UI on route change (no ghost UI / duplicates)
- [x] Learner Mode: Hide subtitle containers when no subtitles exist (avoid empty blocks)
- [x] Learner Mode: Ensure learner controls don’t break layout on small screens (responsive sizing)
- [x] Tag Filters: Show active filters clearly (chips/toggles) and allow quick removal
- [x] Tag Filters: Multi-tag filters should persist across navigation (homepage → work → back)
- [x] Caching: Add a central cache layer with TTL + consistent keys for DLsite, work metadata, translations, tag translations
- [x] Caching: Add request de-duping (multiple requests for same key share one network call)
- [x] UI: Consolidate CSS injection (avoid multiple competing style blocks)
- [x] UI: Fix dark mode hover/active states (avoid unreadable black-on-dark)
- [x] Tests: Add a minimum smoke test suite for core flows (settings, radio, learner, whisper, vector dialog)
- [x] Runtime: Add startup self-check logging (bridge/store/selectors ready) to reduce false “fixed” reports
- [x] Whisper / Streaming: Streaming Playback Broken (HLS not supported). Decision: Detect HLS and warn user.
- [x] Settings / Whisper: Allow user to choose Whisper model and quantization.
- [x] Infrastructure / Cache: Handle key quota limits and eviction errors gracefully.
- [x] UI / Layout: Fix bottom bar icon alignment on small screens.
- [x] UI / Learner: Fix vertical centering of collapsed subtitle controls.
- [x] UI / Header: "Magic Search" button doesn't use theme accent color.
- [x] Playlist / Playback: Playback stops after last track instead of advancing to next work.
- [x] UI / Sidebar: Add clear visual indicator when "Playlist Mode" is active.
- [x] Playlist Generator: Search returns no results/invalid results with filters (CV, Duration).
- [x] Playlist Generator: Rename feature to "Advanced Search".

Completed Fixes

- Settings / UX: /settings should show our settings options, but currently doesn't. Root cause: SettingsManager was never constructed after bridge init, so the settings injector never ran. Changed: instantiate SettingsManager during bootstrap in `asmr-one-ultimate/src/main.ts`. Verify: open `/settings` and confirm Radio/Magic sections render, or run `npm test` in `asmr-one-ultimate`.
- Settings / UX: Settings injection/event binding is broken (remove inline handlers / fix context isolation). Root cause: same as above; injected sections were never created, so event delegation never attached. Changed: SettingsManager now runs on `/settings` and binds events through delegated listeners (no inline handlers). Verify: open `/settings`, toggle Shuffle, confirm UI state flips and persists.
- Settings / UX: Add API key input option to the settings page. Root cause: API key field existed but wasn't localized and never injected due to SettingsManager not running. Changed: localize the Magic Search header and API key label via `I18n` and inject the `vectorSearchApiKey` input. Verify: open `/settings`, confirm the API key input appears under Magic Search.
- Metadata / Performance: Metadata fetch per work is too slow -> batch fetch + cache, fetch everything in one go. Root cause: DLsite lookups were sequential across domains and repeated every visit, causing slow metadata panels. Changed: parallelize product + dynamic API fetches, add in-memory + GM storage caching, and gate concurrent requests in `asmr-one-ultimate/src/features/DLsiteScraper.ts`. Verify: run `npm test -- --run tests/scrapers/DLsiteScraper.test.ts` in `asmr-one-ultimate`, then open a work page twice and confirm the second metadata fetch is near-instant with no extra network calls.
- Metadata / Performance: Translations should be done in parallel (not serial), with caching. Root cause: tag translations were awaited one-by-one, delaying tag hydration. Changed: batch translations with `Promise.all` in `asmr-one-ultimate/src/features/EnglishTags.ts`. Verify: run `npm test -- --run tests/features/EnglishTags.test.ts` in `asmr-one-ultimate`.
- Metadata / Performance: Google Translate rate limiting caused repeated failures and retry storms. Root cause: translation retries ran every observer tick without cooldown and remote requests were unthrottled. Changed: add per-element pending/fail state with cooldown in `asmr-one-ultimate/src/features/TranslatedTags.ts`, and add a global throttled remote queue in `asmr-one-ultimate/src/services/TranslationService.ts` so Google requests are paced and local translation batches always run first. Verify: open a work with many JP tags/tracks, confirm translations appear gradually without 429 spam in the console.
- Translations / UX: Work listing card titles and circle/studio names were not translated in grid view. Root cause: selectors only covered list items and similar-works titles. Changed: add card meta selectors (`.text-subtitle1 .text-grey.ellipsis`) and grid title selectors (`.ellipsis-2-lines a[href*="/work/"]`, `.q-card .text-h6 a[href*="/work/"]`) in `asmr-one-ultimate/src/features/TranslatedTags.ts`. Verify: open `/works` in grid view and confirm titles + circle names translate.
- Metadata / Performance: Any DLsite search / metadata lookup must be locally cached. Root cause: repeat lookups always hit DLsite/Jina. Changed: added persistent GM cache with TTL in `asmr-one-ultimate/src/features/DLsiteScraper.ts`. Verify: open the same work twice and check that DLsite API calls only happen once.
- Metadata / Performance: DLsite metadata errors like \"Empty API response\" need robust parsing + fallback. Root cause: payload shape variance caused scraper to throw. Changed: broadened payload parsing and added minimal fallback in `asmr-one-ultimate/src/features/DLsiteScraper.ts`, plus a fallback test in `asmr-one-ultimate/tests/scrapers/DLsiteScraper.test.ts`. Verify: run `npm test -- --run tests/scrapers/DLsiteScraper.test.ts` in `asmr-one-ultimate`.
- Learner Mode / Subtitles: Learner mode subtitle features regressed (restore expected behaviour fully). Root cause: blur state was reset and mini controls didn't mount consistently. Changed: reset blur per line, add hover reveal via existing fixes, mount controls on `.player-bar`, and handle viewport visibility in `asmr-one-ultimate/src/features/LearnerMode.ts` and `asmr-one-ultimate/src/styles/learner.css`. Verify: run `npm test -- --run tests/features/LearnerMode.test.ts` in `asmr-one-ultimate`, then confirm EN starts blurred and the mini bar shows subtitles.
- Learner Mode / Subtitles: There are two subtitle views (expanded + minimised) — both must work and stay in sync. Root cause: collapsed mount paths and updates weren't consistent. Changed: always update both JP/EN nodes and allow `.player-bar` to host controls in `asmr-one-ultimate/src/features/LearnerMode.ts`. Verify: play a subtitled track and confirm both panels show the same line.
- Learner Mode / Subtitles: Blur behaviour should match expected UX (click-to-reveal behaviour, not fragile toggles). Root cause: blur was removed on each update. Changed: default EN to blurred and keep click toggle in `asmr-one-ultimate/src/features/LearnerMode.ts` (hover reveal remains in fixes). Verify: start playback and confirm EN blurs until click/hover.
- Learner Mode / Subtitles: Mini-player subtitles missing / inconsistent — fix. Root cause: controls were appended only when `.player-bar` was a descendant, not the root. Changed: treat `.player-bar` and `.q-footer` as valid roots and gate visibility on viewport in `asmr-one-ultimate/src/features/LearnerMode.ts`. Verify: scroll the main player out of view and confirm the mini subtitle bar appears.
- Whisper Transcription: Whisper search/transcribe fails: [Whisper] No audio source found to transcribe. Root cause: Whisper only read a narrow set of fields. Changed: resolve URLs from queue/playlist/audio element fallback in `asmr-one-ultimate/src/features/Whisper.ts`, with tests in `asmr-one-ultimate/tests/features/Whisper.test.ts`. Verify: run `npm test -- --run tests/features/Whisper.test.ts` in `asmr-one-ultimate`.
- Whisper Transcription: Whisper icon is ugly / misaligned — make it blend with learner controls. Root cause: button styling didn't match learner controls. Changed: mount inside learner control groups and align sizing in `asmr-one-ultimate/src/features/Whisper.ts` and `asmr-one-ultimate/src/styles/fixes.css`. Verify: open a work page and confirm alignment in both player bars.
- Whisper Transcription: Whisper should support live Japanese transcription. Root cause: Whisper defaulted to translation mode. Changed: default to `subtask: transcribe` with Japanese language in `asmr-one-ultimate/src/features/Whisper.ts`. Verify: run a JP track and confirm Japanese output.
- Whisper Transcription: Investigate best Whisper model for live JP in-browser (Whisper Web / worker). Root cause: model defaults were hard-coded. Changed: select `whisper-tiny-quantized` for low-memory/mobile, otherwise `whisper-tiny` in `asmr-one-ultimate/src/features/Whisper.ts`. Verify: check console logs for selected model and confirm transcription starts on mobile.
- Whisper Transcription: If Whisper is toggled on, inject live transcription as subtitles (override static subs when desired). Root cause: live updates were ignored by Learner Mode. Changed: dispatch live updates from Whisper and prefer them in Learner Mode when `whisperOverrideSubs` is enabled in `asmr-one-ultimate/src/features/Whisper.ts`, `asmr-one-ultimate/src/features/LearnerMode.ts`, and `asmr-one-ultimate/src/core/Utils.ts`. Verify: start Whisper and confirm the subtitle panel updates during transcription.
- Whisper Transcription: AI auto-transcribe CORS failure on cross-origin audio. Root cause: Whisper fetched audio with `credentials: include` for all URLs, triggering CORS rejection on `raw.kiko-play` responses with wildcard origins. Changed: route cross-origin audio through GM_xmlhttpRequest or fetch with `credentials: omit` in `asmr-one-ultimate/src/features/Whisper.ts`, with tests in `asmr-one-ultimate/tests/features/Whisper.test.ts`. Verify: run `npm test -- --run tests/features/Whisper.test.ts` in `asmr-one-ultimate`, then transcribe a `raw.kiko-play` track and confirm no CORS error in the console.
- Whisper Transcription: Model warmup stuck/unauthorized + settings localization. Root cause: model warmup could stall or hit HF 401/403 with no fallback, and Whisper model/task options were hardcoded in English. Changed: added warmup timeout + fallback chain + WASM retry and HF mirror support in `asmr-one-ultimate/src/features/Whisper.ts` + `asmr-one-ultimate/src/features/WhisperWorkerLoader.ts`, plus localized model/task labels in `asmr-one-ultimate/src/features/SettingsManager.ts` + `asmr-one-ultimate/src/core/Config.ts`. Verify: click Download Model on `/settings`, watch localized status updates, and confirm warmup retries on mirror or falls back to smaller models instead of hanging.
- Whisper Transcription: Real-time sync + transcript downloads. Root cause: live alignment drifted under backlog, Xenova defaults conflicted with onnx-community, and cached transcripts were not exposed for download. Changed: tightened chunk/backpressure timing and word-level interpolation in `asmr-one-ultimate/src/features/Whisper.ts`, removed Xenova defaults in `asmr-one-ultimate/src/features/SettingsManager.ts`, added transcript index + LRC/VTT generation and translated LRC caching in `asmr-one-ultimate/src/features/Whisper.ts`, and injected download buttons into the work tree/flat view via `asmr-one-ultimate/src/features/TranscriptFileInjector.ts` + styles in `asmr-one-ultimate/src/styles/fixes.css`. Verify: transcribe a track, re-open the work tree and confirm LRC download buttons appear (and translated LRC if available), then replay the track to see instant cache reuse.
- Whisper Transcription: WebGPU errors + model fallback order + audio graph crashes. Root cause: memory errors could trigger the wrong fallback order, and the audio element could only be connected once, causing InvalidStateError on re-init. Changed: rebuilt fallback lists by size in `asmr-one-ultimate/src/features/WhisperWorkerLoader.ts` and cache/reuse MediaElementAudioSourceNode graphs instead of recreating them in `asmr-one-ultimate/src/features/Whisper.ts`. Verify: trigger a memory error and confirm it falls back to smaller models, then toggle Whisper on/off multiple times and confirm no "HTMLMediaElement already connected" error.
- Whisper Settings: Allow arbitrary model IDs (including Xenova). Root cause: model dropdown was a fixed select with only onnx-community values, and normalization forced unsupported values back to defaults. Changed: switched the combobox to a free-typing datalist and allowed arbitrary model IDs while still offering suggested options in `asmr-one-ultimate/src/features/SettingsManager.ts`, and relaxed model normalization in `asmr-one-ultimate/src/features/Whisper.ts` / `asmr-one-ultimate/src/features/WhisperWorkerLoader.ts` to pass through custom model IDs. Verify: type a custom Hugging Face model ID in the Whisper Model field, save it, and confirm the value persists and the worker attempts to load it.
- Whisper Sync + Translation Settings: Real-time chunk timing drifted and translation settings were buried under Radio. Root cause: chunk start times were computed from a stale time base, and local translation settings lived in the Radio section with no clear model download path. Changed: derive chunk start times from the live buffer anchor in `asmr-one-ultimate/src/features/Whisper.ts`, move local translation settings into a new Translation section with a download button in `asmr-one-ultimate/src/features/SettingsManager.ts`, wire translation model warmup + progress events in `asmr-one-ultimate/src/services/TranslationService.ts`, and update the translation worker language handling in `asmr-one-ultimate/src/features/TranslationWorkerLoader.ts`. Verify: start Whisper and confirm chunk offsets track playback time, then open `/settings` and see Translation Settings with a working download progress indicator.
- Radio Mode / Playback: Radio mode only goes to the first track — should be random depending on selection. Root cause: shuffle seeding only used sparse queues and could default to index 0. Changed: resolve playable tracks from queue/work/VM and shuffle before playback in `asmr-one-ultimate/src/features/RadioMode.ts`, with tests in `asmr-one-ultimate/tests/features/RadioMode.test.ts`. Verify: run `npm test -- --run tests/features/RadioMode.test.ts` in `asmr-one-ultimate`, then enable Shuffle + Radio and observe different start tracks.
- Radio Mode / Playback: Shuffle isn't being honored / starts at track 0 too often — fix track choice + queue shuffle logic. Root cause: playlist actions could reset queue index. Changed: prefer `SET_QUEUE` with index and shuffle copies before playback in `asmr-one-ultimate/src/features/RadioMode.ts`. Verify: turn on Shuffle and confirm the initial track is not always the first.
- Tags / Search / Discovery: Multitag filtering from the homepage is not set up. Root cause: TagFilters only dispatched Works/search, so clicking tags on home never navigated to the works list; single-tag searches also kept stale tag_id when multiple tags were selected. Changed: always push to `/works` with `tags` query and clear/set `tag_id` based on tag count in `asmr-one-ultimate/src/features/TagFilters.ts`, plus updated tests in `asmr-one-ultimate/tests/features/TagFilters.test.ts`. Verify: run `npm test -- --run tests/features/TagFilters.test.ts` in `asmr-one-ultimate`, then click multiple homepage tags and confirm the works list opens with combined tags.
- Tags / Search / Discovery: /tags / /circles / /vas search only works in Japanese — English should work too. Root cause: tag lists weren’t augmented on `/tags`, so the List page filter only matched Japanese names. Changed: allow `/tags` entity list augmentation and tag list mapping via `asmr-one-ultimate/src/features/EnglishTags.ts`, plus added coverage in `asmr-one-ultimate/tests/features/EnglishTags.test.ts`. Verify: run `npm test -- --run tests/features/EnglishTags.test.ts` in `asmr-one-ultimate`, then open `/tags` and type an English tag name to filter.
- Tags / Search / Discovery: Improve the vector search dialog: Rename "Magic Search" -> something better. Root cause: UI labels were hardcoded as "Magic Search" in settings and the dialog. Changed: renamed labels to "Semantic Search" in `asmr-one-ultimate/src/core/Utils.ts` and `asmr-one-ultimate/src/features/VectorSearch.ts`. Verify: open the header button tooltip and the dialog title to confirm "Semantic Search" is shown.
- Tags / Search / Discovery: Improve the vector search dialog: Increase search icon size so it looks better. Root cause: the search button icon used default sizing inside a dense button. Changed: set a larger icon size for `.asmr-vector-go` in `asmr-one-ultimate/src/features/VectorSearch.ts`. Verify: open the vector search dialog and confirm the search icon is visibly larger in the search button.
- Tags / Search / Discovery: "100 works indexed" currently only indexes first 5 pages — pressing again should do next pages (pagination). Root cause: bulk indexing always started at page 1 and never advanced its cursor. Changed: add a bulk index cursor and startPage tracking in `asmr-one-ultimate/src/features/VectorSearch.ts`, plus coverage in `asmr-one-ultimate/tests/features/VectorSearch.test.ts`. Verify: run `npm test -- --run tests/features/VectorSearch.test.ts` in `asmr-one-ultimate`, then click Build Index twice and confirm it fetches later pages.
- Tags / Search / Discovery: Search behaviour to DLsite must be cached (again: local cache). Root cause: DLsite lookups were previously feared to bypass cache, but inspection shows all DLsite requests flow through `DLsiteScraper` which already implements GM + memory caching. Changed: no new code; verified that DLsite requests are centralized and covered by existing cache/tests. Verify: run `npm test -- --run tests/scrapers/DLsiteScraper.test.ts` in `asmr-one-ultimate` and confirm repeated scrapes do not refetch.
- UI Consistency: Toggle state color should use a purple accent (and apply this consistently everywhere). Root cause: toggles used mixed green/pink accents, leading to inconsistent UI cues. Changed: introduced `--asmr-accent` and `.asmr-accent` in `asmr-one-ultimate/src/styles/fixes.css`, switched settings toggles and sidebar radio status to the accent in `asmr-one-ultimate/src/features/LearnerMode.ts`, `asmr-one-ultimate/src/styles/learner.css`, and `asmr-one-ultimate/src/ui/SidebarMenu.ts`. Verify: open `/settings` and confirm toggles use the purple accent, then toggle Radio Mode and confirm the sidebar status label turns purple.
- Dialog UX: Add the shared dialog sizing/style injection to all dialogs. Root cause: injected dialogs relied on defaults and did not share sizing. Changed: added a shared dialog sizing injector in `asmr-one-ultimate/src/core/Utils.ts` and applied it at startup via `asmr-one-ultimate/src/main.ts`. Verify: open any injected dialog (Semantic Search or Playlist Builder) and confirm scroll areas and plugin dialog widths match the shared sizing.
- Quality / Tests: Add tests so fixes don't regress (at least smoke tests for core flows). Root cause: regression coverage for core flows was thin. Changed: added/extended feature tests across settings, tags, vector search, and radio/learner/whisper flows (see `asmr-one-ultimate/tests/features`). Verify: run `npm test -- --run tests/features/SettingsManager.test.ts` and `npm test -- --run tests/features/VectorSearch.test.ts` in `asmr-one-ultimate`.
- Vector Search: Auto-populate the vector index (or offer “index on demand” with throttling) so it isn’t empty by default. Root cause: indexing didn’t run unless manually triggered. Changed: verified existing auto-index on open/background (`scheduleBackgroundIndex` + `ensureAutoIndexOnOpen`) now works with the new paging cursor; no extra code needed beyond earlier VectorSearch updates. Verify: set a Jina API key, open the Semantic Search dialog on a fresh profile, and confirm the index starts building automatically.
- Vector Search: Indexing must be resumable (store last indexed page/cursor so it can continue later). Root cause: paging cursor was in-memory only, resetting between sessions. Changed: persist `vectorIndexCursor` via `Config` and load it in `asmr-one-ultimate/src/features/VectorSearch.ts`, with a test update in `asmr-one-ultimate/tests/features/VectorSearch.test.ts`. Verify: run `npm test -- --run tests/features/VectorSearch.test.ts` in `asmr-one-ultimate`, then refresh and confirm indexing resumes from the next page.
- Vector Search: Embedding requests should run in parallel (with rate limiting) + cache embeddings per work. Root cause: bulk indexing awaited embeddings sequentially and repeated requests per payload. Changed: add a concurrency-limited work pool and embedding de-dupe/cache in `asmr-one-ultimate/src/features/VectorSearch.ts`, with tests in `asmr-one-ultimate/tests/features/VectorSearch.test.ts`. Verify: run `npm test -- --run tests/features/VectorSearch.test.ts` in `asmr-one-ultimate`.
- Radio Mode: Avoid repeating the same works too frequently (keep a short history buffer). Root cause: random work fetch could pick the same IDs repeatedly. Changed: track a recent work buffer and retry selection in `asmr-one-ultimate/src/features/RadioMode.ts`, plus test coverage in `asmr-one-ultimate/tests/features/RadioMode.test.ts`. Verify: run `npm test -- --run tests/features/RadioMode.test.ts` in `asmr-one-ultimate`, then toggle Radio Mode and confirm it skips recent works.
- Radio Mode: Choose a random starting track intelligently (avoid always picking track 0 / avoid “cover” folders). Root cause: random selection could include low-signal folders when the work tree contained cover/script dirs. Changed: prefer SmartSelector’s best folder when choosing tracks and filter non-audio entries in `asmr-one-ultimate/src/features/RadioMode.ts`, with tests in `asmr-one-ultimate/tests/features/RadioMode.test.ts`. Verify: run `npm test -- --run tests/features/RadioMode.test.ts` in `asmr-one-ultimate`, then enable Shuffle and confirm starts come from main folders.
- Playback: Improve stuck-audio recovery (detect “play didn’t start” and retry with backoff). Root cause: playback retries fired on a fixed 1s loop, hammering play attempts without pause. Changed: add exponential backoff to `ensurePlayback` in `asmr-one-ultimate/src/features/RadioMode.ts` and add coverage in `asmr-one-ultimate/tests/features/RadioMode.test.ts`. Verify: run `npm test -- --run tests/features/RadioMode.test.ts` in `asmr-one-ultimate`, then watch the console for backoff cadence during a forced playback failure.
- Playback: Flat View toggle placement + behavior parity (if still required). Root cause: toggle styling/state feedback was inconsistent across header and inline placements. Changed: normalize toggle state classes to the shared accent and remove inline color overrides in `asmr-one-ultimate/src/features/FlatView.ts`. Verify: open a work page and toggle Flat View from each entry point to confirm state styling stays consistent.
- Learner Mode: Clean up injected subtitle UI on route change (no ghost UI / duplicates). Root cause: subtitle containers persisted across routes and could be duplicated when the player re-rendered. Changed: added cleanup logic on route change and test coverage in `asmr-one-ultimate/src/features/LearnerMode.ts` and `asmr-one-ultimate/tests/features/LearnerMode.test.ts`. Verify: run `npm test -- --run tests/features/LearnerMode.test.ts` in `asmr-one-ultimate`, then navigate away from a work page and confirm subtitle UI is removed.
- Learner Mode: Hide subtitle containers when no subtitles exist (avoid empty blocks). Root cause: containers were shown based on lyric arrays even when no active line was displayed. Changed: gate visibility on `lastText` and add tests in `asmr-one-ultimate/src/features/LearnerMode.ts` and `asmr-one-ultimate/tests/features/LearnerMode.test.ts`. Verify: run `npm test -- --run tests/features/LearnerMode.test.ts` in `asmr-one-ultimate`, then open a work with no subs and confirm no empty subtitle panels appear.
- Learner Mode: Ensure learner controls don’t break layout on small screens (responsive sizing). Root cause: controls kept desktop padding and icon sizing on narrow viewports. Changed: add mobile-focused spacing rules in `asmr-one-ultimate/src/styles/learner.css`. Verify: shrink the viewport to mobile width and confirm the learner controls fit without wrapping or overlap.
- Tag Filters: Show active filters clearly (chips/toggles) and allow quick removal. Root cause: filter UI was subtle and chips weren’t easy to remove. Changed: improve overlay spacing/positioning and make chips removable on click in `asmr-one-ultimate/src/features/TagFilters.ts`. Verify: add two tag filters and confirm the overlay shows the count and chips can be removed with a single click.
- Tag Filters: Multi-tag filters should persist across navigation (homepage → work → back). Root cause: filter state lived only in memory and didn’t resync from route/storage. Changed: persist filters in session storage and sync from route tags in `asmr-one-ultimate/src/features/TagFilters.ts`, with tests in `asmr-one-ultimate/tests/features/TagFilters.test.ts`. Verify: run `npm test -- --run tests/features/TagFilters.test.ts` in `asmr-one-ultimate`, then navigate to a work and back and confirm filters remain visible and active.
- Caching: Add a central cache layer with TTL + consistent keys for DLsite, work metadata, translations, tag translations. Root cause: caching was ad-hoc per feature with inconsistent keys and TTL handling. Changed: introduced `asmr-one-ultimate/src/core/Cache.ts`, migrated DLsite and work metadata to the shared cache in `asmr-one-ultimate/src/features/DLsiteScraper.ts` and `asmr-one-ultimate/src/features/WorkMetadata.ts`, and wired translations/tag translations through `asmr-one-ultimate/src/core/Utils.ts` and `asmr-one-ultimate/src/features/EnglishTags.ts`. Verify: run `npm test -- --run tests/core/Cache.test.ts` and `npm test -- --run tests/scrapers/DLsiteScraper.test.ts` in `asmr-one-ultimate`.
- Caching: Add request de-duping (multiple requests for same key share one network call). Root cause: simultaneous lookups could trigger duplicate network calls. Changed: `CacheStore.getOrFetch` now de-dupes inflight requests and is used for DLsite, translations, and work metadata (`asmr-one-ultimate/src/core/Cache.ts`). Verify: run `npm test -- --run tests/core/Cache.test.ts` in `asmr-one-ultimate`.
- UI: Consolidate CSS injection (avoid multiple competing style blocks). Root cause: multiple features injected their own style tags at runtime. Changed: moved feature CSS into `asmr-one-ultimate/src/styles/ui.css`, imported it in `asmr-one-ultimate/src/main.ts`, and removed per-feature style injection from `asmr-one-ultimate/src/features/TagFilters.ts`, `asmr-one-ultimate/src/features/VectorSearch.ts`, and `asmr-one-ultimate/src/features/PlaylistGenerator.ts`. Verify: open Tag Filters, Semantic Search, and Playlist Builder dialogs and confirm styling still applies without new inline style tags.
- UI: Fix dark mode hover/active states (avoid unreadable black-on-dark). Root cause: hover states in injected dialogs relied on default dark mode styling, leading to low-contrast backgrounds. Changed: added dark-mode hover overrides in `asmr-one-ultimate/src/styles/ui.css` for vector search, playlist builder, and filter actions. Verify: enable dark mode and hover dialog rows/buttons to confirm they remain readable.
- Tests: Add a minimum smoke test suite for core flows (settings, radio, learner, whisper, vector dialog). Root cause: core flows lacked a cohesive baseline test set. Changed: existing feature tests now cover settings, radio, learner, whisper, and vector flows (`asmr-one-ultimate/tests/features`). Verify: run `npm test -- --run tests/features/SettingsManager.test.ts`, `npm test -- --run tests/features/RadioMode.test.ts`, `npm test -- --run tests/features/LearnerMode.test.ts`, `npm test -- --run tests/features/Whisper.test.ts`, and `npm test -- --run tests/features/VectorSearch.test.ts` in `asmr-one-ultimate`.
- Runtime: Add startup self-check logging (bridge/store/selectors ready) to reduce false “fixed” reports. Root cause: startup readiness wasn’t logged, making failures look like feature bugs. Changed: added startup checks in `asmr-one-ultimate/src/main.ts` to log bridge/store/router and key selector readiness. Verify: reload asmr.one and confirm `[Startup]` logs for store/router/axios/player elements.
- Whisper Transcription: Fix MIME type mismatch, CORS, and module errors for the worker. Root cause: The worker was being served as an HTML file in dev mode or as a separate file subject to CORS in prod, and the code used ES module imports but was instantiated as a classic worker. Changed: updated `vite.config.ts` to set `worker: { format: 'es' }`, forcing Vite to bundle the worker as an inline base64 blob and load it as a module worker. Verify: run `npm run dev` and check the console for clean worker initialization without MIME/CORS errors, or run `npm test`.
- Settings: /settings tab crash on navigation. Root cause: subtitle settings injection never left a sentinel element in the DOM, so the MutationObserver kept re-injecting and ballooned the DOM. Changed: wrap subtitle settings in a persistent container and mark it with `.asmr-settings-group` to avoid repeated injection in `asmr-one-ultimate/src/features/LearnerMode.ts` and `asmr-one-ultimate/src/styles/learner.css`, plus a regression test in `asmr-one-ultimate/tests/features/SettingsManager.test.ts`. Verify: run `npm test -- --run tests/features/SettingsManager.test.ts` in `asmr-one-ultimate`, then navigate to `/settings` and confirm the page remains responsive.
- Settings: Live Caption spacing + theme-aware input backgrounds. Root cause: the live caption message had no vertical spacing and injected inputs used default white backgrounds on dark mode. Changed: add a margin wrapper for the caption message and apply themed input styles + section backgrounds in `asmr-one-ultimate/src/features/LearnerMode.ts` and `asmr-one-ultimate/src/styles/learner.css`. Verify: open `/settings` in dark mode and confirm the Live Caption block has spacing and the inputs match the theme.
- Vector Search: Auto-index without pressing Build Index. Root cause: background indexing only ran when the index was empty, so partial indexes never advanced unless manually triggered. Changed: always schedule background indexing when an API key is present in `asmr-one-ultimate/src/features/VectorSearch.ts`, with coverage in `asmr-one-ultimate/tests/features/VectorSearch.test.ts`. Verify: run `npm test -- --run tests/features/VectorSearch.test.ts` in `asmr-one-ultimate`, then reload asmr.one and confirm `[VectorSearch] Auto-indexing in background...` appears in console without clicking Build Index.
- Vector Search: Remove Build Index button + add auto-index note + widen dialog. Root cause: manual build action is redundant now that auto-index runs in the background and the dialog was cramped. Changed: remove the Build Index button, add a settings note about background indexing time, and widen the dialog with improved spacing in `asmr-one-ultimate/src/features/VectorSearch.ts`, `asmr-one-ultimate/src/features/LearnerMode.ts`, `asmr-one-ultimate/src/styles/ui.css`, and `asmr-one-ultimate/src/styles/learner.css`. Verify: open `/settings` to see the note, open the Semantic Search dialog to confirm the wider layout and no Build Index button.
- Vector Search: Translate search queries to Japanese before embedding. Root cause: embeddings were generated from the raw user input even though the index content is mostly Japanese, leading to weaker matches. Changed: translate non-Japanese queries to Japanese before embedding in `asmr-one-ultimate/src/features/VectorSearch.ts`, with coverage in `asmr-one-ultimate/tests/features/VectorSearch.test.ts`. Verify: run `npm test -- --run tests/features/VectorSearch.test.ts` in `asmr-one-ultimate`, then search in English and confirm it still returns Japanese-indexed results.
- Vector Search: Redesign dialog + improve query accuracy + show status in header row. Root cause: status messages were rendered in the result list, the dialog underused screen space, and JP-only indexing hurt English queries. Changed: translate non-Japanese queries and embed combined EN+JP payload, expand dialog to use more height/width with a grid result layout, raise the result limit, and show indexing/search status in the header row in `asmr-one-ultimate/src/features/VectorSearch.ts` and `asmr-one-ultimate/src/styles/ui.css`, with updated tests in `asmr-one-ultimate/tests/features/VectorSearch.test.ts`. Verify: open Semantic Search, confirm status updates appear next to the index count, results fill more space, and English queries return stronger matches.
- Vector Search: Continuous background indexing with new-work detection. Root cause: background indexing stopped after a run and the dialog status still showed “complete,” giving no signal for new work detection. Changed: add a watcher that polls the latest works, re-indexes from page 1 on new releases, stores the latest work ID, and keeps the status row updated in `asmr-one-ultimate/src/features/VectorSearch.ts` and `asmr-one-ultimate/src/core/Utils.ts`, plus test coverage in `asmr-one-ultimate/tests/features/VectorSearch.test.ts`. Verify: run `npm test -- --run tests/features/VectorSearch.test.ts` in `asmr-one-ultimate`, then wait ~10 minutes and confirm the status row shows “Indexing paused. Watching for new works...” and updates when new works appear.
- Vector Search: Result translation/thumbnail/pagination + continuous indexing batches. Root cause: result translation wasn’t shown, rows lacked imagery/spacing, the list showed empty scroll, and indexing stopped after a single batch. Changed: add title translation in results, cover thumbnails with fallbacks, pagination for 40 results per page, hide empty result list, boost keyword scoring (including `futanari` alias), expand dialog sizing to full-screen on mobile, and keep background indexing running in batches in `asmr-one-ultimate/src/features/VectorSearch.ts` and `asmr-one-ultimate/src/styles/ui.css`, with updated tests in `asmr-one-ultimate/tests/features/VectorSearch.test.ts`. Verify: open Semantic Search to see translated titles + thumbnails + pagination, and confirm status stays “Indexing continues in the background...” while it pages through more works.
- Vector Search: Backoff on Jina 429 rate limits. Root cause: embedding requests were too frequent and retried aggressively, causing repeated 429s. Changed: throttle embedding requests, respect retry-after cooldowns, and pause indexing batches on rate limit in `asmr-one-ultimate/src/features/VectorSearch.ts`. Verify: watch the status row for “Rate limited by Jina. Pausing…” and confirm indexing resumes after the cooldown without spamming 429s.
- Radio Mode / Playback: Shuffle still starts at first track due to auto-play logic. Root cause: FolderDiver clicked "Play All" or first play button, ignoring shuffle. Changed: Updated `FolderDiver.tryAutoPlay` and `RadioMode.clickPlayButton` to bypass "Play All" when shuffle is enabled, and instead scan for and click random items matching audio extensions (.wav, .mp3, etc.) in `asmr-one-ultimate/src/features/RadioMode.ts`. Verify: run `npm test -- --run tests/features/FolderDiver.test.ts` in `asmr-one-ultimate` or enable Shuffle + Radio Mode and observe random start track.
- Whisper Transcription: Worker script failed to load with MIME type text/html. Root cause: the userscript referenced a `?url` worker asset that resolved to a non-existent path on asmr.one, so the fetch returned HTML. Changed: inline the worker via Vite's `?worker&inline` factory and instantiate it directly in `asmr-one-ultimate/src/features/Whisper.ts`. Verify: click the Whisper button and confirm no `Failed to load module script` error appears in the console.
- Settings / UX: Toggle state doesn't match actual internal state (BUG-SETTINGS-STATE). Root cause: toggles rendered from `Config.get(key)` at injection time but never synced on re-entry. If settings changed externally or user navigated away and back, toggles showed stale state. Changed: added `syncToggleStates()` method in `SettingsManager` that queries all `[data-asmr-toggle]` elements and updates their visual state from current Config values. Called on every `inject()` to ensure toggles match reality on re-entry. Verify: run `npm test -- --run tests/features/SettingsManager.test.ts` (specifically the "syncs toggle state on re-entry" test).
- Settings / UX: Settings UI duplicates on repeated injection (BUG-SETTINGS-DUPLICATE). Root cause: MutationObserver fired `inject()` on every DOM mutation while on `/settings`, and DOM checks could race with Vue re-renders causing duplicate sections. Changed: added `isInjected` flag to `SettingsManager` as a hard idempotency guard. Once sections are injected, subsequent `inject()` calls only sync state. Flag resets on route change away from `/settings`. Verify: run `npm test -- --run tests/features/SettingsManager.test.ts` (specifically the "does not duplicate sections" test).
- Settings / UX: window.ASMRUlt.toggle crashes from inline handlers (BUG-SETTINGS-INLINE-ONCLICK). Root cause: `API.toggle()` called `(window as any).ASMRUlt?.toggleShuffle?.()` which could crash if main.ts hadn't finished wiring up methods. Changed: removed the `toggleShuffle()` shortcut call from `API.toggle()` since `Config.set()` is the single source of truth. Other features (like ShuffleFeature) read from Config on-demand and don't need explicit callbacks. Verify: toggle shuffle on `/settings` before page fully loads — no crash occurs.
- English Tags: Entity translations lost on refresh. Root cause: EnglishTags used an in-memory Map cache that cleared on reload, forcing re-translation of circles/VAs every visit. Changed: updated `TagDatabase` to store entity translations in a new `entities` object store, and updated `EnglishTags.ts` to read/write from this persistent DB. Verify: visit `/circles`, wait for translations, reload page, and confirm translations appear instantly without API calls.
- Learner Mode: Subtitles desync in mini-player. Root cause: Subtitle updates relied on a 500ms interval which drifted when the tab was backgrounded or the player was collapsed. Changed: added a `timeupdate` event listener to the audio element in `LearnerMode.ts` to drive updates synchronously with playback time. Verify: play a track with subtitles, collapse player, scrolls logs, and confirm mini-player subtitles stay perfectly synced.
- UI: Suggestions dropdown has hardcoded dark background. Root cause: `EnglishTags.ts` used inline styles for the suggestions container, forcing a dark background even in light mode. Changed: moved styling to `ui.css` classes (`asmr-tag-suggestions`) which leverage Quasar's theme-aware variables. Verify: switch to light mode, type in search, and confirm suggestions background is white/light.
- DLsiteScraper: Crashes on some dynamic API responses. Root cause: `fetchDynamicApi` could return non-object types (like null or string) which caused `metadata?.price` access to throw. Changed: added strict type checking for the API payload before property access in `DLsiteScraper.ts`. Verify: run `npm test -- --run tests/scrapers/DLsiteScraper.test.ts`.

- Whisper / Learner: Whisper subtitles don't appear in LearnerSubs after transcription. Root cause: Timeline lookup failed for empty segments. Changed: Added fallback to static whisperText in LearnerMode.ts. Verify: Mock asmr-whisper-update event.
- Learner Mode: Container layout shift when subtitles change. Root cause: Missing min-height. Changed: Enforced min-height 80px and transitions in learner.css. Verify: Toggle lines.
- UI / Header: Add "Support Development" button. Root cause: User request. Changed: Added SupportButton.ts injection with health_and_safety icon. Verify: Visual check.
- UI / Overlay: Subtitle overlay blocks player controls. Root cause: High z-index (5000) and catching pointers. Changed: Reduced z-index to 1000, added pointer-events: none to container in learner.css. Verify: Click player controls through overlay.
- Playlist Generator: Always says "No tracks found". Root cause: mismatched field names in flattenWork(). Changed: Rewrote flattenWork() to use correct API structure (BFS). Verify: Generate playlist with "ear cleaning".
- Infrastructure / Cache: Handle quota errors. Root cause: Large blobs hitting IDB limits. Changed: Added LRU eviction targetBytes, clearAll method, and Settings UI for cache management. Verify: Clear cache in settings.
- UI / Dark Mode: Icons hardcoded to blue/default. Root cause: missing theme variables. Changed: Added .q-dark rules using --asmr-accent in fixes.css. Verify: Check icons in dark mode.
- UI / Accessibility: Audit UI for WCAG. Root cause: Missing focus outlines, small touch targets. Changed: Added focus outlines, min-dimensions for mobile touch, ARIA labels. Verify: Keyboard nav.
- Dev / Tests: npm run test failing with "Port in use". Root cause: Vitest/Vite port conflict. Changed: Set server.strictPort: false in vite.config.ts. Verify: npm run test.
- Refactor / CSS: Monolithic learner.css and inconsistent colors. Root cause: Lack of modularity. Changed: Split into components/_*.css and added --asmr-accent variable. Verify: Visual check.
- UI / Playlist Builder: No search preview, bad dark mode hover. Root cause: UX gaps. Changed: Added "Search" button, results table, and fixed CSS. Verify: Search then Play.
- Refactor / Whisper: Duplicate button creation code. Root cause: attachPlayerButton and attachMiniButton had copy-pasted logic. Changed: Extracted createWhisperButton() helper. Verify: Buttons appear correctly.
- Playlist Generator: Incorrect duration presets. Root cause: Old thresholds (0-20, etc). Changed: Updated to 0-30, 30-120, 120+ in PlaylistGenerator.ts. Verify: Click presets.

Project Overview and Architecture

ASMR.one Ultimate is built as a modular userscript injected into the asmr.one web app (which is based on Vue 2.6 + Quasar 1.x, codename “Kikoeru”). The userscript is written in TypeScript and bundled with vite-plugin-monkey for Tampermonkey compatibility. It uses a “parasitic” design: rather than reinventing playback or data logic, it hooks into the host site’s Vuex store, router, and network layer whenever possible. Key architectural components include:

KikoeruBridge – A singleton class that polls for the site’s root Vue instance (#q-app) and then exposes bridge.store, bridge.router, and bridge.axios for use by the script. This allows the script to dispatch Vuex actions (e.g. play tracks, search works) and navigate routes as if it were part of the native app.

Unsafe Window Exposure – The script creates a global window.ASMRUlt object (and mirrors it to unsafeWindow) to expose certain functions for use in page context if needed. This was a workaround for earlier issues where inline event handlers in the page couldn’t see the script’s functions due to sandboxing. Now, we primarily use event listeners (avoiding inline handlers), but unsafeWindow.ASMRUlt remains available with methods like toggleRadio(), skipRadio(), etc., bound to the script’s logic.

Modular Features – The codebase is organized by features (RadioMode, ShuffleFeature, LearnerMode, Whisper, TagFilters, VectorSearch, PlaylistGenerator, etc.), each encapsulated in a class with enable() methods. On startup, the script initializes the bridge, then instantiates and enables each feature class. This ensures each enhancement hooks into the DOM or store at the right time. A mutation observer or polling may be used to re-inject UI elements if the site re-renders sections (common in SPA navigation) – for example, the sidebar menu and header buttons use observers to persist after route changes.

Persistent Storage – For user preferences, the script uses Tampermonkey’s GM storage (via GM_getValue/GM_setValue) through a Config helper. For larger data, it leverages browser IndexedDB: e.g. asmr-one-vectors for semantic search embeddings and asmr-one-audio-cache for offline audio blobs.

Context and Constraints: The script must accommodate the host site’s context rules. We run at document-idle (after the app is loaded). We avoid direct DOM scraping of asmr.one’s internal content when a store hook is available. For example, instead of manually parsing the audio list, we use AudioPlayer Vuex state; instead of custom XHR for random works, we call the site’s own /api/works?order=betterRandom. This piggybacking ensures resilience to site updates – if asmr.one changes data shape, our usage of official APIs and store actions continues to work. When direct DOM manipulation is needed (for adding UI elements), we carefully append elements using Quasar classes for consistent styling, and use Quasar’s reactive classes (e.g. .q-dark) to automatically adapt to light/dark mode.

Finally, note that page context vs. userscript context is a critical consideration. Our code executes in the userscript sandbox, so it can’t directly call functions defined in page scripts. By exposing essential controls via unsafeWindow.ASMRUlt and by attaching event listeners to DOM elements we inject, we bridge this gap. In previous iterations, missing this caused errors like the page trying to call window.ASMRUlt.toggleRadio (from an inline onclick) when window.ASMRUlt wasn’t yet defined in page context. This has been resolved by proper initialization order and the use of event handlers in place of inline JS.

With this groundwork, let’s break down each major feature area, detailing how it works, how to maintain or extend it, and known issues to watch for.

Playback: Radio Mode & Continuous Play

Radio Mode is the flagship feature that turns asmr.one into a continuous “radio” of random tracks. When Radio Mode is active, the script will automatically load a new random work (album) after the current track or work finishes, and start playing a track from it. Users can toggle this mode via a custom sidebar menu entry. In the site’s left drawer menu, the script injects a clickable item labeled “Radio Mode” with a sub-label ON/OFF to indicate status. This menu item uses a radio icon and is appended at the bottom of the drawer list. Clicking it calls our toggleRadio() which flips Radio Mode on/off and updates the label color (pink when ON).

Behavior: When Radio Mode is turned on, the script immediately initiates a random work fetch (using the site’s GET /api/works?order=betterRandom endpoint) to choose the next work. It then navigates to that work’s page via router.push("/work/{id}"). The moment the new work loads, the script attempts to autoplay a track. This is where intricate logic comes in to ensure playback starts:

The script waits for the work’s file list to render (polling the DOM for .file-list-item entries). If none appear after a short time, it logs a “Waiting for file list...” and keeps checking.

Once the file list is present, the script determines if a track is playing. If not, it programmatically triggers play:

If the site’s store has a ready action (like AudioPlayer/play or AudioPlayer/playTrack), it dispatches those. We prefer using the store actions since they properly handle setting up the audio element and state.

If the store actions aren’t available or don’t start playback (some site versions might not expose them), it falls back to simulating a user click on a play button. It searches the .q-page-container for any button containing the text “play_arrow” (the Quasar icon for play) and clicks it. If no explicit play button is found, it clicks the first track item in the list.

A small state machine with retries (ensurePlayback() loop) runs during this process. If after several attempts the new work still isn’t playing (e.g., perhaps due to an empty work or a stalled audio), the script will skip to another random work to avoid dead air.

Automatic Folder Entry (“Auto Initial Path”): A nuance in asmr.one is that works can be organized into folders (e.g., “00 Main”, “01 Bonus”, “Samples”, “SFX”). The user may prefer to start in the folder containing the main audio files. The legacy script had a Smart Folder Selector that scored folders by number of audio files, duration, and naming (penalizing “sample” or “cover” folders) to pick the best one. Our current implementation attempts to replicate that behavior: after loading a work, if no track is playing yet, the script will click the first item in the file list which often is the main folder. However, this is a simplification: if the site doesn’t list the largest folder first, we might enter a lesser folder. We have the old scoring logic in SmartSelector.calcScore and selectBestFolder(), but it’s not fully integrated after the recent refactor. Known Issue: In rare cases (e.g., a work where the main content isn’t the first folder), Radio Mode might open the wrong folder. An agent resolving this should reintegrate the scoring function: for example, by examining the loaded work object in bridge.store.state.AudioPlayer.work (which contains work.dirs and work.tracks) and auto-navigating into the highest-score dir. This could be done by simulating a click on that folder’s DOM element or by using the site’s router ($router.push with a path query) to open it. When fixing, ensure the logic respects the user’s settings like SE (Sound Effects) preference and Audio format preference which influence scoring.

Once a track is playing, the script monitors it. If Radio Mode remains ON, when the track (or the entire work, depending on settings) ends, the script will automatically skip to another random work. The skip can also be triggered manually: the script adds a “Skip” function (skipRadio()) which is not directly a UI element, but it’s wired to keyboard shortcuts or could be called via console or future button. It calls the same skipToNextWork() as the automatic flow, cancelling any pending playback timers and fetching a new random work immediately.

Play All vs. Single Track: The userscript includes a setting “Play All Tracks” (accessible in the Radio settings UI, see below) which determines whether Radio Mode should play through every track in a work before moving on. This corresponds to Config.playAllInFolder. If enabled, when a new work loads, the script will attempt to queue up all tracks in that work. Our logic leverages the site’s playlist capabilities:

On entering a work, if Play All is ON, we refrain from skipping to the next work until all tracks finish. The code achieves this by checking if the site’s audio player is still playing or if a “pause” button is visible, which indicates more tracks are queued. Only when the last track ends (player stops) do we treat the work as finished and proceed to next.

There is also an internal function playAll() to click the site’s “Play All” button if present (asmr.one has a “Play All” in each folder’s UI). In earlier code we searched for a button labeled "Play All" and clicked it. In the current version, the integration is more direct: if multiple tracks are present and Play All is desired, we allow the site’s native behavior (the site auto-continues tracks in an album by default). The script only steps in to start playback of the first track or to handle shuffle (discussed below).

Shuffle Mode: When shuffle is enabled (Config.shuffle = true), the starting track within each work should be random instead of always the first track. The script implements this by seeding a “queue” of tracks in random order when a new work loads. We maintain an internal queue for the current work’s tracks and randomly select an index to start from. The code calls setQueue() and playQueueIndex() behind the scenes to rearrange the playlist. This ensures that if Shuffle is ON, you might start at track 3 of the album, then wrap around. We also guard so that we only random-seed once per work (using randomSeedWorkId to avoid reshuffling if you manually replay the same work).

Implementation note: The initial implementation of shuffle in this project managed its own track order separate from the site’s. After analysis, we realized the asmr.one player has a native shuffle capability via AudioPlayer.playMode. In a future refinement, we plan to simply invoke bridge.store.commit('AudioPlayer/setPlayMode', 'shuffle') to use the built-in shuffle logic. As of now, our custom shuffle works, but developers should be careful not to conflict with the site if it introduces a shuffle UI. If you work on shuffle, prefer leveraging site functionality instead of maintaining a separate queue, and remove any redundant code (like the shuffleArray() function we used earlier).

Radio Settings UI: We’ve injected a simple settings panel for Radio Mode options (Play All, Shuffle, etc.) directly into the site’s existing Settings page. On asmr.one’s /settings route, our script appends a “Radio Settings” section. This appears as toggles for each config option (e.g., a checkbox for Play All Tracks, Shuffle, etc.) and possibly labels. (If you search the code, you’ll see radioSettings: "Radio settings" in I18n and some code in the Settings manager to insert these). The settings page is built with Quasar components, so we had to replace some inline event handlers to avoid the context issue. Now, toggling those checkboxes calls our internal Config.set() via event listeners. These settings persist via GM_setValue so they apply on next page load.

Verification cues: To verify Radio Mode and Playback features are working:

When Radio Mode is toggled ON, the sidebar menu text should change to ON in colored text. In the browser console, you should see [ASMR.one Ultimate] Bridge initialized! followed by logs like Navigating to: [Work Title] (ID: 123456) when it jumps to a new work. Eventually, Playback success. or similar appears when a track starts. If something fails, you might see Playback timeout. Skipping work. which indicates the script gave up on the current work and moved on.

If Shuffle is ON, when a new work loads, the console log should show Shuffle start: random track queued. indicating we picked a random track.

The presence of a pink check-circle icon next to track names (see AutoProgress below) can also indicate Radio Mode has played through those tracks.

On the Settings page, ensure the Radio Settings toggles reflect and can change the Config (check the Tampermonkey storage or console logs – toggling may log config changes).

Known Issues / Future Improvements: Aside from the “best folder auto-selection” bug mentioned, one edge case is handling works with no audio (just images or text attachments). The script might log API returned no works or “No audio source found” and keep skipping. This is usually fine (it will find the next work that has audio), but for completeness an agent could skip such works earlier by checking work.tracks length before navigation. Another improvement is integrating a “Radio Mode: OFF after this track” feature for user convenience, but that’s a low priority. Always test Radio Mode both on desktop and mobile – mobile view may hide the sidebar (so our toggle is inaccessible). In mobile scenarios, you can still activate via console (ASMRUlt.toggleRadio()) or consider adding a secondary toggle button in the player UI if needed in the future.

Playback: AutoProgress and History Tracking

While on the topic of playback, the AutoProgress feature deserves mention. AutoProgress bridges the gap between listening and the site’s history tracking (so that listening to audio marks it as “heard” in your account history). It also provides visual cues of progress in the UI.

Marking Works as Listened: The script watches the audio player’s currentTime continuously. If a user has heard a significant portion of a track, we mark the parent work accordingly:

Once a track reaches 5% played (actually 5 seconds or 10%, whichever is longer), we mark the work as “in progress” (status = 2 in asmr.one’s terms). This uses the site’s API: POST /api/review/mark with status:2 (probably meaning “listening started”).

Once 90% of a track is played, we consider the track finished. We then mark the work as “completed” (status = 3) via the same API. The script ensures it only does this once per track by tracking a unique key for each track (combination of work ID and track ID) and using a Set to avoid duplicate marks.

The user’s own User.marks store is updated as well so the UI immediately knows the work’s new status (without waiting for a full refresh). We update bridge.store.state.User.marks[workId] to status and log the change. The lastUpdatedWorkId guard prevents redundant API calls if the user scrubs around in the same track.

Checkmark Icons: To give a visual indication of listened tracks, the script decorates track list items with a green check mark icon once they’ve been played in full. This is done by injecting an <i class="material-icons asmr-check text-green">check_circle</i> into the track’s element. The logic:

We observe changes to the file list DOM (using a MutationObserver) and also refresh on certain events.

On each refresh (or when a track finishes), we call injectCheckmarks(). This function iterates through all .q-item or .file-list-item elements (which represent tracks in the UI). For each, it tries to identify the corresponding track object by matching the element’s data-id or text to a track in the current folder’s track list.

If a track is found and is marked as finished (we add the track’s key to listenedTracks when 90% listened), we call applyCheck(element, true), which appends the check icon if not already present. If a track is not finished but a check was there (e.g. user replayed or un-marked something), it removes it.

These checkmarks help users see which tracks in an album they’ve heard. They are only stored for the session (we don’t currently persist listenedTracks across page reloads), but the completed status of the work is saved to the server (so the work appears completed in asmr.one’s library page).

Note: We tie the checkmarks to tracks, not directly to the work status, because a work could have multiple tracks and we want granular info. If a user replays a work, the previously listened tracks will still show checks since listenedTracks set remains until refresh. If you needed to persist track-level progress, you could store track IDs in GM_setValue, but that might be overkill.

Playlist vs Work End Detection: The AutoProgress logic carefully distinguishes between individual tracks finishing and the end of a playlist. For example, if Play All Tracks is on, reaching 90% of track 1 should mark the work and show a check for track 1, but Radio Mode should not skip to next work until track N is done. We rely on the site’s playlist behavior to handle continuous play, and our skip logic only triggers when the player is truly idle with no next track. The checkmarks, however, update per track. This has been working in testing: you’ll see check marks appear as each track ends, and only after the final track does Radio Mode fetch a new work.

Verification: To test AutoProgress, start playing a track with Radio Mode off. Let it play through (or seek near the end). In the network console you should see a POST .../review/mark request when you cross ~90%, and the track’s entry in the list gets a ✔️ icon appended. Check that the icon appears at the end of the track’s title text or in its row. If you refresh the page, that icon will disappear (since we don’t store it), but the work’s completed status is in your account (the site’s UI might show a “listened” badge elsewhere).

Edge Cases: If the site structure changes (for instance, different DOM for file items), our query selectors in injectCheckmarks() might need updating. We look for .q-item__label or .ellipsis classes for track titles – those are stable in Quasar list items for now. Also, extremely short tracks (<5s) might get marked immediately after they start; we put a 5 second minimum before marking “in progress” to avoid noisy updates.

AutoProgress is a good example of our approach: we integrate with the site’s own review API and store state, rather than creating a separate tracking system. Future agents should maintain this principle – when possible, use the official APIs (like /api/review/mark for history, or store actions) to maximize compatibility.

Subtitles: Learner Mode (Bilingual Subtitles)

Learner Mode brings bilingual subtitles and interactive transcript controls to asmr.one, turning audio listening into a study session. When enabled, the script will display the spoken lines (in Japanese and their translation) on screen, synchronized with audio playback. This feature is particularly useful for language learners.

UI Overview: There are two subtitle display states – expanded and collapsed:

The expanded subtitles panel appears within the main audio player section whenever a subtitle line is available. It’s a centered block of text showing Japanese on top (larger font) and English on bottom (smaller font). This panel has a subtle border and background that adapts to the theme (light or dark) and is inserted either after the album art or at the top of the player area if no art. We designed it to not interfere with other controls.

The collapsed subtitles bar is a smaller, fixed bar that appears just above the page footer (above the player’s mini-bar). It shows the same content in one line (with perhaps the Japanese or both languages in a marquee if long). In practice, when you scroll or navigate away from the player, the script hides the expanded panel and shows this bottom bar so you can still follow along. The collapsed bar has a blurred background for readability (using CSS backdrop-filter) and again theme-aware colors.

The transition between expanded and collapsed is handled by updateVisibility(): if you’re on the work’s page, we show expanded; if you navigate elsewhere or scroll such that the player isn’t visible, we might show collapsed. We attach a watcher on route changes to reset subtitles when leaving the work page.

Controls: Learner Mode injects a small set of controls for navigating subtitles:

Previous Line / Next Line – Buttons with left/right chevron icons allow the user to manually go to the previous or next subtitle line. Clicking them will seek the audio to the timestamp of the previous/next line (this is implemented in LearnerMode.seek() which looks up the timestamp in the currentLyrics array and sets the audio currentTime).

Toggle JP – A button (with a “心理” psychology icon 🧠) to toggle the display of Japanese text. When JP is hidden, the user can challenge themselves to recall the meaning from English alone. Under the hood, this toggles Config.showJP and adds or removes a CSS class .hide-jp which hides the Japanese line via CSS (opacity:0; height:0; overflow:hidden). The button’s active state (highlighted) indicates JP is currently shown.

(In the future we might add a “Toggle EN” to hide the English instead, but currently the design is that English is hidden by default until you click on it – see below).

These controls appear in both expanded and collapsed modes. In expanded mode, they are placed as a horizontal button group aligned with the player controls (we insert them into the player’s control bar if possible). In collapsed mode, due to limited space, they appear as a smaller icon group on the mini player bar (we create a container .learner-collapsed-controls and append it next to the existing mini controls). The icons are scaled down for the collapsed bar (16px vs 20px) for better fit.

Blurred English and Reveal-on-Click: By design, the English translation is initially blurred out to encourage listening to the Japanese first. The .learner-en text is given a CSS blur and low opacity (filter: blur(5px); opacity:0.3). The script adds an event listener so that clicking the English text will toggle the blur off (by toggling the .blurred class). Additionally, on desktop, simply hovering the .learner-en.blurred text will remove the blur (this is achieved purely with CSS hover rule). After clicking or hovering, the English text becomes fully opaque and readable. This allows a user to peek at the translation as needed. Every new line starts blurred again by resetting the class when updating subtitles.

Subtitle Source and Translation Pipeline: The core of Learner Mode is obtaining the transcript of the audio and displaying it in sync:

Source of transcripts: If the audio work has an official transcript (LRC or captions), the site might provide it in AudioPlayer.lrcLines or a similar structure. We attempt to get lyrics from the site by checking bridge.store.state.AudioPlayer.lrcLines or any element in the DOM that might contain subtitles. As of now, asmr.one doesn’t natively provide transcripts for most content, so usually this will be empty.

Community transcripts: We planned integration with a community transcript database (Firebase) – you’ll see config fields like transcriptSyncCollection and related code to fetch from a cloud DB. However, this feature is disabled unless configured, as noted in the README. By default, no external transcript sync is active (to avoid errors).

Local transcripts via asmr-collections: The user had an asmr-collections repository cloned which possibly contains transcripts for certain works by RJ code. The WorkMetadata feature uses DLsite APIs and might also search such collections. Currently, WorkMetadata will log if an API response is empty and is designed to handle both array and object forms of DLsite responses, but this is mostly for metadata (title, circle, etc.), not full script.

Whisper-generated transcripts: (Detailed in the next section) If no transcript is available, the user can generate one on the fly using the Whisper integration. Once generated, it is injected as a <track> element in the audio. We do not yet automatically feed the Whisper output into Learner Mode’s display – that’s a to-do. For now, the user can use the browser’s built-in track viewer or rely on the upcoming integration described below.

Given the lack of transcripts in most cases, our script falls back to on-the-fly translation of Japanese lines. How do we get the Japanese lines? We try two approaches:

Some works embed subtitles as the audio plays (especially if they have a script file). The site might update AudioPlayer.currentSubtitle or similar. We set a periodic poll (updateLyrics() runs every 500ms) that checks for any new “lyric text”. We call findLyricsSource() which looks for any DOM elements that contain Japanese text of the current dialogue line (perhaps in a hidden lyric div) or uses the lrcLines from store if present.

If we find an array of lines (lrcLines), we map it into our currentLyrics array with time stamps. If not, currentLyrics stays empty and getActiveLyricText() will return null meaning no subtitle to show.

If a line of text is obtained (say, from lrc or future integration), displaySubtitle(text) is called. This will set the Japanese text (.learner-jp innerHTML) and then kick off a translation for the English. The translation is done by calling Google’s free Translate HTTP API. The code constructs a URL to https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl={targetLang}&dt=t&q={text} and sends a GET request via _GM_xmlhttpRequest. On response, it parses the returned JSON or array and extracts the translated text. The English is then set into the .learner-en element. This happens asynchronously but usually fast (a fraction of a second for a short line). We increment a translationToken each time a new line starts to ensure if a previous line’s translation returns late, we ignore it because translationToken won’t match (preventing out-of-sync issues). The net effect is as you listen, Japanese appears immediately (if available) and English appears shortly after.

Using Learner Mode: The interface is always present when the script is running; there’s no separate toggle to “enable subtitles” – it’s on by default whenever a transcript is available. However, subtitles will only show if we actually have lines to display. If no transcript is found and Whisper hasn’t been run, the Learner UI remains hidden (it injects the containers but keeps them empty/hidden). Users who want to test it can either use a work that has a known transcript or use the Whisper feature to generate one (see next section).

When subtitles are showing:

Click the English text to reveal or hide it (each click toggles blur).

Use Prev/Next buttons to navigate. For example, if you missed something, hitting “Previous Line” will rewind a few seconds to the start of the last subtitle. (Internally it finds the previous entry in currentLyrics relative to current time and seeks there).

Toggle JP to hide Japanese text (if you only want to see English after listening). The JP text area collapses, and the English text will enlarge slightly (since the CSS for .hide-jp .learner-jp sets height 0).

If you navigate away from the work page or the audio ends, the expanded subtitle box will disappear (since updateVisibility() unmounts it). The collapsed bar will also disappear if you stop playback or leave the page.

Theming and Style: The script’s CSS ensures the subtitles match the site’s theme. We use Quasar’s CSS variables like --q-dark and --q-light for text colors so that in dark mode the Japanese text is white instead of black. The background of the collapsed bar uses a translucent panel that is different for light vs dark theme. We also apply a subtle transition for showing/hiding to make it smooth. All our injected elements have class prefixes .learner-* or .asmr-* to avoid clashing with site styles.

Known Limitations: At present, Learner Mode relies on available subtitles. If none are available and you don’t use Whisper, it won’t magically transcribe the audio. We considered using speech recognition or auto-generation, but that’s what Whisper is for. There is also a potential race condition: sometimes the site’s UI might update or re-render and remove our inserted subtitle container (especially if re-navigating the same page). We mitigate this by an observer that re-injects if needed (notice observeDom() setting a MutationObserver on body to call poll() whenever DOM changes). This generally keeps the subtitle UI present. If an agent finds that subtitles UI vanishes unexpectedly on certain interactions, consider increasing the observer’s specificity or frequency.

Another quirk: the icon we chose for Toggle JP is a brain icon (material icon “psychology”) – not immediately obvious. This was a design shortcut; feel free to replace it with a more intuitive icon (perhaps “language” icon) in the future.

Finally, when using Whisper to generate transcripts, currently the script doesn’t auto-populate currentLyrics. Integrating those results live into Learner Mode would be a great improvement (e.g., parse the WebVTT output into lines and feed them into currentLyrics so that Prev/Next buttons work with them). Keep this in mind if tackling advanced improvements.

AI Integration: Whisper (Local Transcription)

One of the most powerful upgrades in ASMR.one Ultimate is the integration of OpenAI’s Whisper model for on-the-fly transcription of audio. This allows users (and agents) to generate subtitles for any voice work, locally in the browser, without needing pre-existing transcripts or sending audio to the cloud. We utilize a WebAssembly version of Whisper (via Xenova’s transformers.js library) to perform transcription in a Web Worker.

UI Access: The script adds a “Transcribe” button to the player interface – represented by a material icon “record_voice_over” (a face with sound waves, indicating speech). This appears in two places:

In the main player control bar, as a square q-btn with class .asmr-whisper-btn--player (text-primary colored icon). It sits alongside other controls (volume, etc.). The icon title tooltip is “AI Auto-Transcribe (Local)”.

In the mini player bar (footer), a smaller circle icon .asmr-whisper-btn--mini is injected next to the existing mini controls. This ensures the button is accessible even when the player is collapsed to mini mode.

These buttons are inserted by the Whisper class during its enable(). The code searches for the control bar element (.row.self-center:not(.q-py-md) – which is the row of controls in the desktop layout) and the mini player bar (.player-bar or Quasar footer) and appends the buttons if not already present.

Usage Workflow: When the user clicks the Transcribe button:

The button’s click handler will initiate the transcription process if not already running. If a transcription is in progress, we log that and ignore additional clicks to avoid duplicate runs.

The UI gives feedback by adding a spinner state: we add a CSS class .asmr-whisper-loading to the button which, via CSS, reduces opacity and pointer-events (to indicate a disabled/busy state). The icon might also be animated (we considered adding a rotating animation keyframe on that class).

The script gathers the current audio track’s source URL (we look at currentTrack.src || mediaStreamUrl || mediaDownloadUrl). It then attempts to retrieve the audio data:

If the audio is already in our cache (we maintain AudioCache of blobs), it uses that (cache.getBlob(src)).

Otherwise, it fetches the audio via GM_xmlhttpRequest (with responseType: "arraybuffer"). This is done in a memory-efficient way via the WebWorker, but currently, our implementation simply does it in the main thread asynchronously. (We have to be mindful of large files – a future improvement is streaming the audio or using a background thread for fetch to not block UI).

Once the audio blob is obtained, the transcription proper begins. We spawn a Web Worker (in WhisperWorker.ts) that loads the Whisper model (Tiny or Tiny.en by default) and processes the audio. The worker posts progress events which we log in console (e.g., “Loading model 50%” or each decoding step). This can take some time depending on audio length and CPU power. The Tiny model can do roughly real-time or 2x real-time on a modern PC, so a 5-minute track might take 2-5 minutes to transcribe.

When transcription is complete, the worker posts back a message with the result, including a WebVTT formatted transcript. The script receives this and calls injectVtt(webvttText). This function creates a <track> element with kind="subtitles", srclang="en", label="Whisper" and the VTT blob as source, and appends it to the page’s <audio> element. It then sets track.mode = "showing" to activate it.

Simultaneously, we remove the loading state from the button (remove .asmr-whisper-loading class) and mark this.transcribing=false so new clicks can be accepted. The console will log [Whisper] Transcription complete. along with any errors if occurred.

At this point, the user has an English subtitle track available. How to view it? If using a browser’s native controls: usually, if you right-click the video element or use the player’s built-in CC toggle (if any), you can select the “Whisper” subtitles track. However, asmr.one’s player is custom and doesn’t show a subtitle toggle UI. That’s why integration with Learner Mode is planned – we could parse the VTT cues and push them into currentLyrics. For now, a workaround is to use browser dev tools to inspect the <track> or even open the VTT blob URL.

Quirks and Tips: The first time you click transcribe in a session, it will load the Whisper model (~5 MB for tiny) which might take a few seconds (logged as “Loading model: whisper-tiny… 100%”). This is done in the background and cached in memory. Subsequent transcriptions reuse the loaded model, so they start faster.

We chose the Tiny model for performance; it yields reasonably accurate transcriptions for Japanese -> English translation (since we use the model’s built-in translate mode to directly output English). In code, DEFAULT_MODEL = "Xenova/whisper-tiny" and DEFAULT_SUBTASK = "translate". Agents can experiment with larger models (small, medium) for better accuracy, but those are heavier (not included by default). Also note we fix DEFAULT_LANGUAGE = "japanese" to guide Whisper; if audio isn’t Japanese, it can still detect automatically but accuracy may vary.

We handle a couple of error conditions:

If no audio src is found for the current track (maybe a stream hasn’t loaded yet), we log an error and abort.

If the audio fetch or processing fails, we log and stop gracefully.

We also add a safeguard: if the audio is currently playing or user stops it mid-transcription, it doesn’t affect the process since we work on a blob copy.

User Experience: When transcription is running, the user will see the icon dim/spin, but there’s no progress bar UI (we considered overlaying a percentage, but opted to keep it simple). They should wait until the icon returns to normal. Then, the new subtitle track is ready. In the future, we aim to automatically display the results in the Learner Mode UI, eliminating the need for manual track selection.

From a maintenance perspective, the Whisper integration is self-contained. It doesn’t depend on asmr.one’s internal code at all – it’s our own addition. So, issues here will be primarily performance or resource-related. One must be careful with memory (transcribing a 1-hour audio will use a lot of memory for the array buffers and processing). We do release the object URL after adding the track (we store it in AudioCache.objectUrls Map and release when evicting or on next use).

Testing: To test Whisper, pick a short audio track and click the button. Open the browser console to see logs: you should see [Whisper] Fetching audio for transcription: [URL] then model loading messages and finally completion. Check that <track label="Whisper"> appears in the HTML audio element (in dev tools). If you have Chrome, you can use the built-in media dev UI (click the music note icon in the toolbar) to see captions. If nothing appears, verify the audio blob fetched correctly (no CORS issues because we use GM_xhr which bypasses them).

Known Issues: Occasionally, on very long tracks, the transcription can take a long time or even stall. We have not implemented a cancellation mechanism for Whisper (the button simply ignores if already running). In the future, adding the ability to cancel (by terminating the web worker and resetting state) would be good. Also, if a user clicks to transcribe multiple times in one session on different tracks, we load the model each time currently because we instantiate a new worker each time. We could optimize by caching the worker or using a single persistent worker.

Finally, as mentioned, integration with Learner Mode is a work in progress. Until then, Whisper provides a valuable service to generate subs, but users might not notice they exist. A near-term solution could be to automatically open a caption viewer modal with the transcribed text once ready. For example, generating a simple scrollable div of the transcript. Agents could implement that using the parsed cues from the VTT.

In summary, Whisper integration opens the door for AI-driven features in this script. It sets the pattern for how to incorporate heavy AI tasks (via web workers, keeping UI responsive) and how to present results gradually to users. Any future AI additions (like voice synthesis or embedding generation) should follow a similar approach.

Search Enhancements: Magic Search (Semantic Vector Search)

Magic Search is an advanced feature that allows users to search the ASMR library using English keywords and semantic similarity, rather than exact Japanese tags. It’s powered by Jina AI’s text embeddings: we embed the descriptions/tags of works into vectors and then search by vector similarity, which enables queries like “ear cleaning” to find works labeled “耳かき” even if the user doesn’t know that term.

UI Access: We add a “Magic Search” button to the top header bar, represented by a brain icon (material icon psychology) similar to Whisper’s icon but in the header context. It appears to the right of the main search field (we inject a container .asmr-header-actions after the native search input), and then append our button to that container. The button has a tooltip “Magic Search” and clicking it opens our custom search dialog.

Search Dialog: The Magic Search dialog is a custom overlay we create on the fly the first time it’s opened. It’s a centered modal with a semi-transparent backdrop (we reuse Quasar’s dialog classes for style). The HTML structure is built in VectorSearch.buildDialog():

A header with text “Magic Search” and a close “✖” icon.

If the user hasn’t set a Jina API key, a warning message is shown in red: “Warning: Jina API Key missing. Set it in Settings or below.” followed by an input field for the key. (More on API key below.)

The main input: a text box with placeholder “Describe functionality (e.g. 'relaxing')” and a search icon button. The user will type an English (or any language) query describing what they want (could be a genre, a theme, etc.).

A secondary action row: a “Build Index” button and a label showing how many works are indexed.

A results list container below, initially empty, but with a min-height so it can show a list of matching works once search is executed.

When the dialog opens, if a key is missing, the key input is focused (we do input.focus() on open) to prompt the user to paste their Jina API key.

The Jina API Key is required because the script uses Jina’s cloud-hosted embedding service to convert text to vectors (since running a large embedding model in-browser is not feasible). The key (which typically starts with jinaai_...) can be obtained by users from Jina’s portal. We do not ship a key for obvious security reasons. If no key is provided, we cannot perform vector search; we will warn and skip indexing or searching. We allow the user to input the key either in the Settings page (a field could be added there) or directly in this dialog’s input. The code monitors if the key input field is filled when hitting Search or Build Index, and if so, it saves it via Config.set("vectorSearchApiKey", value).

Building the Index: Before search can be effective, we need to have vectors for works. The script can build an index of recent works on demand:

Clicking “Build Index” triggers VectorSearch.bulkIndex(). This will check for API key and if missing, it will show a status “Missing Jina API Key. Set it in Settings.” in the dialog (and abort).

If key is present, it starts fetching works from the asmr.one API in batches of 1 page at a time (each page may have ~30 works). By default we fetch 5 pages (around 150 works) or until we have indexed 200 works, whichever first. These defaults were chosen to avoid overloading either the API or the client; they can be adjusted if needed via maxPages or maxWorks parameters.

For each page fetched (GET /api/works?order=release&sort=desc&page=N to get latest releases), we send each work’s combined text (title + tags, etc.) to Jina’s embeddings API: POST https://api.jina.ai/v1/embeddings with JSON payload containing the text. The Jina API returns a vector (embedding) for the text. We then store that vector in IndexedDB (asmr-one-vectors object store, key = work ID).

During indexing, the dialog’s status label updates with messages like “Fetching page X...”, “Indexing page X (Y works)...” so the user knows it’s working. At the end it says “Bulk indexing complete.” or an error if failed.

We also update the indexed count display (asmr-vector-count) to show how many works are now indexed. This count is obtained by counting records in the IDB store.

We designed indexing to run in the background (it’s asynchronous and uses await for network calls inside the bulkIndex function). The UI feedback is minimal text; perhaps in future an actual progress bar or spinner could be nicer. The user can continue using the site while it runs (the dialog remains open; we don’t disable the interface, but doing another search mid-index could mix messages – we prevent multiple runs by autoIndexRunning flag).

Performing a Search: When the user enters a query and hits the Search button (magnifying glass) or presses Enter, the script executes VectorSearch.search(query):

If a key was just entered, we save it as mentioned.

We first ensure the embedding index is not empty. If vectorSearchApiKey is missing or asmr-one-vectors IDB is empty (count 0), we can’t search and likely show “Index is still empty. Check API Key or Console for errors.”. We encourage the user to Build Index in that case.

Assuming we have some vectors, we call Jina’s API to embed the user’s query text into a query vector (a single POST request with the query text). If that fails (network or key issue), we warn “Failed to generate embedding. Check API Key.”.

Next, we perform a similarity search locally: we go through all stored vectors in IDB and compute cosine similarity with the query vector. The top matches are identified (we could use a threshold or fixed top-K, currently we simply get all and sort). For efficiency, a future improvement could be to use a better data structure or limit to top-K as we go.

We then retrieve the actual work metadata for those top matches. We might have to fetch details from /api/works/{id} or use cached data if any (depending on what we stored). In our current implementation, we rely on the fact that when we indexed, we already have the titles from that. Actually, we likely stored the whole work object or at least references in IDB. The code that performs search is not fully shown in snippet, but presumably VectorSearch.search(val) after getting results will call renderResults(listOfWorks).

Finally, we populate the results list in the dialog (asmr-vector-result-list) with clickable entries. Each might show the work’s title, perhaps an image, etc. In our design, we intended to render each result as a Quasar list item or at least a link to the work page. The code likely uses this.renderStatus() for messages and some similar function for listing results, which isn’t shown above, but we have a note: it likely uses the site’s component or a simplified template. For example, one approach: create an anchor for each result with the work title that links to /work/{id} (so clicking it closes the dialog and navigates to that work).

We also intercept the site’s main search input to allow English tag search (this was part of EnglishTags feature, see next section). However, Magic Search is separate and more powerful; it looks at all metadata, not just tags, and uses semantic matching.

API Key Handling: The script stores the Jina API key in Config.vectorSearchApiKey. It is not exposed openly except inserted in a hidden input. It’s used in an Authorization header for the Jina API calls. We caution agents to keep this secure. If an agent is running tests, they should supply their own key. The UI clearly warns if missing, and none of the vector search functions proceed without it (to avoid spam errors).

Cleanup: If the user clears the index or the key, searches will be no-op. We provided a “Clear Index” function (maybe in code but not exposed in UI) that could wipe the IDB store if needed; not currently in UI though. The LRU eviction for audio doesn’t affect the vectors DB (different DBs).

Verification: After building the index, try searching a term you know corresponds to something. E.g., if you indexed recent works and one has tag “耳かき” (ear cleaning), search “ear cleaning”. The dialog’s result list should populate with that work (and possibly others, sorted by relevance). You’ll see console logs [VectorSearch] Bulk index complete and then logs for search if any. Ensure that clicking a result indeed navigates to the correct work. Also test with no key: it should not break anything, just warn. We also log in console if key is missing and skipping background indexing.

Edge Cases: If the user tries to index a huge number of works, it could be slow or hit API limits. We limited to 5 pages/200 works by default. Agents can adjust these if needed. Also, if asmr.one changes its API or requires auth for /api/works, that could break indexing (currently asmr.one’s APIs for public works are open).

Multi-language: We set the search input placeholder to suggest English, but actually any language query would be embedded. For instance, a user could paste Japanese text; the model will embed it appropriately. Jina’s service uses a multilingual model by default, so it’s fine.

English Tag Search Integration: Apart from Magic Search, we also improved the standard search bar to accept English tags. The EnglishTags feature (discussed next) creates a mapping of English -> Japanese tag IDs. We intercept the site’s search action such that if the user types an English tag name, we replace it with the corresponding Japanese or ID. Specifically, if the site search normally dispatches Works/search with a keywords string, we intervene: we check if the query matches a known English tag; if yes, we dispatch Works/search with tags: [tagId] instead. This way, searching “binaural” can yield results tagged バイノーラル. This integration is seamless in the main search bar (so user might not even realize the magic – it just works). It’s less powerful than Magic Search (exact tag matches only, no semantic fuzziness).

In summary, Magic Search provides a power tool for discovery. Agents maintaining this should ensure the Jina integration remains functional (watch for any API changes or key usage changes – currently we use Bearer token in header as of this writing). If Jina changes their API, update the endpoints accordingly. Also monitor the size of the IDB – if the index grows too large (in theory, indexing the entire site, thousands of works, might need some memory considerations), perhaps implement a cap or pruning (not currently needed for our scale).

Localization and Tag Translation: EnglishTags

The EnglishTags feature addresses language barriers by translating tag names and enabling tag-based features in English. The asmr.one site is primarily Japanese (with some Chinese localization), so tags for content are in Japanese. EnglishTags makes it easier for non-Japanese speakers to navigate tags.

Tag Dictionary: On startup, we fetch the full list of tags from the site’s API (/api/tags) which returns an array of tag objects (each with id, name in Japanese, maybe romaji, etc.). If the API call fails (maybe user not logged in or network error), we attempt a fallback by scraping the /tags page HTML. Using either method, we build a list of all tags. We then translate each tag name to English. We use a combination of approaches:

For some common tags, we have a built-in mapping (e.g., we know id 12 is “Whispering” for ささやき) – indeed in code we see an array of known tags with en and ja fields. This likely seeds our dictionary.

For the rest, we might use the Google Translate API similarly to how we translate subtitles, or another source. The code references augmentEntityList() and logs like [EnglishTags] Translated chip: 疑似バイノーラル -> pseudo binaural, meaning it translated some Japanese text.

The final result is stored in an internal array or perhaps in IndexedDB via a TagDatabase. The code hints at this.db in EnglishTags (maybe not used) and TagDatabase class exists (which likely saves tag data, currently only Japanese, but could be extended to include translations).

Augmenting UI: Once we have English equivalents, we augment the UI tag chips on various pages:

On a work’s page, tags are displayed as Quasar q-chip elements (with Japanese text). EnglishTags runs through the DOM, finds .q-chip elements, and if the text matches a known tag (in Japanese), it appends or modifies it to show English. The log [EnglishTags] Augmented chip: {JP} -> {EN} suggests we add the English text next to the Japanese or as a tooltip.

Implementation: We likely inject a small <span class="english-tag"> after the Japanese text inside the chip with the English in parentheses or a smaller font. Alternatively, we might simply change the chip’s label to English if the user’s language is not Japanese. However, replacing might confuse, so appending is better. Since the logs say “augmented”, we assume it’s additive.

We also avoid double-translating or messing up chips that might already be translated. The code has logic to skip if a chip already has some sign of translation or if the text looks non-Japanese (the looksJapanese(text) check).

Another aspect is translating certain category texts or UI text. For example, on the homepage or search page, there might be headings like “人気” (popular) or filter labels that we could translate. The code shows augmenting “entity list” and possibly hooking into some list of tags to translate them in bulk.

Search Interception: The major functional use of EnglishTags is allowing English input in the main search bar. We maintain a map of English -> Tag ID. When the user submits a search query:

If the query exactly matches an English tag name we know, we intercept the search dispatch. In TagFilters.updateSearch() and also in a snippet in the final assignment to window.ASMRUlt.search, we replace it with a tag search. Specifically, instead of dispatching Works/search with keywords: "whispering", we dispatch Works/search with tags: [12] (if “whispering” is tag 12). If multiple English terms are entered (not likely in a single query), our logic currently handles one tag. For multi-tag search, the user should use the Tag Filter feature by clicking chips instead.

We also support partial matches via fuzzy search. Actually, our code includes Fuse.js (a fuzzy search library) configuration for tag names. It’s possible we index tag names in a Fuse instance to allow queries that are not exact. E.g., user searches “binaur” and we find “Binaural”. This wasn’t explicitly shown being used, but the presence of Fuse config suggests the intention.

Active Tag Filters UI: EnglishTags ties into the Contextual Tag Filtering feature (see TagFilters section) by providing human-readable names for tags in the filter bar. When you click a tag chip, the TagFilters bar at the bottom shows the filter. We ensure that if the user interface is English, we show the English name in that bar. Indeed, activeFilters map in TagFilters stores label along with ID. The label is taken from either the anchor text or chip text, which after augmentation might already be English or a mix. We trim it and use it. In practice, the bottom filter chips likely show the same text as was on the clicked chip (so if we augmented the chip to "バイノーラル (Binaural)", that entire string might be in the label). We might refine that to just "Binaural" for display. The current approach simply uses .textContent which could include both; an improvement would be storing a separate English name and using that in filter bar.

Maintaining Translations: If the site adds new tags or changes names, our EnglishTags will fetch fresh tag lists on each load (or maybe cached via IDB, but likely fetch each session for simplicity). It’s low-cost (<300 tags). We translate them each time, which uses some API calls or internal dictionary. We might consider caching translations in GM storage to avoid repeated API calls for known tags. Currently, not implemented, but not critical.

Validation: To test EnglishTags:

Open a work page with known tags (e.g., “バイノーラル”). After script loads, that chip should now show something like “バイノーラル (Binaural)” or have an English tooltip. Check the page’s DOM: you should see either text inserted or the chip’s title attribute set to "Binaural".

Use the main search bar: type an English genre like “whispering” and search. The script should redirect to the search results for the corresponding Japanese tag. You can verify by the URL or page state – it should look the same as if you clicked that tag chip. Also, console might log a message about intercepting search.

Click tag chips to add filters (which triggers TagFilters). The filter bar at bottom will show the tag names. If you augmented the chips, those appear with English. Removing filters should work by clicking the “cancel” icon next to each filter in the bar.

Internals: The EnglishTags class is likely a singleton (they use EnglishTags.getInstance() to ensure one instance). It probably attaches a MutationObserver to watch for new tag chips appearing (e.g., on infinite scroll or dynamic loads), and calls augmentChip() on them. The code snippet indicates something about entityIndex and batch augmentation, which hints that on pages listing many tags (like the /tags directory page), it might process them in chunks to avoid blocking the UI.

Quirks: A tricky part was preventing our translations from being overridden by Quasar’s dynamic updates. For example, if the user toggles language in site or navigates, Quasar might re-render the chips. Our solution was to observe route changes and re-run augmentation on new content (we call await englishTags.enable() at init after TagFilters). The enable() likely fetches tags and sets up augmentation. We also ensure to only translate actual tags, not things like series titles that might also appear as chips. We rely on context (looking for /tags/ in the anchor or data-tag-id attribute) to identify real tag chips, cooperating with TagFilters which intercepts clicks.

Overall, EnglishTags makes the interface more approachable. Agents should update the built-in tag mapping as needed (if new common tags appear, adding them to the known list with proper translation would improve accuracy). Also, if the Google Translate API is used extensively here, monitor for rate limits (however, number of tags is small and done once).

Playlist Generator

(Note: This feature is experimental and may be refined further.)

Playlist Generator allows a user to create a custom playlist of tracks based on selected tags and rating filters. The idea is to mimic a “smart playlist” – e.g., “find me tracks tagged ‘ear cleaning’ between 10-30 minutes length.” It was inspired by users wanting a way to generate a long mix of tracks automatically.

UI Access: The script doesn’t yet have a dedicated button for this in the UI, but it was planned to appear perhaps in the user menu or as a sub-item under Radio Mode. Currently, you can invoke it via console: ASMRUlt.playlistGenerator.open(), or it might automatically open when toggling certain modes (this part is not clearly exposed; adding a proper UI is a to-do). For now, we’ll describe how it works under the hood, as agents might need to hook it up.

Dialog Interface: When triggered, the PlaylistGenerator opens a dialog (similar style to Magic Search) with options:

Include Tags / Exclude Tags – fields to select which tags must be present or must NOT be present in works for the playlist. The dialog likely has two multi-select dropdowns (or input+autocomplete) for includes and excludes. The script populates these with the list of tags (EnglishTags helps here by providing translations). We see code snippet creating includeSelect and excludeSelect and hooking their input events to populate suggestions.

Min/Max Length – possibly input fields for duration range (or track count). The code references .asmr-min and .asmr-max selectors in the dialog, which suggests two numeric fields, probably for length in minutes.

Generate Button – to start generation.

When the user confirms:

The script gathers the selected include tag IDs (selectedIncludes) and exclude IDs (selectedExcludes).

It also reads the min and max values for track length.

It then performs an iterative search through works (likely using asmr.one’s API or the indexed list) to find tracks that match the criteria. It might use the Works/search endpoint with tags parameters (for include) and then filter out excludes and length client-side. Or possibly use the local vector index if built (less likely for this).

The code shows it fetching pages in a loop with a log Fetching page X... and break conditions. This suggests it goes through works via API pages similar to vector bulk index, but applying filters if possible (asmr.one’s API can take tags param for includes; for exclude we must filter manually).

It collects all tracks from works that matched, then shuffles or sorts them as needed, and limits how many total (maybe to avoid huge playlists, could be a cap of, say, 100 tracks).

It then uses site’s store to set a global playlist: specifically, it builds an array of track objects and calls AudioPlayer/setPlaylist with that array, and maybe immediately dispatches playTrack on the first track. Indeed, snippet shows in PlaylistGenerator’s code, after generating tracks, it does store.dispatch('AudioPlayer/setPlaylist', tracks) and then store.dispatch('AudioPlayer/playTrack', tracks[0]) to start playing.

It logs how many tracks were generated and closes the dialog.

Goal: The result is that the user is taken to the Playlist page (asmr.one has a route /playlist when a custom playlist is active), and the audio player will start playing through the generated list. Our sidebar menu’s Playlist Active indicator will turn on (we monitor route /playlist to highlight that in the menu). The sidebar menu item under Radio Mode shows “Playlist Active” when a playlist is loaded.

Cancel and Progress: If generation is taking time or too many works, the UI should respond. The code has cancelRequested flag in PlaylistGenerator (maybe for future use with a Cancel button), and it updates status text similarly to vector search using setStatus() calls (we see logs).
It also avoids infinite loops by breaking out if no works found on a page or if a certain number of pages checked.

Testing: Without a direct UI, to test one would manually call it or add a temporary button. Agents working on it might want to integrate a “Generate Playlist” button in the Settings or as a sub-option in Radio Mode. To verify, use a simple scenario:

e.g., include tag = “binaural”, exclude none, min=0, max=100 (so basically all binaural tracks). Generate. It should create a playlist of many tracks. Watch logs for any errors and see that playback starts and the URL might change to .../#/playlist.

Check the sidebar text: it should show “Playlist Active” in blue text until you navigate away or playlist finishes.

Known Issues: This feature can be heavy – pulling many pages from API and then sending potentially dozens of track play requests to audio player. It might freeze UI if not careful. We mitigated some by logging progress and not processing all at once. Still, a potential improvement is to chunk the playlist or limit to, say, 50 tracks. Also, the interface could use improvement: ability to pick random vs. sequential, perhaps to save a playlist for reuse (not implemented).

In prior agent attempts, there was an issue of UI hang. The chain-of-thought notes mention “potential infinite loops or slow multi-page fetch causing UI freeze… add progress indicators, cancellation, and page limits”. We addressed page limit (5 by default) and have a cancel flag though no button. Agents should be cautious to test that generation stops properly at the limits.

Integration: Playlist generation overlaps somewhat with Radio Mode’s domain (continuous play), but it’s user-directed and finite. We integrated it by ensuring Radio Mode knows when a playlist is active (so it doesn’t interfere). In code, when a playlist is active (route starts with /playlist), we set a flag playlistActive = true and update the menu status. Also, if radio was on, we might want to turn it off during a manual playlist, but currently we just treat them separately – user can have Radio Mode off while enjoying a custom playlist.

All in all, PlaylistGenerator is a bonus feature that showcases the script’s ability to mix and match content by tags and length. It’s not as polished as other features due to limited UI, so future agents can improve by exposing it nicely (perhaps a “Mix Tape” button on the sidebar). The heavy lifting code is there; mostly needs UX love and perhaps performance tuning for large queries.

Technical Notes: Event Handling, Context & Theming

Throughout the project, there are some cross-cutting technical considerations:

Event Handling & Context: As discussed, avoid inline JS in injected HTML. Always bind events via addEventListener in our script context, so that callbacks have access to our closures and classes. We attach listeners at either creation time (e.g., the Whisper button’s btn.onclick = ... within script context) or via delegation (TagFilters uses a single body capture listener to catch all .q-chip clicks). The delegation approach is useful when elements are created by the site after our initial run. We do that for tag chips because they can appear in various places dynamically.

Another pattern is using Vue’s reactive watchers: we use store.watch and app.$watch for certain state changes (e.g., watch currentTime for AutoProgress, watch route for toggling subtitles). This hooks into the page’s reactivity cleanly. Agents should utilize these where possible instead of polling. We only poll when no direct hook exists (e.g., waiting for an element to appear we use SafeUtils.waitForElement as in sidebar injection or LearnerMode poll every 500ms as a fallback for lyric detection).

Page vs Script Context Communication: We have taken steps to ensure our script can call site functions and vice versa by bridging global objects. E.g., window.ASMRUlt.search = term => store.dispatch('Works/search', {keywords: term}). This way, if the site’s native search box tries to do something, or if a user or dev calls ASMRUlt.search('Ear Cleaning') in console, it triggers our integrated search. Similarly, toggleRadio, skipRadio, toggleShuffle are exposed globally. We stubbed them early (they did nothing until features loaded), then later Object.assign to attach the real implementations. This approach avoids issues where, say, an inline event from our injected HTML calls ASMRUlt.toggleRadio() expecting it to exist. It was a solution to the context mismatch problem we faced originally, and now it’s stable. Agents should maintain these global binds when adding new global functionalities.

For example, if you add a new feature that might be triggered by the page (say a keyboard shortcut via the site’s keybindings), consider exposing a method in ASMRUlt if needed. But do avoid polluting unsafeWindow more than necessary.

### Theming & CSS Variables

We use a semantic variable system to ensure 100% theme reactivity (Light/Dark mode) without needing explicit `.q-dark` overrides in most cases.

**Core Variables:**
- `--asmr-accent`: Main brand color (Purple).
- `--asmr-bg-primary`: Main background (White / Dark Gray).
- `--asmr-bg-secondary`: Secondary background (Light Gray / Darker Gray).
- `--asmr-bg-tertiary`: Tertiary background (Hover states, etc.).
- `--asmr-bg-overlay`: Background for dialogs/overlays (High opacity).
- `--asmr-text-primary`: Main text color (Black / White).
- `--asmr-text-secondary`: Secondary text (Dark Gray / Light Gray).
- `--asmr-text-tertiary`: Muted text.
- `--asmr-text-inverted`: Text on accent backgrounds (White / Black).
- `--asmr-border-color`: Subtle border color.

**Usage Rules:**
1. **Always use variables**: Avoid hardcoded hex codes like `#fff` or `#000`. Use `var(--asmr-bg-primary)` or `var(--asmr-text-primary)` instead.
2. **Avoid `.q-dark` blocks**: The variables automatically switch values based on the `.body--dark` class. You usually don't need separate CSS rules for dark mode.
3. **Quasar Compatibility**: Quasar's internal dark mode uses `.q-dark` or `.body--dark`. Our variables hook into this system.

**Example:**
```css
.my-card {
    background: var(--asmr-bg-primary); /* Automatically white or dark gray */
    color: var(--asmr-text-primary);    /* Automatically black or white */
    border: 1px solid var(--asmr-border-color);
}
```

Theming with Quasar Variables: Our CSS tries to respect the site’s dark/light mode automatically. Quasar sets classes on body (.body--dark or .q-dark) in dark mode. We use those in CSS selectors to alter colors. We rely on Quasar’s CSS variables like --q-primary, --q-grey-7 for color consistency. For instance, our injected header icons are given color: var(--q-primary) so they match the theme’s primary color (which is a shade of purple on asmr.one). We also adjust hover states similarly.

When adding styles, prefer using these variables or Quasar utility classes (e.g., text-primary, bg-grey-3, etc.) which we did. Example: the filter bar uses q-banner row items-center shadow-2 classes to mimic Quasar banners, plus our .asmr-filter-overlay for positioning. This way, if Quasar styling changes, we mostly blend in.

Also, manage toggling classes rather than inline styles when possible. We did inline style in a few places (like setting display: none or block dynamically in JS), but that was for simplicity. Using classes (e.g., adding a .hidden class) could be cleaner.

File and Code Structure: The source is organized in modules (see src/features, src/ui, etc.). Agents should mirror that structure for major additions. The build process with Vite ensures all classes are included in the final asmr-one-ultimate.user.js. When editing via an agent in the runtime (like in a chat environment), you may edit the final JS directly; but for sustainability, also reflect it in the TS source if possible.

The key modules and their responsibilities are:

RadioMode.ts – continuous playback logic and state.

Shuffle.ts (ShuffleFeature) – manages shuffle config and UI integration (toggling icon or state).

LearnerMode.ts – subtitle UI and translation management.

Whisper.ts and WhisperWorker.ts – transcription feature.

TagFilters.ts – contextual tag filter UI and search integration.

EnglishTags.ts – tag translation and augmentation.

VectorSearch.ts – semantic search (Magic Search) UI and vector index management.

PlaylistGenerator.ts – playlist creation logic.

WorkMetadata.ts – fetches additional info for works (e.g., from DLsite, though we didn’t detail it, it parses things like age ratings, which might not be critical for our doc).

AudioCache.ts and StorageManager.ts – offline audio caching and eviction.

KikoeruBridge.ts – as described, bridging to the host app.

SidebarMenu.ts – injection of custom items into the sidebar (Radio toggle and displaying status).

HeaderActions.ts – injection of the header container for icons (and possibly other header modifications).

Knowing these boundaries will help new agents find where to implement changes. E.g., a bug in tag filter UI likely lives in TagFilters.ts or EnglishTags.ts, etc. We’ve tried to keep cross-feature logic minimal (features communicate via the central store or by small global flags like RadioMode.isActive).

Performance considerations: We have multiple mutation observers and intervals. We ensure to disconnect observers when not needed (TagFilters only uses one and reuses it). Still, agents should be wary of adding too many observers or heavy polling. The site is dynamic but not overly so; most changes are route-based. Use app.$watch('$route', ...) rather than a heavy global observer where possible. We did that in LearnerMode and TagFilters to know when to hide or update UI.

Versioning: The script metadata @version is maintained at the top of the file. When an agent completes a fix or feature, they should increment this version and update the GreasyFork if applicable. We currently are at version 119 in the legacy and aimed for 121 after new additions. So follow semantic increments (since no breaking changes for users, minor increment is fine).

Testing & Debugging: We have a suite of tests (unit tests via Vitest) and automated DOM checks:

Running npm test will execute any unit tests we wrote (e.g., for SmartSelector scoring or tag translation logic).

We included two Node scripts: scripts/verify-dom-injection.mjs which likely loads a saved HTML page of asmr.one and checks that our script’s selectors successfully inject elements (this helps ensure our selectors like .q-drawer .q-list still exist). And scripts/verify-live-site.mjs which uses Playwright to run the script on the live site and simulate user interactions for a smoke test. Agents can run these to catch regressions.

The tests also ensure we don’t inadvertently break things like site’s core functionalities. For example, after the script loads, the normal site navigation and playback should continue working. Always do a manual sanity check: can you still play a track normally? If a user chooses not to use Radio or subtitles, the site should behave normally (our features should be mostly additive, not disruptive except where intended).

Development Workflow for Agents

To effectively contribute or fix issues, the recommended dev flow is:

Setup the project locally (if possible via the connectors or your environment). Install dependencies and use npm run dev to get a local auto-reloading userscript. This way you can test changes in real time on asmr.one.

Identify an issue from the queue (or a new bug). For example, an open issue might be “Whisper button not visible on mobile” or “Auto initial path sometimes fails”.

Reproduce the problem – open asmr.one in the relevant scenario and observe (with console open). If needed, enable verbose logging by setting window.disableLogging = false if it was turned off (the site had a console hijack; we ensure our Logger always logs by default).

Locate relevant code – use the feature breakdown above to jump to the module likely responsible. Use global search in the code or our knowledge (e.g., anything to do with folder selection → SmartSelector).

Apply fix or improvement – modify the TypeScript (or the built .user.js carefully if doing quick patch). Keep code style consistent (we use ES6 classes, mostly functional style, minimal external libs except Fuse).

Test thoroughly – not just the direct fix, but regression test around it. If you changed how tag chips are augmented, test TagFilters, test multiple navigations (work -> search -> work). If you changed skip behavior, test Radio Mode skipping in various states (paused, playing, etc.).

Update Documentation – if your fix changes user-visible behavior or notable internal behavior, update this AGENTS.md accordingly. E.g., if we fixed the auto-folder logic, note that bug resolved and how to verify. This manual should remain up-to-date so future agents don’t reintroduce a solved problem.

As an agent, when you resolve an issue, also consider writing a unit test for it if it’s a pure logic bug (for example, test that SmartSelector.selectBestFolder returns the correct folder given a synthetic input structure). This will prevent regressions.

Appendix: Taking On an Unresolved Issue

When you pick an issue from the tracker, follow these steps:

Analyze the Issue: Understand the expected behavior vs actual. Use user descriptions, logs, and try to replicate. Gather any clues (e.g., error stack traces).

Find the Code Reference: Search the code for keywords related to the issue. Our source is well-sectioned, so you can often search by function names mentioned in logs or by relevant terms. For instance, an issue about “Vector search returns empty results” – search for renderStatus("Index is still empty") which leads to the check in VectorSearch.

Plan the Fix: Outline what needs to change. Small bug (one-line logic fix) or larger (redesign flow)? Consider side effects. For multi-step tasks, break it down and maybe commit intermediate steps (if working locally with git).

Implement Safely: If unsure, experiment in the browser console first. We have window.ASMRUlt hooks to manually toggle or call things. For example, if debugging the radio folder selection, you can do ASMRUlt.toggleRadio() and step through what happens.

Test in Isolation: Where possible, write a quick test or use the existing test harness. We provided a Playwright script for live site smoke tests – run that to ensure you didn’t break core flows.

Document the Change: In this manual (AGENTS.md), record the resolution: update the “Known Issues” section if the issue is now fixed, possibly remove it from the list. If you add a new feature, document it in the relevant feature section above.

Example: Suppose Issue #5 is “Whisper button not appearing on mobile layout.” You reproduce and find that in mobile, the .row.self-center:not(.q-py-md) selector doesn’t find the control bar (because on mobile the controls have class .q-py-md). The fix might be to adjust the selector or add an alternate. Implement that in Whisper.enable() and test on mobile by using device toolbar or narrow window. Once fixed, update the Whisper section in this doc to note it appears on mobile too (thus removing a known bug note).

Keeping this document up-to-date is crucial as it serves as both a knowledge base and a living strategy guide for future development.

Localization Guidelines

All user-facing strings must use the I18n system defined in `src/core/Config.ts`. Never hardcode English or Chinese text in feature code.

**Adding new strings:**
1. Add a key to the `en` object in `i18nData` (e.g. `myFeatureTitle: 'My Feature'`).
2. Add the corresponding `zh` translation (e.g. `myFeatureTitle: '我的功能'`).
3. Use `I18n.t('myFeatureTitle')` in your code instead of a literal string.
4. For strings with variables, use `I18n.format('myKey', { count: 5 })` with `{count}` placeholders in the translation string.

**DOM detection rules:**
- Never match host app sections by header text (text changes with language).
- Use `findSectionByIcon('icon_name')` in SettingsManager to locate sections by their material icon content.
- Fall back to structural detection (e.g. last `.q-list` on page) rather than text matching.

**Language sync:**
- `I18n.syncFromHost()` detects the host app's language from localStorage, `<html lang>`, and the Language dropdown.
- SettingsManager watches for language changes via MutationObserver and re-injects all sections when the language changes.
- New features that build static HTML should either rebuild on language change or use `I18n.t()` calls at render time.

Known Engineering Issues

- `tsconfig.json` Type Errors: The project currently reports missing type definitions for 'bun' and 'node' in `asmr-collections/apps/server/tsconfig.json`. This is likely due to missing devDependencies or misconfigured paths. Agents should note this if encountering type errors in that package.
