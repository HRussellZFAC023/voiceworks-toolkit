import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    AsyncSerialQueue,
    FfmpegOpusTranscoder,
    buildOpusArguments,
    encodeMetadataBlockPicture,
    hasOpusContainerSignature,
    loadFfmpegInstanceFromCdn,
    rewriteFfmpegClassWorkerSource,
    type FfmpegLoaderRuntime,
} from '../../src/features/downloads/OpusTranscoder';

describe('buildOpusArguments', () => {
    it('writes preserved and generated metadata into the Opus stream', () => {
        const args = buildOpusArguments('in.flac', 'out.opus', {
            bitrateKbps: 96, tags: { title: 'Original [翻訳]', custom_private: 'preserved' },
        });
        expect(args).toEqual(expect.arrayContaining([
            '-map_metadata', '-1', '-c:a', 'libopus', '-b:a', '96k',
            '-metadata', 'title=Original [翻訳]', '-metadata', 'custom_private=preserved',
        ]));
        expect(args).not.toContain('-c:v');
        expect(args.at(-1)).toBe('out.opus');
    });

    it('encodes artwork as a standards-compatible FLAC picture comment', () => {
        const encoded = encodeMetadataBlockPicture({ mimeType: 'image/png', data: new Uint8Array([1, 2, 3]), description: 'Cover' });
        const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
        const view = new DataView(bytes.buffer);
        expect(view.getUint32(0)).toBe(3);
        expect(new TextDecoder().decode(bytes.slice(8, 17))).toBe('image/png');
        expect([...bytes.slice(-3)]).toEqual([1, 2, 3]);
    });

    it('rejects empty or header-only output as a valid Opus container', () => {
        expect(hasOpusContainerSignature(new Uint8Array())).toBe(false);
        expect(hasOpusContainerSignature(new TextEncoder().encode('OggS OpusHead'))).toBe(false);
        const body = new TextEncoder().encode('OpusHead');
        const validShape = new Uint8Array(28 + body.length);
        validShape.set(new TextEncoder().encode('OggS'), 0);
        validShape[5] = 0x06;
        validShape[26] = 1;
        validShape[27] = body.length;
        validShape.set(body, 28);
        expect(hasOpusContainerSignature(validShape)).toBe(true);
        expect(hasOpusContainerSignature(validShape.slice(0, -1))).toBe(false);
    });

    it('serializes concurrent work on the single FFmpeg worker', async () => {
        const queue = new AsyncSerialQueue();
        const order: string[] = [];
        let releaseFirst!: () => void;
        const first = queue.run(async () => {
            order.push('first-start');
            await new Promise<void>(resolve => { releaseFirst = resolve; });
            order.push('first-end');
        });
        const second = queue.run(async () => { order.push('second'); });
        await Promise.resolve();
        expect(order).toEqual(['first-start']);
        releaseFirst();
        await Promise.all([first, second]);
        expect(order).toEqual(['first-start', 'first-end', 'second']);
    });

    it('rewrites every FFmpeg class-worker import to its pinned CDN package', () => {
        const rewritten = rewriteFfmpegClassWorkerSource(
            'import { CORE_URL } from "./const.js";\nimport { ERROR_UNKNOWN_MESSAGE_TYPE } from \'./errors.js\';',
            'https://cdn.example/@ffmpeg/ffmpeg@0.12.15/dist/esm/',
        );

        expect(rewritten).toContain('https://cdn.example/@ffmpeg/ffmpeg@0.12.15/dist/esm/const.js');
        expect(rewritten).toContain('https://cdn.example/@ffmpeg/ffmpeg@0.12.15/dist/esm/errors.js');
        expect(rewritten).not.toMatch(/from\s*["']\.\//);
        expect(() => rewriteFfmpegClassWorkerSource('export {};', 'https://cdn.example/pkg/'))
            .toThrow('missing required import');
    });

    it('passes a same-origin blob classWorkerURL and revokes it on termination', async () => {
        const load = vi.fn().mockResolvedValue(true);
        const terminate = vi.fn();
        class FakeFfmpeg {
            load = load;
            terminate = terminate;
        }
        const toBlobURL = vi.fn(async (url: string) => `blob:dependency:${url}`);
        let createdWorkerBlob: Blob | undefined;
        const createObjectURL = vi.fn((blob: Blob) => {
            createdWorkerBlob = blob;
            return 'blob:https://asmr.one/class-worker';
        });
        const revokeObjectURL = vi.fn();
        const importModule = vi.fn(async (url: string) => url.includes('@ffmpeg/util')
            ? { toBlobURL }
            : { FFmpeg: FakeFfmpeg });
        let fetchReceiver: unknown = Symbol('not-called');
        const fetchImpl = vi.fn(function (this: unknown) {
            fetchReceiver = this;
            return Promise.resolve(new Response(
                'import { CORE_URL } from "./const.js";\nimport { ERROR_UNKNOWN_MESSAGE_TYPE } from "./errors.js";',
                { status: 200, headers: { 'content-type': 'text/javascript' } },
            ));
        });
        const runtime: FfmpegLoaderRuntime = {
            importModule,
            fetchImpl: fetchImpl as unknown as typeof fetch,
            createObjectURL,
            revokeObjectURL,
        };

        const ffmpeg = await loadFfmpegInstanceFromCdn('https://unpkg.com', runtime);

        expect(load).toHaveBeenCalledWith(expect.objectContaining({
            classWorkerURL: 'blob:https://asmr.one/class-worker',
            coreURL: expect.stringContaining('@ffmpeg/core@0.12.10'),
            wasmURL: expect.stringContaining('@ffmpeg/core@0.12.10'),
        }));
        expect(createdWorkerBlob).toBeInstanceOf(Blob);
        expect(createdWorkerBlob?.type).toBe('text/javascript');
        expect(fetchReceiver).toBeUndefined();
        ffmpeg.terminate();
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:https://asmr.one/class-worker');
        expect(terminate).toHaveBeenCalledTimes(1);
    });
});

describe('FfmpegOpusTranscoder instance lifecycle', () => {
    // jsdom exposes neither Worker nor WebAssembly, and isSupported() gates on
    // both, so stub them to reach the lifecycle logic under test.
    beforeEach(() => {
        vi.stubGlobal('Worker', class {});
        if (typeof WebAssembly === 'undefined') vi.stubGlobal('WebAssembly', {});
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    /**
     * ffmpeg.wasm never returns memory to the host, and a trapped module stays
     * trapped. Reported live: a 32-file job died at 7/32 with
     * "RuntimeError: index out of bounds", and every remaining file inherited
     * the poisoned instance.
     */
    function createFakeFfmpeg(behaviour: { failOn?: number } = {}) {
        let calls = 0;
        const terminated = { count: 0 };
        const instance = {
            calls: () => calls,
            terminated,
            on: vi.fn(), off: vi.fn(),
            writeFile: vi.fn(async () => {}),
            readFile: vi.fn(async () => new Uint8Array()),
            deleteFile: vi.fn(async () => {}),
            ffprobe: vi.fn(async () => 0),
            exec: vi.fn(async () => {
                calls += 1;
                if (behaviour.failOn && calls === behaviour.failOn) {
                    throw new Error('RuntimeError: index out of bounds');
                }
                return 0;
            }),
            terminate: vi.fn(() => { terminated.count += 1; }),
        };
        return instance;
    }

    it('retires a trapped module instead of reusing it for the next file', async () => {
        const created: ReturnType<typeof createFakeFfmpeg>[] = [];
        const transcoder = new FfmpegOpusTranscoder();
        // Force a fresh fake per load so instance reuse is observable.
        (transcoder as unknown as { loadInstance: () => Promise<unknown> }).loadInstance = async () => {
            const fake = createFakeFfmpeg({ failOn: 1 });
            created.push(fake);
            return fake;
        };

        await expect(transcoder.transcode({
            input: new Uint8Array(16), inputExtension: '.mp3', bitrateKbps: 96,
        } as never)).rejects.toThrow(/index out of bounds/);

        // The failed module must have been terminated and dropped, so a second
        // conversion loads a brand new one rather than inheriting the trap.
        expect(created).toHaveLength(1);
        expect(created[0].terminated.count).toBeGreaterThan(0);
        expect((transcoder as unknown as { ffmpeg?: unknown }).ffmpeg).toBeUndefined();
    });

    it('does not touch the virtual filesystem of a trapped module', async () => {
        const fake = createFakeFfmpeg({ failOn: 1 });
        const transcoder = new FfmpegOpusTranscoder();
        (transcoder as unknown as { loadInstance: () => Promise<unknown> }).loadInstance = async () => fake;

        await expect(transcoder.transcode({
            input: new Uint8Array(16), inputExtension: '.mp3', bitrateKbps: 96,
        } as never)).rejects.toThrow();

        // deleteFile on a corrupt module throws again and masks the real error.
        expect(fake.deleteFile).not.toHaveBeenCalled();
    });
});
