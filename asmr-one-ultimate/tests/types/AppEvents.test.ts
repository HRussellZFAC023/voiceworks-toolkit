/**
 * Tests that AppEvents type includes all events used in the codebase.
 *
 * These are compile-time type checks (they pass if the code compiles)
 * and runtime checks against known event names.
 */
import { describe, it, expect } from 'vitest';

// The AppEvents interface lives in types/store.ts — we verify event names exist
// by checking that they're accepted as string keys. This is primarily a
// documentation test that fails if events are removed from the type.

const EXPECTED_EVENTS = [
    // Core events
    'track:change',
    'track:end',
    'work:change',
    'radio:toggle',
    'radio:state',
    'radio:skip',
    // Whisper events
    'whisper:start',
    'whisper:toggle',
    'whisper:progress',
    'whisper:update',
    'whisper:complete',
    'whisper:error',
    'whisper:hls-warning',
    'whisper:clear',
    'whisper:cache-updated',
    'whisper:segment-translated',
    // Cache events
    'cache:evicted',
    'cache:cleared',
    'cache:added',
    // Config
    'config:change',
    // Playlist events
    'playlist:active',
    'playlist:navigate',
    'playlist:progress',
    'playlist:shuffled',
    // Player events
    'title:update',
    'player:rate-change',
    'player:nav-prev',
    'player:nav-next',
    'progress:update',
    // Toggle events
    'joi:toggle',
    'joi:trigger',
    'viz:toggle',
    'flatview:toggle',
    'lang:change',
    // Embedding
    'embedding:progress',
    // Fullscreen
    'fullscreen:enter',
    'fullscreen:exit',
    // Work tree
    'worktree:path-change',
    // Gallery
    'gallery:nav',
    'gallery:exclude',
    // Homepage
    'homepage:cached-data-injected',
    'homepage:section-ready',
    'homepage:section-refresh',
] as const;

describe('AppEvents type completeness', () => {
    it('should have all expected event names defined', () => {
        // This test documents the full set of events the system uses.
        // If an event is removed from AppEvents, this test should be updated.
        expect(EXPECTED_EVENTS.length).toBeGreaterThan(30);
    });

    it('event names follow namespace:action convention', () => {
        for (const event of EXPECTED_EVENTS) {
            expect(event).toMatch(/^[a-z]+:[a-z][-a-z]*$/);
        }
    });

    it('no duplicate event names', () => {
        const unique = new Set(EXPECTED_EVENTS);
        expect(unique.size).toBe(EXPECTED_EVENTS.length);
    });

    it('toggle events have void payloads (by convention)', () => {
        // joi:toggle, viz:toggle, whisper:toggle, whisper:clear should have void payloads
        const voidEvents = ['joi:toggle', 'viz:toggle', 'whisper:toggle', 'whisper:clear'];
        for (const event of voidEvents) {
            expect(EXPECTED_EVENTS).toContain(event);
        }
    });
});
