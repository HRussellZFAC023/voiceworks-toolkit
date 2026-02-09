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

Not refactored yet (legacy imperative DOM-heavy paths still present):

- `src/features/CommentSection.ts`
- `src/features/AdvancedSearch.ts`
- `src/features/FlatView.ts`
- `src/features/JoiTool.ts`

Rule: refactor one feature at a time behind existing toggles, preserve host-app behavior, and add regression tests before moving to the next feature.

## 9) Testing Expectations

Minimum validation for non-trivial changes:

```bash
npx tsc --noEmit
npm run test:run
```

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
