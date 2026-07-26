/**
 * Minimal streaming ZIP writer (store method, no compression).
 *
 * Downloaded works are already compressed audio/video, so deflating would burn
 * CPU for no gain. Everything is emitted sequentially so a multi-gigabyte work
 * folder can be archived straight into the staging sink without ever being
 * held in memory.
 */

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const ZIP64_END_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const END_SIGNATURE = 0x06054b50;
const ZIP64_EXTRA_ID = 0x0001;
/** Streaming data descriptor (bit 3) plus UTF-8 filenames (bit 11). */
const GENERAL_PURPOSE_FLAGS = 0x0008 | 0x0800;
const VERSION_STORE = 20;
const VERSION_ZIP64 = 45;
export const ZIP32_LIMIT = 0xffffffff;

let crcTable: Uint32Array | undefined;

function getCrcTable(): Uint32Array {
    if (crcTable) return crcTable;
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
        let value = index;
        for (let bit = 0; bit < 8; bit += 1) {
            value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
        }
        table[index] = value >>> 0;
    }
    crcTable = table;
    return table;
}

export function crc32(bytes: Uint8Array, seed = 0): number {
    const table = getCrcTable();
    let crc = (seed ^ 0xffffffff) >>> 0;
    for (let index = 0; index < bytes.length; index += 1) {
        crc = (crc >>> 8) ^ table[(crc ^ bytes[index]) & 0xff];
    }
    return (crc ^ 0xffffffff) >>> 0;
}

/** DOS date/time pair used by the ZIP headers. */
export function toDosDateTime(date: Date): { time: number; date: number } {
    const year = Math.max(1980, date.getFullYear());
    return {
        time: (Math.floor(date.getSeconds() / 2) | (date.getMinutes() << 5) | (date.getHours() << 11)) & 0xffff,
        date: (date.getDate() | ((date.getMonth() + 1) << 5) | ((year - 1980) << 9)) & 0xffff,
    };
}

class ByteBuilder {
    private readonly parts: number[] = [];

    u16(value: number): this {
        this.parts.push(value & 0xff, (value >>> 8) & 0xff);
        return this;
    }

    u32(value: number): this {
        const normalized = value >>> 0;
        this.parts.push(normalized & 0xff, (normalized >>> 8) & 0xff, (normalized >>> 16) & 0xff, (normalized >>> 24) & 0xff);
        return this;
    }

    u64(value: number): this {
        const low = value % 0x100000000;
        const high = Math.floor(value / 0x100000000);
        return this.u32(low).u32(high);
    }

    bytes(value: Uint8Array): this {
        for (const byte of value) this.parts.push(byte);
        return this;
    }

    build(): Uint8Array {
        return Uint8Array.from(this.parts);
    }
}

interface CentralEntry {
    name: Uint8Array;
    crc: number;
    size: number;
    offset: number;
    dos: { time: number; date: number };
    zip64: boolean;
}

export interface StoredZipEntry {
    /** Slash-separated path stored inside the archive. */
    name: string;
    size: number;
    chunks: AsyncIterable<Uint8Array>;
}

/**
 * Emits archive bytes sequentially through `emit`. Sizes are known up-front so
 * both the local header and the streaming data descriptor carry correct values,
 * which keeps naive, streaming and seeking extractors all in agreement.
 */
export class StoredZipWriter {
    private readonly entries: CentralEntry[] = [];
    private offset = 0;
    private finished = false;

    constructor(
        private readonly emit: (bytes: Uint8Array) => Promise<void>,
        private readonly now: () => Date = () => new Date(),
    ) {}

    get bytesWritten(): number { return this.offset; }

    async addEntry(entry: StoredZipEntry): Promise<void> {
        if (this.finished) throw new Error('The archive is already finished');
        if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
            throw new RangeError(`Invalid archive entry size for ${entry.name}`);
        }
        const name = new TextEncoder().encode(entry.name.replace(/\\/g, '/'));
        const dos = toDosDateTime(this.now());
        const localOffset = this.offset;
        const zip64 = entry.size > ZIP32_LIMIT || localOffset > ZIP32_LIMIT;
        await this.write(this.localHeader(name, entry.size, dos, zip64));

        let crc = 0;
        let written = 0;
        for await (const chunk of entry.chunks) {
            if (!chunk.byteLength) continue;
            crc = crc32(chunk, crc);
            written += chunk.byteLength;
            await this.write(chunk);
        }
        if (written !== entry.size) {
            throw new Error(`Archive entry ${entry.name} produced ${written} of ${entry.size} bytes`);
        }
        await this.write(this.dataDescriptor(crc, entry.size, zip64));
        this.entries.push({ name, crc, size: entry.size, offset: localOffset, dos, zip64 });
    }

    async finish(): Promise<number> {
        if (this.finished) return this.offset;
        this.finished = true;
        const centralOffset = this.offset;
        for (const entry of this.entries) await this.write(this.centralHeader(entry));
        const centralSize = this.offset - centralOffset;
        const needsZip64 = centralOffset > ZIP32_LIMIT
            || centralSize > ZIP32_LIMIT
            || this.entries.length > 0xffff
            || this.entries.some(entry => entry.zip64);
        if (needsZip64) await this.write(this.zip64Trailer(centralOffset, centralSize));
        await this.write(this.endRecord(centralOffset, centralSize, needsZip64));
        return this.offset;
    }

    private async write(bytes: Uint8Array): Promise<void> {
        await this.emit(bytes);
        this.offset += bytes.byteLength;
    }

    private localHeader(name: Uint8Array, size: number, dos: { time: number; date: number }, zip64: boolean): Uint8Array {
        const builder = new ByteBuilder()
            .u32(LOCAL_HEADER_SIGNATURE)
            .u16(zip64 ? VERSION_ZIP64 : VERSION_STORE)
            .u16(GENERAL_PURPOSE_FLAGS)
            .u16(0)
            .u16(dos.time)
            .u16(dos.date)
            .u32(0)
            .u32(zip64 ? ZIP32_LIMIT : size)
            .u32(zip64 ? ZIP32_LIMIT : size)
            .u16(name.byteLength)
            .u16(zip64 ? 20 : 0)
            .bytes(name);
        if (zip64) builder.u16(ZIP64_EXTRA_ID).u16(16).u64(size).u64(size);
        return builder.build();
    }

    private dataDescriptor(crc: number, size: number, zip64: boolean): Uint8Array {
        const builder = new ByteBuilder().u32(DATA_DESCRIPTOR_SIGNATURE).u32(crc);
        if (zip64) builder.u64(size).u64(size);
        else builder.u32(size).u32(size);
        return builder.build();
    }

    private centralHeader(entry: CentralEntry): Uint8Array {
        const zip64Sizes = entry.size > ZIP32_LIMIT;
        const zip64Offset = entry.offset > ZIP32_LIMIT;
        const extraLength = zip64Sizes || zip64Offset
            ? 4 + (zip64Sizes ? 16 : 0) + (zip64Offset ? 8 : 0)
            : 0;
        const builder = new ByteBuilder()
            .u32(CENTRAL_HEADER_SIGNATURE)
            .u16(VERSION_ZIP64)
            .u16(entry.zip64 ? VERSION_ZIP64 : VERSION_STORE)
            .u16(GENERAL_PURPOSE_FLAGS)
            .u16(0)
            .u16(entry.dos.time)
            .u16(entry.dos.date)
            .u32(entry.crc)
            .u32(zip64Sizes ? ZIP32_LIMIT : entry.size)
            .u32(zip64Sizes ? ZIP32_LIMIT : entry.size)
            .u16(entry.name.byteLength)
            .u16(extraLength)
            .u16(0)
            .u16(0)
            .u16(0)
            .u32(0)
            .u32(zip64Offset ? ZIP32_LIMIT : entry.offset)
            .bytes(entry.name);
        if (extraLength) {
            builder.u16(ZIP64_EXTRA_ID).u16(extraLength - 4);
            if (zip64Sizes) builder.u64(entry.size).u64(entry.size);
            if (zip64Offset) builder.u64(entry.offset);
        }
        return builder.build();
    }

    private zip64Trailer(centralOffset: number, centralSize: number): Uint8Array {
        return new ByteBuilder()
            .u32(ZIP64_END_SIGNATURE)
            .u64(44)
            .u16(VERSION_ZIP64)
            .u16(VERSION_ZIP64)
            .u32(0)
            .u32(0)
            .u64(this.entries.length)
            .u64(this.entries.length)
            .u64(centralSize)
            .u64(centralOffset)
            .u32(ZIP64_LOCATOR_SIGNATURE)
            .u32(0)
            .u64(centralOffset + centralSize)
            .u32(1)
            .build();
    }

    private endRecord(centralOffset: number, centralSize: number, zip64: boolean): Uint8Array {
        const count = zip64 && this.entries.length > 0xffff ? 0xffff : this.entries.length;
        return new ByteBuilder()
            .u32(END_SIGNATURE)
            .u16(0)
            .u16(0)
            .u16(count)
            .u16(count)
            .u32(centralSize > ZIP32_LIMIT ? ZIP32_LIMIT : centralSize)
            .u32(centralOffset > ZIP32_LIMIT ? ZIP32_LIMIT : centralOffset)
            .u16(0)
            .build();
    }
}
