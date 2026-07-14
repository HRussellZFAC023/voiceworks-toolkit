/**
 * E2E: Emergency Playlist Export
 *
 * Verifies the one-click playlist backup in Settings → Emergency Backup:
 *  - JSON export downloads a single document with the user's own playlists
 *    and community (public/global) playlists in SEPARATE sections
 *  - CSV/TXT exports download own and public playlists as separate files
 *  - RJ codes and titles survive the round trip
 */

import { test, expect, helpers } from './fixtures';
import type { Download, Page } from '@playwright/test';
import * as fs from 'fs';
import { execFileSync } from 'child_process';

const FFPROBE_PATH = process.env.FFPROBE_PATH
    || (fs.existsSync('/opt/homebrew/bin/ffprobe') ? '/opt/homebrew/bin/ffprobe' : 'ffprobe');
let hasFfprobe = true;
try { execFileSync(FFPROBE_PATH, ['-version'], { stdio: 'ignore' }); } catch { hasFfprobe = false; }

const OWN_ID = '11111111-2222-3333-4444-555555555555';

function tinyWav(): Buffer {
    const samples = 1600; const dataSize = samples * 2; const out = Buffer.alloc(44 + dataSize);
    out.write('RIFF', 0); out.writeUInt32LE(36 + dataSize, 4); out.write('WAVEfmt ', 8);
    out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
    out.writeUInt32LE(16000, 24); out.writeUInt32LE(32000, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
    out.write('data', 36); out.writeUInt32LE(dataSize, 40);
    for (let i = 0; i < samples; i += 1) out.writeInt16LE(Math.round(Math.sin(i / 12) * 4000), 44 + i * 2);
    return out;
}

async function mockPlaylistApis(page: Page) {
    // Own playlist listing (both endpoint shapes)
    await page.route('**/api/playlist/get-playlists*', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
            playlists: [{ id: OWN_ID, name: 'My Precious Playlist', description: 'mine', privacy: 0, works: [] }],
            pagination: { currentPage: 1, pageSize: 100, totalCount: 1 },
        }),
    }));

    await page.route('**/api/playlist/get-playlist-metadata*', (route) => {
        const id = new URL(route.request().url()).searchParams.get('id') || '';
        const isOwn = id.toLowerCase() === OWN_ID;
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                id,
                name: isOwn ? 'My Precious Playlist' : `Community ${id.slice(0, 8)}`,
                description: isOwn ? 'mine' : 'a community playlist',
                privacy: isOwn ? 0 : 2,
                user_name: isOwn ? 'E2E' : 'someone-else',
                works: [],
                works_count: isOwn ? 2 : 1,
            }),
        });
    });

    await page.route('**/api/playlist/get-playlist-works*', (route) => {
        const id = new URL(route.request().url()).searchParams.get('id') || '';
        const isOwn = id.toLowerCase() === OWN_ID;
        const works = isOwn
            ? [
                { id: 111111, source_id: 'RJ111111', title: 'Own Work One' },
                { id: 222222, source_id: 'RJ222222', title: 'Own Work Two' },
            ]
            : [{ id: 333333, source_id: 'RJ333333', title: 'Community Work' }];
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                works,
                pagination: { currentPage: 1, pageSize: 100, totalCount: works.length },
            }),
        });
    });
}

async function openEmergencySection(page: Page) {
    const section = page.locator('#asmr-emergency-export-section');
    await expect(section).toBeVisible({ timeout: 15000 });
    await section.scrollIntoViewIfNeeded();
    return section;
}

async function readDownload(download: Download): Promise<string> {
    const filePath = await download.path();
    return fs.readFileSync(filePath!, 'utf-8');
}

test.describe('Emergency Playlist Export', () => {
    test.beforeEach(async ({ injectedPage }) => {
        await mockPlaylistApis(injectedPage);
    });

    test('JSON export includes own and public playlists in separate sections', async ({ injectedPage, isScriptLoaded }) => {
        test.setTimeout(180000);
        await helpers.gotoSettings(injectedPage);
        await isScriptLoaded();
        await openEmergencySection(injectedPage);

        const downloadPromise = injectedPage.waitForEvent('download', { timeout: 120000 });
        await injectedPage.locator('[data-testid="emergency-export-json"]').click();
        const download = await downloadPromise;

        expect(download.suggestedFilename()).toMatch(/^asmr-playlists-backup-.*\.json$/);
        const doc = JSON.parse(await readDownload(download));

        expect(doc.format).toBe('asmr-one-ultimate-playlist-backup');
        expect(doc.version).toBe(1);

        // Own playlists: exactly the mocked one, with its works
        expect(doc.ownPlaylists).toHaveLength(1);
        const own = doc.ownPlaylists[0];
        expect(own.name).toBe('My Precious Playlist');
        expect(own.works.map((w: { rjCode: string }) => w.rjCode)).toEqual(['RJ111111', 'RJ222222']);
        expect(own.works[0].title).toBe('Own Work One');

        // Public playlists: non-empty (seeded/global list) and disjoint from own
        expect(doc.publicPlaylists.length).toBeGreaterThan(0);
        const publicIds = doc.publicPlaylists.map((p: { id: string }) => p.id.toLowerCase());
        expect(publicIds).not.toContain(OWN_ID);
        const firstPublic = doc.publicPlaylists[0];
        expect(firstPublic.works.map((w: { rjCode: string }) => w.rjCode)).toEqual(['RJ333333']);
        expect(firstPublic.userName).toBe('someone-else');

        // Status line reports the result
        const status = injectedPage.locator('[data-testid="emergency-export-status"]');
        await expect(status).toContainText('1', { timeout: 10000 });
    });

    test('CSV export downloads own and public playlists as separate files', async ({ injectedPage, isScriptLoaded }) => {
        test.setTimeout(180000);
        await helpers.gotoSettings(injectedPage);
        await isScriptLoaded();
        await openEmergencySection(injectedPage);

        const downloads: Download[] = [];
        injectedPage.on('download', (d) => downloads.push(d));
        await injectedPage.locator('[data-testid="emergency-export-csv"]').click();
        await expect.poll(() => downloads.length, { timeout: 175000 }).toBeGreaterThanOrEqual(2);

        const names = downloads.map((d) => d.suggestedFilename());
        expect(names.some((n) => /^asmr-playlists-own-.*\.csv$/.test(n))).toBe(true);
        expect(names.some((n) => /^asmr-playlists-public-.*\.csv$/.test(n))).toBe(true);

        const ownCsv = await readDownload(downloads[names.findIndex((n) => n.includes('-own-'))]);
        expect(ownCsv).toContain('playlist_id,playlist_name,rj_code,title');
        expect(ownCsv).toContain('RJ111111');
        expect(ownCsv).toContain('My Precious Playlist');
        expect(ownCsv).not.toContain('RJ333333');

        const publicCsv = await readDownload(downloads[names.findIndex((n) => n.includes('-public-'))]);
        expect(publicCsv).toContain('RJ333333');
        expect(publicCsv).not.toContain('My Precious Playlist');
    });

    test('TXT export produces grouped RJ-code lists', async ({ injectedPage, isScriptLoaded }) => {
        test.setTimeout(180000);
        await helpers.gotoSettings(injectedPage);
        await isScriptLoaded();
        await openEmergencySection(injectedPage);

        const downloads: Download[] = [];
        injectedPage.on('download', (d) => downloads.push(d));
        await injectedPage.locator('[data-testid="emergency-export-txt"]').click();
        await expect.poll(() => downloads.length, { timeout: 175000 }).toBeGreaterThanOrEqual(2);

        const names = downloads.map((d) => d.suggestedFilename());
        const ownTxt = await readDownload(downloads[names.findIndex((n) => /-own-.*\.txt$/.test(n))]);
        expect(ownTxt).toContain('# My Precious Playlist (2 works)');
        expect(ownTxt).toContain('RJ111111\tOwn Work One');
    });

    test('backup work chooser supports searchable tri-state selection and download profiles', async ({ injectedPage, isScriptLoaded }) => {
        await injectedPage.setViewportSize({ width: 390, height: 844 });
        await helpers.gotoSettings(injectedPage);
        await isScriptLoaded();
        await openEmergencySection(injectedPage);
        const backup = {
            format: 'asmr-one-ultimate-playlist-backup', version: 1,
            exportedAt: new Date().toISOString(), source: 'https://asmr.one', errors: [], publicPlaylists: [],
            ownPlaylists: [{
                id: 'playlist-a', name: 'Large collection', description: '', worksCount: 3,
                works: [
                    { rjCode: 'RJ111111', title: 'First work' },
                    { rjCode: 'RJ222222', title: 'Second work' },
                    { rjCode: 'RJ333333', title: 'Third work' },
                ],
            }],
        };
        await injectedPage.getByTestId('backup-download-input').setInputFiles({
            name: 'playlist-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)),
        });

        const dialog = injectedPage.getByTestId('backup-downloader');
        await expect(dialog).toBeVisible();
        await expect(injectedPage.getByTestId('start')).toBeDisabled();
        await injectedPage.getByTestId('playlist-check-playlist-a').check();
        await expect(injectedPage.getByTestId('selection-summary')).toContainText('3');
        await injectedPage.getByTestId('expand-playlist-a').click();
        await injectedPage.getByTestId('work-RJ222222').locator('input').uncheck();
        await expect(injectedPage.getByTestId('playlist-check-playlist-a')).toHaveJSProperty('indeterminate', true);
        await injectedPage.getByTestId('search').fill('Third');
        await expect(injectedPage.getByTestId('work-RJ111111')).toBeHidden();
        await expect(injectedPage.getByTestId('work-RJ333333')).toBeVisible();
        await injectedPage.getByTestId('opus-toggle').check();
        await injectedPage.getByTestId('opus-bitrate').selectOption('96');
        await injectedPage.getByTestId('title-mode').selectOption('original-bracketed-translation');
        await expect(injectedPage.getByTestId('start')).toBeEnabled();
        const overflow = await dialog.evaluate(el => el.scrollWidth > window.innerWidth + 1);
        expect(overflow).toBe(false);
    });

    test('downloads a complete selected work tree into the chosen browser directory', async ({ injectedPage, isScriptLoaded }) => {
        await injectedPage.route('**/api/tracks/111111*', route => route.fulfill({
            status: 200, contentType: 'application/json', body: JSON.stringify([{
                type: 'folder', title: 'Audio', children: [
                    { type: 'audio', hash: 'audio-hash', title: 'track.wav', size: 4, mediaDownloadUrl: 'https://media.e2e/track.wav' },
                    { type: 'image', hash: 'image-hash', title: 'cover.jpg', size: 3, mediaDownloadUrl: 'https://media.e2e/cover.jpg' },
                ],
            }]),
        }));
        await injectedPage.route('**/api/workInfo/111111*', route => route.fulfill({
            status: 200, contentType: 'application/json', body: JSON.stringify({
                id: 111111, source_id: 'RJ111111', title: 'First work', name: 'Circle', circle_id: 1,
                circle: { id: 1, name: 'Circle' }, vas: [], tags: [], release: '2026-01-01',
                source_url: 'https://www.dlsite.com/RJ111111', mainCoverUrl: '', thumbnailCoverUrl: '', samCoverUrl: '',
            }),
        }));
        await injectedPage.route('https://media.e2e/track.wav', route => route.fulfill({ status: 200, body: Buffer.from([1, 2, 3, 4]), headers: { 'content-length': '4', 'accept-ranges': 'bytes' } }));
        await injectedPage.route('https://media.e2e/cover.jpg', route => route.fulfill({ status: 200, body: Buffer.from([5, 6, 7]), headers: { 'content-length': '3', 'accept-ranges': 'bytes' } }));
        await helpers.gotoSettings(injectedPage);
        await isScriptLoaded();
        await injectedPage.evaluate(() => {
            (window as any).showDirectoryPicker = () => navigator.storage.getDirectory();
        });
        const backup = {
            format: 'asmr-one-ultimate-playlist-backup', version: 1, exportedAt: new Date().toISOString(),
            source: 'https://asmr.one', errors: [], publicPlaylists: [], ownPlaylists: [{
                id: 'p', name: 'Playlist', description: '', worksCount: 1,
                works: [{ rjCode: 'RJ111111', title: 'First work' }],
            }],
        };
        await injectedPage.getByTestId('backup-download-input').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
        await injectedPage.getByTestId('playlist-check-p').check();
        await injectedPage.getByTestId('title-mode').selectOption('original');
        await injectedPage.getByTestId('start').click();
        await expect(injectedPage.getByTestId('emergency-export-status')).toContainText(/downloaded|保存|下载/i, { timeout: 170000 });
        const files = await injectedPage.evaluate(async () => {
            const root = await navigator.storage.getDirectory();
            const work = await root.getDirectoryHandle('First work');
            const audio = await work.getDirectoryHandle('Audio');
            const read = async (name: string) => [...new Uint8Array(await (await (await audio.getFileHandle(name)).getFile()).arrayBuffer())];
            return { track: await read('track.wav'), cover: await read('cover.jpg') };
        });
        expect(files).toEqual({ track: [1, 2, 3, 4], cover: [5, 6, 7] });
    });

    test('resumes an interrupted file from its persisted byte offset after reload', async ({ injectedPage, isScriptLoaded }) => {
        let rangeHeader = '';
        await injectedPage.route('https://media.e2e/resume.wav', route => {
            rangeHeader = route.request().headers().range || '';
            return route.fulfill({
                status: rangeHeader === 'bytes=2-' ? 206 : 200,
                body: Buffer.from(rangeHeader === 'bytes=2-' ? [3, 4] : [1, 2, 3, 4]),
                headers: rangeHeader === 'bytes=2-'
                    ? { 'content-range': 'bytes 2-3/4', 'content-length': '2', etag: 'v1', 'accept-ranges': 'bytes' }
                    : { 'content-length': '4', etag: 'v1', 'accept-ranges': 'bytes' },
            });
        });
        await helpers.gotoSettings(injectedPage);
        await isScriptLoaded();
        await injectedPage.evaluate(async () => {
            await new Promise<void>((resolve, reject) => {
                const deletion = indexedDB.deleteDatabase('asmr-one-downloads');
                deletion.onsuccess = () => resolve(); deletion.onerror = () => reject(deletion.error);
            });
            const root = await navigator.storage.getDirectory();
            const folder = await root.getDirectoryHandle('Resume work', { create: true });
            const handle = await folder.getFileHandle('track.wav', { create: true });
            const writable = await handle.createWritable();
            await writable.write(new Uint8Array([1, 2])); await writable.close();
            await new Promise<void>((resolve, reject) => {
                const request = indexedDB.open('asmr-one-downloads', 1);
                request.onupgradeneeded = () => {
                    const db = request.result;
                    const jobs = db.createObjectStore('jobs', { keyPath: 'id' }); jobs.createIndex('by-status', 'status');
                    const files = db.createObjectStore('files', { keyPath: 'id' }); files.createIndex('by-job', 'jobId'); files.createIndex('by-job-status', ['jobId', 'status']);
                    const checkpoints = db.createObjectStore('checkpoints', { keyPath: 'fileId' }); checkpoints.createIndex('by-job', 'jobId');
                };
                request.onsuccess = () => {
                    const db = request.result; const tx = db.transaction(['jobs', 'files', 'checkpoints'], 'readwrite');
                    const now = Date.now();
                    tx.objectStore('jobs').put({ id: 'resume-job', title: 'Resume 2 of 4 bytes', status: 'paused', options: { state: { convertToOpus: false }, directory: root, enrichment: {} }, createdAt: now, updatedAt: now });
                    tx.objectStore('files').put({ id: 'resume-file', jobId: 'resume-job', path: 'Resume work/track.wav', url: 'https://media.e2e/resume.wav', status: 'paused', downloadedBytes: 2, totalBytes: 4, createdAt: now, updatedAt: now });
                    tx.objectStore('checkpoints').put({ fileId: 'resume-file', jobId: 'resume-job', offset: 2, etag: 'v1', updatedAt: now });
                    tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
                };
                request.onerror = () => reject(request.error);
            });
        });
        await injectedPage.reload({ waitUntil: 'domcontentloaded' });
        await expect(injectedPage.getByTestId('backup-download-resume-resume-job')).toBeVisible({ timeout: 15000 });
        await injectedPage.getByTestId('backup-download-resume-resume-job').click();
        await expect(injectedPage.getByTestId('emergency-export-status')).toContainText(/downloaded|保存|下载/i, { timeout: 170000 });
        expect(rangeHeader).toBe('bytes=2-');
        const bytes = await injectedPage.evaluate(async () => {
            const root = await navigator.storage.getDirectory();
            const file = await (await (await root.getDirectoryHandle('Resume work')).getFileHandle('track.wav')).getFile();
            return [...new Uint8Array(await file.arrayBuffer())];
        });
        expect(bytes).toEqual([1, 2, 3, 4]);
    });

    test('skips unavailable works and keeps same-title work folders collision-free', async ({ injectedPage, isScriptLoaded }) => {
        for (const id of ['555555', '777777']) {
            await injectedPage.route(`**/api/tracks/${id}*`, route => route.fulfill({
                status: 200, contentType: 'application/json', body: JSON.stringify([
                    { type: 'audio', hash: `audio-${id}`, title: 'track.wav', size: 1, mediaDownloadUrl: `https://media.e2e/${id}.wav` },
                ]),
            }));
            await injectedPage.route(`**/api/workInfo/${id}*`, route => route.fulfill({
                status: 200, contentType: 'application/json', body: JSON.stringify({
                    id: Number(id), source_id: `RJ${id}`, title: 'Same', name: 'Circle', circle: { name: 'Circle' }, vas: [], tags: [],
                    release: '2026-01-01', source_url: '', mainCoverUrl: '', thumbnailCoverUrl: '', samCoverUrl: '',
                }),
            }));
            await injectedPage.route(`https://media.e2e/${id}.wav`, route => route.fulfill({ status: 200, body: Buffer.from([Number(id[0])]) }));
        }
        await injectedPage.route('**/api/tracks/666666*', route => route.fulfill({ status: 404, body: 'missing' }));
        await injectedPage.route('**/api/workInfo/666666*', route => route.fulfill({ status: 404, body: 'missing' }));
        await helpers.gotoSettings(injectedPage); await isScriptLoaded();
        await injectedPage.evaluate(() => { (window as any).showDirectoryPicker = () => navigator.storage.getDirectory(); });
        const backup = { format: 'asmr-one-ultimate-playlist-backup', version: 1, exportedAt: '', source: '', errors: [], publicPlaylists: [], ownPlaylists: [{
            id: 'mixed', name: 'Mixed', description: '', worksCount: 3, works: [
                { rjCode: 'RJ555555', title: 'Same' }, { rjCode: 'RJ666666', title: 'Unavailable' }, { rjCode: 'RJ777777', title: 'Same' },
            ],
        }] };
        await injectedPage.getByTestId('backup-download-input').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
        await injectedPage.getByTestId('playlist-check-mixed').check();
        await injectedPage.getByTestId('title-mode').selectOption('original');
        await injectedPage.getByTestId('start').click();
        await expect(injectedPage.getByTestId('emergency-export-status')).toContainText(/skipped|スキップ|跳过/i, { timeout: 30000 });
        const result = await injectedPage.evaluate(async () => {
            const root = await navigator.storage.getDirectory();
            const read = async (folder: string) => {
                const directory = await root.getDirectoryHandle(folder);
                const file = await (await directory.getFileHandle('track.wav')).getFile();
                return [...new Uint8Array(await file.arrayBuffer())];
            };
            return { first: await read('Same'), second: await read('Same (2)') };
        });
        expect(result).toEqual({ first: [5], second: [7] });
    });

    test('converts a real WAV to playable tagged Opus through the downloader UI', async ({ injectedPage, isScriptLoaded }) => {
        test.skip(!hasFfprobe, 'Native ffprobe is required to validate the generated Opus file');
        test.setTimeout(180000);
        const wav = tinyWav();
        const cover = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
        await injectedPage.route('**/api/tracks/444444*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{
            type: 'folder', title: 'Audio', children: [{ type: 'audio', hash: 'wav', title: 'track.wav', size: wav.length, mediaDownloadUrl: 'https://media.e2e/opus.wav' }],
        }]) }));
        await injectedPage.route('**/api/workInfo/444444*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
            id: 444444, source_id: 'RJ444444', title: 'Opus work', name: 'Test Circle', circle_id: 9,
            circle: { id: 9, name: 'Test Circle' }, vas: [{ id: 'v', name: 'Test VA' }], tags: [{ id: 1, name: 'ASMR' }],
            release: '2026-01-01', source_url: 'https://www.dlsite.com/RJ444444', mainCoverUrl: 'https://media.e2e/cover.png', thumbnailCoverUrl: '', samCoverUrl: '',
        }) }));
        await injectedPage.route('https://media.e2e/opus.wav', route => route.fulfill({ status: 200, body: wav, headers: { 'content-length': String(wav.length) } }));
        await injectedPage.route('https://media.e2e/cover.png', route => route.fulfill({ status: 200, contentType: 'image/png', body: cover }));
        await helpers.gotoSettings(injectedPage); await isScriptLoaded();
        await injectedPage.evaluate(() => { (window as any).showDirectoryPicker = () => navigator.storage.getDirectory(); });
        const backup = { format: 'asmr-one-ultimate-playlist-backup', version: 1, exportedAt: '', source: '', errors: [], publicPlaylists: [], ownPlaylists: [{
            id: 'opus-p', name: 'Opus', description: '', worksCount: 1, works: [{ rjCode: 'RJ444444', title: 'Opus work' }],
        }] };
        await injectedPage.getByTestId('backup-download-input').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
        await injectedPage.getByTestId('playlist-check-opus-p').check();
        await injectedPage.getByTestId('title-mode').selectOption('original');
        await injectedPage.getByTestId('opus-toggle').check();
        await injectedPage.getByTestId('opus-bitrate').selectOption('96');
        await injectedPage.getByTestId('start').click();
        await expect(injectedPage.getByTestId('emergency-export-status')).toContainText(/downloaded|保存|下载/i, { timeout: 30000 });
        const bytes = await injectedPage.evaluate(async () => {
            const root = await navigator.storage.getDirectory();
            const audio = await (await root.getDirectoryHandle('Opus work')).getDirectoryHandle('Audio');
            const file = await (await audio.getFileHandle('track.opus')).getFile();
            return [...new Uint8Array(await file.arrayBuffer())];
        });
        const output = '/tmp/asmr-v158-real.opus'; fs.writeFileSync(output, Buffer.from(bytes));
        const probe = JSON.parse(execFileSync(FFPROBE_PATH, ['-v', 'error', '-of', 'json', '-show_format', '-show_streams', output], { encoding: 'utf8' }));
        expect(probe.streams[0].codec_name).toBe('opus');
        const tags = { ...(probe.format.tags || {}), ...(probe.streams[0].tags || {}) };
        expect(tags.album).toBe('Opus work');
        expect(tags.artist).toContain('Test VA');
        expect(probe.streams.some((stream: any) => stream.codec_type === 'video' && stream.disposition?.attached_pic === 1)).toBe(true);
    });
});
