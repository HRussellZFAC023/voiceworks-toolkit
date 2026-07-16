# AGENTS.md

Operational playbook for agents contributing to `asmr-one-ultimate`.

## 1) Mission

Maintain a stable userscript that extends asmr.one without breaking host functionality.

Primary goals:

- Reliability across route changes and host re-renders.
- Fast, local-first AI features with graceful fallback.
- Clean enable/disable lifecycle for every feature.
- Strong typing and regression tests for core behaviors.

## 2) Repo Scope

This document applies only to `asmr-one-ultimate/`.

Key files:

- `src/main.ts`: bootstrap and feature registry.
- `src/types/store.ts`: shared contracts (store/router/events/payloads).
- `src/infrastructure/KikoeruBridge.ts`: host integration.
- `src/store/AppStore.ts`: plugin state/config.
- `src/core/*`: shared utilities/observer/event bus.
- `src/features/*`: all user-visible capabilities.
- `tests/*`: unit and integration tests.

## 3) Non-Negotiable Engineering Rules

- All user-facing text goes through `I18n` keys.
- Feature modules must support cleanup on disable.
- Prefer Vue components/controllers over raw DOM injection when feasible.
- Use host store actions/mutations before DOM simulation.
- Keep changes typed; avoid `any` unless boundary constraints require it.

## 4) Host Integration Constraints

The host app is Vue 2 + Quasar and may re-render aggressively.

Required practices:

- Use `KikoeruBridge` for store/router/axios access.
- Assume injected DOM can be destroyed at any time.
- Re-establish UI on route changes and observer callbacks.
- Avoid assumptions about static class names unless verified by tests.

## 5) Event & Type Contracts

`src/types/store.ts` is the source of truth for:

- EventBus payloads (`AppEvents`).
- Host store state shape (`AudioPlayerState`, etc.).
- Router and route query typing.

If payloads or route/query usage change, update:

1. Shared types.
2. Emitters/listeners.
3. Tests that assert payload shape.

## 6) Feature Development Pattern

For a new or refactored feature:

1. Add/extend typed interfaces first.
2. Implement feature as controller + Vue component when UI-heavy.
3. Register in `main.ts` through feature registry.
4. Ensure `enable()/disable()` is idempotent.
5. Add tests for behavior and regressions.

## 7) High-Risk Modules

Review carefully before editing:

- `WorkTreeManager`, `FolderDiver`: route/path and DOM-sync complexity.
- `LearnerMode`, `Whisper`: timing-sensitive subtitle/transcription pipeline.
- `GpuScheduler`, worker loaders: model lifecycle and GPU fallback.
- `PlaylistDiscovery`: variable API schemas and progressive loading logic.

## 8) Vue Migration Status

Vue-first migration is in progress and must remain incremental.

Recently refactored:

- `src/features/JoiTool.ts` now renders bar UI via `src/features/components/JoiBar.vue` with reactive state.
- `src/features/FolderDiver.ts` path/tree and DOM folder-matching logic now use extracted helpers in `src/features/folderDiverTreeUtils.ts` and `src/features/folderDiverDomUtils.ts` with dedicated tests.
- Learner subtitle source/parsing logic is centralized in `src/features/learnerLyricsUtils.ts` and shared by `src/features/LearnerMode.ts` and `src/features/components/LearnerSubtitles.vue`.
- RJ-code parsing/normalization is centralized in `src/features/rjCodeUtils.ts` and reused by HVDB links, comment section parsing, and work metadata modules to avoid divergent matching behavior.
- `src/features/HVDBLinkController.ts` and `src/features/components/HVDBLink.vue` now share `resolveHvdbRjCode` route/work fallback logic, and `findHvdbInjectionPoint` prefers metadata-scoped DLsite anchors (before generic rating fallbacks) to reduce mis-mounting from unrelated global DLsite links.
- Work-tree enhancement internals now use shared helpers: title-slot alignment in `src/features/workTreeTextSyncUtils.ts` and item-type synchronization in `src/features/workTreeItemTypeUtils.ts` (with regression tests for stale-label and stale-`data-item-type` cases).
- `src/features/WorkTreeManager.ts` now resets route/navigation runtime state on disable to avoid stale same-work suppression on re-enable; regression tests assert prefetch re-handshake after disable/enable cycles.
- Transcript action injection now uses shared helpers in `src/features/transcriptInjectionUtils.ts` (item selection, fatherFolder audio resolution, action-group replacement, and cleanup helpers), coalesces refreshes on `lang:change` / `subtitleLang` updates, and removes injected transcript controls when the feature is disabled.
- `src/features/MediaViewer.ts` is now a compatibility wrapper that delegates to `src/features/MediaViewerController.ts`, removing a large legacy imperative duplicate implementation while preserving old call sites.
- Media viewer DOM/media classification logic is extracted into `src/features/media/mediaViewerDomUtils.ts`; delegated-click filtering and media-type matching now have focused tests to reduce controller-level imperative branching.
- Media stream URL + token handling is centralized in `src/features/media/mediaStreamUrlUtils.ts` and shared by `MediaViewerController` and `components/MediaLightbox.vue`, including `/media/stream` support, token de-duplication, and fragment-safe query appending.
- Media viewer WorkTree patch lifecycle is now centralized in `src/features/media/mediaViewerWorkTreePatchUtils.ts`; `MediaViewerController` now restores patched `onClickItem` handlers and disposes folder-path watchers on disable/route cleanup to prevent stale hooks after feature toggles.
- Work-tree copy injection now performs upsert behavior (update/remove/rebind existing buttons), cleans up injected copy buttons on disable, and uses shared DOM helpers in `src/features/workTreeCopyUtils.ts`, preventing stale copy metadata on reused rows and stale controls when the feature is toggled off.
- Media viewer candidate-type resolution now uses title-first + explicit-type fallback in `src/features/media/mediaViewerDomUtils.ts`, fixing over-inclusive DOM-scan matching and preserving delegated-click behavior for typed media items without standard extensions.
- Infinite-scroll route/query API URL construction is now centralized in `src/features/infiniteScrollApiUtils.ts` and reused by `src/features/components/InfiniteScrollGrid.vue` and `src/features/InfiniteScrollController.ts`, fixing dropped `'0'` filter values and array-query normalization inconsistencies.
- Host queue replacement for Flat View and Media Viewer is centralized in `src/features/audioPlayerQueueUtils.ts`; it advances the track/index before replacing a queue and refreshes legacy compatibility state to avoid synchronous stale-index watcher crashes.
- Whisper fetches and workers are identity/generation guarded, and same-worker model initialization is deduplicated across warmup and transcription start so stale async completions cannot stop or dispose a replacement run.
- `src/core/RegionGateRecovery.ts` runs before bridge initialization on the exact English-language gate response, validates/fetches same-host bootstrap and Webpack lazy-route assets with Chinese-first privileged requests, and restores the SPA without changing the browser language or page origin.
- Bulk work downloads now use `DownloadCenterController` + the Vue `DownloadCenter`/`BackupWorkDownloader` panel in the shared header. `DownloadCenterRunner` owns checkpointed discovery, translation, folder recreation, optional Opus conversion, and resume state independently of the modal. Community playlist summaries come from the bounded server catalog; work lists remain lazy until expansion, selection, or download.
- Community playlist seeds live under `proxy-worker/data/`, outside the userscript bundle. `PlaylistDiscoveryService` consumes one validated, ETag-cached catalog and may submit only a playlist UUID; the Worker independently verifies that it is public before an atomic, rate-limited R2 write.

Not refactored yet (legacy imperative DOM-heavy paths still present):

- `src/features/WorkTreeManager.ts` (path sync + folder control injection still imperative; route/path, text-sync, and item-type sync helpers are extracted, but DOM orchestration and lifecycle hooks remain legacy)
- `src/features/WorkTreeCopy.ts` (button-state upsert and helper extraction are improved, but list-item injection and button rendering are still imperative DOM code)
- `src/features/TranscriptFileInjector.ts` (track resolution and action replacement helpers are extracted, but host-list rendering and DOM button construction remain imperative)
- `src/features/MediaViewerController.ts` (media-type/click helper extraction has progressed, but host integration still relies on imperative click interception, WorkTree patching, and thumbnail injection)
- `src/features/HVDBLinkController.ts` (link UI is Vue-based and injection lookup is improved, but mount-point discovery still depends on host DOM scanning and selector fallback heuristics)
- `src/features/components/InfiniteScrollGrid.vue` (core flow is Vue-driven, but host-grid detection and DOM fallback card injection still contain substantial imperative paths)

Rule: refactor one feature at a time behind existing toggles, preserve host-app behavior, and add regression tests before moving to the next feature.

## 9) Testing Expectations

Minimum validation for non-trivial changes:

```bash
npx tsc --noEmit
npm run test:run
```

Release builds also maintain a tracked repository-root `asmr-one-ultimate.user.js` mirror. `npm run build` must keep it byte-identical to `dist/asmr-one-ultimate.user.js`; the release webhook reads the root path from the published tag.

Also run targeted tests for touched areas, e.g.:

```bash
npm test -- --run tests/features/LearnerMode.test.ts
npm test -- --run tests/features/WorkTreeNavigation.test.ts
npm test -- --run tests/infrastructure/KikoeruBridge.test.ts
```

For route/UI integration changes, run at least one Playwright spec.

## 10) Performance Guidance

- Reuse `CentralObserver`; do not add duplicate observers per feature.
- Prefer deduped, cached API calls (`SharedCache`, service-level memoization).
- Keep polling sparse and bounded; cancel on disable.
- Avoid repeated heavy DOM queries in hot paths.

## 11) Documentation Maintenance

When behavior changes materially:

- Update `README.md` if user-facing behavior changed.
- Update this file for architectural/process changes.
- Keep docs concise and actionable; remove stale issue-history narratives.

## 12) Fast Triage Workflow

When debugging production issues:

1. Reproduce with minimal route/feature toggles.
2. Validate bridge/store readiness in console logs.
3. Confirm event payloads and state transitions.
4. Add a failing unit test if logic bug is deterministic.
5. Patch smallest layer that resolves root cause.
