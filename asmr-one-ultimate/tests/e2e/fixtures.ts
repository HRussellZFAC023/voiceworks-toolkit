/**
 * E2E Test Fixtures
 *
 * Provides page fixtures that automatically inject the userscript.
 * No manual browser setup or Tampermonkey installation required.
 */

import { test as base, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createSilentWav } from './audioFixture';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const USERSCRIPT_PATH = path.join(__dirname, '../../dist/asmr-one-ultimate.user.js');
const AUTH_PATH = path.join(__dirname, '.auth.json');
const isRealE2E = process.env.E2E_REAL === '1' || process.env.E2E_NO_MOCKS === '1';
// Direct document requests are region/language gated from common CI and agent
// networks. Keep the maintained Japan relay as the safe default; local runs
// that explicitly need to exercise direct networking can opt out.
const viaProxy = process.env.E2E_PROXY !== '0';
const E2E_PROXY_URL = (process.env.E2E_PROXY_URL || 'https://asmr-api-proxy.henry-robert-christopher-russell.workers.dev').replace(/\/$/, '');
const requireAuth = process.env.E2E_REQUIRE_AUTH === '1';
const TEST_IMAGE_BODY = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8Dwn6Hh/38AEXkEfRkE0tIAAAAASUVORK5CYII=',
    'base64'
);

// Long enough that playback-state assertions cannot race the media `ended`
// event, while remaining small enough to serve cheaply in every test context.
const TEST_AUDIO_BODY = createSilentWav(8000, 30);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type AuthConfig = { username: string; password: string };

function resolveWorkFixture(workId: string, suffix = ''): string | null {
    let decoded: string;
    try {
        decoded = decodeURIComponent(workId);
    } catch {
        return null;
    }
    if (!/^(?:RJ)?\d+$/i.test(decoded)) return null;
    const digits = decoded.replace(/^RJ/i, '');
    const numeric = digits.replace(/^0+(?=\d)/, '');
    const candidates = [...new Set([
        decoded,
        digits,
        numeric,
        `RJ${digits}`,
    ])];
    for (const candidate of candidates) {
        const fixture = path.join(__dirname, `mock-data/api/work/${candidate}${suffix}.json`);
        if (fs.existsSync(fixture)) return fixture;
    }
    return null;
}

function loadAuthConfig(): AuthConfig | null {
    const username = process.env.ASMR_ONE_USER || process.env.E2E_USERNAME || process.env.ASMR_USER;
    const password = process.env.ASMR_ONE_PASS || process.env.E2E_PASSWORD || process.env.ASMR_PASS;
    if (username && password) {
        return { username, password };
    }

    if (fs.existsSync(AUTH_PATH)) {
        try {
            const raw = fs.readFileSync(AUTH_PATH, 'utf-8');
            const parsed = JSON.parse(raw);
            if (parsed?.username && parsed?.password) {
                return { username: String(parsed.username), password: String(parsed.password) };
            }
        } catch {
            // ignore invalid auth file
        }
    }

    return null;
}

export async function ensureLoggedIn(page: Page): Promise<boolean> {
    const context = page.context() as any;
    if (context.__authReady != null) return context.__authReady;

    const creds = loadAuthConfig();
    if (!creds || !requireAuth) {
        context.__authReady = false;
        return false;
    }

    const baseUrl = getBaseUrl(context._workerIndex || 0);
    await page.goto(baseUrl, { waitUntil: 'commit', timeout: 30000 });

    const result = await page.evaluate(async (payload) => {
        try {
            const existing = localStorage.getItem('jwt-token');
            if (existing) return { ok: true, token: existing };

            const res = await fetch('/api/auth/me', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: payload.username, password: payload.password }),
                credentials: 'include',
            });
            if (!res.ok) {
                return { ok: false, status: res.status };
            }
            const data = await res.json().catch(() => null);
            const token = data?.token || '';
            if (token) {
                localStorage.setItem('jwt-token', token);
                try {
                    const bridge = (window as any).__ASMR_KIKOERU_BRIDGE__;
                    const headers = bridge?.axios?.defaults?.headers?.common;
                    if (headers) headers.Authorization = `Bearer ${token}`;
                } catch {
                    // ignore bridge header issues
                }
            }
            return { ok: !!token, token };
        } catch (err) {
            return { ok: false, error: String(err) };
        }
    }, creds);

    context.__authReady = !!result?.ok;
    return context.__authReady;
}

// Resource types to block for RAM savings — images, fonts, and media are
// not needed for functional E2E testing of a userscript
const BLOCKED_URL_PATTERNS = [
    /\.(?:png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|eot|mp3|mp4|ogg|wav|flac)(?:\?|$)/i,
    /google-analytics\.com/,
    /googletagmanager\.com/,
    /hotjar\.com/,
    /sentry\.io/,
];

const BASE_URLS = (() => {
    const custom = (process.env.E2E_BASE_URLS || process.env.E2E_BASE_URL || '').trim();
    if (custom) {
        return custom
            .split(',')
            .map(v => v.trim())
            .filter(Boolean)
            .map(v => (v.startsWith('http://') || v.startsWith('https://')) ? v : `https://${v}`);
    }
    if (isRealE2E) {
        // Keep real runs on stable production domains (avoid flaky mirror hosts).
        return ['https://www.asmr.one', 'https://asmr.one'];
    }
    return ['https://asmr.one', 'https://www.asmr.one', 'https://asmr-100.com', 'https://asmr-200.com', 'https://asmr-300.com'];
})();

function getBaseUrl(index: number): string {
    return BASE_URLS[index % BASE_URLS.length];
}

function buildUrl(base: string, pathOrUrl: string): string {
    if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) return pathOrUrl;
    const normalizedPath = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
    return `${base}${normalizedPath}`;
}

async function gotoWithFallback(page: Page, pathOrUrl: string, waitMs = 0): Promise<void> {
    const workerIndex = (page.context() as any)._workerIndex || 0;
    let lastError: unknown = null;
    for (let i = 0; i < BASE_URLS.length; i++) {
        const base = getBaseUrl(workerIndex + i);
        const target = buildUrl(base, pathOrUrl);
        try {
            await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
            // Wait a beat so anti-bot / CDN error pages can settle.
            await sleep(500);
            const isUnavailable = await page.evaluate(() => {
                const text = (document.body?.innerText || '').toLowerCase();
                const hasHostApp = !!document.querySelector('#q-app');
                return text.includes('502')
                    || text.includes('bad gateway')
                    || text.includes('network error')
                    || text.includes('无法连接服务器')
                    || !hasHostApp;
            }).catch(() => true);
            if (isUnavailable) throw new Error(`Host app unavailable on ${target}`);
            if (waitMs > 0) await sleep(waitMs);
            return;
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError instanceof Error ? lastError : new Error(`Failed to open ${pathOrUrl} on all configured base URLs`);
}

// Fallback dependencies if userscript metadata cannot be parsed.
const FALLBACK_REQUIRE_URLS = [
    'https://cdn.jsdelivr.net/npm/vue@3.5.27/dist/vue.global.prod.js',
    'https://cdn.jsdelivr.net/npm/systemjs@6.15.1/dist/system.min.js',
    'https://cdn.jsdelivr.net/npm/systemjs@6.15.1/dist/extras/named-register.min.js',
    "data:application/javascript,%3B(typeof%20System!%3D'undefined')%26%26(System%3Dnew%20System.constructor())%3B",
];

const LOCAL_REQUIRE_PATHS = new Map<string, string>([
    [FALLBACK_REQUIRE_URLS[0], path.join(__dirname, '../../node_modules/vue/dist/vue.global.prod.js')],
    [FALLBACK_REQUIRE_URLS[1], path.join(__dirname, '../../node_modules/systemjs/dist/system.min.js')],
    [FALLBACK_REQUIRE_URLS[2], path.join(__dirname, '../../node_modules/systemjs/dist/extras/named-register.min.js')],
]);

function loadLocalRequireSource(url: string): string | null {
    if (url.startsWith('data:application/javascript,')) {
        try {
            return decodeURIComponent(url.slice(url.indexOf(',') + 1));
        } catch {
            return null;
        }
    }

    const localPath = LOCAL_REQUIRE_PATHS.get(url);
    if (!localPath || !fs.existsSync(localPath)) return null;
    return fs.readFileSync(localPath, 'utf-8');
}

// GM_* API stubs for running outside Tampermonkey
export const GM_STUBS = `
window.GM_getValue = window.GM_getValue || ((key, def) => {
    try {
        const v = localStorage.getItem('GM_' + key);
        return v !== null ? JSON.parse(v) : def;
    } catch { return def; }
});
window.GM_setValue = window.GM_setValue || ((key, val) => {
    localStorage.setItem('GM_' + key, JSON.stringify(val));
});
window.GM_deleteValue = window.GM_deleteValue || ((key) => {
    localStorage.removeItem('GM_' + key);
});
window.GM_listValues = window.GM_listValues || (() => {
    return Object.keys(localStorage).filter(k => k.startsWith('GM_')).map(k => k.slice(3));
});
window.GM_xmlhttpRequest = window.GM_xmlhttpRequest || ((opts) => {
    const isSameOrigin = (() => { try { return new URL(opts.url, location.href).origin === location.origin; } catch { return false; } })();
    fetch(opts.url, {
        method: opts.method || 'GET',
        headers: opts.headers,
        body: opts.data,
        credentials: isSameOrigin ? 'include' : 'omit'
    }).then(async (res) => {
        let response;
        let responseText = '';
        if (opts.responseType === 'blob') {
            response = await res.blob();
        } else {
            responseText = await res.text();
            response = responseText;
            try { response = JSON.parse(responseText); } catch {}
        }
        const responseHeaders = Array.from(res.headers.entries())
            .map(([name, value]) => name + ': ' + value)
            .join('\\r\\n');
        opts.onload?.({
            // Real GM_xmlhttpRequest retains raw responseText even when a JSON
            // response is also exposed as a parsed response value.
            responseText,
            response,
            status: res.status,
            statusText: res.statusText,
            responseHeaders,
            finalUrl: res.url,
        });
    }).catch(err => {
        opts.onerror?.(err);
    });
});
window.GM_addStyle = window.GM_addStyle || ((css) => {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    return style;
});
window.GM_registerMenuCommand = window.GM_registerMenuCommand || (() => {});
window.GM_unregisterMenuCommand = window.GM_unregisterMenuCommand || (() => {});
window.GM_notification = window.GM_notification || (() => {});
window.GM_openInTab = window.GM_openInTab || ((url) => window.open(url));
window.GM_setClipboard = window.GM_setClipboard || ((text) => navigator.clipboard?.writeText(text));
window.GM_info = window.GM_info || { script: { name: 'ASMR Ultimate', version: '1.0.0' } };
window.unsafeWindow = window;
`;

export type UserscriptBundle = {
    code: string;
    requires: string[];
    requireSources: Array<string | null>;
};

// Cache the parsed userscript once per worker process.
let cachedUserscript: UserscriptBundle | null = null;

export function loadUserscript(): UserscriptBundle {
    if (cachedUserscript) return cachedUserscript;

    try {
        if (!fs.existsSync(USERSCRIPT_PATH)) {
            throw new Error(`Userscript not found at ${USERSCRIPT_PATH}`);
        }

        const raw = fs.readFileSync(USERSCRIPT_PATH, 'utf-8');
        const headerMatch = raw.match(/^\/\/\s*==UserScript==[\s\S]*?\/\/\s*==\/UserScript==\s*/m);
        const header = headerMatch?.[0] || '';

        const requires = Array.from(header.matchAll(/\/\/\s*@require\s+(.+)$/gm))
            .map((m) => m[1]?.trim())
            .filter((v): v is string => !!v);

        let script = raw;

        // Remove userscript header (everything before first non-comment code)
        script = script.replace(/^\/\/\s*==UserScript==[\s\S]*?\/\/\s*==\/UserScript==\s*/m, '');

        const effectiveRequires = requires.length > 0 ? requires : FALLBACK_REQUIRE_URLS;
        cachedUserscript = {
            code: script,
            requires: effectiveRequires,
            requireSources: effectiveRequires.map(loadLocalRequireSource),
        };
        return cachedUserscript;
    } catch (e) {
        throw new Error(
            `Cannot load userscript from ${USERSCRIPT_PATH}.\n` +
            'Make sure to build first: npm run build\n' +
            `Error: ${e}`
        );
    }
}

// Custom fixtures
type Fixtures = {
    injectedPage: Page;
    isScriptLoaded: () => Promise<boolean>;
    waitForBridge: (timeout?: number) => Promise<boolean>;
};

export const test = base.extend<Fixtures>({
    context: async ({ context }, use, testInfo) => {
        // Load userscript once
        const userscript = loadUserscript();

        // Inject GM stubs and Userscript once for the whole context
        await context.addInitScript({ content: GM_STUBS });

        // Inject SystemJS and Userscript
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

                        // Load userscript @require dependencies (Vue/SystemJS/etc.) in metadata order.
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
                                    console.error('[E2E] Failed to load @require dependency from ' + url);
                                    resolve();
                                };
                                document.head.appendChild(script);
                            });
                        }

                        // Inject Userscript
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

        // Store worker index in context for subdomain rotation
        (context as any)._workerIndex = (testInfo as any).workerIndex || 0;

        // Region-block bypass: when E2E_PROXY=1, load the asmr.one frontend
        // (document + JS/CSS) through the Tokyo-placed Cloudflare Worker so
        // the suite runs from networks the site 403s ("remember, no english").
        // Registered FIRST so all later routes (API mocks, resource blocks)
        // take precedence over it.
        if (viaProxy) {
            await context.route(url => /^https:\/\/([a-z0-9-]+\.)*asmr(-\d+)?\.(one|com)\//.test(url.toString()), async (route) => {
                const request = route.request();
                if (request.method() !== 'GET') return route.continue();
                const u = new URL(request.url());
                u.searchParams.set('__host', u.hostname);
                const proxied = `${E2E_PROXY_URL}${u.pathname}${u.search}`;
                try {
                    const resp = await context.request.get(proxied, {
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
                        status: resp.status(),
                        contentType: resp.headers()['content-type'] || 'text/html',
                        body: await resp.body(),
                    });
                } catch (error) {
                    // Never disguise relay failures as direct-host 403s. A
                    // synthetic 502 leaves a precise URL/error in traces.
                    return route.fulfill({
                        status: 502,
                        contentType: 'text/plain; charset=utf-8',
                        body: `E2E relay failed for ${proxied}: ${String(error)}`,
                    });
                }
            });
        }

        // Serve a tiny placeholder image for tests that need media preview
        await context.route('**/test-image-*.png*', (route) => {
            route.fulfill({
                status: 200,
                contentType: 'image/png',
                body: TEST_IMAGE_BODY,
            });
        });

        // Telemetry is irrelevant to product behavior and the Sentry host is
        // independently access-restricted. Block it in every mode so a beacon
        // failure cannot masquerade as an app/API 403 in test output.
        await context.route('**/api/**/sentry/**', (route) => route.abort());
        await context.route('**://sentry.asmr.one/**', (route) => route.abort());

        if (!isRealE2E) {
            // Block heavy resources context-wide
            await context.route('**/*.{png,jpg,jpeg,gif,webp,svg,ico,woff2,ttf,eot,mp3,mp4,ogg,wav,flac}*', (route) => {
                if (/\/test-image-[^/?]+\.png(?:\?|$)/i.test(route.request().url())) {
                    return route.fallback();
                }
                return route.abort();
            });
            await context.route(url =>
                !/\/test-image-[^/?]+\.png(?:\?|$)/i.test(url.toString())
                    && BLOCKED_URL_PATTERNS.some(p => p.test(url.toString())),
                (route) => route.abort(),
            );
        }

        // Flat-view mock tracks point at example.com. Serve valid local audio so
        // the host PlayerBar mounts instead of failing before learner/Whisper UI.
        if (!isRealE2E) await context.route('https://example.com/**', (route) => {
            route.fulfill({
                status: 200,
                contentType: 'audio/wav',
                body: TEST_AUDIO_BODY,
            });
        });

        // API Mocking for deterministic mode
        if (!isRealE2E) await context.route('**/api/**', async (route) => {
            const url = route.request().url();
            const method = route.request().method();

            if (url.includes('/api/auth/me') && method === 'GET') {
                const body = JSON.stringify({ user: { name: 'E2E' }, auth: true });
                return route.fulfill({ status: 200, contentType: 'application/json', body });
            }

            // Work details
            if (url.includes('/api/work/')) {
                const workIdMatch = url.match(/work\/([^\/?]+)/);
                const workId = workIdMatch ? workIdMatch[1] : null;

                if (url.includes('/tracks')) {
                    const mockPath = workId ? resolveWorkFixture(workId, '-tracks') : null;
                    if (mockPath) return route.fulfill({ path: mockPath });
                } else if (workId) {
                    const mockPath = resolveWorkFixture(workId);
                    if (mockPath) return route.fulfill({ path: mockPath });
                }
            }

            // Work info
            if (url.includes('/api/workInfo/')) {
                const workIdMatch = url.match(/workInfo\/([^\/?]+)/);
                const workId = workIdMatch ? workIdMatch[1] : null;
                if (workId) {
                    const infoPath = resolveWorkFixture(workId, '-info');
                    if (infoPath) return route.fulfill({ path: infoPath });
                    const fallbackPath = resolveWorkFixture(workId);
                    if (fallbackPath) return route.fulfill({ path: fallbackPath });
                }
            }

            // Tracks (v2)
            if (url.includes('/api/tracks/')) {
                const workIdMatch = url.match(/tracks\/([^\/?]+)/);
                const workId = workIdMatch ? workIdMatch[1] : null;
                if (workId) {
                    const mockPath = resolveWorkFixture(workId, '-tracks');
                    if (mockPath) return route.fulfill({ path: mockPath });
                }
            }

            // Works list (Home/Search)
            if (url.includes('/api/works')) {
                const mockPath = path.join(__dirname, `mock-data/api/works.json`);
                if (fs.existsSync(mockPath)) return route.fulfill({ path: mockPath });
            }
            if (url.includes('/api/search')) {
                const mockPath = path.join(__dirname, `mock-data/api/works.json`);
                if (fs.existsSync(mockPath)) return route.fulfill({ path: mockPath });
            }
            if (url.includes('/api/circles/') && url.includes('/works')) {
                const mockPath = path.join(__dirname, `mock-data/api/works.json`);
                if (fs.existsSync(mockPath)) return route.fulfill({ path: mockPath });
            }
            if (url.includes('/api/vas/') && url.includes('/works')) {
                const mockPath = path.join(__dirname, `mock-data/api/works.json`);
                if (fs.existsSync(mockPath)) return route.fulfill({ path: mockPath });
            }
            if (url.includes('/api/tags/') && url.includes('/works')) {
                const mockPath = path.join(__dirname, `mock-data/api/works.json`);
                if (fs.existsSync(mockPath)) return route.fulfill({ path: mockPath });
            }

            // Tags / VAs / Circles lists
            if (url.includes('/api/tags')) {
                const mockPath = path.join(__dirname, 'mock-data/api/tags.json');
                if (fs.existsSync(mockPath)) return route.fulfill({ path: mockPath });
            }
            if (url.includes('/api/vas')) {
                const mockPath = path.join(__dirname, 'mock-data/api/vas.json');
                if (fs.existsSync(mockPath)) return route.fulfill({ path: mockPath });
            }
            if (url.includes('/api/circles')) {
                const mockPath = path.join(__dirname, 'mock-data/api/circles.json');
                if (fs.existsSync(mockPath)) return route.fulfill({ path: mockPath });
            }

            // Playlist APIs - return empty lists to avoid auth flakiness
            if (url.includes('/api/playlists')) {
                const body = JSON.stringify({
                    playlists: [],
                    pagination: { currentPage: 1, pageSize: 100, totalCount: 0 },
                });
                return route.fulfill({ status: 200, contentType: 'application/json', body });
            }
            if (url.includes('/api/playlist/get-playlists')) {
                const body = JSON.stringify({
                    playlists: [],
                    pagination: { currentPage: 1, pageSize: 100, totalCount: 0 },
                });
                return route.fulfill({ status: 200, contentType: 'application/json', body });
            }
            if (url.includes('/api/playlist/get-playlist-metadata')) {
                const body = JSON.stringify({
                    id: 'mock-playlist',
                    name: 'Mock Playlist',
                    description: '',
                    privacy: 0,
                    works: [],
                    works_count: 0,
                    user_name: 'E2E',
                });
                return route.fulfill({ status: 200, contentType: 'application/json', body });
            }
            if (url.includes('/api/playlist/get-playlist-works')) {
                const body = JSON.stringify({
                    works: [],
                    pagination: { currentPage: 1, pageSize: 100, totalCount: 0 },
                });
                return route.fulfill({ status: 200, contentType: 'application/json', body });
            }

            // The host derives its own stream URL from the track hash even when
            // the mock track also carries a direct mediaStreamUrl.
            if (url.includes('/api/media/stream/mock_hash_')) {
                return route.fulfill({
                    status: 200,
                    contentType: 'audio/wav',
                    body: TEST_AUDIO_BODY,
                });
            }

            // Cover images
            if (url.includes('/api/cover/')) {
                return route.fulfill({
                    status: 200,
                    contentType: 'image/png',
                    body: TEST_IMAGE_BODY,
                });
            }

            if (url.includes('/api/media/check-lrc/')) {
                const body = JSON.stringify({ exists: false });
                return route.fulfill({ status: 200, contentType: 'application/json', body });
            }

            // In proxy mode, unmocked API calls fall back to the region proxy
            // route (registered first); route.continue() would go direct and 403.
            return viaProxy ? route.fallback() : route.continue();
        });

        // Mock Google Translate to avoid flaky network + console errors
        if (!isRealE2E) await context.route('https://translate.googleapis.com/**', async (route) => {
            const body = JSON.stringify([[['Mock translation', '', null, null, 1]], null, 'en']);
            await route.fulfill({ status: 200, contentType: 'application/json', body });
        });

        // Google Identity Services is dynamically injected when the maintained
        // Drive client ID is present. Keep settings tests deterministic while
        // still exercising the real preload path.
        if (!isRealE2E) await context.route('https://accounts.google.com/gsi/client', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/javascript',
                body: `window.google = window.google || {};
window.google.accounts = window.google.accounts || {};
window.google.accounts.oauth2 = window.google.accounts.oauth2 || {
  initTokenClient: () => ({ requestAccessToken() {} })
};`,
            });
        });

        await use(context);
    },

    injectedPage: async ({ context }, use) => {
        const page = await context.newPage();

        // Listen for console messages for debugging
        page.on('console', msg => {
            const text = msg.text();
            if (msg.type() === 'error') {
                if (text.includes('ERR_FAILED') || text.includes('net::ERR_')) return;
                const source = msg.location().url;
                console.log(`[Browser error]${source ? ` ${source}` : ''}: ${text}`);
            } else if (text.includes('[E2E]') || text.includes('[ASMR]') || text.includes('[ASMR Ultimate]') || text.includes('Bridge')) {
                console.log(`[Browser ${msg.type()}]: ${text}`);
            }
        });
        page.on('pageerror', err => {
            console.log(`[Page error]: ${err.message}`);
        });

        await ensureLoggedIn(page);
        await use(page);
    },

    isScriptLoaded: async ({ injectedPage }, use) => {
        const check = async () => {
            const start = Date.now();
            while (Date.now() - start < 15000) {
                const ready = await injectedPage.evaluate(() => {
                    const w = window as any;
                    return !!(w.ASMRUlt && w.__ASMR_KIKOERU_BRIDGE__?.store);
                }).catch(() => false);
                if (ready) return true;
                await sleep(250);
            }
            return false;
        };
        await use(check);
    },

    waitForBridge: async ({ injectedPage }, use) => {
        const wait = async (timeout = 15000) => {
            const start = Date.now();
            while (Date.now() - start < timeout) {
                const ready = await injectedPage.evaluate(() => {
                    try {
                        const w = window as any;
                        const bridgeReady = !!w.__ASMR_KIKOERU_BRIDGE__?.store;
                        const apiReady = !!w.ASMRUlt;
                        const mountedFeature =
                            !!document.querySelector('.asmr-header-actions') ||
                            !!document.querySelector('.asmr-playlist-btn') ||
                            !!document.querySelector('.asmr-vector-btn') ||
                            !!document.querySelector('#asmr-radio-toggle');
                        return bridgeReady && apiReady && mountedFeature;
                    } catch { return false; }
                }).catch(() => false);
                if (ready) return true;
                await sleep(500);
            }
            return false;
        };
        await use(wait);
    },
});

// Helper functions
export const helpers = {
    // Navigation helpers — reduced default waits for faster execution.
    // addInitScript ensures the script is ready early.
    async gotoHome(page: Page, waitMs = 0) {
        await gotoWithFallback(page, '/', waitMs);
    },

    async gotoWork(page: Page, workId: string, waitMs = 0) {
        await gotoWithFallback(page, `/work/${workId}`, waitMs);
    },

    async gotoSettings(page: Page, waitMs = 0) {
        await gotoWithFallback(page, '/settings', waitMs);
    },

    async gotoTags(page: Page, waitMs = 0) {
        await gotoWithFallback(page, '/tags', waitMs);
    },

    async gotoWorks(page: Page, waitMs = 0) {
        await gotoWithFallback(page, '/works', waitMs);
    },

    async gotoPlaylists(page: Page, waitMs = 0) {
        await gotoWithFallback(page, '/playlists', waitMs);
    },

    async gotoCircles(page: Page, waitMs = 0) {
        await gotoWithFallback(page, '/circles', waitMs);
    },

    async gotoVAs(page: Page, waitMs = 0) {
        await gotoWithFallback(page, '/vas', waitMs);
    },

    // Health monitoring
    async monitorHealth(page: Page, seconds: number) {
        const errors: string[] = [];
        const samples: Array<{ heap: number; dom: number }> = [];

        const errorHandler = (e: Error) => errors.push(e.message);
        page.on('pageerror', errorHandler);

        for (let i = 0; i < seconds; i++) {
            await sleep(1000);
            const m = await page.evaluate(() => ({
                heap: ((performance as any).memory?.usedJSHeapSize || 0) / 1024 / 1024,
                dom: document.querySelectorAll('*').length,
            })).catch(() => null);

            if (m) {
                samples.push(m);
                console.log(`  [${i + 1}s] ${m.heap.toFixed(1)}MB, ${m.dom} nodes`);
            } else {
                page.off('pageerror', errorHandler);
                return { alive: false, errors, samples };
            }
        }

        page.off('pageerror', errorHandler);
        return { alive: true, errors, samples };
    },

    // Track helpers
    getPlayableTrackButtons(page: Page) {
        const buttons = page.locator(
            '#work-tree .q-item .q-btn--round, ' +
            '.work-tree .q-item .q-btn--round, ' +
            '.asmr-flat-panel .q-item .q-btn--round',
        );
        return buttons.filter({
            has: page.locator('.q-icon, .material-icons').filter({ hasText: /^(?:play_arrow|pause)$/ }),
        });
    },

    async playFirstTrack(page: Page) {
        // The global fixture blocks media for memory savings. A real, tiny WAV
        // lets the host player mount so playback-dependent controls can be tested.
        await page.route(/\.(?:mp3|wav|flac|ogg|m4a)(?:\?|$)/i, route => route.fulfill({
            status: 200,
            contentType: 'audio/wav',
            body: TEST_AUDIO_BODY,
        }));
        const icon = page.locator('.q-icon, .material-icons').filter({ hasText: /^(?:play_arrow|pause)$/ });
        const flatButton = page.locator('.asmr-flat-panel .q-item .q-btn--round').filter({ has: icon }).first();
        let openedFlatPanel = false;
        if (!(await flatButton.isVisible({ timeout: 10000 }).catch(() => false))) {
            const panel = page.locator('.asmr-flat-panel--open');
            if (!(await panel.isVisible().catch(() => false))) {
                await page.locator('.asmr-flat-toggle').click();
                openedFlatPanel = true;
            }
        }
        const flatReady = await flatButton.waitFor({ state: 'visible', timeout: 15000 })
            .then(() => true)
            .catch(() => false);
        if (!flatReady && openedFlatPanel) {
            const close = page.locator('.asmr-flat-panel__close');
            if (await close.isVisible().catch(() => false)) await close.click();
            await page.locator('.asmr-flat-backdrop--visible').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
        }
        const button = flatReady ? flatButton : this.getPlayableTrackButtons(page).first();
        await button.waitFor({ state: 'visible', timeout: 20000 });
        await button.click();
        await page.waitForFunction(() => {
            const bridge = (window as any).__ASMR_KIKOERU_BRIDGE__;
            return !!(bridge?.currentTrack || bridge?._app?.$store?.state?.AudioPlayer?.currentTrack);
        }, { timeout: 10000 });
        await page.evaluate(() => {
            const store = (window as any).__ASMR_KIKOERU_BRIDGE__?.store;
            if (store?.state?.AudioPlayer?.hide) {
                store.commit?.('AudioPlayer/TOGGLE_HIDE');
            }
        });
        await sleep(500);
        if (!(await page.locator('.audio-player').isVisible().catch(() => false))) {
            const nowPlaying = page.locator('.q-footer .q-item, .player-bar .q-item').first();
            if (await nowPlaying.isVisible().catch(() => false)) {
                await nowPlaying.click();
            }
            await sleep(500);
        }
    },

    async getCurrentTrack(page: Page) {
        return page.evaluate(() => {
            const w = window as any;
            const bridge = w.__ASMR_KIKOERU_BRIDGE__;
            if (!bridge) return null;
            const track = bridge.currentTrack || bridge._app?.$store?.state?.AudioPlayer?.currentTrack;
            return track ? { title: track.title, hash: track.hash } : null;
        });
    },

    // Radio Mode Helpers
    getRadioStatus(page: Page) {
        return page.locator('#asmr-radio-status, .asmr-radio-status');
    },

    async isRadioActive(page: Page) {
        return page.evaluate(() => {
            const apiActive = (window as any).ASMRUlt?.isRadioActive?.();
            if (typeof apiActive === 'boolean') return apiActive;
            const status = document.querySelector('#asmr-radio-status, .asmr-radio-status');
            return status?.textContent?.includes('ON') ?? false;
        });
    },

    async toggleRadio(page: Page) {
        const toggle = page.locator('#asmr-radio-toggle, .asmr-radio-toggle');
        await toggle.click();
    },

    async isShuffleEnabled(page: Page) {
        return page.evaluate(() => {
            return (window as any).ASMRUlt?.get?.('shuffle') ?? false;
        });
    },

    // UI element locators
    getSidebar(page: Page) {
        return page.locator('.q-drawer--left, .q-drawer');
    },

    getHeaderActions(page: Page) {
        return page.locator('.asmr-header-actions');
    },

    getPlayerBar(page: Page) {
        return page.locator('.player-bar:visible, .q-footer:visible, .audio-player:visible').first();
    },

    getWorkTree(page: Page) {
        return page.locator('#work-tree, .work-tree');
    },

    async getWorkTreeItems(page: Page) {
        // The host now renders tree rows as direct list children without the
        // legacy `.q-item` class on some routes.
        return page.locator(
            '#work-tree .q-item, .work-tree .q-item, #work-tree .q-list > *, .work-tree .q-list > *'
        ).all();
    },

    // Flat view helpers
    getFlatViewButton(page: Page) {
        return page.locator('.asmr-flat-toggle');
    },

    async isFlatViewActive(page: Page) {
        const btn = this.getFlatViewButton(page);
        if (await btn.count() === 0) return false;
        const bg = await btn.evaluate(el => getComputedStyle(el).backgroundColor);
        return !bg.includes('66, 66, 66');
    },

    // Semantic search helpers
    getSemanticSearchButton(page: Page) {
        return page.locator('[data-asmr="semantic-search"]');
    },

    async openSemanticSearch(page: Page) {
        const btn = this.getSemanticSearchButton(page);
        await btn.click();
        await page.locator('.asmr-vector-dialog').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
        await sleep(300);
    },

    async isSemanticSearchOpen(page: Page) {
        const dialog = page.locator('.asmr-vector-dialog');
        return await dialog.isVisible();
    },

    async getIndexCount(page: Page): Promise<number> {
        return page.evaluate(() => {
            const status = document.querySelector('.asmr-vector-status');
            if (!status) return 0;
            const text = status.textContent || '';
            const match = text.match(/(\d+)/);
            return match ? parseInt(match[1], 10) : 0;
        });
    },

    getPlaylistMakerButton(page: Page) {
        return page.locator('.asmr-playlist-btn');
    },

    // Translation helpers
    async hasTranslations(page: Page) {
        return page.evaluate(() => {
            const items = document.querySelectorAll('.q-item__label, .q-chip__content');
            for (const item of items) {
                const text = item.textContent || '';
                if (/[\u3040-\u30ff\u4e00-\u9faf].*\(.*[a-zA-Z].*\)/.test(text)) {
                    return true;
                }
            }
            return false;
        });
    },

    // Settings helpers
    getSettingsSection(page: Page) {
        return page.locator('.asmr-settings-group, [data-asmr="settings"]');
    },

    async hasSettingsSections(page: Page) {
        return {
            radio: await page.locator('#asmr-radio-settings-section').count() > 0,
            playlist: await page.locator('#asmr-playlist-settings-section').count() > 0,
            translation: await page.locator('#asmr-translation-settings-section').count() > 0,
            whisper: await page.locator('#asmr-whisper-settings-section').count() > 0,
            storage: await page.locator('#asmr-storage-settings-section').count() > 0,
            emergency: await page.locator('#asmr-emergency-export-section').count() > 0,
        };
    },

    async getToggleState(page: Page, name: string): Promise<boolean> {
        const toggle = page.locator(`.asmr-toggle[data-key="${name}"] .q-toggle__inner`);
        if (await toggle.count() === 0) return false;
        const classes = await toggle.getAttribute('class');
        // The class used by SettingsManager is q-toggle__inner--truthy
        return classes?.includes('q-toggle__inner--truthy') ?? false;
    },

    async clickToggle(page: Page, name: string) {
        // Click the toggle wrapper div (the inner checkbox is hidden in Quasar)
        const toggle = page.locator(`.asmr-toggle[data-key="${name}"]`);
        await toggle.click({ force: true });
    },

    async getConfig(page: Page, key: string) {
        // Read directly from GM storage (localStorage with GM_ prefix)
        return page.evaluate((k) => {
            try {
                const val = localStorage.getItem('GM_' + k);
                return val !== null ? JSON.parse(val) : undefined;
            } catch {
                return undefined;
            }
        }, key);
    },

    // Whisper helpers
    getWhisperButton(page: Page) {
        return page.locator('.asmr-whisper-btn');
    },

    async isWhisperLoading(page: Page) {
        const btn = this.getWhisperButton(page).first();
        if (await btn.count() === 0) return false;
        const classes = await btn.getAttribute('class');
        return classes?.includes('loading') || classes?.includes('asmr-whisper-loading') || false;
    },

    // Learner mode helpers
    getLearnerControls(page: Page) {
        return page.locator('.learner-controls, .learner-collapsed-controls, .asmr-learner-controls');
    },

    // Playlist Mode Helpers
    async openAdvancedSearch(page: Page) {
        const btn = this.getPlaylistMakerButton(page);
        await btn.first().waitFor({ state: 'visible', timeout: 15000 });
        await btn.click();
        await sleep(1000);
    },

    async isPlaylistModeActive(page: Page): Promise<boolean> {
        return page.evaluate(() => {
            const api = (window as any).ASMRUlt;
            return api?.isPlaylistActive?.() ?? false;
        });
    },

    async activatePlaylistMode(page: Page, workIds: string[]): Promise<void> {
        await page.evaluate((ids) => {
            const api = (window as any).ASMRUlt;
            if (api?.activatePlaylist) {
                api.activatePlaylist(ids);
            }
        }, workIds);
        await sleep(500);
    },

    async deactivatePlaylistMode(page: Page): Promise<void> {
        await page.evaluate(() => {
            const api = (window as any).ASMRUlt;
            api?.deactivatePlaylist?.();
        });
        await sleep(500);
    },

    async getPlaylistProgress(page: Page): Promise<{ current: number; total: number; workId: string | null }> {
        return page.evaluate(() => {
            const api = (window as any).ASMRUlt;
            return api?.getPlaylistProgress?.() ?? { current: 0, total: 0, workId: null };
        });
    },

    getPlaylistControls(page: Page) {
        return page.locator('.asmr-playlist-controls');
    },

    getPlaylistPrevButton(page: Page) {
        return page.locator('.asmr-playlist-prev');
    },

    getPlaylistNextButton(page: Page) {
        return page.locator('.asmr-playlist-next');
    },

    getPlaylistProgressDisplay(page: Page) {
        return page.locator('.asmr-playlist-progress');
    },

    getAdvancedSearchDialog(page: Page) {
        return page.locator('.asmr-advanced-search-dialog');
    },

    // Playback Progress Helpers
    getTrackCheckmark(page: Page, trackIndex: number) {
        return page.locator('.q-item, .file-row').nth(trackIndex).locator('.q-icon[name="check"], .text-positive');
    },

    async isWorkCompleted(page: Page) {
        const markBtn = page.locator('.asmr-mark-btn, [data-asmr="mark-work"]');
        if (await markBtn.count() > 0) {
            const text = await markBtn.textContent();
            return text?.includes('Completed') || text?.includes('済') || false;
        }
        return false;
    },

    // Theme helpers
    async isDarkMode(page: Page) {
        return page.evaluate(() => {
            return document.body.classList.contains('body--dark') ||
                document.documentElement.classList.contains('dark');
        });
    },

    // Work Tree helpers
    async toggleFlatView(page: Page) {
        const btn = page.locator('.asmr-flat-toggle');
        // Use force:true because backdrop may intercept clicks when panel is open
        await btn.click({ force: true });
        await sleep(1000);
    },

    getFlatViewContainer(page: Page) {
        return page.locator('.asmr-flat-panel');
    },

    async getFlatViewItems(page: Page) {
        return page.locator('.asmr-flat-panel .q-item[data-asmr-flat-idx]').all();
    },

    async getFlatViewItemTexts(page: Page) {
        const items = await page.locator('.asmr-flat-panel .q-item[data-asmr-flat-idx] .q-item__label').allTextContents();
        return items;
    },

    isFlatPanelOpen(page: Page) {
        return page.locator('.asmr-flat-panel--open');
    },

    getBreadcrumbs(page: Page) {
        return page.locator('#work-tree .q-breadcrumbs, .work-tree .q-breadcrumbs');
    },

    async getBreadcrumbTexts(page: Page) {
        return page.locator('#work-tree .q-breadcrumbs .q-btn__content, .work-tree .q-breadcrumbs .q-btn__content').allTextContents();
    },

    async getWorkTreeFolderCount(page: Page) {
        return page.locator('#work-tree .q-item .q-icon[name="folder"], #work-tree .q-icon[color="amber"]').count();
    },

    /** @deprecated Native tree is no longer hidden - flat view is a side panel */
    async isNativeTreeHidden(_page: Page) {
        return false;
    },

    async getWorkTreeAudioItemCount(page: Page) {
        // Audio items have round play buttons, not folder/description icons
        return page.locator('#work-tree .q-item .q-btn--round, .work-tree .q-item .q-btn--round').count();
    },
};

export const TEST_WORKS = {
    STANDARD: 'RJ01052162',
    WITH_SUBTITLES: 'RJ01052162',
    ALTERNATIVE: 'RJ01382560',
    EMPTY: 'RJ999999',
};

export { expect };
