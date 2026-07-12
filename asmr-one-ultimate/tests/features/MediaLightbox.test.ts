import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ gmRequest: vi.fn() }));

vi.mock('../../src/composables/useBridge', () => ({
    useBridge: () => ({
        store: {
            state: { AudioPlayer: { hide: true } },
            commit: vi.fn(),
        },
    }),
}));

vi.mock('../../src/composables/useConfig', () => ({
    useConfig: (key: string) => ref(
        key === 'dlsiteProxyUrl' ? 'https://relay.example'
            : key === 'galleryAutoSlideshowInterval' ? 6
                : false,
    ),
}));

vi.mock('../../src/composables/useI18n', () => ({
    useI18n: () => ({
        t: (key: string) => key,
        format: (key: string) => key,
        lang: ref('en'),
    }),
}));

vi.mock('../../src/infrastructure/HttpClient', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/infrastructure/HttpClient')>();
    return { ...actual, gmRequest: mocks.gmRequest };
});

import MediaLightbox from '../../src/features/components/MediaLightbox.vue';

interface LightboxExposed {
    showExternalImages(urls: string[], startIndex?: number): void;
}

function validResponse(url: string) {
    return {
        status: 200,
        statusText: 'OK',
        responseText: '',
        responseHeaders: 'content-type: image/jpeg',
        response: new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0xdb])], { type: 'image/jpeg' }),
        finalUrl: url,
    };
}

describe('MediaLightbox verified image loading', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        mocks.gmRequest.mockReset();
        mocks.gmRequest.mockImplementation(async ({ url }: { url: string }) => validResponse(url));
        Object.defineProperty(URL, 'createObjectURL', {
            configurable: true,
            value: vi.fn((blob: Blob) => `blob:verified-${blob.size}-${Math.random()}`),
        });
        Object.defineProperty(URL, 'revokeObjectURL', {
            configurable: true,
            value: vi.fn(),
        });
    });

    it('fetches current plus immediate neighbours only, not the entire gallery', async () => {
        const wrapper = mount(MediaLightbox, { props: { visible: false }, attachTo: document.body });
        const urls = Array.from({ length: 12 }, (_, index) => `https://images.example/${index}.jpg`);

        (wrapper.vm as unknown as LightboxExposed).showExternalImages(urls, 6);
        await flushPromises();

        expect(mocks.gmRequest).toHaveBeenCalledTimes(3);
        expect(mocks.gmRequest.mock.calls.map(([config]) => config.url).sort()).toEqual([
            urls[5], urls[6], urls[7],
        ].sort());
        wrapper.unmount();
    });

    it('never renders an HTTP-200 restriction PNG and selects a valid alternate', async () => {
        mocks.gmRequest.mockImplementation(async ({ url }: { url: string }) => {
            if (url.includes('restricted')) {
                return {
                    ...validResponse(url),
                    response: new Blob(['restriction'], { type: 'image/png' }),
                    responseHeaders: 'content-type: image/png',
                    finalUrl: 'https://www.cloudflare-terms-of-service-abuse.com/stream.png',
                };
            }
            return validResponse(url);
        });

        const wrapper = mount(MediaLightbox, { props: { visible: false }, attachTo: document.body });
        (wrapper.vm as unknown as LightboxExposed).showExternalImages([
            'https://images.example/restricted.jpg',
            'https://images.example/valid.jpg',
        ]);
        await flushPromises();
        await vi.waitFor(() => {
            const image = document.querySelector('.media-viewer-image') as HTMLImageElement | null;
            expect(image?.src).toMatch(/^blob:verified-/);
        });

        const rendered = document.querySelector('.media-viewer-image') as HTMLImageElement | null;
        expect(rendered?.src).toMatch(/^blob:verified-/);
        expect(document.body.textContent).not.toContain('cloudflare-terms-of-service-abuse');
        expect(document.querySelector('.media-viewer-title')?.textContent).toContain('valid.jpg');
        wrapper.unmount();
    });

    it('uses localized labels for every affected pointer control', () => {
        const wrapper = mount(MediaLightbox, { props: { visible: false }, attachTo: document.body });
        const labels = Array.from(document.querySelectorAll<HTMLElement>(
            '.media-viewer-action[aria-label], .media-viewer-nav[aria-label]'
        )).map((el) => el.getAttribute('aria-label'));

        expect(labels).toEqual(expect.arrayContaining([
            'mediaViewerZoomOut',
            'mediaViewerZoomIn',
            'mediaViewerZoomReset',
            'mediaViewerFullscreen',
            'mediaViewerDownload',
            'mediaViewerOpenRaw',
            'mediaViewerClose',
            'mediaViewerPrevious',
            'mediaViewerNext',
        ]));
        wrapper.unmount();
    });
});
