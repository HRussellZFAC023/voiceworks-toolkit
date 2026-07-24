import { describe, expect, it, vi } from 'vitest';
import {
    getOpusConversionMemoryBudget,
    OpusConversionMemoryLimitError,
    OpusFileTransformer,
    planOpusOutputPaths,
} from '../../src/features/downloads/OpusFileTransformer';

describe('OpusFileTransformer', () => {
    it('converts audio and leaves source cleanup to the coordinator commit boundary', async () => {
        const transcoder: any = {
            isSupported: () => true,
            transcode: vi.fn(async (request) => {
                request.onProgress?.(0.42);
                return new Uint8Array([7, 8]);
            }),
        };
        const transformer = new OpusFileTransformer(transcoder, {
            enabled: true, bitrateKbps: 96, metadataPolicy: 'additive',
            tagsForFile: () => ({ album: 'Work [作品]' }),
        });
        const sink: any = {
            size: vi.fn().mockResolvedValue(4),
            read: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4])),
            writeAll: vi.fn(), remove: vi.fn(),
        };
        const file: any = { id: 'f', path: 'Work/track.flac', totalBytes: 4, downloadedBytes: 4 };

        const onProgress = vi.fn();
        const result = await transformer.transform(file, sink, undefined, onProgress);

        expect(transcoder.transcode).toHaveBeenCalledWith(expect.objectContaining({
            inputExtension: 'flac', bitrateKbps: 96, generatedTags: { album: 'Work [作品]' }, metadataPolicy: 'additive',
        }));
        expect(sink.writeAll).toHaveBeenCalledWith(['Work', 'track.opus'], new Uint8Array([7, 8]));
        expect(sink.remove).not.toHaveBeenCalled();
        expect(onProgress).toHaveBeenCalledWith(0.42);
        expect(result).toEqual({ path: 'Work/track.opus', bytes: 2 });
    });

    it('keeps the source when conversion fails', async () => {
        const transformer = new OpusFileTransformer({ transcode: vi.fn().mockRejectedValue(new Error('codec failed')) } as any, {
            enabled: true, bitrateKbps: 64, metadataPolicy: 'additive',
        });
        const sink: any = {
            size: vi.fn().mockResolvedValue(1),
            read: vi.fn().mockResolvedValue(new Uint8Array([1])),
            writeAll: vi.fn(),
            remove: vi.fn(),
        };
        await expect(transformer.transform({ path: 'track.wav' } as any, sink)).rejects.toThrow('codec failed');
        expect(sink.remove).not.toHaveBeenCalled();
    });

    it('checks size and loads optional artwork before retaining the full source buffer', async () => {
        const order: string[] = [];
        const transformer = new OpusFileTransformer({
            transcode: vi.fn(async () => {
                order.push('transcode');
                return new Uint8Array([2]);
            }),
        } as any, {
            enabled: true,
            bitrateKbps: 64,
            metadataPolicy: 'additive',
            artworkForFile: vi.fn(async () => {
                order.push('artwork');
                return undefined;
            }),
        });
        const sink: any = {
            size: vi.fn(async () => {
                order.push('size');
                return 1;
            }),
            read: vi.fn(async () => {
                order.push('source');
                return new Uint8Array([1]);
            }),
            writeAll: vi.fn(),
        };

        await transformer.transform({ id: 'file', path: 'track.wav' } as any, sink);

        expect(order).toEqual(['size', 'artwork', 'source', 'transcode']);
    });

    it('rejects oversized sources before artwork or full source materialization', async () => {
        const transcoder = { transcode: vi.fn() };
        const artworkForFile = vi.fn();
        const transformer = new OpusFileTransformer(transcoder as any, {
            enabled: true,
            bitrateKbps: 64,
            metadataPolicy: 'additive',
            memoryBudget: { maxSourceBytes: 4 },
            artworkForFile,
        });
        const sink: any = {
            size: vi.fn().mockResolvedValue(5),
            read: vi.fn(),
            writeAll: vi.fn(),
            remove: vi.fn(),
        };

        await expect(transformer.transform({ id: 'file', path: 'track.wav' } as any, sink))
            .rejects.toEqual(expect.objectContaining<Partial<OpusConversionMemoryLimitError>>({
                name: 'OpusConversionMemoryLimitError',
                sourceBytes: 5,
                maxSourceBytes: 4,
            }));
        expect(artworkForFile).not.toHaveBeenCalled();
        expect(sink.read).not.toHaveBeenCalled();
        expect(transcoder.transcode).not.toHaveBeenCalled();
        expect(sink.writeAll).not.toHaveBeenCalled();
        expect(sink.remove).not.toHaveBeenCalled();
    });

    it('uses conservative device-scaled source limits with an absolute ceiling', () => {
        const mib = 1024 * 1024;
        expect(getOpusConversionMemoryBudget({ deviceMemoryGiB: -1, isMobile: false }).maxSourceBytes).toBe(128 * mib);
        expect(getOpusConversionMemoryBudget({ deviceMemoryGiB: -1, isMobile: true }).maxSourceBytes).toBe(64 * mib);
        expect(getOpusConversionMemoryBudget({ deviceMemoryGiB: 4, isMobile: false }).maxSourceBytes).toBe(128 * mib);
        expect(getOpusConversionMemoryBudget({ deviceMemoryGiB: 32, isMobile: false }).maxSourceBytes).toBe(256 * mib);
        expect(getOpusConversionMemoryBudget({ deviceMemoryGiB: 32, isMobile: true }).maxSourceBytes).toBe(96 * mib);
    });

    it('plans collision-free Opus paths against existing and converted files', () => {
        const paths = planOpusOutputPaths([
            { id: 'wav', path: 'Work/track.wav' },
            { id: 'existing', path: 'Work/track.opus' },
            { id: 'flac', path: 'Work/TRACK.flac' },
        ]);
        expect(paths.wav).toBe('Work/track (2).opus');
        expect(paths.flac).toBe('Work/TRACK (3).opus');
        expect(paths.existing).toBeUndefined();
    });

    it.each(['alac', 'oga'])('converts every classified %s audio extension', (extension) => {
        const transformer = new OpusFileTransformer({ transcode: vi.fn() } as any, {
            enabled: true, bitrateKbps: 96, metadataPolicy: 'additive',
        });
        const file = { id: extension, path: `Work/track.${extension}` } as any;
        expect(transformer.shouldTransform(file)).toBe(true);
        expect(planOpusOutputPaths([file])[extension]).toBe('Work/track.opus');
    });
});
