import 'fake-indexeddb/auto';
import fs from 'fs';
import path from 'path';
import { vi, beforeEach } from 'vitest';

// --- Global GM Storage Mock ---
const gmStorage = new Map<string, any>();

// --- Global Mocks (MUST be before any imports that use them) ---
(globalThis as any).GM_setValue = vi.fn((key: string, val: any) => {
    gmStorage.set(key, val);
});
(globalThis as any).GM_getValue = vi.fn((key: string, def: any) => {
    return gmStorage.has(key) ? gmStorage.get(key) : def;
});
(globalThis as any).GM_deleteValue = vi.fn((key: string) => {
    gmStorage.delete(key);
});
(globalThis as any).GM_listValues = vi.fn(() => Array.from(gmStorage.keys()));

(globalThis as any).unsafeWindow = window as any;

// Mock Console to avoid noise
console.log = vi.fn();
console.warn = vi.fn();
console.error = vi.fn();

// Mock fetch
(globalThis as any).fetch = vi.fn((_url: string) => {
    return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ success: true })),
        json: () => Promise.resolve({ success: true }),
        blob: () => Promise.resolve(new Blob(['test'])),
        headers: new Headers()
    });
});

// Mock '$' module (vitescripts/monkey)
vi.mock('$', () => ({
    GM_getValue: (key: string, def: any) => (globalThis as any).GM_getValue(key, def),
    GM_setValue: (key: string, val: any) => (globalThis as any).GM_setValue(key, val),
    GM_deleteValue: (key: string) => (globalThis as any).GM_deleteValue(key),
    GM_listValues: () => (globalThis as any).GM_listValues(),
    GM_xmlhttpRequest: (opt: any) => (globalThis as any).GM_xmlhttpRequest(opt),
    unsafeWindow: (globalThis as any).unsafeWindow,
    monkeyWindow: globalThis,
}));

const fixturesDir = path.resolve(process.cwd(), 'tests/fixtures');
const dlsiteDummy = fs.existsSync(path.join(fixturesDir, 'dlsite_dummy.html'))
    ? fs.readFileSync(path.join(fixturesDir, 'dlsite_dummy.html'), 'utf8')
    : '<html><body>Dummy</body></html>';
const tagsFixture = '<html><body><a href="/tags/53">Ear Cleaning</a></body></html>';

// Mock GM_xmlhttpRequest
(globalThis as any).GM_xmlhttpRequest = vi.fn((options: any) => {
    const url = String(options?.url || '');
    const respondText = (text: string) => {
        options?.onload?.({ status: 200, responseText: text, responseHeaders: '' });
    };
    const respondBlob = (blob: Blob) => {
        options?.onload?.({ status: 200, response: blob, responseHeaders: '' });
    };

    if (url.includes('dlsite.com')) {
        respondText(dlsiteDummy);
        return;
    }

    if (url.includes('/tags')) {
        respondText(tagsFixture);
        return;
    }

    if (options?.responseType === 'blob') {
        respondBlob(new Blob(['test']));
        return;
    }

    options?.onload?.({ status: 200, responseText: '{}', response: {}, responseHeaders: '' });
});

// Import Bridge AFTER mocks
import { KikoeruBridge } from '../src/infrastructure/KikoeruBridge';

beforeEach(() => {
    (KikoeruBridge as any).instance = null;
    delete (globalThis as any).__ASMR_KIKOERU_BRIDGE__;
    delete (window as any).__ASMR_KIKOERU_BRIDGE__;
    gmStorage.clear();
    vi.useRealTimers();
});
