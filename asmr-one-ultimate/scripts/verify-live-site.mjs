import path from 'path';
import { chromium } from 'playwright';

const root = process.cwd();
const userScriptPath = path.resolve(root, 'dist/asmr-one-ultimate.user.js');
const targetUrl = 'https://asmr.one/';

const browser = await chromium.launch();
const page = await browser.newPage();

page.on('pageerror', (err) => {
  console.error('[playwright] pageerror:', err);
});
page.on('console', (msg) => {
  console.log(`[browser:${msg.type()}]`, msg.text());
});

await page.addInitScript(() => {
  window.GM_getValue = (key, defaultValue) => defaultValue;
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

    if (url.includes('api.jina.ai')) {
      respondText(JSON.stringify({ data: [{ embedding: [0, 0, 0] }] }));
      return;
    }

    if (options?.responseType === 'blob') {
      respondBlob(new Blob(['test']));
      return;
    }

    fetch(url, { method: options?.method || 'GET' })
      .then(async (res) => {
        const text = await res.text();
        options?.onload?.({ status: res.status, responseText: text });
      })
      .catch((err) => options?.onerror?.(err));
  };
});

await page.addInitScript({ path: userScriptPath });

await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForSelector('#q-app', { timeout: 20000 });
await page.waitForFunction(() => window.ASMRUlt !== undefined, { timeout: 20000 });

const selectors = [
  '.asmr-playlist-btn',
  '.asmr-vector-btn',
  '.asmr-filter-overlay'
];

for (const selector of selectors) {
  await page.waitForSelector(selector, { timeout: 20000, state: 'attached' });
}

console.log('Playwright live site check: OK');
await browser.close();
