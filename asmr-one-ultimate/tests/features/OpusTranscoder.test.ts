import { describe, expect, it } from 'vitest';
import { AsyncSerialQueue, buildOpusArguments, encodeMetadataBlockPicture, hasOpusContainerSignature } from '../../src/features/downloads/OpusTranscoder';

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
});
