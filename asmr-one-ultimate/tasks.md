# ASMR.one Ultimate - Stabilization Epic

**Epic ID**: STAB-001
**Priority**: Critical
**Goal**: Stabilize the userscript, fix regressions, and systematize the codebase

---

## Mandatory Workflow Rules

> **CRITICAL**: These rules MUST be followed for every task.

### Rule 1: E2E Test After Each Task
After completing ANY task:
1. Run `npm run test:e2e`
2. Visually inspect the screenshots in `playwright-report/`
3. Check browser console for errors
4. Verify no regressions in existing functionality

### Rule 2: Commit After Each Task
After completing ANY task and passing E2E:
1. Stage only related files (`git add <specific-files>`)
2. Write descriptive commit message following convention
3. Run `git commit` (pre-commit hooks will run tests)
4. Verify commit succeeded

### Rule 3: Update Documentation
If you discover unexpected behavior or fix a non-obvious bug:
1. Update CLAUDE.md changelog section
2. Add notes to this tasks.md if relevant

---

## Phase Overview

| Phase | Focus | Scope | Dependencies |

|-------|-------|-------|--------------|
| **Phase 1** | Critical Fixes | Singleplayer core functionality | None |
| **Phase 2** | UI/UX Systematization | CSS, layout, accessibility | Phase 1 |
| **Phase 3** | Feature Completion | Missing features, polish | Phase 2 |
| **Phase 4** | Multiplayer/External | External services, sharing | Phase 3 |

---

## Phase 1: Critical Fixes (Singleplayer)

### STAB-101: Re-enable Features in main.ts

**Status**: PARTIALLY DONE - CentralObserver migration complete, just need to uncomment in main.ts

**Problem**: Features are commented out in `main.ts` for debugging. The CentralObserver migration is already complete for: AdvancedSearch, EnglishTags, WorkMetadata, Whisper, VectorSearch, FlatView, PlayerTranslator.

**Steps**:
1. ~~Migrate each to use `CentralObserver.register()`~~ DONE
2. Uncomment features in main.ts one by one, testing after each
3. Verify no performance regression

**Remaining Work**:
- Uncomment `FlatView` in `initializeQOLFeatures()`
- Uncomment `AdvancedSearch` in `initializeQOLFeatures()`
- Uncomment `WorkMetadata` in `initializeQOLFeatures()`
- Uncomment `PlayerTranslator` in `initializeQOLFeatures()`
- Uncomment `EnglishTags` in `initializeQOLFeatures()`
- Uncomment `VectorSearch` in `initializeAIFeatures()`
- Uncomment `Whisper` in `initializeAIFeatures()`
- Uncomment `FaviconNowPlaying`, `MediaSessionManager`, `MenuIconFixer`

**Acceptance Criteria**:
- [ ] All features enabled in `main.ts`
- [ ] No console errors on page load
- [ ] SPA navigation doesn't duplicate injections

**Test Plan**:
- E2E: Navigate between pages, verify no crashes
- Visual: Screenshot comparison before/after

---

### STAB-102: Fix Whisper Loading Banner Stuck at 100%

**Problem**: Loading banner shows "Loading model: decoder_model_merged.onnx (100%)" but never transitions to "Transcribing..." or clears.

**Steps**:
1. Trace `whisper:progress` event flow from Whisper.ts to LearnerMode.ts
2. Identify where state transition from `loading` to `transcribing` fails
3. Ensure `handleWhisperProgress` updates `whisperStatus` correctly
4. Add explicit clear of loading state when transcription begins

**Expected vs Actual**:
- Expected: Banner shows "Loading..." -> "Transcribing..." -> text appears -> banner clears
- Actual: Banner stuck at "Loading model... (100%)"

**Scope**: `Whisper.ts:handleWorkerMessage`, `LearnerMode.ts:handleWhisperProgress`

**Acceptance Criteria**:
- [ ] Banner transitions through all states
- [ ] Banner disappears when transcription completes
- [ ] No duplicate banners on re-transcription

**Test Plan**:
- Manual: Click whisper button, observe banner lifecycle
- Unit: Mock worker messages, verify state transitions
- E2E: Screenshot at each state

---

### STAB-103: Fix Subtitle/Transcribe Conflict

**Problem**: Enabling both subtitles (VTT) and Whisper transcription causes race conditions - subtitles flash, override each other, or show "..."

**Steps**:
1. Review `LearnerMode.updateLyrics()` priority logic
2. Ensure `whisperOverrideSubs` config respected
3. When Whisper active, suppress VTT display
4. Clear "..." placeholder when no subtitles available

**Expected vs Actual**:
- Expected: Whisper OR VTT, not both simultaneously
- Actual: Conflicting displays, "..." shown when empty

**Scope**: `LearnerMode.ts:updateLyrics`, `LearnerMode.ts:updateVisibility`

**Acceptance Criteria**:
- [ ] Only one subtitle source displayed at a time
- [ ] No "..." when no subtitles available
- [ ] Config toggle works correctly

**Test Plan**:
- Manual: Enable both, verify one wins
- Unit: Test `updateLyrics` with various combinations
- Console: No errors during subtitle switching

---

### STAB-104: Fix Whisper Streaming Not Working

**Problem**: Whisper downloads full audio instead of streaming. For long files, this causes timeouts and memory issues.

**Steps**:
1. Investigate HLS handling in `resolveAudioSource`
2. Research chunked audio processing with transformers.js
3. If streaming not feasible, implement chunk-at-a-time processing
4. Add settings option to choose Whisper model

**Expected vs Actual**:
- Expected: Whisper processes audio in chunks, real-time display
- Actual: Full download, long delay, potential failure

**Scope**: `Whisper.ts`, `WhisperWorker.ts`

**Acceptance Criteria**:
- [ ] Audio processing starts within 5 seconds
- [ ] Partial results appear during transcription
- [ ] Settings page has model selector

**Test Plan**:
- Manual: Test with 1hr audio file
- E2E: Verify partial results appear before completion
- Console: No memory warnings

---

### STAB-105: Fix Playlist Mode Sequencing

**Problem**: After the last track in a work, playlist doesn't advance to next work correctly. System loses track of playlist state.

**Steps**:
1. Review `AdvancedSearch.setupPlaylistEndMonitor`
2. Check `AudioPlayer` state after last track
3. Fix queue index tracking
4. Ensure Radio Mode handoff works

**Expected vs Actual**:
- Expected: Playlist advances through all works
- Actual: Stops after first work's tracks

**Scope**: `AdvancedSearch.ts:setupPlaylistEndMonitor`, `RadioMode.ts`

**Acceptance Criteria**:
- [ ] Playlist plays all tracks across all works
- [ ] Status indicator shows playlist progress
- [ ] Handoff to Radio Mode works when playlist ends

**Test Plan**:
- Manual: Create 3-work playlist, verify all play
- E2E: Automate playlist creation and verification

---

### STAB-106: Fix Advanced Search "No Tracks Found"

**Problem**: Advanced Search always returns "No tracks found matching criteria. Try adjusting filters."

**Steps**:
1. Debug `fetchTracks` API call
2. Check tag ID mapping
3. Verify API endpoint response parsing
4. Test with no filters (should return results)

**Expected vs Actual**:
- Expected: Search returns matching works
- Actual: Always "No tracks found"

**Scope**: `AdvancedSearch.ts:fetchTracks`, `AdvancedSearch.ts:flattenWork`

**Acceptance Criteria**:
- [ ] Search with no filters returns works
- [ ] Tag filtering works
- [ ] Duration filtering works
- [ ] CV filtering works

**Test Plan**:
- Manual: Test each filter type
- Unit: Mock API responses, verify parsing
- Console: Log API responses for debugging

---

### STAB-107: Fix Settings Manager DOM Injection

**Problem**: Settings page doesn't show custom sections (API key input, toggles). 3 test failures indicate injection broken.

**Steps**:
1. Review `SettingsManager` injection logic
2. Check if MutationObserver triggers on `/settings` route
3. Verify DOM selectors match actual page structure
4. Test toggle event binding

**Expected vs Actual**:
- Expected: Custom settings sections visible and functional
- Actual: Settings page shows default only

**Scope**: `SettingsManager.ts`

**Acceptance Criteria**:
- [ ] API key input visible and saveable
- [ ] Radio Mode toggles work
- [ ] Whisper model selector works
- [ ] All 3 failing tests pass

**Test Plan**:
- E2E: Navigate to /settings, verify custom sections
- Unit: Fix failing tests
- Screenshot: Settings page with custom sections

---

### STAB-108: Fix Bottom Bar Icon Alignment

**Problem**: Icons in bottom player bar are not centered, can wrap on mobile, and aren't aligned on desktop.

**Steps**:
1. Review flex layout in `fixes.css`
2. Add `!important` overrides where host styles win
3. Test across breakpoints (320px, 600px, 768px, 1200px)
4. Fix learner-collapsed-controls centering

**Expected vs Actual**:
- Expected: Icons always centered, never wrap
- Actual: Misaligned, can wrap

**Scope**: `fixes.css`, `ui.css`, `_learner.css`

**Acceptance Criteria**:
- [ ] Icons centered on all screen sizes
- [ ] No wrapping on 320px screens
- [ ] Consistent spacing between icons

**Test Plan**:
- Visual regression: Screenshots at each breakpoint
- E2E: Check element positions

---

### STAB-109: Fix Icon Injection on Refresh

**Problem**: On full page refresh, icons sometimes don't inject. MutationObserver timing race with SPA hydration.

**Steps**:
1. Add readiness check before injection
2. Wait for `#q-app.__vue__` before registering observers
3. Add fallback polling for first 5 seconds
4. Ensure CentralObserver starts after Vue hydration

**Expected vs Actual**:
- Expected: Icons always appear after refresh
- Actual: Sometimes missing until navigation

**Scope**: `main.ts`, `CentralObserver.ts`, `KikoeruBridge.ts`

**Acceptance Criteria**:
- [ ] Icons appear within 2 seconds of page load
- [ ] Consistent across 10 refreshes
- [ ] No console errors

**Test Plan**:
- E2E: Refresh page 20x, verify icons appear
- Manual: Hard refresh with cache disabled

---

### STAB-110: Fix Dynamic Favicon

**Problem**: Dynamic favicon feature doesn't work - site shows no favicon.

**Steps**:
1. Check if `FaviconNowPlaying` is enabled (currently disabled)
2. Review favicon canvas drawing logic
3. Test with various track metadata
4. Ensure fallback favicon exists

**Expected vs Actual**:
- Expected: Favicon shows current work cover/title
- Actual: No favicon

**Scope**: `FaviconNowPlaying.ts`

**Acceptance Criteria**:
- [ ] Favicon updates when track changes
- [ ] Fallback favicon when no track
- [ ] No console errors

**Test Plan**:
- Manual: Play track, check browser tab
- E2E: Verify favicon element changes

---

## Phase 2: UI/UX Systematization

### STAB-201: Consolidate CSS and Create Guidelines

**Problem**: Duplicate rules across CSS files, inline styles in JS, inconsistent patterns.

**Steps**:
1. Audit all CSS files for duplicates
2. Merge `fixes.css` rules into component files
3. Remove inline styles from TS files
4. Create CSS guidelines document in CLAUDE.md

**Scope**: All CSS files

**Acceptance Criteria**:
- [ ] No duplicate rules
- [ ] No inline styles in TS (except dynamic values)
- [ ] Guidelines documented

---

### STAB-202: Fix Advanced Search Tag UI Issues

**Problem**: Include/Exclude tags behave incorrectly - same tags on both sides, state mirroring, confusing UX.

**Steps**:
1. Fix tag list not populating completely
2. Ensure include/exclude are mutually exclusive
3. Fix chip styling (alignment, padding, close icon)
4. Separate "Search" and "Play All" into distinct actions

**Scope**: `AdvancedSearch.ts`, `_playlist.css`

**Acceptance Criteria**:
- [ ] Tag list shows all available tags
- [ ] Can't add same tag to both include and exclude
- [ ] Chips styled consistently
- [ ] Clear distinction between Search and Generate

---

### STAB-203: Fix Button Hover States

**Status**: MOSTLY DONE - P15 section in fixes.css addresses most hover states

**Already Implemented** (fixes.css P15):
- [x] Learner control buttons hover
- [x] Whisper button hover (`rgba(124, 77, 255, 0.1)`)
- [x] Playlist button hover
- [x] Sidebar menu item hover (Radio/Playlist icons)
- [x] Clear cache button hover
- [x] Generate button hover
- [x] Duration preset buttons hover
- [x] Semantic search button dark mode color (P1-11)

**Remaining Issues** (per user report):
- [ ] Verify no "white on hover" regression in playlist builder dialog
- [ ] Test all hover states in dark mode specifically

**Scope**: `fixes.css`, `ui.css`

**Acceptance Criteria**:
- [x] Core buttons use accent color on hover
- [ ] Visual verification in dark mode
- [ ] No white hover backgrounds

---

### STAB-204: Fix Learner Mode Psychology Icon State

**Problem**: Psychology icon doesn't show purple accent when toggled on.

**Steps**:
1. Review `updateStyle()` in LearnerMode.ts
2. Ensure `learner-btn-active` class applied
3. Verify CSS specificity

**Scope**: `LearnerMode.ts`, `_learner.css`

**Acceptance Criteria**:
- [ ] Icon turns purple when active
- [ ] Consistent across expanded/collapsed views

---

### STAB-205: WCAG Accessibility Audit

**Status**: MOSTLY DONE - Core a11y features implemented in fixes.css

**Already Implemented** (in fixes.css P18 section):
- [x] Focus outlines for keyboard navigation (`:focus` rules)
- [x] Focus-visible only for keyboard users (`:focus:not(:focus-visible)`)
- [x] 44x44px touch targets on mobile (`min-width: 44px !important`)
- [x] High contrast mode support (`@media (prefers-contrast: high)`)
- [x] Reduced motion support (`@media (prefers-reduced-motion: reduce)`)

**Remaining**:
- [ ] Contrast audit (verify 4.5:1 on all text)
- [ ] Keyboard navigation test for all injected controls
- [ ] Screen reader testing

**Scope**: All CSS files, all button/control code

**Acceptance Criteria**:
- [x] Focus visible on all buttons
- [ ] Contrast passes WCAG AA (needs audit)
- [x] Touch targets >= 44px
- [ ] Tab navigation fully tested

---

### STAB-206: Add Flattener Toggle Button

**Problem**: Flattener feature missing - should show all folders with a toggle before Feedback button.

**Steps**:
1. Re-enable FlatView feature
2. Position toggle before Feedback button
3. Make toggle persistent (Config storage)
4. Style "ghost" files appropriately

**Scope**: `FlatView.ts`, `fixes.css`

**Acceptance Criteria**:
- [ ] Toggle appears before Feedback button
- [ ] State persists across sessions
- [ ] Temp files styled as "ghostly"

---

## Phase 3: Feature Completion

### STAB-301: Implement Auto Status Updates

**Problem**: No automatic status population when entering work pages.

**Steps**:
1. Define status criteria (listened, listening, marked, postponed, replay)
2. Implement detection logic
3. POST to Kikoeru API
4. Ensure only one bucket per work

**Scope**: New feature, `AutoProgress.ts` enhancement

**Acceptance Criteria**:
- [ ] Work auto-added to correct status
- [ ] Only one status per work
- [ ] API calls successful

---

### STAB-302: Implement Whisper Model Selection in Settings

**Problem**: Users can't choose Whisper model or trigger download.

**Steps**:
1. Add model dropdown to Settings
2. Show download button with progress
3. Cache model in IndexedDB
4. Handle quota exceeded gracefully

**Scope**: `SettingsManager.ts`, `Whisper.ts`

**Acceptance Criteria**:
- [ ] Model dropdown in settings
- [ ] Download progress visible
- [ ] Model cached between sessions

---

### STAB-303: Implement Storage Quota Handling

**Problem**: No handling when IndexedDB quota exceeded - potential soft-brick.

**Steps**:
1. Add quota detection to AudioCache, VectorSearch
2. Implement LRU eviction strategy
3. Show non-blocking notification
4. Add "Clear Cache" button to settings

**Scope**: `AudioCache.ts`, `VectorSearch.ts`, `SettingsManager.ts`

**Acceptance Criteria**:
- [ ] Quota exceeded handled gracefully
- [ ] LRU eviction works
- [ ] Clear cache button works
- [ ] User notified when cache cleared

---

### STAB-304: Enhance Rating Row with Links

**Problem**: Rating row should include HVDB link, comment count (clickable), better metadata display.

**Steps**:
1. Inject enhanced row after existing rating row
2. Add HVDB link
3. Make comment count clickable (scroll to comments)
4. Style consistently

**Scope**: `WorkMetadata.ts`

**Acceptance Criteria**:
- [ ] HVDB link visible
- [ ] Comment count clickable
- [ ] Styling matches existing UI

---

## Phase 4: Multiplayer/External (Final)

### STAB-401: Implement Comments Display

**Problem**: Comment count shows but comments not visible.

**Steps**:
1. Fetch comments from Kikoeru API
2. Display under work tree
3. Mark external comments
4. Add translation option

**Scope**: New feature or `WorkMetadata.ts` enhancement

**Acceptance Criteria**:
- [ ] Comments visible under work tree
- [ ] External comments marked
- [ ] Translation toggle works

---

### STAB-402: Evaluate Shared Cache Bucket

**Problem**: Want to share cached subtitles/transcripts without abuse.

**Steps**:
1. Research free-tier storage options (Firebase, S3, etc.)
2. Design abuse prevention (rate limits, anonymous limits)
3. Implement CLI setup guide
4. Make configuration minimal

**Scope**: New infrastructure

**Acceptance Criteria**:
- [ ] Storage provider selected
- [ ] Abuse prevention designed
- [ ] CLI setup documented
- [ ] Stays within free tier

---

### STAB-403: Browse Other Playlists

**Problem**: Want to discover and browse other users' playlists.

**Steps**:
1. Design playlist discovery UI
2. Implement playlist fetch by URL
3. Add "Import Playlist" feature

**Scope**: New feature

**Acceptance Criteria**:
- [ ] Can paste playlist URL
- [ ] Playlist loads and displays
- [ ] Can play imported playlist

---

## Test Suite Hardening

### STAB-501: Fix 8 Failing Unit Tests

**Problem**: 8 tests failing (138/146 passing = 94.5%), blocking CI confidence.

**Current Failures** (verified via test run):
1. SettingsManager: API key input not found in DOM
2. SettingsManager: Toggle event binding failing
3. SettingsManager: Toggle state sync returns null
4. FolderDiver: playMode config returns undefined (toLowerCase on undefined)
5. Shuffle: playMode commit not called
6. TagFilters: router.push not called for multi-tag filter
7. KikoeruBridge: Timeout waiting for #q-app (JSDOM limitation)
8. RadioMode: Expected test (details TBD)

**Steps**:
1. Fix SettingsManager - likely JSDOM DOM injection issue, may need test refactor
2. Fix FolderDiver - add null check for playMode config
3. Fix Shuffle - ensure commit is called or use Config.set
4. Fix TagFilters - check event delegation in tests
5. Mark KikoeruBridge test as `.skip` with comment (JSDOM can't simulate Vue)

**Scope**: All failing test files

**Acceptance Criteria**:
- [ ] 145+ tests pass
- [ ] Only KikoeruBridge skipped (JSDOM limitation documented)

---

### STAB-502: Add E2E Smoke Tests

**Status**: PARTIALLY DONE - 6 tests exist in `work-page-crash.spec.ts`

**Existing Tests**:
- [x] Work page stability (stays alive with userscript)
- [x] Navigation stability (home -> work -> settings -> home)
- [x] Settings page renders without crash
- [x] Current track info retrieval
- [x] Sidebar menu injection check
- [x] Semantic search button exists

**Remaining**:
- [ ] Radio Mode toggle test (actual toggle functionality)
- [ ] Subtitle display test
- [ ] Add visual regression captures

**Scope**: `tests/e2e/`

**Acceptance Criteria**:
- [x] Work page stability tests
- [ ] Radio Mode functionality test
- [ ] Subtitle display test
- [ ] Tests run in CI

---

### STAB-503: Add Visual Regression Tests

**Problem**: CSS changes can cause undetected regressions.

**Steps**:
1. Add Playwright screenshot tests
2. Capture bottom bar at each breakpoint
3. Capture dialog open states
4. Set up comparison threshold

**Scope**: `tests/e2e/`

**Acceptance Criteria**:
- [ ] Screenshots captured at 320, 600, 1200px
- [ ] Diff threshold configured
- [ ] Baseline images committed

---

## Implementation Order
1. STAB-101 (CentralObserver migration) - unlocks all other work
2. STAB-107 (Settings injection) - needed for testing
3. STAB-109 (Icon injection) - core stability
4. STAB-501 (Fix failing tests) - CI confidence
5. STAB-102 (Whisper banner)
6. STAB-103 (Subtitle conflict)
7. STAB-104 (Whisper streaming)
8. STAB-106 (Advanced Search)
9. STAB-108 (Bottom bar alignment)
10. STAB-201 (CSS consolidation)
11. STAB-202 (Tag UI)
12. STAB-203 (Button hovers)
13. STAB-105 (Playlist sequencing)
14. STAB-206 (Flattener)
15. STAB-204-205 (A11y)
16. STAB-502-503 (E2E tests)
17. STAB-301-304 (Phase 3 features)
18. STAB-401-403 (Phase 4 external)

---

## Success Metrics

- [ ] All unit tests pass (currently 138/146 - need 145+)
- [x] E2E smoke tests exist (6 tests in work-page-crash.spec.ts)
- [ ] No console errors on page load (needs verification)
- [ ] All features enabled in production build (currently most disabled)
- [ ] Lighthouse Performance > 80
- [ ] WCAG AA compliance
- [ ] All features enabled in production build
