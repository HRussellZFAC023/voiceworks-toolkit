/** Emergency export and the header Download Center share playlist fixtures. */
import { test, expect, helpers } from './fixtures';
import type { Download, Page } from '@playwright/test';
import * as fs from 'fs';
import { execFileSync } from 'child_process';

const OWN_ID = '11111111-2222-4333-8444-555555555555';
const PUBLIC_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const FFPROBE_PATH = process.env.FFPROBE_PATH
    || (fs.existsSync('/opt/homebrew/bin/ffprobe') ? '/opt/homebrew/bin/ffprobe' : 'ffprobe');
let hasFfprobe = true;
try { execFileSync(FFPROBE_PATH, ['-version'], { stdio: 'ignore' }); } catch { hasFfprobe = false; }

function tinyWav(): Buffer {
    const samples = 1600; const dataSize = samples * 2; const output = Buffer.alloc(44 + dataSize);
    output.write('RIFF', 0); output.writeUInt32LE(36 + dataSize, 4); output.write('WAVEfmt ', 8);
    output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20); output.writeUInt16LE(1, 22);
    output.writeUInt32LE(16000, 24); output.writeUInt32LE(32000, 28); output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34);
    output.write('data', 36); output.writeUInt32LE(dataSize, 40);
    for (let index = 0; index < samples; index += 1) output.writeInt16LE(Math.round(Math.sin(index / 12) * 4000), 44 + index * 2);
    return output;
}

async function mockPlaylistApis(page: Page): Promise<void> {
    await page.route('**/community-playlists/catalog.json*', route => route.fulfill({
        status: 200, contentType: 'application/json', headers: { etag: '"e2e-catalog"' },
        body: JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), playlists: [{
            id: PUBLIC_ID, name: 'Community calm', userName: 'Public curator', worksCount: 1,
            coverUrl: 'https://media.e2e/public.jpg', tags: ['Relaxing'],
        }] }),
    }));
    await page.route('**/community-playlists/*.json*', route => {
        if (route.request().url().includes('/community-playlists/catalog.json')) return route.fallback();
        return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'cache miss' }) });
    });
    await page.route('**/api/playlist/get-playlists*', route => route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify({
            playlists: [{ id: OWN_ID, name: 'My Precious Playlist', description: 'mine', privacy: 0, works: [], works_count: 1, user_name: 'E2E' }],
            pagination: { currentPage: 1, pageSize: 100, totalCount: 1 },
        }),
    }));
    await page.route('**/api/playlist/get-playlist-metadata*', route => {
        const id = new URL(route.request().url()).searchParams.get('id') || '';
        const own = id.toLowerCase() === OWN_ID;
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
            id, name: own ? 'My Precious Playlist' : 'Community calm', description: own ? 'mine' : 'public',
            privacy: own ? 0 : 2, user_name: own ? 'E2E' : 'Public curator', works: [], works_count: 1,
        }) });
    });
    await page.route('**/api/playlist/get-playlist-works*', route => {
        const id = new URL(route.request().url()).searchParams.get('id') || '';
        const works = id.toLowerCase() === OWN_ID
            ? [{ id: 111111, source_id: 'RJ111111', title: 'Own Work One' }]
            : [{ id: 333333, source_id: 'RJ333333', title: 'Community Work' }];
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
            works, pagination: { currentPage: 1, pageSize: 100, totalCount: works.length },
        }) });
    });
    await page.route('**/api/search/**', route => route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify({
            works: [{
                id: 999999, title: 'Direct search result', duration: 600,
                thumbnailCoverUrl: 'https://media.e2e/direct-cover.jpg', tags: [{ name: 'Direct tag' }],
            }],
            pagination: { currentPage: 1, pageSize: 20, totalCount: 1 },
        }),
    }));
    await page.route('**/api/tracks/999999*', route => route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify([
            { type: 'audio', hash: 'direct-audio', title: 'direct.wav', size: 1024 * 1024, mediaDownloadUrl: 'https://media.e2e/direct.wav' },
            { type: 'image', hash: 'direct-cover', title: 'cover.jpg', size: 512 * 1024, mediaDownloadUrl: 'https://media.e2e/direct-cover.jpg' },
        ]),
    }));
    await page.route('https://media.e2e/direct-cover.jpg', route => route.fulfill({
        status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z6CsAAAAASUVORK5CYII=', 'base64'),
    }));
}

async function mockOwnPlaylist(page: Page, input: { id: string; name: string; works: Array<{ id: number; source_id: string; title: string }> }): Promise<void> {
    await page.route('**/api/playlist/get-playlists*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        playlists: [{ id: input.id, name: input.name, privacy: 0, works: [], works_count: input.works.length }],
        pagination: { currentPage: 1, pageSize: 100, totalCount: 1 },
    }) }));
    await page.route('**/api/playlist/get-playlist-metadata*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        id: input.id, name: input.name, privacy: 0, works: [], works_count: input.works.length, user_name: 'E2E',
    }) }));
    await page.route('**/api/playlist/get-playlist-works*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        works: input.works, pagination: { currentPage: 1, pageSize: 100, totalCount: input.works.length },
    }) }));
}

async function openEmergencySection(page: Page) {
    const section = page.locator('#asmr-emergency-export-section');
    await expect(section).toBeVisible({ timeout: 15_000 });
    await section.scrollIntoViewIfNeeded();
    return section;
}

async function openDownloadCenter(page: Page, timeout = 5_000, signedIn = true): Promise<void> {
    await page.evaluate((authenticated) => {
        if (authenticated) localStorage.setItem('jwt-token', 'e2e-token');
        else localStorage.removeItem('jwt-token');
    }, signedIn);
    const button = page.getByTestId('download-center-open');
    await expect(button).toBeVisible({ timeout: 15_000 });
    await button.click();
    await expect(page.getByTestId('backup-downloader')).toBeVisible({ timeout });
}

async function readDownload(download: Download): Promise<string> {
    return fs.readFileSync((await download.path())!, 'utf8');
}

test.describe('Emergency export and Download Center', () => {
    test.beforeEach(async ({ injectedPage }) => { await mockPlaylistApis(injectedPage); });

    test('JSON export keeps own and server-catalog community playlists separate', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoSettings(injectedPage); await isScriptLoaded(); await openEmergencySection(injectedPage);
        const pending = injectedPage.waitForEvent('download');
        await injectedPage.getByTestId('emergency-export-json').click();
        const doc = JSON.parse(await readDownload(await pending));
        expect(doc.format).toBe('asmr-one-ultimate-playlist-backup');
        expect(doc.ownPlaylists).toHaveLength(1);
        expect(doc.ownPlaylists[0]).toMatchObject({ id: OWN_ID, name: 'My Precious Playlist' });
        expect(doc.ownPlaylists[0].works).toEqual([{ rjCode: 'RJ111111', title: 'Own Work One' }]);
        expect(doc.publicPlaylists).toHaveLength(1);
        expect(doc.publicPlaylists[0]).toMatchObject({ id: PUBLIC_ID, userName: 'Public curator' });
        expect(doc.publicPlaylists[0].works[0].rjCode).toBe('RJ333333');
    });

    test('CSV and TXT exports still produce separate own/community files', async ({ injectedPage, isScriptLoaded }) => {
        test.setTimeout(120_000);
        await helpers.gotoSettings(injectedPage); await isScriptLoaded(); await openEmergencySection(injectedPage);
        for (const format of ['csv', 'txt'] as const) {
            const downloads: Download[] = [];
            const listener = (download: Download) => downloads.push(download);
            injectedPage.on('download', listener);
            await injectedPage.getByTestId(`emergency-export-${format}`).click();
            await expect.poll(() => downloads.length, { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
            const own = downloads.find(item => item.suggestedFilename().includes('-own-'))!;
            const community = downloads.find(item => item.suggestedFilename().includes('-public-'))!;
            expect(await readDownload(own)).toContain('RJ111111');
            expect(await readDownload(community)).toContain('RJ333333');
            injectedPage.off('download', listener);
        }
    });

    test('opens instantly on Site and lazily fetches personal and community playlists', async ({ injectedPage, isScriptLoaded }) => {
        let communityCatalogRequests = 0;
        let publicWorksRequests = 0;
        let releaseOwn!: () => void;
        const ownGate = new Promise<void>(resolve => { releaseOwn = resolve; });
        await injectedPage.route('**/api/playlist/get-playlists*', async route => {
            await ownGate;
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
                playlists: [{ id: OWN_ID, name: 'My Precious Playlist', privacy: 0, works: [], works_count: 1 }],
                pagination: { currentPage: 1, pageSize: 100, totalCount: 1 },
            }) });
        });
        injectedPage.on('request', request => {
            if (request.url().includes('/community-playlists/catalog.json')) communityCatalogRequests += 1;
            if (request.url().includes('/get-playlist-works') && request.url().includes(PUBLIC_ID)) publicWorksRequests += 1;
        });
        await helpers.gotoHome(injectedPage); await isScriptLoaded();
        communityCatalogRequests = 0;
        await openDownloadCenter(injectedPage, 500);
        await expect(injectedPage.getByTestId('source-site')).toHaveAttribute('aria-selected', 'true');
        await expect(injectedPage.getByTestId('playlist-loading')).toHaveCount(0);
        await injectedPage.getByTestId('source-own').click();
        await expect(injectedPage.getByTestId('playlist-loading')).toBeVisible();
        expect(communityCatalogRequests).toBe(0);
        releaseOwn();
        await expect(injectedPage.getByTestId(`playlist-${OWN_ID}`)).toBeVisible();
        expect(publicWorksRequests).toBe(0);
        await injectedPage.getByTestId('source-public').click();
        await expect(injectedPage.getByTestId(`playlist-${PUBLIC_ID}`)).toBeVisible();
        expect(communityCatalogRequests).toBeGreaterThanOrEqual(1);
        expect(publicWorksRequests).toBe(0);
        await injectedPage.getByTestId(`expand-${PUBLIC_ID}`).click();
        await expect(injectedPage.getByTestId('work-RJ333333')).toBeVisible();
        expect(publicWorksRequests).toBe(1);
    });

    test('opens signed-out users on Site and keeps Community separate', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoHome(injectedPage); await isScriptLoaded();
        await openDownloadCenter(injectedPage, 5_000, false);

        await expect(injectedPage.getByTestId('source-own')).toHaveCount(0);
        await expect(injectedPage.getByTestId('source-site')).toHaveAttribute('aria-selected', 'true');
        await expect(injectedPage.getByTestId(`playlist-${PUBLIC_ID}`)).toHaveCount(0);
        await expect(injectedPage.getByTestId('source-load-error')).toHaveCount(0);
        await expect(injectedPage.getByText('Find playlists or works', { exact: true })).toBeVisible();
        await expect(injectedPage.getByTestId('search-all-works')).toHaveText('Search');
        await injectedPage.getByTestId('search').fill('RJ999999');
        await injectedPage.getByTestId('search-all-works').click();
        await expect(injectedPage.getByTestId('search-work-RJ999999')).toBeVisible();
        await expect(injectedPage.getByTestId('search-work-RJ999999').locator('.work-cover img')).toHaveAttribute('src', 'https://media.e2e/direct-cover.jpg');
        await expect(injectedPage.getByTestId('search-work-RJ999999')).toContainText('1.5 MB');
        await injectedPage.getByTestId('source-public').click();
        await expect(injectedPage.getByTestId(`playlist-${PUBLIC_ID}`)).toBeVisible();
        await expect(injectedPage.getByTestId('all-work-results')).toHaveCount(0);
    });

    test('offers themed selection, clear-all, tags, options, and direct work search in one modal', async ({ injectedPage, isScriptLoaded }) => {
        await injectedPage.setViewportSize({ width: 390, height: 844 });
        await helpers.gotoHome(injectedPage); await isScriptLoaded(); await openDownloadCenter(injectedPage);
        await injectedPage.getByTestId('source-own').click();
        await injectedPage.getByTestId(`playlist-check-${OWN_ID}`).check();
        await expect(injectedPage.getByTestId('selection-summary')).toContainText('1');
        await injectedPage.getByTestId('clear-all').click();
        await expect(injectedPage.getByTestId('start')).toBeDisabled();
        await injectedPage.getByTestId('source-public').click();
        await expect(injectedPage.getByTestId('tag-filter')).toContainText('Relaxing');
        await injectedPage.getByTestId('source-site').click();
        // Exact RJ lookup intentionally exercises the live-API fallback even
        // when the hosted semantic baseline is available in this real shell.
        await injectedPage.getByTestId('search').fill('RJ999999');
        await injectedPage.getByTestId('search-all-works').click();
        await expect(injectedPage.getByTestId('search-work-RJ999999')).toBeVisible();
        await injectedPage.getByTestId('search-work-RJ999999').locator('input').check();
        await injectedPage.getByTestId('opus-toggle').check();
        await expect(injectedPage.getByTestId('artwork-toggle')).toBeVisible();
        await expect(injectedPage.getByTestId('download-center-import-input')).toHaveCount(0);
        const layout = await injectedPage.evaluate(() => {
            const rect = (selector: string) => {
                const value = document.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
                if (!value) throw new Error(`Missing ${selector}`);
                return { top: value.top, bottom: value.bottom };
            };
            return {
                opus: rect('[data-testid="opus-option"]'),
                bitrate: rect('[data-testid="opus-bitrate-option"]'),
                metadata: rect('[data-testid="metadata-options"]'),
                artwork: rect('[data-testid="artwork-option"]'),
                artworkLabel: rect('[data-testid="artwork-option"] .option-row'),
                artworkHint: rect('[data-testid="artwork-option"] .hint'),
            };
        });
        expect(layout.bitrate.top).toBeGreaterThan(layout.opus.bottom);
        expect(layout.artwork.top).toBeGreaterThan(layout.metadata.bottom);
        expect(layout.artworkHint.top).toBeGreaterThanOrEqual(layout.artworkLabel.bottom);
        expect(await injectedPage.getByTestId('backup-downloader').evaluate(el => el.scrollWidth <= window.innerWidth + 1)).toBe(true);
    });

    test('downloads a complete selected work folder while keeping progress in the modal', async ({ injectedPage, isScriptLoaded }) => {
        await injectedPage.route('**/api/tracks/111111*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{
            type: 'folder', title: 'Audio', children: [
                { type: 'audio', hash: 'audio', title: 'track.wav', size: 4, mediaDownloadUrl: 'https://media.e2e/track.wav' },
                { type: 'image', hash: 'cover', title: 'cover.jpg', size: 3, mediaDownloadUrl: 'https://media.e2e/cover.jpg' },
            ],
        }]) }));
        await injectedPage.route('**/api/workInfo/111111*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
            id: 111111, source_id: 'RJ111111', title: 'Own Work One', name: 'Circle', circle_id: 1, circle: { name: 'Circle' },
            vas: [], tags: [], release: '2026-01-01', source_url: '', mainCoverUrl: '', thumbnailCoverUrl: '', samCoverUrl: '',
        }) }));
        await injectedPage.route('https://media.e2e/track.wav', route => route.fulfill({ status: 200, body: Buffer.from([1, 2, 3, 4]), headers: { 'content-length': '4' } }));
        await injectedPage.route('https://media.e2e/cover.jpg', route => route.fulfill({ status: 200, body: Buffer.from([5, 6, 7]), headers: { 'content-length': '3' } }));
        await helpers.gotoHome(injectedPage); await isScriptLoaded();
        await injectedPage.evaluate(() => { (window as any).showDirectoryPicker = () => navigator.storage.getDirectory(); });
        await openDownloadCenter(injectedPage);
        await injectedPage.getByTestId('source-own').click();
        await injectedPage.getByTestId(`playlist-check-${OWN_ID}`).check();
        await injectedPage.getByTestId('title-mode').selectOption('original');
        await injectedPage.getByTestId('start').click();
        await expect(injectedPage.getByTestId('download-progress')).toContainText(/downloaded|download complete|保存|下载/i, { timeout: 30_000 });
        await expect(injectedPage.getByTestId('backup-downloader')).toBeVisible();
        const files = await injectedPage.evaluate(async () => {
            const root = await navigator.storage.getDirectory(); const work = await root.getDirectoryHandle('Own Work One'); const audio = await work.getDirectoryHandle('Audio');
            const read = async (name: string) => [...new Uint8Array(await (await (await audio.getFileHandle(name)).getFile()).arrayBuffer())];
            return { track: await read('track.wav'), cover: await read('cover.jpg') };
        });
        expect(files).toEqual({ track: [1, 2, 3, 4], cover: [5, 6, 7] });
    });

    test('offers a recovered interrupted job in the header modal after refresh', async ({ injectedPage, isScriptLoaded }) => {
        await injectedPage.route('https://media.e2e/resume.wav', route => route.fulfill({ status: 206, body: Buffer.from([3, 4]), headers: {
            'content-range': 'bytes 2-3/4', 'content-length': '2', etag: 'v1', 'accept-ranges': 'bytes',
        } }));
        await helpers.gotoHome(injectedPage); await isScriptLoaded();
        await injectedPage.evaluate(async () => {
            const root = await navigator.storage.getDirectory(); const folder = await root.getDirectoryHandle('Resume work', { create: true });
            const handle = await folder.getFileHandle('track.wav', { create: true }); const writable = await handle.createWritable();
            await writable.write(new Uint8Array([1, 2])); await writable.close();
            await new Promise<void>((resolve, reject) => {
                const request = indexedDB.open('asmr-one-downloads', 1);
                request.onupgradeneeded = () => { const db = request.result; const jobs = db.createObjectStore('jobs', { keyPath: 'id' }); jobs.createIndex('by-status', 'status'); const files = db.createObjectStore('files', { keyPath: 'id' }); files.createIndex('by-job', 'jobId'); files.createIndex('by-job-status', ['jobId', 'status']); const checkpoints = db.createObjectStore('checkpoints', { keyPath: 'fileId' }); checkpoints.createIndex('by-job', 'jobId'); };
                request.onsuccess = () => { const db = request.result; const tx = db.transaction(['jobs', 'files', 'checkpoints'], 'readwrite'); const now = Date.now();
                    tx.objectStore('jobs').put({ id: 'resume-job', title: 'Resume job', status: 'paused', options: { state: { convertToOpus: false }, directory: root, enrichment: {} }, createdAt: now, updatedAt: now });
                    tx.objectStore('files').put({ id: 'resume-file', jobId: 'resume-job', path: 'Resume work/track.wav', url: 'https://media.e2e/resume.wav', status: 'paused', downloadedBytes: 2, totalBytes: 4, createdAt: now, updatedAt: now });
                    tx.objectStore('checkpoints').put({ fileId: 'resume-file', jobId: 'resume-job', offset: 2, etag: 'v1', updatedAt: now });
                    tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
                request.onerror = () => reject(request.error);
            });
        });
        await injectedPage.reload({ waitUntil: 'domcontentloaded' });
        await openDownloadCenter(injectedPage);
        await expect(injectedPage.getByTestId('resume-resume-job')).toBeVisible({ timeout: 15_000 });
        await injectedPage.getByTestId('resume-resume-job').click();
        await expect(injectedPage.getByTestId('download-progress')).toContainText(/downloaded|download complete|保存|下载/i, { timeout: 30_000 });
        const bytes = await injectedPage.evaluate(async () => { const root = await navigator.storage.getDirectory(); const file = await (await (await root.getDirectoryHandle('Resume work')).getFileHandle('track.wav')).getFile(); return [...new Uint8Array(await file.arrayBuffer())]; });
        expect(bytes).toEqual([1, 2, 3, 4]);
    });

    test('resumes persisted work discovery after a refresh without restarting the selection', async ({ injectedPage, isScriptLoaded }) => {
        test.setTimeout(120_000);
        const playlistId = '88888888-1111-4222-8333-444444444444';
        await mockOwnPlaylist(injectedPage, { id: playlistId, name: 'Discovery', works: [{ id: 888888, source_id: 'RJ888888', title: 'Discovery work' }] });
        let trackRequests = 0;
        let releaseCancelledRequest: (() => void) | undefined;
        await injectedPage.route('**/api/tracks/888888*', async route => {
            trackRequests += 1;
            if (trackRequests === 1) {
                await new Promise<void>(resolve => { releaseCancelledRequest = resolve; });
                return;
            }
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{
                type: 'folder', title: 'Audio', children: [{ type: 'audio', hash: 'resume-discovery', title: 'track.wav', mediaDownloadUrl: 'https://media.e2e/discovery.wav' }],
            }]) });
        });
        await injectedPage.route('**/api/workInfo/888888*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
            id: 888888, source_id: 'RJ888888', title: 'Discovery work', name: 'Circle', circle: { name: 'Circle' }, vas: [], tags: [],
            release: '2026-01-01', source_url: '', mainCoverUrl: '', thumbnailCoverUrl: '', samCoverUrl: '',
        }) }));
        await injectedPage.route('https://media.e2e/discovery.wav', route => route.fulfill({ status: 200, body: Buffer.from([8, 8, 8]) }));
        await helpers.gotoHome(injectedPage); await isScriptLoaded();
        await injectedPage.evaluate(() => { (window as any).showDirectoryPicker = () => navigator.storage.getDirectory(); });
        await openDownloadCenter(injectedPage);
        await injectedPage.getByTestId('source-own').click();
        await injectedPage.getByTestId(`playlist-check-${playlistId}`).check();
        await injectedPage.getByTestId('title-mode').selectOption('original');
        await injectedPage.getByTestId('start').click();
        await expect.poll(() => trackRequests).toBe(1);
        const jobId = await injectedPage.evaluate(async () => new Promise<string>((resolve, reject) => {
            const request = indexedDB.open('asmr-one-downloads', 1);
            request.onsuccess = () => { const query = request.result.transaction('jobs').objectStore('jobs').getAll(); query.onsuccess = () => resolve(query.result[0]?.id || ''); query.onerror = () => reject(query.error); };
            request.onerror = () => reject(request.error);
        }));
        expect(jobId).not.toBe('');
        await injectedPage.reload({ waitUntil: 'domcontentloaded' });
        await openDownloadCenter(injectedPage);
        const resume = injectedPage.getByTestId(`resume-${jobId}`);
        await expect(resume).toBeVisible({ timeout: 15_000 });
        releaseCancelledRequest?.();
        await resume.click();
        await expect(injectedPage.getByTestId('download-progress')).toContainText(/downloaded|download complete|保存|下载/i, { timeout: 30_000 });
        expect(trackRequests).toBeGreaterThanOrEqual(2);
        const bytes = await injectedPage.evaluate(async () => { const root = await navigator.storage.getDirectory(); const audio = await (await root.getDirectoryHandle('Discovery work')).getDirectoryHandle('Audio'); return [...new Uint8Array(await (await (await audio.getFileHandle('track.wav')).getFile()).arrayBuffer())]; });
        expect(bytes).toEqual([8, 8, 8]);
    });

    test('skips unavailable works and keeps same-title folders collision-free', async ({ injectedPage, isScriptLoaded }) => {
        const playlistId = '55555555-1111-4222-8333-444444444444';
        await mockOwnPlaylist(injectedPage, { id: playlistId, name: 'Mixed', works: [
            { id: 555555, source_id: 'RJ555555', title: 'Same' },
            { id: 666666, source_id: 'RJ666666', title: 'Unavailable' },
            { id: 777777, source_id: 'RJ777777', title: 'Same' },
        ] });
        for (const id of ['555555', '777777']) {
            await injectedPage.route(`**/api/tracks/${id}*`, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
                { type: 'audio', hash: `audio-${id}`, title: 'track.wav', mediaDownloadUrl: `https://media.e2e/${id}.wav` },
            ]) }));
            await injectedPage.route(`**/api/workInfo/${id}*`, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
                id: Number(id), source_id: `RJ${id}`, title: 'Same', name: 'Circle', circle: { name: 'Circle' }, vas: [], tags: [], release: '2026-01-01', source_url: '', mainCoverUrl: '', thumbnailCoverUrl: '', samCoverUrl: '',
            }) }));
            await injectedPage.route(`https://media.e2e/${id}.wav`, route => route.fulfill({ status: 200, body: Buffer.from([Number(id[0])]) }));
        }
        await injectedPage.route('**/api/tracks/666666*', route => route.fulfill({ status: 404, body: 'missing' }));
        await injectedPage.route('**/api/workInfo/666666*', route => route.fulfill({ status: 404, body: 'missing' }));
        await helpers.gotoHome(injectedPage); await isScriptLoaded();
        await injectedPage.evaluate(() => { (window as any).showDirectoryPicker = () => navigator.storage.getDirectory(); });
        await openDownloadCenter(injectedPage);
        await injectedPage.getByTestId('source-own').click();
        await injectedPage.getByTestId(`playlist-check-${playlistId}`).check();
        await injectedPage.getByTestId('title-mode').selectOption('original');
        await injectedPage.getByTestId('start').click();
        await expect(injectedPage.getByTestId('download-progress')).toContainText(/skipped|スキップ|跳过/i, { timeout: 30_000 });
        const result = await injectedPage.evaluate(async () => {
            const root = await navigator.storage.getDirectory();
            const read = async (folder: string) => {
                const directory = await root.getDirectoryHandle(folder);
                const handle = await directory.getFileHandle('track.wav');
                return [...new Uint8Array(await (await handle.getFile()).arrayBuffer())];
            };
            return { first: await read('Same'), second: await read('Same (2)') };
        });
        expect(result).toEqual({ first: [5], second: [7] });
    });

    test('converts a real WAV to tagged Opus with preserved/generated artwork', async ({ injectedPage, isScriptLoaded }) => {
        test.skip(!hasFfprobe, 'Native ffprobe is required to validate generated Opus');
        test.setTimeout(120_000);
        const playlistId = '44444444-1111-4222-8333-444444444444';
        await mockOwnPlaylist(injectedPage, { id: playlistId, name: 'Opus', works: [{ id: 444444, source_id: 'RJ444444', title: 'Opus work' }] });
        const wav = tinyWav();
        const cover = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
        await injectedPage.route('**/api/tracks/444444*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{
            type: 'folder', title: 'Audio', children: [{ type: 'audio', hash: 'wav', title: 'track.wav', size: wav.length, mediaDownloadUrl: 'https://media.e2e/opus.wav' }],
        }]) }));
        await injectedPage.route('**/api/workInfo/444444*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
            id: 444444, source_id: 'RJ444444', title: 'Opus work', name: 'Test Circle', circle_id: 9, circle: { id: 9, name: 'Test Circle' },
            vas: [{ id: 'v', name: 'Test VA' }], tags: [{ id: 1, name: 'ASMR' }], release: '2026-01-01', source_url: '',
            mainCoverUrl: 'https://media.e2e/cover.png', thumbnailCoverUrl: '', samCoverUrl: '',
        }) }));
        await injectedPage.route('https://media.e2e/opus.wav', route => route.fulfill({ status: 200, body: wav, headers: { 'content-length': String(wav.length) } }));
        await injectedPage.route('https://media.e2e/cover.png', route => route.fulfill({ status: 200, contentType: 'image/png', body: cover }));
        await helpers.gotoHome(injectedPage); await isScriptLoaded();
        await injectedPage.evaluate(() => { (window as any).showDirectoryPicker = () => navigator.storage.getDirectory(); });
        await openDownloadCenter(injectedPage);
        await injectedPage.getByTestId('source-own').click();
        await injectedPage.getByTestId(`playlist-check-${playlistId}`).check();
        await injectedPage.getByTestId('title-mode').selectOption('original');
        await injectedPage.getByTestId('opus-toggle').check();
        await injectedPage.getByTestId('opus-bitrate').selectOption('96');
        await injectedPage.getByTestId('start').click();
        await expect(injectedPage.getByTestId('download-progress')).toContainText(/downloaded|download complete|保存|下载/i, { timeout: 60_000 });
        const bytes = await injectedPage.evaluate(async () => { const root = await navigator.storage.getDirectory(); const audio = await (await root.getDirectoryHandle('Opus work')).getDirectoryHandle('Audio'); return [...new Uint8Array(await (await (await audio.getFileHandle('track.opus')).getFile()).arrayBuffer())]; });
        const output = `/tmp/asmr-download-center-${Date.now()}.opus`; fs.writeFileSync(output, Buffer.from(bytes));
        const probe = JSON.parse(execFileSync(FFPROBE_PATH, ['-v', 'error', '-of', 'json', '-show_format', '-show_streams', output], { encoding: 'utf8' }));
        expect(probe.streams[0].codec_name).toBe('opus');
        const tags = { ...(probe.format.tags || {}), ...(probe.streams[0].tags || {}) };
        expect(tags.album).toBe('Opus work'); expect(tags.artist).toContain('Test VA');
        expect(probe.streams.some((stream: any) => stream.codec_type === 'video' && stream.disposition?.attached_pic === 1)).toBe(true);
    });
});
