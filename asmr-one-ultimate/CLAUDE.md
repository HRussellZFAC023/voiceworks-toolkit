# CLAUDE.md

Operational guide for coding agents working on `asmr-one-ultimate`.

## Quick Start

```bash
npm install
npm run dev
npm run build
npm run test:run
npx tsc --noEmit
```

Target output is `dist/asmr-one-ultimate.user.js`.

## Core Principles

- Treat this as a parasitic integration with a live Vue 2 + Quasar host app.
- Prefer host store/router APIs through `KikoeruBridge`; avoid direct fragile DOM coupling unless required.
- Keep features additive and reversible. If a feature is toggleable, it must support clean disable/cleanup.
- New user-facing strings must use `I18n.t`/`I18n.format` and be added for `en` and `zh` (and `ja` when practical).
- Prefer typed event contracts in `src/types/store.ts` over ad-hoc payload shapes.

## Architecture Map

- `src/main.ts`: startup orchestration and feature registration.
- `src/infrastructure/KikoeruBridge.ts`: host Vue/Router/Vuex/axios bridge.
- `src/store/AppStore.ts`: plugin runtime state + config + host store helpers.
- `src/core/EventBus.ts`: typed cross-feature communication.
- `src/core/CentralObserver.ts`: shared mutation observer.
- `src/features/*`: feature modules/controllers.
- `src/features/components/*` + `src/ui/components/*`: Vue 3 SFC UI.
- `src/services/*`: API and ML-related services.

## Feature Patterns

Use one of these:

1. `FeatureController` subclass (preferred for Vue UI features).
2. Standalone class with `enable()`/`disable()` and explicit cleanup.

For DOM-heavy features:

- Register with `CentralObserver` instead of creating many observers.
- Avoid inline handlers in injected HTML.
- Use event delegation for dynamic host content.

## Vue Migration Status

Migration to Vue-first UI is ongoing and must be incremental to avoid host integration regressions.

Recently refactored:

- `src/features/JoiTool.ts` now uses `src/features/components/JoiBar.vue` for bar rendering and i18n updates.
- `src/features/FolderDiver.ts` now delegates tree/path and folder DOM matching to `src/features/folderDiverTreeUtils.ts` and `src/features/folderDiverDomUtils.ts`.
- `src/features/LearnerMode.ts` and `src/features/components/LearnerSubtitles.vue` now share lyric-source/parsing logic via `src/features/learnerLyricsUtils.ts`.
- RJ-code extraction/normalization now lives in `src/features/rjCodeUtils.ts` and is shared by HVDB links, comment section helpers, and work metadata modules.
- `src/features/HVDBLinkController.ts` and `src/features/components/HVDBLink.vue` now share `resolveHvdbRjCode` (work + route fallback), and `findHvdbInjectionPoint` now prefers metadata-scoped DLsite rows before generic rating fallbacks to avoid mis-mounting from unrelated global DLsite links.
- Work-tree enhancement now delegates stale label repair and item-type synchronization to `src/features/workTreeTextSyncUtils.ts` and `src/features/workTreeItemTypeUtils.ts`, reducing fragile inline DOM mutation logic in the manager.
- `src/features/WorkTreeManager.ts` now resets internal route/navigation state during disable so re-enable on the same work route re-runs prefetch/auto-dive handshakes instead of being skipped by stale `currentWorkId` state.
- Transcript list-action injection now delegates item selection/track resolution/action replacement/cleanup to `src/features/transcriptInjectionUtils.ts`, coalesces refreshes on `lang:change` and `subtitleLang` config updates, and removes injected controls when the feature is disabled.
- `src/features/MediaViewer.ts` is now a thin compatibility adapter over `src/features/MediaViewerController.ts`, eliminating a large legacy imperative duplicate while keeping old imports functional.
- `src/features/media/mediaViewerDomUtils.ts` now centralizes delegated-click target filtering, media-type classification, and Vue item/hash extraction used by `MediaViewerController`.
- `src/features/media/mediaStreamUrlUtils.ts` now centralizes stream-URL construction/token appending and is shared by `MediaViewerController` and `components/MediaLightbox.vue`, including `/media/stream` path support and hash-fragment-safe token insertion.
- `src/features/media/mediaViewerWorkTreePatchUtils.ts` now centralizes WorkTree click-handler patch/restore logic; `MediaViewerController` now performs deterministic cleanup of WorkTree patches and folder-path watchers during disable/route cleanup to avoid stale hooks.
- `src/features/WorkTreeCopy.ts` now upserts existing copy buttons (update/remove/rebind), removes injected copy controls on disable, and uses shared helpers in `src/features/workTreeCopyUtils.ts`, eliminating stale copied-title metadata on reused rows and stale controls after feature toggles.
- `src/features/media/mediaViewerDomUtils.ts` now resolves candidate media types via title-first + explicit-type fallback, preventing over-inclusive DOM-scan matches while still supporting typed media rows lacking standard extensions.
- Infinite-scroll API URL construction is now centralized in `src/features/infiniteScrollApiUtils.ts` and shared by `src/features/components/InfiniteScrollGrid.vue` and `src/features/InfiniteScrollManager.ts`, fixing dropped `'0'` query filters and inconsistent array-query handling.

Features not refactored yet (still mostly imperative DOM code):

- `src/features/WorkTreeManager.ts` (DOM-driven folder navigation and control injection paths; route/path, label-sync, and item-type sync utilities are extracted, but rendering/enhancement flow is still imperative)
- `src/features/WorkTreeCopy.ts` (DOM-driven copy-button injection into host-rendered list rows; stale-state handling is improved, but rendering/injection remains imperative)
- `src/features/TranscriptFileInjector.ts` (DOM-driven transcript action injection into host-rendered list rows; item selection/track resolution/action replacement utilities are extracted, but UI rendering remains imperative)
- `src/features/MediaViewerController.ts` (helper extraction is progressing, but host integration still relies on imperative click interception, WorkTree patching, and thumbnail injection; modal rendering itself is Vue-driven)
- `src/features/HVDBLinkController.ts` (link UI is Vue-based and anchor lookup is improved, but injection-point resolution still depends on host DOM scanning and selector fallbacks)
- `src/features/components/InfiniteScrollGrid.vue` (feature is mounted via Vue controller, but host-grid discovery and fallback card rendering remain imperative DOM-heavy)

Expectation for migration work:

1. Pick one feature.
2. Keep existing behavior/toggles stable.
3. Move rendering/state to Vue components/controllers.
4. Add/update tests before touching the next feature.

## Testing Policy

Before finishing changes:

1. Run `npx tsc --noEmit`.
2. Run `npm run test:run`.
3. For UI/integration-sensitive changes, run at least one relevant Playwright spec.

Examples:

```bash
npm test -- --run tests/features/LearnerMode.test.ts
npm test -- --run tests/features/WorkTreeManager.test.ts
npm run test:e2e -- tests/e2e/work-tree.spec.ts
```

## High-Risk Areas

- Work tree/path sync (`WorkTreeManager`, `FolderDiver`, route query `path`).
- Player lifecycle and minimized/expanded transitions (`LearnerMode`, `Whisper`, `Visualizer`, `JoiTool`).
- Translation/model loading race conditions (`TranslationService`, `WhisperWorkerLoader`, `GpuScheduler`).
- Playlist discovery and pagination, where API shapes vary.

## Safe Change Checklist

- Are feature toggles honored at runtime (enable and disable)?
- Are all listeners/intervals/observers cleaned up?
- Are event payloads and shared interfaces updated together?
- Did you avoid hardcoded UI text?
- Did you verify both typecheck and tests?

## Common Commands

```bash
npm run dev
npm run build
npm run test:run
npm run test:coverage
npm run test:e2e
npx tsc --noEmit
```

## Do Not

- Do not match host sections by localized text.
- Do not mutate host internals when a store action/mutation exists.
- Do not add new polling loops if an event/watcher path exists.
- Do not bypass typed event/store contracts.
