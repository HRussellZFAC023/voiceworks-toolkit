import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const playerGallerySource = readFileSync(
    resolve(process.cwd(), 'src/features/components/PlayerGallery.vue'),
    'utf8',
);
const playerFullscreenCss = readFileSync(
    resolve(process.cwd(), 'src/styles/components/_player_fullscreen.css'),
    'utf8',
);

const mocks = vi.hoisted(() => ({
    showExternalImages: vi.fn(),
    getTracks: vi.fn(),
    gmRequest: vi.fn(),
    eventHandlers: new Map<string, (...args: never[]) => unknown>(),
}));

vi.mock('../../src/composables/useBridge', () => ({
    useBridge: () => ({ findWorkTreeComponent: () => null }),
}));

vi.mock('../../src/composables/useI18n', () => ({
    useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('../../src/composables/useEventBus', () => ({
    useEventBus: () => ({
        on: vi.fn((event: string, handler: (...args: never[]) => unknown) => {
            mocks.eventHandlers.set(event, handler);
        }),
    }),
}));

vi.mock('../../src/composables/useConfig', () => ({
    useConfig: (key: string) => ref(key === 'dlsiteProxyUrl' ? 'https://relay.example' : false),
}));

vi.mock('../../src/store/AppStore', () => ({
    AppStore: {
        currentWork: {
            id: 1409932,
            mainCoverUrl: 'https://asmr.one/api/cover/1409932.jpg',
        },
    },
}));

vi.mock('../../src/services/WorkService', () => ({
    WorkService: { getTracks: mocks.getTracks },
}));

vi.mock('../../src/features/MediaViewerController', () => ({
    MediaViewerController: {
        getInstance: () => ({ showExternalImages: mocks.showExternalImages }),
    },
}));

vi.mock('../../src/infrastructure/HttpClient', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/infrastructure/HttpClient')>();
    return {
        ...actual,
        gmRequest: mocks.gmRequest,
        retryWithBackoff: (fn: () => Promise<unknown>) => fn(),
    };
});

import PlayerGallery from '../../src/features/components/PlayerGallery.vue';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
}

function browserImageResponse(url: string): Response {
    const blob = new Blob(
        [Uint8Array.from([0xff, 0xd8, 0xff, 0xdb])],
        { type: 'image/jpeg' },
    );
    const result = new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xdb]), {
        status: 200,
        headers: {
            'content-length': String(blob.size),
            'content-type': 'image/jpeg',
        },
    });
    Object.defineProperty(result, 'url', { configurable: true, value: url });
    return result;
}

describe('PlayerGallery', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <div class="audio-player">
                <div class="albumart" style="position: relative"></div>
            </div>
        `;
        mocks.showExternalImages.mockReset();
        mocks.getTracks.mockReset();
        mocks.gmRequest.mockReset();
        mocks.eventHandlers.clear();

        mocks.getTracks.mockResolvedValue(Array.from({ length: 12 }, (_, index) => ({
            type: 'image',
            hash: `1409932/image-${index}.jpg`,
            title: `image-${index}.jpg`,
            mediaStreamUrl: `https://api.asmr-200.com/api/media/stream/1409932/image-${index}.jpg`,
            size: 4_000_000 + index,
        })));
        mocks.gmRequest.mockImplementation(async ({ url }: { url: string }) => ({
            status: 200,
            statusText: 'OK',
            responseText: '',
            responseHeaders: 'content-type: image/jpeg',
            response: new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0xdb])], { type: 'image/jpeg' }),
            finalUrl: url,
        }));
        vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            const finalUrl = url.includes('/api/media/stream/')
                ? 'https://raw.kiko-play-niptan.one/media/stream/daily/RJ01409932/image.jpg?verify=test'
                : url;
            return browserImageResponse(finalUrl);
        }));

        Object.defineProperty(URL, 'createObjectURL', {
            configurable: true,
            value: vi.fn((blob: Blob) => `blob:verified-${blob.size}-${Math.random()}`),
        });
        Object.defineProperty(URL, 'revokeObjectURL', {
            configurable: true,
            value: vi.fn(),
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('keeps a large source inventory lazy and fetches only selected/adjacent items', async () => {
        const albumart = document.querySelector('.albumart') as HTMLElement;
        const wrapper = mount(PlayerGallery, { attachTo: albumart });
        await flushPromises();

        // Cover + twelve track images are inventoried, but initial load verifies
        // only the selected cover instead of downloading the whole gallery.
        expect(mocks.getTracks).toHaveBeenCalledTimes(1);
        expect(mocks.gmRequest).not.toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());

        await wrapper.find('.asmr-gallery-next').trigger('click');
        await flushPromises();
        expect(mocks.gmRequest).not.toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledTimes(2);

        wrapper.unmount();
        expect(URL.revokeObjectURL).toHaveBeenCalled();
    });

    it('keeps desktop controls subtle and opens the lightbox by clicking the cover', async () => {
        const albumart = document.querySelector('.albumart') as HTMLElement;
        const wrapper = mount(PlayerGallery, { attachTo: albumart });
        await flushPromises();

        const next = wrapper.find('.asmr-gallery-next');
        expect(next.isVisible()).toBe(true);
        expect(wrapper.find('.asmr-gallery-open').exists()).toBe(false);

        // The surface stays transparent at rest while the white glyph retains
        // a dark outline. Fading the whole button also faded that contrast
        // layer and made the controls disappear on pale artwork.
        expect(playerGallerySource).toMatch(/\.asmr-gallery-nav\s*\{[\s\S]*background:\s*transparent;[\s\S]*opacity:\s*1;/);
        expect(playerGallerySource).toMatch(/\.asmr-gallery-nav :deep\(\.material-icons\)\s*\{[\s\S]*-webkit-text-stroke:\s*1px rgba\(0, 0, 0, 0\.92\);/);
        expect(playerGallerySource).toMatch(/\.asmr-gallery-nav:hover\s*\{[\s\S]*opacity:\s*1\s*!important;/);
        expect(playerGallerySource).not.toContain(':global(.albumart):hover');
        expect(playerFullscreenCss).not.toMatch(/\.albumart:hover \.asmr-gallery-nav/);
        expect(playerFullscreenCss).toMatch(/\.albumart:hover \.asmr-gallery-counter\s*\{[\s\S]*opacity:\s*1/);
        expect(getComputedStyle(next.element).pointerEvents).not.toBe('none');

        await mocks.eventHandlers.get('fullscreen:enter')?.();
        await flushPromises();
        albumart.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(mocks.showExternalImages).toHaveBeenCalledTimes(1);
        expect(mocks.showExternalImages.mock.calls[0][0]).toHaveLength(13);

        wrapper.unmount();
    });

    it('never displays the Cloudflare restriction image and falls back to the verified cover', async () => {
        mocks.getTracks.mockResolvedValue([
            {
                type: 'image',
                hash: '1409932/restricted.png',
                title: 'restricted.png',
                mediaStreamUrl: '/api/media/stream/1409932/restricted.png',
            },
        ]);
        vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes('/media/stream/')) {
                throw new TypeError('redirect blocked');
            }
            return browserImageResponse(url);
        }));
        // The privileged bridge is retried for official media routes, so it has
        // to reproduce the restriction as well: Cloudflare answers HTTP 200 from
        // its own abuse host, which the final-URL policy must refuse.
        mocks.gmRequest.mockImplementation(async ({ url }: { url: string }) => ({
            status: 200,
            statusText: 'OK',
            responseText: '',
            responseHeaders: 'content-type: image/png',
            response: new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0xdb])], { type: 'image/png' }),
            finalUrl: url.includes('restricted')
                ? 'https://www.cloudflare-terms-of-service-abuse.com/stream.png'
                : url,
        }));

        const albumart = document.querySelector('.albumart') as HTMLElement;
        const wrapper = mount(PlayerGallery, { attachTo: albumart });
        await flushPromises();
        await vi.waitFor(() => expect(wrapper.find('.asmr-gallery-img').attributes('src')).toMatch(/^blob:verified-/));
        const coverSrc = wrapper.find('.asmr-gallery-img').attributes('src');
        expect(coverSrc).toMatch(/^blob:verified-/);

        await wrapper.find('.asmr-gallery-next').trigger('click');
        await flushPromises();
        await vi.waitFor(() => expect(mocks.gmRequest).toHaveBeenCalled());
        await flushPromises();

        expect(wrapper.find('.asmr-gallery-img').attributes('src')).toBe(coverSrc);
        expect(albumart.getAttribute('data-gallery-count')).toBe('1');
        expect(document.body.textContent).not.toContain('cloudflare-terms-of-service-abuse');
        wrapper.unmount();
    });

    it('does not resume image work after unmount while tracks are pending', async () => {
        const tracks = deferred<Array<{ type: 'image'; title: string; mediaStreamUrl: string }>>();
        mocks.getTracks.mockReturnValue(tracks.promise);
        const albumart = document.querySelector('.albumart') as HTMLElement;
        const wrapper = mount(PlayerGallery, { attachTo: albumart });

        await vi.waitFor(() => expect(mocks.getTracks).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledOnce());
        const requestsAtUnmount = vi.mocked(fetch).mock.calls.length;
        const blobsAtUnmount = vi.mocked(URL.createObjectURL).mock.calls.length;

        wrapper.unmount();
        tracks.resolve([{
            type: 'image',
            title: 'late.jpg',
            mediaStreamUrl: 'https://raw.kiko-play-niptan.one/1409932/late.jpg',
        }]);
        await flushPromises();

        expect(fetch).toHaveBeenCalledTimes(requestsAtUnmount);
        expect(URL.createObjectURL).toHaveBeenCalledTimes(blobsAtUnmount);
    });
});
