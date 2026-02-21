import { test, expect, helpers, TEST_WORKS } from './fixtures';
import type { Page } from '@playwright/test';

type SessionSnapshot = {
    title: string;
    artist: string;
    album: string;
    artworkCount: number;
};

async function readMediaSession(page: Page): Promise<SessionSnapshot | null> {
    return await page.evaluate(() => {
        const metadata = navigator.mediaSession?.metadata as MediaMetadata | null | undefined;
        if (!metadata) return null;
        const artwork = (metadata as unknown as { artwork?: unknown[] }).artwork;
        return {
            title: String(metadata.title || ''),
            artist: String(metadata.artist || ''),
            album: String(metadata.album || ''),
            artworkCount: Array.isArray(artwork) ? artwork.length : 0,
        };
    });
}

test.describe('Media Session Metadata', () => {
    test('uses track/work metadata instead of fallback labels after playback starts', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();

        const playButtons = injectedPage.locator('#work-tree .q-item .q-btn--round, .work-tree .q-item .q-btn--round');
        await expect(playButtons.first()).toBeVisible({ timeout: 20000 });
        await playButtons.first().click();

        await expect.poll(async () => {
            const meta = await readMediaSession(injectedPage);
            if (!meta) return 'missing';
            if (!meta.title) return 'empty-title';
            if (meta.title === 'No Track') return 'fallback-title';
            if (!meta.artist) return 'empty-artist';
            if (meta.artist === 'ASMR.one') return 'fallback-artist';
            return 'ok';
        }, { timeout: 30000 }).toBe('ok');

        const meta = await readMediaSession(injectedPage);
        expect(meta).not.toBeNull();
        expect((meta as SessionSnapshot).title).not.toBe('No Track');
        expect((meta as SessionSnapshot).artist).not.toBe('ASMR.one');
    });

    test('updates metadata when switching to another track', async ({ injectedPage, isScriptLoaded }) => {
        await helpers.gotoWork(injectedPage, TEST_WORKS.STANDARD);
        await isScriptLoaded();

        const playButtons = injectedPage.locator('#work-tree .q-item .q-btn--round, .work-tree .q-item .q-btn--round');
        await expect(playButtons.first()).toBeVisible({ timeout: 20000 });

        const count = await playButtons.count();
        test.skip(count < 2, 'Work does not expose at least two playable tracks');

        await playButtons.nth(0).click();
        await expect.poll(async () => (await readMediaSession(injectedPage))?.title || '', { timeout: 30000 }).not.toBe('');
        const firstTitle = (await readMediaSession(injectedPage))?.title || '';

        await playButtons.nth(1).click();
        await expect.poll(async () => {
            const meta = await readMediaSession(injectedPage);
            return meta?.title || '';
        }, { timeout: 30000 }).not.toBe(firstTitle);
    });
});
