# Plan: AutoProgress Fixes + Continue Listening Feature

## Part 1: AutoProgress Bug Fixes (5 bugs)

### Bug 1 — CRITICAL: API query params (src/api/Review.ts)

**Problem:** `updateReview()` sends `progressOnly`/`starOnly` in the request body, but kikoeru-express reads them from `req.query` (lines 60-64 of `routes/review.js`).

**Fix:** In the PUT strategy, extract `starOnly`/`progressOnly` from the payload and pass as Axios `params` config (3rd arg). Keep them in the body too for POST fallbacks.

```ts
// Before:
async () => getAxios().put('/api/review', payload),

// After:
async () => getAxios().put('/api/review', payload, {
    params: { starOnly: payload.starOnly ?? undefined, progressOnly: payload.progressOnly ?? undefined },
}),
```

**Test update:** `Review.test.ts` — verify PUT call includes `{ params: {...} }` as 3rd argument.

---

### Bug 2 — Partial-listen detection for multi-track works (AutoProgress.ts)

**Problem:** `currentListeningMaxProgress` tracks currentTime/duration of the *current track*. If track 1 finishes (progress → 1.0), user navigates away during track 2, maxProgress stays at 1.0, so "postponed" never fires.

**Fix:**
- Add `playedTracksInWork: Map<string, Set<string>>` — tracks played >50% per workId
- Add `currentTrackStarted: boolean` — whether current track has >5s playback (to distinguish "actually started" from "just browsed")
- In `checkAndMark()`: when a track reaches >50%, add its key to the Set for the current work
- In `checkPartialListen()` (on work change): compute `workProgress = playedTracks.size / totalTracksCount`. Mark postponed if `workProgress < 0.30` AND at least one track started (>5s playback)
- Remove `currentListeningMaxProgress` field entirely

---

### Bug 3 — Dedup fragility (AutoProgress.ts)

**Problem:** `lastUpdatedKey` is a single string — only remembers the last work+status.

**Fix:** Replace with `sentUpdates = new Set<string>()`. Add key on successful send. Remove on API failure (to allow retry). Clear on `disable()`.

---

### Bug 4 — Optimistic rollback (AutoProgress.ts)

**Problem:** `marks[workId]` is set optimistically but never reverted on API failure.

**Fix:** Capture `previousStatus` before optimistic update. In `.catch()`, restore it.

---

### Bug 5 — i18n descriptions (Config.ts)

Update all autoProgress strings in en (~line 54), zh (~line 567), ja (~line 1080) per the spec.

---

## Part 2: Continue Listening Feature

### New files:
1. `src/features/ContinueListeningController.ts` — FeatureController subclass
2. `src/features/components/ContinueListeningPanel.vue` — Vue 3 SFC

### Architecture:
- Controller injects on homepage (`route.path === '/'` or `/home`)
- Injection point: after the last `.q-pt-lg.q-px-md` section (below "Recommended works")
- Uses `insertMode: 'after'`
- Vue SFC fetches works via `ReviewApi.getReviews({ filter: 'listening', page: 1 })` on mount
- Displays horizontal scrolling card list matching the existing "Popular works" swiper style
- Each card: cover image, title (truncated), click → navigate to `/work/RJ{id}`
- Empty state: hidden (no section shown if no "listening" works)
- Refreshes when `progress:update` event fires (from AutoProgress)

### Config:
- Add `enableContinueListening: boolean` to PluginConfig type (store.ts)
- Default: `true` (in CONFIG_DEFAULTS in AppStore.ts)
- Add setting toggle in SettingsPanel.vue under Feature Toggles section

### i18n keys (Config.ts):
- `continueListening` / `continueListeningSub` — setting label/description
- `continueListeningTitle` — section header ("Continue Listening")

### Registration in main.ts:
```ts
if (Config.get('enableContinueListening')) {
    const continueListening = new ContinueListeningController();
    continueListening.enable();
}
```

---

## Implementation Order

1. Fix `Review.ts` query params (Bug 1) + update Review.test.ts
2. Fix AutoProgress.ts: dedup Set (Bug 3), optimistic rollback (Bug 4), partial-listen rewrite (Bug 2)
3. Update i18n strings in Config.ts (Bug 5)
4. Update AutoProgress.test.ts for new logic
5. Add Continue Listening feature (controller + SFC + config + i18n + main.ts registration)
6. Run `npm run test:run` to verify

## Files Modified
- `src/api/Review.ts`
- `src/features/AutoProgress.ts`
- `src/core/Config.ts`
- `src/types/store.ts`
- `src/store/AppStore.ts`
- `src/features/settings/SettingsPanel.vue`
- `src/main.ts`
- `tests/api/Review.test.ts`
- `tests/features/AutoProgress.test.ts`

## New Files
- `src/features/ContinueListeningController.ts`
- `src/features/components/ContinueListeningPanel.vue`
