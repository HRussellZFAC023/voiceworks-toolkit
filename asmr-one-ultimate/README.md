# Voiceworks Ultimate

A comprehensive browser-based toolkit for Japanese language learning through immersion with native voiceworks. Runs as a [Tampermonkey](https://www.tampermonkey.net/) userscript on [asmr.one](https://asmr.one), enhancing the platform with on-device AI transcription, real-time neural translation, and dozens of study and quality-of-life features — all running locally in your browser with no external server dependencies.

## Features

### Language Learning

#### Learner Mode — Dual-Language Subtitles
Real-time synced subtitles purpose-built for immersion-based Japanese study. Japanese text is displayed as the primary line with blurrable English translations underneath — hover or press B to reveal. Automatically loads LRC lyric files when available and integrates with live Whisper transcriptions for unstudied content. Chinese-language subtitles are auto-translated to Japanese via Google Translate so learners always see kana/kanji as the primary line. Playback speed controls and configurable lead-time let you study at your own pace.

#### Live Transcription — On-Device Speech-to-Text
Turns any voicework into study material by transcribing audio in real-time directly from the player element — no file downloads or uploads needed. Powered by [Transformers.js](https://huggingface.co/docs/transformers.js) running the `whisper-small` model inside a dedicated Web Worker with WebGPU acceleration. Transcripts are cached per-track with a 90-day TTL for instant reloads on revisit. Supports 8 language modes (Japanese, English, Chinese, Korean, etc.) and exports to LRC, VTT, and SRT subtitle formats for use in external tools like Anki or mpv.

#### Neural Translation — Local Machine Translation
Two dedicated neural translation models (`Xenova/opus-mt-ja-en` for Japanese→English and `Xenova/opus-mt-zh-en` for Chinese→English) running entirely in-browser via Web Workers. Uses greedy decoding for fast throughput on short CJK text segments. Local translation is WebGPU-only by policy; if GPU inference fails, requests fall back to remote translation instead of WASM to avoid severe latency on constrained devices. Includes scheduler-backed priority queues, cancellable stale-batch dropping, in-flight request deduplication, and shared translation caching. Translates player titles, content tags, and UI elements with low-latency updates.

#### Interface Translation
Localizes the platform's Chinese and Japanese UI strings to English using a hardcoded translation map for static elements (sort options, buttons, menus) and pattern-based regex replacements for dynamic text. Combined with the neural tag translator, this makes the entire interface accessible to English-speaking learners.

### Search & Discovery

#### Semantic Search — AI-Powered Discovery
Find voiceworks by meaning rather than exact keyword matches. Embeds titles and descriptions using the Jina v3 embeddings API, with vectors stored locally in IndexedDB (`asmr-one-vectors`). Supports multilingual queries with tag-based hints and paginated results. Rate-limited to respect Jina's free tier (500 RPM). Ideal for finding content by topic or theme when you don't know the exact Japanese title.

#### Advanced Search — Multi-Filter Query Builder
Structured search with filters for tags, circles (creators), voice actors, date range, rating, and price. Supports AND/OR logic for combining multiple filters. Includes saved search history for quick re-use of frequent queries.

### Playback & Immersion

#### Radio Mode — Continuous Shuffled Playback
Shuffled continuous playback across your entire library for extended immersion sessions. Automatically selects random voiceworks and plays all tracks sequentially, advancing to the next work on completion. Health-checking and auto-recovery mechanisms keep the stream running through network interruptions. Playback state persists across page refreshes. Mutually exclusive with Playlist Mode.

#### Playlist Mode — Sequential Work Playback
Curated playlist playback with forward/back navigation controls injected into the player bar. Auto-advances to the next voicework when the current one finishes. Paired with the Playlist Discovery panel for browsing, searching, and activating community-curated playlists — useful for finding themed study collections.

#### Shuffle
Enhanced playlist shuffling that integrates with the host app's native shuffle controls. Applies a hard shuffle that maintains playback of the current track and persists the shuffle preference across sessions.

#### Audio Cache — Offline Playback
IndexedDB-backed audio caching with TTL-based expiration. Automatically caches tracks during playback for offline replay and reduced bandwidth on revisits — useful for reviewing previously studied content without re-downloading.

### Media & Visualization

#### Media Viewer — Inline Gallery
Click-to-expand lightbox for images and video files bundled with voiceworks. Supports JPG, PNG, GIF, WebP, MP4, WebM, MOV, AVI, MKV, PDF, TXT, and SRT. Slideshow mode with auto-advance, keyboard navigation (arrow keys, ESC), and swipe support on touch devices. Thumbnail caching and lazy loading for performance.

#### Player Gallery — Album Art Slideshow
Image gallery integrated into the player's album art area. Displays work cover images with slideshow navigation, arrow controls, swipe support, and keyboard shortcuts.

#### Audio Visualizer — Real-time Spectrum Display
40-bar frequency spectrum visualization using the Web Audio API's AnalyserNode. Renders in both a collapsible compact view (fixed position) and an expanded player-integrated view. Smooth animations with configurable bar styling.

#### Player Fullscreen
CSS-based fullscreen expansion for the player area. Preserves playback during toggle, syncs with the Player Gallery when active. Keyboard shortcut: F.

### Progress & Organization

#### Auto Progress Tracking
Automatically tracks listening progress across your library. Marks voiceworks as "listening" when playback starts and upgrades to "listened" when a track reaches 80% completion. Progress checkmarks appear on work cards throughout the site, making it easy to see what you've already studied. Supports "postponed" status for works you want to return to later.

#### Folder Diver — Smart Directory Navigation
Intelligently navigates nested voicework directory structures to find audio content. Uses a folder scoring algorithm that weights by audio file count, folder name keywords, and content relevance. Continues diving until audio tracks are found or max depth is reached. DOM click simulation ensures reliable interaction with the host app's Vue 2 reactivity.

#### Flat View — Alternative File Browser
Side-drawer panel showing all files from a voicework in a flat list, as an alternative to the native tree view. Supports direct playback, lightbox image viewing, and file path copy. Responsive layout with dark mode support and animated slide-in/out transitions.

#### Work Tree Copy
Bulk copy voicework file paths and directory structure as formatted text to clipboard.

### Metadata & Information

#### Work Metadata Panel
Enhanced metadata display showing additional detail for voiceworks: circle (creator) info, voice actor credits, release date, and other fields not shown in the default UI. Customizable information layout on work pages.

#### HVDB Cross-Reference
Adds a one-click link to HVDB (an alternative metadata database) next to the DLsite link on work pages, enabling quick cross-database lookup for additional information.

#### Comment Section
Community comment section injected into work pages with persistent localStorage-backed storage and reply threading support.

### Quality of Life

#### Keyboard Shortcuts
Comprehensive keyboard control for hands-free operation during study sessions:

| Key | Action |
|-----|--------|
| Space / K | Play / Pause |
| M | Mute / Unmute |
| F | Fullscreen toggle |
| Arrow Left/Right | Seek ±5s (Shift: ±30s) |
| Arrow Up/Down | Volume ±5% |
| \[ / \] | Decrease / Increase playback speed |
| 0–9 | Jump to 0%–90% of track |
| B | Toggle English subtitle blur |
| J | Toggle Japanese subtitles |

Smart input filtering — shortcuts are ignored when typing in text fields.

#### Infinite Scroll
Replaces pagination with IntersectionObserver-based infinite scroll on home, category, and search pages. Seamless browsing without manual page navigation.

#### OS Media Integration
Updates system media controls (notification center, lock screen) with voicework metadata and album art. Play/pause/next/prev from your OS media keys without switching to the browser.

#### Dynamic Favicon
Shows the currently playing voicework's cover art as the browser tab favicon for quick identification across tabs.

#### Tag Filters
Click any tag to instantly filter by it. Persistent filters across navigation with a visual filter bar and storage-backed persistence.

#### Route State Sync
Syncs view state (filters, sort order, search query) with URL query parameters. Restores your exact view settings on page reload or when sharing links.

#### JOI Tool — Interactive Edge Game
Interactive edge game with live Whisper transcription that listens for spoken commands. Real-time audio analysis with configurable difficulty settings.

#### SFW Mode — Safe for Work
Hides all images and thumbnails site-wide for discreet browsing in public or shared environments.

#### Store Backup — Export/Import Settings
Export all settings and preferences to a JSON file. Import to restore configuration on a new browser or after a reinstall.

#### Player Translator — Track Title Translation
Translates Japanese and Chinese track titles in the player to English in real-time using local neural MT models.

#### Translated Tags — CJK Tag Translation
Translates CJK tags throughout the entire UI (work cards, search, filters) to English using cached translations stored in IndexedDB.

#### CORS Fixer
Transparent proxy workaround for cross-origin restrictions on content delivery, ensuring media files load reliably.

#### Localization
Full English, Chinese, and Japanese UI localization. All user-facing strings use `I18n.t()` with interpolation support via `I18n.format()`.

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser. On Chromium-based browsers (Edge, Chrome), go to the Tampermonkey extension details page and enable **Allow User Scripts**.
2. Clone this repo and install dependencies:
   ```bash
   git clone https://github.com/HRussellZFAC023/voiceworks-toolkit.git
   cd voiceworks-toolkit/asmr-one-ultimate
   npm install
   ```
3. **Development** (HMR):
   ```bash
   npm run dev
   ```
   Open `http://localhost:5173/asmr-one-ultimate.user.js` and install the script. Keep the dev server running while browsing `https://asmr.one/`.

4. **Production build**:
   ```bash
   npm run build
   ```
   Open `dist/asmr-one-ultimate.user.js` in your browser to install via Tampermonkey.

## Testing

```bash
npm test                # Vitest unit tests (240 tests across 31 suites)
npm run test:e2e        # Playwright E2E (headless Chromium)
npm run test:e2e:headed # E2E with visible browser
npm run test:e2e:ui     # Playwright UI mode
npm run test:e2e:debug  # Step-through debugging
```

Tests run in a headless Chromium browser with automatic userscript injection — no manual browser setup or Tampermonkey installation needed. GM_* APIs are stubbed using localStorage.

## Architecture

**Userscript injection** — hooks into the host site's Vue 2.6 + Quasar framework via a `KikoeruBridge` singleton that exposes the app's Vuex store, Vue Router, and Axios HTTP client. Features mount as isolated modules that register with a central lifecycle.

```
src/
├── features/          Feature modules (30+ independent features)
│   ├── components/    Vue 3 SFCs mounted via FeatureController
│   ├── radio/         Radio Mode subsystem
│   ├── playlist/      Playlist Mode subsystem
│   ├── media/         Media Viewer subsystem
│   └── settings/      Settings panel and controls
├── services/          TranslationService, WorkService, DLsiteService
├── infrastructure/    KikoeruBridge, AudioCache, HttpClient, StorageManager
├── core/              Config, Utils, Cache, EventBus, Logger, CentralObserver
├── store/             AppStore (reactive state), ConfigStore
├── api/               REST API clients (Auth, Work, Playlist, History, etc.)
├── ui/                Shared UI components and helpers
├── composables/       Vue 3 composables (reusable reactive logic)
├── scrapers/          DLsite and external site scrapers
├── styles/            CSS with variables, component styles, layout fixes
└── types/             TypeScript type definitions
```

### Key Technical Patterns

- **CentralObserver** — Single MutationObserver on `document.body`; features register callbacks for efficient DOM watching instead of each creating their own observer
- **Web Workers** — Translation models and Whisper transcription run off the main thread to keep the UI responsive during inference
- **GPU Scheduler** — Per-worker priority queues with serialized model-load leases, keyed cancellable tasks, and per-worker circuit breakers to prevent GPU queue flooding
- **WebGPU Policy** — Translation and Whisper run in WebGPU-first mode; translation falls back to remote inference when local GPU is unavailable, while embedding can use WASM fallback when enabled by device tier
- **WebGPU Stability Guards** — Worker/device-lost signaling, stale-batch cancellation on route/path churn, and chunked translation streaming to keep UI latency low during heavy scroll/update bursts
- **Worker Coalescing** — Translation requests are batched in an 8ms window; single-text requests are prioritized over batch arrays to minimize latency for interactive use
- **IndexedDB** — Vector embeddings, audio cache, and transcript storage using the `idb` wrapper library
- **GM Storage** — Tampermonkey's `GM_getValue`/`GM_setValue` for user preferences and feature state that persists across site updates
- **FeatureController** — Base class pattern for Vue SFC mounting with injection point detection and lifecycle management
- **EventBus** — Typed publish/subscribe system for cross-feature communication (track changes, transcription events, translation ready signals)

### Technology Stack

| Category | Technology |
|----------|-----------|
| Build | Vite + [vite-plugin-monkey](https://github.com/nicennnnnnnlee/tampermonkey-vite) |
| Language | TypeScript |
| UI Components | Vue 3 SFCs (mounted into Vue 2 host) |
| ML Inference | [Transformers.js](https://huggingface.co/docs/transformers.js) (Whisper, opus-mt) |
| GPU Acceleration | WebGPU API with WASM fallback |
| Vector Search | Jina Embeddings v3 API + IndexedDB |
| Audio Analysis | Web Audio API (AnalyserNode) |
| Testing | Vitest (unit) + Playwright (E2E) |
| Fuzzy Search | Fuse.js |

## License

MIT
