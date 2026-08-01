/**
 * Whisper AI Transcription — E2E BDD Test Spec
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * USER RESEARCH SUMMARY (Simulated)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Persona: Japanese ASMR listener who doesn't speak Japanese fluently.
 * Context: Uses asmr.one to browse/play audio works. Wants AI subtitles to
 *          understand what the voice actor is saying.
 *
 * Pain Points Identified:
 *   1. "I clicked the AI transcribe button but nothing happened — no text appeared"
 *   2. "It said 'Loading model' forever with no indication of progress"
 *   3. "I can't tell if my GPU is being used or if it's falling back to CPU"
 *   4. "The transcription completed but I never saw any subtitles in the player"
 *   5. "There's no feedback during transcription — is it stuck or working?"
 *   6. "When I switch tracks, stale transcription text stays on screen"
 *   7. "I want to see the Japanese text AND an English translation side by side"
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * USER STORIES
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * FUNCTIONAL REQUIREMENTS:
 *
 * US-1: As a listener, I want to click "AI Transcribe" and see the model loading
 *        progress with file names and percentages so I know it's working.
 *
 * US-2: As a listener, I want to see real-time token count progress during
 *        transcription so I know it hasn't frozen.
 *
 * US-3: As a listener, I want transcription segments with timestamps to appear
 *        after the model finishes processing, so I can read along.
 *
 * US-4: As a listener, I want a VTT subtitle track injected into the audio
 *        element so the browser's native subtitle renderer can display them.
 *
 * US-5: As a listener, I want the LearnerMode subtitle panel to update with
 *        Whisper text so I see it in the same place as LRC subtitles.
 *
 * US-6: As a listener, I want the transcription button to show an active/loading
 *        state while working and return to normal when done.
 *
 * US-7: As a listener, when I switch tracks, I want old transcription state
 *        cleared so stale text doesn't linger.
 *
 * US-8: As a listener, if no audio is playing, I want a clear error message
 *        telling me to play a track first.
 *
 * NON-FUNCTIONAL REQUIREMENTS:
 *
 * NF-1: The status UI must update within 2 seconds of each model file download
 *        progress event (responsiveness).
 *
 * NF-2: Console logs must include structured diagnostic info (raw data keys,
 *        chunk count, sample text) for debugging failed transcriptions.
 *
 * NF-3: The worker must detect WebGPU availability and log the backend used
 *        (observability).
 *
 * NF-4: If segments are empty but raw text exists, a fallback single-segment
 *        must be created (robustness).
 *
 * NF-5: Hallucination patterns and stage directions must be filtered from
 *        output text (quality).
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { test as base, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createSilentWav } from './audioFixture';
import { ensureLoggedIn, GM_STUBS, helpers, loadUserscript } from './fixtures';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Test-local fixture: WAV file served, audio not blocked, extended timeouts
// ---------------------------------------------------------------------------

// Keep this custom fixture aligned with the shared E2E fixture: remote asmr.one
// documents are region/language gated from common CI and agent networks, so use
// the maintained relay by default and allow direct-network tests to opt out.
const VIA_PROXY = process.env.E2E_PROXY !== '0';
const E2E_PROXY_URL = (process.env.E2E_PROXY_URL
    || 'https://asmr-api-proxy.henry-robert-christopher-russell.workers.dev').replace(/\/$/, '');
const TEST_WAV_DATA = createSilentWav(16000, 2);

// Extended timeout for model download + transcription
const WHISPER_TIMEOUT = 5 * 60 * 1000; // 5 minutes

type WhisperFixtures = {
    whisperPage: Page;
    consoleLogs: string[];
    waitForWhisperLog: (pattern: RegExp, timeout?: number) => Promise<string>;
};

const test = base.extend<WhisperFixtures>({
    // Override context: DON'T block audio files, and serve our WAV fixture
    context: async ({ context }, use) => {
        const userscript = loadUserscript();

        await context.addInitScript({ content: GM_STUBS });
        await context.addInitScript({
            content: `
                localStorage.setItem('GM_enableLogging', 'true');
                localStorage.setItem('GM_enableVectorSearch', 'false');
                localStorage.setItem('GM_whisperAutoWarmup', 'false');
            `,
        });
        await context.addInitScript({
            content: `
                (function() {
                    if (window !== window.top) return;
                    const REQUIRE_URLS = ${JSON.stringify(userscript.requires)};
                    const REQUIRE_SOURCES = ${JSON.stringify(userscript.requireSources)};
                    const USERSCRIPT = ${JSON.stringify(userscript.code)};
                    async function init() {
                        if (!location.href.includes('asmr.one') && !location.href.includes('asmr-')) return;
                        if (window.__ASMR_ULTIMATE_INITIALIZED__) return;
                        console.log('[E2E] Starting script injection...');
                        for (let index = 0; index < REQUIRE_URLS.length; index++) {
                            const url = REQUIRE_URLS[index];
                            const localSource = REQUIRE_SOURCES[index];
                            if (typeof localSource === 'string') {
                                const script = document.createElement('script');
                                script.textContent = localSource;
                                document.head.appendChild(script);
                                continue;
                            }

                            await new Promise((resolve) => {
                                const script = document.createElement('script');
                                script.src = url;
                                const timer = setTimeout(() => {
                                    console.error('[E2E] Timed out loading @require dependency from ' + url);
                                    resolve();
                                }, 10000);
                                script.onload = () => { clearTimeout(timer); resolve(); };
                                script.onerror = () => {
                                    clearTimeout(timer);
                                    console.error('[E2E] Failed: ' + url);
                                    resolve();
                                };
                                document.head.appendChild(script);
                            });
                        }
                        const scriptEl = document.createElement('script');
                        scriptEl.textContent = USERSCRIPT;
                        document.head.appendChild(scriptEl);
                        console.log('[E2E] Userscript injected');
                    }
                    if (document.readyState === 'loading') {
                        document.addEventListener('DOMContentLoaded', init, { once: true });
                    } else {
                        setTimeout(init, 0);
                    }
                })();
            `
        });

        if (VIA_PROXY) {
            await context.route(url => /^https:\/\/([a-z0-9-]+\.)*asmr(-\d+)?\.(one|com)\//.test(url.toString()), async (route) => {
                const request = route.request();
                if (request.method() !== 'GET') return route.continue();
                const url = new URL(request.url());
                url.searchParams.set('__host', url.hostname);
                const proxied = `${E2E_PROXY_URL}${url.pathname}${url.search}`;
                try {
                    const response = await context.request.get(proxied, {
                        timeout: 30000,
                        headers: {
                            Accept: request.headers().accept || '*/*',
                            'Accept-Language': 'zh-CN,zh;q=0.9,ja;q=0.8',
                            ...(request.headers().authorization ? { Authorization: request.headers().authorization } : {}),
                            ...(request.headers().range ? { Range: request.headers().range } : {}),
                            ...(request.headers()['if-none-match'] ? { 'If-None-Match': request.headers()['if-none-match'] } : {}),
                            ...(request.headers()['if-modified-since'] ? { 'If-Modified-Since': request.headers()['if-modified-since'] } : {}),
                        },
                    });
                    return route.fulfill({
                        status: response.status(),
                        contentType: response.headers()['content-type'] || 'text/html',
                        body: await response.body(),
                    });
                } catch (error) {
                    return route.fulfill({
                        status: 502,
                        contentType: 'text/plain; charset=utf-8',
                        body: `E2E relay failed for ${proxied}: ${String(error)}`,
                    });
                }
            });
        }

        // Block heavy resources EXCEPT audio (we need .wav for Whisper)
        await context.route(/\.(?:png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|eot)(?:\?|$)/i, (route) => route.abort());
        await context.route(/google-analytics|googletagmanager|hotjar|sentry\.io/, (route) => route.abort());

        // Serve our WAV fixture on a predictable URL
        await context.route('**/test-whisper-audio.wav', (route) => {
            route.fulfill({
                status: 200,
                contentType: 'audio/wav',
                body: TEST_WAV_DATA,
            });
        });

        // Mock API for work page
        const mockDataDir = path.join(__dirname, 'mock-data/api');
        await context.route('**/api/**', async (route) => {
            const url = route.request().url();
            if (url.includes('/api/work/')) {
                const workIdMatch = url.match(/work\/([^\/?]+)/);
                const workId = workIdMatch ? workIdMatch[1] : null;
                if (url.includes('/tracks')) {
                    const mockPath = path.join(mockDataDir, `work/${workId}-tracks.json`);
                    if (fs.existsSync(mockPath)) return route.fulfill({ path: mockPath });
                } else if (workId) {
                    const mockPath = path.join(mockDataDir, `work/${workId}.json`);
                    if (fs.existsSync(mockPath)) return route.fulfill({ path: mockPath });
                }
            }
            if (url.includes('/api/workInfo/')) {
                const workIdMatch = url.match(/workInfo\/([^\/?]+)/);
                const workId = workIdMatch ? workIdMatch[1] : null;
                if (workId) {
                    const infoPath = path.join(mockDataDir, `work/${workId}-info.json`);
                    if (fs.existsSync(infoPath)) return route.fulfill({ path: infoPath });
                    const fallbackPath = path.join(mockDataDir, `work/${workId}.json`);
                    if (fs.existsSync(fallbackPath)) return route.fulfill({ path: fallbackPath });
                }
            }
            if (url.includes('/api/tracks/')) {
                const workIdMatch = url.match(/tracks\/([^\/?]+)/);
                const workId = workIdMatch ? workIdMatch[1] : null;
                if (workId) {
                    const mockPath = path.join(mockDataDir, `work/${workId}-tracks.json`);
                    if (fs.existsSync(mockPath)) return route.fulfill({ path: mockPath });
                }
            }
            if (url.includes('/api/works')) {
                const mockPath = path.join(mockDataDir, 'works.json');
                if (fs.existsSync(mockPath)) return route.fulfill({ path: mockPath });
            }
            if (url.endsWith('/api/tags')) {
                const mockPath = path.join(mockDataDir, 'tags.json');
                if (fs.existsSync(mockPath)) return route.fulfill({ path: mockPath });
            }
            if (url.endsWith('/api/vas')) {
                const mockPath = path.join(mockDataDir, 'vas.json');
                if (fs.existsSync(mockPath)) return route.fulfill({ path: mockPath });
            }
            if (url.endsWith('/api/circles')) {
                const mockPath = path.join(mockDataDir, 'circles.json');
                if (fs.existsSync(mockPath)) return route.fulfill({ path: mockPath });
            }
            return route.continue();
        });

        await context.route('https://translate.googleapis.com/**', async (route) => {
            const body = JSON.stringify([[['Mock translation', '', null, null, 1]], null, 'en']);
            await route.fulfill({ status: 200, contentType: 'application/json', body });
        });

        await use(context);
    },

    whisperPage: async ({ context }, use) => {
        const page = await context.newPage();
        await ensureLoggedIn(page);
        await use(page);
    },

    consoleLogs: async ({}, use) => {
        const logs: string[] = [];
        await use(logs);
    },

    waitForWhisperLog: async ({ whisperPage, consoleLogs }, use) => {
        // Attach console listener once — capture ALL logs to avoid missing formatted messages
        whisperPage.on('console', msg => {
            // Playwright's msg.text() joins all arguments with spaces.
            // For %c styled messages like console.log('%c[PREFIX]%c msg', style1, style2),
            // msg.text() returns: "%c[PREFIX]%c msg style1 style2"
            // We need to also check msg.args() for the raw text.
            const text = msg.text();
            consoleLogs.push(text);

            // Also capture the first argument which is the format string
            // For Logger.log: console.log('%c[ASMR-Ult]%c [Whisper] ...', style, '')
            // msg.text() = '%c[ASMR-Ult]%c [Whisper] ... color:... '
            const isWhisperRelated = text.includes('Whisper') || text.includes('[E2E]') ||
                text.includes('Bridge') || text.includes('ASMR');
            if (isWhisperRelated) {
                // Clean up %c formatting for display
                const clean = text.replace(/%c/g, '').replace(/color:[^;]*;?/g, '').replace(/font-[^;]*;?/g, '').trim();
                console.log(`  [browser] ${clean.substring(0, 200)}`);
            }
        });
        whisperPage.on('pageerror', err => {
            console.log(`  [page-error] ${err.message}`);
        });

        const waiter = async (pattern: RegExp, timeout = WHISPER_TIMEOUT): Promise<string> => {
            const start = Date.now();
            while (Date.now() - start < timeout) {
                // Search through all captured logs — strip %c formatting before matching
                for (const log of consoleLogs) {
                    const clean = log.replace(/%c/g, '');
                    if (pattern.test(clean)) return clean;
                }
                await new Promise(r => setTimeout(r, 500));
            }
            // Dump last 50 logs for debugging (cleaned up)
            console.log('--- Last 50 console logs ---');
            consoleLogs.slice(-50).forEach(l => {
                const clean = l.replace(/%c/g, '').substring(0, 200);
                console.log(`  ${clean}`);
            });
            console.log('---');
            throw new Error(`Timed out waiting for console log matching ${pattern} after ${timeout}ms`);
        };
        await use(waiter);
    },
});

const TEST_WORK = 'RJ01052162';

// ---------------------------------------------------------------------------
// Helper: Navigate, wait for script, start a track, then inject test audio
// ---------------------------------------------------------------------------

async function setupWhisperPage(page: Page): Promise<void> {
    await ensureLoggedIn(page);
    await helpers.gotoWork(page, TEST_WORK);

    // Wait for userscript injection
    const ready = await page.waitForFunction(
        () => !!(window as any).__ASMR_LOGGER__ || !!(window as any).ASMRUlt || !!(window as any).__ASMR_ULTIMATE_INITIALIZED__,
        undefined,
        { timeout: 20000 },
    ).then(() => true).catch(() => false);

    if (!ready) throw new Error('Userscript did not initialize within 20s');

    // Wait for work tree to render
    await page.waitForTimeout(3000);

    // Click the first play button in the file tree to start the audio player
    const playBtn = page.locator('#work-tree .q-item .q-btn--round, .work-tree .q-item .q-btn--round').first();
    if (await playBtn.count() > 0) {
        console.log('  [E2E] Clicking first track play button...');
        await playBtn.click();
        // Wait for audio player to appear
        await page.waitForTimeout(3000);
    } else {
        console.log('  [E2E] No play button found in work tree');
    }

    // Intercept any audio file requests and serve our test WAV instead
    // (the real track URL will fail or be slow, so we replace it)
    await page.route(/\.(mp3|wav|flac|ogg|m4a)(\?|$)/i, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'audio/wav',
            body: TEST_WAV_DATA,
        });
    });

    // Now replace the audio element source with our WAV
    const swapped = await page.evaluate(() => {
        const audio = document.querySelector('audio') as HTMLAudioElement;
        if (!audio) {
            console.log('[E2E] No audio element found, creating one');
            const newAudio = document.createElement('audio');
            newAudio.id = 'e2e-test-audio';
            document.body.appendChild(newAudio);
        }
        const el = (document.querySelector('audio') as HTMLAudioElement)!;
        el.src = location.origin + '/test-whisper-audio.wav';
        el.muted = true;
        el.load();

        // Also set the Vuex store so Whisper.resolveAudioSource can find it
        const bridge = (window as any).__ASMR_KIKOERU_BRIDGE__;
        if (bridge?.store) {
            try {
                const player = bridge.store.state.AudioPlayer;
                if (player) {
                    if (!player.currentTrack) player.currentTrack = {};
                    player.currentTrack.mediaDownloadUrl = location.origin + '/test-whisper-audio.wav';
                    player.currentTrack.title = 'E2E Test Audio';
                    player.currentTrack.fileName = 'test-audio.wav';
                }
                return true;
            } catch (e) {
                console.log('[E2E] Could not set store track:', e);
                return false;
            }
        }
        return false;
    });
    console.log(`  [E2E] Store track set: ${swapped}`);

    // Let audio element load the WAV
    await page.waitForTimeout(2000);

    // Attempt to start playback (muted autoplay should be allowed)
    await page.evaluate(() => {
        const audio = document.querySelector('audio') as HTMLAudioElement | null;
        if (!audio) return;
        audio.muted = true;
        audio.play().catch(() => {});
    });

    // Verify audio element has our WAV loaded
    const audioState = await page.evaluate(() => {
        const audio = document.querySelector('audio') as HTMLAudioElement;
        return {
            src: audio?.src || 'none',
            currentSrc: audio?.currentSrc || 'none',
            readyState: audio?.readyState || 0,
            duration: audio?.duration || 0,
            error: audio?.error?.message || null,
        };
    });
    console.log('  [E2E] Audio state:', JSON.stringify(audioState));
}

async function clickWhisperButton(page: Page): Promise<boolean> {
    // Try the button in the LearnerMode controls
    const btn = page.locator('.asmr-whisper-btn').first();
    if (await btn.count() > 0 && await btn.isVisible()) {
        console.log('  [E2E] Found Whisper button, clicking...');
        await btn.click();
        return true;
    }

    // Fallback: trigger via EventBus directly (most reliable)
    console.log('  [E2E] Whisper button not visible, triggering via EventBus...');
    const triggered = await page.evaluate(() => {
        const w = window as any;
        // Try EventBus directly — this is the most reliable path
        if (w.__ASMR_EVENT_BUS__) {
            console.log('[E2E] Emitting whisper:toggle via __ASMR_EVENT_BUS__');
            w.__ASMR_EVENT_BUS__.emit('whisper:toggle', undefined);
            return 'eventbus';
        }
        // Fallback: try ASMRUlt API
        if (w.ASMRUlt) {
            // The API might not expose whisperToggle, but EventBus should
            console.log('[E2E] No EventBus found, trying ASMRUlt');
            return 'no-eventbus';
        }
        return 'nothing';
    });
    console.log(`  [E2E] Trigger method: ${triggered}`);
    return triggered === 'eventbus';
}

// ═══════════════════════════════════════════════════════════════════════════════
// BDD TEST SCENARIOS
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Feature: Whisper AI Transcription End-to-End', () => {
    // 5 minute timeout for the whole suite — model download is slow
    test.setTimeout(WHISPER_TIMEOUT);

    test.describe('Scenario: Full transcription pipeline', () => {
        /**
         * Given: A work page is loaded with an audio file available
         * When:  The user clicks "AI Transcribe"
         * Then:  The system downloads the model, transcribes, and shows text
         *
         * Covers: US-1, US-2, US-3, US-4, US-5, US-6, NF-1, NF-2, NF-3, NF-4
         *
         * NOTE: Requires WebGPU model download — skipped in headless CI.
         * Run with `npm run test:e2e:headed` to execute this test.
         */
        test.skip(!!process.env.CI || !process.env.WHISPER_E2E, 'Requires WebGPU model download — set WHISPER_E2E=1 to run');
        test('starts the first decoded chunk without a seek or scrub', async ({
            whisperPage: page,
            consoleLogs,
            waitForWhisperLog,
        }) => {
            await setupWhisperPage(page);
            await page.evaluate(() => {
                const state = window as any;
                state.__E2E_SEEK_COUNT__ = 0;
                state.__E2E_NONEMPTY_WHISPER_UPDATES__ = 0;
                document.querySelector('audio')?.addEventListener('seeking', () => {
                    state.__E2E_SEEK_COUNT__ += 1;
                });
                state.ASMRUlt?.set?.('whisperModelPreset', 'auto');
                state.ASMRUlt?.set?.('whisperVadMode', 'off');
                state.__ASMR_EVENT_BUS__?.on('whisper:update', (payload: { text?: string }) => {
                    if (payload?.text?.trim()) state.__E2E_NONEMPTY_WHISPER_UPDATES__ += 1;
                });
            });

            expect(await clickWhisperButton(page)).toBe(true);
            const firstChunk = await waitForWhisperLog(
                /\[Whisper Worker\] Starting inference on (webgpu|wasm)/,
                WHISPER_TIMEOUT,
            );
            expect(firstChunk).toMatch(/Starting inference on (webgpu|wasm)/);
            expect(await page.evaluate(() => (window as any).__E2E_SEEK_COUNT__)).toBe(0);

            const terminal = await Promise.race([
                waitForWhisperLog(/\[Whisper Worker\] Chunk result:/, WHISPER_TIMEOUT).then(() => 'complete'),
                waitForWhisperLog(/\[Whisper\] Worker error:/, WHISPER_TIMEOUT).then(() => 'error'),
            ]);
            if (terminal === 'error') {
                const recent = consoleLogs.slice(-40).join('\n');
                throw new Error(`Whisper failed after dispatching its first no-seek chunk:\n${recent}`);
            }
            await page.waitForTimeout(250);
            expect(await page.evaluate(() => (window as any).__E2E_NONEMPTY_WHISPER_UPDATES__)).toBe(0);
        });
        test.skip('legacy console-diagnostic contract (superseded by event-based no-scrub coverage)', async ({
            whisperPage: page,
            consoleLogs,
            waitForWhisperLog,
        }) => {
            // ── GIVEN: Page loaded with audio ──────────────────────────
            await setupWhisperPage(page);
            console.log('  [E2E] Page setup complete, audio source injected.');

            // Verify audio element has our WAV
            const audioSrc = await page.evaluate(() => {
                const audio = document.querySelector('audio');
                return audio?.src || audio?.currentSrc || 'none';
            });
            expect(audioSrc).toContain('test-whisper-audio.wav');
            console.log('  [E2E] Audio src confirmed:', audioSrc);

            // ── WHEN: User clicks "AI Transcribe" ─────────────────────
            const clicked = await clickWhisperButton(page);
            expect(clicked).toBe(true);
            console.log('  [E2E] Whisper transcription triggered.');

            // ── THEN (US-6): Button shows active/loading state ────────
            // Give it a moment to react
            await page.waitForTimeout(1000);
            const btnActive = await page.evaluate(() => {
                const btn = document.querySelector('.asmr-whisper-btn');
                return {
                    hasActiveClass: btn?.classList.contains('learner-btn-active') || false,
                    dataActive: btn?.getAttribute('data-active'),
                    hasLoadingClass: btn?.classList.contains('asmr-whisper-loading') || false,
                };
            });
            console.log('  [E2E] Button state:', JSON.stringify(btnActive));
            // At least one of these should be true if button exists
            // (button might not exist if LearnerMode didn't inject it)

            // ── THEN (US-1): Model loading progress appears in console ─
            console.log('  [E2E] Waiting for transcription start log...');
            await waitForWhisperLog(/\[Whisper\] ====== TRANSCRIPTION START ======/, 30000);

            // Wait for worker initialization — backend detection (NF-3)
            console.log('  [E2E] Waiting for worker backend detection...');
            const backendLog = await waitForWhisperLog(/\[Whisper\] Worker initialized, backend:/, 60000);
            console.log('  [E2E]', backendLog);

            // Wait for model loading progress (US-1, NF-1)
            console.log('  [E2E] Waiting for model loading progress...');
            await waitForWhisperLog(/\[Whisper\] Loading model:.*\d+%/, 3 * 60 * 1000);

            // Verify status UI shows loading info (NF-1)
            const statusDuringLoad = await page.evaluate(() => {
                const el = document.querySelector('.whisper-status');
                return el?.textContent || '';
            });
            console.log('  [E2E] Status UI during load:', statusDuringLoad);

            // Wait for model ready (US-1)
            console.log('  [E2E] Waiting for model ready...');
            await waitForWhisperLog(/\[Whisper\] Model loaded, ready to transcribe/, 4 * 60 * 1000);

            // ── THEN (US-2): Token progress appears ───────────────────
            console.log('  [E2E] Waiting for transcription progress...');
            // Either progress_tick logs or completion
            const progressOrComplete = await Promise.race([
                waitForWhisperLog(/\[Whisper\] Transcribing\.\.\. \d+ tokens generated/, WHISPER_TIMEOUT)
                    .then(log => ({ type: 'progress', log })),
                waitForWhisperLog(/\[Whisper\] Transcription complete/, WHISPER_TIMEOUT)
                    .then(log => ({ type: 'complete', log })),
            ]);
            console.log(`  [E2E] Got ${progressOrComplete.type}:`, progressOrComplete.log);

            // ── THEN (US-3): Transcription completes with segments ────
            if (progressOrComplete.type !== 'complete') {
                console.log('  [E2E] Waiting for transcription complete...');
                await waitForWhisperLog(/\[Whisper\] Transcription complete/, WHISPER_TIMEOUT);
            }

            // ── THEN (NF-2): Raw diagnostic data logged ──────────────
            // Helper to search cleaned logs
            const cleanLogs = consoleLogs.map(l => l.replace(/%c/g, ''));
            const rawDataKeysLog = cleanLogs.find(l => l.includes('[Whisper] Raw data keys:'));
            const rawTextLog = cleanLogs.find(l => l.includes('[Whisper] Raw text:'));
            const rawChunksLog = cleanLogs.find(l => l.includes('[Whisper] Raw chunks:'));

            console.log('  [E2E] Diagnostics:');
            console.log('    Raw data keys:', rawDataKeysLog?.substring(0, 200) || 'NOT FOUND');
            console.log('    Raw text:', rawTextLog?.substring(0, 200) || 'NOT FOUND');
            console.log('    Raw chunks:', rawChunksLog?.substring(0, 200) || 'NOT FOUND');

            expect(rawDataKeysLog).toBeTruthy();
            expect(rawTextLog).toBeTruthy();
            expect(rawChunksLog).toBeTruthy();

            // ── THEN (US-3): Segments or fallback text produced ───────
            const hasSegments = cleanLogs.some(l => /\[Whisper\] Got \d+ segments/.test(l));
            const hasFallback = cleanLogs.some(l => l.includes('using raw text as single segment'));
            const noSegments = cleanLogs.some(l => l.includes('No valid segments'));

            console.log('  [E2E] Results: hasSegments=%s, hasFallback=%s, noSegments=%s',
                hasSegments, hasFallback, noSegments);

            // (NF-4): At minimum, either segments or fallback should exist
            // The only acceptable failure is if the audio is genuinely silent
            if (noSegments && !hasFallback) {
                // Check if there was raw text — if so, fallback should have caught it
                const rawText = rawTextLog || '';
                const textContent = rawText.match(/Raw text: "(.*)"/)?.[1] || '';
                if (textContent.trim().length > 0) {
                    // There was text but no segments were produced — this is a bug
                    throw new Error(
                        `Transcription produced raw text "${textContent.substring(0, 100)}" ` +
                        `but no segments were created. The fallback mechanism failed.`
                    );
                }
                console.log('  [E2E] ⚠ No segments and no raw text — audio may be silent/non-speech');
            }

            // ── THEN (US-3): Transcription text logged ────────────────
            const transcriptionResultLog = cleanLogs.find(l => l.includes('[Whisper] Transcription result:'));
            if (hasSegments || hasFallback) {
                expect(transcriptionResultLog).toBeTruthy();
                console.log('  [E2E] Transcription result:', transcriptionResultLog?.substring(0, 300));
            }

            // ── THEN (US-4): VTT track injected ──────────────────────
            if (hasSegments || hasFallback) {
                const vttLog = cleanLogs.find(l => l.includes('Injecting VTT track'));
                expect(vttLog).toBeTruthy();
                console.log('  [E2E] VTT injection:', vttLog);

                const vttTrack = await page.evaluate(() => {
                    const audio = document.querySelector('audio');
                    if (!audio) return null;
                    const track = audio.querySelector('track[data-asmr="whisper"]') as HTMLTrackElement;
                    return track ? { label: track.label, kind: track.kind, srclang: track.srclang } : null;
                });
                console.log('  [E2E] VTT track element:', JSON.stringify(vttTrack));
                if (vttTrack) {
                    expect(vttTrack.kind).toBe('subtitles');
                    expect(vttTrack.label).toMatch(/Whisper/);
                }
            }

            // ── THEN (US-5): EventBus whisper:update emitted ─────────
            if (hasSegments || hasFallback) {
                // The whisper:update event should have been emitted - check for segment logs
                const segmentLogs = cleanLogs.filter(l => /\[Whisper\]\s+\[\d+\.\d+s/.test(l));
                console.log(`  [E2E] Segment detail logs: ${segmentLogs.length}`);
                segmentLogs.slice(0, 5).forEach(l => console.log(`    ${l}`));
            }

            // ── THEN (US-6): Button returns to normal state ──────────
            // Wait for transcription end
            await waitForWhisperLog(/\[Whisper\] ====== TRANSCRIPTION END ======/, 10000);

            const btnFinal = await page.evaluate(() => {
                const btn = document.querySelector('.asmr-whisper-btn');
                return {
                    hasActiveClass: btn?.classList.contains('learner-btn-active') || false,
                    hasLoadingClass: btn?.classList.contains('asmr-whisper-loading') || false,
                };
            });
            console.log('  [E2E] Final button state:', JSON.stringify(btnFinal));
            // After completion, button should NOT be in active/loading state
            expect(btnFinal.hasLoadingClass).toBe(false);

            console.log('  [E2E] ✓ Full transcription pipeline test complete');
        });
    });

    test.describe('Scenario: No audio source', () => {
        /**
         * Given: A work page is loaded but no audio is playing
         * When:  The user clicks "AI Transcribe"
         * Then:  An error message is shown telling them to play a track
         *
         * Covers: US-8
        */
        test('should show error when no audio source available', async ({ whisperPage: page }) => {
            test.setTimeout(60_000);
            await ensureLoggedIn(page);
            await helpers.gotoWork(page, TEST_WORK);

            await page.waitForFunction(
                () => {
                    try {
                        const state = window as any;
                        return !!state.ASMRUlt
                            && !!state.__ASMR_KIKOERU_BRIDGE__?.store
                            && !!state.__ASMR_EVENT_BUS__;
                    } catch {
                        return false;
                    }
                },
                undefined,
                { timeout: 20000 },
            );

            await page.waitForTimeout(3000);

            // Do NOT set audio source — leave it empty
            // Remove any existing audio src
            await page.evaluate(() => {
                const audio = document.querySelector('audio');
                if (audio) {
                    audio.removeAttribute('src');
                    audio.load();
                }
            });

            await page.evaluate(() => {
                const state = window as any;
                state.__E2E_WHISPER_ERRORS__ = [];
                state.__ASMR_EVENT_BUS__.on('whisper:error', (payload: { message?: string }) => {
                    state.__E2E_WHISPER_ERRORS__.push(payload?.message || '');
                });
            });

            expect(await clickWhisperButton(page)).toBe(true);
            await page.waitForFunction(() => {
                const errors = (window as any).__E2E_WHISPER_ERRORS__ as string[] | undefined;
                return errors?.some((message) => /No audio source found|音声ソース|未找到音频源/.test(message));
            }, undefined, { timeout: 15000 });

            const errors = await page.evaluate(() => (window as any).__E2E_WHISPER_ERRORS__ as string[]);
            expect(errors.some((message) => /No audio source found|音声ソース|未找到音频源/.test(message))).toBe(true);
            console.log('  [E2E] ✓ Got expected no-audio-source error event');
        });
    });
});
