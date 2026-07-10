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

const OWN_ID = '11111111-2222-3333-4444-555555555555';

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
        await expect.poll(() => downloads.length, { timeout: 120000 }).toBeGreaterThanOrEqual(2);

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
        await expect.poll(() => downloads.length, { timeout: 120000 }).toBeGreaterThanOrEqual(2);

        const names = downloads.map((d) => d.suggestedFilename());
        const ownTxt = await readDownload(downloads[names.findIndex((n) => /-own-.*\.txt$/.test(n))]);
        expect(ownTxt).toContain('# My Precious Playlist (2 works)');
        expect(ownTxt).toContain('RJ111111\tOwn Work One');
    });
});
