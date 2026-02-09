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

Features not refactored yet (still mostly imperative DOM code):

- `src/features/CommentSection.ts`
- `src/features/AdvancedSearch.ts`
- `src/features/FlatView.ts`
- `src/features/JoiTool.ts`

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
