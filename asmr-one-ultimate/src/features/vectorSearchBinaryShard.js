export const SEMANTIC_BINARY_MAGIC = 'ASMRVEC\0';
export const SEMANTIC_BINARY_VERSION = 1;
export const SEMANTIC_BINARY_HEADER_BYTES = 24;

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export function stableSemanticJson(value) {
    return JSON.stringify(stableValue(value));
}

/** @param {Array<{vector: ArrayLike<number>} & Record<string, unknown>>} entries @param {number} dimension */
export function encodeSemanticBinaryShard(entries, dimension) {
    const metadata = entries.map(({ vector: _vector, ...entry }) => entry);
    const metadataBytes = new TextEncoder().encode(stableSemanticJson(metadata));
    const output = new Uint8Array(SEMANTIC_BINARY_HEADER_BYTES + metadataBytes.byteLength + entries.length * dimension * 4);
    output.set(new TextEncoder().encode(SEMANTIC_BINARY_MAGIC), 0);
    const view = new DataView(output.buffer);
    view.setUint32(8, SEMANTIC_BINARY_VERSION, true);
    view.setUint32(12, dimension, true);
    view.setUint32(16, entries.length, true);
    view.setUint32(20, metadataBytes.byteLength, true);
    output.set(metadataBytes, SEMANTIC_BINARY_HEADER_BYTES);
    let offset = SEMANTIC_BINARY_HEADER_BYTES + metadataBytes.byteLength;
    for (const entry of entries) {
        if (entry.vector.length !== dimension) throw new Error('Vector dimension mismatch while encoding shard');
        for (let index = 0; index < dimension; index++, offset += 4) {
            view.setFloat32(offset, Number(entry.vector[index]), true);
        }
    }
    return output;
}

/** @param {ArrayBuffer | Uint8Array} input */
export function decodeSemanticBinaryShard(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.byteLength < SEMANTIC_BINARY_HEADER_BYTES) throw new Error('Semantic shard is truncated');
    const magic = new TextDecoder().decode(bytes.subarray(0, 8));
    if (magic !== SEMANTIC_BINARY_MAGIC) throw new Error('Invalid semantic shard magic');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = view.getUint32(8, true);
    const dimension = view.getUint32(12, true);
    const count = view.getUint32(16, true);
    const metadataBytes = view.getUint32(20, true);
    if (version !== SEMANTIC_BINARY_VERSION || !dimension || !count) throw new Error('Invalid semantic shard header');
    const vectorOffset = SEMANTIC_BINARY_HEADER_BYTES + metadataBytes;
    const expectedBytes = vectorOffset + count * dimension * 4;
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes !== bytes.byteLength) throw new Error('Semantic shard length mismatch');
    let metadata;
    try {
        metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(SEMANTIC_BINARY_HEADER_BYTES, vectorOffset)));
    } catch {
        throw new Error('Invalid semantic shard metadata');
    }
    if (!Array.isArray(metadata) || metadata.length !== count) throw new Error('Semantic shard metadata count mismatch');
    const entries = metadata.map((entry, row) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || 'vector' in entry) throw new Error('Invalid semantic shard metadata row');
        const vector = new Float32Array(dimension);
        let offset = vectorOffset + row * dimension * 4;
        for (let column = 0; column < dimension; column++, offset += 4) vector[column] = view.getFloat32(offset, true);
        return { ...entry, vector };
    });
    return { version, dimension, count, entries };
}
