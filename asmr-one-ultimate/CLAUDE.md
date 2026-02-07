# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Vite dev server (port 5173, no HMR — manual page refresh required)
npm run build        # Build single-file userscript to dist/

npm test             # Vitest unit tests (watch mode)
npm run test:run     # Unit tests (single run)
npm test -- --run tests/features/RadioMode.test.ts  # Run single test file

npm run test:e2e          # Playwright E2E (headless, auto-starts dev server)
npm run test:e2e:headed   # E2E with visible browser
npm run test:e2e:ui       # Playwright UI mode
npm run test:e2e:debug    # Step-through debugging

npm run test:coverage     # Unit tests with v8 coverage
```

## Architecture

This is a **parasitic Tampermonkey userscript** that hooks into asmr.one's Vue 2.6 + Quasar app. It runs at `document-idle` and injects features by discovering the host app's internals.

### Core Infrastructure

**KikoeruBridge** (`src/infrastructure/KikoeruBridge.ts`) — Singleton that discovers the host Vue instance via `__vue__` on `#q-app` and exposes `bridge.store` (Vuex), `bridge.router`, `bridge.axios`. All host interactions go through the bridge.

**CentralObserver** (`src/core/CentralObserver.ts`) — Single MutationObserver on `document.body`. Features register debounced callbacks instead of creating their own observers. Uses `beginModification()/endModification()` guards to prevent infinite loops when callbacks modify the DOM.

**EventBus** (`src/core/EventBus.ts`) — Type-safe pub/sub (`on`, `once`, `waitFor`, `emit`) for cross-feature communication. Events: `track:change`, `work:change`, `cache:added`, etc. Persisted on `unsafeWindow` to survive script re-injection.

**AppStore** (`src/store/AppStore.ts`) — Centralized state: plugin config (persisted via GM storage), runtime app state, and host Vuex access. Vue 3 reactivity. Config has 100+ settings.

**Disposable** (`src/core/Disposable.ts`) — Base class for resource cleanup. Provides `addDomListener()`, `addBusListener()`, `addInterval()`, `addTimeout()`, `onCleanup()` — all auto-released on `dispose()`.

### Feature Patterns

Features follow two patterns:

1. **FeatureController** (`src/features/FeatureController.ts`) — For Vue 3 SFC-based features. Subclasses define `component`, `findInjectionPoint()`, `shouldBeActive()`, `insertMode`. Base handles CentralObserver registration, route watching, and mount/unmount lifecycle.

2. **Standalone classes** — For non-Vue features (RadioMode, LearnerMode, Whisper). These have `enable()/disable()` methods, register with CentralObserver directly, and extend Disposable for cleanup.

Features are organized in `src/features/`, some with subdirectories (`radio/`, `playlist/`, `settings/`, `media/`).

### Initialization Order (src/main.ts)

1. Import all CSS (13 stylesheets)
2. Duplicate init guard (`__ASMR_ULTIMATE_INITIALIZED__`)
3. Wait for KikoeruBridge (host Vue discovery)
4. Start CentralObserver + reactive config
5. Enable features in order: Radio → Playlist → Learner → Settings → Sidebar → QOL features → AI features → Infrastructure
6. Warm up translation models (fire-and-forget)
7. Setup audio recovery handlers
8. Expose `window.ASMRUlt` global API

### Translation System

Two Opus-MT models (`ja→en`, `zh→en`) run in separate Web Workers via `@huggingface/transformers`. Greedy decoding, 16-item batch chunks, 8ms coalescing window, in-flight dedup. WebGPU preferred with WASM fallback. Config in `src/services/TranslationService.ts`.

### Storage

- **GM storage** (`GM_getValue`/`GM_setValue`): User preferences, config
- **IndexedDB**: Vector embeddings (`asmr-one-vectors`), audio cache (`asmr-one-audio-cache`), tag translations, transcripts
- **SharedCache** (`src/core/Cache.ts`): Unified cache layer with TTL, wrapping both backends

### CSS

Styles live in `src/styles/` with component-specific CSS in `src/styles/components/_*.css`. Theme uses CSS custom properties (`--asmr-*`) with dark mode via `.body--dark`/`.q-dark` selectors. All injected elements use `asmr-*` class prefixes to avoid host conflicts.

## Testing

**Unit tests** (Vitest + jsdom): Located in `tests/` mirroring `src/` structure. Setup (`tests/setup.ts`) mocks GM_* APIs via localStorage, uses `fake-indexeddb`, and resets KikoeruBridge before each test.

**E2E tests** (Playwright, Chromium only): Located in `tests/e2e/`. Auto-injects userscript via `context.addInitScript()` with stubbed GM_* APIs. Mocks API responses from `tests/e2e/mock-data/`. Workers=1 (sequential). WebGPU enabled for Whisper tests. Dev server auto-starts if needed.

## Localization Rules

All user-facing strings must use `I18n.t('key')` or `I18n.format('key', { param })`. Both `en` and `zh` translations are required in `src/core/Config.ts` (`i18nData` object). DOM detection must be language-independent — use icons, CSS classes, or structural position, never text matching.

## Build Output

Single unminified userscript in `dist/` (~1.8MB). Bundled with `vite-plugin-monkey`. External imports via SystemJS/CDN. No source maps (unsupported by Tampermonkey). For dev, install the dev server URL once in Tampermonkey, then keep `npm run dev` running.

## Pre-push Hook

`.husky/pre-push` runs `npm test` before allowing push.
