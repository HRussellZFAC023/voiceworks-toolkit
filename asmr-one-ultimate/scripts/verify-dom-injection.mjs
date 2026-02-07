import path from 'path';
import { pathToFileURL } from 'url';
import { chromium } from 'playwright';

const root = process.cwd();
const fixturePath = path.resolve(root, 'tests/fixtures/injection.html');
const userScriptPath = path.resolve(root, 'dist/asmr-one-ultimate.user.js');
const fixtureUrl = pathToFileURL(fixturePath).href;

const browser = await chromium.launch();
const page = await browser.newPage();

page.on('pageerror', (err) => {
  console.error('[playwright] pageerror:', err);
});
page.on('console', (msg) => {
  console.log(`[browser:${msg.type()}]`, msg.text());
});

await page.addInitScript(() => {
  window.GM_getValue = (key, defaultValue) => {
    if (key === 'autoFilterFolders') return false;
    return defaultValue;
  };
  window.GM_setValue = () => {};
  window.GM_addStyle = () => {};
  window.unsafeWindow = window;
  window.GM_xmlhttpRequest = (options) => {
    const url = String(options?.url || '');
    const respondText = (text) => options?.onload?.({ status: 200, responseText: text });
    const respondBlob = (blob) => options?.onload?.({ status: 200, response: blob });

    if (url.includes('/tags')) {
      respondText('<html><body><a href="/tags/53">Ear Cleaning</a></body></html>');
      return;
    }

    if (url.includes('translate.googleapis.com')) {
      respondText('[[["Translated","",null,null,1]]]');
      return;
    }

    if (options?.responseType === 'blob') {
      respondBlob(new Blob(['test']));
      return;
    }

    options?.onerror?.(new Error(`Unhandled GM_xmlhttpRequest URL: ${url}`));
  };
});

await page.goto(fixtureUrl, { waitUntil: 'load' });

await page.evaluate(() => {
  const store = {
    state: {
      AudioPlayer: {
        currentTime: 0,
        duration: 120,
        playMode: 'order',
        currentTrack: {
          title: 'Test Track',
          duration: 120,
          src: 'https://example.com/audio.mp3'
        },
        work: {
          id: 'RJ000000',
          title: 'Test Work',
          tracks: [{ id: 'track-1', title: 'Track 1' }],
          dirs: []
        }
      },
      User: { marks: { 'track-1': 3 } },
      Works: { searchParams: {} }
    },
    dispatch: () => Promise.resolve(),
    commit: () => {},
    watch: () => () => {},
    _actions: { 'AudioPlayer/setPlaylist': [] }
  };

  const app = {
    $store: store,
    $router: {
      currentRoute: { query: {} },
      push: () => Promise.resolve(),
      replace: () => Promise.resolve()
    },
    $axios: {
      get: () => Promise.resolve({ data: { works: [] } }),
      post: () => Promise.resolve({})
    },
    $watch: () => {},
    $route: { params: {}, query: {}, path: '/work/RJ000000' }
  };

  const root = document.getElementById('q-app');
  if (root) root.__vue__ = app;
});

await page.addScriptTag({ path: userScriptPath });
await page.waitForFunction(() => window.ASMRUlt !== undefined, { timeout: 10000 });

const selectors = [
  '.asmr-playlist-btn',
  '.asmr-vector-btn',
  '.asmr-flat-toggle',
  '.learner-subs-expanded',
  '.learner-subs-collapsed',
  '.asmr-whisper-btn',
  '.asmr-filter-overlay',
  '.asmr-check'
];

for (const selector of selectors) {
  await page.waitForSelector(selector, { timeout: 10000, state: 'attached' });
}

console.log('Playwright DOM injection check: OK');
await browser.close();
