import { test, expect, helpers, TEST_WORKS } from './fixtures';

const HASH_ONLY_IMAGE_BODY = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8Dwn6Hh/38AEXkEfRkE0tIAAAAASUVORK5CYII=',
    'base64',
);
const HASH_ONLY_TEST_TITLE = 'hash-only work-tree image uses the media API and preserves gallery navigation';

async function openFirstImage(page: import('@playwright/test').Page) {
    const flatPanel = helpers.isFlatPanelOpen(page);
    if (!await flatPanel.isVisible()) {
        await helpers.toggleFlatView(page);
    }

    const imageItem = page
        .locator('.asmr-flat-panel .q-item[data-asmr-flat-type="image"]')
        .first();
    await expect(imageItem).toBeVisible({ timeout: 10000 });
    await imageItem.click();

    const modal = page.locator('#asmr-media-viewer-modal');
    await expect(modal).toHaveClass(/active/, { timeout: 10000 });
    return modal;
}

async function openExternalFixtureGallery(page: import('@playwright/test').Page) {
    const opened = await page.evaluate((items) => {
        type HostVm = {
            fatherFolder?: unknown[];
            $data?: { fatherFolder?: unknown[] };
            _data?: { fatherFolder?: unknown[] };
        };
        type TestWindow = Window & typeof globalThis & {
            __ASMR_KIKOERU_BRIDGE__?: {
                findComponent(predicate: (vm: { $options?: { name?: string } }) => boolean): HostVm | null;
            };
        };
        const runtime = window as TestWindow;
        const workTreeVm = runtime.__ASMR_KIKOERU_BRIDGE__?.findComponent(
            vm => vm.$options?.name === 'WorkTree',
        );
        const workTree = document.getElementById('work-tree');
        if (!workTreeVm || !workTree) return false;

        const folders = [
            workTreeVm.fatherFolder,
            workTreeVm.$data?.fatherFolder,
            workTreeVm._data?.fatherFolder,
        ];
        for (const folder of folders) {
            if (Array.isArray(folder)) folder.splice(0, folder.length, ...items);
        }

        const qItem = document.createElement('div') as HTMLElement & {
            __vue__?: { item: (typeof items)[number]; $attrs: { item: (typeof items)[number] } };
        };
        qItem.className = 'q-item';
        qItem.dataset.asmrHash = items[0].hash;
        qItem.innerHTML = `<div class="q-item__label">${items[0].title}</div>`;
        qItem.__vue__ = { item: items[0], $attrs: { item: items[0] } };
        workTree.appendChild(qItem);
        qItem.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return true;
    }, [
        {
            hash: 'fixture-image-1',
            title: 'test-image-1.png',
            type: 'image',
            mediaStreamUrl: 'https://asmr.one/test-image-1.png',
        },
        {
            hash: 'fixture-image-2',
            title: 'test-image-2.png',
            type: 'image',
            mediaStreamUrl: 'https://asmr.one/test-image-2.png',
        },
    ]);
    expect(opened).toBe(true);

    const modal = page.locator('#asmr-media-viewer-modal');
    await expect(modal).toHaveClass(/active/, { timeout: 10000 });
    return modal;
}

async function openHashOnlyCanonicalGallery(page: import('@playwright/test').Page) {
    const result = await page.evaluate((items) => {
        const workTree = document.getElementById('work-tree');
        if (!workTree) return null;

        type TestBridge = {
            findWorkTreeComponent?: () => unknown;
            findComponent: (...args: unknown[]) => unknown;
        };
        const bridge = (window as Window & typeof globalThis & {
            __ASMR_KIKOERU_BRIDGE__?: TestBridge;
        }).__ASMR_KIKOERU_BRIDGE__;
        if (!bridge) return null;

        // Force MediaViewerController past all host-Vue sources. The tracks
        // endpoint is empty for this test, leaving these raw rows as the only
        // available gallery source and therefore exercising the DOM fallback.
        bridge.findWorkTreeComponent = () => null;
        bridge.findComponent = () => null;
        workTree.querySelectorAll('.q-item').forEach(row => row.remove());

        const rows = items.map((item) => {
            const qItem = document.createElement('div');
            qItem.className = 'q-item';
            qItem.dataset.asmrHash = item.hash;
            qItem.innerHTML = `<div class="q-item__label">${item.title}</div>`;
            workTree.appendChild(qItem);
            return qItem;
        });
        const hasDirectUrl = rows.some(qItem => Array.from(qItem.attributes)
            .some(attribute => /^(?:https?:|blob:|data:)/i.test(attribute.value)));
        const hasVue = rows.some(qItem => Object.prototype.hasOwnProperty.call(qItem, '__vue__'));

        rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return {
            rowCount: rows.length,
            hasDirectUrl,
            hasVue,
        };
    }, [
        {
            hash: 'hash-only/first',
            title: 'hash-only-first.png',
            type: 'image',
        },
        {
            hash: 'hash-only/second',
            title: 'hash-only-second.png',
            type: 'image',
        },
    ]);

    expect(result).toEqual({
        rowCount: 2,
        hasDirectUrl: false,
        hasVue: false,
    });

    const modal = page.locator('#asmr-media-viewer-modal');
    await expect(modal).toHaveClass(/active/, { timeout: 10000 });
    return modal;
}

async function expectDecodedGalleryImage(
    modal: import('@playwright/test').Locator,
    title: string,
    position: string,
) {
    await expect(modal.locator('.media-viewer-title')).toHaveText(title);
    await expect(modal.locator('.media-viewer-current')).toHaveText(position);
    await expect(modal.locator('.media-viewer-total')).toHaveText('2');

    const image = modal.locator('.media-viewer-image');
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute('alt', title);
    await expect.poll(
        () => image.evaluate((element: HTMLImageElement) =>
            element.complete && element.naturalWidth > 0 && element.naturalHeight > 0,
        ),
    ).toBe(true);
}

test.describe('MediaViewer v2.0', () => {

    test.beforeEach(async ({ injectedPage: page, isScriptLoaded }, testInfo) => {
        if (testInfo.title === HASH_ONLY_TEST_TITLE) {
            // Register this before navigation so neither the host nor
            // WorkService can seed an in-memory/IndexedDB real manifest.
            await page.route(/\/api\/tracks\/[^/?]+(?:\?.*)?$/, route => route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: '[]',
            }));
        }
        await helpers.gotoWork(page, TEST_WORKS.STANDARD);
        await isScriptLoaded();
        const workTree = page.locator('#work-tree');
        if (testInfo.title === HASH_ONLY_TEST_TITLE) {
            await expect(workTree).toHaveCount(1, { timeout: 15000 });
        } else {
            await expect(workTree).toBeVisible({ timeout: 15000 });
        }
        await page.waitForTimeout(2000);
    });

    test('modal element is created on work page', async ({ injectedPage: page }) => {
        // MediaViewer creates the modal during enable()
        const modal = page.locator('#asmr-media-viewer-modal');
        // Modal should exist in DOM (but not active until an image is clicked)
        await expect(modal).toHaveCount(1, { timeout: 10000 });

        // Verify modal has proper structure
        const hasBackdrop = await modal.locator('.media-viewer-backdrop').count();
        const hasBody = await modal.locator('.media-viewer-body').count();
        const hasCounter = await modal.locator('.media-viewer-counter').count();
        const hasZoomControls = await modal.locator('.media-viewer-zoom-controls').count();
        const hasClose = await modal.locator('.media-viewer-close').count();
        const hasNav = await modal.locator('.media-viewer-prev').count();
        const hasThumbnails = await modal.locator('.media-viewer-thumbnails').count();

        expect(hasBackdrop).toBe(1);
        expect(hasBody).toBe(1);
        expect(hasCounter).toBe(1);
        expect(hasZoomControls).toBe(1);
        expect(hasClose).toBe(1);
        expect(hasNav).toBe(1);
        expect(hasThumbnails).toBe(1);
    });

    test('modal can be activated and deactivated', async ({ injectedPage: page }) => {
        const modal = await openFirstImage(page);
        await modal.locator('.media-viewer-backdrop').dispatchEvent('click');
        await expect(modal).not.toHaveClass(/active/);
    });

    test('zoom controls are present with correct initial state', async ({ injectedPage: page }) => {
        const modal = page.locator('#asmr-media-viewer-modal');
        await expect(modal).toHaveCount(1, { timeout: 10000 });

        const zoomIn = modal.locator('.media-viewer-zoom-in');
        const zoomOut = modal.locator('.media-viewer-zoom-out');
        const zoomReset = modal.locator('.media-viewer-zoom-reset');
        const zoomIndicator = modal.locator('.media-viewer-zoom-indicator');
        const zoomSlider = modal.locator('.media-viewer-zoom-slider');

        await expect(zoomIn).toHaveCount(1);
        await expect(zoomOut).toHaveCount(1);
        await expect(zoomReset).toHaveCount(1);
        await expect(zoomIndicator).toHaveCount(1);
        await expect(zoomSlider).toHaveCount(1);

        // Initial zoom indicator should show 100%
        await expect(zoomIndicator).toHaveText('100%');
    });

    test('close button triggers hide', async ({ injectedPage: page }) => {
        const modal = await openFirstImage(page);

        // Click close button
        const closeBtn = modal.locator('.media-viewer-close');
        await closeBtn.click({ force: true });

        // Modal should be deactivated (the close button triggers hideModal)
        await expect(modal).not.toHaveClass(/active/, { timeout: 5000 });
    });

    test('opens decoded image pixels from a work-tree item', async ({ injectedPage: page }) => {
        const modal = await openExternalFixtureGallery(page);
        const image = modal.locator('.media-viewer-image');
        await expect(image).toBeVisible();
        await expect.poll(
            () => image.evaluate((element: HTMLImageElement) => element.naturalWidth),
        ).toBeGreaterThan(0);
        await expect(modal.locator('.media-viewer-title')).toHaveText('test-image-1.png');
    });

    test(HASH_ONLY_TEST_TITLE, async ({ injectedPage: page }) => {
        const mediaRequests: string[] = [];
        const onRequest = (request: import('@playwright/test').Request) => {
            const url = new URL(request.url());
            if (url.pathname.startsWith('/api/media/stream/')) {
                mediaRequests.push(url.toString());
            }
        };
        page.on('request', onRequest);
        await page.route(
            /^https:\/\/(?:api\.asmr\.one|api\.asmr-(?:100|200|300)\.com)\/api\/media\/stream\/hash-only\/(?:first|second)(?:\?.*)?$/,
            route => route.fulfill({
                status: 200,
                contentType: 'text/plain',
                body: HASH_ONLY_IMAGE_BODY,
            }),
        );
        try {
            const modal = await openHashOnlyCanonicalGallery(page);
            await expectDecodedGalleryImage(modal, 'hash-only-first.png', '1');

            await modal.locator('.media-viewer-next').click();
            await expectDecodedGalleryImage(modal, 'hash-only-second.png', '2');

            await modal.locator('.media-viewer-prev').click();
            await expectDecodedGalleryImage(modal, 'hash-only-first.png', '1');

            const downloadPromise = page.waitForEvent('download');
            await modal.locator('.media-viewer-download').click();
            const download = await downloadPromise;
            expect(download.suggestedFilename()).toBe('hash-only-first.png');
            const stream = await download.createReadStream();
            const chunks: Buffer[] = [];
            for await (const chunk of stream) chunks.push(Buffer.from(chunk));
            expect(Buffer.concat(chunks)).toEqual(HASH_ONLY_IMAGE_BODY);

            expect(mediaRequests.some((requestUrl) =>
                new URL(requestUrl).pathname === '/api/media/stream/hash-only/first',
            )).toBe(true);
            expect(mediaRequests.some((requestUrl) =>
                new URL(requestUrl).pathname === '/api/media/stream/hash-only/second',
            )).toBe(true);
            expect(mediaRequests.filter((requestUrl) => {
                const url = new URL(requestUrl);
                return (url.hostname === 'asmr.one' || url.hostname === 'www.asmr.one');
            })).toEqual([]);
        } finally {
            page.off('request', onRequest);
        }
    });

    test('media viewer CSS is injected', async ({ injectedPage: page }) => {
        // Verify the media viewer CSS is loaded
        const hasMediaViewerCSS = await page.evaluate(() => {
            for (const sheet of document.styleSheets) {
                try {
                    for (const rule of sheet.cssRules) {
                        if (rule.cssText?.includes('media-viewer-modal')) {
                            return true;
                        }
                    }
                } catch (e) {
                    // Skip cross-origin
                }
            }
            return false;
        });

        expect(hasMediaViewerCSS).toBe(true);
    });

    test('keyboard handler is registered', async ({ injectedPage: page }) => {
        const modal = await openFirstImage(page);

        // Press Escape should close the modal
        await page.keyboard.press('Escape');
        await expect(modal).not.toHaveClass(/active/, { timeout: 5000 });
    });

    test('navigation buttons exist in modal', async ({ injectedPage: page }) => {
        const modal = page.locator('#asmr-media-viewer-modal');
        await expect(modal).toHaveCount(1, { timeout: 10000 });

        const prevBtn = modal.locator('.media-viewer-prev');
        const nextBtn = modal.locator('.media-viewer-next');

        await expect(prevBtn).toHaveCount(1);
        await expect(nextBtn).toHaveCount(1);

        // Check ARIA labels
        const prevLabel = await prevBtn.getAttribute('aria-label');
        const nextLabel = await nextBtn.getAttribute('aria-label');
        expect(prevLabel).toBeTruthy();
        expect(nextLabel).toBeTruthy();
    });

    test('action buttons have correct accessibility attributes', async ({ injectedPage: page }) => {
        const modal = page.locator('#asmr-media-viewer-modal');
        await expect(modal).toHaveCount(1, { timeout: 10000 });

        // All action buttons should have aria-label
        const actionButtons = modal.locator('.media-viewer-action');
        const count = await actionButtons.count();
        expect(count).toBeGreaterThan(0);

        for (let i = 0; i < count; i++) {
            const label = await actionButtons.nth(i).getAttribute('aria-label');
            expect(label).toBeTruthy();
        }
    });
});
