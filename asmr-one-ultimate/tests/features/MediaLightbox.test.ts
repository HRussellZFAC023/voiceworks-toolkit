import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    gmDownload: vi.fn(),
    gmRequest: vi.fn(),
}));

vi.mock('../../src/composables/useBridge', () => ({
    useBridge: () => ({
        axios: { defaults: { baseURL: 'https://api.asmr-100.com' } },
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
    return {
        ...actual,
        gmDownload: mocks.gmDownload,
        gmRequest: mocks.gmRequest,
    };
});

import MediaLightbox from '../../src/features/components/MediaLightbox.vue';

interface LightboxExposed {
    showMedia(
        item: {
            hash: string;
            title: string;
            type: 'image' | 'video' | 'pdf' | 'text';
            mediaStreamUrl?: string;
            mediaDownloadUrl?: string;
        },
        type: 'image' | 'video' | 'pdf' | 'text',
        mediaList: Array<{
            hash: string;
            title: string;
            type: 'image' | 'video' | 'pdf' | 'text';
            mediaStreamUrl?: string;
            mediaDownloadUrl?: string;
        }>,
        startIndex: number,
    ): Promise<void>;
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

function browserImageResponse(url: string, blob?: Blob): Response {
    const body = blob ?? new Blob(
        [Uint8Array.from([0xff, 0xd8, 0xff, 0xdb])],
        { type: 'image/jpeg' },
    );
    const result = new Response(awaitableBlobBytes(body), {
        status: 200,
        headers: {
            'content-length': String(body.size),
            'content-type': body.type || 'image/jpeg',
        },
    });
    Object.defineProperty(result, 'url', { configurable: true, value: url });
    return result;
}

function awaitableBlobBytes(blob: Blob): Uint8Array<ArrayBuffer> {
    // Every fixture here is a four-byte JPEG marker or UTF-8 text supplied by
    // the individual test; the helper keeps Node's Response in its own realm.
    return blob.type === 'image/jpeg'
        ? Uint8Array.from([0xff, 0xd8, 0xff, 0xdb])
        : new Uint8Array(blob.size);
}

describe('MediaLightbox verified image loading', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        localStorage.clear();
        mocks.gmDownload.mockReset().mockResolvedValue(true);
        mocks.gmRequest.mockReset();
        mocks.gmRequest.mockImplementation(async ({ url }: { url: string }) => validResponse(url));
        vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            const finalUrl = url.includes('/api/media/stream/')
                ? 'https://raw.kiko-play-niptan.one/media/stream/daily/RJ01052162/image.jpg?verify=test'
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
        delete (globalThis as typeof globalThis & { pdfjsLib?: unknown }).pdfjsLib;
        vi.unstubAllGlobals();
    });

    it('fetches current plus immediate neighbours only, not the entire gallery', async () => {
        const wrapper = mount(MediaLightbox, { props: { visible: false }, attachTo: document.body });
        const urls = Array.from({ length: 12 }, (_, index) => `https://api.asmr-100.com/${index}.jpg`);

        (wrapper.vm as unknown as LightboxExposed).showExternalImages(urls, 6);
        await flushPromises();

        expect(mocks.gmRequest).not.toHaveBeenCalled();
        expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url)).sort()).toEqual([
            urls[5], urls[6], urls[7],
        ].sort());
        wrapper.unmount();
    });

    it('loads hash-only work-tree images from the active host API origin', async () => {
        localStorage.setItem('jwt-token', 'must-not-leak');
        const wrapper = mount(MediaLightbox, { props: { visible: false }, attachTo: document.body });
        const item = {
            hash: '1052162/319502',
            title: '03.台詞-1.jpg',
            type: 'image' as const,
        };

        await (wrapper.vm as unknown as LightboxExposed).showMedia(item, 'image', [item], 0);
        await flushPromises();

        expect(fetch).toHaveBeenCalledWith(
            'https://api.asmr-100.com/api/media/stream/1052162/319502',
            expect.objectContaining({ credentials: 'omit', redirect: 'follow' }),
        );
        expect(mocks.gmRequest).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it('ignores a host-root placeholder and renders Firefox CORS bytes without privileged transport', async () => {
        const apiUrl = 'https://api.asmr-100.com/api/media/stream/1052162/319495';
        vi.stubGlobal('fetch', vi.fn(async () => browserImageResponse(
            'https://raw.kiko-play-niptan.one/media/stream/daily/RJ01052162/cover.jpg?verify=test',
        )));

        const wrapper = mount(MediaLightbox, { props: { visible: false }, attachTo: document.body });
        const item = {
            hash: '1052162/319495',
            title: '01.表紙.jpg',
            type: 'image' as const,
            mediaStreamUrl: '/',
            mediaDownloadUrl: '/',
        };

        await (wrapper.vm as unknown as LightboxExposed).showMedia(item, 'image', [item], 0);
        await flushPromises();

        expect(mocks.gmRequest).not.toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledWith(apiUrl, expect.objectContaining({
            credentials: 'omit',
            mode: 'cors',
        }));
        await vi.waitFor(() => {
            expect(document.querySelector<HTMLImageElement>('.media-viewer-image')?.src)
                .toMatch(/^blob:verified-/);
        });
        expect(document.body.textContent).not.toContain('mediaViewerImageUnavailable');
        wrapper.unmount();
    });

    it('never renders an HTTP-200 restriction PNG and selects a valid alternate', async () => {
        vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes('restricted')) {
                throw new TypeError('redirect blocked');
            }
            return browserImageResponse(url);
        }));

        const wrapper = mount(MediaLightbox, { props: { visible: false }, attachTo: document.body });
        (wrapper.vm as unknown as LightboxExposed).showExternalImages([
            'https://api.asmr-100.com/restricted.jpg',
            'https://api.asmr-100.com/valid.jpg',
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

    it('uses the Firefox userscript download API for a verified image Blob', async () => {
        const downloadedBlob = new Blob(
            [Uint8Array.from([0xff, 0xd8, 0xff, 0xdb])],
            { type: 'image/jpeg' },
        );
        vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) =>
            browserImageResponse(String(input), downloadedBlob)));
        const wrapper = mount(MediaLightbox, { props: { visible: false }, attachTo: document.body });

        (wrapper.vm as unknown as LightboxExposed).showExternalImages([
            'https://api.asmr-100.com/download.jpg',
        ]);
        await flushPromises();
        let downloadButton: HTMLButtonElement | null = null;
        await vi.waitFor(() => {
            downloadButton = document.querySelector<HTMLButtonElement>('.media-viewer-download');
            expect(downloadButton).not.toBeNull();
        });
        downloadButton!.click();
        await vi.waitFor(() => {
            expect(mocks.gmDownload).toHaveBeenCalledWith({
                url: expect.objectContaining({
                    size: 4,
                    type: 'image/jpeg',
                }),
                name: 'download.jpg',
                saveAs: false,
            });
        });
        wrapper.unmount();
    });

    it('loads arbitrary public text with bounded credentialless CORS and never GM transport', async () => {
        const textUrl = 'https://cdn.example.com/readme.txt';
        vi.stubGlobal('fetch', vi.fn(async () => {
            const result = new Response('hello from text', {
                status: 200,
                headers: { 'content-type': 'text/plain' },
            });
            Object.defineProperty(result, 'url', { configurable: true, value: textUrl });
            return result;
        }));
        const wrapper = mount(MediaLightbox, { props: { visible: false }, attachTo: document.body });
        const item = {
            hash: 'readme',
            title: 'readme.txt',
            type: 'text' as const,
            mediaStreamUrl: textUrl,
        };

        await (wrapper.vm as unknown as LightboxExposed).showMedia(item, 'text', [item], 0);
        await vi.waitFor(() => expect(document.body.textContent).toContain('hello from text'));

        expect(fetch).toHaveBeenCalledWith(textUrl, expect.objectContaining({
            credentials: 'omit',
            mode: 'cors',
            redirect: 'error',
            referrerPolicy: 'no-referrer',
        }));
        expect(mocks.gmRequest).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it('blocks private text URLs before transport or translation rendering', async () => {
        const wrapper = mount(MediaLightbox, { props: { visible: false }, attachTo: document.body });
        const item = {
            hash: 'private',
            title: 'private.txt',
            type: 'text' as const,
            mediaStreamUrl: 'https://127.0.0.1/secret.txt',
        };

        await (wrapper.vm as unknown as LightboxExposed).showMedia(item, 'text', [item], 0);
        await flushPromises();

        expect(fetch).not.toHaveBeenCalled();
        expect(mocks.gmRequest).not.toHaveBeenCalled();
        expect(document.body.textContent).toContain('mediaViewerResolutionFailed');
        wrapper.unmount();
    });

    it('extracts PDF bytes through the bounded browser transport rather than GM', async () => {
        const pdfUrl = 'https://cdn.example.com/guide.pdf';
        const getDocument = vi.fn(() => ({
            promise: Promise.resolve({
                numPages: 1,
                getPage: async () => ({
                    getTextContent: async () => ({
                        items: [{ str: 'safe pdf text', hasEOL: true }],
                    }),
                }),
            }),
        }));
        (globalThis as typeof globalThis & { pdfjsLib?: unknown }).pdfjsLib = {
            GlobalWorkerOptions: { workerSrc: '' },
            getDocument,
        };
        vi.stubGlobal('fetch', vi.fn(async () => {
            const result = new Response(Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d]), {
                status: 200,
                headers: { 'content-type': 'application/pdf' },
            });
            Object.defineProperty(result, 'url', { configurable: true, value: pdfUrl });
            return result;
        }));
        const wrapper = mount(MediaLightbox, { props: { visible: false }, attachTo: document.body });
        const item = {
            hash: 'guide',
            title: 'guide.pdf',
            type: 'pdf' as const,
            mediaStreamUrl: pdfUrl,
        };

        await (wrapper.vm as unknown as LightboxExposed).showMedia(item, 'pdf', [item], 0);
        await vi.waitFor(() => expect(document.body.textContent).toContain('safe pdf text'));

        expect(getDocument).toHaveBeenCalledOnce();
        expect(fetch).toHaveBeenCalledWith(pdfUrl, expect.objectContaining({
            credentials: 'omit',
            redirect: 'error',
        }));
        expect(mocks.gmRequest).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it('embeds only a verified PDF blob in a sandboxed fallback iframe', async () => {
        const pdfUrl = 'https://cdn.example.com/scanned.pdf';
        (globalThis as typeof globalThis & { pdfjsLib?: unknown }).pdfjsLib = {
            GlobalWorkerOptions: { workerSrc: '' },
            getDocument: () => ({
                promise: Promise.resolve({
                    numPages: 1,
                    getPage: async () => ({
                        getTextContent: async () => ({ items: [] }),
                    }),
                }),
            }),
        };
        vi.stubGlobal('fetch', vi.fn(async () => {
            const result = new Response(
                Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]),
                { status: 200, headers: { 'content-type': 'application/pdf' } },
            );
            Object.defineProperty(result, 'url', { configurable: true, value: pdfUrl });
            return result;
        }));
        const wrapper = mount(MediaLightbox, { props: { visible: false }, attachTo: document.body });
        const item = {
            hash: 'scanned',
            title: 'scanned.pdf',
            type: 'pdf' as const,
            mediaStreamUrl: pdfUrl,
        };

        await (wrapper.vm as unknown as LightboxExposed).showMedia(item, 'pdf', [item], 0);
        await vi.waitFor(() => expect(document.querySelector('.media-viewer-pdf')).not.toBeNull());

        const iframe = document.querySelector<HTMLIFrameElement>('.media-viewer-pdf');
        expect(iframe?.src).toMatch(/^blob:verified-/);
        expect(iframe?.hasAttribute('sandbox')).toBe(true);
        expect(iframe?.getAttribute('sandbox')).toBe('');
        expect(iframe?.src).not.toContain(pdfUrl);
        expect(mocks.gmRequest).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it('rejects HTML served from a .pdf URL instead of embedding an unsandboxed raw iframe', async () => {
        const pdfUrl = 'https://cdn.example.com/not-really.pdf';
        const getDocument = vi.fn();
        (globalThis as typeof globalThis & { pdfjsLib?: unknown }).pdfjsLib = {
            GlobalWorkerOptions: { workerSrc: '' },
            getDocument,
        };
        vi.stubGlobal('fetch', vi.fn(async () => {
            const result = new Response('<html><script>top.location="/stolen"</script></html>', {
                status: 200,
                headers: { 'content-type': 'text/html' },
            });
            Object.defineProperty(result, 'url', { configurable: true, value: pdfUrl });
            return result;
        }));
        const wrapper = mount(MediaLightbox, { props: { visible: false }, attachTo: document.body });
        const item = {
            hash: 'fake-guide',
            title: 'not-really.pdf',
            type: 'pdf' as const,
            mediaStreamUrl: pdfUrl,
        };

        await (wrapper.vm as unknown as LightboxExposed).showMedia(item, 'pdf', [item], 0);
        await vi.waitFor(() => expect(document.body.textContent).toContain('mediaViewerPdfLoadFailed'));

        expect(getDocument).not.toHaveBeenCalled();
        expect(document.querySelector('.media-viewer-pdf')).toBeNull();
        expect(mocks.gmRequest).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it('downloads canonical non-image media through the safe official redirect path', async () => {
        const streamUrl = 'https://api.asmr-100.com/api/media/stream/text-hash';
        const rawStreamUrl = 'https://raw.kiko-play-niptan.one/media/stream/text-hash?verify=signed';
        const downloadUrl = 'https://api.asmr-100.com/api/media/download/text-hash';
        const rawDownloadUrl = 'https://raw.kiko-play-niptan.one/media/download/text-hash?verify=signed';
        vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
            const requested = String(input);
            const body = requested === downloadUrl ? 'downloaded text' : 'preview';
            const result = new Response(body, {
                status: 200,
                headers: { 'content-type': 'text/plain' },
            });
            Object.defineProperty(result, 'url', {
                configurable: true,
                value: requested === downloadUrl ? rawDownloadUrl : rawStreamUrl,
            });
            return result;
        }));
        const wrapper = mount(MediaLightbox, { props: { visible: false }, attachTo: document.body });
        const item = {
            hash: 'text-hash',
            title: 'notes.txt',
            type: 'text' as const,
            mediaStreamUrl: '/api/media/stream/text-hash',
            mediaDownloadUrl: '/api/media/download/text-hash',
        };

        await (wrapper.vm as unknown as LightboxExposed).showMedia(item, 'text', [item], 0);
        await vi.waitFor(() => expect(document.body.textContent).toContain('preview'));
        document.querySelector<HTMLButtonElement>('.media-viewer-download')?.click();
        await vi.waitFor(() => expect(mocks.gmDownload).toHaveBeenCalledWith({
            url: expect.objectContaining({
                size: 'downloaded text'.length,
                type: 'text/plain',
            }),
            name: 'notes.txt',
            saveAs: false,
        }));

        expect(fetch).toHaveBeenCalledWith(streamUrl, expect.objectContaining({ redirect: 'follow' }));
        expect(fetch).toHaveBeenCalledWith(downloadUrl, expect.objectContaining({ redirect: 'follow' }));
        expect(mocks.gmRequest).not.toHaveBeenCalled();
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
