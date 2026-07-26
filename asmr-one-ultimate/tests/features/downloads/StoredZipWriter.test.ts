import { describe, expect, it } from 'vitest';
import { crc32, StoredZipWriter, ZIP32_LIMIT } from '../../../src/features/downloads/StoredZipWriter';

function concat(parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
    return out;
}

async function* chunksOf(bytes: Uint8Array, size = 4): AsyncGenerator<Uint8Array> {
    for (let offset = 0; offset < bytes.byteLength; offset += size) {
        yield bytes.subarray(offset, Math.min(offset + size, bytes.byteLength));
    }
}

interface ParsedEntry { name: string; crc: number; size: number; offset: number; data: Uint8Array }

/** Minimal central-directory reader mirroring how a real extractor works. */
function readArchive(archive: Uint8Array): ParsedEntry[] {
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    let end = archive.byteLength - 22;
    while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end -= 1;
    if (end < 0) throw new Error('End of central directory not found');
    const count = view.getUint16(end + 10, true);
    let cursor = view.getUint32(end + 16, true);
    const entries: ParsedEntry[] = [];
    for (let index = 0; index < count; index += 1) {
        if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error('Bad central header');
        const crc = view.getUint32(cursor + 16, true);
        const size = view.getUint32(cursor + 24, true);
        const nameLength = view.getUint16(cursor + 28, true);
        const extraLength = view.getUint16(cursor + 30, true);
        const commentLength = view.getUint16(cursor + 32, true);
        const offset = view.getUint32(cursor + 42, true);
        const name = new TextDecoder().decode(archive.subarray(cursor + 46, cursor + 46 + nameLength));
        if (view.getUint32(offset, true) !== 0x04034b50) throw new Error('Bad local header');
        const localNameLength = view.getUint16(offset + 26, true);
        const localExtraLength = view.getUint16(offset + 28, true);
        const dataStart = offset + 30 + localNameLength + localExtraLength;
        entries.push({ name, crc, size, offset, data: archive.subarray(dataStart, dataStart + size) });
        cursor += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}

describe('StoredZipWriter', () => {
    it('round-trips nested entries through a parsable central directory', async () => {
        const parts: Uint8Array[] = [];
        const writer = new StoredZipWriter(async bytes => { parts.push(bytes); }, () => new Date(2024, 0, 2, 3, 4, 6));
        const first = new TextEncoder().encode('the quick brown fox');
        const second = new Uint8Array([0, 1, 2, 3, 255, 254]);
        await writer.addEntry({ name: 'Work Title/track.wav', size: first.byteLength, chunks: chunksOf(first) });
        await writer.addEntry({ name: 'Work Title/sub/cover.jpg', size: second.byteLength, chunks: chunksOf(second) });
        const total = await writer.finish();

        const archive = concat(parts);
        expect(total).toBe(archive.byteLength);
        const entries = readArchive(archive);
        expect(entries.map(entry => entry.name)).toEqual(['Work Title/track.wav', 'Work Title/sub/cover.jpg']);
        expect(Array.from(entries[0].data)).toEqual(Array.from(first));
        expect(Array.from(entries[1].data)).toEqual(Array.from(second));
        expect(entries[0].crc).toBe(crc32(first));
        expect(entries[1].crc).toBe(crc32(second));
    });

    it('writes a parsable archive with no entries', async () => {
        const parts: Uint8Array[] = [];
        const writer = new StoredZipWriter(async bytes => { parts.push(bytes); });
        await writer.finish();
        expect(readArchive(concat(parts))).toEqual([]);
    });

    it('computes CRC identically regardless of chunk boundaries', async () => {
        const data = new Uint8Array(1024).map((_, index) => (index * 37) % 251);
        const collect = async (chunkSize: number): Promise<number> => {
            const parts: Uint8Array[] = [];
            const writer = new StoredZipWriter(async bytes => { parts.push(bytes); });
            await writer.addEntry({ name: 'a.bin', size: data.byteLength, chunks: chunksOf(data, chunkSize) });
            await writer.finish();
            return readArchive(concat(parts))[0].crc;
        };
        expect(await collect(1)).toBe(await collect(997));
        expect(await collect(1)).toBe(crc32(data));
    });

    it('rejects an entry whose stream does not match the declared size', async () => {
        const writer = new StoredZipWriter(async () => undefined);
        await expect(writer.addEntry({
            name: 'short.bin',
            size: 10,
            chunks: chunksOf(new Uint8Array(4)),
        })).rejects.toThrow(/produced 4 of 10/);
    });

    it('emits zip64 headers and a locator once an entry exceeds the 32-bit limit', async () => {
        const parts: Uint8Array[] = [];
        const writer = new StoredZipWriter(async bytes => { parts.push(bytes); });
        const huge = ZIP32_LIMIT + 1;
        // Only the headers are exercised; the body stream is stubbed so the
        // test never allocates four gigabytes.
        await expect(writer.addEntry({
            name: 'huge.bin',
            size: huge,
            chunks: (async function* () { yield new Uint8Array(0); })(),
        })).rejects.toThrow(/produced 0 of/);
        const header = parts[0];
        const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
        expect(view.getUint16(4, true)).toBe(45);
        expect(view.getUint32(18, true)).toBe(ZIP32_LIMIT);
        expect(view.getUint32(22, true)).toBe(ZIP32_LIMIT);
        expect(view.getUint16(28, true)).toBe(20);
        const extraStart = 30 + view.getUint16(26, true);
        expect(view.getUint16(extraStart, true)).toBe(0x0001);
        expect(view.getUint16(extraStart + 2, true)).toBe(16);
    });
});
